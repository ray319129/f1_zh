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
function pickTokens(text, out, src) {
  if (typeof text !== 'string') return;
  // 記下每個候選的「出處」。伺服器分別驗證 ascendontoken 與 entitlementtoken，
  // 代表它們是兩個不同的權杖，必須各自配對正確的來源，不能亂試。
  const push = (s, tag) => {
    if (typeof s !== 'string' || /\s/.test(s)) return;
    if (/^ey[A-Za-z0-9_-]+\./.test(s) || s.length >= 40) out.push({ v: s, src: tag || src });
  };
  push(text);

  // Cookie 值多半是 URL-encoded。之前只 push 了原始字串，
  // 而解碼後的版本只在「能 JSON.parse」時才會被處理——
  // 對 entitlement_token 這種「URL-encoded 的 JWT」來說，
  // 真正該送出去的解碼後字串從來沒進過候選清單。
  try {
    const dec = decodeURIComponent(text);
    if (dec !== text) push(dec, src + '(decoded)');
  } catch (e) { /* 不是合法的 encoding */ }

  try {
    const obj = JSON.parse(decodeURIComponent(text));
    const walk = (o, d) => {
      if (d > 6 || o == null) return;
      if (typeof o === 'string') { push(o); return; }
      if (typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /subscriptionToken|ascendon|entitlement|accessToken|access_token|\btoken\b/i.test(k)) {
          // 欄位名就是最精確的出處線索，排到最前面
          if (!/\s/.test(v) && v.length >= 20) out.unshift({ v, src: src + '/' + k });
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
      if (!c.value || /^(_ga|_gid|OptanonC|__utm|NRBA_|ABTasty|reese84|consent|_rdt|_sfid|_evga|sp_)/i.test(c.name)) continue;
      const before = out.length;
      pickTokens(c.value, out, 'cookie:' + c.name);
      if (out.length > before) names.push(`${c.name}(${c.value.length})`);
    }
  }
  // 依 value 去重，保留第一個（出處最精確的那個）
  const seen = new Set();
  const uniq = out.filter((t) => (seen.has(t.v) ? false : (seen.add(t.v), true)));
  return { tokens: uniq.slice(0, 12), names: Array.from(new Set(names)) };
}

/**
 * 建立「依出處精準配對」的嘗試清單。
 *
 * 實測發現伺服器**分別**驗證兩個權杖，各自回報自己的錯誤：
 *   ascendontoken     → "AscendonToken signature validation failed"
 *   entitlementtoken  → "EntitlementToken signature validation failed"
 *
 * 代表它們是兩個不同的權杖，各有各的來源：
 *   ascendontoken     ← login-session cookie 裡的 subscriptionToken
 *   entitlementtoken  ← entitlement_token cookie
 *
 * 先前的「合併」變體把**同一個值**塞進兩個 header，那組合注定失敗；
 * 而盲目排列組合又會產生數十次無效請求（實測 60 次、74 秒）。
 * 依出處配對後只剩個位數次嘗試。
 */
function buildAttempts(tokens) {
  const pick = (re) => tokens.filter((t) => re.test(t.src || ''));
  const asc = pick(/subscriptionToken|login-session|ascendon/i);
  const ent = pick(/entitlement/i);
  const rest = tokens.filter((t) => !asc.includes(t) && !ent.includes(t));
  const A = [];

  // 1) 兩個一起送，各用各的來源 —— 最可能正確的組合
  for (const a of asc.slice(0, 2)) {
    for (const e of ent.slice(0, 2)) {
      A.push({
        headers: { ascendontoken: a.v, entitlementtoken: e.v },
        label: `ascendon←${a.src} + entitlement←${e.src}`,
      });
    }
  }
  // 2) 各自單獨送
  for (const a of asc.slice(0, 2)) A.push({ headers: { ascendontoken: a.v }, label: `ascendontoken←${a.src}` });
  for (const e of ent.slice(0, 2)) A.push({ headers: { entitlementtoken: e.v }, label: `entitlementtoken←${e.src}` });
  // 3) 兜底：出處不明的候選
  for (const t of rest.slice(0, 3)) {
    A.push({ headers: { ascendontoken: t.v }, label: `ascendontoken←${t.src}` });
  }
  A.push({ headers: {}, label: '不帶授權 header' });
  return A.slice(0, 14);
}

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

  const list = (Array.isArray(tokens) ? tokens : []).filter((t) => t && t.v);
  const attempts = buildAttempts(list);

  let last = null;
  let best = null;        // 「最接近成功」的一次
  const tried = [];       // 只記 label（出處名稱），不含權杖值

  for (const a of attempts) {
    // 送出前再擋一次：Chrome 對含控制字元／非 ASCII 的 header 值會直接拒絕整個
    // 請求（Failed to fetch），那不是伺服器的回應，卻很容易被誤讀成認證失敗。
    const bad = Object.entries(a.headers).find(([, v]) => !/^[\x21-\x7E]+$/.test(String(v)));
    if (bad) { tried.push(`${a.label} → 略過（${bad[0]} 的值不能當 header）`); continue; }

    let r;
    try { r = await tryPlay(url, a.headers); }
    catch (e) {
      last = { status: 0, text: String(e.message || e) };
      tried.push(`${a.label} → 網路層失敗（${last.text}）`);
      continue;
    }
    last = r;
    // 把伺服器訊息一起記下來：500 跟 401 要看內容才知道差在哪
    const msg = (r.data && r.data.message) ? String(r.data.message).slice(0, 90)
              : String(r.text || '').slice(0, 90);
    tried.push(`${a.label} → ${r.status}${msg ? ' ' + msg : ''}`);

    // 錯誤訊息本身就是進度指示：
    //   400 Missing parameter…                    → header 名稱錯，伺服器沒讀到
    //   401 signature validation failed / expired → header 名稱對，值被拒
    const reached = /signature|expired|invalid|ACN_3005/i.test(r.text || '');
    if (reached && !best) {
      best = { headerNames: Object.keys(a.headers), status: r.status, msg: String(r.text).slice(0, 160) };
    }

    if (r.ok) {
      return { ok: true, status: r.status, master: r.master, usedHeader: a.label };
    }
  }

  return {
    ok: false,
    status: last ? last.status : 0,
    tokensTried: list.length,
    attemptsMade: attempts.length,
    tried,
    topKeys: last && last.data ? Object.keys(last.data).slice(0, 20) : [],
    hint: last ? String(last.text).slice(0, 260) : '無回應',
    best,
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
