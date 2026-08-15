/**
 * Service Worker —— 唯一對外通訊的地方
 *
 * 為什麼所有網路請求都走這裡，而不是讓 content script 直接 fetch：
 *   1. content script 的 fetch 受頁面 CORS 限制；SW 不受，只要有 host_permissions
 *   2. 未來要加的授權權杖只存在這裡，不會出現在頁面環境裡
 *   3. 商店審核時「網路行為集中在一處」比散落各處容易解釋
 *
 * ⚠️ MV3 的 SW 隨時可能被瀏覽器殺掉並重啟。
 *    因此**所有狀態都必須放 chrome.storage，不能放模組層級變數**。
 *    下面的 memCache 只是同一次生命週期內的加速，掉了也不影響正確性。
 */

importScripts('/src/shared/normalize.js', '/src/shared/defaults.js');

const BACKEND = self.PL.BACKEND;
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000;   // 遠端設定快取 6 小時

// 生命週期內的記憶體快取。被殺掉就沒了，但 storage 裡有備份。
const memCache = {
  bundles: new Map(),      // cid -> { lines, segCount, count, at }
  config: null,
};

// ---------------------------------------------------------------------------
// 後端通訊
// ---------------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, self.PL.DEFAULT_SETTINGS, settings || {});
}

async function getClientToken() {
  const { clientToken } = await chrome.storage.local.get('clientToken');
  return clientToken || '';
}

async function api(path, options) {
  const token = await getClientToken();
  const res = await fetch(BACKEND + path, Object.assign({
    headers: { 'content-type': 'application/json', 'x-client-token': token },
  }, options || {}));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 取得遠端設定。這是 F1TV 改版時的救命索：
 * 選擇器變了就改後端 JSON，不用重新送審。
 * 拿不到就用內建預設，功能不會因為後端掛掉而中斷。
 */
async function getConfig() {
  const now = Date.now();
  if (memCache.config && now - memCache.config.at < CONFIG_TTL_MS) return memCache.config.data;

  const { configCache } = await chrome.storage.local.get('configCache');
  if (configCache && now - configCache.at < CONFIG_TTL_MS) {
    memCache.config = configCache;
    return configCache.data;
  }

  try {
    const data = await api('/v1/config');
    const entry = { data, at: now };
    memCache.config = entry;
    await chrome.storage.local.set({ configCache: entry });
    return data;
  } catch (e) {
    // 後端不可用時退回內建設定，或用過期的快取（過期總比沒有好）
    if (configCache) return configCache.data;
    return self.PL.BUILT_IN_CONFIG;
  }
}

/**
 * 取得整支影片的譯文。
 * 這是「共用快取」的讀取端——同一支影片全世界只翻一次，其他人直接下載。
 */
async function getBundle(cid) {
  if (!cid) return { lines: {}, count: 0, segCount: 0 };

  const cached = memCache.bundles.get(cid);
  if (cached) return cached;

  try {
    const d = await api(`/v1/subs?cid=${encodeURIComponent(cid)}`);
    const entry = { lines: d.lines || {}, count: d.count || 0, segCount: d.segCount || 0, at: Date.now() };
    memCache.bundles.set(cid, entry);
    // 只留最近 3 支，避免 SW 記憶體無限成長
    if (memCache.bundles.size > 3) memCache.bundles.delete(memCache.bundles.keys().next().value);
    return entry;
  } catch (e) {
    return { lines: {}, count: 0, segCount: 0, error: String(e.message || e) };
  }
}

/**
 * 後備路徑：這支影片還沒被收割過時，逐句向後端要翻譯。
 * 後端會先查自己的單句快取，未命中才呼叫模型，並把結果存起來——
 * 所以就算是「第一個看的人」，他翻過的每一句也都會嘉惠後面的人。
 */
async function translateLines(cid, lines) {
  if (!lines || !lines.length) return { lines: {} };
  try {
    return await api('/v1/translate', {
      method: 'POST',
      body: JSON.stringify({ cid: cid || 'misc', lines }),
    });
  } catch (e) {
    return { lines: {}, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 與 content script 的訊息通道
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'getConfig':
          sendResponse({ ok: true, config: await getConfig() });
          break;
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'getBundle':
          sendResponse({ ok: true, bundle: await getBundle(msg.cid) });
          break;
        case 'translate':
          sendResponse({ ok: true, result: await translateLines(msg.cid, msg.lines) });
          break;
        case 'health':
          try {
            const h = await fetch(BACKEND + '/v1/health').then((r) => r.json());
            sendResponse({ ok: true, health: h });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;   // 一定要 return true，否則非同步的 sendResponse 會失效
});

// 設定改變時清掉設定快取，讓新的權杖立刻生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.clientToken) { memCache.config = null; memCache.bundles.clear(); }
});
