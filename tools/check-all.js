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
  ['normKey 三份一致', 'tools/check-normkey.js'],
  ['SYSTEM_PROMPT 兩份一致 + 快取門檻', 'tools/check-prompt.js'],
  ['事件日誌沒有被丟掉的參數', 'tools/check-logcalls.js'],
  ['擴充功能可實際執行（抓 --check 抓不到的）', 'tools/smoke-extension.js'],
  ['後端資安與維運邏輯（權杖／分流／汙染防護／成本）', 'tools/check-backend.js'],
  ['亂操作防呆（14 個情境，不可有未捕捉的例外）', 'tools/chaos-extension.js'],
  ['設定頁的 HTML／CSS／JS 一致性', 'tools/check-options.js'],
  ['後台與後端一致（端點都有 UI、危險操作有確認）', 'tools/check-admin.js'],
  ['法律文件與程式碼一致（權限／保存期限／價格／法規要件）', 'tools/check-legal.js'],
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
