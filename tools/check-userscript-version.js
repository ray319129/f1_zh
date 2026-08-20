#!/usr/bin/env node
/**
 * userscript 的兩個版本號必須一致。
 *
 * `// @version`  Tampermonkey 判斷要不要更新的依據
 * `const VERSION` 診斷報告與事件時間軸顯示的版本
 *
 * **漂掉的後果是診斷報告會說謊。** 實際發生過：`@version` 已經是 4.9.2，
 * 而診斷一路回報 `v4.7.2` —— 於是「使用者跑的是哪一版」這個判斷全部錯誤，
 * 而那是排查任何問題的第一個依據。更糟的是它不會報錯，
 * 兩個數字各自都很合理，只有並排看才看得出來。
 *
 * 這與 `normKey`／`SYSTEM_PROMPT` 是同一類問題：**同一件事寫在兩個地方**，
 * 沒有機制擋就一定會漂。
 *
 * 用法：node tools/check-userscript-version.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'f1tv-zh-subtitles.user.js');
const src = fs.readFileSync(file, 'utf8');

const meta = (src.match(/^\/\/\s*@version\s+(\S+)/m) || [])[1];
const konst = (src.match(/^\s*const VERSION\s*=\s*['"]([^'"]+)['"]/m) || [])[1];

if (!meta) {
  console.log('❌ 找不到 `// @version` —— Tampermonkey 會無法判斷更新');
  process.exit(1);
}
if (!konst) {
  console.log('❌ 找不到 `const VERSION` —— 診斷報告會顯示 undefined');
  process.exit(1);
}
if (meta !== konst) {
  console.log(`❌ 版本號不一致：@version = ${meta}，const VERSION = ${konst}`);
  console.log('   後果：診斷報告會回報錯的版本，排查問題時會被誤導');
  process.exit(1);
}

console.log(`✅ userscript 版本一致（v${meta}）`);
