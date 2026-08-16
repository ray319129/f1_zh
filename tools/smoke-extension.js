#!/usr/bin/env node
/**
 * 擴充功能 content script 煙霧測試
 *
 * 為什麼需要這支：
 * `node --check` 只驗語法。刪掉一行 `let manifests = []` 之後語法完全合法，
 * 但一執行就 `ReferenceError: manifests is not defined`——v0.4.0 就是這樣
 * 交出去的（見 handoff 坑 #22）。
 *
 * 這支在 Node 裡用假的 DOM／chrome API 把 main.js 真的跑一遍，並主動觸發
 * 幾條實際用得到的路徑。目標不是驗證行為正確，而是**確保每條路徑上的識別字
 * 都存在**——那正是 `--check` 抓不到的那一類錯。
 *
 * 用法：node tools/smoke-extension.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const calls = { sendMessage: [], listeners: {} };

// boot() 是 async——裡面的 ReferenceError 不會往上拋，會變成未處理的 rejection
// （使用者在 Console 看到的正是 `Uncaught (in promise) ReferenceError`）。
// 不攔這個的話，最先炸掉的那一處反而測不到。
process.on('unhandledRejection', (e) => {
  errors.push(`未處理的 rejection：${(e && e.message) || e}`);
});

// --- 假 DOM ------------------------------------------------------------
function fakeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], textContent: '', className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
    contains: () => false,
    closest: () => null,
    firstElementChild: null,
  };
  return el;
}

const documentStub = {
  visibilityState: 'visible',
  documentElement: fakeEl('html'),
  head: fakeEl('head'),
  body: fakeEl('body'),
  createElement: (t) => fakeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (calls.listeners[type] = calls.listeners[type] || []).push(fn); },
  removeEventListener() {},
  getElementById: () => null,
};

const windowListeners = {};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document: documentStub,
  location: {
    href: 'https://f1tv.formula1.com/detail/1000010267/post-race-show-monaco?action=play',
    pathname: '/detail/1000010267/post-race-show-monaco',
    hostname: 'f1tv.formula1.com',
    origin: 'https://f1tv.formula1.com',
  },
  performance: {
    getEntriesByType: () => ([
      { name: 'https://f1tv.formula1.com/2.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=1000010267&channelId=0' },
    ]),
    setResourceTimingBufferSize() {},
    now: () => Date.now(),
  },
  MutationObserver: class { observe() {} disconnect() {} },
  // 計時器全部吃掉，避免測試自己跑成無窮迴圈
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout() {}, clearInterval() {},
  Date, Math, JSON, Map, Set, Promise, RegExp, URL, Error, Object, Array, String, Number, Boolean,
  TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : class {},
  isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  chrome: {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '0.0.0-test' }),
      sendMessage(msg, cb) {
        calls.sendMessage.push(msg && msg.type);
        // 回一個「什麼都成功但沒資料」的回應，讓各條路徑都走得下去
        if (cb) cb({ ok: true, config: null, settings: {}, bundle: { lines: {} }, result: {}, text: '' });
      },
      onMessage: { addListener() {} },
    },
    storage: { onChanged: { addListener() {} }, local: { get(_, cb) { cb && cb({}); }, set() {} } },
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.postMessage = () => {};
sandbox.addEventListener = sandbox.window.addEventListener;

const ctx = vm.createContext(sandbox);

// --- 載入三支 content script（順序照 manifest）--------------------------
const FILES = [
  'extension/src/shared/normalize.js',
  'extension/src/shared/defaults.js',
  'extension/src/content/main.js',
];
for (const f of FILES) {
  try {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  } catch (e) {
    errors.push(`載入 ${f} 失敗：${e.message}`);
  }
}

// --- 主動觸發實際路徑 ---------------------------------------------------
// 這些是 v0.4.0 真正炸掉的地方：訊息橋接與影片切換。
function run(label, fn) {
  try { fn(); } catch (e) { errors.push(`${label}：${e.message}`); }
}

// boot() 是 async，要讓 microtask 佇列跑完，橋接與監聽器才裝得上
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

main();
async function main() {
await settle();
const api = sandbox.__pitlingo || {};

// 1) MAIN world 送 manifest 過來（會走到 manifests.push）
run('inject 橋接 · manifest', () => {
  const handlers = windowListeners.message || [];
  if (!handlers.length) throw new Error('沒有註冊 message 監聽器，橋接可能沒安裝');
  const ev = {
    source: sandbox.window,
    data: {
      __pitlingo_vtt__: true, kind: 'manifest',
      url: 'https://ott-video-fer-cf.formula1.com/v2/pa_TOKEN/h/h/index_13_0.m3u8',
      manifest: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="eng",URI="sub.m3u8"\n',
    },
  };
  handlers.forEach((h) => h(ev));
});

// 2) 送 VTT 過來（會走到 ingestVtt → scheduleFlush）
run('inject 橋接 · vtt', () => {
  const handlers = windowListeners.message || [];
  const ev = {
    source: sandbox.window,
    data: {
      __pitlingo_vtt__: true, kind: 'vtt', url: 'https://x/seg1.vtt',
      vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBox box box\n',
    },
  };
  handlers.forEach((h) => h(ev));
});

// 3) 注入成功通知
run('inject 橋接 · injected', () => {
  const handlers = windowListeners.message || [];
  handlers.forEach((h) => h({
    source: sandbox.window,
    data: { __pitlingo_vtt__: true, kind: 'injected', bytes: 707103 },
  }));
});

// 4) 診斷報告（buildDiagnostics 會讀 manifests，v0.4.0 就是在這裡炸的）
run('匯出診斷', () => {
  if (typeof api.diag !== 'function') throw new Error('__pitlingo.diag 不存在');
  const out = api.diag();
  if (typeof out !== 'string' || out.length < 100) throw new Error('診斷內容異常短');
});

// 5) 換影片。checkContentChange 沒有公開入口，改用 boot() 註冊在 window 的
//    focus handler——它會走 checkPollStall + pollCaption，而 structural 檢查
//    的那條路徑（含 manifests = []）由 prefetch 入口一併覆蓋。
run('切換影片 → 整軌預抓入口', () => {
  sandbox.location.pathname = '/detail/1000010243/post-race-show-miami';
  if (typeof api.prefetch !== 'function') throw new Error('__pitlingo.prefetch 不存在');
  api.prefetch();
});

run('視窗事件（focus / resize）', () => {
  for (const t of ['focus', 'visibilitychange', 'resize', 'scroll']) {
    (windowListeners[t] || []).forEach((h) => h({ type: t }));
  }
});

// 6) 其他公開入口
for (const name of ['peek', 'site', 'events', 'state']) {
  run(`__pitlingo.${name}`, () => {
    const v = api[name];
    if (typeof v === 'function') v();
  });
}

// --- 結果 --------------------------------------------------------------
await settle();
if (errors.length) {
  console.log('❌ 煙霧測試失敗\n');
  errors.forEach((e) => console.log('   ' + e));
  console.log('\n這類錯誤 node --check 抓不到——它只驗語法，不驗識別字是否存在。');
  process.exit(1);
}
console.log('✅ content script 可載入，且下列路徑都跑得過：');
console.log('   manifest 橋接 / VTT 橋接 / 注入通知 / 匯出診斷 / 切換影片 / 公開入口');
console.log(`   （期間對 service worker 發出 ${calls.sendMessage.length} 則訊息：`
  + `${[...new Set(calls.sendMessage)].join(', ')}）`);
}
