#!/usr/bin/env node
/**
 * 正規表示式字面量的實際編譯檢查。
 *
 * **為什麼需要一支專門的工具**：JS 的正則字面量是**延遲編譯**的，
 * 所以下面這行在所有靜態檢查裡都是合法的——
 *
 *     'x'.replace( SLASH ** (.+?) ** SLASH g, ... )   ← `**` 沒有可重複的對象
 *     （這裡刻意寫成 SLASH，直接寫出那個字元會把本註解提前結束）
 *
 * 實測結果（2026-08-17）：
 *     node --check    放行
 *     new Function()  放行
 *     vm.Script       放行
 *     esbuild         放行
 *
 * 它只會在**那一行真的被執行到**的時候才爆炸。實際發生的事：
 * 反斜線被 shell 吃掉造成 `\*\*` 變成 `**`，`buy.js` 整個壞掉，
 * 而使用者在畫面上看到的是「目前無法取得方案資訊」——
 * 一個與真正原因完全無關的訊息，因為錯誤被最外層的 try/catch 吃掉了。
 *
 * 這裡的做法：找出所有正則字面量，逐一 `new RegExp()` 真的編譯一次。
 * 字面量的邊界在 JS 裡沒辦法用正則完美判定（`/` 也可能是除號），
 * 所以**只掃「明確接在這些之後」的**——那些位置一定是正則：
 *     .replace( .match( .test( .split( .search( .exec(  = /  ( /  , /  return /
 * 漏抓的代價是這支檢查沒發揮作用，誤抓的代價是假警報——寧可漏抓。
 *
 * 用法：node tools/check-regex.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const FILES = [
  'legal/buy.js',
  'legal/contact.js',
  'extension/src/content/main.js',
  'extension/src/content/inject.js',
  'extension/src/background/sw.js',
  'extension/src/shared/defaults.js',
  'extension/src/shared/normalize.js',
  'extension/src/options/options.js',
  'backend/src/index.js',
  'f1tv-zh-subtitles.user.js',
];

const errors = [];
let checked = 0;

// 只認這些位置後面的 `/`，那裡不可能是除號
// 分成強弱兩種前導，差別在**要不要排除註解**：
//
//   強前導 `.replace(` `.match(` …  這個位置後面的 `/` 一定是正則。
//        **不能加 `(?![*/])` 守衛**——那個守衛是為了跳過 `/*` 註解，
//        但壞掉的正則正好也長成 `/**…`，加了守衛就把要抓的目標排除掉了。
//        （第一版就是這樣寫的，結果注入原始 bug 也抓不到。）
//
//   弱前導 `=` `(` `,` `return` …  這裡的 `/` 可能是除號或註解，
//        必須保留守衛，寧可漏抓也不要假警報。
const BODY = String.raw`(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[dgimsuvy]*`;
const STRONG = new RegExp(
  String.raw`\.(?:replace|replaceAll|match|matchAll|test|split|search|exec)\s*\(\s*(\/` + BODY + ')', 'g');
const WEAK = new RegExp(
  String.raw`(?:[=(,:]\s*|return\s+|&&\s*|\|\|\s*)(\/(?![*/])` + BODY + ')', 'g');
const PATTERNS = [STRONG, WEAK];

for (const rel of FILES) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');

  const seen = new Set();
  for (const m of PATTERNS.flatMap((re) => [...src.matchAll(re)])) {
    if (seen.has(m.index)) continue;          // 兩種樣式可能抓到同一處
    seen.add(m.index);
    const lit = m[1];
    const lastSlash = lit.lastIndexOf('/');
    const body = lit.slice(1, lastSlash);
    const flags = lit.slice(lastSlash + 1);
    checked++;
    try {
      // eslint-disable-next-line no-new
      new RegExp(body, flags);
    } catch (e) {
      const line = src.slice(0, m.index).split('\n').length;
      errors.push(`${rel}:${line}　${lit.slice(0, 60)}　→ ${e.message}`);
    }
  }
}

// ⚠️ 這支檢查本身要能自我驗證：抓不到任何正則就代表它壞了
//    （這個專案踩過一次「檢查了 0 個函式卻回報通過」）。
if (checked < 50) {
  console.log(`❌ 只掃到 ${checked} 個正則字面量，明顯過少 —— 這支檢查的樣式可能被改壞了`);
  process.exit(1);
}

if (errors.length) {
  console.log(`❌ ${errors.length} 個無法編譯的正規表示式：`);
  errors.forEach((e) => console.log('   ' + e));
  console.log('   ※ node --check / esbuild 都不會抓到這種錯，只有實際編譯才會');
  process.exit(1);
}

console.log(`✅ ${checked} 個正規表示式全部編譯成功`);
