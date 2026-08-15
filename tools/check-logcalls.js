#!/usr/bin/env node
/**
 * 事件日誌呼叫檢查
 *
 * logEvent(level, msg) 只接受**一個**訊息參數。呼叫端若照 console.log 的
 * 習慣傳第二個參數，它會被靜默丟掉——實測就這樣印出「翻譯後端回報錯誤：」
 * 後面一片空白，等於白記一筆，而且問題完全看不出來。
 *
 * 這種錯誤不會報錯、不會壞功能，只會讓診斷資訊消失，所以做成可重複執行的檢查。
 * 用法：node tools/check-logcalls.js
 */
const fs = require('fs');
const path = require('path');

const FILES = [
  'extension/src/content/main.js',
  'extension/src/content/inject.js',
  'extension/src/background/sw.js',
];
const FNS = ['log', 'evOk', 'evInfo', 'evWarn', 'evErr'];

// 前面不能是 . 或英數（排除 console.log、self.log 之類）
const RE = new RegExp(
  '(^|[^.\\w])(' + FNS.join('|') + ')\\(\\s*(?:\'[^\']*\'|`[^`]*`|"[^"]*")\\s*,',
  'g'
);

let bad = [];
for (const rel of FILES) {
  const file = path.join(__dirname, '..', rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    bad.push(`${rel}:${line}  ${m[0].trim()}`);
  }
}

if (bad.length) {
  console.log('❌ 這些呼叫傳了第二個參數，會被靜默丟掉——請改用字串串接：');
  bad.forEach((b) => console.log('   ' + b));
  process.exit(1);
}
console.log('✅ 沒有多參數的事件日誌呼叫（console.log 不受限，已排除）');
