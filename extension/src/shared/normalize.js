/**
 * 文字正規化 —— 快取鍵的計算方式
 *
 * ⚠️ 這裡的 normKey() 必須與以下兩處**完全一致**，否則同一句話會算出不同的鍵，
 *    共用快取就整個失效（而且不會報錯，只會默默重翻）：
 *      - backend/src/index.js 的 normKey()
 *      - f1tv-zh-subtitles.user.js 的 normKey()
 *
 * 這是三份程式碼之間唯一的硬性契約。改動時三邊要一起改。
 */

(function (root) {
  'use strict';

  /** 去掉 VTT 標籤、音效標記與 HTML 實體，收合空白 */
  function clean(s) {
    return String(s || '')
      .replace(/<[^>]*>/g, ' ')        // <v Speaker> <i> 之類的行內標籤
      .replace(/\[[^\]]*\]/g, ' ')     // [MUSIC] [APPLAUSE]
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 快取鍵：轉小寫、去掉所有標點、收合空白。
   * 目的是讓「VTT 裡的原文」與「畫面上渲染出來的文字」能對得起來——
   * 兩者的標點與大小寫常有細微差異。
   */
  function normKey(s) {
    try {
      return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (e) {
      // 極舊環境沒有 Unicode property escapes 時的退路
      return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  root.PL = root.PL || {};
  root.PL.clean = clean;
  root.PL.normKey = normKey;
})(typeof self !== 'undefined' ? self : this);
