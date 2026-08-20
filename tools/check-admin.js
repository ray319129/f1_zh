#!/usr/bin/env node
/**
 * 後台的靜態一致性檢查。
 *
 * 後台是單一 HTML 檔，沒有建置步驟，所以任何拼錯都要到「點下去沒反應」
 * 才會發現——而後台是客服操作的地方，出錯的代價是使用者權益。
 *
 * 檢查三件事：
 *   1. JS 取用的 id 都存在（`$('xx')` 打錯 → null.onclick 才炸）
 *   2. 每個管理端點都真的被呼叫（後端做了但前端沒接 = 等於沒做，
 *      這件事實際發生過：`handleLicensePatch` 支援換方案但 UI 沒有選單）
 *   3. 危險操作一定要有二次確認（刪除、停用不可逆或影響使用者）
 *
 * 用法：node tools/check-admin.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'legal/admin.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'backend/src/index.js'), 'utf8');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 0. JS 必須能執行 -------------------------------------------------------
// **這是最重要的一項。** 後台是單一 HTML，一個語法錯誤就讓整段 script 不執行，
// 於是每個按鈕都沒反應——而瀏覽器只在 Console 留一行紅字，
// 從畫面上完全看不出來「壞掉」與「還沒載入」的差別。
//
// 實際踩過：用腳本插入程式碼時，換行跳脫被吃掉變成真的換行，
// 單引號字串因此跨行 → 整個後台變成靜態頁面，所有按鈕都沒反應。
{
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) bad('後台找不到 <script> 區塊');
  else {
    try { new (require('vm').Script)(m[1]); ok('後台 JS 語法正確（整段可執行）'); }
    catch (e) { bad(`後台 JS 有語法錯誤，整段不會執行、所有按鈕都沒反應：${e.message}`); }
  }
}

// --- 1. id 一致性 ---------------------------------------------------------
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((i) => !ids.has(i));
missing.length
  ? bad(`後台取用了不存在的 id：${missing.join('、')} —— 那些按鈕會完全沒反應`)
  : ok(`${used.size} 個 id 都存在`);

// --- 2. 每個管理端點都要有人用 ---------------------------------------------
// 後端做了但前端沒接，等於沒做。這正是「後台改方案」那次的情況。
const endpoints = [...api.matchAll(/path === '(\/v1\/admin\/[^']+)'/g)].map((m) => m[1]);
const unused = [...new Set(endpoints)].filter((e) => !html.includes(e));
unused.length
  ? bad(`後端有這些管理端點但後台沒有用到：${unused.join('、')} —— 做了等於沒做`)
  : ok(`${new Set(endpoints).size} 個管理端點都有對應的 UI`);

// --- 3. 危險操作必須有二次確認 ---------------------------------------------
// 刪除與停用都會影響使用者權益，誤點的代價是真實的。
// 用「動作關鍵字」定位，而不是端點——同一個端點可能同時有安全與危險的用法
// （reports/patch 既是標記已解決，也是刪除工單）。
const DANGEROUS = [
  [/永久刪除/, '刪除授權碼'],
  [/小時內失去存取權/, '停用授權碼'],
  [/刪除這張工單/, '刪除工單'],
  [/的所有裝置/, '清空裝置'],
];
let confirmed = 0;
for (const [pat, label] of DANGEROUS) {
  const m = html.match(pat);
  if (!m) { bad(`找不到 ${label} 的操作`); continue; }
  const i = html.indexOf(m[0]);
  const around = html.slice(Math.max(0, i - 200), i + 200);
  if (/confirm\(/.test(around)) confirmed++;
  else bad(`${label} 沒有二次確認 —— 誤點會直接影響使用者`);
}
confirmed === DANGEROUS.length && ok(`${confirmed} 個危險操作都有二次確認`);

// --- 4. 方案與價格一律由伺服器提供，後台不可以自己寫一份 ---------------------
//
// 舊版是把方案選項寫死在 HTML 裡，並用「寫死的名稱都存在於後端」來把關。
// 那個把關擋不住真正發生的事：定價從「早鳥 399／正式 599」改成
// 「上半季 599／下半季 299／一週 39」之後，**名稱依然存在**，
// 所以檢查照樣通過，而後台還在發早鳥碼——賣的東西與網站上的是兩套。
//
// 所以現在反過來檢查：後台**不准**出現寫死的方案選項或價格。
const planBlock = api.match(/const PLANS = \{([\s\S]*?)\n\};/)[1];
const backendPlans = [...planBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

const hardPlan = [...html.matchAll(/<option value="([a-z_0-9]+)"/g)]
  .map((m) => m[1]).filter((k) => backendPlans.includes(k));
hardPlan.length
  ? bad(`後台把方案寫死在 HTML 裡：${[...new Set(hardPlan)].join('、')} —— 改價之後會靜默漂掉`)
  : ok('後台沒有寫死任何方案選項');

// 價格同理。任何 NT$ 後面直接跟數字都是寫死的價格。
const hardPrice = [...html.matchAll(/NT\$\s?[0-9][0-9,]*/g)].map((m) => m[0]);
hardPrice.length
  ? bad(`後台寫死了價格：${[...new Set(hardPrice)].join('、')} —— 應該由 /v1/admin/plans 提供`)
  : ok('後台沒有寫死任何價格');

html.includes('/v1/admin/plans')
  ? ok(`方案下拉由伺服器提供（後端目前有 ${backendPlans.length} 個方案）`)
  : bad('後台沒有向 /v1/admin/plans 取方案 —— 下拉一定是寫死的');

// --- 4b. 訂單狀態要與後端的狀態機一致 ---------------------------------------
// 後端多一個狀態而後台沒有對應標籤時，畫面會直接顯示英文代碼，
// 而那看起來只像是「有一筆奇怪的訂單」，不像是漏了東西。
{
  const rank = api.match(/const ORDER_RANK = \{([^}]*)\}/);
  if (!rank) bad('後端找不到 ORDER_RANK —— 訂單狀態機不見了');
  else {
    const states = [...rank[1].matchAll(/(\w+):/g)].map((m) => m[1]);
    const labels = html.match(/const OR_LABEL = \{([^}]*)\}/);
    if (!labels) bad('後台找不到 OR_LABEL —— 訂單狀態會顯示成英文代碼');
    else {
      const have = [...labels[1].matchAll(/(\w+):/g)].map((m) => m[1]);
      const miss = states.filter((x) => !have.includes(x));
      miss.length
        ? bad(`後台沒有這些訂單狀態的中文標籤：${miss.join('、')}`)
        : ok(`${states.length} 個訂單狀態都有中文標籤`);
    }
  }
}

// --- 5. 不可以把 ADMIN_TOKEN 存進 localStorage ------------------------------
/localStorage[^\n]*(tok|token)/i.test(html)
  ? bad('後台把權杖存進 localStorage —— 任何能碰到這台電腦的人都拿得到管理權限')
  : ok('權杖只留在分頁記憶體，沒有寫入儲存空間');

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 後台與後端完全對得起來');
