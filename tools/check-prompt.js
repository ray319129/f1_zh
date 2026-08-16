#!/usr/bin/env node
/**
 * SYSTEM_PROMPT 一致性與快取門檻檢查
 *
 * 兩件事會靜默出錯，所以做成可重複執行的檢查：
 *
 * 1. userscript 與 backend 的 SYSTEM_PROMPT 必須完全相同。
 *    userscript 直接打 Anthropic，backend 服務擴充功能——
 *    兩份漂掉的話，同一句話在兩個產物上會翻出不同結果，
 *    而共用快取又不分來源，於是譯文品質變成擲骰子。
 *    （這是繼 normKey() 之後第二個跨檔案硬性契約。
 *     userscript 必須是單一檔案、backend 由 wrangler 打包，
 *     沒辦法共用模組，只能靠這支檢查擋漂移。）
 *
 * 2. prompt 必須 ≥ 4096 tokens，否則 Haiku 的 cache_control 靜默失效——
 *    不報錯，只是每次都全額計費。踩過一次了，見 handoff.md 坑 #21。
 *
 * 用法：node tools/check-prompt.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const FILES = {
  userscript: 'f1tv-zh-subtitles.user.js',
  backend: 'backend/src/index.js',
};

function extract(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!m) throw new Error('找不到 SYSTEM_PROMPT：' + file);
  return m[1];
}

const got = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, extract(f)])
);

let ok = true;

// --- 1. 一致性 ---
const [refName, ref] = Object.entries(got)[0];
for (const [name, p] of Object.entries(got)) {
  const same = p === ref;
  if (!same) ok = false;
  console.log(`${same ? '✅' : '❌'} ${name.padEnd(11)} ${String(p.length).padStart(6)} 字元`);
  if (!same) {
    // 找出第一個相異位置，方便定位
    let i = 0;
    while (i < Math.min(p.length, ref.length) && p[i] === ref[i]) i++;
    console.log(`      與 ${refName} 在第 ${i} 個字元起相異`);
    console.log(`      ${refName}: ${JSON.stringify(ref.slice(i, i + 60))}`);
    console.log(`      ${name}: ${JSON.stringify(p.slice(i, i + 60))}`);
  }
}

// --- 2. 快取門檻 ---
// 粗估：CJK 約 1 字 1 token，其餘約 4 字元 1 token。
// 只用來擋「明顯低於門檻」，真正的數字請跑 userscript 選單的「🧮 檢查 token 數」。
const cjk = (ref.match(/[一-鿿]/g) || []).length;
const est = Math.round(cjk + (ref.length - cjk) / 4);
const THRESHOLD = 4096;
const margin = est >= THRESHOLD * 1.2;
if (!margin) ok = false;
console.log('');
console.log(`${margin ? '✅' : '❌'} 粗估 ${est} tokens（門檻 ${THRESHOLD}，需保留餘裕）`);

console.log(ok
  ? '\n✅ 兩份 SYSTEM_PROMPT 一致且跨過快取門檻'
  : '\n❌ 有問題，請修正後再提交');
process.exit(ok ? 0 : 1);
