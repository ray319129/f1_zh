#!/usr/bin/env node
/**
 * 譯文合理性守門的三份複本必須一致。
 *
 * ⚠️ **這是第四個跨檔案的硬性契約**（前三個是 normKey、SYSTEM_PROMPT、
 *    userscript 版本號）。對不起來的後果與 normKey 同類：不報錯，
 *    只是同一句話在不同產物上表現不同——後端擋掉了、用戶端放行，
 *    或者反過來，而使用者只會覺得「有時候會有怪句子、有時候少一句」。
 *
 * 三份：
 *   backend/src/index.js                 ROLE_BREAK / plausibleTranslation()
 *   extension/src/shared/normalize.js    ROLE_BREAK / PL.plausible()
 *   f1tv-zh-subtitles.user.js            ROLE_BREAK / plausible()
 *
 * 除了比對規則本身，還跑一組**行為樣本**：
 *   - 真實發生過的模型自言自語必須被擋
 *   - 真實的轉播譯文必須放行（誤攔的代價是「那一句沒有中文字幕」）
 *
 * 用法：node tools/check-guard.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let bad = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { bad++; console.log('  ❌ ' + m); };

const FILES = [
  ['backend/src/index.js', 'backend'],
  ['extension/src/shared/normalize.js', 'extension'],
  ['f1tv-zh-subtitles.user.js', 'userscript'],
];

/* --- 1. 規則陣列必須一字不差 --- */
const rules = new Map();
for (const [f, label] of FILES) {
  const m = read(f).match(/const ROLE_BREAK = new RegExp\(\[([\s\S]*?)\]\.join\('\|'\)\);/);
  if (!m) { no(`${label}：找不到 ROLE_BREAK`); continue; }
  // 去掉縮排與空行再比，格式差異不算漂移
  rules.set(label, m[1].split('\n').map((x) => x.trim()).filter(Boolean).join('\n'));
}
if (rules.size === FILES.length) {
  const vals = new Set(rules.values());
  vals.size === 1
    ? ok(`ROLE_BREAK 三份一致（${[...rules.values()][0].split('\n').length} 條規則）`)
    : no('ROLE_BREAK 三份不一致：\n'
      + [...rules].map(([k, v]) => `     --- ${k} ---\n     ` + v.replace(/\n/g, '\n     ')).join('\n'));
}

/* --- 2. INJECTION_HINT 也要一致 --- */
{
  const got = new Map();
  for (const [f, label] of FILES) {
    const m = read(f).match(/const INJECTION_HINT = (\/.*\/i);/);
    if (m) got.set(label, m[1]);
  }
  got.size === FILES.length && new Set(got.values()).size === 1
    ? ok('INJECTION_HINT 三份一致')
    : no('INJECTION_HINT 不一致或缺漏：' + JSON.stringify([...got]));
}

/* --- 3. 行為樣本 --- */
//
// ⚠️ **兩邊都要測。** 只測「壞的有沒有擋下」會讓規則愈收愈緊，
//    直到正常字幕也被吃掉——而那個症狀是「偶爾少一句」，沒有人會回報。
const LEAK = [
  ['我沒有收到任何關於 Isaac Hadjar 的資訊。（注：根據我的知識庫，請提供完整的轉播內容片段，我會直接翻譯。）',
    '2026-08-21 直播實際外洩'],
  ['注：這句話沒有上下文', '括號外的註解'],
  ['以下是這句話的翻譯', '模型自報'],
  ['作為 AI 助理，我', '自稱 AI'],
  ['請提供完整的原文', '要求輸入'],
  ['這句無法翻譯', '拒答'],
  ['翻譯如下：他贏了', '前綴'],
  ['I could not translate this', '純英文'],
];
const REAL = [
  ['我無法相信他沒有在發車順序上', '車手無線電常見句'],
  ['我不能再推了，輪胎完蛋了', '車手無線電常見句'],
  ['以下是本場最快單圈的車手', '播報員的正常用語'],
  ['原文是這樣說的沒錯', '正常對話'],
  ['他今天經歷了不少波折才拿到第二名', '一般播報'],
  ['觀眾們的情緒恢復了，但他們剛才受到了巨大的衝擊', '一般播報'],
  ['昨天他用他的職業生涯第八個竿位向我們證明了這一點', '一般播報'],
];

function guardOf(file) {
  const src = read(file);
  const rb = src.match(/const ROLE_BREAK = new RegExp\(\[[\s\S]*?\]\.join\('\|'\)\);/)[0];
  const ih = src.match(/const INJECTION_HINT = \/.*\/i;/)[0];
  // eslint-disable-next-line no-new-func
  return new Function(`${rb}\n${ih}\nreturn function (en, zh) {
    if (typeof zh !== 'string') return false;
    const t = zh.trim();
    if (!t) return false;
    if (t.length > Math.max(60, String(en || '').length * 2)) return false;
    if (INJECTION_HINT.test(t)) return false;
    if (ROLE_BREAK.test(t)) return false;
    if (!/[\u4e00-\u9fff]/.test(t)) return false;
    return true;
  };`)();
}

{
  const g = guardOf('backend/src/index.js');
  // 英文長度給得寬鬆，才不會讓長度規則替代掉真正要測的規則
  const EN = 'x'.repeat(200);
  let leaked = 0;
  for (const [t, why] of LEAK) if (g(EN, t)) { leaked++; no(`外洩樣本沒擋下（${why}）：${t.slice(0, 40)}`); }
  if (!leaked) ok(`${LEAK.length} 個外洩樣本全部擋下`);

  let over = 0;
  for (const [t, why] of REAL) if (!g(EN, t)) { over++; no(`正常譯文被誤擋（${why}）：${t}`); }
  if (!over) ok(`${REAL.length} 句真實轉播譯文全部放行`);
}

/* --- 4. 守門必須套在該套的地方 --- */
{
  const be = read('backend/src/index.js');
  // 翻譯結果不可以在檢查之前就寫進 result（那就是「請求者拿得到」的舊 bug）
  const seg = be.match(/for \(const m of chunk\) \{[\s\S]*?\n      \}/);
  if (!seg) no('找不到 /v1/translate 的回應迴圈');
  else {
    const i = seg[0].indexOf('plausibleTranslation');
    const j = seg[0].indexOf('result[m.k] = zh');
    (i >= 0 && j > i)
      ? ok('/v1/translate：不合理的譯文連請求者都拿不到')
      : no('/v1/translate 把未通過檢查的譯文回給請求者了（模型的自言自語會顯示在畫面上）');
  }
  /(handlePostSubs[\s\S]*?)plausibleTranslation/.test(be)
    ? ok('POST /v1/subs（收割上傳）也過同一道門')
    : no('POST /v1/subs 沒有做合理性檢查 —— 收割會把垃圾寫進所有人的共用快取');
}
{
  const mn = read('extension/src/content/main.js');
  /function remember\(k, zh\) \{[\s\S]{0,400}?self\.PL\.plausible/.test(mn)
    ? ok('擴充功能：remember() 是唯一入口，且有守門')
    : no('擴充功能的 remember() 沒有守門 —— 共用快取的舊資料會直接顯示');
  /state\.blocked/.test(mn) && /合理性檢查擋下/.test(mn)
    ? ok('擴充功能：攔截次數會出現在診斷報告裡')
    : no('攔截次數沒有進診斷報告 —— 過度攔截將無從發現');
}
{
  const us = read('f1tv-zh-subtitles.user.js');
  /function memoSet\(text, zh\) \{[\s\S]{0,400}?plausible\(text, zh\)/.test(us)
    ? ok('userscript：memoSet() 有守門')
    : no('userscript 的 memoSet() 沒有守門');
}

console.log('');
console.log(bad ? `❌ ${bad} 項未通過` : '✅ 譯文守門三份一致，且套在每一條路徑上');
process.exit(bad ? 1 : 0);
