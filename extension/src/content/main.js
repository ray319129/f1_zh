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

  // 注入兩次的話會有兩組計時器、兩份狀態，症狀是各種東西「莫名其妙跑兩遍」。
  // MV3 正常不會這樣，但 SPA 導覽、擴充功能重載、開發時手動注入都可能造成，
  // 而且完全不報錯。擋掉的成本是一行。
  if (window.__pitlingoBooted) return;
  window.__pitlingoBooted = true;

  const { clean, normKey, siteConfigFor, sanitizeSettings, DEFAULT_SETTINGS } = self.PL;

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

  // 上限。一場正賽約 2,000 句，這次實測單支練習賽就 3,331 句——
  // 沒有上限的話，長時間連看多支影片會一路長上去。
  // Map 保留插入順序，砍最舊的就近似 LRU（重看同一支時最近的那些才有價值）。
  const MEMO_MAX = 12000;
  const PENDING_MAX = 3000;        // 待翻佇列。正常收割不會逼近，防的是異常情況
  const memo = new Map();          // normKey -> 譯文（**跨影片共用**，不要拿來當單片的分母）
  let sessionKeys = new Set();     // 這支影片出現過的 normKey，回寫查核的分母
  let contentId = null;
  let seenContentId = null;        // 從 performance 觀察到的
  let lastPath = location.pathname;

  let lastSeenCaption = '';
  let lastRaw = '';
  let everSawCaption = false;

  const pending = new Map();
  // 「現在螢幕上就要用」的鍵。直播的並發去重只讓前瞻那條路讓步，
  // 急件一律不讓——讓路的人要等別人翻完再讀快取，而直播字幕 3~4 秒就換一句。
  const urgentKeys = new Set();       // normKey -> 原文（待送出）
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
    dropped: 0,                    // 重試 3 次仍失敗、已放棄的句數
    yieldCount: 0, yieldMs: 0,   // 為了讓路給影片而暫停收割的次數與總時間
    gaps: 0, lastGap: null,        // 字幕中途缺漏（不含「本來就沒旁白」）
    badLines: 0,                   // 長度異常而被略過的「字幕」——不是 0 就代表攔錯東西了
    hits: 0, isLive: false, harvestDone: false,
  };

  // ---- 事件時間軸 ----
  // 所有狀態變化都記在這裡，「匯出診斷」時一併帶出。
  // 沒有這個就只能靠翻 Console 猜，而 SW 的 log 又在另一個視窗。
  const eventLog = [];
  let phase = '啟動中';
  /**
   * 相同訊息連續出現時折疊成計數，不要各佔一行。
   *
   * 為什麼一定要有：實測跑三小時後，事件時間軸 400 筆裡有 150 筆是同一行
   * 「⚙ 遠端設定已更新 v1 → v1」，把真正重要的紀錄全部擠掉。
   * **診斷報告是這個專案唯一的回報管道**——被洗版就等於瞎了，
   * 而洗版的原因有很多種，一個一個修永遠追不完。
   * 在這裡擋一次，之後任何來源的重複訊息都傷不到報告。
   */
  let lastLogMsg = '', lastLogCount = 0;
  function logEvent(level, msg) {
    if (msg === lastLogMsg && eventLog.length) {
      lastLogCount++;
      eventLog[eventLog.length - 1] =
        `${eventLog[eventLog.length - 1].replace(/　×\d+$/, '')}　×${lastLogCount + 1}`;
      return;                                  // Console 也不再重複印
    }
    lastLogMsg = msg; lastLogCount = 0;
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
  /**
   * 從資源計時裡找 contentId。**只在網址上找不到時才做。**
   *
   * ⚠️ 這個函式原本每 1.5 秒無條件跑一次，而資源計時緩衝被我們自己調到
   *    1,000 筆——等於每 1.5 秒對一千條幾百字元的網址各跑一次正則。
   *    F1TV 的網址還特別長（帶著 400 字元的授權 token）。
   *    那是持續佔用主執行緒的工作，而**播放器的 ABR 決策也跑在主執行緒上**。
   *
   *    絕大多數情況網址本身就有 `/detail/(\d+)`，根本不需要掃。
   *    這裡先問一次，有答案就直接返回。
   */
  function scanContentIdFromPerformance() {
    if (seenContentId) return;                        // 已經找到過就不必再掃
    if (site && site.contentIdPattern) {
      try {
        if (new RegExp(site.contentIdPattern).test(location.pathname)) return;
      } catch (e) { /* 設定裡的正則壞掉就往下掃 */ }
    }
    // ⚠️ **只找 `contentId=` 是不夠的。**
    //
    //    實測（2026-08-21 直播）：兩台裝置看同一場直播，一台的網址是
    //    /detail/<id>/... 解析得到 cid，另一台解析不到，於是**整場的譯文
    //    被寫進 misc 這個公用桶子**——與正片的重疊率 98.1%，
    //    等於同一句話付了兩次錢，而且不會有任何錯誤訊息。
    //
    //    所以三種形式都掃：查詢參數、/detail/ 路徑、以及頁面自己的資料。
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const u = entries[i].name;
        const m = u.match(/[?&]contentId=(\d+)/i) || u.match(/\/detail\/(\d+)/);
        if (m) { seenContentId = m[1]; return; }
      }
    } catch (e) { /* 不影響主要功能 */ }
    // 最後一招：頁面自己的資料（Next.js 的 __NEXT_DATA__ 之類）
    try {
      const raw = (document.getElementById('__NEXT_DATA__') || {}).textContent || '';
      const m = raw.match(/"contentId"\s*:\s*"?(\d{6,})/);
      if (m) { seenContentId = m[1]; return; }
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
  /**
   * 「播放中卻沒有字幕」的提示。擴充功能一直缺這個——使用者忘了開 CC 時
   * 畫面完全沒反應，也沒有任何說明，只會以為是我們壞了。
   *
   * 防呆的重點在**寧可漏報也不要誤報**（userscript 坑 #14）：
   *   - 只有 video 存在、正在播放、且沒暫停才計時
   *   - 看過任何一句字幕就永不再提示（那代表 CC 是開的，現在只是沒旁白）
   *   - 五分鐘內最多提示一次
   *   - 有 VTT 資料才是高訊號（確定這支有字幕卻沒顯示 → CC 沒開）；
   *     沒資料只記 Console，因為可能真的是開場動畫或宣傳片
   */
  const NO_CAPTION_WARN_MS = 45000;
  // 中途缺漏的門檻。轉播的自然空白（換鏡頭、車手沒講話）多半在 10 秒內，
  // 20 秒沒有任何字幕就值得記一筆——但要分辨是不是本來就沒旁白，見 checkCaptionGap。
  const CAPTION_GAP_MS = 20000;
  let lastNonEmptyAt = Date.now();
  let hintShownAt = 0;

  function isActuallyPlaying() {
    const v = document.querySelector('video');
    return !!(v && !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0);
  }

  /**
   * 播放中卻長時間沒有字幕。**要分辨是誰的問題。**
   *
   * ⚠️ 舊版只在「從未看過字幕」時才警告（`if (everSawCaption) return`），
   *    所以**比賽中途的缺漏完全是隱形的**——使用者看到字幕消失一段，
   *    診斷報告卻什麼都沒有，我們只能用猜的。
   *
   * 中途缺漏有四種成因，後果完全不同，必須當場分辨：
   *
   *   A. 這段本來就沒有旁白（賽後訪問、頒獎、純畫面）
   *      → **正常**。原生字幕也是空的，我們沒有東西可翻。
   *   B. 原生字幕有，我們沒有譯文
   *      → 翻譯沒跟上，或這句不在快取裡。可以補。
   *   C. 原生字幕整個不見了
   *      → CC 被關掉、選擇器失效、或播放器重建導致 observer 失聯。
   *   D. 額度用完
   *      → 免費模式的正常行為，但要說清楚免得被當成故障。
   *
   * 判斷依據是**當下重讀 DOM**，不是任何快取的變數。
   */
  let gapReported = 0;
  function checkCaptionGap() {
    if (!settings.enabled || !site || killed || tooOld) return;
    if (!everSawCaption) return;                        // 交給下面的首次偵測處理
    if (!isActuallyPlaying()) return;
    if (Date.now() - lastNonEmptyAt < CAPTION_GAP_MS) return;
    // 同一次缺漏只回報一次，恢復之後才會再記
    if (gapReported > lastNonEmptyAt) return;
    gapReported = Date.now();

    const gapSec = Math.round((Date.now() - lastNonEmptyAt) / 1000);
    const container = activeContainer();
    const nativeNow = clean(collectCaption());

    let kind, msg;
    if (trialExhausted()) {
      kind = 'quota';
      msg = `已停止顯示 ${gapSec} 秒：免費額度已用完（這是正常行為，非故障）`;
    } else if (nativeNow) {
      // 原生有字幕，我們卻沒畫出來 —— 這是真的漏了
      const k = normKey(nativeNow);
      kind = memo.has(k) ? 'render' : 'untranslated';
      if (kind === 'render') plErr('PL-C04', gapSec + ' 秒');
      msg = `⚠ 字幕缺漏 ${gapSec} 秒：原生字幕存在但未顯示中文`
        + `（${memo.has(k) ? '譯文已在本機，疑似顯示層問題' : '這句尚無譯文'}）`;
    } else if (!container) {
      kind = 'container_gone';
      plErr('PL-C03', gapSec + ' 秒');
      msg = `⚠ 字幕缺漏 ${gapSec} 秒：找不到字幕容器 —— 選擇器可能已失效，或播放器重建中`;
    } else {
      kind = 'silent';
      msg = `字幕空白 ${gapSec} 秒：原生字幕也是空的（賽後訪問、頒獎、純畫面時屬正常）`;
    }

    // 「本來就沒旁白」不該吵人，記成 INFO；其餘是要處理的問題
    if (kind === 'silent' || kind === 'quota') evInfo(msg); else evWarn(msg);
    metric('caption_gap', { kind, sessionType: sessionType() });
    state.gaps = (state.gaps || 0) + (kind === 'silent' || kind === 'quota' ? 0 : 1);
    state.lastGap = { kind, sec: gapSec, at: new Date().toISOString() };
  }

  /**
   * 播了一陣子還是完全攔不到串流 → 注入失敗。
   *
   * 這種情況功能還在（會退化成逐句翻譯），但**慢很多也貴很多**，
   * 而且使用者只會覺得「字幕怎麼一直慢半拍」。所以要留代碼，
   * 但**不打斷觀看**——它還能用，跳一個大警告只會嚇到人。
   */
  let injectChecked = false;
  let injectSince = Date.now();
  function checkInjection() {
    if (injectChecked || !site || killed) return;
    if (!isActuallyPlaying()) return;
    if (Date.now() - injectSince < 90000) return;      // 給它 90 秒
    injectChecked = true;
    if (state.workerPatched > 0 || state.workerVtt > 0 || state.segFetched > 0) return;
    plErr('PL-C05', '播放 90 秒仍未攔截到任何串流資料');
  }
  function checkNoCaption() {
    if (!settings.enabled || !site) return;
    if (!isActuallyPlaying()) { lastNonEmptyAt = Date.now(); return; }
    if (Date.now() - lastNonEmptyAt < NO_CAPTION_WARN_MS) return;
    lastNonEmptyAt = Date.now();

    if (everSawCaption) return;                       // CC 正常，只是這段沒旁白
    if (Date.now() - hintShownAt < 300000) return;    // 五分鐘內只提示一次
    hintShownAt = Date.now();

    const haveData = state.workerVtt > 0 || state.segFetched > 0 || memo.size > 0;
    if (haveData) {
      metric('playback_error', { kind: 'no_caption' });
      evWarn('這支影片有字幕資料，但畫面上從未出現字幕 — 播放器的 CC 應該是關著的');
      show('⚠ 請在播放器設定開啟英文字幕 (CC)', '');
    } else {
      evInfo('播放中但尚未取得任何字幕（可能是無旁白片段，或 CC 未開啟）');
    }
  }

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
  const detect = { byObserver: 0, byPoll: 0, renderMs: [], paintMs: [] };
  let inObserverTick = false;

  function onMutation() {
    inObserverTick = true;
    try { pollCaption(); } finally { inObserverTick = false; }
  }

  /**
   * 播放器是不是已經被關掉了。
   *
   * ⚠️ **不能只看網址。** 點播放器左上角的返回鍵時網址完全不變，
   *    播放器卻已經被拆掉（坑 #15）。判斷依據是 video 元素消失——
   *    但要給 5 秒寬限，因為切換視角、換畫質時播放器會短暫重建，
   *    那幾百毫秒的消失不是「離開」。
   *
   * 收割與顯示共用同一份判斷，兩邊的定義不一致會很難查。
   */
  let videoGoneLogged = false;
  let videoMissingSince = 0;
  function playerGone() {
    const v = document.querySelector('video');
    if (v) { videoMissingSince = 0; return false; }
    if (!videoMissingSince) { videoMissingSince = Date.now(); return false; }
    return Date.now() - videoMissingSince > 5000;
  }

  /**
   * 錯誤代碼。
   *
   * ⚠️ **只有「使用者的體驗確實壞了」而且「我們拿到代碼查得出東西」才給代碼。**
   *
   *    這個專案有兩種「沒有字幕」是完全正常的：這支影片本來就沒字幕，
   *    以及有字幕的影片中途長時間沒旁白（賽後訪問、頒獎、純畫面）。
   *    給那兩種發代碼，等於訓練使用者把正常現象當故障回報——
   *    然後真正的故障就淹沒在雜訊裡。它們一律只記 INFO，不給代碼。
   *
   * ⚠️ 代碼發出去就不可以改語意。要淘汰就留著別再用。
   */
  const PL_CODES = {
    'PL-C01': '連不上翻譯伺服器',
    'PL-C02': '伺服器回報錯誤（後面會附伺服器自己的代碼）',
    'PL-C03': '找不到字幕容器 —— 播放器改版或選擇器失效',
    'PL-C04': '譯文已在本機，畫面卻沒顯示 —— 顯示層問題',
    'PL-C05': '注入失敗 —— 攔不到串流，只能逐句翻譯（較慢較貴）',
    'PL-C06': '這支影片不在免費範圍內（不是故障）',
    'PL-C07': '免費額度已用完（不是故障）',
    'PL-C08': '解析不出影片編號 —— 譯文無法存進這支影片的共用快取',
  };
  // 這次觀看出現過哪些代碼，診斷報告要帶上去
  const seenCodes = new Map();

  /**
   * 記一個錯誤代碼。toUser 為 true 時才會顯示在畫面上——
   * 大部分代碼只需要進診斷，不需要打斷觀看。
   */
  function plErr(code, detail, toUser) {
    seenCodes.set(code, (seenCodes.get(code) || 0) + 1);
    const line = '【' + code + '】' + (PL_CODES[code] || '') + (detail ? '　' + detail : '');
    evWarn(line);
    if (toUser) show('⚠ ' + line + '　（回報時請附上代碼）', '');
    return code;
  }

  function pollCaption() {
    checkPollStall();
    // ⚠️ 提前顯示要放在所有停用判斷**之後**。
    //    放前面的話 killSwitch 開著、或使用者關掉翻譯時它照樣跑：
    //    show() 會擋住畫面所以看不出問題，但 shownEarly 已經被標記成「顯示過」，
    //    等到恢復時那些句子再也不會提前——靜默地少一個功能，沒有任何錯誤訊息。
    if (!settings.enabled || !site || killed || tooOld) return;

    // 播放器關掉了就不要再偵測字幕。網址沒變，但畫面上已經沒有影片——
    // 這時候容器裡殘留的東西不是字幕，而疊字還留在畫面上只會擋住頁面。
    if (playerGone()) {
      if (!videoGoneLogged) {
        videoGoneLogged = true;
        evInfo('播放器已關閉（網址未變），暫停字幕偵測與顯示');
        lastSeenCaption = ''; lastRaw = ''; currentEn = '';
        scheduleHide();
      }
      return;
    }
    if (videoGoneLogged) {
      videoGoneLogged = false;
      evInfo('播放器已回來，恢復字幕偵測');
      // 重新開始，不要沿用關掉前的去重狀態
      lastSeenCaption = ''; lastRaw = ''; currentEn = '';
      lastNonEmptyAt = Date.now();
      observedNodes = new Set();
      hookObservers();
    }

    tickEarlyDisplay();
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
      // ⚠️ 收起也要走延後佇列。只延後顯示會把每一句的顯示時間砍掉 N 毫秒，
      //    短句直接消失、稍長的句子閃一下就沒——見 `enqueueDelayed` 的說明。
      enqueueDelayed(scheduleHide);
      return;
    }
    lastNonEmptyAt = Date.now();
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

  // =========================================================================
  // 免費層閘門
  //
  // 四種正式賽事場次的前 15 分鐘免費，其餘 F1TV 影片不含在內。
  //
  // 這裡是**產品承諾**的實作（使用者看得到的規則）；
  // 成本保護在伺服器（未授權的安裝每天有句數上限）。兩者目的不同，都要有——
  // 只做這一層的話，改一下 storage 就能無限用。
  // =========================================================================
  let licensed = false;              // 有沒有有效授權
  let freeSession = false;           // 這支影片屬不屬於免費涵蓋的場次
  let freeSpent = 0;                 // 直播用：已看掉的免費秒數
  let lastTickAt = 0;
  let trialEndedShown = false;

  /** 免費額度還剩幾秒。授權中回傳 Infinity。 */
  function freeSecondsLeft() {
    if (licensed) return Infinity;
    if (!freeSession) return 0;
    // ⚠️ freeTier 掛在**設定的根層**，不是 sites[i] 底下。
    //    原本寫 `site.freeTier` 永遠是 undefined，於是一直用內建值——
    //    遠端推的免費層設定完全不會生效，而且不報錯（這個專案的招牌錯法）。
    const limit = (freeTierCfg && freeTierCfg.seconds) || 900;
    const v = document.querySelector('video');
    // 重播：用播放位置判定「前 15 分鐘」，暫停或重看都不會多扣。
    // 直播：沒有可靠的起點，改用實際觀看秒數累計。
    const used = state.isLive ? freeSpent : (v && isFinite(v.currentTime) ? v.currentTime : 0);
    return Math.max(0, limit - used);
  }

  /**
   * 記錄免費用量。
   *
   * ⚠️ **這裡要寫進 storage，不能只留在記憶體。**
   *    舊版 `freeSpent` 是 content script 的區域變數，開新分頁就從 0 開始——
   *    使用者只要按一下「在新分頁開啟」就重置了計時。伺服器端每日 800 句
   *    仍然擋得住成本，但畫面上顯示「剩餘 15:00」等於在告訴他這招有效，
   *    而**讓使用者以為自己找到漏洞，比真的有漏洞更糟**：
   *    他會去講給別人聽，而且再也不會付錢。
   *
   *    storage 是整個擴充功能共用的，所以所有分頁看到同一份用量。
   *    重播用 `currentTime` 判定，本來就跨分頁一致（同一支影片同一個位置）；
   *    真正需要持久化的是直播的累計秒數，以及**每支影片各自的已用量**。
   */
  const FREE_USAGE_KEY = 'freeUsage';
  let freeUsageSaveAt = 0;

  function tickFreeUsage() {
    const now = Date.now();
    if (state.isLive && !licensed && freeSession && isActuallyPlaying()) {
      if (lastTickAt) freeSpent += Math.min(5, (now - lastTickAt) / 1000);
      // 節流寫入：每 5 秒一次就夠，chrome.storage 寫太密會拖慢
      if (contentId && now - freeUsageSaveAt > 5000) {
        freeUsageSaveAt = now;
        saveFreeUsage();
      }
    }
    lastTickAt = now;
  }

  function saveFreeUsage() {
    try {
      chrome.storage.local.get(FREE_USAGE_KEY, (o) => {
        const all = (o && o[FREE_USAGE_KEY]) || {};
        all[contentId] = { spent: Math.round(freeSpent), at: Date.now() };
        // 只留最近 50 支，避免無界成長
        const keys = Object.keys(all);
        if (keys.length > 50) {
          keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
            .slice(0, keys.length - 50).forEach((k) => delete all[k]);
        }
        chrome.storage.local.set({ [FREE_USAGE_KEY]: all });
      });
    } catch (e) { /* 分頁關閉中，忽略 */ }
  }

  /** 換影片時把這支之前用掉的額度讀回來。 */
  function loadFreeUsage(cid) {
    try {
      chrome.storage.local.get(FREE_USAGE_KEY, (o) => {
        const rec = ((o && o[FREE_USAGE_KEY]) || {})[cid];
        if (rec && Number.isFinite(rec.spent) && rec.spent > freeSpent) {
          freeSpent = rec.spent;
          evInfo(`本片先前已使用 ${Math.round(freeSpent)} 秒免費額度（跨分頁共用，開新分頁不會重置）`);
        }
      });
    } catch (e) { /* noop */ }
  }

  function trialExhausted() {
    if (licensed) return false;
    if (!freeSession) return true;          // 不在免費範圍的影片，一律需要授權
    return freeSecondsLeft() <= 0;
  }

  function showTrialEnded() {
    if (trialEndedShown) return;
    trialEndedShown = true;
    metric('free_exhausted', {
      sessionType: sessionType(),
      minutes: (((site && freeTierCfg && freeTierCfg.seconds) || 900) / 60),
    });
    box.classList.remove('on');
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }   // 把原生英文字幕還給使用者
    evWarn(freeSession
      // 方案名稱不要寫死在這裡——「購買 Season」在一週通行證上線後就是錯的，
      // 而且會隨定價調整而漂掉。指向購買頁，那裡的價格永遠是對的。
      ? '⏳ 免費試看的 15 分鐘已結束。原生英文字幕已恢復顯示。'
        + '購買授權可解除限制：https://pitlingo.com/buy'
      : '🔒 這支影片不在免費範圍內（免費只涵蓋練習賽／衝刺賽／排位賽／正賽的前 15 分鐘）。');
  }

  // =========================================================================
  // 產品數據
  //
  // **只送彙總得出來的維度，不送 contentId、不送任何識別碼。**
  // 我們要回答的是「排位賽佔多少」「15 分鐘夠不夠」「哪個版本錯最多」，
  // 不是「這個人看了什麼」——後者對優化沒幫助，卻讓隱私政策難寫、
  // 審查難過、外洩時後果嚴重得多。
  //
  // 攢著批次送，不要每個事件都打一次網路。
  // =========================================================================
  const metricQueue = [];
  let metricTimer = null;

  /** 從網址推出場次類型。與免費層用同一份規則，但這裡只要粗分類。 */
  function sessionType() {
    const p = location.pathname.toLowerCase();
    if (!self.PL.isFreeSession(p, freeTierCfg)) return 'other';
    if (/practice/.test(p)) return 'practice';
    if (/qualifying/.test(p)) return 'qualifying';
    if (/sprint/.test(p)) return 'sprint';
    return 'race';
  }

  function metric(event, dims) {
    metricQueue.push({ event, dims: Object.assign({ version: chrome.runtime.getManifest().version }, dims || {}) });
    if (metricQueue.length > 40) metricQueue.shift();
    clearTimeout(metricTimer);
    // 30 秒攢一次。事件很少，不值得為它增加請求數。
    metricTimer = setTimeout(flushMetrics, 30000);
  }

  function flushMetrics() {
    if (!metricQueue.length) return;
    const events = metricQueue.splice(0, metricQueue.length);
    send({ type: 'metric', events }).catch(() => {});
  }

  async function refreshLicensed() {
    const res = await send({ type: 'licenseStatus' });
    const was = licensed;
    licensed = !!(res.ok && res.license && res.license.active);
    if (licensed !== was) {
      evInfo(licensed ? '✅ 授權已生效，無使用限制' : 'ℹ️ 目前為免費模式');
      if (licensed) trialEndedShown = false;      // 剛買完要立刻恢復顯示
    }
  }

  // =========================================================================
  // 字幕時機微調
  //
  // 使用者實測發現 F1TV 官方字幕本身時快時慢。這裡讓他自己補那個偏差。
  //
  // **兩個方向的難度完全不同：**
  //
  //   延後（offset < 0）  容易。收到字幕後 setTimeout 再顯示。零風險，任何情況都能用。
  //   提前（offset > 0）  難。我們是「看到 F1TV 畫出字幕才知道有這句」，
  //                       本質上不可能比它更早——除非用 VTT 的時間軸。
  //
  // 而直接用 VTT 時間軸就是 handoff 決策 4.1 明確避開的那條路：
  // HLS 分段 VTT 的時間基準要靠 X-TIMESTAMP-MAP 換算，很脆弱，
  // 做出來常常是「翻譯正確但時機歪掉」。
  //
  // **所以這裡不解析 X-TIMESTAMP-MAP，改用自我校準：**
  // 每當 DOM 出現一句我們手上也有 VTT 時間的字幕，就記下
  // `video.currentTime - cue 時間` 這個差值。取中位數就是這支影片的基準偏移。
  // 有了它才啟用提前顯示；校準樣本不足就自動退回「只能延後」。
  //
  // 好處是它自我修正、不依賴任何格式假設，而且**校準失敗時的退化方向是安全的**
  // （退回現在的行為，而不是顯示錯位的字幕）。
  //
  // ⚠️ 直播只允許延後。直播的字幕清單是滑動視窗，基準點會隨著重抓而變，
  //    校準出來的值不可信——寧可不做，也不要在直播時顯示錯位的字幕。
  // =========================================================================
  // 兩個方向的上限**刻意不對稱**：
  //   延後是純 setTimeout，不依賴任何推論，加多久就是多久 → 放寬到 3 秒
  //   提前依賴校準值，誤差會直接變成「字幕顯示在錯的地方」 → 維持 2 秒
  // 對稱看起來比較整齊，但那會讓風險最高的方向拿到最大的權限。
  const OFFSET_LATE_MAX_MS = 3000;   // 延後（負值）的上限
  const OFFSET_EARLY_MAX_MS = 2000;  // 提前（正值）的上限
  const CALIB_MIN = 12;              // 至少要這麼多樣本才敢下判斷
  const CALIB_KEEP = 40;             // 樣本保留數（滑動視窗）
  const CUE_MAX = 20000;             // cue 時間／原文的記錄上限

  // ⚠️ **離散度閘門——這是提前顯示唯一可信的依據。**
  //
  // `parseVtt` 的 `start` 是 cue 在**那個分段檔案內**的秒數。F1TV 的分段
  // VTT 究竟寫絕對時間還是分段內相對時間，我們沒有實測過，而兩者的差別
  // 是致命的：
  //   絕對時間 → `currentTime - cue` 是常數，中位數就是基準偏移，提前顯示成立
  //   分段相對 → 這個差值等於「該分段的起始時間」，隨播放持續變大，
  //              中位數是垃圾，提前顯示會在隨機的時刻噴出隨機的句子
  //
  // 舊版直接取 8 個樣本的中位數就相信它，**沒有任何辦法分辨這兩種情況**——
  // 那正是「用起來怪怪的、不確定有沒有效」的來源。
  //
  // 改成看樣本的**四分位距（IQR）**：
  //   絕對時間的話所有樣本會擠在一起（IQR 只反映播放器畫字幕的抖動，遠小於 1 秒）
  //   分段相對的話樣本會攤在整支影片的長度上（IQR 是幾百秒）
  // 超過門檻就判定「cue 時間軸不可用」，自動退回只允許延後。
  //
  // 這樣不論 F1TV 用哪種寫法都不會出錯，而且**判斷結果會寫進診斷報告**，
  // 不用再靠感覺猜它有沒有生效。
  const CALIB_MAX_SPREAD_S = 1.0;

  const cueTimes = new Map();        // normKey -> VTT 裡的 cue 起始秒數
  const cueText = new Map();         // normKey -> 原文。提前顯示時要一起畫出來
  const calibSamples = [];           // video.currentTime - cueTime 的樣本
  let calibrated = null;             // 通過閘門的中位數，null = 不可用
  let calibSpread = null;            // 最近一次算出來的 IQR，診斷用
  let calibNote = '尚未取得樣本';    // 人看得懂的狀態，會進診斷報告與設定頁
  const shownEarly = new Set();      // 已經提前顯示過的鍵，避免 DOM 到時重複
  let earlyHoldUntil = 0;            // 提前顯示期間，暫時不讓「原生字幕清空」收掉疊字
  let lastSeekCheck = 0;             // 上次看到的 currentTime，用來偵測往回拖

  /** 把使用者設定夾進合法範圍。非數字一律當 0（跟隨官方字幕）。 */
  function clampOffset(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(-OFFSET_LATE_MAX_MS, Math.min(OFFSET_EARLY_MAX_MS, v));
  }

  /** 目前**實際生效**的偏移。提前的條件不成立時一律回 0。 */
  function activeOffsetMs() {
    const raw = clampOffset(settings.subtitleOffset);
    if (raw <= 0) return raw;                      // 延後：任何情況都安全
    if (state.isLive) return 0;                    // 直播不提前
    if (calibrated === null) return 0;             // 沒校準好就不提前
    return raw;
  }

  /**
   * 設定值與實際行為的落差要說出來。
   *
   * 使用者拉了「提前 1.5 秒」但直播不支援時，畫面上什麼都沒變——
   * 沒有這行字他只會覺得「這個功能是不是壞的」。
   */
  function offsetStatusText() {
    const raw = clampOffset(settings.subtitleOffset);
    if (raw === 0) return '跟隨官方字幕';
    if (raw < 0) return `延後 ${(-raw / 1000).toFixed(1)} 秒（已生效）`;
    const want = `提前 ${(raw / 1000).toFixed(1)} 秒`;
    if (state.isLive) return `${want} → 直播不支援，目前未生效`;
    if (calibrated === null) return `${want} → 未生效：${calibNote}`;
    return `${want}（已生效，${calibNote}）`;
  }

  /** 依目前樣本重算校準值與可信度。樣本不足或太散就把 `calibrated` 收回 null。 */
  function recomputeCalibration() {
    if (calibSamples.length < CALIB_MIN) {
      calibrated = null; calibSpread = null;
      calibNote = `校準中（${calibSamples.length}/${CALIB_MIN} 個樣本）`;
      return;
    }
    const a = calibSamples.slice().sort((x, y) => x - y);
    const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
    const med = q(0.5);
    const iqr = q(0.75) - q(0.25);
    calibSpread = iqr;
    if (!Number.isFinite(med) || !Number.isFinite(iqr) || iqr > CALIB_MAX_SPREAD_S) {
      calibrated = null;
      calibNote = `cue 時間軸不可用（離散 ${Number.isFinite(iqr) ? iqr.toFixed(1) : '?'}s`
        + `，上限 ${CALIB_MAX_SPREAD_S}s）→ 只能延後`;
      return;
    }
    calibrated = med;
    calibNote = `基準 ${med.toFixed(2)}s、離散 ${iqr.toFixed(2)}s`;
  }

  /** DOM 出現一句時記一筆校準樣本。 */
  function noteCalibration(k) {
    if (state.isLive) return;
    const cue = cueTimes.get(k);
    if (cue === undefined) return;
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime)) return;

    calibSamples.push(v.currentTime - cue);
    if (calibSamples.length > CALIB_KEEP) calibSamples.shift();
    recomputeCalibration();
  }

  /**
   * 使用者改設定或換影片時，把所有時序狀態收乾淨。
   *
   * 不做這件事的具體後果：把「延後 3 秒」改成「提前 1 秒」的那一刻，
   * 已經排進去的延後計時器還會在 3 秒後醒來補畫一次——那時畫面早就換句了。
   * 它有 DOM 比對護著不會畫錯內容，但**提前與延後同時活著**這件事本身
   * 就是不該存在的狀態，之後任何一次改動都可能踩到。
   */
  function cancelTimingTimers() {
    // 佇列裡排的是「用舊偏移算出來的」顯示與收起，改了設定就全部作廢。
    // 留著的話「延後 3 秒 → 改成提前」的那一刻，兩種模式會有一段時間同時活著。
    for (const t of delayQueue) clearTimeout(t);
    delayQueue.clear();
    earlyHoldUntil = 0;
  }

  /**
   * 換影片時把「字幕時機」歸零。字級與位置**不歸零**。
   *
   * 為什麼只有這一項要歸零：字級與位置是使用者對「我的螢幕」的偏好，跨影片一定成立。
   * 字幕時機不是——它補的是**這一支影片的**字幕偏差，而那個偏差每支都不同
   * （直播與重播的差別更大）。把上一支調好的值帶到下一支，等於預設就是錯的，
   * 而且錯得很難察覺：使用者不會想到「我上禮拜調過」。
   *
   * 一定要寫回 storage 而不是只改記憶體裡的 `settings`——
   * 否則設定頁的滑桿還停在 -1.5 秒，實際行為卻是 0，
   * 那種「畫面說一套做一套」的狀態比功能不完整更糟。
   */
  function resetOffsetForNewVideo() {
    if (clampOffset(settings.subtitleOffset) === 0) return;   // 已經是預設，別多寫一次
    const next = Object.assign({}, settings, { subtitleOffset: 0 });
    settings = sanitizeSettings(next);
    // 寫回會觸發 storage.onChanged，那裡再 sanitize 一次得到同樣的值，
    // 而且下一輪 clampOffset 已經是 0，不會再寫 → 不會遞迴。
    try { chrome.storage.local.set({ settings }); } catch (e) { /* 分頁正在關閉，忽略 */ }
    evInfo('已換影片，字幕時機回復預設（字級與位置保留）');
  }

  /**
   * 提前顯示。每次輪詢時檢查「再過 offset 毫秒就該出現」的那句。
   *
   * 只在**已經有譯文**時才提前——沒有譯文就提前顯示等於什麼都沒有，
   * 反而讓下面的 DOM 路徑被去重擋掉。
   */
  function tickEarlyDisplay() {
    const off = activeOffsetMs();
    if (off <= 0) return;
    // 免費額度用完之後**這條路也要關**。
    // handleCaption 有擋，但提前顯示不經過它——漏掉的話免費層等於形同虛設。
    if (trialExhausted()) return;
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime) || v.paused) return;

    // 往回拖進度條時把「已提前顯示過」清掉，否則重看那一段完全不會提前。
    // 只認明顯的倒退（2 秒），避免播放器微調 currentTime 就誤判。
    if (v.currentTime < lastSeekCheck - 2) shownEarly.clear();
    lastSeekCheck = v.currentTime;

    const target = v.currentTime - calibrated + off / 1000;
    // 找出「起始時間落在 [target-0.5, target] 這個窗內」且還沒顯示過的那句。
    // 窗口 0.5 秒是為了容忍輪詢間隔與校準誤差。
    for (const [k, t] of cueTimes) {
      if (t > target || t < target - 0.5) continue;
      if (shownEarly.has(k)) continue;
      const zh = memo.get(k);
      if (!zh) continue;
      shownEarly.add(k);
      if (shownEarly.size > 3000) shownEarly.clear();
      lastRaw = '';                 // 讓 DOM 到達時不會因為去重而漏掉狀態更新
      // ⚠️ 原文要一起畫。舊版傳空字串，於是提前顯示時只有中文，
      //    等原生字幕追上來才補英文——**畫面會在一兩秒內跳動一次**。
      //    那個跳動看起來就像「時機怪怪的」，但成因是內容變了不是時機變了。
      render(zh, settings.showEnglish ? (cueText.get(k) || '') : '');
      // 提前顯示的這段期間，原生字幕還沒出現，輪詢會判定「字幕清空」而想收掉。
      // 撐住到原生字幕預期抵達為止，多留一個寬限。上限就是 off，不會無限延長。
      earlyHoldUntil = Date.now() + off + CLEAR_GRACE_MS;
      dbg(`提前 ${off}ms 顯示：${zh.slice(0, 30)}`);
      return;
    }
  }

  /**
   * 延後顯示。
   *
   * ⚠️ **「顯示」與「收起」必須用同一個延遲，這是整個功能的關鍵。**
   *
   * 舊版只延後顯示，收起仍然跟著原生字幕即時走。後果是每一句的顯示時間
   * 都被硬生生砍掉 N 毫秒：
   *
   *   原生字幕 0 ~ 1200ms、延後 1000ms
   *     → 我們 1000ms 才畫出來，1200ms 原生就清空了，1550ms 收起
   *     → 使用者看到的是**閃一下就不見**（只有 550ms）
   *
   *   原生字幕 0 ~ 800ms、延後 1000ms
   *     → 排程到 1000ms 時原生早就沒了，舊版的 DOM 比對判定「畫面已換句」
   *     → **這一句完全不顯示**
   *
   * 而轉播字幕每 3~4 秒換一句，延後 3 秒幾乎必然落在這兩種情況裡——
   * 延後開得愈大，掉字幕愈嚴重。這就是「有些字幕顯示出來後馬上消失、
   * 有時甚至完全沒顯示」的成因。
   *
   * 正解是把延後當成**整條時間軸的平移**：顯示、收起都進同一個佇列，
   * 使用者看到的就是原生字幕往後挪 N 毫秒，長度完全不變。
   *
   * 舊版那個 DOM 比對是為了坑 #18（過時的譯文重新彈出）加的，但那個坑屬於
   * **翻譯慢回來才補顯示**的路徑（`flushPending` 裡那段，仍然保留檢查）。
   * 這裡的排程是在字幕出現當下、譯文已經在手上時就決定的，延遲量固定、
   * 順序不會亂——它不是「遲到的結果」，是「刻意平移的結果」，不該套同一條規則。
   */
  const delayQueue = new Set();
  const DELAY_QUEUE_MAX = 40;        // 字幕異常抖動時不要無限堆積

  function enqueueDelayed(fn) {
    const off = activeOffsetMs();
    if (off >= 0) { fn(); return; }          // 沒開延後就照舊立刻執行

    const cid = contentId;
    const v0 = document.querySelector('video');
    const at0 = v0 && Number.isFinite(v0.currentTime) ? v0.currentTime : null;
    let t = null;
    t = setTimeout(() => {
      delayQueue.delete(t);
      // 這段期間世界可能整個換掉了，逐項確認再動畫面。
      if (cid !== contentId) return;                      // 換了影片
      if (!settings.enabled || killed || tooOld) return;   // 中途被停用
      if (at0 !== null) {
        const v = document.querySelector('video');
        // 拖了進度條就作廢。正常播放時 currentTime 會剛好前進 -off 毫秒，
        // 差太多代表使用者跳走了，這句已經沒有意義。
        if (v && Number.isFinite(v.currentTime)
            && Math.abs(v.currentTime - (at0 + (-off) / 1000)) > 3) return;
      }
      fn();
    }, -off);
    delayQueue.add(t);

    if (delayQueue.size > DELAY_QUEUE_MAX) {
      const oldest = delayQueue.values().next().value;
      clearTimeout(oldest);
      delayQueue.delete(oldest);
    }
  }

  function renderWithOffset(zh, en) {
    earlyHoldUntil = 0;              // 原生字幕已經到了，不需要再撐
    enqueueDelayed(() => render(zh, en));
  }

  function handleCaption(raw) {
    const text = clean(raw);
    if (!text || text.length < 2 || text === lastRaw) return;
    // DOM 路徑同樣要擋。字幕容器若被 F1TV 拿去放別的東西（實測見過整段
    // 節目介紹），送出去只會讓整批被後端退回。
    if (text.length > MAX_LINE_LEN) {
      lastRaw = text;
      state.badLines = (state.badLines || 0) + 1;
      dbg(`略過異常長度的字幕（${text.length} 字元）`);
      return;
    }
    lastRaw = text;
    currentEn = text;

    // 免費額度用完就停止顯示。**已經在畫面上的不會被抽走**，
    // 只是不再翻新的——中途把字幕整個抽掉比一開始就沒有更惱人。
    if (trialExhausted()) { showTrialEnded(); return; }

    const k = normKey(text);
    sessionKeys.add(k);
    const hit = memo.get(k);
    if (hit) {
      state.hits++;
      noteCalibration(k);
      const t0 = performance.now();
      renderWithOffset(hit, text);
      const jsMs = performance.now() - t0;
      detect.renderMs.push(jsMs);
      if (detect.renderMs.length > 200) detect.renderMs.shift();

      // ⚠️ 上面那個數字只到「JS 返回」為止，**不是使用者看到的時間**。
      // 之前只量它就下結論「我們只加 1ms」，漏掉了版面計算與繪製。
      // 兩次 rAF 之後才是這一幀真的上畫面，那個才能拿去跟 userscript 比。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const paintMs = performance.now() - t0;
        detect.paintMs.push(paintMs);
        if (detect.paintMs.length > 200) detect.paintMs.shift();
      }));

      dbg(`命中本機快取（JS ${jsMs.toFixed(1)}ms）：${hit.slice(0, 40)}`);
      return;
    }

    state.misses++;
    dbg(`未命中，排入佇列：${text.slice(0, 60)}`);
    // 走到這裡代表預抓還沒涵蓋到這句。
    // 不顯示「翻譯中…」之類的佔位字——那會一直在畫面上閃、非常分心。
    // 就讓畫面保持空白，譯文回來時若這句還在螢幕上就補顯示。

    if (requested.has(k)) return;  // 已經送出去了，等回應就好
    // ⚠️ **這一句現在就在螢幕上，是急件。**
    //
    //    `urgentKeys` 原本設計成「畫面上正在顯示的句子不參與直播並發去重」，
    //    但**從來沒有任何地方 add 進去**——於是 isUrgent 永遠是 false，
    //    每一批都被當成非急件，直播時全部讓給其他觀眾去翻。
    //
    //    單人測試看不出來（沒有人可以讓），兩個人同時看就會
    //    互相讓來讓去：實測回覆率只有 16~34%，字幕斷斷續續。
    //    讓路的那些要等 3 秒後重讀共用快取，而直播每 3~4 秒就換一句——
    //    等回來時那句早就過去了。
    urgentKeys.add(k);
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
  /** 寫入本機快取並維持上限。切換影片時 memo 刻意不清（重複用語可互相受惠） */
  function remember(k, zh) {
    memo.set(k, zh);
    if (memo.size <= MEMO_MAX) return;
    // 淘汰最舊的，但**跳過這支影片還會用到的鍵**。
    // 不跳過的話，連看幾支長影片之後會把正在看的這支的譯文淘汰掉，
    // 畫面上突然開始重翻已經翻過的句子——不報錯，只是變慢又變貴。
    for (const key of memo.keys()) {
      if (memo.size <= MEMO_MAX) break;
      if (sessionKeys.has(key)) continue;
      memo.delete(key);
    }
  }

  function scheduleFlush() {
    if (pendingTimer) return;
    if (harvestInFlight && pending.size < BATCH_MAX) return;   // 等湊滿
    // ⚠️ **直播要加抖動。** 直播時所有觀眾在同一秒看到同一批新分段，
    //    不加抖動的話大家會在同一個毫秒送出同一批句子，伺服器端的認領
    //    機制只能擋掉一部分（認領本身也需要時間）。
    //    0~1.2 秒的隨機延遲把尖峰攤平，代價是直播字幕最多晚 1.2 秒——
    //    而 worker 的提前量有 50 秒，這點延遲完全吸收得掉。
    const jitter = state.isLive ? Math.floor(Math.random() * 1200) : 0;
    pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS + jitter);
  }

  /** 收割結束時把佇列倒乾淨——不然最後不滿一批的句子會卡住 */
  function drainAfterHarvest() {
    if (!pending.size) return;
    dbg(`收割結束，倒出剩餘 ${pending.size} 句`);
    clearTimeout(pendingTimer); pendingTimer = null;
    flushPending();
  }

  /**
   * 還沒解析出 cid 時，先把句子留在佇列裡。
   *
   * ⚠️ **沒有 cid 的請求會被丟進 `misc` 這個所有影片共用的桶子。**
   *    後果是：這支影片的共用快取拿不到那些句子，下一個觀看者要重付一次；
   *    而同一場如果有另一台裝置解析得到 cid，同一句話就會**被翻兩次、付兩次錢**。
   *    實測過，重疊率 98.1%。
   *
   * ⚠️ 但**不能無限期等**——等不到就完全沒有字幕，那比多付錢嚴重得多。
   *    所以只等 CID_WAIT_MS，之後照樣送出（用 misc），但會記一筆警告與代碼，
   *    讓它從「安靜地多花錢」變成診斷報告上看得到的一行。
   */
  const CID_WAIT_MS = 15000;
  let noCidSince = 0;

  async function flushPending() {
    pendingTimer = null;
    if (!pending.size) return;

    if (!contentId) {
      if (!noCidSince) noCidSince = Date.now();
      if (Date.now() - noCidSince < CID_WAIT_MS) {
        state.heldNoCid = (state.heldNoCid || 0) + pending.size;
        scheduleFlush();                     // 等一下再試，句子留在佇列裡
        return;
      }
      if (!state.noCidWarned) {
        state.noCidWarned = true;
        plErr('PL-C08', '譯文會寫進公用快取，這支影片的下一位觀看者要重新付費');
      }
    } else {
      noCidSince = 0;
    }
    // 最後一道。佇列可能是額度用完**之前**排進來的，送出去仍然要花錢。
    // 三道防線（ingestVtt／handleCaption／這裡）刻意重複——
    // 每一條進入佇列的路都要各自擋，只擋入口會漏掉未來新增的路徑。
    if (trialExhausted()) { pending.clear(); return; }
    if (inflight >= MAX_INFLIGHT) { scheduleFlush(); return; }

    const keys = Array.from(pending.keys()).slice(0, BATCH_MAX);
    const batch = keys.map((k) => pending.get(k));
    keys.forEach((k) => { pending.delete(k); requested.add(k); });

    inflight++;
    const t0 = Date.now();
    dbg(`送出批次 ${batch.length} 句（佇列剩 ${pending.size}，飛行中 ${inflight}/${MAX_INFLIGHT}）`);
    batch.forEach((t, i) => dbg(`  ${i + 1}. ${t.slice(0, 70)}`));
    try {
      // 整批只要有一句是急件就整批算急件。分開送會讓批次變小、呼叫次數變多，
      // 而批次大小直接決定成本（實測 14.3 句/批 vs 4.8 句/批＝三倍的呼叫）。
      // ⚠️ **直播一律算急件。**
      //    並發去重的前提是「讓路的人有時間等別人翻完再讀快取」，
      //    而那個前提來自重播的整軌預抓（提前量約 47 秒）。
      //    直播沒有提前量——字幕是隨畫面產生的，讓路等於放棄那一句。
      const isUrgent = state.isLive || keys.some((k) => urgentKeys.has(k));
      keys.forEach((k) => urgentKeys.delete(k));
      // slug 要一起送。**伺服器要靠它判斷這支影片算不算免費場次**——
      // 那條規則以前只存在於這裡，改一下用戶端就繞得過去。
      const res = await send({
        type: 'translate', cid: contentId, lines: batch,
        urgent: isUrgent, slug: location.pathname,
      });
      const lines = (res.ok && res.result && res.result.lines) || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) { remember(k, zh); n++; }
      state.translated += n;
      const ms = Date.now() - t0;
      batchStats.push({ sent: batch.length, got: n, ms });
      if (batchStats.length > 100) batchStats.shift();
      dbg(`批次回應：送 ${batch.length} / 回 ${n} 句，耗時 ${ms}ms`
        + (n < batch.length ? `　⚠ 少了 ${batch.length - n} 句` : ''));
      for (const [k, zh] of Object.entries(lines)) dbg(`  → ${zh.slice(0, 40)}`);
      // 直播時別人正在翻同一批句子（伺服器端的認領機制）。
      // **不是錯誤**，把這些句子排回佇列，過幾秒再讀一次就會從共用快取拿到。
      // 沒有這段的話，讓路的那些句子會被 `requested` 標記成「已送出」而永遠不再要，
      // 於是直播時只有第一個到的人看得到字幕——安靜地壞掉。
      const elsewhere = res.ok && res.result && res.result.pendingElsewhere;
      if (elsewhere) {
        const back = keys.filter((k) => !lines[k]);
        back.forEach((k) => { requested.delete(k); });
        dbg(`${back.length} 句由其他觀眾翻譯中，稍後從共用快取取得`);
        setTimeout(() => {
          // 排回去之前先確認還沒被別人補上，避免無意義的重送
          back.forEach((k) => { if (!memo.has(k) && batch.length) pending.set(k, batch[keys.indexOf(k)] || ''); });
          for (const [k, v] of pending) if (!v) pending.delete(k);
          if (pending.size) scheduleFlush();
        }, Number(res.result.retryAfterMs) || 3000);
      }
      if (res.ok && res.result && res.result.error) {
        state.errors++;
        const be = String(res.result.code || '');
        // 免費層的兩種情形**不是故障**，用專屬代碼標成「預期內」，
        // 不要跟真正的錯誤混在一起（見 plErr 的說明）。
        const code = res.result.reason === 'not_free_session' ? 'PL-C06'
          : /^E3[02]$/.test(be) ? 'PL-C07' : 'PL-C02';
        // logEvent 只吃一個參數，第二個會被靜默丟掉——一律用字串串接。
        plErr(code, String(res.result.error || '(無訊息)') + (be ? '（伺服器 ' + be + '）' : ''));
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
      plErr('PL-C01', String(e.message || e));
      requeue(keys, batch, e.message);
    } finally {
      keys.forEach((k) => requested.delete(k));
      inflight--;
      if (pending.size) scheduleFlush();
    }
  }

  /**
   * 失敗的句子要放回佇列重試。
   *
   * 原本是直接丟掉：`requested.delete(k)` 之後那 20 句就永遠消失了，
   * 不重試、不記錄，只有 `state.errors++`。一次 429（後端每 IP 每分鐘 120 次，
   * 同一個家用 IP 兩人同時收割就會逼近）或一次網路抖動 = 20 句永久遺失，
   * 而且**共用快取會缺這 20 句，下一個人得重新付費**。
   *
   * 每句最多重試 3 次。超過就放棄——那通常代表後端有系統性問題，
   * 無上限重試只會把 429 變得更嚴重（鐵則 #3）。
   */
  const retryCount = new Map();      // normKey -> 已重試次數
  function requeue(keys, batch, reason) {
    let back = 0, gaveUp = 0;
    keys.forEach((k, i) => {
      const n = (retryCount.get(k) || 0) + 1;
      if (n > 3) { retryCount.delete(k); gaveUp++; return; }
      retryCount.set(k, n);
      if (!memo.has(k)) { pending.set(k, batch[i]); back++; }
    });
    state.dropped += gaveUp;
    evWarn(`批次失敗（${reason}）：${back} 句已排回重試`
      + (gaveUp ? `，${gaveUp} 句重試 3 次仍失敗已放棄` : ''));
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
    const want = settings.enabled && !killed && !tooOld && settings.hideNativeCC && site && site.hideCss;
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

  /**
   * 原生字幕消失時，跟著把疊字收掉。
   *
   * 這是「感覺比 userscript 慢一拍」的真正成因。原本只靠 `holdMs` 計時器：
   *   holdMs 太短 → F1TV 的字幕還在，我們的中文先消失，空白一段才換下一句
   *   holdMs 太長 → 講完很久了，我們還掛著上一句，跟聲音對不起來
   * 兩種都讀起來像「延遲」，而且**調參數永遠只能二選一**。
   *
   * 正解是跟著來源走：我們每 100ms 就知道原生字幕清空了，那一刻收掉即可。
   * `holdMs` 從此退化成純安全網（輪詢真的停擺時才輪到它）。
   *
   * 350ms 寬限是因為換句之間 F1TV 會有極短的空窗，立刻收掉會閃爍。
   */
  const CLEAR_GRACE_MS = 350;

  /**
   * 字幕停留上限。**固定值，不開放調整。**
   *
   * 它曾經是設定頁上的滑桿，但那是個會誤導人的旋鈕：自從「跟著原生字幕一起收掉」
   * 之後，正常播放時這個計時器**永遠不會被觸發**——調它不會有任何可見效果。
   * 使用者覺得字幕不同步時會去拉它，拉完沒變，於是以為整個功能壞了。
   *
   * 真正會用到它的只有一種情況：輪詢停擺（分頁被瀏覽器節流），那時原生字幕
   * 清空的事件我們收不到，只剩這個計時器把疊字收掉。既然是安全網，
   * 就該由我們決定長度，7 秒足以涵蓋任何一句正常的轉播字幕。
   */
  const HOLD_MS = 7000;

  let clearTimer = null;
  function scheduleHide() {
    clearTimeout(clearTimer);
    // 提前顯示期間原生字幕本來就還沒出現，這時的「清空」不是真的結束。
    // 沒有這個保護，提前顯示的句子會在 350ms 後被自己的輪詢收掉——
    // 表現出來是「開了提前之後字幕一閃就不見」。
    // ⚠️ 一定要先確認是有限數。`Math.max(350, Math.min(NaN, 7000))` 會得到 NaN，
    //    而 `setTimeout(fn, NaN)` 被當成 0 —— 疊字會在下一個 tick 立刻消失。
    //    那是「調一調就壞掉」裡最難查的一種：沒有錯誤訊息，只是字幕一閃而過。
    const remain = earlyHoldUntil - Date.now();
    const wait = Number.isFinite(remain)
      ? Math.max(CLEAR_GRACE_MS, Math.min(remain, HOLD_MS))
      : CLEAR_GRACE_MS;
    clearTimer = setTimeout(() => {
      box.classList.remove('on');
      dbg('原生字幕已清空，收起疊字');
    }, wait);
  }

  function show(zhText, enText, isPending) {
    if (!settings.enabled || killed || tooOld) return;
    clearTimeout(clearTimer);          // 新句子來了，取消待執行的收起
    mount(); reposition();
    zhEl.textContent = zhText;
    zhEl.classList.toggle('pending', !!isPending);
    enEl.textContent = enText || '';
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), HOLD_MS);
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
  // ⚠️ **收割必須讓路給影片。** 這是使用者實測回報的問題：
  //    開著擴充功能時影片一直卡頓、自動降解析度，關掉就正常。
  //
  //    成因很直接——整軌預抓要抓 1,020 個 VTT 分段，而那些分段跟影片來自
  //    **同一個 CDN 主機**。HTTP/2 之下它們共用同一條連線，我們每秒打十幾個
  //    請求就是在跟影片分段搶頻寬與 stream 優先權。播放器的 ABR 演算法量到
  //    吞吐量下降，就會做它該做的事：**降解析度**。
  //    我們拿到的字幕是 40 分鐘後才要用的，影片是現在就要看的——
  //    優先權完全相反。
  //
  //    三道退讓，缺一不可：
  //      1. `priority: 'low'`（在 sw.js）——直接告訴瀏覽器這些請求排後面
  //      2. 並發從 3 降到 1、間隔拉長
  //      3. 播放器缺資料時**主動暫停收割**（見 `playbackHealthy`）
  // 節奏調整（v0.18.1）：上一版為了修卡頓把並發壓到 1、間隔 120ms，
  // 1,203 段最快也要四分半。現在退讓機制已經是**自適應**的
  // （priority:'low' + 依緩衝存量減速 + 真卡住才暫停），
  // 可以把健康時的節奏放回來，卡頓時仍然會自動退到 800ms 單線。
  const FETCH_CONCURRENCY = 2;
  const FETCH_GAP_MS = 40;
  const LIVE_REFRESH_MS = 20000;

  // ⚠️ **退讓要「減速」不能「停住」。** 上一版寫成硬性閘門：緩衝低於 8 秒就
  //    整個停下來等，最多等 30 秒。實測診斷（v0.17.0）打臉：
  //      分段：清單 1203 / 已抓 4　　讓路給影片：2 次，共 30.2 秒
  //    57 秒的觀看裡有 30 秒在等，只抓到 4 段——照這個速度 1,203 段要四小時，
  //    等於**整軌預抓實質上不會完成**。收割不完就沒有人把譯文灌滿共用快取，
  //    下一位觀眾要從頭付費翻譯，成本反而比卡頓那版更糟。
  //
  //    修一個問題製造另一個問題，是因為我把「讓路」做成二元的。
  //    改成三段，任何時候都還在前進：
  //      健康        正常速度
  //      緩衝偏低    放慢到 SLOW（不停）
  //      真的在等資料（readyState < 3）  才短暫暫停，且上限只有 5 秒
  const YIELD_BUFFER_SEC = 8;        // 低於這個秒數就放慢
  const FETCH_GAP_SLOW_MS = 800;     // 放慢時的間隔
  const YIELD_POLL_MS = 250;
  const YIELD_MAX_MS = 5000;         // 真的卡住時最多暫停這麼久

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
  const MANIFEST_MAX_BYTES = 8e6;   // 總量上限。份數上限擋不住「每份都很大」
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
      if (!m.body) continue;
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) {
        return { url: m.url, body: m.body, lang: 'eng', how: '直接攔到字幕清單' };
      }
    }
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (!m.body || !/#EXT-X-STREAM-INF/i.test(m.body)) continue;
      const sp = findSubtitlePlaylist(m.body, m.url);
      if (sp) return { url: sp.url, body: null, lang: sp.lang, how: '由 master 解析' };
    }
    return null;
  }

  /**
   * 這支影片到底**有沒有**官方字幕軌。
   *
   * ⚠️ **三態，不是布林。** 最重要的是分出「確定沒有」與「還不知道」：
   *
   *   has     —— 攔到字幕清單，或 master 裡有 TYPE=SUBTITLES
   *   none    —— **看過 master 了**，而裡面完全沒有字幕軌 → 這支真的沒有
   *   unknown —— 連 master 都還沒攔到（注入失敗？還在載？）→ **什麼都不要說**
   *
   * 把 unknown 當成 none 會造成最糟的誤報：注入失效時對每一支影片都說
   * 「這支沒有字幕」，使用者會以為我們的涵蓋範圍很差而退訂——
   * 而真正的問題（注入壞了）反而被這句話蓋掉。
   *
   * 也刻意**不看使用者有沒有開 CC**：CC 關著但字幕軌存在時，
   * 判定仍然是 has，那種情況要由 checkNoCaption 去提醒開 CC。
   */
  function subtitleTrackVerdict() {
    let sawMaster = false;
    for (const m of manifests) {
      if (!m.body) continue;
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) return 'has';
      if (/#EXT-X-STREAM-INF/i.test(m.body)) {
        sawMaster = true;
        if (/TYPE=SUBTITLES/i.test(m.body)) return 'has';
      }
    }
    return sawMaster ? 'none' : 'unknown';
  }

  /**
   * 「這支影片沒有官方字幕」的告知。
   *
   * ⚠️ **這不是錯誤，所以沒有錯誤代碼。** 影片本來就沒字幕是 F1TV 的內容問題，
   *    不是我們的故障。發代碼等於訓練使用者把正常現象當故障回報，
   *    真正的故障就會淹沒在雜訊裡（見 plErr 的說明）。
   *
   * 但**一定要說**：買家付了錢，點開一支空白的影片而畫面上沒有任何說明時，
   * 他分不出「我們壞了」與「這支本來就沒有」。那筆客訴是自找的。
   */
  let noSubShown = false;
  function checkNoSubtitleTrack() {
    if (noSubShown || !settings.enabled || !site || killed || tooOld) return;
    if (!isActuallyPlaying()) return;
    // 給播放器時間把 master 載進來。太早判定會把「還在載」說成「沒有」。
    if (Date.now() - injectSince < 45000) return;
    if (subtitleTrackVerdict() !== 'none') return;

    noSubShown = true;
    evInfo('這支影片沒有官方英文字幕軌 —— 沒有可以翻譯的來源（不是故障）');
    show('ℹ 這支影片沒有官方英文字幕，PitLingo 無法翻譯', '');
    // 回報給後端統計。**知道比例才有辦法決定要不要自己做語音辨識。**
    try {
      send({ type: 'markComplete', cid: contentId, segCount: 0, slug: location.pathname, noSubtitles: true });
    } catch (e) { /* 統計失敗不影響任何功能 */ }
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

  /** `00:01:23.456` → 秒。分秒可省略小時。 */
  function hmsToSec(t) {
    const m = String(t).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + Number(m[4]) / 1000;
  }

  /**
   * 極簡 WebVTT 解析。回傳 `{ text, start }`。
   *
   * `start` 是 cue 在**這個分段檔案內**的秒數，不是影片的絕對時間——
   * HLS 分段 VTT 要靠 X-TIMESTAMP-MAP 才能換算成絕對時間，而那條路很脆弱
   * （決策 4.1 明確避開）。我們不換算，改用自我校準推出基準，
   * 見 `noteCalibration`。
   */
  function parseVtt(raw) {
    const out = [];
    if (!raw || raw.indexOf('-->') === -1) return out;
    let cur = null, start = null;
    String(raw).replace(/\r\n?/g, '\n').split('\n').forEach((ln) => {
      if (ln.indexOf('-->') !== -1) {
        if (cur && cur.length) out.push({ text: cur.join(' '), start });
        cur = [];
        start = hmsToSec(ln.split('-->')[0]);
        return;
      }
      if (cur === null) return;
      if (ln.trim() === '') { if (cur.length) { out.push({ text: cur.join(' '), start }); cur = null; } return; }
      cur.push(ln.trim());
    });
    if (cur && cur.length) out.push({ text: cur.join(' '), start });
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
  let killed = false;              // 遠端總開關
  let freeTierCfg = null;          // 免費層設定（在遠端設定的**根層**，不在 sites 底下）
  let tooOld = false;              // 版本低於伺服器要求的下限

  /** 語意化版本比較。回傳 -1 / 0 / 1。 */
  function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

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
    const prevSite = site;
    configVersion = config.version;
    site = next;
    freeTierCfg = config.freeTier || (self.PL.BUILT_IN_CONFIG.freeTier);

    // ---- 總開關 ----
    // F1TV 大改版而我們一時修不好時，與其讓使用者看到錯亂的疊字，
    // 不如乾淨地退回原生英文字幕。這是最後的救命索（P3-PLAN 1.3）。
    killed = !!config.killSwitch;
    if (killed) {
      box.classList.remove('on');
      if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }   // 讓原生字幕回來
      evWarn('⛔ 已由遠端停用疊字（killSwitch）。原生英文字幕已恢復顯示。'
        + '這通常代表 F1TV 剛改版、我們正在修，請稍後再試。');
      return true;
    }

    // ---- 版本下限 ----
    // 舊版用戶端可能因為協定改變而產生壞資料（例如把殘缺的譯文寫進共用快取）。
    // 與其讓它繼續跑，不如明確要求更新。
    const myVer = chrome.runtime.getManifest().version;
    if (config.minClientVersion && cmpVer(myVer, config.minClientVersion) < 0) {
      tooOld = true;
      box.classList.remove('on');
      evErr(`⛔ 這個版本（v${myVer}）已停止支援，最低需要 v${config.minClientVersion}。`
        + '請到 chrome://extensions 更新 PitLingo。');
      return true;
    }
    tooOld = false;

    // 選擇器換了就把觀察者整組重掛，並清掉「已隱藏」的樣式重新套用
    observedNodes = new Set();
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
    applyHideNative();
    lastSeenCaption = ''; lastRaw = '';

    // ---- 自我檢查 ----
    // 推了壞選擇器時，使用者不該等我們發現。這裡在套用後 30 秒回頭確認
    // 「還抓得到字幕嗎」，抓不到就自動退回上一版設定（P3-PLAN 1.4）。
    // 有了它，即使推送出錯，最多也只壞 30 秒。
    if (prevVersion >= 0 && !killed && !tooOld) scheduleConfigSelfCheck(prevSite, prevVersion);

    if (prevVersion >= 0) {
      if (prevVersion === configVersion) {
        // 版本號一樣卻判定有變 → 是內容漂移，不是真的推了新設定。
        // 這種情況使用者不需要知道，降到詳細日誌就好。
        dbg(`遠端設定內容有異動但版本仍為 v${configVersion}，已就地套用`);
      } else {
        evOk(`⚙ 遠端設定已更新 v${prevVersion} → v${configVersion}，選擇器已就地套用`
          + `（root: ${(site.captionRoot || []).join(', ')}）`);
      }
    }
    return true;
  }

  /**
   * 遠端設定的自我檢查。
   *
   * 只在「套用新設定之前本來看得到字幕」時才判定失敗——否則影片剛開場、
   * 進廣告、或這段本來就沒旁白，都會被誤判成推送失敗而白白回退（坑 #14 的教訓）。
   */
  let selfCheckTimer = null;
  function scheduleConfigSelfCheck(prevSite, prevVersion) {
    clearTimeout(selfCheckTimer);
    const wasWorking = everSawCaption;
    const before = state.hits + state.misses;
    selfCheckTimer = setTimeout(() => {
      if (!wasWorking || !prevSite) return;              // 本來就沒在運作，不能判定
      if (!isActuallyPlaying()) return;                  // 沒在播就沒有判斷依據
      if (state.hits + state.misses > before) return;    // 這 30 秒有抓到字幕，正常
      if (collectCaption()) return;                      // 此刻畫面上有字幕，正常

      // ⚠️ **兩個誤判防線，都是實際遇到才補的。**
      //
      // 1. 版本沒變就沒有東西可以退。使用者實際看到過
      //    「套用設定 v1 後 30 秒都抓不到字幕，自動退回 v1」——
      //    退回自己是個 no-op，但那行紅字看起來像出了大事。
      if (prevVersion === configVersion) {
        dbg('自我檢查：30 秒沒有字幕，但設定版本沒變，沒有可退回的版本');
        return;
      }
      // 2. **「沒有字幕」不等於「選擇器壞了」。** 賽後訪問、頒獎、純畫面
      //    很容易連續 30 秒沒有任何旁白，那時原生字幕本來就是空的。
      //    選擇器真的失效時的樣子是**容器整個找不到**，而不是容器在、內容空。
      //    只看「抓不到文字」會把安靜的片段誤判成推壞設定，然後把好的設定退掉。
      if (captionContainers().length > 0) {
        dbg('自我檢查：30 秒沒有字幕，但字幕容器存在 → 判定為無旁白片段，不退回設定');
        return;
      }

      evErr(`⚠ 套用設定 v${configVersion} 後 30 秒找不到字幕容器，自動退回 v${prevVersion}`);
      site = prevSite;
      configVersion = prevVersion;
      observedNodes = new Set();
      if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
      applyHideNative();
      lastSeenCaption = ''; lastRaw = '';
      hookObservers();
    }, 30000);
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
          // 措辭要準確：這裡只代表「攔到了新的 VTT 分段」，不是重跑整軌預抓。
          // 原本寫「開始批次預譯」，使用者掛著幾小時後看到它再次出現，
          // 會誤以為整支又要重翻一次（實際上只翻了 1~2 句沒命中的）。
          evOk('✅ 已從播放器的字幕分段取得提前量');
        }
        return;
      }
      if (d.kind === 'manifest' && typeof d.manifest === 'string') {
          if (manifests.some((m) => m.url === d.url)) return;   // 同一份會重覆抓
        // 已經拿到字幕清單就不需要再留任何 manifest ——
        // 它們唯一的用途就是找出那個位址。
        if (subtitlePlaylistUrl) return;
        manifests.push({ url: d.url || '', body: d.manifest, bytes: d.manifest.length });
        // ⚠️ 上限要看**總位元組**，不是份數。
        //    每份最多 600,000 字元，12 份 = 最壞 14 MB 常駐在頁面裡。
        //    m3u8 是純文字，8 MB 已經遠超過任何實際情況。
        let total = manifests.reduce((a, m) => a + m.bytes, 0);
        while (manifests.length > MANIFEST_MAX || (manifests.length > 1 && total > MANIFEST_MAX_BYTES)) {
          total -= manifests.shift().bytes;
        }
        state.manifests = manifests.length;
        return;
      }
    }, false);
  }

  /**
   * 一句字幕的長度上限。**必須與後端的 `MAX_LINE_LEN` 一致。**
   *
   * 後端超過就整批退回（「單句長度不可超過 1000 字元」），所以送出去之前
   * 就該擋掉——讓後端替我們做輸入驗證，代價是整批句子一起被丟掉。
   *
   * 實際發生過：worker 攔到的媒體分段被硬解成文字，其中湊出了 "-->"，
   * `parseVtt` 於是產出一句幾萬字元的「字幕」。根因已在 inject.js 修掉
   * （不再碰媒體分段），這裡是第二道防線——真正的口語句子不會超過 200 字元，
   * 超過 1000 的一定不是字幕。
   */
  const MAX_LINE_LEN = 1000;

  function ingestVtt(text) {
    // 免費額度用完就不再排任何翻譯。
    // ⚠️ 這條路**不經過 `handleCaption`**，那裡的 `trialExhausted()` 擋不到它——
    //    漏掉的話免費使用者看不到字幕，我們卻還在替他翻譯後面的內容。
    if (trialExhausted()) return 0;
    let added = 0;
    let dropped = 0;
    for (const cue of parseVtt(text)) {
      const t = clean(cue.text);
      if (!t || t.length < 2) continue;
      if (t.length > MAX_LINE_LEN) { dropped++; continue; }
      const k = normKey(t);
      if (!k || prefetchSeen.has(k)) continue;
      prefetchSeen.add(k);
      // 已有譯文也要登記——那句確實出現在這支影片的 VTT 裡（坑 #16）
      sessionKeys.add(k);
      // 時間軸留給「提前顯示」用。上限與 memo 同級，避免無界成長。
      // 原文也要留：提前顯示時要跟中文一起畫出來，否則英文會晚一兩秒才跳進來。
      if (cue.start !== null && cueTimes.size < CUE_MAX) {
        cueTimes.set(k, cue.start);
        cueText.set(k, t);
      }
      if (memo.has(k)) continue;          // 共用快取已有，不用再翻
      if (pending.size >= PENDING_MAX) continue;   // 佇列爆了就先不收，下輪再說
      pending.set(k, t);
      added++;
    }
    if (dropped) {
      // 出現就代表有東西不對勁，要看得到。正常的 VTT 一句都不會被丟。
      state.badLines = (state.badLines || 0) + dropped;
      evWarn(`已略過 ${dropped} 句異常長度的字幕（超過 ${MAX_LINE_LEN} 字元），`
        + '通常代表攔到的不是字幕檔');
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

  function harvestShouldStop(myGen) {
    if (myGen !== harvestGen) return '影片切換';

    // ⚠️ **關掉翻譯不算中止收割。**
    //
    // `settings.enabled` 控制的是「要不要在畫面上顯示疊字」，不是「要不要繼續
    // 貢獻共用快取」。使用者可能只是想暫時看純英文，收割跑到 80% 卻整個作廢，
    // 下一個看同一支影片的人就得從頭付費——那是白白浪費已經抓下來的東西。
    //
    // 收割的唯一終止條件是**使用者真的離開了這支影片**。而「離開」不能只看網址：
    // 點播放器左上角的返回鍵時網址完全不變，播放器卻已經被拆掉（坑 #15）。
    // 所以用 video 元素消失超過 5 秒當訊號（5 秒是為了避開播放器重建的短暫消失）。
    // 與顯示端共用同一份判斷（playerGone），兩邊定義不一致會非常難查
    return playerGone() ? '播放器已關閉' : null;
  }

  /**
   * 播放器現在有沒有餘裕讓我們抓東西。
   *
   * 判斷依據是**緩衝存量**，不是「有沒有在播」。等到 `waiting` 事件才讓路已經太晚——
   * 那時畫面已經停住，而且 ABR 早就降過一次畫質了。緩衝掉到 8 秒就先退開。
   *
   * 暫停時回 true：那時頻寬是空的，正是收割的好時機。
   */
  /** 播放器前方還緩衝了幾秒。取不到回 null（不代表有問題）。 */
  function bufferAheadSec() {
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime)) return null;
    try {
      const b = v.buffered;
      if (!b || !b.length) return null;
      // 找出涵蓋目前播放位置的那一段，不能直接取最後一段——
      // 拖過進度條之後 buffered 會有好幾段，最後一段可能離現在很遠。
      for (let i = 0; i < b.length; i++) {
        if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i)) {
          return b.end(i) - v.currentTime;
        }
      }
      return 0;                        // 目前位置根本沒被緩衝到 = 正在等
    } catch (e) { return null; }
  }

  /**
   * 現在該用什麼節奏抓。回傳要等的毫秒數。
   *
   * `'stall'` 代表播放器真的在等資料，那時完全不要跟它搶。
   */
  function fetchPace() {
    const v = document.querySelector('video');
    if (!v) return FETCH_GAP_MS;                 // 沒有影片就沒有要讓的對象
    if (v.paused || v.ended) return FETCH_GAP_MS; // 沒在播，頻寬讓給我們
    if (v.readyState < 3) return 'stall';         // HAVE_FUTURE_DATA 以下＝正在等資料
    const ahead = bufferAheadSec();
    if (ahead !== null && ahead < YIELD_BUFFER_SEC) return FETCH_GAP_SLOW_MS;
    return FETCH_GAP_MS;
  }

  /**
   * 依播放狀況調整節奏，回傳這一輪該等多久。
   *
   * 只有「真的在等資料」才會暫停，而且上限 5 秒——**必須保證一直有進度**，
   * 因為收割不完等於沒有人把譯文灌進共用快取。
   */
  async function paceForPlayback(myGen) {
    let pace = fetchPace();
    if (pace !== 'stall') return pace;

    const t0 = Date.now();
    state.yieldCount++;
    while (fetchPace() === 'stall') {
      if (myGen !== harvestGen) return FETCH_GAP_MS;      // 換影片了
      if (Date.now() - t0 > YIELD_MAX_MS) break;
      await new Promise((r) => setTimeout(r, YIELD_POLL_MS));
    }
    state.yieldMs += Date.now() - t0;
    // 剛從卡住恢復，先用慢速走一段，不要立刻又搶滿
    return FETCH_GAP_SLOW_MS;
  }

  async function fetchSegments(list, myGen) {
    let idx = 0, lastPct = -1, stopReason = null;
    const worker = async () => {
      while (idx < list.length) {
        const stop = harvestShouldStop(myGen);
        if (stop) { stopReason = stop; return; }
        // 每抓一段之前都確認一次。整軌預抓會持續好幾分鐘，
        // 播放狀況在那段期間會變——只在開頭判斷一次沒有意義。
        const gap = await paceForPlayback(myGen);
        if (myGen !== harvestGen) return;
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
        // 用這一輪算出來的節奏，不是固定值——緩衝偏低時會自動變慢
        if (gap) await new Promise((r) => setTimeout(r, gap));
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
      // 帶上網址後綴，後台才分得出這是哪一場的哪個場次
      const res = await send({ type: 'markComplete', cid, segCount, slug: location.pathname });
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
      const server = b.lines || {};
      const serverCount = Object.keys(server).length;
      state.serverCount = serverCount;

      // ⚠️ 分母一定要用「這支影片的鍵」，不能用 memo.size。
      //    memo 跨影片共用（重複用語互相受惠，刻意的），拿它去比單一影片的
      //    bundle 必然偏低。實測就誤報過：本機 4308／後端 1946 看似只有 45%，
      //    其實 4308 裡有 2357 句是上一支影片的——真實回寫率是 99.7%。
      //    這是坑 #16 換個形式又出現，這次污染的是量測而不是資料。
      const mine = Array.from(sessionKeys);
      const missing = mine.filter((k) => !server[k]);
      const rate = mine.length ? (mine.length - missing.length) / mine.length : 1;

      if (rate >= 0.95) {
        evOk(`☁ 回寫查核：這支影片本機 ${mine.length} 句，後端已有 ${mine.length - missing.length} 句`
          + `（${Math.round(rate * 100)}%），共用快取正常累積`);
      } else {
        evWarn(`⚠ 回寫查核：這支影片本機 ${mine.length} 句，後端只有 ${mine.length - missing.length} 句`
          + `（${Math.round(rate * 100)}%）。`
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

    // ⚠️ **花錢之前先確認身分。**
    //
    // 整軌預抓會把整支影片（這裡是 1,203 段、上千句）送去翻譯。對已付費的人
    // 那是正確的：他要看完整場，而且順便把譯文灌滿共用快取讓所有人受惠。
    // 但對免費使用者，他**最多只看得到 15 分鐘**，卻讓我們付了整場的翻譯費。
    //
    // 更糟的是它可以被反覆觸發：進一支沒人翻過的影片、等收割開始、立刻退出、
    // 換下一支——每一輪都在燒錢。伺服器端每日 800 句的上限擋得住金額，
    // 但擋不住「免費使用者的成本結構本身就是錯的」。
    //
    // 免費模式改成只用 **worker 攔到的分段**（前瞻預譯）：那是播放器自己會下載的
    // 東西，我們搭便車、零額外請求，提前量約 50 秒，足夠涵蓋他看得到的 15 分鐘。
    // 整軌預抓留給付費使用者。
    //
    // `force` 是測試指令用的，會繞過這個判斷（上線前那段測試工具要整段移除）。
    if (!licensed && !force) {
      evInfo('免費模式：略過整軌預抓，改用播放器自己下載的字幕分段（提前量約 50 秒）。'
        + '購買授權後會自動改用整軌預抓，拖動進度條也不會漏字幕。');
      setPhase('前瞻預譯中');
      return;
    }

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
      // body 的唯一用途是找出這個位址，找到就放掉。
      // 診斷仍看得到有幾份與各自多大（bytes 留著）。
      manifests.forEach((m) => { m.body = ''; });
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
        // 只有「分段全抓到」**且「沒有句子被放棄」**才敢標記完整。
        //
        // 原本只看 segFailed，那只涵蓋「分段抓取」；翻譯失敗被放棄的句子完全
        // 不擋標記，等於可能把殘缺的 bundle 標成完整——之後所有人都跳過預抓，
        // 拿到的永遠是缺角的譯文，而且沒有任何機制會去補。
        if (state.harvestDone && !state.dropped) {
          markComplete(cid, segs.length, myGen);
        } else if (state.dropped) {
          evWarn(`有 ${state.dropped} 句重試後仍失敗，這次不標記完整收割`
            + '（避免後續使用者跳過預抓卻拿到缺角的譯文）');
        }
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
    for (const [k, zh] of Object.entries(b.lines || {})) { if (!memo.has(k)) { remember(k, zh); n++; } }
    state.bundleCount = n;

    if (n) { evOk(`☁ 已從共用譯文庫取得 ${n} 句（cid ${cid}），本片無須重新翻譯`); return; }

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
    // 換影片＝重新判斷一次注入有沒有成功，並清掉上一支的代碼統計
    injectChecked = false; injectSince = Date.now(); seenCodes.clear();
    noSubShown = false;
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
    sessionKeys = new Set();
    cueTimes.clear(); cueText.clear();
    calibSamples.length = 0; calibrated = null; calibSpread = null;
    calibNote = '尚未取得樣本';
    shownEarly.clear(); lastSeekCheck = 0;
    cancelTimingTimers();
    resetOffsetForNewVideo();
    // 每支影片各自判定免費資格
    freeSession = self.PL.isFreeSession(location.pathname, freeTierCfg);
    freeSpent = 0; lastTickAt = 0; trialEndedShown = false;
    loadFreeUsage(cid);   // 這支之前用掉的額度要接回來，開新分頁不會重置
    bundleSegCount = 0;
    state.manifests = 0;
    state.harvestSkipped = false;
    state.dropped = 0;
    state.badLines = 0; state.gaps = 0; state.lastGap = null;
    state.yieldCount = 0; state.yieldMs = 0;
    state.serverCount = -1;
    state.playlistSegs = 0; state.segFetched = 0; state.segFailed = 0;
    state.isLive = false; state.harvestDone = false;

    if (prev) { setPhase('切換影片'); evInfo(`影片切換 ${prev} → ${cid}`); }
    metric('session_start', { sessionType: sessionType(), licensed });
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
    settings = sanitizeSettings((setRes.ok && setRes.settings) || {});
    debugOn = !!settings.debug;
    site = siteConfigFor(config, location.hostname);
    freeTierCfg = config.freeTier || self.PL.BUILT_IN_CONFIG.freeTier;
    configVersion = config.version;

    if (!site) { evWarn('這個網域沒有對應的設定，不啟用'); return; }
    setPhase('等待播放');
    evOk(`PitLingo v${chrome.runtime.getManifest().version} 已啟動　|　設定版本 ${config.version}`
       + `　|　翻譯：${settings.enabled ? '開啟' : '關閉'}`);
    evInfo('提示：擴充功能圖示 →「匯出診斷」可一鍵複製完整狀態');

    // 授權狀態決定免費層的閘門。取不到就當未授權——
    // **但那不會鎖住功能**，只是套用免費額度（15 分鐘）。
    await refreshLicensed();
    freeSession = self.PL.isFreeSession(location.pathname, freeTierCfg);

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
      checkNoCaption();
      checkNoSubtitleTrack();
      checkInjection();
      tickFreeUsage();
    }, STRUCT_MS);

    // 定期重讀遠端設定並「就地套用」。
    // 沒有這個的話，F1TV 改版時就算後端已經推了新選擇器，
    // 使用者還是得自己重新整理頁面才會生效——比賽播到一半沒人會想這樣做。
    setInterval(applyRemoteConfig, CONFIG_RECHECK_MS);
    // 剛買完要立刻能用，剛被停用也要及時反映
    setInterval(refreshLicensed, CONFIG_RECHECK_MS);

    ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach((e) =>
      window.addEventListener(e, () => { mount(); reposition(); }, true));

    /**
     * 關閉分頁前，把還沒送出的句子做最後一搏。
     *
     * 擴充功能的譯文是**由後端在 /v1/translate 當下寫回 bundle** 的，所以
     * 「翻好的」本來就已經在伺服器上，中途離開不會白費——這點和 userscript
     * 的「累積到最後才上傳」不同，反而更安全。
     *
     * 但**還在佇列裡、根本還沒送出去**的那些會直接消失。收割完的瞬間可能還有
     * 幾十句待送，這時關掉分頁就等於下一個人要重翻那幾十句。
     *
     * pagehide 不能用 await（頁面隨時會被凍結），所以直接發 keepalive 請求。
     * 這也是為什麼要走 sendBeacon 風格而不是等回應——我們不需要譯文了，
     * 只是要讓伺服器把它翻出來存進共用快取，嘉惠下一個人。
     */
    window.addEventListener('pagehide', () => {
      flushMetrics();
      if (!pending.size || !contentId) return;
      const lines = Array.from(pending.values()).slice(0, 200);
      send({ type: 'translateKeepalive', cid: contentId, lines });
      evInfo(`離開頁面，最後送出 ${lines.length} 句給共用快取`);
    });

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
      settings = sanitizeSettings(changes.settings.newValue);
      debugOn = !!settings.debug;
      // 時機一改，之前排好的延後計時器就作廢——它是用**舊的**偏移排的。
      // 不清的話「延後 3 秒 → 改成提前」的那一刻，兩種模式會有一小段重疊。
      cancelTimingTimers();
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
  /**
   * 把網址裡的敏感段落遮掉，但保留足以診斷的資訊（長度、頭尾、路徑結構）。
   * 判斷「網址有沒有被截斷」只需要長度，不需要權杖本體。
   */
  function maskUrl(u) {
    if (!u) return '(尚未取得)';
    try {
      const url = new URL(u);
      // F1TV 的授權段是 /v2/pa_<很長的 base64>/...
      const path = url.pathname.replace(/\/(pa_[A-Za-z0-9_\-=]+)/g, (m, tok) =>
        `/pa_${tok.slice(3, 11)}…${tok.slice(-6)}[共${tok.length - 3}字元·已遮蔽]`);
      return `${url.origin}${path}${url.search ? '?<query 已遮蔽>' : ''}　(全長 ${u.length} 字元)`;
    } catch (e) {
      return `(網址解析失敗，全長 ${String(u).length} 字元)`;
    }
  }

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
    const mMaster = manifests.filter((m) => /#EXT-X-STREAM-INF/i.test(m.body || '')).length;
    const mSubs = manifests.filter((m) => /#EXTINF/i.test(m.body || '') && /\.vtt|\.webvtt/i.test(m.body || '')).length;
    const mBytes = manifests.reduce((a, m) => a + (m.bytes || 0), 0);
    L.push(`  其中 master ${mMaster} 份、字幕清單 ${mSubs} 份、共 ${(mBytes / 1024).toFixed(0)} KB`
      + (subtitlePlaylistUrl ? '（已取得清單，內容已釋放）' : ''));
    L.push(`PLAY API 路徑：已停用（八輪未通，改用 Worker 注入 + 攔到的 manifest）`);
    L.push('');
    L.push('──── 整軌預抓（決定成本與拖進度條會不會漏）────');
    L.push(`型態　　　：${state.isLive ? '直播（滑動視窗）' : '重播'}`);
    L.push(`清單來源　：${prefetchHow || '(尚未取得)'}`);
    // ⚠️ **絕對不能把完整網址寫進報告。**
    //
    // F1TV 的字幕清單網址裡有一段 base64，解開來含 sessionId 與一個 24 小時
    // 有效的 CDN 存取權杖（ttl:1440）。這份報告是設計來貼給別人看的——
    // 貼出去等於把該串流的存取權一起送出去。
    //
    // v0.4.0 為了偵錯拿掉截斷時破壞了這個原則（坑 #31）。
    // 現在改成遮蔽權杖但保留長度與頭尾，仍然看得出「有沒有被切掉」——
    // 那才是坑 #3 真正要防的事，不需要完整權杖也能判斷。
    L.push(`字幕清單　：${maskUrl(subtitlePlaylistUrl)}`);
    L.push(`分段　　　：清單 ${state.playlistSegs} / 已抓 ${state.segFetched}（失敗 ${state.segFailed}）`);
    // 收割與影片搶同一個 CDN 的頻寬。這兩個數字是「我們有沒有乖乖讓路」的證據——
    // 使用者回報畫質下降時先看這裡，全 0 代表根本沒讓過。
    const ahead = bufferAheadSec();
    L.push(`讓路給影片：暫停 ${state.yieldCount} 次共 ${(state.yieldMs / 1000).toFixed(1)} 秒`
      + `　目前節奏 ${fetchPace() === 'stall' ? '暫停（播放器正在等資料）' : fetchPace() + 'ms'}`);
    L.push(`播放器緩衝：${ahead === null ? '(取不到)' : ahead.toFixed(1) + ' 秒'}`
      + `　放慢門檻 ${YIELD_BUFFER_SEC}s、正常 ${FETCH_GAP_MS}ms／放慢 ${FETCH_GAP_SLOW_MS}ms、並發 ${FETCH_CONCURRENCY}`);
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
    const stat = (arr) => {
      if (!arr.length) return '(尚無樣本)';
      const a = arr.slice().sort((x, y) => x - y);
      return `中位數 ${a[Math.floor(a.length / 2)].toFixed(1)}ms / `
        + `p90 ${a[Math.floor(a.length * 0.9)].toFixed(1)}ms / 最大 ${a[a.length - 1].toFixed(1)}ms`
        + `（${a.length} 筆）`;
    };
    L.push(`JS 耗時　　：${stat(detect.renderMs)}`);
    L.push(`到上畫面　：${stat(detect.paintMs)}　← 這個才是使用者看到的`);
    L.push('※ 「JS 耗時」只到函式返回，不含版面計算與繪製。要跟 userscript 比就比「到上畫面」。');
    L.push('');
    L.push('──── 字幕時機微調 ────');
    // 「設定值」與「實際生效」一定要分兩行印。
    // 只印一個數字的話，使用者設了提前 1.5 秒但條件不成立時，
    // 報告看起來完全正常，我們也查不出他為什麼覺得沒效。
    L.push(`設定值　　：${clampOffset(settings.subtitleOffset)} ms`
      + `（上限：延後 ${OFFSET_LATE_MAX_MS} / 提前 ${OFFSET_EARLY_MAX_MS}）`);
    L.push(`實際生效　：${activeOffsetMs()} ms　→ ${offsetStatusText()}`);
    L.push(`校準　　　：${calibNote}`
      + `　樣本 ${calibSamples.length}/${CALIB_MIN}`
      + `　離散 ${calibSpread === null ? '-' : calibSpread.toFixed(2) + 's'}`
      + `（上限 ${CALIB_MAX_SPREAD_S}s）`);
    L.push(`cue 時間軸：${cueTimes.size} 句有時間`
      + `　已提前顯示 ${shownEarly.size} 句`);
    L.push(`延後佇列　：${delayQueue.size} 筆待執行（上限 ${DELAY_QUEUE_MAX}）`
      + '　※ 顯示與收起都在裡面，只延後其中一邊會讓字幕閃一下就消失');
    L.push(`停留上限　：${HOLD_MS} ms（固定值，不開放調整）`);
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
    // 出現過的錯誤代碼。**排在前面**——這是回報時最有用的一行。
    if (seenCodes.size) {
      L.push('錯誤代碼　：' + Array.from(seenCodes, ([c, n]) =>
        c + '×' + n + '（' + (PL_CODES[c] || '?') + '）').join('　'));
    } else {
      L.push('錯誤代碼　：無');
    }
    L.push(`字幕軌　　：${({ has: '有', none: '這支影片沒有官方字幕', unknown: '尚未判定' })[subtitleTrackVerdict()]}`);
    // ⚠️ 這一行是為了讓「安靜地多付錢」浮出來。cid 解析不到時，譯文會落進
    //    所有影片共用的 misc 桶子，這支影片的下一位觀看者要重新付費。
    L.push(`影片編號　：${contentId || '（尚未解析出來）'}`
      + `${state.heldNoCid ? `　※ 曾因沒有編號而暫留 ${state.heldNoCid} 句` : ''}`
      + `${state.noCidWarned ? '　⚠ 最後仍以公用快取送出' : ''}`);
    L.push(`即時翻譯　：${state.translated} 句　錯誤 ${state.errors}　`
      + `放棄 ${state.dropped} 句${state.dropped ? '（已重試 3 次）' : ''}`);
    // 不是 0 就代表「攔到的東西不是字幕」。曾經因為 worker 把媒體分段
    // 硬解成文字、其中湊出 "-->"，而送出幾萬字元的假字幕給後端。
    // 中途缺漏。**這是「看比賽時字幕突然消失一段」的唯一線索**——
    // 舊版看過一次字幕之後就再也不警告，那種缺漏完全是隱形的。
    L.push(`中途缺漏　：${state.gaps || 0} 次`
      + (state.lastGap
        ? `　最近一次：${state.lastGap.kind} / ${state.lastGap.sec} 秒 / ${state.lastGap.at}`
        : '（無）')
      + `　※ kind：untranslated=無譯文、render=有譯文卻沒畫、`
      + `container_gone=找不到字幕容器、silent=本來就沒旁白（正常）`);
    L.push(`長度異常略過：${state.badLines || 0} 句`
      + (state.badLines ? `　⚠ 不該大於 0，代表攔截層抓到了不是字幕的東西` : ''));
    L.push(`待送出　　：${pending.size} 句　飛行中 ${inflight} 個請求（上限 ${MAX_INFLIGHT}）`);
    L.push('');
    L.push('──── 設定 ────');
    L.push(JSON.stringify(settings));
    // 傳播延遲 = SW 快取 TTL（2 分鐘）+ 這邊的重讀間隔，最壞約 3 分鐘。
    // 只寫「每 60 秒重讀」會誤導——那 60 秒常常只是問到 SW 的快取。
    L.push(`遠端設定版本：v${configVersion}（重讀間隔 ${CONFIG_RECHECK_MS / 1000} 秒；`
      + `含後端快取，實際傳播最壞約 3 分鐘。要立即生效請用「立即重新載入設定」）`);
    L.push(`選擇器：${JSON.stringify(site && { root: site.captionRoot, label: site.captionLabel })}`);
    L.push(`授權狀態：${licensed ? '已授權' : '免費模式'}`
      + `　場次${freeSession ? '在' : '不在'}免費範圍`
      + (licensed ? '' : `　剩餘 ${Math.round(freeSecondsLeft())} 秒`)
      + `　免費層 ${(freeTierCfg && freeTierCfg.seconds) || '?'} 秒`
      + `（${freeTierCfg === self.PL.BUILT_IN_CONFIG.freeTier ? '內建' : '遠端'}）`
      + `　計時方式：${state.isLive ? '直播＝累計實際觀看秒數（暫停不計）' : '重播＝以播放位置判定前 N 分鐘'}`);
    if (!licensed) {
      L.push('　　※ 免費模式不執行整軌預抓，只用播放器自己下載的分段（前瞻預譯）');
    }
    L.push(`遠端狀態：${killed ? '⛔ killSwitch 已啟用' : '正常'}`
      + `${tooOld ? '　⛔ 版本過舊，已停止翻譯' : ''}`);
    L.push('');
    L.push(`──── 事件時間軸（最近 ${Math.min(eventLog.length, 150)} 筆）────`);
    L.push(eventLog.slice(-150).join('\n'));
    L.push('');
    L.push('════════ 報告結束 ════════');
    return L.join('\n');
  }

  // 選項頁按「匯出診斷」時會來要這份報告
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 設定頁的狀態卡要知道「這個分頁現在如何」
    if (msg && msg.type === 'quickStatus') {
      sendResponse({
        ok: true,
        state: {
          everSawCaption, memo: memo.size, contentId,
          harvestSkipped: state.harvestSkipped,
          killed, tooOld, phase,
          // 免費額度要讓使用者看得到，不能只寫在診斷報告裡。
          // 「還剩多久」是他決定要不要買的唯一依據。
          licensed,
          freeSession,
          freeLeft: licensed ? null : Math.round(freeSecondsLeft()),
          freeTotal: (freeTierCfg && freeTierCfg.seconds) || 900,
          playing: isActuallyPlaying(),
        },
      });
      return true;
    }
    if (msg && msg.type === 'collectDiagnostics') {
      sendResponse({ ok: true, report: buildDiagnostics() });
      return true;
    }
    // 設定頁要能回答「我拉的這個時機，現在真的生效了嗎」。
    // 沒有這條路的話，提前顯示的所有前置條件（重播、校準通過）都是黑箱。
    if (msg && msg.type === 'timingStatus') {
      sendResponse({
        ok: true,
        timing: {
          text: offsetStatusText(),
          set: clampOffset(settings.subtitleOffset),
          active: activeOffsetMs(),
          isLive: !!state.isLive,
          samples: calibSamples.length,
          spread: calibSpread,
          note: calibNote,
        },
      });
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
    manifests: () => manifests.map((m) => ({ url: m.url, bytes: m.bytes, held: !!m.body })),
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
