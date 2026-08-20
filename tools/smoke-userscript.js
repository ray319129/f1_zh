#!/usr/bin/env node
/**
 * userscript 的執行期煙霧測試。
 *
 * **為什麼需要**：`node --check` 只驗語法，抓不到「用了一個沒宣告的變數」——
 * 那在語法上完全合法，要等執行到那一行才 ReferenceError。
 *
 * 實際發生過（v4.9.3）：`hqWatch()` 裡宣告的是 `cid`，底下卻用 `path`，
 * 第一行 log 就拋例外。而它在 `setTimeout` 的回呼裡，**例外被吞掉**，
 * 表現出來是「收割明明完成了，佇列就是不動」——完全沒有徵兆，
 * 使用者只能靠診斷報告的時間戳推斷。
 *
 * 擴充功能早就有 `smoke-extension.js`（坑 #22 的產物），
 * userscript 卻一直沒有——**同樣的規則沒有套用到另一個檔案上**（鐵則 #13）。
 *
 * 做法：在假的瀏覽器環境裡實際執行整份腳本，然後呼叫自動收割的進入點。
 * 判定標準只有一個：**不可以有未捕捉的例外**。
 *
 * 用法：node tools/smoke-userscript.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const crashes = [];
process.on('uncaughtException', (e) => crashes.push(`未捕捉的例外：${e.message}`));
process.on('unhandledRejection', (e) => crashes.push(`未處理的 rejection：${(e && e.message) || e}`));

const store = new Map();
const timers = [];

function el(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    textContent: '', innerHTML: '', className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; }, remove() {},
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
    contains: () => false, closest: () => null, firstElementChild: null, href: '',
  };
}

const doc = {
  visibilityState: 'visible',
  documentElement: el('html'), head: el('head'), body: el('body'),
  createElement: (t) => el(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, getElementById: () => null,
  readyState: 'complete',
};
doc.body.innerHTML = '<a href="/detail/1000010185/2026-australian-grand-prix">x</a>';

const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  document: doc,
  location: {
    href: 'https://f1tv.formula1.com/detail/1000010187/weekend-warm-up-australia?action=play',
    pathname: '/detail/1000010187/weekend-warm-up-australia',
    hostname: 'f1tv.formula1.com', origin: 'https://f1tv.formula1.com', search: '?action=play',
  },
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  performance: { getEntriesByType: () => [], setResourceTimingBufferSize() {}, now: () => Date.now() },
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: (fn, ms) => { timers.push({ fn, at: ms || 0 }); return timers.length; },
  setInterval: (fn) => { timers.push({ fn, at: 1e9 }); return timers.length; },
  clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: (fn) => { timers.push({ fn, at: 0 }); return 0; },
  fetch: async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } }),
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} getResponseHeader() { return ''; } },
  BroadcastChannel: class { postMessage() {} close() {} },
  Blob: class { constructor(p) { this.parts = p; this.size = 0; this.type = ''; } },
  URL: Object.assign(function URLShim(u) { return new (require('url').URL)(u); }, {
    createObjectURL: () => 'blob:x', revokeObjectURL() {},
  }),
  TextDecoder, TextEncoder, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, isNaN,
  // GM_* API
  GM_setValue: (k, v) => store.set(k, v),
  GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
  GM_registerMenuCommand: (label, fn) => { (sandbox.__menus = sandbox.__menus || []).push([label, fn]); },
  GM_xmlhttpRequest: () => {},
  GM_addStyle: () => {},
  GM_setClipboard: () => {},
  GM_notification: () => {},
  GM_openInTab: () => {},
  GM_info: { script: { version: '0.0.0' } },
  alert: (m) => { (sandbox.__alerts = sandbox.__alerts || []).push(String(m)); },
  confirm: () => false,
  prompt: () => null,
};
// window/self 都指回沙箱本身，並補上腳本會用到的事件 API
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.postMessage = () => {};
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
sandbox.innerWidth = 1280; sandbox.innerHeight = 720;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
// `unsafeWindow` 是 Tampermonkey 的東西，腳本可能會摸到
sandbox.unsafeWindow = sandbox;

// ⚠️ **佇列必須在執行腳本之前就設成 running。**
//    `hqWatch()` 第一件事就是 `if (!d.running) return;`——
//    先跑腳本再設狀態的話，盯梢迴圈會在還沒進入正題前就返回，
//    那條路徑等於完全沒被測到（第一版就是這樣，注入原始 bug 也抓不到）。
const store0 = JSON.stringify({
  queue: ['/detail/1000010185/2026-australian-grand-prix'],
  done: [], failed: [], running: true, startedAt: Date.now(),
});
store.set('harvestQueue', store0);
store.set('adminToken', 'test-admin-token');

const src = fs.readFileSync(path.join(root, 'f1tv-zh-subtitles.user.js'), 'utf8');
vm.createContext(sandbox);

const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { crashes.push(m); console.log('❌ ' + m); };

try {
  vm.runInContext(src, sandbox);
  ok('腳本可以實際執行（不只是語法正確）');
} catch (e) {
  bad(`腳本執行時就爆炸：${e.message}`);
  console.log(crashes.length ? '' : '');
  process.exit(1);
}

// --- 選單命令都註冊得起來 -------------------------------------------------
const menus = sandbox.__menus || [];
menus.length >= 10
  ? ok(`註冊了 ${menus.length} 個選單命令`)
  : bad(`只註冊了 ${menus.length} 個選單命令 —— 疑似中途拋錯`);

// --- 把排程的回呼全部跑一次（含巢狀排出來的）-------------------------------
//
// **這是整支測試的重點。** `hqWatch` 靠 setTimeout 啟動，它排出來的 `tick`
// 又是另一層 setTimeout —— 而那些回呼裡的例外會被瀏覽器吞掉，
// 表現出來只是「功能安靜地不動」。所以要一路跑到沒有新的排程為止。
let fired = 0;
for (let round = 0; round < 5 && timers.length; round++) {
  const batch = timers.splice(0, timers.length);
  for (const t of batch) {
    try { t.fn(); fired++; } catch (e) { bad(`排程回呼拋例外：${e.message}`); }
  }
}
ok(`跑過 ${fired} 個排程回呼（含巢狀），沒有拋例外`);

// --- 自動收割的選單 -------------------------------------------------------
const watch = menus.find(([l]) => l.includes('收割佇列狀態'));
try {
  if (watch) watch[1]();
  ok('「收割佇列狀態」可以執行');
} catch (e) { bad(`收割佇列狀態拋例外：${e.message}`); }

// 收集選單（會讀 DOM）
const collect = menus.find(([l]) => l.includes('收集本頁影片'));
try {
  if (collect) collect[1]();
  ok('「收集本頁影片到收割佇列」可以執行');
} catch (e) { bad(`收集選單拋例外：${e.message}`); }

console.log(crashes.length
  ? `\n❌ ${crashes.length} 個問題`
  : '\n✅ userscript 煙霧測試通過（沒有未捕捉的例外）');
process.exit(crashes.length ? 1 : 0);
