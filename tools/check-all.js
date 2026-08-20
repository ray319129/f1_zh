#!/usr/bin/env node
/**
 * 一次跑完所有檢查。
 *
 * 存在的理由很實際：檢查工具愈來愈多，靠記憶一支一支跑就會漏。
 * v0.4.0 出包正是因為只跑了 `node --check` 就交出去（坑 #22）。
 *
 * 用法：node tools/check-all.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

const SYNTAX = [
  'f1tv-zh-subtitles.user.js',
  'backend/src/index.js',
  'extension/src/content/main.js',
  'extension/src/content/inject.js',
  'extension/src/background/sw.js',
  'extension/src/shared/normalize.js',
  'extension/src/shared/defaults.js',
];

const CHECKS = [
  ['userscript 兩處版本號一致', 'tools/check-userscript-version.js'],
  ['normKey 三份一致', 'tools/check-normkey.js'],
  ['SYSTEM_PROMPT 兩份一致 + 快取門檻', 'tools/check-prompt.js'],
  ['事件日誌沒有被丟掉的參數', 'tools/check-logcalls.js'],
  ['擴充功能可實際執行（抓 --check 抓不到的）', 'tools/smoke-extension.js'],
  ['userscript 可實際執行（含自動收割的排程回呼）', 'tools/smoke-userscript.js'],
  ['注入層（worker hook 語法 + 絕不攔媒體分段）', 'tools/check-inject.js'],
  ['正規表示式全部編譯得起來（--check 抓不到）', 'tools/check-regex.js'],
  ['後端資安與維運邏輯（權杖／分流／汙染防護／成本）', 'tools/check-backend.js'],
  ['亂操作防呆（15 個情境，不可有未捕捉的例外）', 'tools/chaos-extension.js'],
  ['設定頁的 HTML／CSS／JS 一致性', 'tools/check-options.js'],
  ['後台與後端一致（端點都有 UI、危險操作有確認）', 'tools/check-admin.js'],
  ['法律文件與程式碼一致（權限／保存期限／價格／法規要件）', 'tools/check-legal.js'],
  ['所有超連結指向正確位置', 'tools/check-links.js'],
];

let failed = 0;

function run(label, args) {
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe' });
    console.log(`✅ ${label}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${label}`);
    const out = ((e.stdout || '') + (e.stderr || '')).toString().trim();
    if (out) out.split('\n').forEach((l) => console.log('     ' + l));
  }
}

console.log('── 語法 ──');
for (const f of SYNTAX) run(f, ['--check', f]);

/**
 * ⚠️ **`node --check` 對 ESM 檔案有盲點。**
 *
 * `backend/src/index.js` 是 ES module（`export default`），但副檔名是 `.js`，
 * 於是 `node --check` 用 **CommonJS** 的方式解析它——實測會**放行**
 * 下面這種錯誤，而 wrangler 用的 esbuild 直接爆掉：
 *
 *     async function handleRequest(r, e) {
 *       { ... }
 *     },        ← 多餘的逗號
 *     };        ← 多餘的分號
 *
 * 實際發生過：CORS 重構把 `export default { async fetch() }` 拆成獨立函式時，
 * 尾端的 `},\n};` 沒改乾淨。`check-all` 全綠，`wrangler deploy` 失敗，
 * 而錯誤訊息只有一個行號——**測試綠燈卻部署不了，比紅燈更浪費時間**。
 *
 * 修法是複製成 `.mjs` 再檢查一次：`.mjs` 強制走 ESM 解析，
 * 這種錯誤就抓得到（實測 `.js` exit 0、`.mjs` exit 1）。
 */
{
  const fs = require('fs');
  const os = require('os');
  const ESM = ['backend/src/index.js'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-esm-'));
  for (const f of ESM) {
    const copy = path.join(tmp, path.basename(f).replace(/\.js$/, '.mjs'));
    fs.writeFileSync(copy, fs.readFileSync(path.join(root, f)));
    run(`${f}（以 ESM 解析）`, ['--check', copy]);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
}

// JSON 檔沒有 `node --check` 可用，但壞掉的後果更嚴重：
// manifest.json 不合法 → 擴充功能整個載入不了。
// 實際發生過一次（腳本先開寫入模式清空檔案才讀取），所以納入檢查。
for (const f of ['extension/manifest.json']) {
  run(f, ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(f)}, 'utf8'))`]);
}

console.log('\n── 契約與行為 ──');
for (const [label, script] of CHECKS) run(label, [script]);

console.log('');
if (failed) {
  console.log(`❌ ${failed} 項未通過，請修正後再提交`);
  process.exit(1);
}
console.log('✅ 全部通過');
