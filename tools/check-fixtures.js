#!/usr/bin/env node
/**
 * 固定測試資料的比對。
 *
 * 翻譯品質的退化是**靜默的**：換模型、改 SYSTEM_PROMPT、動 normKey，
 * 每一項都可能讓譯文變差，而沒有任何語法測試會失敗。
 *
 * 這支分兩種模式：
 *
 *   離線（預設，check-all 會跑）
 *     不呼叫模型、不花錢。檢查的是**不變式**：
 *       · 三份 normKey 對每一句都算出同一個 key（快取鍵不能漂）
 *       · 每一句都有譯文、沒有空字串、沒有殘留的英文整句
 *       · 譯文長度沒有異常（過長通常是模型開始解釋而不是翻譯）
 *       · 沒有簡體字（我們賣的是繁體）
 *
 *   線上（--live，要 ADMIN_TOKEN，**會花錢**）
 *     把同一批英文重新送一次，跟存下來的譯文比對，回報差異率。
 *     ⚠️ 差異不等於變差——翻譯本來就有多種合理說法。
 *        這支只負責**指出哪幾句變了**，判斷好壞是人的工作。
 *
 * 用法：
 *   node tools/check-fixtures.js
 *   $env:ADMIN_TOKEN="..."; node tools/check-fixtures.js --live
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'fixtures');
const LIVE = process.argv.includes('--live');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };
const warn = (m) => console.log('⚠️  ' + m);

/* ------------------------------------------------------------------ */
if (!fs.existsSync(DIR) || !fs.readdirSync(DIR).filter((f) => /^\d+\.json$/.test(f)).length) {
  // ⚠️ **不要靜默通過。** 這個專案的 bug 幾乎都是靜默的，
  //    「沒有測試資料所以跳過」如果不吭聲，就等於永遠不會有人去建它。
  warn('還沒有固定測試資料 —— 翻譯品質的退化目前無法偵測');
  console.log('    建立方式：$env:ADMIN_TOKEN="..."; node tools/fetch-fixtures.js');
  console.log('    （會從共用快取挑句數最多的 4 支已完整影片，各取樣 120 句）');
  process.exit(0);
}

const files = fs.readdirSync(DIR).filter((f) => /^\d+\.json$/.test(f));
const fixtures = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const total = fixtures.reduce((n, f) => n + Object.keys(f.sample).length, 0);
console.log(`固定測試資料：${fixtures.length} 支影片、${total} 句\n`);

/* ---- 1. 三份 normKey 必須對每一句都算出同一個 key ---- */
//
// check-normkey.js 只比對「函式原始碼長得一樣」，那擋不住
// 「兩邊都改、改得一樣但邏輯錯」的情況。這裡是拿真實資料實際跑。
{
  // ⚠️ **用大括號配對取函式，不要用正則。**
  //    正則版寫成「到第一個行首 `}` 為止」，那假設函式在最外層沒有縮排。
  //    normalize.js 的 normKey 是縮排的，於是比對衝過頭、抓進後面的程式碼，
  //    錯誤訊息變成「Unexpected token ';'」——與真正的原因毫無關聯。
  //    check-normkey.js 早就是配對寫法，這裡照抄它（同一個檔案學到的規則，
  //    要主動確認它在別的地方也成立，鐵則 #13）。
  const grab = (file, name) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const start = src.indexOf('function ' + name);
    if (start < 0) throw new Error(`在 ${file} 找不到 ${name}()`);
    let depth = 0;
    let end = -1;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) throw new Error(`在 ${file} 的 ${name}() 大括號不對稱`);
    // eslint-disable-next-line no-new-func
    return new Function('return (' + src.slice(start, end) + ')')();
  };
  let impls;
  try {
    impls = [
      ['backend', grab('backend/src/index.js', 'normKey')],
      ['extension', grab('extension/src/shared/normalize.js', 'normKey')],
      ['userscript', grab('f1tv-zh-subtitles.user.js', 'normKey')],
    ];
  } catch (e) {
    impls = null;
    bad('normKey 實測：' + e.message);
  }

  if (impls) {
    const mismatch = [];
    for (const fx of fixtures) {
      for (const en of Object.keys(fx.sample)) {
        const keys = impls.map(([, fn]) => fn(en));
        if (new Set(keys).size !== 1) mismatch.push(en.slice(0, 50) + ' → ' + keys.join(' / '));
        if (mismatch.length > 5) break;
      }
    }
    mismatch.length
      ? bad('normKey 三份實作對真實字幕算出不同的快取鍵：' + mismatch.join('　|　'))
      : ok(`normKey：${total} 句在三份實作上算出完全相同的快取鍵`);
  }
}

/* ---- 2. 譯文的不變式 ---- */
{
  // 簡體字取樣。不需要完整字表——出現任何一個就代表出問題了。
  const SIMPLIFIED = /[这么说话个国来时对开们没经过还发点样种应当动无长门问间实现电车轮胎级压圈进赛队图][^]/;
  const problems = { empty: [], tooLong: [], english: [], simplified: [] };
  for (const fx of fixtures) {
    for (const [en, zh] of Object.entries(fx.sample)) {
      if (!zh || !String(zh).trim()) { problems.empty.push(en.slice(0, 40)); continue; }
      // 譯文比原文長太多，通常是模型開始「解釋」而不是翻譯
      if (zh.length > Math.max(60, en.length * 2.5)) problems.tooLong.push(en.slice(0, 40));
      // 整句原封不動＝沒翻到
      if (zh.trim().toLowerCase() === en.trim().toLowerCase()) problems.english.push(en.slice(0, 40));
      if (SIMPLIFIED.test(zh)) problems.simplified.push(en.slice(0, 40) + ' → ' + zh.slice(0, 30));
    }
  }
  const show = (a) => a.slice(0, 3).join('　|　') + (a.length > 3 ? ` …共 ${a.length} 句` : '');

  problems.empty.length ? bad('有空的譯文：' + show(problems.empty)) : ok('沒有空的譯文');
  problems.english.length
    ? bad('有整句沒翻到的（中英完全相同）：' + show(problems.english))
    : ok('沒有整句未翻譯的');
  problems.simplified.length
    ? bad('譯文裡有簡體字（我們賣的是繁體）：' + show(problems.simplified))
    : ok('沒有簡體字');
  // 過長只是訊號不是錯誤，例如原文是縮寫而中文要展開
  problems.tooLong.length
    ? warn(`${problems.tooLong.length} 句譯文明顯偏長，值得抽看：` + show(problems.tooLong))
    : ok('沒有異常偏長的譯文');
}

/* ---- 3. 線上回歸（要 --live，會花錢）---- */
if (!LIVE) {
  console.log('\n（離線模式。要實際重翻一次比對品質：node tools/check-fixtures.js --live，會花錢）');
} else {
  const TOKEN = process.env.ADMIN_TOKEN;
  const API = process.env.PITLINGO_API || 'https://api.pitlingo.com';
  if (!TOKEN) { bad('--live 需要 ADMIN_TOKEN'); }
  else {
    (async () => {
      let changed = 0;
      let same = 0;
      const samples = [];
      for (const fx of fixtures) {
        const ens = Object.keys(fx.sample).slice(0, 40);       // 每支只重翻 40 句，控制成本
        const r = await fetch(API + '/v1/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
          // cid 用一個不存在的，強迫它真的重翻而不是從 bundle 拿舊的
          body: JSON.stringify({ cid: '999999999', lines: ens, urgent: true, slug: fx.slug }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.lines) { bad(`${fx.cid} 重翻失敗：${d.error || r.status}`); continue; }
        for (const en of ens) {
          const before = fx.sample[en];
          const after = d.lines[en];
          if (!after) continue;
          if (after === before) same++;
          else { changed++; if (samples.length < 8) samples.push(`${en.slice(0, 40)}\n    舊：${before}\n    新：${after}`); }
        }
      }
      const n = same + changed;
      console.log(`\n線上回歸：${n} 句　相同 ${same}　不同 ${changed}（${n ? (changed / n * 100).toFixed(1) : 0}%）`);
      if (samples.length) console.log('\n變動的例子：\n  ' + samples.join('\n  '));
      console.log('\n⚠️ 不同不等於變差。這支只負責指出哪幾句變了，好壞要人看。');
      finish();
    })();
    return;
  }
}

finish();

function finish() {
  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 固定測試資料全部通過');
}
