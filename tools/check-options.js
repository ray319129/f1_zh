#!/usr/bin/env node
/**
 * 設定頁的靜態一致性檢查。
 *
 * 為什麼需要：`$('licActivat')` 少一個字元不會報錯，
 * `getElementById` 回 null，`null.onclick = ...` 才炸——**而且只在使用者
 * 打開那一頁時才炸**，開發時很容易漏掉。反過來也一樣：HTML 上放了一個
 * 沒人接的按鈕，使用者按了完全沒反應，也不會有任何錯誤訊息。
 *
 * 另外檢查 MV3 的硬性規定：行內 script／style 會直接讓上架審核失敗。
 *
 * 用法：node tools/check-options.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'extension/src/options');

const html = fs.readFileSync(path.join(dir, 'options.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'options.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'options.css'), 'utf8');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 1. JS 取用的 id 必須存在於 HTML --------------------------------------
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// id 有兩種取用方式：字面 `$('licActivate')`，以及透過 TOGGLES／RANGES 陣列
// 迴圈綁定的 `$(k)`。只看字面會把後者全部誤判成「沒人處理」。
const arrayIds = (name) => {
  const m = js.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  return m ? (m[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
};
const usedIds = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...arrayIds('TOGGLES'),
  ...arrayIds('RANGES'),
]);

const missing = [...usedIds].filter((id) => !htmlIds.has(id));
missing.length
  ? bad(`JS 取用了 HTML 裡沒有的 id：${missing.join('、')} —— 那些按鈕會完全沒反應`)
  : ok(`JS 取用的 ${usedIds.size} 個 id 都存在於 HTML`);

// --- 2. HTML 上的互動元件必須有人接 ---------------------------------------
// 只檢查 button／input，容器類的 id 本來就可能只給 CSS 用
const interactive = [...html.matchAll(/<(button|input|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2]);
const orphan = interactive.filter((id) => !usedIds.has(id));
orphan.length
  ? bad(`HTML 上有沒人處理的互動元件：${orphan.join('、')} —— 使用者按了不會有事發生`)
  : ok(`${interactive.length} 個互動元件都有對應的處理`);

// --- 3. MV3 硬性規定：不可有行內 script／style ------------------------------
/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html)
  ? bad('HTML 含行內 <script> —— MV3 的 CSP 會擋掉，且上架審核會失敗')
  : ok('沒有行內 script');
/\sstyle="/.test(html)
  ? bad('HTML 含行內 style 屬性 —— MV3 的 CSP 會擋掉')
  : ok('沒有行內 style 屬性');

// --- 4. 設定欄位三邊要對得起來 --------------------------------------------
const defaults = fs.readFileSync(path.join(root, 'extension/src/shared/defaults.js'), 'utf8');
const defBlock = defaults.match(/const DEFAULT_SETTINGS = \{([\s\S]*?)\};/)[1];
const defKeys = [...defBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

const wired = [...arrayIds('TOGGLES'), ...arrayIds('RANGES')];

// 刻意不給一般使用者看的設定。放在這裡而不是靠人記得——
// 少一個 UI 究竟是「故意的」還是「忘了接」，只有寫下來才分得出來。
const INTENTIONALLY_HIDDEN = {
  debug: '詳細日誌是開發用的，放進公開 UI 只會造成困惑。'
       + '需要時在 F1TV 分頁的 Console 打 __pitlingo.debug(true)。',
};

const unwired = defKeys.filter((k) => !wired.includes(k) && !INTENTIONALLY_HIDDEN[k]);
Object.keys(INTENTIONALLY_HIDDEN)
  .filter((k) => defKeys.includes(k))
  .forEach((k) => console.log(`ℹ️  ${k} 刻意不放進 UI：${INTENTIONALLY_HIDDEN[k]}`));
const staleHidden = Object.keys(INTENTIONALLY_HIDDEN).filter((k) => !defKeys.includes(k));
if (staleHidden.length) bad(`白名單裡有已不存在的設定：${staleHidden.join('、')}`);

unwired.length
  ? bad(`這些設定沒有任何 UI 可以調整：${unwired.join('、')}`)
  : ok(`${defKeys.length} 個設定欄位都有對應的 UI`);

const ghost = wired.filter((k) => !defKeys.includes(k));
ghost.length
  ? bad(`UI 綁了 DEFAULT_SETTINGS 沒有的欄位：${ghost.join('、')} —— 會被 sanitizeSettings 丟掉`)
  : ok('UI 沒有綁到不存在的設定欄位');

// --- 5. CSS 類別要有人用（避免改版後留下死樣式）-----------------------------
const cssClasses = new Set([...css.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]));
const usedInHtmlOrJs = html + js;
const deadCss = [...cssClasses].filter((c) => !new RegExp(`["'\\s.]${c}\\b`).test(usedInHtmlOrJs));
deadCss.length
  ? console.log(`ℹ️  CSS 有 ${deadCss.length} 個沒被用到的類別：${deadCss.join('、')}`)
  : ok('CSS 沒有多餘的類別');

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 設定頁的 HTML／CSS／JS 與設定定義完全對得起來');
