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
// 遠端設定是「F1TV 改版時能不能在幾分鐘內救回所有使用者」的唯一保障。
//
// 這個值踩過兩次：
//   6 小時  → 比賽日出事等於整場報銷
//   10 分鐘 → content script 每 60 秒重讀變成空轉，實際傳播仍是 10 分鐘
//
// 真正的傳播延遲 = SW 快取 TTL + content script 的重讀間隔。
// 設 2 分鐘，最壞情況約 3 分鐘。設定 JSON 只有幾百 bytes，
// 每位使用者每 2 分鐘一次請求的負載完全可接受。
const CONFIG_TTL_MS = 2 * 60 * 1000;        // 2 分鐘

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
  return self.PL.sanitizeSettings(settings);
}

/**
 * 取得這個安裝的權杖。沒有就跟後端換一枚。
 *
 * 為什麼不再用使用者手動貼的共用金鑰（SECURITY.md S6）：
 * 那枚金鑰隨擴充功能發給每一個人，等同公開——任何人都能拿去無限呼叫後端
 * 燒掉 Anthropic 額度。改成**每個安裝一枚**之後才有辦法個別限額與撤銷。
 *
 * 使用者完全無感：不需要註冊、不需要 email、不收任何個資，
 * 只是啟動時匿名換一枚權杖存在本機。
 *
 * `installId` 同時用於分階段推送的分流（同一個安裝永遠落在同一組）。
 * 它**只送給我們自己的後端**，不做任何跨站追蹤。
 */
const TOKEN_RENEW_BEFORE_MS = 7 * 86400 * 1000;     // 到期前 7 天就換新的

async function getClientToken() {
  const st = await chrome.storage.local.get(['installToken', 'installExp', 'clientToken']);

  // 還在有效期內就用它
  if (st.installToken && st.installExp && st.installExp * 1000 - Date.now() > TOKEN_RENEW_BEFORE_MS) {
    return st.installToken;
  }

  try {
    const res = await fetch(BACKEND + '/v1/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const d = await res.json();
      if (d && d.token) {
        await chrome.storage.local.set({ installToken: d.token, installExp: d.exp });
        return d.token;
      }
    }
  } catch (e) { /* 換不到就往下退 */ }

  // 換不到新的就先用舊的（過期總比沒有好），再退回使用者手填的金鑰
  return st.installToken || st.clientToken || '';
}

/** 分階段推送用的分流識別碼。從權杖裡取，不另外產生。 */
async function getInstallId() {
  const { installToken } = await chrome.storage.local.get('installToken');
  if (!installToken) return '';
  const first = String(installToken).split('.')[0];
  return /^[0-9a-f-]{8,}$/i.test(first) ? first : '';
}

/**
 * 呼叫後端。
 *
 * ⚠️ 錯誤一定要帶著 **status 與伺服器給的訊息**。
 *
 * 原本只丟 `new Error('HTTP 404')`，於是每個呼叫端都只能寫
 * 「無法連線到伺服器」——但 404（端點不存在／後端沒部署）、401（權杖問題）、
 * 429（太頻繁）、503（額度用盡）是完全不同的四件事，
 * **對使用者的指示也完全不同**。把它們混成同一句話，等於沒有錯誤訊息。
 *
 * 實際踩到：使用者按「傳送診斷」看到「無法連線到伺服器，請檢查網路」，
 * 真正的原因是後端還沒部署 v2.3，`/v1/report` 回 404。他去檢查網路是白費工。
 */
async function api(path, options) {
  const token = await getClientToken();
  // 通行證一併帶上。伺服器用它判斷這個安裝有沒有付費——
  // 用戶端的授權 UI 只是體驗，真正的閘門在伺服器（沒有 TOKEN_SECRET 就驗不了簽）。
  const { entitlement } = await chrome.storage.local.get('entitlement');
  const headers = { 'content-type': 'application/json', 'x-client-token': token };
  if (entitlement) headers['x-entitlement'] = entitlement;

  let res;
  try {
    res = await fetch(BACKEND + path, Object.assign({ headers }, options || {}));
  } catch (e) {
    // 只有這裡才是真的連不上
    const err = new Error('無法連線到伺服器，請檢查網路連線');
    err.offline = true;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return data;

  const err = new Error(describeHttp(res.status, data));
  err.status = res.status;
  err.data = data;
  throw err;
}

/** 把 HTTP 狀態翻成「使用者現在能做什麼」。 */
function describeHttp(status, data) {
  if (data && data.error) return data.error;
  if (status === 401) return '存取權杖無效。請重新載入擴充功能，它會自動重新取得。';
  if (status === 403) return '沒有權限執行這個動作。';
  if (status === 404) return '伺服器上找不到這個功能（可能是後端版本較舊）。請聯絡開發者。';
  if (status === 429) return '操作太頻繁，請稍後再試。';
  if (status === 503) return '服務暫時無法使用，請稍後再試。';
  if (status >= 500) return `伺服器發生錯誤（${status}），請稍後再試。`;
  return `請求失敗（HTTP ${status}）`;
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
    // 帶上 installId，讓伺服器決定這個安裝該拿哪一版（分階段推送）
    const iid = await getInstallId();
    const data = await api('/v1/config' + (iid ? `?iid=${encodeURIComponent(iid)}` : ''));
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
/**
 * ⚠️ 這個快取一定要有 TTL。
 *
 * 原本是 `if (cached) return cached;`——存了 `at` 卻從來不檢查，等於永久快取。
 * 實測症狀：同一支影片預抓完 836 句後重整頁面，共用快取仍然只回報 87 句，
 * 整支又重翻一次。因為 SW 在重整之間沒有被回收，回的是開場那份舊 bundle。
 * 使用者完全看不出來，只會覺得「怎麼又在翻」。（handoff 坑 #23）
 *
 * 90 秒是折衷：夠短，讓重整或別人剛灌進去的譯文很快被看到；
 * 夠長，不會讓正常觀看途中反覆打後端。
 */
const BUNDLE_TTL_MS = 90 * 1000;

async function getBundle(cid, force) {
  if (!cid) return { lines: {}, count: 0, segCount: 0 };

  const cached = memCache.bundles.get(cid);
  if (cached && !force && Date.now() - cached.at < BUNDLE_TTL_MS) return cached;

  try {
    // cache: 'no-store' 是第二道保險。後端 v1.6 起已改成 no-store，但使用者的
    // 後端可能還沒部署，而舊回應帶著 max-age=60——那層 HTTP 快取我們清不掉，
    // 會讓剛寫進去的 segCount 整整一分鐘看不到（坑 #26）。
    const d = await api(`/v1/subs?cid=${encodeURIComponent(cid)}`, { cache: 'no-store' });
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
async function translateLines(cid, lines, urgent, slug) {
  if (!lines || !lines.length) return { lines: {} };
  try {
    return await api('/v1/translate', {
      method: 'POST',
      // urgent = 畫面上現在就要用。後端只讓**非急件**參與直播的並發去重，
      // 因為讓路的人要等別人翻完再讀快取，而直播字幕 3~4 秒就換一句。
      // **預設是急件**：漏標的後果是多花一點錢，標錯方向的後果是看不到字幕。
      // slug：伺服器要靠它判斷這支影片算不算免費場次（那條規則以前只在用戶端）
      body: JSON.stringify({ cid: cid || 'misc', lines, urgent: urgent !== false, slug: slug || '' }),
    });
  } catch (e) {
    return { lines: {}, error: String(e.message || e) };
  }
}

/**
 * 告訴後端「這支影片的字幕已被完整收割」，讓後續觀看者跳過整軌預抓。
 *
 * 標記成功後要把本機的 bundle 快取作廢，否則同一個 SW 生命週期內
 * 下一次 getBundle 還是回舊的 segCount=0，跳過判斷永遠不會生效。
 */
async function markComplete(cid, segCount, slug) {
  if (!cid || !segCount) return { ok: false };
  try {
    const d = await api('/v1/complete', {
      method: 'POST',
      // slug 是後台唯一能分辨「這是哪一場的哪個場次」的東西——
      // 我們只存 contentId，那是一串數字，人看不出是澳洲正賽還是賽後訪問。
      body: JSON.stringify({ cid, segCount, slug: slug || '' }),
    });
    memCache.bundles.delete(cid);
    return d;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 授權
//
// **授權碼綁人，安裝權杖綁裝置。** 兩者不可混用——
// 用安裝權杖當付費憑證的話，使用者換一台電腦就失效。
//
// 通行證（entitlement）存在本機，過期前都算有效。
// **後端連不上時不要把功能鎖起來**：伺服器出問題是我們的錯，
// 不該讓已付費的人看不到字幕。
// ---------------------------------------------------------------------------
// 通行證有效期 14 天是為了**離線容忍度**：後端掛掉時已付費的人還能撐兩週。
// 但如果只在快到期時才續，停用（退款、盜用、chargeback）最久要 11 天才生效——
// 那對開發者完全沒有保護。
//
// 拆成兩個時間：
//   RECHECK   每 24 小時主動回報一次。停用後最多一天生效。
//   有效期    仍是 14 天。後端連不上時**不會**把功能鎖起來，只是續不到而已。
// 兩者互不衝突：正常情況每天續一次，異常情況靠 14 天的緩衝撐著。
const ENT_RECHECK_MS = 24 * 3600 * 1000;

/**
 * @param {boolean} force 立刻向後端問一次，不用等 24 小時的週期。
 *
 * 設定頁開啟時要用 force。使用者按圖示的當下就是他在確認狀態的當下——
 * 那時給他一個最多過時 24 小時的答案，等於讓畫面說謊。
 * 一次請求的成本可以忽略，而且離線時 `licenseRenew` 不會清掉任何東西。
 */
async function licenseStatus(force) {
  if (force) {
    const { licenseKey } = await chrome.storage.local.get('licenseKey');
    if (licenseKey) await licenseRenew().catch(() => {});
  }
  const st = await chrome.storage.local.get(['licenseKey', 'entitlement', 'entExp', 'licPlan',
    'licPlanLabel', 'licGpName', 'licGpCount', 'licExpiresAt', 'entCheckedAt']);
  if (!st.entitlement || !st.entExp) {
    const { licRevokedReason } = await chrome.storage.local.get('licRevokedReason');
    return { active: false, reason: licRevokedReason || '' };
  }

  const expMs = st.entExp * 1000;
  if (expMs < Date.now()) {
    // 過期了，試著續一次。續不到也先回報未啟用，但**不刪掉授權碼**——
    // 可能只是後端暫時掛掉，網路恢復後還要能自動續回來。
    const r = await licenseRenew();
    if (!r.ok) return { active: false, expired: true, licenseKey: st.licenseKey };
    return licenseStatus();
  }

  // 距離上次回報超過 24 小時就在背景續一次，不擋使用者。
  // 這是停用能生效的唯一途徑，不能省。
  if (!st.entCheckedAt || Date.now() - st.entCheckedAt > ENT_RECHECK_MS) {
    licenseRenew().catch(() => {});
  }

  return {
    active: true,
    plan: st.licPlan || 'season',
    planLabel: st.licPlanLabel || '',
    gpName: st.licGpName || '',
    gpCount: st.licGpCount || 0,
    expiresAt: st.licExpiresAt || null,
    licenseKey: st.licenseKey || '',
  };
}

async function licenseActivate(licenseKey) {
  const key = String(licenseKey || '').trim();
  if (!key) return { ok: false, error: '請輸入授權碼' };
  try {
    const d = await api('/v1/license/activate', { method: 'POST', body: JSON.stringify({ licenseKey: key }) });
    if (!d || !d.ok) return d || { ok: false, error: '啟用失敗' };
    await chrome.storage.local.set({
      licenseKey: key, entitlement: d.entitlement, entExp: d.exp,
      licPlan: d.plan, licPlanLabel: d.planLabel || '',
      licGpName: d.gpName || '', licGpCount: d.gpCount || 0,
      licExpiresAt: d.expiresAt || null,
      entCheckedAt: Date.now(), licRevokedReason: '',
    });
    return d;
  } catch (e) {
    // api() 現在會把伺服器的訊息與 body 一起帶回來，
    // 所以裝置上限（409 + devices 清單）不用再重打一次請求。
    return Object.assign({ ok: false, error: e.message }, e.data || {});
  }
}

async function licenseRenew() {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  if (!licenseKey) return { ok: false };
  try {
    const res = await fetch(BACKEND + '/v1/license/renew', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-token': await getClientToken() },
      body: JSON.stringify({ licenseKey }),
    });
    const d = await res.json().catch(() => ({}));

    // 403 = 已停用／已過期／這台裝置已被解除。
    // 404 = 授權碼**已被刪除**（後台永久刪除，或客服重新發碼）。
    //
    // 兩者都是**確定的否定答案**，要立刻清掉本機狀態。
    // ⚠️ 原本只判 403。實際回報的症狀就是這個漏洞：後台把授權碼刪掉之後，
    //    續期收到 404，程式碼一路往下走到「不是 ok 就什麼都不做」，
    //    於是本機的通行證原封不動，擴充功能持續顯示「已啟用」最長 14 天。
    //    不報錯、沒有日誌，只有使用者看得到那個錯的狀態。
    //
    // 其他錯誤（500、逾時、斷網）一律不動——那可能只是後端暫時有事，
    // 把付費使用者的授權清掉才是真正的傷害。
    if (res.status === 403 || res.status === 404) {
      await chrome.storage.local.remove(['entitlement', 'entExp', 'licPlan', 'licExpiresAt']);
      await chrome.storage.local.set({
        entCheckedAt: Date.now(),
        licRevokedReason: d.error || (res.status === 404 ? '這組授權碼已不存在' : '授權已停用'),
      });
      return { ok: false, revoked: true, error: d.error };
    }
    if (res.ok && d && d.ok) {
      await chrome.storage.local.set({
        entitlement: d.entitlement, entExp: d.exp, licPlan: d.plan,
        licPlanLabel: d.planLabel || '', licGpName: d.gpName || '', licGpCount: d.gpCount || 0,
        entCheckedAt: Date.now(), licRevokedReason: '',
      });
    }
    return d || { ok: false };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

async function licenseDeactivate(licenseKey, installId) {
  const { licenseKey: stored } = await chrome.storage.local.get('licenseKey');
  const key = String(licenseKey || stored || '').trim();
  if (!key || !installId) return { ok: false, error: '缺少授權碼或裝置編號' };
  try {
    return await api('/v1/license/deactivate', { method: 'POST', body: JSON.stringify({ licenseKey: key, installId }) });
  } catch (e) { return { ok: false, error: '無法連線到伺服器' }; }
}

/** 目前這組授權碼底下有哪些裝置。純查詢，不會動到綁定狀態。 */
async function licenseDevices() {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  if (!licenseKey) return [];
  try {
    const d = await api('/v1/license/devices', { method: 'POST', body: JSON.stringify({ licenseKey }) });
    return (d && d.devices) || [];
  } catch (e) { return []; }
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

/**
 * 純文字抓取（m3u8 / vtt）。帶上使用者的 session。
 *
 * 這是整軌預抓唯一需要的網路能力：字幕清單的位址由 content script 從
 * worker 攔到的 manifest 取得，這裡只負責把它抓下來（CDN 是跨來源，
 * content script 自己 fetch 會被 CORS 擋）。
 *
 * PLAY API 那整套（權杖掃描、header 組合、cookie 讀取）已於 v0.4.0 移除——
 * 八個版本都沒通，而且新的預抓入口根本不需要授權。
 */
// 只允許抓這些網域。**這個白名單是必要的，不是防禦性程式設計。**
//
// 字幕清單的網址來自 content script，而 content script 是從 MAIN world 的
// window.postMessage 收來的——**頁面上任何腳本都能偽造那個訊息**。
// 沒有白名單的話，F1TV 頁面上的第三方腳本（廣告、分析、被入侵的 CDN）
// 就能讓這個擴充功能帶著使用者的 cookie 去抓任意網址。
const FETCH_ALLOW = [
  'ott-video-fer-cf.formula1.com',
  'f1tv.formula1.com',
];

function isAllowedFetch(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return FETCH_ALLOW.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

async function fetchText(url) {
  if (!isAllowedFetch(url)) throw new Error('網址不在允許清單內，已拒絕');
  // ⚠️ `priority: 'low'` 不是可有可無的優化，是**正確性層級的**。
  //    這些請求打的是與影片同一個 CDN 主機，HTTP/2 之下共用同一條連線。
  //    不標低優先權的話，瀏覽器會把「40 分鐘後才要用的字幕」和
  //    「現在就要播的影片分段」排在同一個優先級 —— 播放器的 ABR 量到
  //    吞吐量下降就會降解析度。使用者實測：開擴充功能就卡，關掉就正常。
  //    舊版 Chrome 不支援這個欄位時會直接忽略，不會出錯。
  const res = await fetch(url, { credentials: 'include', priority: 'low' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
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
        case 'refreshConfig':
          // 強制丟掉快取重抓 —— 驗證熱修流程與緊急狀況都要用到
          memCache.config = null;
          await chrome.storage.local.remove('configCache');
          sendResponse({ ok: true, config: await getConfig() });
          break;
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'getBundle':
          sendResponse({ ok: true, bundle: await getBundle(msg.cid, msg.force) });
          break;
        case 'translate':
          sendResponse({ ok: true, result: await translateLines(msg.cid, msg.lines, msg.urgent, msg.slug) });
          break;
        // pagehide 觸發的最後一搏。頁面隨時會被凍結，所以立刻回應、
        // 用 keepalive 讓請求在分頁消失後仍然送達。我們不需要譯文，
        // 只是要讓伺服器把它翻出來存進共用快取。
        case 'translateKeepalive':
          sendResponse({ ok: true });
          try {
            const token = await getClientToken();
            fetch(BACKEND + '/v1/translate', {
              method: 'POST',
              keepalive: true,
              headers: { 'content-type': 'application/json', 'x-client-token': token },
              body: JSON.stringify({ cid: msg.cid || 'misc', lines: msg.lines || [] }),
            }).catch(() => {});
          } catch (e) { /* 離開途中，不做任何事 */ }
          break;
        // ---- 狀態與授權（設定頁用）----
        case 'status': {
          try {
            const h = await fetch(BACKEND + '/v1/health').then((r) => r.json());
            sendResponse({ ok: true, health: h });
          } catch (e) { sendResponse({ ok: false, error: '後端無法連線' }); }
          break;
        }
        case 'licenseStatus':
          sendResponse({ ok: true, license: await licenseStatus(msg.force) });
          break;
        case 'licenseActivate':
          sendResponse({ ok: true, result: await licenseActivate(msg.licenseKey) });
          break;
        case 'licenseDeactivate':
          sendResponse({ ok: true, result: await licenseDeactivate(msg.licenseKey, msg.installId) });
          break;
        case 'licenseDevices':
          sendResponse({ ok: true, devices: await licenseDevices() });
          break;
        case 'licenseClear':
          await chrome.storage.local.remove(['licenseKey', 'entitlement', 'entExp', 'licPlan', 'licExpiresAt']);
          sendResponse({ ok: true });
          break;
        // 產品數據。**失敗一律吞掉**——統計不該影響使用者的任何體驗。
        case 'metric':
          sendResponse({ ok: true });
          try { await api('/v1/metric', { method: 'POST', body: JSON.stringify({ events: msg.events }) }); }
          catch (e) { /* noop */ }
          break;
        case 'sendReport': {
          try {
            const d = await api('/v1/report', {
              method: 'POST',
              body: JSON.stringify({
                report: msg.report, note: msg.note, contact: msg.contact, version: msg.version,
              }),
            });
            sendResponse({ ok: true, result: d });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'markComplete':
          sendResponse({ ok: true, result: await markComplete(msg.cid, msg.segCount, msg.slug) });
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
