#!/usr/bin/env node
/**
 * 把幾支已完整翻譯的影片抓下來，當成**固定測試資料**。
 *
 * 為什麼需要：翻譯品質的退化是**靜默的**。換模型、改 SYSTEM_PROMPT、
 * 調 normKey——每一項都可能讓譯文變差，而沒有任何測試會失敗，
 * 因為「翻得好不好」不是語法問題。唯一能抓到的方法是
 * **拿同一份輸入跟上一版的輸出比對**。
 *
 * ⚠️ 這支要 ADMIN_TOKEN，所以**不放進 check-all**。
 *    它是「產生測試資料」的工具，不是測試本身。
 *    測試是 tools/check-fixtures.js，那支不需要任何權杖。
 *
 * 用法（PowerShell）：
 *   $env:ADMIN_TOKEN="..."; node tools/fetch-fixtures.js
 * 指定要抓哪幾支：
 *   node tools/fetch-fixtures.js 1000010185 1000010530
 *
 * 不指定時會從翻譯清單裡挑**句數最多的前 4 支已完整影片**——
 * 句數多代表涵蓋的用語廣，比隨機挑幾支更有代表性。
 */
const fs = require('fs');
const path = require('path');

const API = process.env.PITLINGO_API || 'https://api.pitlingo.com';
const TOKEN = process.env.ADMIN_TOKEN || '';
const OUT = path.join(__dirname, 'fixtures');
const WANT = 4;
// 一支影片全部收下來會有一千多句，比對時看不完也沒必要。
// 取樣要**穩定**（同一份輸入永遠取到同一批），否則每次比對的基準都不一樣。
const SAMPLE = 120;

if (!TOKEN) {
  console.error('需要 ADMIN_TOKEN。PowerShell：$env:ADMIN_TOKEN="..."; node tools/fetch-fixtures.js');
  process.exit(1);
}

async function api(p) {
  const r = await fetch(API + p, { headers: { 'x-admin-token': TOKEN } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

/**
 * 穩定取樣：依 key 的雜湊排序後取前 N 筆。
 * 用 Math.random() 的話每次抓到的都不一樣，下一版就沒有東西可以比對。
 */
function stableSample(entries, n) {
  const h = (s) => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  };
  return entries.slice().sort((a, b) => h(a[0]) - h(b[0])).slice(0, n);
}

(async () => {
  let cids = process.argv.slice(2).filter((x) => /^\d+$/.test(x));

  if (!cids.length) {
    console.log('沒有指定 cid，從翻譯清單挑句數最多的已完整影片…');
    const d = await api('/v1/admin/bundles');
    const all = [];
    for (const g of d.groups || []) for (const it of g.items || []) all.push(it);
    cids = all
      .filter((it) => it.segCount > 0 && it.lines > 200)     // 只挑收割完整的
      .sort((a, b) => b.lines - a.lines)
      .slice(0, WANT)
      .map((it) => String(it.cid));
    if (!cids.length) { console.error('找不到任何「已完整收割且超過 200 句」的影片'); process.exit(1); }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const index = [];
  for (const cid of cids) {
    const b = await api('/v1/admin/bundle?cid=' + cid);
    const entries = stableSample(Object.entries(b.lines || {}), SAMPLE);
    if (!entries.length) { console.log(`  ${cid} 沒有譯文，略過`); continue; }
    const file = path.join(OUT, cid + '.json');
    fs.writeFileSync(file, JSON.stringify({
      cid: b.cid,
      slug: b.slug,
      fetchedAt: new Date().toISOString(),
      totalLines: b.count,
      // key 是 normKey 之後的英文，value 是當時的譯文
      sample: Object.fromEntries(entries),
    }, null, 2));
    index.push({ cid: b.cid, slug: b.slug, n: entries.length, of: b.count });
    console.log(`  ✅ ${cid}　${b.slug}　取樣 ${entries.length} / ${b.count} 句`);
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    note: '固定測試資料。每次 release 前跑 node tools/check-fixtures.js 比對。',
    files: index,
  }, null, 2));
  console.log(`\n已寫入 ${index.length} 份到 tools/fixtures/`);
  console.log('接下來：node tools/check-fixtures.js');
})().catch((e) => { console.error('失敗：' + e.message); process.exit(1); });
