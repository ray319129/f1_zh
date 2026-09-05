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

  /**
   * 沒有中文的譯文，什麼時候仍然是對的。
   *
   * ⚠️ **這條規則是用線上 12 萬句實際譯文校準出來的，不要憑感覺改。**
   *
   *    原本只有一句「沒有中文就擋掉」，理由是「純英文回來代表模型照抄」。
   *    實測掃過全部 119 支影片、122,017 句之後發現：**被它擋下的 965 句裡，
   *    有 768 句是正確的譯文**——`hamilton → Hamilton`、`12 → 12`、
   *    `albert park → Albert Park`。我們自己的 SYSTEM_PROMPT 就規定
   *    人名、隊名、彎名、輪胎代號一律保留原文，所以**正確的譯文本來就沒有中文**。
   *
   *    這條規則以前只擋「寫進共用快取」，誤判不痛不癢；現在它同時擋「顯示」，
   *    誤判就是把字幕挖掉——而名字類的字幕在轉播裡非常多。
   *
   * 放行的條件（三選一）：
   *   1. 輸出的字母數字是來源的子集，且來源不超過 5 個詞（人名／隊名／數字）
   *   2. 同上但輸出帶中文標點（、，。）——那證明模型是刻意排版，不是照抄
   *   3. 來源很短且輸出很短（formula one → F1）
   *
   * 仍然擋下的（實測 197 句，逐句看過）：
   *   · 153 句只剩標點（`pitlane → 。`）——那是壞掉
   *   · 44 句是「整句只翻出一個名字」（`he had a great run in 99 → Eddie Irvine`）
   *     ——內容真的掉了，顯示英文原字幕比顯示半句好
   */
  function latinEchoOk(en, t) {
    const a = String(en).toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!b) return false;                       // 只剩標點：壞掉了
    const words = String(en).trim().split(/\s+/).filter(Boolean).length;
    if (!a.includes(b)) return b.length <= 4 && words <= 3;
    return words <= 5 || /[、，。：；！？「」（）]/.test(t);
  }

  function plausible(en, zh) {
    if (typeof zh !== 'string') return false;
    const t = zh.trim();
    if (!t) return false;
    if (t.length > Math.max(60, String(en || '').length * 2)) return false;
    if (INJECTION_HINT.test(t)) return false;
    if (ROLE_BREAK.test(t)) return false;
    // 沒有中文時，只有「來源本身就是人名／隊名／數字」才放行（見 latinEchoOk）
    if (!/[\u4e00-\u9fff]/.test(t) && !latinEchoOk(en, t)) return false;
    return true;
  }

  root.PL = root.PL || {};
  root.PL.clean = clean;
  root.PL.normKey = normKey;
  root.PL.plausible = plausible;
})(typeof self !== 'undefined' ? self : this);
