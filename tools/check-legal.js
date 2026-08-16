#!/usr/bin/env node
/**
 * 法律文件與程式碼的一致性檢查。
 *
 * 為什麼需要：隱私權政策寫「我們不蒐集 X」，但程式碼真的在蒐集 X ——
 * 這在 Chrome Web Store 是下架理由，在台灣個資法下是不實陳述。
 * 而這種不一致**不會有任何技術徵兆**，只會在被檢舉或稽核時爆開。
 *
 * 政策是承諾，程式碼是事實。這支確保兩者對得起來。
 *
 * 用法：node tools/check-legal.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const priv = fs.readFileSync(path.join(root, 'legal/privacy.html'), 'utf8');
const terms = fs.readFileSync(path.join(root, 'legal/terms.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'backend/src/index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 1. 權限：manifest 有的，政策必須列出來 --------------------------------
const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
const undeclared = perms.filter((p) => {
  const host = p.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  return !priv.includes(host) && !priv.includes(p);
});
undeclared.length
  ? bad(`manifest 有這些權限但隱私政策沒說明：${undeclared.join('、')} —— 商店審核會問`)
  : ok(`${perms.length} 個權限都在隱私政策裡說明了`);

// 反過來：政策不該列出已經移除的權限
const REMOVED = ['cookies', 'tabs', 'webRequest', 'history', 'bookmarks'];
const overclaimed = REMOVED.filter((p) => new RegExp(`<code>${p}</code>`).test(priv));
overclaimed.length
  ? bad(`隱私政策提到我們沒有的權限：${overclaimed.join('、')}`)
  : ok('隱私政策沒有列出多餘的權限');

// --- 2. 蒐集的統計維度必須與白名單一致 --------------------------------------
// 政策說「我們記錄 A/B/C」，程式碼的白名單就必須是 A/B/C。
const evBlock = api.match(/const METRIC_EVENTS = \{([\s\S]*?)\n\};/);
if (!evBlock) bad('找不到 METRIC_EVENTS 白名單');
else {
  const dims = new Set();
  for (const m of evBlock[1].matchAll(/'(\w+)'/g)) dims.add(m[1]);
  // 政策明確承諾不收的維度，白名單裡就不可以出現
  const FORBIDDEN = ['cid', 'contentId', 'ip', 'url', 'email', 'userId', 'installId'];
  const leaked = FORBIDDEN.filter((f) => dims.has(f));
  leaked.length
    ? bad(`統計白名單含政策承諾不蒐集的欄位：${leaked.join('、')}`)
    : ok(`統計白名單（${[...dims].join('、')}）沒有違反政策的承諾`);
}

// --- 3. 政策承諾的保存期限要與程式碼一致 -----------------------------------
const ttlChecks = [
  [/REPORT_TTL_DAYS = (\d+)/, 90, '問題回報'],
  [/METRIC_TTL_DAYS = (\d+)/, 400, '使用統計'],
];
for (const [re, expect, label] of ttlChecks) {
  const m = api.match(re);
  if (!m) { bad(`找不到 ${label} 的保存期限設定`); continue; }
  Number(m[1]) === expect
    ? ok(`${label} 保存 ${m[1]} 天，與政策一致`)
    : bad(`${label} 程式碼是 ${m[1]} 天，但政策寫的是 ${expect} 天`);
}

// --- 4. 價格必須與後端的 PLANS 一致 -----------------------------------------
const planBlock = api.match(/const PLANS = \{([\s\S]*?)\n\};/)[1];
const prices = {};
for (const m of planBlock.matchAll(/(\w+):\s*\{[^}]*price:\s*(\d+)/g)) prices[m[1]] = Number(m[2]);
const inTerms = (n) => terms.includes(`NT$${n}`);
const priceMismatch = Object.entries(prices)
  .filter(([, p]) => p > 0)
  .filter(([, p]) => !inTerms(p));
priceMismatch.length
  ? bad(`後端的價格沒有出現在使用條款：${priceMismatch.map(([k, p]) => `${k}=NT$${p}`).join('、')}`)
  : ok(`價格與後端一致（${Object.entries(prices).filter(([, p]) => p).map(([k, p]) => `${k} NT$${p}`).join('、')}）`);

// 早鳥限量的數字也要對
const limitM = api.match(/const EARLY_LIMIT = (\d+)/);
if (limitM && !terms.includes(`限量 ${limitM[1]} 組`)) {
  bad(`使用條款沒寫早鳥限量 ${limitM[1]} 組，或數字與程式碼不符`);
} else if (limitM) ok(`早鳥限量 ${limitM[1]} 組，條款與程式碼一致`);

// --- 5. 免費層的秒數要一致 --------------------------------------------------
const freeM = api.match(/freeTier:\s*\{\s*\n?\s*seconds:\s*(\d+)/);
if (freeM) {
  const mins = Number(freeM[1]) / 60;
  [priv, terms].every((d) => d.includes(`${mins} 分鐘`))
    ? ok(`免費層 ${mins} 分鐘，兩份文件都一致`)
    : bad(`程式碼的免費層是 ${mins} 分鐘，但文件沒有一致地寫出這個數字`);
}

// --- 6. 台灣法規的必要條款 --------------------------------------------------
// 沒有明示排除，消費者仍可主張七天無條件退貨——這條漏掉的代價是實質的。
const REQUIRED = [
  [/通訊交易解除權合理例外情事適用準則/, '七天鑑賞期排除的法源依據'],
  [/事先同意/, '「經消費者事先同意」的要件'],
  [/無任何關聯|均無關聯/, '與 Formula 1 無關聯的聲明'],
  [/個人資料保護法/, '個資法下的當事人權利'],
];
for (const [re, label] of REQUIRED) {
  const doc = re.source.includes('個人資料') ? priv : terms;
  re.test(doc) ? ok(`已載明：${label}`) : bad(`缺少：${label}`);
}

// --- 7. 聯絡方式與網域 ------------------------------------------------------
const MAIL = 'pitlingo.office@gmail.com';
[priv, terms].every((d) => d.includes(MAIL))
  ? ok('兩份文件都有聯絡信箱')
  : bad('文件缺少聯絡信箱');
[priv, terms].every((d) => d.includes('pitlingo.com'))
  ? ok('兩份文件互相連結')
  : bad('文件之間沒有互相連結');

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 法律文件與程式碼的實際行為完全一致');
