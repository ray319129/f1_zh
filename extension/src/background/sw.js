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
// F1TV 串流資源
//
// 為什麼要在這裡發請求，而不是在 content script：
//   1. 有 host_permissions 的 SW 不受頁面 CSP 限制
//   2. CDN 是跨來源，content script 的 fetch 會被 CORS 擋
//
// 為什麼要拿這些：擴充功能若只讀畫面上的 DOM，提前量是 0，
// 逐句翻譯永遠追不上轉播語速。拿到 VTT 才有提前量（實測 47~53 秒），
// 那正是 userscript 跟得上而擴充功能跟不上的原因。
// ---------------------------------------------------------------------------

/** 純文字抓取（m3u8 / vtt）。帶上使用者的 session。 */
async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 呼叫 F1TV 的播放 API 取得串流網址。
 * 這是播放器自己也會發的同一個請求，用的是使用者已登入的 session。
 *
 * ⚠️ 回應的 JSON 結構我尚未實地確認，所以這裡用「遞迴找出第一個 .m3u8 網址」
 *    的方式解析，而不是寫死欄位名。同時把頂層鍵名記下來供診斷用。
 */
function deepFindM3u8(obj, depth) {
  depth = depth || 0;
  if (depth > 6 || obj == null) return null;
  if (typeof obj === 'string') return /\.m3u8/i.test(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const hit = deepFindM3u8(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 讀取 f1tv/formula1 網域的 cookie 找授權權杖。
 *
 * 為什麼需要 cookies 權限：F1TV 把登入資訊放在 cookie，而其中最關鍵的那些
 * 通常是 HttpOnly——網頁的 document.cookie 讀不到，只有擴充功能的
 * chrome.cookies API 拿得到。
 *
 * ⚠️ 只回傳權杖字串本身供 API 呼叫使用，以及**鍵名**供診斷。
 *    值永遠不會出現在診斷報告裡。
 */
function pickTokens(text, out) {
  if (typeof text !== 'string') return;
  const push = (s) => {
    if (typeof s !== 'string' || /\s/.test(s)) return;
    if (/^ey[A-Za-z0-9_-]+\./.test(s) || s.length >= 40) out.push(s);
  };
  push(text);

  // Cookie 值多半是 URL-encoded。之前只 push 了原始字串，
  // 而解碼後的版本只在「能 JSON.parse」時才會被處理——
  // 對 entitlement_token 這種「URL-encoded 的 JWT」來說，
  // 真正該送出去的解碼後字串從來沒進過候選清單。
  try {
    const dec = decodeURIComponent(text);
    if (dec !== text) push(dec);
  } catch (e) { /* 不是合法的 encoding */ }

  try {
    const obj = JSON.parse(decodeURIComponent(text));
    const walk = (o, d) => {
      if (d > 6 || o == null) return;
      if (typeof o === 'string') { push(o); return; }
      if (typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /subscriptionToken|ascendon|entitlement|accessToken|access_token|\btoken\b/i.test(k)) {
          if (!/\s/.test(v) && v.length >= 20) out.unshift(v);
          continue;
        }
        walk(v, d + 1);
      }
    };
    walk(obj, 0);
  } catch (e) { /* 不是 JSON 就算了 */ }
}

async function getCookieTokens() {
  if (!chrome.cookies || !chrome.cookies.getAll) return { tokens: [], names: [] };
  const out = [];
  const names = [];
  for (const domain of ['f1tv.formula1.com', 'formula1.com', '.formula1.com']) {
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ domain }); } catch (e) { continue; }
    for (const c of cookies) {
      if (!c.value || /^(_ga|_gid|OptanonC|__utm|NRBA_)/i.test(c.name)) continue;
      const before = out.length;
      pickTokens(c.value, out);
      if (out.length > before) names.push(`${c.name}(${c.value.length})`);
    }
  }
  return { tokens: Array.from(new Set(out)).slice(0, 10), names: Array.from(new Set(names)) };
}

/**
 * PLAY API 需要的授權 header 名稱未知，所以逐一嘗試。
 * F1TV 回的錯誤訊息點名了三種：Ascendon Token / Entitlement Token / Access Token。
 * 成功之後把組合記進 storage，之後直接用，不必每次重試。
 */
const AUTH_HEADER_VARIANTS = [
  (t) => ({ ascendontoken: t }),
  (t) => ({ entitlementtoken: t }),
  (t) => ({ ascendontoken: t, entitlementtoken: t }),   // 可能要求同時帶
  (t) => ({ 'x-f1-ascendon-token': t }),
  (t) => ({ accesstoken: t }),
  (t) => ({ 'access-token': t }),
  (t) => ({ authorization: `Bearer ${t}` }),
  (t) => ({ authorization: t }),
];

// 全排列會產生幾十次失敗請求（實測 10 權杖 × 6 header = 60 次、耗時 74 秒）。
// 那既慢又像在探測，所以設上限；候選清單本來就已依「欄位名像不像」排序。
const MAX_AUTH_ATTEMPTS = 14;

async function tryPlay(url, headers) {
  const res = await fetch(url, { credentials: 'include', headers: headers || {} });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  const master = data ? deepFindM3u8(data) : null;
  return { status: res.status, ok: res.ok && !!master, master, text, data };
}

async function resolvePlayback(cid, tokens) {
  const url = `https://f1tv.formula1.com/3.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY`
            + `?contentId=${encodeURIComponent(cid)}&player=player_tm`;

  // 先試上次成功的組合
  const { authRecipe } = await chrome.storage.local.get('authRecipe');
  const list = Array.isArray(tokens) ? tokens : [];
  const attempts = [];

  if (authRecipe && typeof authRecipe.variant === 'number' && list[authRecipe.tokenIndex]) {
    attempts.push({ v: authRecipe.variant, ti: authRecipe.tokenIndex });
  }
  // 廣度優先：先讓每個權杖都試最可能的前兩種 header，再往後試冷門的。
  // 比「一個權杖試完六種再換下一個」更快命中，也更早停損。
  for (let v = 0; v < AUTH_HEADER_VARIANTS.length; v++) {
    for (let ti = 0; ti < list.length; ti++) attempts.push({ v, ti });
  }
  attempts.push({ v: -1, ti: -1 });   // 最後試「完全不帶 header」
  attempts.length = Math.min(attempts.length, MAX_AUTH_ATTEMPTS);

  let last = null;
  let best = null;   // 「最接近成功」的一次

  for (const a of attempts) {
    const headers = a.v >= 0 ? AUTH_HEADER_VARIANTS[a.v](list[a.ti]) : {};
    let r;
    try { r = await tryPlay(url, headers); }
    catch (e) { last = { status: 0, text: String(e.message || e) }; continue; }
    last = r;

    // 錯誤訊息本身就是進度指示：
    //   400 Missing parameter…  → header 名稱錯，伺服器根本沒讀到
    //   401 signature validation failed / expired → header 名稱**對了**，只是值不被接受
    // 記下最接近的那次，失敗時回報出來，下一輪就知道該往哪個方向查。
    const reached = /signature|expired|invalid|ACN_3005/i.test(r.text || '');
    if (reached && !best) {
      best = { headerNames: Object.keys(headers), status: r.status, msg: String(r.text).slice(0, 160) };
    }

    if (r.ok) {
      if (a.v >= 0) await chrome.storage.local.set({ authRecipe: { variant: a.v, tokenIndex: a.ti } });
      return {
        ok: true, status: r.status, master: r.master,
        usedHeader: a.v >= 0 ? Object.keys(AUTH_HEADER_VARIANTS[a.v]('x'))[0] : '(無)',
      };
    }
  }

  await chrome.storage.local.remove('authRecipe');
  return {
    ok: false,
    status: last ? last.status : 0,
    tokensTried: list.length,
    variantsTried: AUTH_HEADER_VARIANTS.length,
    attemptsMade: attempts.length,
    topKeys: last && last.data ? Object.keys(last.data).slice(0, 20) : [],
    hint: last ? String(last.text).slice(0, 260) : '無回應',
    best,   // header 名稱正確、只是權杖被拒的那一次
  };
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
        case 'getCookieTokens':
          sendResponse(Object.assign({ ok: true }, await getCookieTokens()));
          break;
        case 'resolvePlayback':
          sendResponse({ ok: true, playback: await resolvePlayback(msg.cid, msg.tokens) });
          break;
        case 'fetchText':
          try {
            sendResponse({ ok: true, text: await fetchText(msg.url) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
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
