#!/usr/bin/env node
/**
 * normKey() 一致性檢查
 *
 * backend / extension / userscript 三處的 normKey() 必須行為完全一致，
 * 否則同一句話會算出不同的快取鍵，共用快取整個失效——
 * 而且不會報錯，只會默默重翻，帳單默默上升。
 *
 * 這是三份程式碼之間唯一的硬性契約，所以做成可重複執行的檢查。
 * 用法：node tools/check-normkey.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function extract(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const start = src.indexOf('function normKey');
  if (start < 0) throw new Error('找不到 normKey：' + file);
  let depth = 0, end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return eval('(' + src.slice(start, end) + ')');
}

const impls = {
  backend:    extract('backend/src/index.js'),
  extension:  extract('extension/src/shared/normalize.js'),
  userscript: extract('f1tv-zh-subtitles.user.js'),
};

const samples = [
  'Box, box, box!',
  "  He's got DRS   now. ",
  "VERSTAPPEN is P1 — and that's a 1:10.246",
  'Eau Rouge / Raidillon',
  "Leclerc's flat-spotted the front-left…",
  'Multiple   spaces\tand\ttabs',
  '什麼都沒有',
  '',
];

let ok = true;
for (const s of samples) {
  const out = Object.entries(impls).map(([k, f]) => [k, f(s)]);
  const first = out[0][1];
  const same = out.every(([, v]) => v === first);
  if (!same) ok = false;
  console.log(`${same ? '✅' : '❌'} ${JSON.stringify(s).padEnd(46)} → ${JSON.stringify(first)}`);
  if (!same) out.forEach(([k, v]) => console.log(`      ${k.padEnd(11)} ${JSON.stringify(v)}`));
}
console.log(ok
  ? '\n✅ 三份 normKey() 行為完全一致 —— 共用快取的契約成立'
  : '\n❌ 不一致！共用快取會靜默失效，請修正後再提交');
process.exit(ok ? 0 : 1);
