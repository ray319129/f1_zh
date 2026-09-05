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


  // -------------------------------------------------------------------
  // 譯文合理性 —— **最後一道，也是唯一擋得住「後端出錯」的一道**
  //
  // ⚠️ 這一段必須與以下兩處**完全一致**（`node tools/check-guard.js` 會擋）：
  //      - backend/src/index.js 的 ROLE_BREAK / plausibleTranslation()
  //      - f1tv-zh-subtitles.user.js 的同名函式
  //
  // ⚠️ **為什麼用戶端也要有一份。** 後端已經擋了，但：
  //    (1) memo 裡可能還留著上一版放行的壞句子——後端補擋救不了已經下載的；
  //    (2) 共用快取裡有舊資料，那是「守門收緊之前」寫進去的；
  //    (3) 後端如果哪天改壞了，這裡是使用者與模型內心話之間最後一層。
  //    誤判的代價只是那一句沒有中文，英文原字幕仍然在畫面上。
  const ROLE_BREAK = new RegExp([
    '[（(]\\s*[注註][：:]',
    '^[注註][：:]',
    '知識庫',
    '(作為|身為)\\s*(一個)?\\s*AI',
    '語言模型',
    '我(會|可以)(直接)?翻譯',
    '(無法|不便|不予)翻譯',
    '請提供[^。]{0,20}(原文|內容|片段|文字|字幕|句子)',
    '^(以下是|這是)[^。]{0,8}(翻譯|譯文)',
    '^(翻譯如下|譯文如下|中文翻譯如下)',
  ].join('|'));

  const INJECTION_HINT = /ignore (all |the )?(previous|above)|system prompt|you are now|<\|.*?\|>|assistant:|忽略(上述|先前)|你現在是/i;

  function plausible(en, zh) {
    if (typeof zh !== 'string') return false;
    const t = zh.trim();
    if (!t) return false;
    if (t.length > Math.max(60, String(en || '').length * 2)) return false;
    if (INJECTION_HINT.test(t)) return false;
    if (ROLE_BREAK.test(t)) return false;
    if (!/[\u4e00-\u9fff]/.test(t)) return false;
    return true;
  }

  root.PL = root.PL || {};
  root.PL.clean = clean;
  root.PL.normKey = normKey;
  root.PL.plausible = plausible;
})(typeof self !== 'undefined' ? self : this);
