#!/usr/bin/env node
/**
 * 把 legal/*.html 裡的 `?v=` 換成該檔案內容的雜湊。
 *
 * ⚠️ **為什麼需要這支：`?v=` 一旦發佈出去，那個網址的內容就凍結一年了。**
 *
 *    `legal/_headers` 給 `/*.js` 與 `/site.css` 的是 `max-age=31536000`。
 *    那是對的——版本化的網址就該永久快取。但它的前提是**內容變了網址就要變**。
 *
 *    今天實際踩到：同一天先後部署兩次，兩次都掛 `?v=5.9`。
 *    第一次載過的瀏覽器把舊的 5.9 存了一年，第二次的修正**永遠不會生效**，
 *    而且完全沒有錯誤訊息——畫面就只是「沒有反應」。
 *    用 curl 檢查還會看到新版（curl 沒有瀏覽器快取），於是更難懷疑到快取頭上。
 *    這是鐵則 #11（傳播延遲是所有快取層的總和）第四次咬人。
 *
 *    手動 bump 版本號解得掉，但那是一個**必須每次都記得**的步驟——
 *    而這次就是忘了。改成用內容雜湊，忘不了：內容一樣雜湊就一樣，
 *    內容變了雜湊必變。
 *
 * 用法：node tools/bump-assets.js        （部署 legal/ 之前跑）
 *      node tools/bump-assets.js --check （只檢查，有漂移就回非零；給 check-all 用）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'legal');
const check = process.argv.includes('--check');

const hash = (f) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 8);

// `?v=` 指向的資產。**新增一支就要加進來**，漏了就等於那支永遠不會更新。
const assets = fs.readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
const want = Object.fromEntries(assets.map((f) => [f, hash(f)]));

let changed = 0;
const drift = [];

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  const p = path.join(dir, f);
  const src = fs.readFileSync(p, 'utf8');
  // /site.css?v=xxx 或 /buy.js?v=xxx
  const out = src.replace(/\/([\w.-]+\.(?:js|css))\?v=([\w.]+)/g, (m, file, ver) => {
    const h = want[file];
    if (!h) return m;                       // 不是 legal/ 裡的檔案，別碰
    if (h !== ver) { drift.push(`${f} → ${file}：${ver} ≠ ${h}`); }
    return `/${file}?v=${h}`;
  });
  if (out !== src) {
    changed++;
    if (!check) fs.writeFileSync(p, out);
  }
}

if (check) {
  if (drift.length) {
    console.log('❌ 資產版本與內容不符 —— 部署後使用者會拿到舊檔（快取一年）\n');
    drift.forEach((d) => console.log('   ' + d));
    console.log('\n   修法：node tools/bump-assets.js');
    process.exit(1);
  }
  console.log('✅ 資產版本 = 內容雜湊');
  process.exit(0);
}

console.log(changed ? `✅ 已更新 ${changed} 個 HTML 的 ?v=` : '✅ 已是最新，無需更動');
for (const [f, h] of Object.entries(want)) console.log('   ' + f.padEnd(12) + ' → ' + h);
