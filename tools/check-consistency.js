#!/usr/bin/env node
/**
 * 跨產物的一致性檢查。
 *
 * 這個專案有三個產物（backend / extension / userscript）加一個網站，
 * 沒有共用模組——所有共用的東西都是**各寫一份**。
 * 那些副本漂掉時**全部都不會報錯**：
 *
 *   · 免費層規則兩邊不同 → 用戶端擋、伺服器不擋（或反過來）
 *   · MAX_LINE_LEN 不同 → 用戶端放行、伺服器退回整批
 *   · 網站的 ?v= 沒跟著改 → 使用者拿到舊 CSS，新元素完全沒有樣式
 *   · 條款寫的數字與程式碼不同 → 消費爭議
 *
 * check-normkey / check-prompt / check-legal 各自顧一塊，
 * 這一支顧的是**剩下那些沒人顧的**。
 *
 * 用法：node tools/check-consistency.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const BACKEND = read('backend/src/index.js');
const EXT_MAIN = read('extension/src/content/main.js');
const EXT_DEF = read('extension/src/shared/defaults.js');
const USER = read('f1tv-zh-subtitles.user.js');
const MANIFEST = read('extension/manifest.json');
const TERMS = read('legal/terms.html');
const FAQ = read('legal/faq.html');

/** 取出一個 `名稱: {...}` 或 `名稱 = {...}` 的區塊，去掉註解與空白後回傳。 */
function block(src, name) {
  const i = src.indexOf(name);
  if (i < 0) return null;
  const st = src.indexOf('{', i);
  if (st < 0) return null;
  let d = 0;
  let j = st;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return src.slice(st, j).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

/* --- 1. 免費層規則：後端與擴充功能必須逐字相同 ------------------------- */
//
// 這是**收費的界線**。兩邊不同的後果：用戶端擋住但伺服器放行（漏財），
// 或用戶端放行但伺服器擋住（使用者看到一個他無從理解的錯誤）。
{
  const b = block(BACKEND, 'freeTier:');
  const e = block(EXT_DEF, 'freeTier:');
  if (!b || !e) bad('找不到 freeTier 設定（後端或擴充功能）');
  else if (b !== e) {
    bad('免費層規則兩邊不一致 —— 收費界線會出現破口');
    console.log('     backend  : ' + b);
    console.log('     extension: ' + e);
  } else ok('免費層規則：後端與擴充功能逐字相同');
}

/* --- 2. 單句長度上限：三份必須相同 -------------------------------------- */
//
// 用戶端比伺服器寬 → 送出去被退回整批（使用者看到「不可超過 1000 字元」）。
// 用戶端比伺服器嚴 → 白白丟掉可以翻的句子。
{
  const grab = (s, label) => {
    const m = s.match(/MAX_LINE_LEN\s*=\s*(\d+)/);
    return m ? Number(m[1]) : (bad(`${label} 找不到 MAX_LINE_LEN`), null);
  };
  const v = [
    ['backend', grab(BACKEND, 'backend')],
    ['extension', grab(EXT_MAIN, 'extension')],
    ['userscript', grab(USER, 'userscript')],
  ];
  const set = new Set(v.map(([, n]) => n).filter((n) => n != null));
  set.size === 1
    ? ok(`單句長度上限三份一致（${[...set][0]} 字元）`)
    : bad('單句長度上限三份不一致：' + v.map(([k, n]) => `${k}=${n}`).join('、'));
}

/* --- 3. 後端位址：manifest 必須涵蓋 sw.js 真正打的網域 ------------------ */
//
// 漏掉的話 fetch 會被 MV3 擋掉，而錯誤只出現在 service worker 的 console——
// 使用者看到的是「字幕完全沒出現」，沒有任何線索。
{
  // BACKEND 定義在 shared/defaults.js，sw.js 只是 `self.PL.BACKEND` 取用
  const m = EXT_DEF.match(/const BACKEND\s*=\s*['"]([^'"]+)['"]/);
  if (!m) bad('extension/src/shared/defaults.js 找不到 BACKEND 常數');
  else {
    const host = new URL(m[1]).origin;
    MANIFEST.includes(host)
      ? ok(`BACKEND（${host}）在 manifest 的 host_permissions 裡`)
      : bad(`BACKEND（${host}）不在 manifest 的 host_permissions 裡 —— 所有請求都會被擋`);
  }
}

/* --- 4. 網站：所有頁面用同一組 API 位址 --------------------------------- */
{
  const apis = new Set();
  for (const f of ['legal/buy.js', 'legal/contact.js', 'legal/paid.js']) {
    const m = read(f).match(/const API\s*=\s*['"]([^'"]+)['"]/);
    if (m) apis.add(m[1]);
  }
  apis.size === 1
    ? ok(`網站三支 JS 用同一個 API 位址（${[...apis][0]}）`)
    : bad('網站的 API 位址不一致：' + [...apis].join('、'));
}

/* --- 5. 同一支資產的 ?v= 在每一頁都要相同 --------------------------------- */
//
// ⚠️ 這一項實際踩過兩次：
//    (1) 改了 site.css 卻只更新其中一頁的 ?v=，另一頁的使用者拿到舊 CSS——
//        **新加的元素完全沒有樣式**，畫面壞掉但 Console 一片乾淨。
//    (2) 同一天部署兩次、兩次都掛 `?v=5.9`。第一次載過的瀏覽器把舊檔
//        存了一年（`_headers` 給 max-age=31536000），第二次的修正**永遠不生效**，
//        而且 curl 看到的是新版（curl 沒有瀏覽器快取），更難懷疑到快取頭上。
//
// ⚠️ **不同資產不必共用同一個版本號。** 現在 `tools/bump-assets.js` 用內容雜湊，
//    每支各有各的值——那正是重點：內容一樣雜湊就一樣，內容變了雜湊必變。
//    這裡只驗「同一支檔案在所有頁面的值相同」，是否等於內容則由 bump-assets 驗。
{
  const byFile = new Map();
  for (const f of fs.readdirSync(path.join(root, 'legal')).filter((x) => x.endsWith('.html'))) {
    const src = read('legal/' + f);
    for (const m of src.matchAll(/\/([\w.-]+\.(?:css|js))\?v=([\w.]+)/g)) {
      if (!byFile.has(m[1])) byFile.set(m[1], new Map());
      const vs = byFile.get(m[1]);
      if (!vs.has(m[2])) vs.set(m[2], []);
      vs.get(m[2]).push(f);
    }
    // 有引用但完全沒帶 ?v= 也要抓：那等於永遠吃瀏覽器快取
    for (const m of src.matchAll(/(?:href|src)="\/([\w.-]+\.(?:css|js))"/g)) {
      bad(`${f} 引用 /${m[1]} 但沒有 ?v= —— 改版後使用者會一直吃到舊檔`);
    }
  }
  const split = [...byFile].filter(([, vs]) => vs.size > 1);
  split.length
    ? split.forEach(([file, vs]) => bad(`/${file} 在不同頁面的 ?v= 不一致：`
      + [...vs].map(([v, fs2]) => `${v}（${fs2.join('、')}）`).join('　|　')
      + ' —— 部分頁面會拿到舊檔'))
    : ok(`${byFile.size} 支靜態資源的 ?v= 在所有頁面一致`);
}


/* --- 6. 錯誤代碼：用到的都要有定義 -------------------------------------- */
{
  const defined = new Set([...(block(EXT_MAIN, 'PL_CODES = ') || '')
    .matchAll(/'(PL-C\d+)'/g)].map((m) => m[1]));
  // ⚠️ 不能只看 `plErr('PL-Cxx'`。有些代碼是先算進變數再傳進去
  //    （免費層那兩個就是），只認字面呼叫會誤報「沒有觸發點」。
  //    改成「把定義區塊本身挖掉，剩下的檔案有沒有提到它」。
  //    ⚠️ 兩個踩過的寫法：拿 block() 的回傳值去 split（那是正規化過的字串，
  //       原始碼裡找不到），以及只看定義之後的內容（有些觸發點在定義**之前**，
  //       函式宣告會提升，執行期完全正常）。兩次都是 7 個代碼全被判成沒用到。
  const defStart = EXT_MAIN.indexOf('PL_CODES = ');
  const defEnd = defStart >= 0 ? EXT_MAIN.indexOf('};', defStart) + 2 : -1;
  const rest = defEnd > 0 ? EXT_MAIN.slice(0, defStart) + EXT_MAIN.slice(defEnd) : '';
  const used = new Set([...defined].filter((c) => rest.includes(c)));
  const undef = [...EXT_MAIN.matchAll(/plErr\(\s*'(PL-C\d+)'/g)]
    .map((m) => m[1]).filter((c) => !defined.has(c));
  const unused = [...defined].filter((c) => !used.has(c));
  undef.length
    ? bad(`用到未定義的錯誤代碼：${undef.join('、')} —— 使用者看到空白說明`)
    : ok(`${used.size} 個錯誤代碼都有定義`);
  if (unused.length) console.log(`     （${unused.join('、')} 已定義但目前沒有觸發點）`);
}

/* --- 7. 條款裡的數字必須等於程式碼 -------------------------------------- */
//
// 寫錯的代價是消費爭議，不是體驗不好。
{
  const num = (src, re, label) => {
    const m = src.match(re);
    return m ? Number(m[1]) : (bad(`找不到 ${label}`), null);
  };
  const pairs = [
    ['同時啟用裝置數', num(BACKEND, /MAX_DEVICES\s*=\s*(\d+)/, 'MAX_DEVICES'),
      [[TERMS, /最多可在 <strong>(\d+) 台裝置/], [FAQ, /同時最多 (\d+) 台/]]],
    ['升級折抵上限', num(BACKEND, /UPGRADE_CREDIT_MAX\s*=\s*(\d+)/, 'UPGRADE_CREDIT_MAX'),
      [[TERMS, /折抵上限為 NT\$(\d+)/]]],
    ['免收差額門檻', num(BACKEND, /UPGRADE_FREE_BELOW\s*=\s*(\d+)/, 'UPGRADE_FREE_BELOW'),
      [[TERMS, /低於 NT\$(\d+) 者/]]],
  ];
  for (const [label, code, docs] of pairs) {
    if (code == null) continue;
    let allOk = true;
    for (const [doc, re] of docs) {
      const m = doc.match(re);
      if (!m) { bad(`文件裡找不到「${label}」的數字`); allOk = false; continue; }
      if (Number(m[1]) !== code) {
        bad(`${label}：程式碼是 ${code}，文件寫的是 ${m[1]}`);
        allOk = false;
      }
    }
    if (allOk) ok(`${label}：程式碼與文件一致（${code}）`);
  }

  // 免費分鐘數
  const sec = Number((BACKEND.match(/freeTier:\s*\{\s*seconds:\s*(\d+)/) || [])[1]);
  const mins = sec / 60;
  [['使用條款', TERMS], ['常見問題', FAQ]].forEach(([label, doc]) => {
    doc.includes(`${mins} 分鐘`)
      ? ok(`${label}：免費 ${mins} 分鐘與程式碼一致`)
      : bad(`${label}：沒有寫出程式碼的免費分鐘數（${mins} 分鐘）`);
  });
}

/* --- 8. 條款／FAQ 不可以殘留舊的效期說法 -------------------------------- */
//
// 通行證從「購買起算七天」改成「錨定賽程」之後，任何殘留的
// 「七天／七日」都是在收錢的頁面上說謊。
// （鑑賞期的「七日」是法規用語，要排除掉。）
{
  const stale = [];
  for (const [label, doc] of [['使用條款', TERMS], ['常見問題', FAQ]]) {
    for (const line of doc.split(/\r?\n/)) {
      if (!/通行證/.test(line)) continue;
      if (/鑑賞期|解約|退貨/.test(line)) continue;         // 法規用語
      if (/七日|七天|7 ?天/.test(line)) stale.push(`${label}：${line.trim().slice(0, 50)}`);
    }
  }
  stale.length
    ? bad('文件仍在用「七天」描述通行證效期，但程式碼早已改成錨定賽程：\n     ' + stale.join('\n     '))
    : ok('文件沒有殘留「七天」的舊效期說法');
}

/* --- 9. 買多站的欄位要一路接到後台 -------------------------------------- */
//
// 後端寫了 gpCount 但後台沒讀，等於後台仍然分不出「×3」與「×1」。
{
  const admin = read('legal/admin.html');
  const wrote = (BACKEND.match(/gpCount:/g) || []).length;
  const readsIt = /r\.gpCount|l\.gpCount/.test(admin);
  wrote >= 2 && readsIt
    ? ok(`買多站：後端寫入 gpCount（${wrote} 處），後台有讀`)
    : bad(`買多站：gpCount 沒有一路接通（後端 ${wrote} 處寫入、後台${readsIt ? '有' : '沒有'}讀）`);
}

/* --- 10. 用戶端不可以自己維護方案名稱對照表 ---------------------------- */
//
// ⚠️ 實際踩過兩次：後台寫死過（改價後還在發早鳥碼），
//    設定頁也寫死過（裡面有一個根本不存在的鍵 `weekend`，
//    而真正的鍵是 `week`——買一週通行證的人看到英文鍵名，完全不報錯）。
//    方案會增減，寫死的對照表一定會漂。
{
  const opts = read('extension/src/options/options.js');
  const planKeys = [...BACKEND.matchAll(/^\s{2}(\w+):\s*\{[^\n]*label:/gm)].map((m) => m[1]);
  // ⚠️ 這個正則**不可以寫成樣板字面量**。樣板字面量會把 \b 當成
  //    **退格字元**（U+0008），不是正則的 word boundary——於是永遠比對不到，
  //    而檢查看起來一直是綠的。第一版就是這樣，注入假的寫死對照表也抓不到。
  const B = String.fromCharCode(92);
  const hard = planKeys.filter((k) => new RegExp(B + 'b' + k + B + 's*:' + B + 's*[\'"]').test(opts));
  hard.length
    ? bad(`設定頁寫死了方案名稱：${hard.join('、')} —— 方案增減時會漂掉`)
    : ok('設定頁沒有寫死方案名稱（用伺服器回的 planLabel）');

  /planLabel/.test(opts)
    ? ok('設定頁用的是伺服器提供的 planLabel')
    : bad('設定頁沒有用 planLabel');
}

/* --- 11. 畫面上的承諾要有程式碼在兌現 ---------------------------------- */
//
// ⚠️ 實際踩過：購買頁寫「將直接為您升級，不另行收費」，
//    但 handleCheckout 照樣把人送去綠界收那筆小額——**畫面在說謊**。
{
  const buy = read('legal/buy.js');
  /不另行收費/.test(buy) && !/免費升級流程|直接發碼/.test(BACKEND)
    ? bad('購買頁承諾「不另行收費」，但後端沒有對應的免費升級流程 —— 那是空頭支票')
    : ok('購買頁沒有無人兌現的付款承諾');
}

/* --- 12. 賽事資料與商品資料必須分開 ------------------------------------ */
//
// 使用者定的核心原則：**商品不可以自己保存一套賽事時間**。
// 保存了就會在賽程異動時與賽事脫節，而且不報錯——只有買家會發現。
{
  const planBlock = BACKEND.match(/const PLANS = \{([\s\S]*?)\n\};/)[1];
  /(days|expiresAt|start|end)\s*:\s*'20\d\d-/.test(planBlock)
    ? bad('PLANS 裡出現了寫死的日期 —— 商品不可以自己保存賽事時間')
    : ok('商品沒有保存任何賽事時間（效期由 gpWindow 動態算）');

  /function gpWindow\(/.test(BACKEND)
    ? ok('通行證效期由賽事資料動態計算（gpWindow）')
    : bad('找不到 gpWindow —— 效期沒有綁定賽事');
}

/* --- 13. 舊的商品名稱不可以殘留 ---------------------------------------- */
//
// 「一週通行證」已改為「比賽週通行證」。殘留在收錢的頁面上就是名實不符。
{
  const files = ['legal/buy.html', 'legal/terms.html', 'legal/faq.html',
    'legal/privacy.html', 'backend/src/index.js'];
  const left = files.filter((f) => /一週通行證/.test(read(f)));
  left.length
    ? bad('這些檔案還留著舊的商品名稱「一週通行證」：' + left.join('、'))
    : ok('沒有殘留舊的商品名稱');
}

/* --- 14. 賽事資料的欄位要齊全 ------------------------------------------ */
//
// 少一個欄位，購買頁的卡片就會缺一塊，而那不會報錯——只會顯示「—」。
{
  const need = ['name', 'label', 'country', 'flag', 'circuit', 'tz', 'start', 'end', 'sessions'];
  const block = BACKEND.match(/schedule: \[([\s\S]*?)\n  \],/);
  if (!block) bad('找不到 schedule 區塊');
  else {
    const rows = block[1].split('\n').filter((l) => l.includes('{ r:'));
    const missing = [];
    for (const r of rows) {
      for (const k of need) if (!new RegExp(k + ':').test(r)) missing.push(k);
    }
    const uniq = [...new Set(missing)];
    uniq.length
      ? bad(`賽事資料缺少欄位：${uniq.join('、')}（共 ${rows.length} 站）`)
      : ok(`賽事資料 ${rows.length} 站，${need.length} 個必要欄位都齊全`);
  }
}

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 跨產物一致性全部通過');
