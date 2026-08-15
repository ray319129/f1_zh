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
  const PENDING_FLUSH_MS = 1200;   // 未命中的句子聚合多久後送去翻譯

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let site = null;                 // 目前網域適用的選擇器設定

  const memo = new Map();          // normKey -> 譯文
  let contentId = null;
  let seenContentId = null;        // 從 performance 觀察到的
  let lastPath = location.pathname;

  let lastSeenCaption = '';
  let lastRaw = '';
  let everSawCaption = false;

  const pending = new Map();       // normKey -> 原文（等待翻譯）
  let pendingTimer = null;
  let translating = false;

  const state = { bundleCount: 0, translated: 0, misses: 0, errors: 0 };

  const log = (...a) => console.log('%c[PitLingo]', 'color:#e10600;font-weight:bold', ...a);

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
  function handleCaption(raw) {
    const text = clean(raw);
    if (!text || text.length < 2 || text === lastRaw) return;
    lastRaw = text;

    const k = normKey(text);
    const hit = memo.get(k);
    if (hit) { render(hit, text); return; }

    state.misses++;
    // 沒有預先收割過的影片才會走到這裡。聚合一下再送，避免一句一個請求。
    pending.set(k, text);
    if (!pendingTimer) pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS);
  }

  async function flushPending() {
    pendingTimer = null;
    if (translating || !pending.size) return;
    translating = true;
    const batch = Array.from(pending.values()).slice(0, 40);
    const keys = Array.from(pending.keys()).slice(0, 40);
    keys.forEach((k) => pending.delete(k));
    try {
      const res = await send({ type: 'translate', cid: contentId, lines: batch });
      const lines = (res.ok && res.result && res.result.lines) || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) { memo.set(k, zh); n++; }
      state.translated += n;
      if (res.ok && res.result && res.result.error) { state.errors++; log('翻譯後端回報錯誤：', res.result.error); }
      // 剛翻好的那句可能正好還在畫面上，補顯示
      const cur = collectCaption();
      if (cur) { const zh = memo.get(normKey(clean(cur))); if (zh) render(zh, clean(cur)); }
    } catch (e) {
      state.errors++;
    } finally {
      translating = false;
      if (pending.size && !pendingTimer) pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS);
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

  function render(zh, en) {
    if (!settings.enabled) return;
    mount(); reposition();
    zhEl.textContent = zh;
    enEl.textContent = en || '';
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), settings.holdMs);
  }

  // =========================================================================
  // 影片切換
  // =========================================================================
  async function loadBundle(cid) {
    if (!cid) return;
    const res = await send({ type: 'getBundle', cid });
    const b = (res.ok && res.bundle) || {};
    let n = 0;
    for (const [k, zh] of Object.entries(b.lines || {})) { if (!memo.has(k)) { memo.set(k, zh); n++; } }
    state.bundleCount = n;
    if (n) log(`從共用快取取得 ${n} 句譯文（cid ${cid}），這些不會再花錢`);
    else if (b.error) log('共用快取讀取失敗（不影響功能，會改用即時翻譯）：', b.error);
    else log(`共用快取尚無此影片的譯文（cid ${cid}），將以即時翻譯運作`);
  }

  function checkContentChange() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; seenContentId = null; }
    scanContentIdFromPerformance();
    const cid = currentContentId();
    if (!cid || cid === contentId) return;
    const prev = contentId;
    contentId = cid;
    // 換影片時重置顯示狀態，但 memo 保留——不同影片的重複用語可以互相受惠
    lastRaw = ''; lastSeenCaption = ''; everSawCaption = false;
    pending.clear();
    observedNodes = new Set();
    if (prev) log(`影片切換 ${prev} → ${cid}`);
    loadBundle(cid);
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

    if (!site) { log('這個網域沒有對應的設定，不啟用'); return; }
    log(`PitLingo 已啟動 | 設定版本 ${config.version} | 翻譯：${settings.enabled ? '開啟' : '關閉'}`);

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
    if (area !== 'local' || !changes.settings) return;
    settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    applyHideNative();
    reposition();
    if (!settings.enabled) box.classList.remove('on');
  });

  // 給偵錯用：在 Console 打 window.__pitlingo 可以看目前狀態
  window.__pitlingo = {
    get state() { return Object.assign({ contentId, memo: memo.size, pending: pending.size, everSawCaption }, state); },
    peek: () => collectCaption(),
    settings: () => settings,
    site: () => site,
  };

  boot();
})();
