#!/usr/bin/env node
/**
 * 升級折抵的漏財檢查。
 *
 * ⚠️ 折抵是**唯一一條會把錢送出去**的路徑，而它的輸入
 *    （授權記錄的 `paid`、`plan`、`fromService`）來自好幾個地方，
 *    任何一處算錯都不會報錯，只會讓某些人少付錢。
 *
 * 第一次跑就抓到兩個實際的漏洞：
 *
 *   1. **代訂送的那一週被拿去折抵。**
 *      `fromService` 的檢查原本只做在「當證明用的那一張」上，
 *      沒有做在累加迴圈裡——只要手上有任何一張真的通行證當證明，
 *      代訂送的那幾張就全部被算進去。
 *
 *   2. **`paid` 記的是整張訂單的總價。**
 *      於是「代訂 1 年（4,599）+ 免費附贈的通行證」發出的通行證
 *      帶著 `paid = 4599`，日後升級時換到滿額折抵。
 *
 * 用法：node tools/check-credit.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// ⚠️ **一定要加 'use strict'。** 後端是 ESM（＝嚴格模式），但 vm.runInContext
//    跑的是 script（＝非嚴格）。差別會吃掉一整類 bug：對未宣告的變數賦值
//    在這裡只是建立一個全域，在真正的 Worker 上是 ReferenceError。
//    實際發生過——`let hasWeekPurchase` 被刪掉、`hasWeekPurchase = true` 留著，
//    node --check 與這裡的矩陣測試**全部放行**，直播頁面上才炸。
let src = "'use strict';\n" + fs.readFileSync(path.join(__dirname, '..', 'backend/src/index.js'), 'utf8')
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
vm.runInContext(src + '\n;this.__api={PLANS,weekCreditFor,quoteCart,gpList,gpId,gpStatus,'
  + 'gpWindow,seasonEndSec,UPGRADE_CREDIT_MAX};', ctx);
const A = sb.__api;

const store = new Map();
const env = { SUBS: {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true }),
} };

const NOW = Date.now();
const gps = A.gpList().filter((g) => A.gpStatus(g, NOW) !== 'finished');
let bad = 0;

const put = (key, lic) => store.set('lic:' + key, JSON.stringify(lic));
const mail = (m, keys) => store.set('licmail:' + m, JSON.stringify(keys));

(async () => {
  const w = A.gpWindow(gps[0]);
  console.log('折抵上限 NT$' + A.UPGRADE_CREDIT_MAX);

  /* --- 1. 代訂送的那一週不可以被拿去折抵 --- */
  {
    store.clear();
    const m = 'a@t.com';
    put('REALWEEK01', { plan: 'week', email: m, paid: 39, windows: [[w.from, w.until]], expiresAt: w.until, devices: [] });
    // 代訂送的那張，帶著整張訂單的金額
    put('GIFTWEEK01', { plan: 'week_svc', email: m, paid: 699, expiresAt: w.until, devices: [] });
    mail(m, ['REALWEEK01', 'GIFTWEEK01']);
    const c = await A.weekCreditFor(env, m, NOW, 'REALWEEK01');
    const ok = !c.keys.includes('GIFTWEEK01') && c.credit === 39;
    if (!ok) bad++;
    console.log('\n1. 真通行證 + 代訂贈送的一週');
    console.log('   ' + (ok ? '✅' : '❌') + ' 折抵 NT$' + c.credit
      + '　認列 ' + c.keys.length + ' 張' + (ok ? '（只認真的那張）' : '　← 代訂送的被算進去了'));
  }

  /* --- 2. 新發出的授權，paid 只能記通行證那幾行 --- */
  {
    console.log('\n2. 授權記錄的 paid 只算通行證那幾行');
    const cases = [
      [[{ key: 'week', gp: A.gpId(gps[0]), qty: 1 }], 39, '單買一張'],
      [[{ key: 'week', gp: A.gpId(gps[0]), qty: 1 }, { key: 'week', gp: A.gpId(gps[1]), qty: 1 }], 78, '兩張'],
      // ⚠️ **附贈那幾列的 sum 是 0，所以自動不計入。**
      //    這是把附贈做成商品列（而不是折抵）換來的：不必再去追
      //    「哪一筆折抵折的是通行證」。付費那張仍然實付 39。
      [[{ key: 'week', gp: A.gpId(gps[0]), qty: 1 },
        { key: 'svc_prem_1y_own', qty: 1, gifts: [A.gpId(gps[1]), A.gpId(gps[2]), A.gpId(gps[3])] }], 39,
      '代訂 1 年（附贈 3 張）+ 自費 1 張'],
      [[{ key: 'svc_prem_1y_own', qty: 1, gifts: [A.gpId(gps[0]), A.gpId(gps[1]), A.gpId(gps[2])] }], 0,
        '只買代訂（附贈 3 張全免費）'],
      [[{ key: 'svc_prem_1m_own', qty: 3, gifts: [A.gpId(gps[0]), A.gpId(gps[2]), A.gpId(gps[4])] },
        { key: 'week', gp: A.gpId(gps[1]), qty: 1 }, { key: 'week', gp: A.gpId(gps[3]), qty: 1 }], 78,
      '代訂 1 月 ×3（附贈 3 張）+ 自費 2 張'],
    ];
    for (const [items, want, why] of cases) {
      const r = await A.quoteCart(env, items, {});
      if (r.error) { bad++; console.log('   ⛔ ' + why + '：' + r.error); continue; }
      const ok = r.weekPaid === want;
      if (!ok) bad++;
      console.log('   ' + (ok ? '✅' : '❌') + ' ' + why.padEnd(34)
        + '訂單 NT$' + String(r.total).padEnd(6) + ' 通行證實付 NT$' + r.weekPaid
        + (ok ? '' : '（應為 ' + want + '）'));
    }
  }

  /* --- 3. 正常購買仍然折得到，而且夾在上限 --- */
  {
    store.clear();
    const m = 'c@t.com';
    const ks = [];
    for (let i = 0; i < 3; i++) {
      const gw = A.gpWindow(gps[i]);
      const k = 'NORMAL0000' + i;
      ks.push(k);
      put(k, { plan: 'week', email: m, paid: 39, windows: [[gw.from, gw.until]], expiresAt: gw.until, devices: [] });
    }
    mail(m, ks);
    const c = await A.weekCreditFor(env, m, NOW, ks[0]);
    const ok = c.credit === Math.min(117, A.UPGRADE_CREDIT_MAX);
    if (!ok) bad++;
    console.log('\n3. 正常買三張（各 39 元）');
    console.log('   ' + (ok ? '✅' : '❌') + ' 折抵 NT$' + c.credit + '（夾在上限）');
  }

  /* --- 4. 別人的授權碼不能當證明 --- */
  {
    store.clear();
    const m = 'd@t.com';
    put('MINE000001', { plan: 'week', email: m, paid: 39, expiresAt: w.until, devices: [] });
    put('THEIRS0001', { plan: 'week', email: 'other@t.com', paid: 39, expiresAt: w.until, devices: [] });
    mail(m, ['MINE000001']);
    const c = await A.weekCreditFor(env, m, NOW, 'THEIRS0001');
    const ok = c.credit === 0;
    if (!ok) bad++;
    console.log('\n4. 拿別人的授權碼當證明');
    console.log('   ' + (ok ? '✅ 被拒（' + c.reason + '）' : '❌ 竟然折抵了 NT$' + c.credit));
  }

  console.log('');
  console.log(bad ? ('❌ ' + bad + ' 項未通過') : '✅ 折抵沒有漏財');
  process.exit(bad ? 1 : 0);
})();
