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

  // 100ms（原 250ms）。observer 正常時輪詢只是備援，這個間隔不重要；
  // 但 observer 失聯時它就是唯一的偵測手段，而 250ms 直接加在顯示延遲上。
  // collectCaption() 只掃字幕容器內的少數節點，100ms 的成本可以接受。
  // 實際 observer 有沒有在作用，看診斷報告的「偵測來源」那兩個數字。
  const POLL_MS = 100;             // 主動輪詢字幕的間隔（偵測備援）
  const STRUCT_MS = 1500;          // 結構性檢查的間隔
  const STALL_MS = 2500;           // 超過這麼久沒輪詢到，判定分頁被節流過

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
  const batchStats = [];           // { sent, got, ms } — 診斷用，看批次效率

  const state = {
    bundleCount: 0, translated: 0, misses: 0, errors: 0,
    playlistSegs: 0, segFetched: 0, segFailed: 0, prefetched: 0,
    workerPatched: 0, workerVtt: 0, manifests: 0, prefetchAnnounced: false,
    serverCount: -1,               // 回寫查核：後端實際有幾句（-1 = 尚未查核）
    harvestSkipped: false,         // 是否因為「已有人收割完整」而跳過整軌預抓
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

  /**
   * 詳細日誌（每句字幕、每個批次都印）。
   *
   * 為什麼要獨立一個層級：正常使用時每 3~4 秒印一行只是噪音，
   * 但測試階段看不到這些就只能猜。預設關閉，兩種方式打開：
   *   - 設定頁勾「詳細日誌」
   *   - Console 打 `__pitlingo.debug(true)`（立即生效，不用重整）
   *
   * 這些**不寫進事件時間軸**——時間軸只有 400 筆，被逐句訊息灌爆的話，
   * 匯出診斷時就看不到真正重要的狀態變化了。
   */
  let debugOn = false;
  function dbg(msg) {
    if (!debugOn) return;
    console.log(`%c[PitLingo·debug] ${msg}`, 'color:#888');
  }
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
  /**
   * 輪詢停擺偵測。
   *
   * 實測回報：看到一半字幕停了一小段，「動了動滑鼠就好」。
   * 最可能的原因是 Chrome 對被遮蔽（occluded）或背景分頁的計時器做節流——
   * setInterval 會被拉長到每分鐘一次，於是 250ms 的輪詢與 1.5 秒的結構檢查
   * 全部失效；滑鼠一動視窗回到前景，計時器恢復正常。
   *
   * 這是推測而非確認，但不論真正原因為何，處理方式都一樣：
   * **偵測到自己剛剛被凍結，就強制做一次完整重檢**，而不是假設狀態還新鮮。
   */
  let lastPollAt = Date.now();
  function checkPollStall() {
    const gap = Date.now() - lastPollAt;
    lastPollAt = Date.now();
    // 門檻用絕對值，不要用 POLL_MS 的倍數。
    // 輪詢間隔從 250ms 調到 100ms 時，倍數寫法會把門檻一起縮到 800ms，
    // 那已經落在正常抖動範圍內，會開始誤報停擺並無謂地整組重掛觀察者。
    if (gap < STALL_MS) return false;             // 正常抖動
    evWarn(`偵測到輪詢停擺 ${Math.round(gap / 1000)} 秒（分頁可能被瀏覽器節流），強制重檢`);
    observedNodes = new Set();                    // 逼 hookObservers 整組重掛
    hookObservers();
    lastSeenCaption = ''; lastRaw = '';           // 清掉去重狀態，避免漏掉停擺期間那句
    mount(); reposition();
    return true;
  }

  /**
   * 偵測來源統計 —— 用來回答「0.5 秒的延遲有多少是我們造成的」。
   *
   * 顯示延遲＝(a) F1TV 自己把字幕畫進 DOM 的時機 ＋ (b) 我們發現它的時間。
   * 只有 (b) 是我們能改的，而兩者靠猜分不開。
   *
   * observer 命中代表 (b) 幾乎是 0（mutation 當下就處理）；
   * 輪詢命中代表 observer 沒作用，(b) 最壞是一個 POLL_MS。
   * 兩邊的比例直接告訴我們該不該把力氣花在調輪詢間隔上。
   */
  const detect = { byObserver: 0, byPoll: 0, renderMs: [] };
  let inObserverTick = false;

  function onMutation() {
    inObserverTick = true;
    try { pollCaption(); } finally { inObserverTick = false; }
  }

  function pollCaption() {
    checkPollStall();
    if (!settings.enabled || !site) return;
    const cur = collectCaption();
    if (cur === lastSeenCaption) return;
    lastSeenCaption = cur;
    if (cur) {
      if (inObserverTick) detect.byObserver++; else detect.byPoll++;
      dbg(`偵測到字幕（${inObserverTick ? 'observer' : '輪詢'}）：${cur.slice(0, 60)}`);
    }

    if (!cur) {
      // 字幕清空可能只是換句空檔，也可能是切換視角導致重建。
      // 一定要重置 lastRaw，否則切回來時若第一句與切走前相同會被去重擋掉。
      lastRaw = '';
      // currentEn 也要清。它是「補顯示」的依據，不清的話畫面上明明沒字幕了，
      // 慢回來的翻譯還是會把那句舊的重新畫出來。
      currentEn = '';
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
      const o = new MutationObserver(onMutation);
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
    if (hit) {
      state.hits++;
      const t0 = Date.now();
      render(hit, text);
      const ms = Date.now() - t0;
      detect.renderMs.push(ms);
      if (detect.renderMs.length > 200) detect.renderMs.shift();
      dbg(`命中本機快取（繪製 ${ms}ms）：${hit.slice(0, 40)}`);
      return;
    }

    state.misses++;
    dbg(`未命中，排入佇列：${text.slice(0, 60)}`);
    // 走到這裡代表預抓還沒涵蓋到這句。
    // 不顯示「翻譯中…」之類的佔位字——那會一直在畫面上閃、非常分心。
    // 就讓畫面保持空白，譯文回來時若這句還在螢幕上就補顯示。

    if (requested.has(k)) return;  // 已經送出去了，等回應就好
    pending.set(k, text);
    scheduleFlush();
  }

  /**
   * 收割期間不要讓計時器把批次切碎（userscript 坑 #10）。
   *
   * 整軌預抓時 383 個分段會在一分多鐘內陸續到齊，每段只帶 2~3 句新的。
   * 300ms 的 flush 計時器一到就把那零星幾句送出去，於是批次平均只有 4.8 句——
   * userscript 同樣的片子是 14.9 句。批次小三倍，API 呼叫就多三倍。
   *
   * 收割期間改成「湊滿 BATCH_MAX 才送」，收割結束時再把剩下的一次倒出去。
   * 這不影響即時性：收割中的句子本來就是未來 40 分鐘才會用到的。
   */
  function scheduleFlush() {
    if (pendingTimer) return;
    if (harvestInFlight && pending.size < BATCH_MAX) return;   // 等湊滿
    pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS);
  }

  /** 收割結束時把佇列倒乾淨——不然最後不滿一批的句子會卡住 */
  function drainAfterHarvest() {
    if (!pending.size) return;
    dbg(`收割結束，倒出剩餘 ${pending.size} 句`);
    clearTimeout(pendingTimer); pendingTimer = null;
    flushPending();
  }

  async function flushPending() {
    pendingTimer = null;
    if (!pending.size) return;
    if (inflight >= MAX_INFLIGHT) { scheduleFlush(); return; }

    const keys = Array.from(pending.keys()).slice(0, BATCH_MAX);
    const batch = keys.map((k) => pending.get(k));
    keys.forEach((k) => { pending.delete(k); requested.add(k); });

    inflight++;
    const t0 = Date.now();
    dbg(`送出批次 ${batch.length} 句（佇列剩 ${pending.size}，飛行中 ${inflight}/${MAX_INFLIGHT}）`);
    batch.forEach((t, i) => dbg(`  ${i + 1}. ${t.slice(0, 70)}`));
    try {
      const res = await send({ type: 'translate', cid: contentId, lines: batch });
      const lines = (res.ok && res.result && res.result.lines) || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) { memo.set(k, zh); n++; }
      state.translated += n;
      const ms = Date.now() - t0;
      batchStats.push({ sent: batch.length, got: n, ms });
      if (batchStats.length > 100) batchStats.shift();
      dbg(`批次回應：送 ${batch.length} / 回 ${n} 句，耗時 ${ms}ms`
        + (n < batch.length ? `　⚠ 少了 ${batch.length - n} 句` : ''));
      for (const [k, zh] of Object.entries(lines)) dbg(`  → ${zh.slice(0, 40)}`);
      if (res.ok && res.result && res.result.error) {
        state.errors++;
        // logEvent 只吃一個參數，第二個會被靜默丟掉——實測就這樣印出
        // 「翻譯後端回報錯誤：」後面空白，等於白記一筆。一律用字串串接。
        evWarn('翻譯後端回報錯誤：' + String(res.result.error || '(無訊息)'));
      }
      // 譯文可能正好對應畫面上「此刻仍在顯示」的那一句，補上去。
      //
      // 一定要當場重讀 DOM 比對，不能只信 currentEn：
      // 那個變數只反映「最後一次看到的字幕」，翻譯慢回來時畫面早就換過了，
      // 直接拿它補顯示會把過時的句子重新彈出來——實測表現為
      // 「同一段字幕在不同時間斷斷續續重複出現」。
      const nowEn = clean(collectCaption());
      if (nowEn && nowEn === currentEn) {
        const zh = memo.get(normKey(nowEn));
        if (zh) render(zh, nowEn);
      }
    } catch (e) {
      state.errors++;
      dbg(`批次失敗：${e.message}`);
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
  // 預抓 —— 決定「跟不跟得上」與「要花多少錢」
  //
  // 兩個層次，不要混為一談：
  //
  // 【提前量】只讀 DOM 的話是 0：字幕出現在畫面上我們才知道有這句，翻譯來回
  //   1~3 秒，而轉播每 3~4 秒一句，永遠追不上。但播放器本來就會**提前約 50 秒**
  //   下載字幕分段——inject.js 在 worker 內攔到那些分段，提前量就回來了。
  //   這一層在 v0.3.0 就完成了。
  //
  // 【整軌覆蓋】worker 只給得到「播放器已經下載的」部分。所以第一個看的人仍要
  //   為整支影片付翻譯費，而且拖動進度條會跳到還沒攔到的區段。整軌預抓則是
  //   一次把整支翻完：之後零呼叫、100% 命中，並且把譯文灌滿共用快取。
  //   這一層是 v0.4.0 補上的。
  //
  //   攔到的 manifest → 字幕清單 → 全部 VTT 分段 → 批次翻譯 → 存進共用快取
  //
  // 入口不是 PLAY API（八個版本都不通，見 handoff 7.7），而是 worker 本來就會
  // 抓的 m3u8。搭便車，零額外請求——F1TV 有 Imperva 機器人防護，這點很重要。
  //
  // 重播：一次抓完整支。直播：滑動視窗，定期重抓補新分段。
  // =========================================================================
  const FETCH_CONCURRENCY = 3;
  const FETCH_GAP_MS = 60;
  const LIVE_REFRESH_MS = 20000;

  let harvestGen = 0;
  let harvestInFlight = false;
  let subtitlePlaylistUrl = null;
  let prefetchHow = '';               // 字幕清單是怎麼拿到的，診斷用
  let bundleSegCount = 0;             // 後端記錄「這支收割過幾段」，0 = 沒人收割完整過
  const seenSegments = new Set();     // 已抓過的分段網址，直播重抓時用來去重
  const prefetchSeen = new Set();     // 已排入翻譯的 normKey
  let liveTimer = null;

  // worker 攔到的 m3u8／MPD。整軌預抓的入口——播放器自己會抓這些，
  // 我們只是搭便車，不產生任何額外的網路請求（Imperva 之下這點很重要）。
  // 上限 12 份：換畫質、換影片都會產生新的，只保留最近的即可。
  const MANIFEST_MAX = 12;
  let manifests = [];

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

  /**
   * 從 worker 攔到的 manifest 找出字幕清單。這是整軌預抓的入口。
   *
   * 兩條路徑，順序有意義：
   *   1. 直接攔到字幕的 media playlist —— 最穩。網址原封不動、body 已經在手上，
   *      連 fetch 都不用，也沒有相對路徑解析出錯的風險。
   *   2. 從 master 的 #EXT-X-MEDIA:TYPE=SUBTITLES 解析 —— 備援。
   *
   * 兩條都由 userscript 實測驗證過（見 userscript 的 findSubtitlePlaylist）。
   * 由新到舊掃，因為換畫質／換影片會留下舊的 manifest。
   */
  function findSubtitlePlaylistFromObserved() {
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) {
        return { url: m.url, body: m.body, lang: 'eng', how: '直接攔到字幕清單' };
      }
    }
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (!/#EXT-X-STREAM-INF/i.test(m.body)) continue;
      const sp = findSubtitlePlaylist(m.body, m.url);
      if (sp) return { url: sp.url, body: null, lang: sp.lang, how: '由 master 解析' };
    }
    return null;
  }

  /**
   * 等 worker 攔到字幕清單。
   *
   * 不自己去猜網址、也不打 PLAY API——那條路試過八個版本都不通，而且 F1TV 有
   * Imperva 機器人防護，送出注定失敗的請求只是在累積風險。
   * 播放器自己一定會抓，我們等它就好。
   */
  function waitForSubtitlePlaylist(myGen) {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        if (myGen !== harvestGen) return resolve(null);
        const sp = findSubtitlePlaylistFromObserved();
        if (sp) return resolve(sp);
        if (++tries >= 45) return resolve(null);      // 最多等 45 秒
        setTimeout(tick, 1000);
      };
      tick();
    });
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

  /**
   * 接收 MAIN world 轉送過來的 VTT。
   *
   * 這是擴充功能取得「提前量」的唯一來源：播放器會提前約 50 秒下載字幕分段，
   * inject.js 在 worker 內攔到之後用 BroadcastChannel 送到 MAIN world，
   * MAIN world 再用 window.postMessage 轉給這裡（只有這裡有 chrome.* API）。
   */
  /**
   * 重讀遠端設定並就地套用。
   *
   * 這是「F1TV 改版時能在幾分鐘內救回所有使用者」的最後一哩：
   * 後端推了新選擇器之後，這裡會在下一次輪詢時換上去，
   * 使用者不用重新整理，影片也不用中斷。
   */
  const CONFIG_RECHECK_MS = 60000;
  let configVersion = -1;

  async function applyRemoteConfig(force) {
    const res = await send({ type: force ? 'refreshConfig' : 'getConfig' });
    const config = (res.ok && res.config) || null;
    if (!config) return false;
    const next = siteConfigFor(config, location.hostname);
    if (!next) return false;

    const changed = config.version !== configVersion
      || JSON.stringify(next) !== JSON.stringify(site);
    if (!changed) return false;

    const prevVersion = configVersion;
    configVersion = config.version;
    site = next;

    // 選擇器換了就把觀察者整組重掛，並清掉「已隱藏」的樣式重新套用
    observedNodes = new Set();
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
    applyHideNative();
    lastSeenCaption = ''; lastRaw = '';

    if (prevVersion >= 0) {
      evOk(`⚙ 遠端設定已更新 v${prevVersion} → v${configVersion}，選擇器已就地套用`
        + `（root: ${(site.captionRoot || []).join(', ')}）`);
    }
    return true;
  }

  const MARK = '__pitlingo_vtt__';
  function installInjectBridge() {
    window.addEventListener('message', (ev) => {
      // 只接受同一個 window 發出、帶我們自己標記的訊息
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d[MARK] !== true) return;

      if (d.kind === 'injected') {
        state.workerPatched++;
        evOk(`✅ 已注入 Worker hook（原始腳本 ${d.bytes} bytes）`);
        return;
      }
      if (d.kind === 'vtt' && typeof d.vtt === 'string') {
        state.workerVtt++;
        const added = ingestVtt(d.vtt);
        if (added && !state.prefetchAnnounced) {
          state.prefetchAnnounced = true;
          setPhase('前瞻預譯中');
          evOk('✅ 從播放器的字幕分段取得提前量，開始批次預譯');
        }
        return;
      }
      if (d.kind === 'manifest' && typeof d.manifest === 'string') {
        if (manifests.some((m) => m.url === d.url)) return;   // 同一份會重覆抓
        manifests.push({ url: d.url || '', body: d.manifest });
        if (manifests.length > MANIFEST_MAX) manifests.shift();
        state.manifests = manifests.length;
        return;
      }
    }, false);
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

  /**
   * 收割該不該停（userscript 坑 #15）。
   *
   * 只看 contentId 不夠：點播放器左上角的返回鍵時**網址不會變**，
   * 播放器已經被拆掉了，收割卻繼續跑完上千個請求。
   * 以「video 元素消失超過 5 秒」為訊號——5 秒是為了避開播放器重建時的短暫消失。
   */
  let videoMissingSince = 0;
  function harvestShouldStop(myGen) {
    if (myGen !== harvestGen) return '影片切換';
    if (!settings.enabled) return '翻譯已關閉';
    const v = document.querySelector('video');
    if (v) { videoMissingSince = 0; return null; }
    if (!videoMissingSince) { videoMissingSince = Date.now(); return null; }
    if (Date.now() - videoMissingSince > 5000) return '播放器已關閉';
    return null;
  }

  async function fetchSegments(list, myGen) {
    let idx = 0, lastPct = -1, stopReason = null;
    const worker = async () => {
      while (idx < list.length) {
        const stop = harvestShouldStop(myGen);
        if (stop) { stopReason = stop; return; }
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
    if (stopReason) evWarn(`收割已中止（${stopReason}），已抓 ${state.segFetched}/${list.length} 段`);
    return stopReason;
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

  /**
   * 收割完成後告訴後端，讓下一個看同一支影片的人可以整段跳過。
   *
   * 等 25 秒才送：`handleComplete` 會拒絕「bundle 還沒有譯文」的標記請求，
   * 而最後幾批翻譯此時可能還在路上。標記早了會被拒，等於白跑一趟。
   */
  function markComplete(cid, segCount, myGen) {
    setTimeout(async () => {
      if (myGen !== harvestGen || cid !== contentId) return;
      const res = await send({ type: 'markComplete', cid, segCount });
      const r = (res.ok && res.result) || {};
      if (r.ok) {
        evOk(`✅ 已標記完整收割（${segCount} 段 / 後端 ${r.lineCount || '?'} 句）`
          + '，之後看這支影片的人會跳過整軌預抓');
      } else {
        evWarn(`標記完整收割未成功：${r.reason || r.error || '(未知)'}`);
      }
    }, 25000);
  }

  /**
   * 預抓翻完之後，回頭問後端「你現在有幾句」。
   *
   * 為什麼值得做：整條共用快取的價值全押在「我翻的東西真的存進去了」上，
   * 而那件事**沒有任何使用者可見的回饋**——存失敗了畫面一模一樣，
   * 只有下一個人要重新付費。實測就踩過：以為在貢獻，其實伺服器一句沒收到。
   *
   * 等 20 秒是要讓最後幾批翻譯先回來並寫進後端。
   */
  function verifyUpload(cid, myGen) {
    setTimeout(async () => {
      if (myGen !== harvestGen || cid !== contentId) return;
      const res = await send({ type: 'getBundle', cid, force: true });
      const b = (res.ok && res.bundle) || {};
      if (b.error) { evWarn(`共用快取回寫查核失敗：${b.error}`); return; }
      const serverCount = Object.keys(b.lines || {}).length;
      state.serverCount = serverCount;
      const local = memo.size;
      if (serverCount >= local * 0.9) {
        evOk(`☁ 回寫查核：後端已有 ${serverCount} 句（本機 ${local} 句），共用快取正常累積`);
      } else {
        evWarn(`⚠ 回寫查核：本機 ${local} 句，但後端只有 ${serverCount} 句。`
          + '譯文沒有完整進入共用快取——下一個觀看者會重新付費。'
          + '請確認後端已部署最新版（`cd backend && wrangler deploy`），'
          + '以及 Cloudflare KV 當日寫入額度未用盡。');
      }
    }, 20000);
  }

  /**
   * 整軌預抓。
   *
   * 為什麼這件事值得做：worker 攔截給的是「播放器已經下載的」分段，也就是約
   * 50 秒的提前量——夠跟上語速，但**第一次看的人仍要為整支影片付翻譯費**，
   * 而且拖動進度條會跳到還沒攔到的區段。整軌預抓則是一次把整支翻完，
   * 之後零呼叫、100% 命中，並且把譯文灌滿共用快取讓所有後續觀看者受惠。
   *
   * 入口從哪來：**不打 PLAY API**（八個版本都不通，見 7.7；而且 F1TV 有
   * Imperva 機器人防護）。改用 worker 攔到的 manifest——播放器自己一定會抓，
   * 我們搭便車，零額外請求。
   */
  async function startPrefetch(cid, attempt, force) {
    if (!cid) return;
    const myGen = harvestGen;

    // 上一支影片的收割可能還在收尾（等待階段最長 45 秒，切換影片時要等它讀到
    // 世代已變才會退出）。直接 return 會讓新影片**永遠沒有整軌預抓**，
    // 所以改成稍後重試。上限是鐵則 #3：任何輪詢裡的重試都要有上限。
    if (harvestInFlight) {
      const n = (attempt || 0) + 1;
      if (n > 30) { evWarn('前一次收割遲遲未釋放，放棄整軌預抓'); return; }
      setTimeout(() => { if (myGen === harvestGen) startPrefetch(cid, n, force); }, 1500);
      return;
    }

    harvestInFlight = true;
    setPhase('等待字幕清單');
    try {
      const sp = await waitForSubtitlePlaylist(myGen);
      if (myGen !== harvestGen) return;
      if (!sp) {
        evWarn('等待 45 秒仍未從播放器攔到字幕清單，略過整軌預抓。'
          + '仍會用 worker 攔到的分段運作（有提前量，只是沒有整軌覆蓋）。');
        setPhase('前瞻預譯中');
        return;
      }
      evOk(`✅ 取得字幕清單（${sp.how}）`);

      setPhase('讀取字幕清單');
      prefetchHow = sp.how;
      subtitlePlaylistUrl = sp.url;
      // 路徑 1 已經連 body 都攔到了，不用再發一次請求
      const body = sp.body || await swFetchText(sp.url);
      const { segs, isVod } = parseMediaPlaylist(body, sp.url);
      state.playlistSegs = segs.length;
      state.isLive = !isVod;

      if (isVod) {
        // 已經有人完整收割過就不要再抓一次。
        //
        // 沒有這個判斷的話，每個開啟同一支影片的人都會再向 CDN 發 383 個請求、
        // 花約 80 秒，而那些分段幾乎不會帶來任何新句子——純粹浪費，
        // 還多累積一次 Imperva 的曝險。userscript 早就有這個判斷，
        // 擴充功能到 v0.4.3 才補上。
        if (!force && bundleSegCount > 0 && bundleSegCount === segs.length && memo.size > 0) {
          state.harvestSkipped = true;
          evOk(`⏭ 跳過整軌預抓：後端記錄這支已完整收割（${bundleSegCount} 段 / 本機 ${memo.size} 句），`
            + '不重複向 CDN 抓 ' + segs.length + ' 個分段');
          setPhase('前瞻預譯中');
          return;
        }

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
        const stopped = await fetchSegments(segs.slice(start).concat(segs.slice(0, start)), myGen);
        if (myGen !== harvestGen) { evInfo('預抓已中止（影片切換）'); return; }
        // harvestInFlight 還是 true，scheduleFlush 會繼續等湊滿一批。
        // 這裡先放開再倒佇列，否則最後不滿 BATCH_MAX 的句子會卡著不送。
        harvestInFlight = false;
        drainAfterHarvest();
        if (stopped) { setPhase('前瞻預譯中'); return; }   // 中止就不標記完整
        state.harvestDone = state.segFailed === 0;
        evOk(`預抓完成：${state.segFetched} 段成功、${state.segFailed} 段失敗，待翻 ${pending.size} 句`);
        // 只有全部成功才敢標記完整——少抓幾段就標記，會害後續使用者跳過預抓
        // 卻拿到殘缺的譯文。
        if (state.harvestDone) markComplete(cid, segs.length, myGen);
        verifyUpload(cid, myGen);
      } else {
        setPhase('直播預抓中');
        evInfo(`偵測到直播（無 EXT-X-ENDLIST），改用滑動視窗持續補抓`);
        await fetchSegments(segs, myGen);
        harvestInFlight = false;
        drainAfterHarvest();
        liveTimer = setTimeout(() => refreshLive(myGen), LIVE_REFRESH_MS);
      }
    } catch (e) {
      // 預抓失敗不等於沒字幕——worker 攔截仍在跑，提前量還在。
      // 只是少了整軌覆蓋（拖進度條會遇到沒翻過的區段）。
      evErr(`整軌預抓失敗：${e.message}。改用 worker 攔到的分段繼續運作`);
      setPhase('前瞻預譯中');
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
    bundleSegCount = b.segCount || 0;
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
    // ⚠️ manifest 一定要清。留著的話新影片會拿上一支的字幕清單去抓，
    //    整支翻錯還不會報錯——就是坑 #16 那種靜默污染。
    manifests = [];
    bundleSegCount = 0;
    state.manifests = 0;
    state.harvestSkipped = false;
    state.serverCount = -1;
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
    debugOn = !!settings.debug;
    site = siteConfigFor(config, location.hostname);
    configVersion = config.version;

    if (!site) { evWarn('這個網域沒有對應的設定，不啟用'); return; }
    setPhase('等待播放');
    evOk(`PitLingo v${chrome.runtime.getManifest().version} 已啟動　|　設定版本 ${config.version}`
       + `　|　翻譯：${settings.enabled ? '開啟' : '關閉'}`);
    evInfo('提示：擴充功能圖示 →「匯出診斷」可一鍵複製完整狀態');

    applyHideNative();
    mount();

    // 接收 MAIN world 注入 worker 後轉送回來的 VTT —— 提前量的唯一來源
    installInjectBridge();

    // 預設的資源計時緩衝只有 250 筆，長時間觀看會把播放器的 PLAY 請求擠出去，
    // 之後就再也找不到那個網址了。
    try { performance.setResourceTimingBufferSize(1000); } catch (e) { /* noop */ }

    setInterval(pollCaption, POLL_MS);
    setInterval(() => {
      checkContentChange();
      hookObservers();
      mount();
      reposition();
    }, STRUCT_MS);

    // 定期重讀遠端設定並「就地套用」。
    // 沒有這個的話，F1TV 改版時就算後端已經推了新選擇器，
    // 使用者還是得自己重新整理頁面才會生效——比賽播到一半沒人會想這樣做。
    setInterval(applyRemoteConfig, CONFIG_RECHECK_MS);

    ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach((e) =>
      window.addEventListener(e, () => { mount(); reposition(); }, true));

    // 分頁重新可見／取得焦點時立刻重檢，不用等下一次輪詢。
    // 這正是「動了動滑鼠就好」那個症狀的直接對策。
    ['focus', 'visibilitychange'].forEach((e) =>
      window.addEventListener(e, () => {
        if (document.visibilityState === 'hidden') return;
        checkPollStall();
        pollCaption();
      }, true));

    checkContentChange();
  }

  // 設定在選項頁被改動時即時反映，不用重新整理
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.settings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
      debugOn = !!settings.debug;
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
    L.push('──── 提前量來源：Worker 注入 ────');
    L.push(`已注入 Worker：${state.workerPatched} 個`);
    L.push(`收到的 VTT 分段：${state.workerVtt} 份`);
    L.push(`攔到的 manifest：${state.manifests} 份（整軌預抓的入口）`);
    // 分類一下，找不到字幕清單時這行會直接說明卡在哪
    const mMaster = manifests.filter((m) => /#EXT-X-STREAM-INF/i.test(m.body)).length;
    const mSubs = manifests.filter((m) => /#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)).length;
    L.push(`  其中 master ${mMaster} 份、字幕清單 ${mSubs} 份`);
    L.push(`PLAY API 路徑：已停用（八輪未通，改用 Worker 注入 + 攔到的 manifest）`);
    L.push('');
    L.push('──── 整軌預抓（決定成本與拖進度條會不會漏）────');
    L.push(`型態　　　：${state.isLive ? '直播（滑動視窗）' : '重播'}`);
    L.push(`清單來源　：${prefetchHow || '(尚未取得)'}`);
    // 網址完整輸出，不截斷——坑 #3 就是截斷造成的，要能一眼看出 token 有沒有被切掉
    L.push(`字幕清單　：${subtitlePlaylistUrl || '(尚未取得)'}`);
    L.push(`分段　　　：清單 ${state.playlistSegs} / 已抓 ${state.segFetched}（失敗 ${state.segFailed}）`);
    L.push(`收割完成　：${state.harvestDone}　進行中：${harvestInFlight}　世代 ${harvestGen}`);
    L.push(`後端完整度：記錄 ${bundleSegCount} 段` + (state.harvestSkipped ? '　→ 本次已跳過整軌預抓' : (bundleSegCount ? '' : '（尚無人完整收割過）')));
    L.push('');
    L.push('──── 顯示延遲的歸因 ────');
    // 這一段的用途：回答「延遲有多少是我們造成的」。
    // observer 命中 = 我們幾乎沒有加延遲；輪詢命中 = 最壞加了一個 POLL_MS。
    const dTot = detect.byObserver + detect.byPoll;
    const pctObs = dTot ? Math.round((detect.byObserver / dTot) * 100) : 0;
    L.push(`偵測來源　：observer ${detect.byObserver} 次 / 輪詢 ${detect.byPoll} 次`
      + `（observer 佔 ${pctObs}%，輪詢間隔 ${POLL_MS}ms）`);
    if (detect.renderMs.length) {
      const arr = detect.renderMs.slice().sort((a, b) => a - b);
      const med = arr[Math.floor(arr.length / 2)];
      L.push(`繪製耗時　：中位數 ${med}ms / 最大 ${arr[arr.length - 1]}ms（${arr.length} 筆）`);
    } else {
      L.push('繪製耗時　：(尚無樣本)');
    }
    L.push('※ observer 佔比高且繪製耗時個位數 → 剩下的延遲來自 F1TV 自己畫字幕的時機，不是我們');
    L.push('');
    L.push('──── 翻譯 ────');
    L.push(`共用快取取得：${state.bundleCount} 句`);
    L.push(`後端回寫查核：${state.serverCount < 0 ? '(尚未查核)' : state.serverCount + ' 句在後端'}`);
    if (batchStats.length) {
      const sent = batchStats.reduce((a, b) => a + b.sent, 0);
      const got = batchStats.reduce((a, b) => a + b.got, 0);
      const ms = batchStats.reduce((a, b) => a + b.ms, 0);
      L.push(`批次效率　：${batchStats.length} 批、平均 ${(sent / batchStats.length).toFixed(1)} 句/批、`
        + `平均 ${Math.round(ms / batchStats.length)}ms、回覆率 ${sent ? Math.round((got / sent) * 100) : 0}%`);
    }
    L.push(`本機快取　：${memo.size} 句`);
    L.push(`命中 / 未命中：${state.hits} / ${state.misses}`);
    L.push(`即時翻譯　：${state.translated} 句　錯誤 ${state.errors}`);
    L.push(`待送出　　：${pending.size} 句　飛行中 ${inflight} 個請求（上限 ${MAX_INFLIGHT}）`);
    L.push('');
    L.push('──── 設定 ────');
    L.push(JSON.stringify(settings));
    // 傳播延遲 = SW 快取 TTL（2 分鐘）+ 這邊的重讀間隔，最壞約 3 分鐘。
    // 只寫「每 60 秒重讀」會誤導——那 60 秒常常只是問到 SW 的快取。
    L.push(`遠端設定版本：v${configVersion}（重讀間隔 ${CONFIG_RECHECK_MS / 1000} 秒；`
      + `含後端快取，實際傳播最壞約 3 分鐘。要立即生效請用「立即重新載入設定」）`);
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
    // 選項頁按「立即重新載入設定」時會打這個，不用等下一次輪詢
    if (msg && msg.type === 'applyConfigNow') {
      applyRemoteConfig(true).then((changed) => {
        sendResponse({ ok: true, changed, version: configVersion });
      });
      return true;
    }
    return false;
  });

  // 給偵錯用：在 Console 打 window.__pitlingo 可以看目前狀態
  // =========================================================================
  // 測試工具
  //
  // ⚠️ 上線前整段刪掉，並把 manifest 的 `TESTING` 標記一併移除。
  //    位置刻意集中在這裡，就是為了「刪一段就乾淨」。
  //    判斷依據：`__pitlingo.help()` 列得出來的東西，正式版一律不該存在。
  //
  // 保留哪些、刪哪些的原則：
  //   保留 — diag / events：**回報問題的唯一管道**，正式版必須留著
  //   刪除 — 其餘全部：會繞過防護（強制預抓）、洩漏內部狀態、或只有開發時有用
  // =========================================================================
  const TESTING = {
    // ---- 強制觸發 ----
    prefetch: () => startPrefetch(contentId, 0, true),   // 強制重抓整支，繞過跳過判斷
    reloadConfig: () => applyRemoteConfig(true),          // 立刻重讀遠端設定，不等 60 秒
    markComplete: () => send({ type: 'markComplete', cid: contentId, segCount: state.playlistSegs }),
    refreshBundle: async () => {
      const r = await send({ type: 'getBundle', cid: contentId, force: true });
      const b = (r.ok && r.bundle) || {};
      console.log(`後端：${Object.keys(b.lines || {}).length} 句，segCount ${b.segCount || 0}`);
      return b;
    },

    // ---- 內部狀態 ----
    detect: () => detect,                 // 偵測來源統計（observer vs 輪詢）
    batches: () => batchStats,            // 每個批次的句數與耗時
    manifests: () => manifests.map((m) => ({ url: m.url, bytes: m.body.length })),
    memo: () => memo,
    pending: () => Array.from(pending.values()),
    settings: () => settings,
    site: () => site,

    // ---- 模擬 ----
    // 假裝畫面出現這句字幕，用來單獨測翻譯與顯示路徑，不用等影片播到
    feed: (en) => { handleCaption(String(en || '')); return '已送入：' + en; },
    // 假裝分頁被節流過，驗證停擺偵測會不會正確重掛
    stall: () => { lastPollAt = Date.now() - STALL_MS - 1000; return checkPollStall(); },

    help: () => {
      console.log([
        '【正式版保留】',
        '  __pitlingo.diag()            匯出完整診斷（回報問題用這個）',
        '  __pitlingo.events()          事件時間軸',
        '  __pitlingo.state             目前狀態',
        '  __pitlingo.peek()            現在畫面上抓到什麼英文',
        '  __pitlingo.debug(true)       開關詳細日誌',
        '',
        '【上線前移除 —— __pitlingo.t.*】',
        '  t.prefetch()                 強制重抓整支（繞過跳過判斷）',
        '  t.reloadConfig()             立刻重讀遠端設定',
        '  t.markComplete()             手動標記完整收割',
        '  t.refreshBundle()            強制重讀後端 bundle 並印出句數與 segCount',
        '  t.detect()                   偵測來源統計',
        '  t.batches()                  每個批次的句數與耗時',
        '  t.manifests()                攔到的 manifest 清單',
        '  t.memo() / t.pending()       本機快取 / 待翻佇列',
        '  t.feed("Box box box")        假裝畫面出現這句，測翻譯與顯示',
        '  t.stall()                    假裝被節流，測停擺偵測',
      ].join('\n'));
      return '見上方';
    },
  };

  window.__pitlingo = {
    // ---- 正式版也要保留 ----
    diag: () => { const r = buildDiagnostics(); console.log(r); return r; },
    events: () => { console.log(eventLog.join('\n')); return eventLog.length; },
    peek: () => collectCaption(),
    debug: (on) => { debugOn = on !== false; console.log('[PitLingo] 詳細日誌：' + (debugOn ? '開啟' : '關閉')); return debugOn; },
    get state() {
      return Object.assign({
        contentId, memo: memo.size, pending: pending.size,
        requested: requested.size, inflight, everSawCaption,
      }, state);
    },

    // ---- 測試工具（上線前刪掉這兩行與上面的 TESTING 區塊）----
    t: TESTING,
    help: TESTING.help,
  };
  evInfo('測試版：Console 打 `__pitlingo.help()` 看可用指令');

  boot();
})();
