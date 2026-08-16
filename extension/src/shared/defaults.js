/**
 * 預設設定與遠端設定的合併邏輯
 *
 * 設計原則：**任何可能因 F1TV 改版而失效的東西都必須是資料，不能是程式碼。**
 * 選擇器、contentId 規則、隱藏用 CSS 全部放在這裡當「內建預設」，
 * 同時由後端的 /v1/config 提供可熱更新的版本。
 *
 * F1TV 改版時：改後端的 JSON → 幾分鐘內所有使用者恢復
 * 而不是：改程式碼 → 送審 → 等 1~3 天 → 使用者手動更新
 *
 * 選擇器是**陣列**，依序嘗試。F1TV 灰度推送期間新舊版會同時存在，
 * 陣列讓兩邊都能運作，你不必賭切換時機。
 */

(function (root) {
  'use strict';
  // ⚠️ 換這個位址前，先確認 manifest 的 host_permissions 兩個都在。
  //    api.pitlingo.com 是正式位址（換供應商時不用改所有已安裝的擴充功能），
  //    workers.dev 保留是為了舊版還連得上——**在確認沒有用戶端使用之前不可移除**。
  //    實際踩過：加子網域時 wrangler 預設關掉 workers.dev，所有安裝立刻斷線。
  const BACKEND = 'https://api.pitlingo.com';

  const BUILT_IN_CONFIG = {
    version: 0,                       // 內建版本永遠是 0，遠端的一定比較新
    sites: [
      {
        host: 'f1tv.formula1.com',
        captionRoot: ['.tm-subtitle-region-container'],
        captionLabel: ['.tm-ui-subtitle-label'],
        contentIdPattern: '/detail/(\\d+)',
        hideCss: '.tm-subtitle-region-container{opacity:0 !important}',
      },
    ],
    // 遠端設定拿不到時的備援。語意見 backend 的 REMOTE_CONFIG。
    freeTier: {
      seconds: 900,
      exclude: ['post-race', 'weekend-warm-up', 'highlights', 'press-conference', 'review', 'documentary'],
      // 刻意不用 `practice-?\d` 之類需要跳脫的寫法——設定是**字串**，
      // JS 字串裡的 `\d` 會被吃掉變成 `d`，正則靜默失效而且完全不報錯。
      // 這裡只需要判斷場次類型，用最單純的關鍵字就夠。
      include: ['practice', 'qualifying', 'sprint', '-race$', 'grand-prix$'],
    },
  };

  /**
   * 這支影片屬不屬於免費層涵蓋的場次。
   *
   * 免費層只涵蓋**四種正式賽事場次**（練習賽、衝刺賽、排位賽、正賽）的前 15 分鐘。
   * 其餘 F1TV 影片不在免費範圍——那些是額外內容，不是使用者訂閱 F1TV 的主要理由。
   *
   * 先排除再納入：`post-race-show-monaco` 含 "race" 但顯然不是正賽。
   */
  function isFreeSession(pathname, freeTier) {
    const ft = freeTier || BUILT_IN_CONFIG.freeTier;
    const slug = String(pathname || '').toLowerCase();
    try {
      if ((ft.exclude || []).some((p) => new RegExp(p).test(slug))) return false;
      return (ft.include || []).some((p) => new RegExp(p).test(slug));
    } catch (e) {
      return false;        // 設定裡的正則壞掉時保守處理：不當成免費
    }
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    showEnglish: true,          // 雙語顯示。字幕延遲時能靠英文關鍵字對上畫面
    fontSize: 26,               // 以 1280px 寬的影片為基準，會依實際大小縮放
    bottomPct: 8,               // 距影片底部的百分比（相對影片高度，不是視窗）
    holdMs: 7000,               // 一句字幕最長停留時間
    hideNativeCC: true,         // 隱藏原生英文字幕，避免與疊字重疊
    // 字幕時機微調（毫秒）。負值＝延後顯示，正值＝提前顯示。
    // 提前只在重播且校準成功時生效，直播一律夾成 0——
    // 直播的字幕清單是滑動視窗，基準點會變，校準值不可信。
    subtitleOffset: 0,
    debug: false,               // 詳細日誌：每句字幕、每個批次都印到 Console（測試用）
  };

  /** 從設定檔裡挑出符合目前網域的那一組 */
  /**
   * 清洗設定值。
   *
   * 設定會從 chrome.storage 讀回來，而那裡面可能有：舊版留下的欄位、
   * 使用者用開發者工具塞的值、同步過來的損毀資料。
   * 不清洗的話 `fontSize: 'big'` 會變成 CSS 的 `NaNpx`——**不會報錯，
   * 只是字幕整個不見**，而使用者完全不知道發生什麼事。
   *
   * 原則：每個欄位都夾在合理範圍內，型別不對就退回預設。寧可忽略也不要壞掉。
   */
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === 'object') ? raw : {});
    const num = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    return {
      enabled: !!s.enabled,
      showEnglish: !!s.showEnglish,
      hideNativeCC: !!s.hideNativeCC,
      debug: !!s.debug,
      fontSize: num(s.fontSize, 12, 72, DEFAULT_SETTINGS.fontSize),
      bottomPct: num(s.bottomPct, 0, 60, DEFAULT_SETTINGS.bottomPct),
      holdMs: num(s.holdMs, 1000, 30000, DEFAULT_SETTINGS.holdMs),
      subtitleOffset: num(s.subtitleOffset, -2000, 2000, 0),
    };
  }

  function siteConfigFor(config, hostname) {
    const sites = (config && config.sites) || [];
    return sites.find((s) => hostname.endsWith(s.host)) || null;
  }

  root.PL = root.PL || {};
  root.PL.BACKEND = BACKEND;
  root.PL.BUILT_IN_CONFIG = BUILT_IN_CONFIG;
  root.PL.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  root.PL.siteConfigFor = siteConfigFor;
  root.PL.sanitizeSettings = sanitizeSettings;
  root.PL.isFreeSession = isFreeSession;
})(typeof self !== 'undefined' ? self : this);
