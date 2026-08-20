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
  // ⚠️ 這裡原本是 `at: now + 1e9`，等於**所有 setInterval 永遠不會觸發**。
  //    後果是這支測試從來沒有跑過任何定期迴圈：字幕輪詢、結構性檢查、
  //    換影片偵測、遠端設定重讀、免費額度計時——全部沒被測到，
  //    而每一個情境的 `advance(1600)` 註解都寫著「觸發結構性檢查」。
  //    測試綠燈但根本沒測到，比紅燈更危險。
  setInterval: (fn, ms) => {
    timers.push({ fn, at: now + (ms || 0), every: Math.max(1, Number(ms) || 1) });
    return timers.length;
  },
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
/**
 * 把假時鐘往前推，途中該醒的計時器都要醒。
 *
 * 週期性計時器（`every`）跑完要重新排程，否則只會觸發一次。
 * 迴圈上限是防呆：一次推 60 秒 × 100ms 輪詢 = 600 次是正常的，
 * 但如果哪天有人寫出 `setInterval(fn, 0)`，沒有上限這裡會直接卡死。
 */
const MAX_TIMER_FIRES = 20000;
function advance(ms) {
  const until = now + ms;
  let fired = 0;
  for (;;) {
    const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!next || ++fired > MAX_TIMER_FIRES) break;
    now = Math.max(now, next.at);
    timers.splice(timers.indexOf(next), 1);
    if (next.every) timers.push({ fn: next.fn, at: next.at + next.every, every: next.every });
    try { next.fn(); } catch (e) { crashes.push(`計時器：${e.message}`); }
  }
  now = until;
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
    // holdMs 已經不是設定項（改成固定的 HOLD_MS）。舊 storage 裡還會有，
    // 必須確認它被無視而不是被沿用——沿用的話等於偷偷保留一個廢棄旋鈕。
    { holdMs: 0 }, { holdMs: -1 }, { holdMs: 'forever' },
    { subtitleOffset: 999999 }, { subtitleOffset: -999999 },
    { subtitleOffset: 'fast' }, { subtitleOffset: NaN }, { subtitleOffset: Infinity },
    { subtitleOffset: null }, { subtitleOffset: [] }, { subtitleOffset: {} },
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
  if (typeof s.enabled !== 'boolean') throw new Error('enabled 沒有被轉成布林：' + typeof s.enabled);
  // holdMs 必須被丟掉。留著的話 main.js 用固定值、設定卻還帶著舊欄位，
  // 下一個人看到會以為它還有效——那是最容易寫出的一種 bug。
  if ('holdMs' in s) throw new Error('holdMs 應該已經不是設定項，卻仍出現在清洗結果中');

  // subtitleOffset 的夾值是**不對稱**的：延後 3 秒、提前 2 秒。
  // 這個不對稱一旦被寫成對稱，提前方向就會拿到超出校準精度的權限。
  const offCase = (v) => {
    sandbox.__onSettings({ settings: { newValue: { subtitleOffset: v } } }, 'local');
    return sandbox.__pitlingo.t.settings().subtitleOffset;
  };
  if (offCase(999999) !== 2000) throw new Error('subtitleOffset 正向沒有夾在 +2000：' + offCase(999999));
  if (offCase(-999999) !== -3000) throw new Error('subtitleOffset 負向沒有夾在 -3000：' + offCase(-999999));
  for (const junk of ['fast', NaN, Infinity, null, [], {}, undefined]) {
    const got = offCase(junk);
    if (got !== 0) throw new Error(`subtitleOffset 遇到 ${String(junk)} 應退回 0，實得 ${got}`);
  }
  sandbox.__onSettings({ settings: { newValue: {} } }, 'local');
});

step('字幕時機：播放中反覆亂調，且換影片必須回到預設', async () => {
  const api = sandbox.__pitlingo;

  // 前一個情境刻意推過壞掉的遠端設定，此刻的 site 可能沒有 contentIdPattern。
  // 這裡要驗的是換影片的行為，先把設定復原成正常的，否則測到的是別的東西。
  swResponder = () => ({
    ok: true,
    config: {
      version: 99,
      sites: [{
        host: 'f1tv.formula1.com',
        captionRoot: ['.tm-subtitle-region-container'],
        captionLabel: ['.tm-ui-subtitle-label'],
        contentIdPattern: '/detail/(\\d+)',
      }],
    },
    settings: {}, bundle: { lines: {} }, result: {}, text: '',
  });
  await api.t.reloadConfig().catch(() => {});
  await settle();

  videoEl = { paused: false, ended: false, readyState: 4, currentTime: 30,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }) };

  // 在延後與提前之間來回橫跳，每次都餵字幕。
  // 舊版切換時不會清掉已排程的延後計時器，兩種模式會有一小段同時活著。
  const seq = [-3000, 2000, -1500, 0, 2000, -3000, 1, -1, 0];
  for (const off of seq) {
    sandbox.__onSettings({ settings: { newValue: { subtitleOffset: off } } }, 'local');
    api.t.feed(`Timing test line at offset ${off} from the commentary`);
    advance(120);
    await settle();
  }
  advance(5000);            // 讓所有可能殘留的計時器都醒過來
  await settle();

  // 換影片：時機必須回到 0，而字級與位置必須原封不動。
  sandbox.__onSettings({ settings: { newValue: { subtitleOffset: -2500, fontSize: 40, bottomPct: 20 } } }, 'local');
  const before = api.t.settings();
  if (before.subtitleOffset !== -2500) throw new Error('前置條件不成立，設定沒吃進去');

  sandbox.location.pathname = '/detail/1000019999/timing-reset-check';
  advance(1600);            // 讓 checkContentChange 跑到
  await settle();

  const after = api.t.settings();
  if (after.subtitleOffset !== 0) throw new Error('換影片後字幕時機沒有回復預設：' + after.subtitleOffset);
  if (after.fontSize !== 40) throw new Error('換影片後字級被誤重設：' + after.fontSize);
  if (after.bottomPct !== 20) throw new Error('換影片後位置被誤重設：' + after.bottomPct);

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
