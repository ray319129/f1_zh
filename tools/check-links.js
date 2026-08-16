#!/usr/bin/env node
/**
 * 網站與擴充功能裡所有超連結的檢查。
 *
 * 為什麼需要：法律文件的網址會填進 Chrome Web Store 的審核欄位，
 * 連結壞掉 = 審核直接失敗。而「連結壞掉」在本機完全看不出來——
 * HTML 不會因為 href 指錯而報錯。
 *
 * 檢查兩件事：
 *   1. 站內連結指向的檔案真的存在（`/privacy` → `legal/privacy.html`）
 *   2. 站外連結（含 mailto）格式正確，且網域是我們預期的那幾個
 *
 * 加 --live 會實際發請求驗證線上狀態（需要網路）。
 *
 * 用法：node tools/check-links.js [--live]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const live = process.argv.includes('--live');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// 我們自己的網域。出現在連結裡的其他網域都要有明確理由。
const OURS = ['pitlingo.com', 'pitlingo.pages.dev', 'api.pitlingo.com',
  'f1zh-api.pitlingo.workers.dev', 'github.com/ray319129'];

const FILES = [
  ['legal/index.html', '網站首頁'],
  ['legal/privacy.html', '隱私權政策'],
  ['legal/terms.html', '使用條款'],
  ['extension/src/options/options.html', '擴充功能設定頁'],
];

// 站內路徑 → 實際檔案
const ROUTES = { '/': 'legal/index.html', '/privacy': 'legal/privacy.html', '/terms': 'legal/terms.html' };

const external = new Set();
let internalOk = 0;

for (const [rel, label] of FILES) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) { bad(`${label} 檔案不存在：${rel}`); continue; }
  const html = fs.readFileSync(p, 'utf8');
  const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);

  for (const h of hrefs) {
    if (h.startsWith('mailto:')) {
      /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(h)
        ? internalOk++
        : bad(`${label}：mailto 格式不正確 → ${h}`);
      continue;
    }
    if (h.startsWith('http')) {
      external.add(h);
      const host = new URL(h).hostname;
      if (!OURS.some((o) => h.includes(o))) bad(`${label}：連到非預期的網域 → ${host}`);
      continue;
    }
    if (h.startsWith('#') || h.startsWith('data:')) continue;

    // 站內：可能是路由（/privacy）或相對路徑（options.css）
    if (h.startsWith('/')) {
      const target = ROUTES[h] || path.join('legal', h.replace(/^\//, ''));
      fs.existsSync(path.join(root, target))
        ? internalOk++
        : bad(`${label}：站內連結指向不存在的檔案 → ${h}（找不到 ${target}）`);
    } else {
      const target = path.join(path.dirname(p), h);
      fs.existsSync(target)
        ? internalOk++
        : bad(`${label}：相對路徑不存在 → ${h}`);
    }
  }
}
if (!errors.length) ok(`${internalOk} 個站內連結與資源都存在`);

// 三份文件必須互相連通，缺一個使用者就會走進死巷
const priv = fs.readFileSync(path.join(root, 'legal/privacy.html'), 'utf8');
const terms = fs.readFileSync(path.join(root, 'legal/terms.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'legal/index.html'), 'utf8');
const pairs = [
  [priv, '/terms', '隱私政策 → 使用條款'],
  [terms, '/privacy', '使用條款 → 隱私政策'],
  [index, '/privacy', '首頁 → 隱私政策'],
  [index, '/terms', '首頁 → 使用條款'],
];
let linked = 0;
for (const [doc, want, label] of pairs) {
  doc.includes(want) ? linked++ : bad(`缺少連結：${label}`);
}
linked === pairs.length && ok('四條互連的路徑都在（不會走進死巷）');

// 擴充功能的設定頁要連到法律文件——商店審核會看
const opts = fs.readFileSync(path.join(root, 'extension/src/options/options.html'), 'utf8');
['/privacy', '/terms'].every((u) => opts.includes(u))
  ? ok('擴充功能設定頁連得到隱私政策與使用條款')
  : bad('擴充功能設定頁沒有連到法律文件 —— 商店審核會問');

// 後端位址：manifest 的 host_permissions 必須涵蓋程式碼實際用的位址
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const defaults = fs.readFileSync(path.join(root, 'extension/src/shared/defaults.js'), 'utf8');
const backend = (defaults.match(/BACKEND\s*=\s*'([^']+)'/) || [])[1];
if (!backend) bad('找不到 BACKEND 位址');
else {
  const host = new URL(backend).hostname;
  (manifest.host_permissions || []).some((p) => p.includes(host))
    ? ok(`BACKEND（${host}）在 host_permissions 裡`)
    : bad(`BACKEND 是 ${host}，但 manifest 的 host_permissions 沒有涵蓋它 —— 所有請求都會被擋`);
}

console.log('');
if (live) {
  (async () => {
    console.log('── 線上驗證 ──');
    const urls = ['https://pitlingo.pages.dev/', 'https://pitlingo.pages.dev/privacy',
      'https://pitlingo.pages.dev/terms', backend + '/v1/health'];
    for (const u of urls) {
      try {
        const r = await fetch(u, { redirect: 'follow' });
        r.ok ? ok(`${u} → ${r.status}`) : bad(`${u} → ${r.status}`);
      } catch (e) { bad(`${u} → ${e.message}`); }
    }
    finish();
  })();
} else finish();

function finish() {
  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 所有連結都指向正確位置');
}
