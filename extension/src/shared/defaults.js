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

  const BACKEND = 'https://f1zh-api.pitlingo.workers.dev';

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
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    showEnglish: true,          // 雙語顯示。字幕延遲時能靠英文關鍵字對上畫面
    fontSize: 26,               // 以 1280px 寬的影片為基準，會依實際大小縮放
    bottomPct: 8,               // 距影片底部的百分比（相對影片高度，不是視窗）
    holdMs: 7000,               // 一句字幕最長停留時間
    hideNativeCC: true,         // 隱藏原生英文字幕，避免與疊字重疊
  };

  /** 從設定檔裡挑出符合目前網域的那一組 */
  function siteConfigFor(config, hostname) {
    const sites = (config && config.sites) || [];
    return sites.find((s) => hostname.endsWith(s.host)) || null;
  }

  root.PL = root.PL || {};
  root.PL.BACKEND = BACKEND;
  root.PL.BUILT_IN_CONFIG = BUILT_IN_CONFIG;
  root.PL.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  root.PL.siteConfigFor = siteConfigFor;
})(typeof self !== 'undefined' ? self : this);
