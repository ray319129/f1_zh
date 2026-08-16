#!/usr/bin/env node
/**
 * 擴充功能的窮舉式防呆測試（chaos test）
 *
 * 目標不是「驗證功能正確」，而是**確保使用者怎麼亂按都不會出錯**。
 * 前面每一個坑都是實際跑出來才發現的；這支是反過來，
 * 主動把所有「不合邏輯的操作順序」跑一遍。
 *
 * 判定標準只有一個：**不可以有未捕捉的例外**。
 * 功能在異常操作下降級是可以接受的，炸掉不行。
 *
 * 用法：node tools/chaos-extension.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const crashes = [];
process.on('unhandledRejection', (e) => crashes.push(`未處理的 rejection：${(e && e.message) || e}`));
process.on('uncaughtException', (e) => crashes.push(`未捕捉的例外：${(e && e.message) || e}`));

// --- 可控的假環境 -------------------------------------------------------
let now = Date.now();
const timers = [];
const windowListeners = {};
let captionText = 'Box box box, Max.';
let videoEl = null;
let containerCount = 1;

function fakeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    textContent: '', className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; }, remove() {},
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
    contains: () => false, closest: () => null, firstElementChild: null,
  };
}

function captionNode() {
  const n = fakeEl('div');
  n.textContent = captionText;
  n.querySelectorAll = (sel) => {
    if (sel === '*') return [];
    const leaf = fakeEl('span');
    leaf.textContent = captionText;
    return captionText ? [leaf] : [];
  };
  return n;
}

const documentStub = {
  visibilityState: 'visible',
  documentElement: fakeEl('html'), head: fakeEl('head'), body: fakeEl('body'),
  createElement: (t) => fakeEl(t),
  querySelector: (sel) => (sel === 'video' ? videoEl : null),
  querySelectorAll: (sel) => {
    if (sel === 'video') return videoEl ? [videoEl] : [];
    if (String(sel).includes('subtitle')) {
      return Array.from({ length: containerCount }, captionNode);
    }
    return [];
  },
  addEventListener() {}, removeEventListener() {}, getElementById: () => null,
};

// 後端回應由測試逐案控制，用來模擬 401 / 500 / 逾時 / 亂回
let swResponder = () => ({ ok: true, config: null, settings: {}, bundle: { lines: {} }, result: {}, text: '' });

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document: documentStub,
  location: {
    href: 'https://f1tv.formula1.com/detail/1000010267/x?action=play',
    pathname: '/detail/1000010267/x', hostname: 'f1tv.formula1.com',
    origin: 'https://f1tv.formula1.com',
  },
  performance: {
    getEntriesByType: () => ([{ name: 'https://f1tv.formula1.com/CONTENT/PLAY?contentId=1000010267' }]),
    setResourceTimingBufferSize() {}, now: () => now,
  },
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
  setInterval: (fn) => { timers.push({ fn, at: now + 1e9 }); return timers.length; },
  clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: (fn) => { timers.push({ fn, at: now }); return 0; },
  Date, Math, JSON, Map, Set, Promise, RegExp, URL, Error,
  Object, Array, String, Number, Boolean, TextDecoder,
  isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  chrome: {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage(msg, cb) { try { cb && cb(swResponder(msg)); } catch (e) { cb && cb({ ok: false, error: String(e.message) }); } },
      onMessage: { addListener() {} },
    },
    storage: { onChanged: { addListener(fn) { sandbox.__onSettings = fn; } }, local: { get(_, cb) { cb && cb({}); }, set() {} } },
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.postMessage = () => {};
sandbox.addEventListener = sandbox.window.addEventListener;

const ctx = vm.createContext(sandbox);
for (const f of ['extension/src/shared/normalize.js', 'extension/src/shared/defaults.js', 'extension/src/content/main.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}

// --- 輔助 ---------------------------------------------------------------
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** 把已到期的計時器跑掉，模擬時間流逝 */
function advance(ms) {
  now += ms;
  const due = timers.filter((t) => t.at <= now);
  for (const t of due) { timers.splice(timers.indexOf(t), 1); try { t.fn(); } catch (e) { crashes.push(`計時器：${e.message}`); } }
}

function fire(type, data) {
  for (const h of windowListeners[type] || []) {
    try { h(data); } catch (e) { crashes.push(`${type} handler：${e.message}`); }
  }
}
const msg = (d) => ({ source: sandbox.window, data: d });
const MARK = '__pitlingo_vtt__';

const cases = [];
const step = (name, fn) => cases.push({ name, fn });

// ========================================================================
// 情境
// ========================================================================

step('反覆快速開關翻譯', async () => {
  for (let i = 0; i < 30; i++) {
    sandbox.__onSettings && sandbox.__onSettings({ settings: { newValue: { enabled: i % 2 === 0 } } }, 'local');
  }
});

step('字幕在有／無之間高速切換', async () => {
  const api = sandbox.__pitlingo;
  for (let i = 0; i < 50; i++) {
    captionText = i % 3 === 0 ? '' : `Line number ${i} from the commentary`;
    api.t.feed(captionText);
  }
  captionText = 'Box box box, Max.';
});

step('影片元素中途消失又出現（返回鍵）', async () => {
  videoEl = { paused: false, ended: false, readyState: 4, currentTime: 12,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }) };
  advance(200);
  videoEl = null;                      // 播放器被拆掉
  advance(6000);                       // 超過 5 秒判定
  videoEl = { paused: true, ended: false, readyState: 4, currentTime: 0,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }) };
  advance(2000);
});

step('預抓進行中連續切換影片五次', async () => {
  for (let i = 0; i < 5; i++) {
    sandbox.location.pathname = `/detail/100001030${i}/x`;
    sandbox.__pitlingo.t.prefetch();
    await settle();
    advance(500);
  }
});

step('後端回 401 / 500 / 亂格式 / 完全沒回應', async () => {
  const bad = [
    () => ({ ok: false, error: 'HTTP 401' }),
    () => ({ ok: false, error: 'HTTP 500' }),
    () => ({ ok: true, result: 'not-an-object' }),
    () => ({ ok: true, bundle: { lines: 'nope' } }),
    () => ({ ok: true, config: { version: 'x', sites: 'bad' } }),
    () => null,
    () => undefined,
    () => { throw new Error('SW 掛了'); },
  ];
  for (const r of bad) {
    swResponder = r;
    sandbox.__pitlingo.t.feed('A line that needs translating right now');
    advance(1000);
    await settle();
    await sandbox.__pitlingo.t.reloadConfig().catch(() => {});
    await settle();
  }
  swResponder = () => ({ ok: true, config: null, settings: {}, bundle: { lines: {} }, result: {}, text: '' });
});

step('MAIN world 送來畸形訊息', async () => {
  const junk = [
    null, undefined, 'string', 42, [],
    { [MARK]: true },
    { [MARK]: true, kind: 'vtt' },
    { [MARK]: true, kind: 'vtt', vtt: null },
    { [MARK]: true, kind: 'vtt', vtt: 123 },
    { [MARK]: true, kind: 'manifest', manifest: null },
    { [MARK]: true, kind: 'manifest', manifest: '', url: null },
    { [MARK]: true, kind: 'manifest', manifest: 'x'.repeat(700000), url: 'javascript:alert(1)' },
    { [MARK]: true, kind: 'unknown-kind', data: 'x' },
    { [MARK]: false, kind: 'vtt', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n' },
    { kind: 'vtt', vtt: 'no mark' },
  ];
  for (const d of junk) fire('message', msg(d));
  // 來源不是自己的視窗（別的 iframe 偽造）
  fire('message', { source: {}, data: { [MARK]: true, kind: 'vtt', vtt: 'x --> y' } });
});

step('遠端設定推壞值', async () => {
  const bad = [
    { version: 2, sites: [] },
    { version: 2, sites: [{ host: 'f1tv.formula1.com' }] },                     // 沒有選擇器
    { version: 3, sites: [{ host: 'f1tv.formula1.com', captionRoot: [], captionLabel: [] }] },
    { version: 4, sites: [{ host: 'f1tv.formula1.com', captionRoot: ['###bad['], captionLabel: ['x'] }] },
    { version: 5, killSwitch: true, sites: [{ host: 'f1tv.formula1.com', captionRoot: ['.a'], captionLabel: ['.b'] }] },
    { version: 6, minClientVersion: '99.0.0', sites: [{ host: 'f1tv.formula1.com', captionRoot: ['.a'], captionLabel: ['.b'] }] },
    { version: 7, minClientVersion: 'not-a-version', sites: [{ host: 'f1tv.formula1.com', captionRoot: ['.a'], captionLabel: ['.b'] }] },
  ];
  for (const cfg of bad) {
    swResponder = () => ({ ok: true, config: cfg, settings: {}, bundle: { lines: {} }, result: {}, text: '' });
    await sandbox.__pitlingo.t.reloadConfig().catch(() => {});
    await settle();
    advance(31000);            // 讓自我檢查也跑到
  }
  swResponder = () => ({ ok: true, config: null, settings: {}, bundle: { lines: {} }, result: {}, text: '' });
});

step('設定被塞入不合理的值', async () => {
  const bad = [
    { fontSize: -5 }, { fontSize: 99999 }, { fontSize: 'big' },
    { bottomPct: -100 }, { bottomPct: 1e9 },
    { holdMs: 0 }, { holdMs: -1 }, { holdMs: 'forever' },
    { enabled: 'yes' }, { showEnglish: null }, { hideNativeCC: 1 },
    null, undefined, 'nonsense',
  ];
  for (const v of bad) {
    sandbox.__onSettings && sandbox.__onSettings({ settings: { newValue: v } }, 'local');
    sandbox.__pitlingo.t.feed('Another commentary line for testing');
    advance(100);
  }
  sandbox.__onSettings && sandbox.__onSettings({ settings: { newValue: {} } }, 'local');

  // 不只要「不炸」，值本身也必須被清洗成合理範圍。
  // fontSize: 'big' 不會拋例外，只會畫出 CSS 的 NaNpx —— 字幕整個不見，
  // 而使用者完全不知道發生什麼事。
  sandbox.__onSettings({ settings: { newValue: { fontSize: 'big', bottomPct: -100, holdMs: 0, enabled: 'yes' } } }, 'local');
  const s = sandbox.__pitlingo.t.settings();
  if (!Number.isFinite(s.fontSize) || s.fontSize < 12 || s.fontSize > 72) throw new Error('fontSize 沒有被清洗：' + s.fontSize);
  if (!Number.isFinite(s.bottomPct) || s.bottomPct < 0) throw new Error('bottomPct 沒有被清洗：' + s.bottomPct);
  if (!Number.isFinite(s.holdMs) || s.holdMs < 1000) throw new Error('holdMs 沒有被清洗：' + s.holdMs);
  if (typeof s.enabled !== 'boolean') throw new Error('enabled 沒有被轉成布林：' + typeof s.enabled);
  sandbox.__onSettings({ settings: { newValue: {} } }, 'local');
});

step('多視角：容器數量在 0/1/5 之間跳動', async () => {
  for (const n of [0, 1, 5, 0, 3, 1]) {
    containerCount = n;
    advance(1600);            // 觸發結構性檢查
    sandbox.__pitlingo.peek();
  }
  containerCount = 1;
});

step('分頁被節流後恢復', async () => {
  sandbox.__pitlingo.t.stall();
  fire('focus', { type: 'focus' });
  fire('visibilitychange', { type: 'visibilitychange' });
  documentStub.visibilityState = 'hidden';
  fire('visibilitychange', { type: 'visibilitychange' });
  documentStub.visibilityState = 'visible';
  fire('visibilitychange', { type: 'visibilitychange' });
});

step('關閉分頁時佇列還有東西', async () => {
  for (let i = 0; i < 40; i++) sandbox.__pitlingo.t.feed(`Pending line ${i} waiting to be sent`);
  fire('pagehide', { type: 'pagehide' });
});

step('全螢幕與視窗尺寸連續變動', async () => {
  for (let i = 0; i < 20; i++) { fire('resize', {}); fire('scroll', {}); fire('fullscreenchange', {}); }
});

step('所有測試指令在異常狀態下呼叫', async () => {
  videoEl = null; containerCount = 0; captionText = '';
  const t = sandbox.__pitlingo.t;
  t.help(); t.detect(); t.batches(); t.manifests(); t.memo(); t.pending();
  t.settings(); t.site(); t.feed(''); t.feed(null); t.stall();
  await t.refreshBundle().catch(() => {});
  await t.markComplete().catch(() => {});
  sandbox.__pitlingo.peek(); sandbox.__pitlingo.events(); sandbox.__pitlingo.debug(true);
  sandbox.__pitlingo.diag();
  sandbox.__pitlingo.debug(false);
  containerCount = 1; captionText = 'Box box box, Max.';
});

step('診斷在任何狀態下都要匯得出來', async () => {
  const out = sandbox.__pitlingo.diag();
  if (typeof out !== 'string' || out.length < 200) throw new Error('診斷報告異常');
  // 這份報告會被貼出去，絕不能含權杖（SECURITY.md S1）
  if (/pa_[A-Za-z0-9_-]{40,}/.test(out)) throw new Error('診斷報告含未遮蔽的授權權杖');
});

// ========================================================================
(async () => {
  await settle();
  advance(100);

  for (const c of cases) {
    const before = crashes.length;
    try { await c.fn(); } catch (e) { crashes.push(`${c.name}：${e.message}`); }
    await settle();
    advance(200);
    await settle();
    const added = crashes.length - before;
    console.log(`${added ? '❌' : '✅'} ${c.name}${added ? `（${added} 個問題）` : ''}`);
  }

  await settle();
  console.log('');
  if (crashes.length) {
    console.log(`❌ ${crashes.length} 個未預期的錯誤：\n`);
    [...new Set(crashes)].forEach((c) => console.log('   ' + c));
    process.exit(1);
  }
  console.log(`✅ ${cases.length} 個亂操作情境全部通過，沒有任何未捕捉的例外`);
})();
