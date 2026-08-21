#!/usr/bin/env node
/**
 * 方案組合矩陣。
 *
 * 把**每一個方案單買、每兩個方案搭配、以及各種數量與跳著買**都跑一遍，
 * 檢查金額、主方案、效期、比賽週區間有沒有算錯。
 *
 * 為什麼需要：方案之間會互相影響（折抵、附贈、區間、主方案的選法），
 * 而那些交互作用**沒有一個會報錯**——只會讓某個組合收錯錢或發錯授權。
 * 第一次跑就抓到兩個實際會收錯錢的 bug：
 *
 *   1. **賽季票 + 比賽週通行證 → 賽季票被截成一週。**
 *      授權帶著比賽週的區間，而續期只簽到「現在這一段」的結束。
 *      客人付了 NT$338 買一整季，拿到的是兩週，比賽週之外完全不能用。
 *
 *   2. **同一場買兩次收兩次錢**，但區間合併後只有一段——第二筆是純損失。
 *
 * 用法：node tools/check-plan-matrix.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'backend/src/index.js'), 'utf8')
  .replace(/export default \{[\s\S]*?\n\};\r?\n/, '')
  .replace(/\bexport\s+class\s+/g, 'class ');
const sb = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
  Request: class {}, URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Array, Object, String, Number, Boolean, setTimeout, clearTimeout, parseInt, parseFloat,
  isNaN, fetch: () => {}, Intl,
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + '\n;this.__api={PLANS,quoteCart,gpList,gpId,gpWindow,gpStatus,planExpiry,'
  + 'entitlementUntil,currentWindow,seasonPriceNow,planPrice,opsConfig,mergeWindows,racesLeft};', ctx);
const A = sb.__api;

const store = new Map();
const env = { SUBS: {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true }),
} };

const NOW = Date.now();
const gps = A.gpList().filter((g) => A.gpStatus(g, NOW) !== 'finished').map((g) => A.gpId(g));
const GP1 = gps[0], GP2 = gps[1], GP3 = gps[2], GPLAST = gps[gps.length - 1];

const problems = [];
const P = (sev, what, detail) => problems.push({ sev, what, detail });

const money = (n) => 'NT$' + n;
async function q(items, opts) { return A.quoteCart(env, items, opts || {}); }

/** 用購物車模擬 webhook 會發出什麼樣的授權，然後檢查它合不合理 */
function simulateLicense(quote) {
  const plan = quote.primary;
  const wins = quote.windows || [];
  return {
    plan,
    windows: wins.length ? wins : null,
    expiresAt: wins.length ? Math.max(...wins.map((w) => w[1])) : A.planExpiry(plan),
    startsAt: wins.length ? Math.min(...wins.map((w) => w[0])) : null,
  };
}

(async () => {
  const sellable = Object.entries(A.PLANS)
    .filter(([, v]) => v.price > 0 && !v.internal)
    .map(([k]) => k);
  console.log('可販售方案：' + sellable.join('、'));
  console.log('可購買場次：' + gps.length + ' 場（' + GP1 + ' … ' + GPLAST + '）\n');

  const needGp = (k) => A.PLANS[k].weekBound || A.PLANS[k].svcWeekend;
  const item = (k, gp, qty) => (needGp(k) ? { key: k, gp: gp || GP1, qty: qty || 1 } : { key: k, qty: qty || 1 });

  /* ---------- 1. 每一個方案單買 ---------- */
  console.log('── 單買 ──');
  for (const k of sellable) {
    const r = await q([item(k)]);
    if (r.error) { const locked = A.PLANS[k].nextSeasonOnly;
      if (!locked) P('高', '單買 ' + k + ' 失敗', r.error);
      console.log('  ' + (locked ? '🔒' : '❌') + ' ' + k + '：' + r.error); continue; }
    const lic = simulateLicense(r);
    const days = lic.expiresAt ? ((lic.expiresAt - NOW / 1000) / 86400).toFixed(1) : '—';
    console.log('  ✅ ' + k.padEnd(16) + money(r.total).padEnd(9)
      + ' 主方案 ' + String(lic.plan).padEnd(12) + ' 效期 ' + days + ' 天');
    if (r.total !== A.PLANS[k].price && !A.PLANS[k].untilSeasonEnd) {
      P('高', k + ' 的金額與牌價不符', r.total + ' vs ' + A.PLANS[k].price);
    }
    if (lic.expiresAt == null) P('高', k + ' 算出「無期限」授權', 'expiresAt = null');
  }

  /* ---------- 2. 兩兩搭配 ---------- */
  console.log('\n── 兩兩搭配 ──');
  for (let i = 0; i < sellable.length; i++) {
    for (let j = i + 1; j < sellable.length; j++) {
      const a = sellable[i], b = sellable[j];
      // 兩個都要指定場次時，用不同場次比較有代表性
      const items = [item(a, GP1), item(b, needGp(b) ? GP2 : undefined)];
      const r = await q(items);
      if (r.error) { console.log('  ⛔ ' + a + ' + ' + b + '：' + r.error); continue; }
      const lic = simulateLicense(r);
      const sum = items.reduce((n, it) => n + (A.PLANS[it.key].untilSeasonEnd
        ? A.seasonPriceNow(A.PLANS[it.key].price).price : A.PLANS[it.key].price) * it.qty, 0);
      const adj = (r.adjustments || []).reduce((n, x) => n + x.amount, 0);
      if (r.total !== sum + adj) {
        P('高', a + ' + ' + b + ' 金額對不上', r.total + ' ≠ ' + sum + ' + ' + adj);
      }
      // **關鍵檢查**：主方案是賽季票時，授權不可以被綁進比賽週區間
      const isSeason = A.PLANS[lic.plan] && A.PLANS[lic.plan].untilSeasonEnd;
      if (isSeason && lic.windows) {
        P('高', a + ' + ' + b + '：賽季票被綁進比賽週區間',
          '主方案 ' + lic.plan + '，但 windows 有 ' + lic.windows.length + ' 段');
      }
      if (isSeason) {
        const seasonEnd = A.planExpiry(lic.plan);
        if (lic.expiresAt && seasonEnd && lic.expiresAt < seasonEnd - 86400) {
          P('高', a + ' + ' + b + '：賽季票的效期被截短',
            new Date(lic.expiresAt * 1000).toISOString().slice(0, 10)
            + ' 而不是 ' + new Date(seasonEnd * 1000).toISOString().slice(0, 10));
        }
      }
      console.log('  ' + (isSeason && lic.windows ? '⚠️' : '✅') + ' '
        + (a + ' + ' + b).padEnd(36) + money(r.total).padEnd(9)
        + ' 主 ' + String(lic.plan).padEnd(12)
        + (r.adjustments && r.adjustments.length ? ' 折抵 ' + adj : ''));
    }
  }

  /* ---------- 3. 數量與折抵 ---------- */
  console.log('\n── 數量與折抵 ──');
  {
    const r = await q([{ key: 'svc_prem_1m_own', qty: 3 }, item('week', GP1)]);
    const adj = (r.adjustments || []).reduce((n, x) => n + x.amount, 0);
    console.log('  代訂×3（附贈 3 週）+ 通行證×1　總計 ' + money(r.total) + '　折抵 ' + adj);
    if (adj !== -39) P('中', '代訂買三份只折抵一次', '折抵 ' + adj + '，但附贈了 3 個比賽週');
  }
  {
    const r = await q([{ key: 'svc_prem_1m_own', qty: 1 },
      item('week', GP1), item('week', GP2), item('week', GP3)]);
    const adj = (r.adjustments || []).reduce((n, x) => n + x.amount, 0);
    console.log('  代訂×1（附贈 1 週）+ 通行證×3　總計 ' + money(r.total) + '　折抵 ' + adj);
    if (adj !== -39) P('中', '一份代訂折抵了不只一週', String(adj));
  }

  /* ---------- 4. 多張比賽週通行證 ---------- */
  console.log('\n── 多張通行證 ──');
  {
    const r = await q([item('week', GP1), item('week', GP2), item('week', GP3)]);
    const lic = simulateLicense(r);
    console.log('  連續三場　' + money(r.total) + '　區間 ' + (r.windows || []).length + ' 段');
    if (r.total !== 117) P('高', '三場的金額不對', String(r.total));
    if ((r.windows || []).length !== 1) P('中', '連續三場沒有合併成一段', JSON.stringify(r.windows));
  }
  {
    const r = await q([item('week', GP1), item('week', GPLAST)]);
    console.log('  跳著買（第一場 + 最後一場）　' + money(r.total) + '　區間 ' + (r.windows || []).length + ' 段');
    if ((r.windows || []).length !== 2) P('高', '跳著買沒有產生兩段區間', JSON.stringify(r.windows));
  }
  {
    const r = await q([item('week', GP1), item('week', GP1)]);
    console.log('  同一場買兩次　' + money(r.total) + '　列數 ' + r.lines.length
      + '　區間 ' + (r.windows || []).length + ' 段');
    if (r.total > 39) P('高', '同一場買兩次收了兩次錢', money(r.total) + '（應為 NT$39 或直接拒絕）');
  }

  /* ---------- 5. 賽季票 + 通行證：真正該檢查的 ---------- */
  console.log('\n── 賽季票 + 通行證 ──');
  {
    const r = await q([{ key: 'season', qty: 1 }, item('week', GP2)]);
    const lic = simulateLicense(r);
    const seasonEnd = A.planExpiry('season');
    console.log('  賽季票 + 一場通行證　' + money(r.total));
    console.log('    主方案 ' + lic.plan
      + '　效期 ' + (lic.expiresAt ? new Date(lic.expiresAt * 1000).toISOString().slice(0, 10) : '—')
      + '（賽季票應為 ' + new Date(seasonEnd * 1000).toISOString().slice(0, 10) + '）');
    console.log('    windows：' + (lic.windows ? lic.windows.length + ' 段' : '無'));
    if (lic.windows) {
      // 現在若不在那一段裡，整張賽季票會被擋
      const inWin = A.currentWindow(lic.windows, NOW);
      console.log('    現在落在區間內？' + (inWin ? '是' : '**否 → 整張賽季票會被擋下**'));
    }
  }

  /* ---------- 6. 不該成立的組合 ---------- */
  console.log('\n── 不該成立的 ──');
  const bad = [
    [[{ key: 'week', qty: 1 }], '通行證沒指定場次'],
    [[{ key: 'svc_pro_5d', qty: 1 }], '共用帳號代訂沒指定場次'],
    [[{ key: 'week_svc', gp: GP1, qty: 1 }], '內部方案 week_svc'],
    [[{ key: 'svc_none', qty: 1 }], '內部方案 svc_none'],
    [[{ key: 'trial', qty: 1 }], '免費層 trial'],
    [[{ key: 'comp', qty: 1 }], '客服補償 comp'],
    [[{ key: 'season_next', qty: 1 }], '尚未開放的下一賽季票'],
    [[{ key: '不存在的方案', qty: 1 }], '不存在的方案'],
  ];
  for (const [items, why] of bad) {
    const r = await q(items);
    console.log('  ' + (r.error ? '✅ 擋下' : '❌ 竟然放行') + '　' + why
      + (r.error ? '' : '　→ ' + money(r.total)));
    if (!r.error) P('高', '應該擋下卻放行：' + why, JSON.stringify(items));
  }

  /* ---------- 結果 ---------- */
  console.log('\n════════ 問題彙總 ════════');
  if (!problems.length) console.log('沒有發現問題');
  else problems.forEach((p, i) => console.log((i + 1) + '. [' + p.sev + '] ' + p.what + '\n      ' + p.detail));
  process.exit(problems.some((p) => p.sev === '高') ? 1 : 0);
})();
