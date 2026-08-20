#!/usr/bin/env node
/**
 * 直播多人同時觀看的並發模擬。
 *
 * **存在的理由**：直播是這個專案最大的未知數（AUDIT 的 U1），而它最貴的
 * 失敗模式——「N 個觀眾同時送同一批句子去翻，付 N 倍的錢」——
 * 需要多個使用者才會發生，而開發者只有一台電腦。
 *
 * 這支不需要第二台電腦，也不需要真的直播：直接把 `handleTranslate` 載進來，
 * 用假的 KV 與假的模型，讓 N 個請求**同時**打同一批句子，然後數
 * **模型實際被呼叫幾次**。那個數字就是成本倍率。
 *
 * 判定：
 *   1. 非急件（前瞻預譯）：N 個並發只該有 1 次模型呼叫
 *   2. 急件（畫面上就要用）：**不可以讓路**，每個人都要拿到譯文
 *   3. 讓路的人一定要拿得到 `pendingElsewhere`，不能靜靜地回空的
 *   4. 認領機制壞掉時要放行（降級成重複翻），不可以變成沒有字幕
 *
 * 用法：node tools/check-live-concurrency.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m + (d ? '：' + d : '')); console.log('❌ ' + m + (d ? '：' + d : '')); };

let src = fs.readFileSync(path.join(root, 'backend/src/index.js'), 'utf8');
// ⚠️ 兩種 export 都要剝：`export default {...}`（Worker 入口）
//    與 `export class SubtitleRoom`（Durable Object）。
//    只剝前者的話，沙箱會在 `export class` 那行語法錯誤——
//    而錯誤訊息指向的是 index.js 的行號，看起來像後端壞掉。
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

// --- 假環境 ---------------------------------------------------------------
let modelCalls = 0;                 // ← 這個數字就是成本倍率
const kv = new Map();
const cacheStore = new Map();

function makeSandbox(opts) {
  const o = opts || {};
  const sandbox = {
    crypto: require('crypto').webcrypto,
    TextEncoder, TextDecoder, btoa, atob,
    Response: class {
      constructor(b, i) { this.body = b; Object.assign(this, i || {}); }
      async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    },
    Request: class {},
    URL, console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
    // Cache API：認領機制用的。`broken` 模式用來驗降級行為。
    caches: o.broken ? undefined : {
      default: {
        async match(u) { return cacheStore.has(u) ? { ok: true } : undefined; },
        async put(u) { cacheStore.set(u, 1); },
      },
    },
    // 模型：每次呼叫就記一筆。這是整支測試的核心量測。
    fetch: async (url, init) => {
      if (String(url).includes('anthropic')) {
        modelCalls++;
        const body = JSON.parse(init.body);
        const text = JSON.stringify(body.messages || body);
        // 回應格式必須與 `translateBatch` 的解析一致：「N. 譯文」每行一句。
        // 格式不對的話，模型呼叫次數量得到，但「有沒有拿到譯文」全部是 0，
        // 那些斷言就變成量不到東西——**測試看起來在跑，其實什麼都沒驗**。
        const nums = [...text.matchAll(/(\d+)\.\s/g)].map((m) => Number(m[1]));
        const n = nums.length ? Math.max(...nums) : 1;
        const out = Array.from({ length: n }, (_, i) => `${i + 1}. 中文譯文${i + 1}`).join('\n');
        return {
          ok: true, status: 200,
          async json() {
            return { content: [{ text: out }], usage: { input_tokens: 10, output_tokens: 10 } };
          },
        };
      }
      throw new Error('未預期的網路呼叫：' + url);
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

const sandbox = makeSandbox({});
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { handleTranslate, SubtitleRoom };', sandbox);
const A = sandbox.__api;

/**
 * 假的 Durable Object namespace。
 *
 * 真的 DO 是單執行緒的——同一個 id 的請求會排隊。這裡用一條 Promise 鏈
 * 重現那個特性：**每個請求都要等前一個做完才開始**。
 * 不模擬排隊的話這支測試會通過，但線上仍然會 race。
 */
function makeRoomNamespace(Cls, env) {
  const rooms = new Map();
  return {
    idFromName: (n) => ({ name: n, toString: () => n }),
    get(id) {
      const key = String(id.name);
      if (!rooms.has(key)) {
        rooms.set(key, { inst: new Cls({ storage: new Map() }, env), queue: Promise.resolve() });
      }
      const r = rooms.get(key);
      return {
        fetch(url, init) {
          // 排隊：DO 一次只處理一個請求
          const next = r.queue.then(() => r.inst.fetch({
            async json() { return JSON.parse(init.body); },
          }));
          r.queue = next.catch(() => {});
          return next;
        },
      };
    },
  };
}

const env = {
  TOKEN_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'sk-test', DAILY_USD_CAP: '999',
  SUBS: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  },
};
// DO binding。名稱要與 wrangler.toml 的 `name = "ROOM"` 一致。
env.ROOM = makeRoomNamespace(A.SubtitleRoom, env);

// 已授權的安裝，避免免費層額度干擾這裡要量的東西
const auth = { ok: true, installId: 'test-install', legacy: true };

function req(body) {
  return {
    headers: { get: () => null },
    async json() { return body; },
  };
}

const LINES = ['Box box box Max', 'He is closing in fast', 'That is a great move'];

async function fire(n, urgent) {
  modelCalls = 0;
  kv.clear();
  cacheStore.clear();
  // **同時**送出，不 await 前一個 —— 這正是直播現場會發生的事
  const rs = await Promise.all(Array.from({ length: n }, (_, i) =>
    A.handleTranslate(req({ cid: 'live-race', lines: LINES, urgent }), env, '1.2.3.4',
      { ...auth, installId: 'install-' + i })));
  const bodies = await Promise.all(rs.map((r) => r.json()));
  return { calls: modelCalls, bodies };
}

(async () => {
  console.log('──── 10 位觀眾同時看同一場直播 ────\n');

  // 1. 前瞻預譯：應該只有一個人真的去翻
  {
    const { calls, bodies } = await fire(10, false);
    const yielded = bodies.filter((b) => b && b.pendingElsewhere).length;
    console.log(`   前瞻預譯（非急件）：模型呼叫 ${calls} 次，${yielded}/10 位讓路`);
    calls <= 2
      ? ok(`並發去重有效：10 位觀眾只花了 ${calls} 次翻譯的錢`)
      : fail(`並發去重失效：10 位觀眾花了 ${calls} 次的錢 —— 成本會隨在線人數等比放大`, '');
    yielded >= 8
      ? ok('讓路的人有拿到 pendingElsewhere（用戶端才知道要去讀快取）')
      : fail('讓路的人沒有收到提示，會以為那些句子沒有譯文', `只有 ${yielded} 位`);
  }

  // 2. 急件：**絕對不能讓路**
  //    直播字幕 3~4 秒換一句，讓路的人等回來時畫面早就換過了。
  {
    const { calls, bodies } = await fire(10, true);
    const yielded = bodies.filter((b) => b && b.pendingElsewhere).length;
    const gotAll = bodies.filter((b) => b && b.lines && Object.keys(b.lines).length === LINES.length).length;
    console.log(`   DOM 逐句（急件）　：模型呼叫 ${calls} 次，${yielded}/10 位讓路，${gotAll}/10 位拿到全部譯文`);
    yielded === 0
      ? ok('急件完全不讓路（畫面上正在顯示的句子不能等）')
      : fail('急件被要求讓路 —— 那些人的字幕會直接消失', `${yielded} 位`);
    gotAll === 10
      ? ok('10 位觀眾都拿到了完整譯文')
      : fail('有人沒拿到譯文', `只有 ${gotAll}/10`);
  }

  // 3. 認領機制壞掉時要降級成「重複翻」，不可以變成「沒有字幕」
  {
    const s2 = makeSandbox({ broken: true });
    vm.createContext(s2);
    vm.runInContext(src + '\n;this.__api = { handleTranslate };', s2);
    modelCalls = 0; kv.clear();
    const rs = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      s2.__api.handleTranslate(req({ cid: 'live-race', lines: LINES, urgent: false }), env, '1.2.3.4',
        { ...auth, installId: 'x-' + i })));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    const gotAll = bodies.filter((b) => b && b.lines && Object.keys(b.lines).length === LINES.length).length;
    console.log(`   Cache API 不可用　：${gotAll}/3 位仍拿到完整譯文`);
    gotAll === 3
      ? ok('認領機制不可用時放行（降級成多花錢，不是沒有字幕）')
      : fail('認領機制故障導致使用者拿不到字幕 —— 省錢的機制不可以製造功能性故障', `${gotAll}/3`);
  }

  console.log(errors.length ? `\n❌ ${errors.length} 項未通過` : '\n✅ 直播並發行為全部符合預期');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('❌ 測試本身出錯：' + e.message); process.exit(1); });
