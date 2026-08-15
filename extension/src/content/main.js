/**
 * Content script（ISOLATED world）
 *
 * 職責只有三件事：
 *   1. 知道現在在看哪支影片（contentId）
 *   2. 讀出畫面上的英文字幕
 *   3. 查表 → 疊字顯示
 *
 * 網路通訊全部交給 service worker。這裡不碰任何金鑰、不注入頁面腳本、
 * 不修改 Worker——所以 F1TV 怎麼改播放器內部都影響不到我們，
 * 只有「字幕的 DOM 選擇器」這一個接觸面，而那個可以靠遠端設定熱修。
 *
 * ── 從 userscript 帶過來的教訓（都是實際踩過的坑）──
 *   #1  讀文字一律用 textContent。innerText 對隱藏元素回傳空字串
 *   #4  不要相信「註冊一次就永遠有效」——SPA 會重建 DOM，observer 會靜默失聯
 *   #11 contentId 不能只認一種網址形式
 *   #14 沒有旁白的片段（動畫、宣傳片）不是故障，不能誤報
 */

(function () {
  'use strict';

  const { clean, normKey, siteConfigFor, DEFAULT_SETTINGS } = self.PL;

  const POLL_MS = 250;             // 主動輪詢字幕的間隔（偵測主力）
  const STRUCT_MS = 1500;          // 結構性檢查的間隔

  // 逐句即時翻譯（後備路徑）的節流參數。
  // 這條路只有在影片沒被預先收割時才會用到，本來就追不上 F1 的語速，
  // 但至少要把「等待聚合」與「一次只能飛一個請求」這兩個自找的瓶頸拿掉。
  const PENDING_FLUSH_MS = 300;    // 原本 1200ms，光是等待就吃掉大半預算
  const MAX_INFLIGHT = 3;          // 允許並行，否則第二句要等第一句回來才送
  const BATCH_MAX = 20;

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let site = null;                 // 目前網域適用的選擇器設定

  const memo = new Map();          // normKey -> 譯文
  let contentId = null;
  let seenContentId = null;        // 從 performance 觀察到的
  let lastPath = location.pathname;

  let lastSeenCaption = '';
  let lastRaw = '';
  let everSawCaption = false;

  const pending = new Map();       // normKey -> 原文（待送出）
  const requested = new Set();     // 已送出、等待回應中的 normKey
  let pendingTimer = null;
  let inflight = 0;

  const state = {
    bundleCount: 0, translated: 0, misses: 0, errors: 0,
    playlistSegs: 0, segFetched: 0, segFailed: 0, prefetched: 0,
    hits: 0, isLive: false, harvestDone: false,
  };

  // ---- 事件時間軸 ----
  // 所有狀態變化都記在這裡，「匯出診斷」時一併帶出。
  // 沒有這個就只能靠翻 Console 猜，而 SW 的 log 又在另一個視窗。
  const eventLog = [];
  let phase = '啟動中';
  function logEvent(level, msg) {
    eventLog.push(`[${new Date().toISOString().slice(11, 23)}] ${level.toUpperCase().padEnd(4)} ${msg}`);
    if (eventLog.length > 400) eventLog.shift();
    const style = level === 'err' ? 'color:#e10600;font-weight:bold'
                : level === 'ok' ? 'color:#0a0;font-weight:bold'
                : level === 'warn' ? 'color:#c80;font-weight:bold'
                : 'color:#57f';
    console.log(`%c[PitLingo] ${msg}`, style);
  }
  const evOk = (m) => logEvent('ok', m);
  const evInfo = (m) => logEvent('info', m);
  const evWarn = (m) => logEvent('warn', m);
  const evErr = (m) => logEvent('err', m);
  function setPhase(p, extra) {
    if (phase === p) return;
    phase = p;
    evInfo(`▶ ${p}${extra ? ' — ' + extra : ''}`);
  }
  const log = evInfo;

  // =========================================================================
  // 與 service worker 通訊
  // =========================================================================
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }

  // =========================================================================
  // contentId
  //
  // F1TV 有多種網址形式：/detail/<id>/... 帶得到 id，/page/<id>/... 帶不到。
  // 只認網址的話，從活動頁進去看影片時整個功能會靜默失效（userscript 的坑 #11）。
  //
  // 解法：performance.getEntriesByType('resource') 會列出主執行緒發過的每一個請求，
  // 而且是**回溯的**——不用提早 hook，也不需要 webRequest 那種高風險權限。
  // 播放 API（.../CONTENT/PLAY?contentId=...）一定會出現在裡面。
  // =========================================================================
  function scanContentIdFromPerformance() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = entries[i].name.match(/[?&]contentId=(\d+)/i);
        if (m) { seenContentId = m[1]; return; }
      }
    } catch (e) { /* 不影響主要功能 */ }
  }

  /**
   * 找出播放器自己發過的 PLAY 請求網址，原封不動沿用。
   *
   * 自己拼參數踩過兩個坑：
   *   - 少了 channelId → 500 "Failed to evaluate stream rule"
   *   - 而 F1TV 有 Imperva 機器人防護（reese84 cookie），
   *     反覆試錯的請求會開始被擋（Failed to fetch）
   *
   * 播放器的網址一定是完整且合法的，重放它比猜參數可靠得多，
   * 也把請求次數壓到最低。
   */
  function findPlayApiUrl(cid) {
    try {
      const entries = performance.getEntriesByType('resource');
      let fallback = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const n = entries[i].name;
        if (!/\/CONTENT\/PLAY\?/i.test(n)) continue;
        if (cid && n.indexOf('contentId=' + cid) !== -1) return n;   // 正好是這支影片
        if (!fallback) fallback = n;
      }
      return fallback;
    } catch (e) { return null; }
  }

  function currentContentId() {
    if (site && site.contentIdPattern) {
      try {
        const m = location.pathname.match(new RegExp(site.contentIdPattern));
        if (m && m[1]) return m[1];
      } catch (e) { /* 設定裡的正則有問題就忽略 */ }
    }
    return seenContentId;
  }

  // =========================================================================
  // 字幕讀取
  // =========================================================================
  function qsAll(selectors) {
    for (const sel of selectors || []) {
      const found = document.querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    return [];
  }

  function captionContainers() { return site ? qsAll(site.captionRoot) : []; }

  /** 多視角時可能同時有多個字幕容器，取面積最大的那個（主畫面） */
  function activeContainer() {
    const list = captionContainers();
    if (list.length <= 1) return list[0] || null;
    let best = null, bestArea = -1;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = el; }
    }
    return best;
  }

  /**
   * 逐葉節點取 textContent 再用空白接起來。
   * 不用 innerText —— 它是版面感知的，元素被我們隱藏後會回傳空字串（坑 #1）。
   * 也不直接用整段 textContent —— 那樣多行字幕會黏成一團沒有空格。
   */
  function textOf(el) {
    const parts = [];
    el.querySelectorAll('*').forEach((n) => {
      if (n.firstElementChild) return;              // 只取葉節點，避免重複計算
      const t = (n.textContent || '').trim();
      if (t) parts.push(t);
    });
    if (!parts.length) {
      const t = (el.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  function collectCaption() {
    const root = activeContainer();
    if (!root) return '';
    const labels = site ? (site.captionLabel || []) : [];
    let parts = [];
    for (const sel of labels) {
      const found = root.querySelectorAll(sel);
      if (found.length) { parts = Array.from(found).map(textOf).filter(Boolean); break; }
    }
    if (!parts.length) { const t = textOf(root); if (t) parts = [t]; }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // =========================================================================
  // 輪詢為主、observer 為輔
  //
  // 這是 userscript 的坑 #4：原本只掛 MutationObserver 就以為永遠有效，
  // 但 F1TV 切換視角時會銷毀重建播放器 DOM，observer 隨之靜默失聯——
  // 不報錯、不觸發，字幕就這樣停了，使用者只覺得「時好時壞」。
  //
  // 輪詢不依賴任何註冊狀態，因此不可能失效。observer 只是讓反應更即時。
  // =========================================================================
  function pollCaption() {
    if (!settings.enabled || !site) return;
    const cur = collectCaption();
    if (cur === lastSeenCaption) return;
    lastSeenCaption = cur;

    if (!cur) {
      // 字幕清空可能只是換句空檔，也可能是切換視角導致重建。
      // 一定要重置 lastRaw，否則切回來時若第一句與切走前相同會被去重擋掉。
      lastRaw = '';
      return;
    }
    if (!everSawCaption) { everSawCaption = true; log('已偵測到第一句字幕，CC 運作正常'); }
    handleCaption(cur);
  }

  let observedNodes = new Set();
  const observers = [];
  function hookObservers() {
    const now = captionContainers();
    let changed = now.length !== observedNodes.size;
    if (!changed) for (const el of now) { if (!observedNodes.has(el)) { changed = true; break; } }
    if (!changed) return;

    observers.forEach((o) => { try { o.disconnect(); } catch (e) { /* noop */ } });
    observers.length = 0;
    observedNodes = new Set(now);
    now.forEach((node) => {
      const o = new MutationObserver(pollCaption);
      o.observe(node, { childList: true, subtree: true, characterData: true });
      observers.push(o);
    });
  }

  // =========================================================================
  // 翻譯：先查快取，未命中才聚合送後端
  // =========================================================================
  let currentEn = '';              // 畫面上正在顯示的英文原句

  function handleCaption(raw) {
    const text = clean(raw);
    if (!text || text.length < 2 || text === lastRaw) return;
    lastRaw = text;
    currentEn = text;

    const k = normKey(text);
    const hit = memo.get(k);
    if (hit) { state.hits++; render(hit, text); return; }

    state.misses++;
    // 走到這裡代表預抓還沒涵蓋到這句。
    // 不顯示「翻譯中…」之類的佔位字——那會一直在畫面上閃、非常分心。
    // 就讓畫面保持空白，譯文回來時若這句還在螢幕上就補顯示。

    if (requested.has(k)) return;  // 已經送出去了，等回應就好
    pending.set(k, text);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (pendingTimer) return;
    pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS);
  }

  async function flushPending() {
    pendingTimer = null;
    if (!pending.size) return;
    if (inflight >= MAX_INFLIGHT) { scheduleFlush(); return; }

    const keys = Array.from(pending.keys()).slice(0, BATCH_MAX);
    const batch = keys.map((k) => pending.get(k));
    keys.forEach((k) => { pending.delete(k); requested.add(k); });

    inflight++;
    try {
      const res = await send({ type: 'translate', cid: contentId, lines: batch });
      const lines = (res.ok && res.result && res.result.lines) || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) { memo.set(k, zh); n++; }
      state.translated += n;
      if (res.ok && res.result && res.result.error) {
        state.errors++;
        log('翻譯後端回報錯誤：', res.result.error);
      }
      // 譯文可能正好對應畫面上還在顯示的那一句，補上去
      if (currentEn) {
        const zh = memo.get(normKey(currentEn));
        if (zh) render(zh, currentEn);
      }
    } catch (e) {
      state.errors++;
    } finally {
      keys.forEach((k) => requested.delete(k));
      inflight--;
      if (pending.size) scheduleFlush();
    }
  }

  // =========================================================================
  // 疊字層
  // =========================================================================
  const box = document.createElement('div');
  box.id = 'pitlingo-box';
  const zhEl = document.createElement('div'); zhEl.id = 'pitlingo-zh';
  const enEl = document.createElement('div'); enEl.id = 'pitlingo-en';
  box.appendChild(zhEl);
  box.appendChild(enEl);

  let hideTimer = null;
  let hideStyleEl = null;

  function applyHideNative() {
    const want = settings.enabled && settings.hideNativeCC && site && site.hideCss;
    if (want && !hideStyleEl) {
      hideStyleEl = document.createElement('style');
      // 用 opacity 而非 visibility：visibility:hidden 會讓文字讀不到（坑 #1），
      // 而且我們還要靠這個容器的矩形來定位疊字，必須保留版面。
      hideStyleEl.textContent = site.hideCss;
      (document.head || document.documentElement).appendChild(hideStyleEl);
    } else if (!want && hideStyleEl) {
      hideStyleEl.remove(); hideStyleEl = null;
    }
  }

  /** 全螢幕時疊字層必須搬進 fullscreen element，否則整個看不到 */
  function mount() {
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (host && box.parentElement !== host) host.appendChild(box);
  }

  function mainVideoRect() {
    let best = null;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) return;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    });
    return best;
  }

  function reposition() {
    const vr = mainVideoRect();
    // 優先貼齊原生字幕容器：我們用 opacity 隱藏它，版面仍在，
    // 所以它的矩形就是 F1TV 原本要放字幕的精確位置（多視角也會落在正確那一格）
    let r = null, tight = false;
    const c = activeContainer();
    if (c) {
      const cr = c.getBoundingClientRect();
      if (cr.width > 40 && cr.height > 8) { r = cr; tight = true; }
    }
    if (!r) r = vr;
    if (!r) return;

    box.style.left = (r.left + r.width / 2) + 'px';
    box.style.bottom = tight
      ? (window.innerHeight - r.bottom) + 'px'
      : (window.innerHeight - r.bottom + r.height * settings.bottomPct / 100) + 'px';
    box.style.maxWidth = (r.width * 0.95) + 'px';

    // 字級依主畫面寬度縮放，避免字幕容器寬度變動導致字體忽大忽小
    const scale = Math.max(0.5, (vr ? vr.width : r.width) / 1280);
    zhEl.style.fontSize = Math.round(settings.fontSize * scale) + 'px';
    enEl.style.fontSize = Math.round(settings.fontSize * 0.62 * scale) + 'px';
    enEl.style.display = settings.showEnglish ? 'inline-block' : 'none';
  }

  function show(zhText, enText, isPending) {
    if (!settings.enabled) return;
    mount(); reposition();
    zhEl.textContent = zhText;
    zhEl.classList.toggle('pending', !!isPending);
    enEl.textContent = enText || '';
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), settings.holdMs);
  }

  function render(zh, en) { show(zh, en, false); }

  // =========================================================================
  // 預抓 —— 擴充功能能不能跟上語速的關鍵
  //
  // 只讀 DOM 的話提前量是 0：字幕出現在畫面上我們才知道有這句，
  // 翻譯來回 1~3 秒，而轉播每 3~4 秒一句，永遠追不上。
  //
  // 但播放器本來就會**提前約 50 秒**下載字幕分段。只要我們也拿得到那些分段，
  // 就等於拿回同樣的提前量。userscript 是靠注入 Worker 攔截，
  // 擴充功能不需要——master 網址本來就來自主執行緒的 PLAY API，
  // 而我們有 host_permissions，可以自己發同一個請求。
  //
  //   PLAY API → master m3u8 → 字幕清單 → VTT 分段 → 批次翻譯 → 存進快取
  //
  // 重播：一次抓完整支。直播：滑動視窗，定期重抓補新分段。
  // =========================================================================
  const FETCH_CONCURRENCY = 3;
  const FETCH_GAP_MS = 60;
  const LIVE_REFRESH_MS = 20000;

  let harvestGen = 0;
  let harvestInFlight = false;
  let subtitlePlaylistUrl = null;
  const seenSegments = new Set();     // 已抓過的分段網址，直播重抓時用來去重
  const prefetchSeen = new Set();     // 已排入翻譯的 normKey
  let liveTimer = null;

  // -------------------------------------------------------------------------
  // 授權權杖
  //
  // PLAY API 回：「Missing parameter Ascendon Token or Entitlement Token or
  // Access Token」——光有 cookies 不夠，還要帶授權 header。
  //
  // 關鍵事實：content script 雖然跑在 ISOLATED world，但 localStorage 是依
  // **來源**隔離的，不是依 world。所以我們讀得到 F1TV 存的登入資訊。
  //
  // ⚠️ 權杖值**絕對不可以**寫進診斷報告——那份報告是要貼給別人看的。
  //    只記錄鍵名與長度。
  // -------------------------------------------------------------------------
  // 欄位名優先序：越前面越像我們要的那個
  const TOKEN_FIELD_HINT = /subscriptionToken|ascendon|entitlement|accessToken|access_token|idToken|\btoken\b|jwt/i;

  // 這些來源只會製造雜訊。ABTastyData 實測有 18,065 字元的 A/B 測試資料，
  // 裡面一堆長字串會被誤判成權杖，把真正的 cookie 權杖擠出候選清單。
  const NOISE_KEY = /^(NRBA_|nr@|_ga|_gid|OptanonC|__utm|amplitude|mp_|ajs_|ABTasty|sp_|_sp_|ClearVR|reese84|consent|_rdt|_sfid|_evga|loglevel|isFirstRendering)/i;

  /**
   * 值必須能當成 HTTP header 送出去。
   *
   * 實測踩到兩次：把整包 JSON（`{"data":{…}}`）當 header 值送，
   * Chrome 直接拒絕整個請求（Failed to fetch）；把還帶 %2F 的
   * URL-encoded 字串送出去，伺服器解 JWT 失敗回 500。
   * 兩者都不是認證問題，是格式問題。
   */
  function isHeaderSafe(v) {
    if (typeof v !== 'string' || v.length < 20 || v.length > 8000) return false;
    if (/^[[{]/.test(v.trim())) return false;              // JSON 物件／陣列
    if (/%[0-9A-Fa-f]{2}/.test(v)) return false;           // 還沒解碼的 URL-encoding
    return /^[\x21-\x7E]+$/.test(v);                       // 只允許可列印 ASCII、不含空白
  }

  /** 來源可信度評分：越高越可能是真正的授權權杖 */
  function tokenScore(src) {
    let s = 10;
    if (/subscriptionToken/i.test(src)) s = 100;
    else if (/entitlement/i.test(src)) s = 95;
    else if (/login-session/i.test(src)) s = 90;
    else if (/ascendon/i.test(src)) s = 85;
    else if (/^cookie:/i.test(src)) s = 50;
    else if (/\/token$|\/jwt$/i.test(src)) s = 30;
    if (/\(decoded\)/i.test(src)) s += 3;                  // 解碼後的版本才是能用的
    return s;
  }
  let authTokenCache = null;
  let authSources = [];            // 只記錄「來源:鍵名(長度)」，絕不記錄值
  let authBestHeader = null;       // 伺服器確實讀到的那個 header 名稱
  let authRejected = 0;            // 因為不能當 header 值而被剔除的候選數
  let authPlayUrlFound = false;    // 是否找到播放器自己的 PLAY 網址可沿用

  /** JWT 或夠長的無空白字串才可能是權杖 */
  function looksLikeToken(s) {
    if (typeof s !== 'string') return false;
    if (/\s/.test(s)) return false;
    if (/^ey[A-Za-z0-9_-]+\./.test(s)) return true;    // JWT
    return s.length >= 40;
  }

  let srcTag = '?';
  function harvestStrings(obj, out, depth) {
    depth = depth || 0;
    if (depth > 6 || obj == null || out.length > 60) return;
    if (typeof obj === 'string') {
      if (looksLikeToken(obj)) out.push({ v: obj, src: srcTag });
      // 值本身可能又是一層 JSON 或 URL-encoded JSON
      if (obj.length > 20 && /[{%]/.test(obj)) {
        try { harvestStrings(JSON.parse(decodeURIComponent(obj)), out, depth + 1); } catch (e) { /* noop */ }
      }
      return;
    }
    if (typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      // 欄位名命中提示詞的優先排到最前面
      if (typeof v === 'string' && looksLikeToken(v) && TOKEN_FIELD_HINT.test(k)) {
        out.unshift({ v, src: srcTag + '/' + k }); continue;
      }
      harvestStrings(v, out, depth + 1);
    }
  }

  function scanStore(store, label, out) {
    let keys = [];
    try { keys = Object.keys(store); } catch (e) { return; }
    for (const key of keys) {
      if (NOISE_KEY.test(key)) continue;
      let raw = '';
      try { raw = store.getItem(key) || ''; } catch (e) { continue; }
      if (!raw) continue;
      authSources.push(`${label}:${key}(${raw.length})`);
      srcTag = `${label}:${key}`;
      try { harvestStrings(JSON.parse(raw), out); }
      catch (e) { harvestStrings(raw, out); }
    }
  }

  /**
   * 從三個來源找授權權杖。
   *
   * 上一輪只掃「鍵名含 token/session」的 localStorage，結果一無所獲——
   * F1TV 把登入資訊放在 **cookie**（慣例是 login-session，內含
   * URL-encoded JSON 的 subscriptionToken），播放器讀出來再放進 header。
   * `credentials:'include'` 雖然會送 cookie，但伺服器要的是 header，所以照樣 400。
   *
   * 這次不做鍵名過濾，改成掃全部再用「值長得像不像權杖」判斷。
   * HttpOnly 的 cookie 讀不到，由 SW 用 chrome.cookies 補。
   */
  async function findAuthTokens() {
    if (authTokenCache) return authTokenCache;
    const out = [];
    authSources = [];

    // 先掃 cookie —— 真正的授權權杖在這裡，不能被 localStorage 的雜訊擠掉
    try {
      for (const part of document.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const name = part.slice(0, i).trim();
        const val = part.slice(i + 1).trim();
        if (!name || !val || NOISE_KEY.test(name)) continue;
        authSources.push(`CK:${name}(${val.length})`);
        srcTag = `cookie:${name}`;
        harvestStrings(decodeURIComponent(val), out);
      }
    } catch (e) { /* noop */ }

    // HttpOnly 的 cookie 只有 SW 拿得到
    const ck = await send({ type: 'getCookieTokens' });
    if (ck.ok && ck.tokens) {
      out.push(...ck.tokens);
      authSources.push(...(ck.names || []).map((n) => `CK*:${n}`));
    }

    scanStore(localStorage, 'LS', out);
    scanStore(sessionStorage, 'SS', out);

    // 依來源可信度排序後才截斷。
    // 之前是「先進先出再 slice(12)」，結果 localStorage 的雜訊佔滿名額
    // （ABTastyData 一個就 18KB），後掃到的 cookie 權杖全被切掉——
    // 實測嘗試清單裡一個 cookie 來源都沒有。
    const seen = new Set();
    const all = out.filter((t) => (t && t.v && !seen.has(t.v)) ? (seen.add(t.v), true) : false);
    const usable = all.filter((t) => isHeaderSafe(t.v));
    authTokenCache = usable
      .sort((a, b) => tokenScore(b.src || '') - tokenScore(a.src || ''))
      .slice(0, 12);
    authRejected = all.length - usable.length;
    evInfo(`授權權杖探索：掃過 ${authSources.length} 個來源，取得 ${authTokenCache.length} 個可用候選` +
      (authRejected ? `（另有 ${authRejected} 個因格式不合被剔除）` : ''));
    return authTokenCache;
  }

  async function swFetchText(url) {
    const res = await send({ type: 'fetchText', url });
    if (!res.ok) throw new Error(res.error || 'fetch 失敗');
    return res.text;
  }

  /** 從 master m3u8 找出英文字幕軌的播放清單位址 */
  function findSubtitlePlaylist(masterBody, masterUrl) {
    const re = /#EXT-X-MEDIA:([^\n]*TYPE=SUBTITLES[^\n]*)/gi;
    let m, best = null;
    while ((m = re.exec(masterBody))) {
      const attrs = m[1];
      const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1];
      if (!uri) continue;
      const lang = (attrs.match(/LANGUAGE="([^"]+)"/i) || [])[1] || '';
      if (!best) best = { uri, lang };
      if (/^en/i.test(lang)) { best = { uri, lang }; break; }
    }
    if (!best) return null;
    try { return { url: new URL(best.uri, masterUrl).href, lang: best.lang }; }
    catch (e) { return null; }
  }

  function parseMediaPlaylist(body, baseUrl) {
    const segs = [];
    let dur = 0;
    body.replace(/\r/g, '').split('\n').forEach((raw) => {
      const t = raw.trim();
      if (!t) return;
      if (/^#EXTINF:/i.test(t)) { dur = parseFloat(t.slice(8)) || 0; return; }
      if (t[0] === '#') return;
      try { segs.push({ url: new URL(t, baseUrl).href, dur }); } catch (e) { /* noop */ }
      dur = 0;
    });
    return { segs, isVod: /#EXT-X-ENDLIST/i.test(body) };
  }

  /** 極簡 WebVTT 解析：只要 cue 文字，不要時間軸 */
  function parseVtt(raw) {
    const out = [];
    if (!raw || raw.indexOf('-->') === -1) return out;
    let cur = null;
    String(raw).replace(/\r\n?/g, '\n').split('\n').forEach((ln) => {
      if (ln.indexOf('-->') !== -1) { if (cur && cur.length) out.push(cur.join(' ')); cur = []; return; }
      if (cur === null) return;
      if (ln.trim() === '') { if (cur.length) { out.push(cur.join(' ')); cur = null; } return; }
      cur.push(ln.trim());
    });
    if (cur && cur.length) out.push(cur.join(' '));
    return out;
  }

  function ingestVtt(text) {
    let added = 0;
    for (const cue of parseVtt(text)) {
      const t = clean(cue);
      if (!t || t.length < 2) continue;
      const k = normKey(t);
      if (!k || prefetchSeen.has(k)) continue;
      prefetchSeen.add(k);
      if (memo.has(k)) continue;          // 共用快取已有，不用再翻
      pending.set(k, t);
      added++;
    }
    if (added) scheduleFlush();
    return added;
  }

  async function fetchSegments(list, myGen) {
    let idx = 0, lastPct = -1;
    const worker = async () => {
      while (idx < list.length && myGen === harvestGen && settings.enabled) {
        const s = list[idx++];
        if (seenSegments.has(s.url)) continue;
        seenSegments.add(s.url);
        try {
          const t = await swFetchText(s.url);
          state.segFetched++;
          ingestVtt(t);
        } catch (e) { state.segFailed++; }
        const pct = Math.floor((state.segFetched / Math.max(1, list.length)) * 10) * 10;
        if (pct > lastPct && pct > 0 && pct < 100) {
          lastPct = pct;
          evInfo(`預抓進度 ${pct}%（${state.segFetched}/${list.length} 段，待翻 ${pending.size} 句）`);
        }
        if (FETCH_GAP_MS) await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
      }
    };
    await Promise.all(new Array(FETCH_CONCURRENCY).fill(0).map(worker));
  }

  /** 直播：字幕清單是滑動視窗，定期重抓才能持續拿到 live edge 的新分段 */
  async function refreshLive(myGen) {
    if (myGen !== harvestGen || !subtitlePlaylistUrl) return;
    try {
      const body = await swFetchText(subtitlePlaylistUrl);
      const { segs } = parseMediaPlaylist(body, subtitlePlaylistUrl);
      const fresh = segs.filter((s) => !seenSegments.has(s.url));
      if (fresh.length) {
        evInfo(`直播：清單新增 ${fresh.length} 段`);
        await fetchSegments(fresh, myGen);
      }
    } catch (e) { evWarn(`直播清單更新失敗：${e.message}`); }
    if (myGen === harvestGen) liveTimer = setTimeout(() => refreshLive(myGen), LIVE_REFRESH_MS);
  }

  async function startPrefetch(cid) {
    if (harvestInFlight || !cid) return;
    harvestInFlight = true;
    const myGen = harvestGen;
    setPhase('取得串流位址');
    try {
      const tokens = await findAuthTokens();
      const playUrl = findPlayApiUrl(cid);
      authPlayUrlFound = !!playUrl;
      if (playUrl) evInfo(`沿用播放器自己的 PLAY 網址（參數完整，不用猜）`);
      const pb = (await send({ type: 'resolvePlayback', cid, tokens, playUrl })).playback || {};
      if (!pb.ok || !pb.master) {
        const NL = String.fromCharCode(10);
        evWarn('取不到串流位址（HTTP ' + (pb.status || '?') + '）'
          + '，已試 ' + (pb.attemptsMade || 0) + ' 種組合（' + (pb.tokensTried || 0) + ' 個候選權杖）'
          + (pb.tried && pb.tried.length
              ? NL + '    嘗試過的配對：' + NL + '      ' + pb.tried.join(NL + '      ')
              : '')
          + (pb.topKeys && pb.topKeys.length ? NL + '    回應欄位：' + pb.topKeys.join(', ') : '')
          + (pb.hint ? NL + '    伺服器回應：' + pb.hint : ''));
        if (pb.best) {
          authBestHeader = pb.best.headerNames.join(' + ');
          evWarn(`✔ header 名稱正確：${pb.best.headerNames.join(' + ')}（HTTP ${pb.best.status}）
` +
            `    伺服器已讀到權杖但不接受 → 值有問題（可能是舊的，或播放器另外換發）
` +
            `    ${pb.best.msg}`);
        }
        evWarn('退回逐句即時翻譯（會跟不上語速）。請把診斷報告貼給開發者。');
        setPhase('逐句模式');
        return;
      }
      evOk(`取得串流位址（授權 header：${pb.usedHeader}）`);

      setPhase('讀取字幕清單');
      const masterBody = await swFetchText(pb.master);
      const sp = findSubtitlePlaylist(masterBody, pb.master);
      if (!sp) { evWarn('master 裡找不到字幕軌'); setPhase('逐句模式'); return; }

      subtitlePlaylistUrl = sp.url;
      const body = await swFetchText(sp.url);
      const { segs, isVod } = parseMediaPlaylist(body, sp.url);
      state.playlistSegs = segs.length;
      state.isLive = !isVod;

      if (isVod) {
        setPhase('預抓中', `${segs.length} 段`);
        evInfo(`字幕分段共 ${segs.length} 個（重播，一次抓完）`);
        // 從目前播放位置開始，讓馬上要用到的先翻，不要先去翻片尾
        const v = document.querySelector('video');
        const cur = (v && isFinite(v.currentTime)) ? v.currentTime : 0;
        let acc = 0, start = 0;
        for (let i = 0; i < segs.length; i++) {
          if (acc + segs[i].dur > cur) { start = i; break; }
          acc += segs[i].dur;
        }
        await fetchSegments(segs.slice(start).concat(segs.slice(0, start)), myGen);
        if (myGen !== harvestGen) { evInfo('預抓已中止（影片切換）'); return; }
        state.harvestDone = state.segFailed === 0;
        evOk(`預抓完成：${state.segFetched} 段成功、${state.segFailed} 段失敗，待翻 ${pending.size} 句`);
      } else {
        setPhase('直播預抓中');
        evInfo(`偵測到直播（無 EXT-X-ENDLIST），改用滑動視窗持續補抓`);
        await fetchSegments(segs, myGen);
        liveTimer = setTimeout(() => refreshLive(myGen), LIVE_REFRESH_MS);
      }
    } catch (e) {
      evErr(`預抓失敗：${e.message}`);
      setPhase('逐句模式');
    } finally {
      harvestInFlight = false;
    }
  }

  // =========================================================================
  // 影片切換
  // =========================================================================
  /**
   * 取回整支影片的譯文。
   *
   * 一定要能重試：實測過「啟動時金鑰還沒填 → 401 → 之後永遠不再嘗試」，
   * 結果整場都走最慢的逐句路徑。任何暫時性失敗都該自己恢復。
   */
  let bundleRetryTimer = null;
  let bundleAttempts = 0;
  const BUNDLE_MAX_ATTEMPTS = 5;

  async function loadBundle(cid, isRetry) {
    if (!cid) return;
    clearTimeout(bundleRetryTimer);
    if (!isRetry) bundleAttempts = 0;

    const res = await send({ type: 'getBundle', cid });
    const b = (res.ok && res.bundle) || {};
    let n = 0;
    for (const [k, zh] of Object.entries(b.lines || {})) { if (!memo.has(k)) { memo.set(k, zh); n++; } }
    state.bundleCount = n;

    if (n) { evOk(`☁ 從共用快取取得 ${n} 句譯文（cid ${cid}），這些不會再花錢`); return; }

    if (b.error) {
      bundleAttempts++;
      const hint = /401/.test(b.error) ? '（存取金鑰無效或尚未設定）' : '';
      if (bundleAttempts < BUNDLE_MAX_ATTEMPTS) {
        const wait = Math.min(30000, 3000 * bundleAttempts);   // 3s、6s、9s…
        log(`共用快取讀取失敗${hint}：${b.error}，${wait / 1000} 秒後重試（${bundleAttempts}/${BUNDLE_MAX_ATTEMPTS}）`);
        bundleRetryTimer = setTimeout(() => loadBundle(cid, true), wait);
      } else {
        log(`共用快取讀取失敗${hint}：${b.error}。已停止重試，改用逐句即時翻譯（較慢且較貴）。`);
      }
      return;
    }
    log(`共用快取尚無此影片的譯文（cid ${cid}），將以逐句即時翻譯運作`);
  }

  function checkContentChange() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; seenContentId = null; }
    scanContentIdFromPerformance();
    const cid = currentContentId();
    if (!cid || cid === contentId) return;
    const prev = contentId;
    contentId = cid;
    // 換影片時重置顯示狀態，但 memo 保留——不同影片的重複用語可以互相受惠
    lastRaw = ''; lastSeenCaption = ''; everSawCaption = false; currentEn = '';
    pending.clear(); requested.clear();
    clearTimeout(bundleRetryTimer); bundleAttempts = 0;
    observedNodes = new Set();

    // 讓還在跑的預抓自行中止，並清掉上一支的收割狀態
    harvestGen++;
    clearTimeout(liveTimer);
    subtitlePlaylistUrl = null;
    seenSegments.clear(); prefetchSeen.clear();
    state.playlistSegs = 0; state.segFetched = 0; state.segFailed = 0;
    state.isLive = false; state.harvestDone = false;

    if (prev) { setPhase('切換影片'); evInfo(`影片切換 ${prev} → ${cid}`); }
    loadBundle(cid).then(() => startPrefetch(cid));
  }

  // =========================================================================
  // 啟動
  // =========================================================================
  async function boot() {
    const [cfgRes, setRes] = await Promise.all([
      send({ type: 'getConfig' }),
      send({ type: 'getSettings' }),
    ]);
    const config = (cfgRes.ok && cfgRes.config) || self.PL.BUILT_IN_CONFIG;
    settings = Object.assign({}, DEFAULT_SETTINGS, (setRes.ok && setRes.settings) || {});
    site = siteConfigFor(config, location.hostname);

    if (!site) { evWarn('這個網域沒有對應的設定，不啟用'); return; }
    setPhase('等待播放');
    evOk(`PitLingo v${chrome.runtime.getManifest().version} 已啟動　|　設定版本 ${config.version}`
       + `　|　翻譯：${settings.enabled ? '開啟' : '關閉'}`);
    evInfo('提示：擴充功能圖示 →「匯出診斷」可一鍵複製完整狀態');

    applyHideNative();
    mount();

    setInterval(pollCaption, POLL_MS);
    setInterval(() => {
      checkContentChange();
      hookObservers();
      mount();
      reposition();
    }, STRUCT_MS);

    ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach((e) =>
      window.addEventListener(e, () => { mount(); reposition(); }, true));

    checkContentChange();
  }

  // 設定在選項頁被改動時即時反映，不用重新整理
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.settings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
      applyHideNative();
      reposition();
      if (!settings.enabled) box.classList.remove('on');
    }

    // 金鑰是後填的很常見（開了播放頁才想到要設定）。
    // 一填好就立刻重抓 bundle，不必等使用者重新整理或換影片。
    if (changes.clientToken && contentId) {
      log('偵測到存取金鑰更新，重新讀取共用快取');
      bundleAttempts = 0;
      loadBundle(contentId);
    }
  });

  // =========================================================================
  // 診斷報告
  // 一鍵匯出所有狀態。回報問題時直接貼這份，不用翻 Console，
  // 也不用另外去 chrome://extensions 開 service worker 的視窗。
  // =========================================================================
  function buildDiagnostics() {
    const L = [];
    const v = document.querySelector('video');
    const rootEl = activeContainer();
    L.push('════════ PitLingo 擴充功能 診斷報告 ════════');
    L.push(`產生時間　：${new Date().toISOString()}`);
    L.push(`版本　　　：${chrome.runtime.getManifest().version}`);
    L.push(`目前階段　：${phase}`);
    L.push(`網址　　　：${location.href}`);
    L.push(`UA　　　　：${navigator.userAgent}`);
    L.push('');
    L.push('──── 影片與字幕 ────');
    L.push(`contentId　：${contentId || '(無)'}（網址 ${(location.pathname.match(/\/detail\/(\d+)/) || [])[1] || '-'} / 觀察 ${seenContentId || '-'}）`);
    L.push(`video　　　：${v ? `${v.paused ? '暫停' : '播放中'} ${v.currentTime.toFixed(1)}s / ${v.duration}` : '無'}`);
    L.push(`字幕容器　：${captionContainers().length} 個（觀察中 ${observedNodes.size}）`);
    L.push(`容器文字長：${rootEl ? (rootEl.textContent || '').trim().length : 0} 字`);
    L.push(`目前抓到　：${collectCaption() || '(空)'}`);
    L.push(`曾看到字幕：${everSawCaption ? '是' : '否'}`);
    L.push('');
    L.push('──── 授權（PLAY API 需要）────');
    L.push(`掃過的來源（LS=localStorage SS=sessionStorage CK=cookie CK*=HttpOnly cookie）：`);
    L.push(authSources.length ? '  ' + authSources.join('\n  ') : '  (尚未掃描)');
    L.push(`候選權杖數　：${authTokenCache ? authTokenCache.length : 0}　※ 報告不含任何權杖內容`);
    L.push(`候選來源（依可信度排序）：${authTokenCache && authTokenCache.length
      ? authTokenCache.map((t) => t.src).join(' | ') : '(無)'}`);
    L.push(`格式不合被剔除：${authRejected} 個`);
    L.push(`沿用播放器的 PLAY 網址：${authPlayUrlFound ? '是（參數完整）' : '否（自行拼接，可能缺 channelId）'}`);
    L.push(`正確的 header：${authBestHeader || '(尚未確認)'}`);
    L.push('');
    L.push('──── 預抓（決定跟不跟得上語速）────');
    L.push(`型態　　　：${state.isLive ? '直播（滑動視窗）' : '重播'}`);
    L.push(`字幕清單　：${subtitlePlaylistUrl ? subtitlePlaylistUrl.slice(0, 120) : '(尚未取得)'}`);
    L.push(`分段　　　：清單 ${state.playlistSegs} / 已抓 ${state.segFetched}（失敗 ${state.segFailed}）`);
    L.push(`收割完成　：${state.harvestDone}　進行中：${harvestInFlight}　世代 ${harvestGen}`);
    L.push('');
    L.push('──── 翻譯 ────');
    L.push(`共用快取取得：${state.bundleCount} 句`);
    L.push(`本機快取　：${memo.size} 句`);
    L.push(`命中 / 未命中：${state.hits} / ${state.misses}`);
    L.push(`即時翻譯　：${state.translated} 句　錯誤 ${state.errors}`);
    L.push(`待送出　　：${pending.size} 句　飛行中 ${inflight} 個請求（上限 ${MAX_INFLIGHT}）`);
    L.push('');
    L.push('──── 設定 ────');
    L.push(JSON.stringify(settings));
    L.push(`選擇器：${JSON.stringify(site && { root: site.captionRoot, label: site.captionLabel })}`);
    L.push('');
    L.push(`──── 事件時間軸（最近 ${Math.min(eventLog.length, 150)} 筆）────`);
    L.push(eventLog.slice(-150).join('\n'));
    L.push('');
    L.push('════════ 報告結束 ════════');
    return L.join('\n');
  }

  // 選項頁按「匯出診斷」時會來要這份報告
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'collectDiagnostics') {
      sendResponse({ ok: true, report: buildDiagnostics() });
      return true;
    }
    return false;
  });

  // 給偵錯用：在 Console 打 window.__pitlingo 可以看目前狀態
  window.__pitlingo = {
    diag: () => { const r = buildDiagnostics(); console.log(r); return r; },
    events: () => { console.log(eventLog.join('\n')); return eventLog.length; },
    prefetch: () => startPrefetch(contentId),
    get state() {
      return Object.assign({
        contentId, memo: memo.size, pending: pending.size,
        requested: requested.size, inflight, everSawCaption,
      }, state);
    },
    peek: () => collectCaption(),
    settings: () => settings,
    site: () => site,
  };

  boot();
})();
