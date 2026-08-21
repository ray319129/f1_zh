/*
 * 購買頁。
 *
 * ⚠️ **金額一律由後端算，前端一個數字都不許自己算。**
 *
 * 上一版把 599 / 399 寫死在這個檔案裡，只從 `/v1/plans` 讀早鳥剩餘數。
 * 後端改成分段定價之後，畫面顯示 599、綠界實收 299——**線上真的發生過**。
 * 收得比顯示少不會有客訴，但那代表兩邊的價格來源根本沒接起來，
 * 反過來（顯示少收得多）就是消費爭議。
 *
 * 所以這裡的規則是：
 *   方案與牌價  ← GET  /v1/plans
 *   購物車金額  ← POST /v1/quote      （與 /v1/checkout 走同一個函式）
 *   結帳        ← POST /v1/checkout
 */
(function () {
  'use strict';

  const API = 'https://api.pitlingo.com';
  const $ = (id) => document.getElementById(id);
  const money = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');

  // key -> qty。用 Map 保順序，畫面上的排列才穩定。
  const cart = new Map();
  let plans = [];
  let quote = null;
  let quoteSeq = 0;

  // ---------------------------------------------------------------------
  // 載入方案
  // ---------------------------------------------------------------------
  async function loadPlans() {
    try {
      const r = await fetch(API + '/v1/plans');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      plans = Array.isArray(d.plans) ? d.plans : [];
      renderPlans(d);
    } catch (e) {
      $('plans').innerHTML = '<p class="msg err">目前無法取得方案資訊，請稍後再試。'
        + '若持續發生請來信 pitlingo.office@gmail.com</p>';
    }
  }

  /**
   * 方案卡片。
   *
   * ⚠️ **收合是必要的，不是好看而已。** 12 個方案每張都攤開完整說明時，
   *    整頁會變成幾千字，標題與價格被擠成一團——使用者連「有哪些方案」
   *    都看不出來，更不用說比較。
   *
   *    收合時只有「名稱 + 價格 + 一行重點」，展開才給細節。
   *    細節用 `<details>` 而不是自己寫的展開邏輯：原生元素本來就支援
   *    鍵盤操作與螢幕閱讀器，而且不會因為 JS 出錯就永遠打不開。
   *
   *    選取用外層的按鈕，展開用內層的 `<details>`——**兩者必須分開**，
   *    否則使用者想看說明卻把方案加進購物車，或反過來。
   */
  function card(p) {
    const el = document.createElement('div');
    el.className = 'plan';
    el.dataset.key = p.key;

    const bits = [];
    // 鎖住的方案：留在頁面上但不能選。**不要直接隱藏**——
    // 整張消失會讓人以為賣完了或網站壞了，而「什麼時候開放」本身就是預告。
    if (p.locked) el.classList.add('locked');
    // 賣的是下一賽季時**一定要講清楚**。靜靜收全價然後給一個要等好幾個月
    // 才用得到的東西，是最糟的那種體驗。
    if (p.nextSeason) bits.push('<b class="warn">此為次一賽季通行證，本賽季剩餘場次一併附贈</b>');
    else if (p.tier) bits.push(p.tier);
    if (p.gp) {
      bits.push(`即刻可用，涵蓋${esc(p.gp.name)}大獎賽　·　效期至 ${fmt(p.gp.expiresAt)}`);
      // ⚠️ **正賽當天購買要提醒。** 賽程只有日期沒有時間，伺服器分不出
      //    「正賽剛開始」與「正賽已結束」；使用者自己知道，所以把選擇權給他。
      //    不講的話，正賽結束後買的人會以為自己買到了下一站。
      if (p.gp.raceDayPassed && p.gp.nextName) {
        bits.push(`<b class="warn">今天是${esc(p.gp.name)}的正賽日。`
          + `若正賽已結束、您想要的是下一站（${esc(p.gp.nextName)}），請明天再購買，`
          + `或直接把站數改成 2。</b>`);
      }
    }
    if (p.limit) bits.push(`限量 ${p.limit} 組`);
    if (p.vpn) bits.push('<b class="warn">觀看時需自備 VPN</b>');
    // ⚠️ 共用帳號的兩個限制**一定要出現在收合狀態的卡片上**。
    //    寫在展開後的商品說明裡等於沒寫——多數人不會展開，
    //    而「買了才發現只能用網頁、還會被擠掉」是必然的客訴與退款。
    if (p.shared) {
      bits.push('<b class="warn">與他人共用帳號　·　僅限網頁端　·　高峰時段有機率被擠掉</b>');
    }
    if (p.bundleWeek) bits.push('隨附一個比賽週的字幕翻譯');
    if (p.locked) bits.push('<b class="warn">目前無法購買</b>　' + esc(p.locked));
    // **划算度要說實話。** 賽季尾聲的整季票可能比一場一場買貴，
    // 那是刻意保留給使用者自己決定的（他可能就是想一次買斷），
    // 但「自己決定」的前提是他看得到另一個選項的總價。
    // 只顯示價格而不顯示對照，技術上沒說謊，實際上是靠他不會算。


    // ⚠️ 說明裡的 `**粗體**` 要跳脫星號（`\*\*`）。少了反斜線的話
    //    `/**(.+?)**/` 是無效的正規表示式（`*` 沒有可重複的對象），
    //    整個 buy.js 直接壞掉，畫面上只會看到「目前無法取得方案資訊」——
    //    一個與真正原因無關的訊息（坑 #36）。
    const desc = p.desc ? esc(p.desc).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') : '';

    // 通行證可以一次買多站。**上限由伺服器給**（本賽季剩餘比賽週），
    // 寫死在這裡的話賽季走到一半就會對不上，而且不會報錯。
    // 共用帳號的代訂要選一場大獎賽。**放在收合狀態就看得到的位置**——
    // 藏在展開裡的話，多數人會直接加進購物車然後在結帳時被擋下。
    const gpBox = p.svcWeekend
      ? `<div class="planQty">
           <label>比賽週末
             <select data-svcgp="${p.key}">
               ${races.filter((r) => r.purchasable).map((r) =>
    `<option value="${r.id}">${r.flag} ${esc(r.label)}（${fmtRange(r.startDate, r.endDate)}）</option>`).join('')}
             </select>
           </label>
           <span class="hint">只有該週末的星期五、六、日可用</span>
         </div>`
      : '';

    // ⚠️ **數量就是數量，不要加單位。** 這個下拉原本寫「站數」，
    //    那是比賽週通行證的用語；套到「代訂 1 個月」上會變成
    //    「站數 3」——完全不知道那是什麼意思。
    //    商品名稱裡已經有單位（1 個月），這裡只要純數字。
    const qtyBox = p.maxQty > 1
      ? '<div class="planQty"><label>數量 <select data-qty="' + p.key + '">'
        + Array.from({ length: p.maxQty }, (_, i) =>
          '<option value="' + (i + 1) + '">' + (i + 1) + '</option>').join('')
        + '</select></label></div>'
      : '';

    el.innerHTML =
      `<button type="button" class="planHead">
         <span class="planName">${esc(p.label)}</span>
         <span class="planPrice">${money(p.price)}</span>
       </button>`
      + gpBox
      + qtyBox
      + (bits.length ? `<div class="planNote">${bits.join('　·　')}</div>` : '')
      + (desc ? `<details class="planMore"><summary>商品說明</summary><div>${desc}</div></details>` : '');

    // 選取與展開是兩件事，必須綁在不同的元素上
    if (p.locked) {
      el.querySelector('.planHead').disabled = true;
    } else {
      el.querySelector('.planHead').onclick = () => { toggle(p.key); };
    }
    const gsel = el.querySelector('[data-svcgp]');
    if (gsel) {
      gsel.onclick = (ev) => ev.stopPropagation();
      gsel.onchange = () => { if (cart.has(p.key)) refreshQuote(); };
    }
    const qsel = el.querySelector('[data-qty]');
    if (qsel) {
      // 站數的下拉不可以連帶觸發「選取／取消選取」——改數量的人不是想退出購物車
      qsel.onclick = (ev) => ev.stopPropagation();
      qsel.onchange = () => {
        const n = Number(qsel.value) || 1;
        // 還沒加進購物車就改數量＝他想買，直接幫他加進去
        cart.set(p.key, n);
        paintSelection();
        refreshQuote();
      };
    }
    return el;
  }

  // 剩餘週末數。用來設通行證的數量上限，也用在剩餘場次的說明文字。
  let seasonInfo = null;

  /**
   * ⚠️ 這裡曾經有一個 valueHint()，會主動算「一週票買滿是多少」貼在賽季卡上。
   *    **使用者的決定（2026-08-19）是移除**：那句話會讓正在看賽季方案的人
   *    突然要做一次算術比較，而多一個比較就多一批放棄結帳的人。
   *    剩餘比賽週末數仍然顯示在方案清單下方，想自己算的人算得到。
   */


  // =====================================================================
  // 比賽週通行證：一個 Grand Prix = 一個商品
  //
  // ⚠️ **所有時間都用瀏覽器的時區顯示。** 伺服器一律回 UTC 秒，
  //    這裡才轉。把時區換算放在伺服器就得猜使用者在哪裡，
  //    而猜錯的後果是「顯示的排位賽時間不是他要出現的時間」。
  // =====================================================================
  let races = [];
  let showAllUpcoming = false;
  const UPCOMING_DEFAULT = 2;

  const TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  })();

  /** 場次時間。顯示成「10/9（五）21:30」。 */
  function fmtSession(sec) {
    if (!sec) return '—';
    const d = new Date(sec * 1000);
    const day = new Intl.DateTimeFormat('zh-TW', {
      timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short',
    }).format(d);
    const time = new Intl.DateTimeFormat('zh-TW', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
    return day + ' ' + time;
  }

  /** 比賽週日期範圍。 */
  function fmtRange(a, b) {
    const f = (x) => new Intl.DateTimeFormat('zh-TW', {
      timeZone: TZ, month: 'numeric', day: 'numeric',
    }).format(new Date(x + 'T12:00:00Z'));
    return f(a) + ' – ' + f(b);
  }

  /** 距離某個時間還有多久。用於「剩餘時間」。 */
  function fmtLeft(sec) {
    const s = sec - Math.floor(Date.now() / 1000);
    if (s <= 0) return '';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    if (d > 0) return d + ' 天 ' + h + ' 小時';
    const m = Math.floor((s % 3600) / 60);
    return h + ' 小時 ' + m + ' 分';
  }

  const ST_LABEL = { upcoming: '即將開始', live: '比賽週進行中', finished: '已結束' };

  function raceCard(g) {
    const el = document.createElement('div');
    el.className = 'plan gp' + (g.purchasable ? '' : ' locked');
    el.dataset.key = 'week';
    el.dataset.gp = g.id;

    // 場次時間。**推估值一定要標示**，不可以讓人以為是官方公布的時間。
    const sess = (g.sessions || []).map((s) =>
      `<div class="sRow"><span>${esc(s.label)}</span><b>${fmtSession(s.at)}</b></div>`).join('');

    const bits = [];
    if (g.sprint) bits.push('<span class="tag">衝刺賽週</span>');
    if (g.tentative) bits.push('<span class="tag warnTag">賽程待 F1 官方確認</span>');
    if (g.status === 'live') bits.push('<span class="tag liveTag">進行中</span>');
    if (!g.purchasable) bits.push('<span class="tag">已結束</span>');

    el.innerHTML =
      `<button type="button" class="planHead"${g.purchasable ? '' : ' disabled'}>
         <span class="planName"><span class="flag">${g.flag || '🏁'}</span> ${esc(g.label)}</span>
         <span class="planPrice">${g.purchasable ? money(g.price) : '—'}</span>
       </button>
       <div class="planNote">
         ${esc(g.country)}　·　${esc(g.circuit)}　·　${fmtRange(g.startDate, g.endDate)}
         ${bits.length ? '　' + bits.join(' ') : ''}
       </div>
       <div class="gpTimes">
         <div class="sRow"><span>第一場賽事</span><b>${fmtSession(g.firstSessionAt)}</b></div>
         <div class="sRow"><span>排位賽</span><b>${fmtSession(g.qualiAt)}</b></div>
         <div class="sRow"><span>正賽</span><b>${fmtSession(g.raceAt)}</b></div>
       </div>
       <details class="planMore">
         <summary>完整場次與通行證效期</summary>
         <div>
           <div class="gpTimes">${sess}</div>
           <p class="hint">
             <b>通行證效期</b><br>
             生效：${g.status === 'upcoming' ? fmtSession(g.validFrom) + '（比賽週開始時）' : '購買後立即生效'}<br>
             失效：${fmtSession(g.validUntil)}
             ${g.nextLabel ? `（${esc(g.nextLabel)}第一場賽事前）` : '（本賽季最後一站，正賽後七日）'}
             ${g.purchasable && g.status !== 'upcoming' ? `<br>剩餘：${fmtLeft(g.validUntil)}` : ''}
           </p>
           <p class="hint">
             ${g.estimated
    ? '⚠️ <b>場次時間為依往例推估</b>，實際時間以 F1 官方公布為準。'
      + '通行證的效期會跟著官方時間自動調整，不需要您做任何事。'
    : '場次時間來自官方賽程。'}
             <br>時間已換算為您的時區（${esc(TZ)}）。
           </p>
         </div>
       </details>`;

    if (g.purchasable) {
      el.querySelector('.planHead').onclick = () => toggleGp(g.id);
    }
    return el;
  }

  function toggleGp(id) {
    const k = 'week:' + id;
    if (cart.has(k)) cart.delete(k); else cart.set(k, 1);
    paintSelection();
    refreshQuote();
  }

  function renderRaces() {
    const up = races.filter((r) => r.purchasable);
    const past = races.filter((r) => !r.purchasable);

    const shown = showAllUpcoming ? up : up.slice(0, UPCOMING_DEFAULT);
    $('gpUpcoming').replaceChildren(...shown.map(raceCard));

    const more = $('gpMore');
    if (up.length > UPCOMING_DEFAULT) {
      more.hidden = false;
      more.textContent = showAllUpcoming
        ? '收合，只看最近兩場'
        : `顯示其餘 ${up.length - UPCOMING_DEFAULT} 場（本賽季共 ${up.length} 場可購買）`;
      more.onclick = () => { showAllUpcoming = !showAllUpcoming; renderRaces(); };
    } else more.hidden = true;

    $('gpPast').replaceChildren(...past.map(raceCard));
    if (!past.length) $('catPast').hidden = true;
    paintSelection();
  }

  function renderPlans(d) {
    seasonInfo = d.season || null;
    races = Array.isArray(d.races) ? d.races : [];
    renderRaces();
    // week 已經拆成「每一場一張卡」，不要在賽季區再出現一次
    const subs = plans.filter((p) => !/^svc_/.test(p.key) && p.key !== 'week');
    const svcs = plans.filter((p) => /^svc_/.test(p.key));

    $('plans').replaceChildren(...subs.map(card));
    $('services').replaceChildren(...svcs.map(card));

    // 後台可設定的公告。空字串就整塊不顯示。
    const nb = $("notice");
    if (nb) { nb.textContent = d.notice || ""; nb.hidden = !d.notice; }

    // 剩餘比賽週末：讓分段價的理由自己說話，比任何文案都有力
    if (d.season && d.season.weekendsLeft != null) {
      const t = d.season.tentative
        ? `（其中 ${d.season.tentative} 場待 F1 官方確認）` : '';
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = `本賽季尚有 ${d.season.weekendsLeft} 個比賽週末${t}。`;
      $('plans').after(p);
    }
    paintSelection();
  }

  function fmt(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------------------------------------------------------------------
  // 購物車
  // ---------------------------------------------------------------------
  function toggle(key) {
    if (cart.has(key)) { cart.delete(key); return paintSelection(), refreshQuote(); }
    const sel = document.querySelector(`[data-qty="${key}"]`);
    cart.set(key, sel ? (Number(sel.value) || 1) : 1);
    paintSelection();
    refreshQuote();
  }

  /**
   * 調整數量。
   *
   * ⚠️ 上限來自**伺服器給的 maxQty**，不是寫死的。一個月的代訂上限三個月，
   *    而那個數字日後會改——寫死在前端就會與後端漂掉，
   *    然後使用者選得到 4 卻在結帳時被夾回 3。
   */
  function bumpQty(key, delta) {
    const plan = plans.find((p) => p.key === key) || {};
    const max = plan.maxQty || 1;
    const now = cart.get(key) || 1;
    const next = Math.max(1, Math.min(max, now + delta));
    if (next === now) return;
    cart.set(key, next);
    // 商品卡上的下拉也要跟著動，否則兩個地方顯示不同的數字
    const sel = document.querySelector('[data-qty="' + key + '"]');
    if (sel) sel.value = String(next);
    refreshQuote();
  }

  function paintSelection() {
    document.querySelectorAll('.plan').forEach((el) => {
      // 比賽週通行證的購物車鍵是 `week:<場次代碼>`，一般方案就是方案代碼
      const k = el.dataset.gp ? ('week:' + el.dataset.gp) : el.dataset.key;
      el.classList.toggle('on', cart.has(k));
    });
  }

  /** 把購物車轉成後端要的格式。比賽週通行證要帶上場次代碼。 */
  function cartItems() {
    return Array.from(cart, ([k, qty]) => {
      const i = k.indexOf(':');
      if (i >= 0) return { key: k.slice(0, i), gp: k.slice(i + 1), qty };
      // 共用帳號的代訂：場次來自卡片上的下拉，不編進購物車的鍵
      const g = document.querySelector('[data-svcgp="' + k + '"]');
      return g ? { key: k, gp: g.value, qty } : { key: k, qty };
    });
  }

  /**
   * 向後端要報價。
   *
   * ⚠️ 用序號擋掉過期的回應。使用者連點幾下時會有多個請求在飛，
   *    先送的可能後到——那時畫面會顯示**上一次**的金額，
   *    而使用者按下結帳時收的是正確的錢。兩個數字不一樣就是糾紛。
   */
  async function refreshQuote() {
    const seq = ++quoteSeq;
    if (!cart.size) { quote = null; paintCart(); validate(); return; }

    const body = {
      items: cartItems(),
      email: $('email').value.trim(),
      upgrade: $('upgrade') ? $('upgrade').checked : false,
      licenseKey: $('upgradeKey') ? $('upgradeKey').value.trim() : '',
    };
    try {
      const r = await fetch(API + '/v1/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (seq !== quoteSeq) return;              // 已經有更新的請求了，丟棄
      quote = r.ok && d.ok ? d : null;
      if (!quote) showMsg(d && d.error ? d.error : '無法計算金額，請稍後再試', true);
      else showMsg('');
    } catch (e) {
      if (seq !== quoteSeq) return;
      quote = null;
      showMsg('無法連線到伺服器，請檢查網路', true);
    }
    paintCart();
    validate();
  }

  /**
   * 購物車。
   *
   * ⚠️ **數量欄要誠實。** 一場一份的商品（比賽週通行證、共用帳號代訂）
   *    顯示純數字，不給加減鈕——給一個按了不會有反應的按鈕，
   *    比不給更糟：使用者會以為壞掉。
   *
   * ⚠️ 每一列都有移除鈕。沒有的話，要拿掉一項就得回到上面的商品卡再點一次，
   *    而那時他已經不記得自己選了哪一張。
   */
  function paintCart() {
    const box = $('cart');
    if (!quote) { box.hidden = true; return; }
    box.hidden = false;

    $('cartLines').replaceChildren(...quote.lines.map((l) => {
      const row = document.createElement('div');
      row.className = 'cartRow';
      row.setAttribute('role', 'row');

      // 這一項在購物車裡的鍵。比賽週通行證是 `week:<場次>`，其餘就是方案代碼。
      const key = l.gp && l.key === 'week' ? ('week:' + l.gp) : l.key;
      const plan = plans.find((p) => p.key === l.key) || {};
      const canQty = (plan.maxQty || 1) > 1;

      // 比賽週通行證要在購物車裡就看得到效期——那是這個商品最容易誤會的地方。
      const notes = [];
      if (l.validUntil) {
        notes.push('效期至 ' + fmtSession(l.validUntil)
          + (l.nextLabel ? '（' + esc(l.nextLabel) + '比賽週開始前）' : ''));
      }
      if (l.note) notes.push(esc(l.note));

      const qtyCell = canQty
        ? '<span class="qtyBox">'
          + '<button type="button" class="qtyBtn" data-dec="' + key + '"'
          + (l.qty <= 1 ? ' disabled' : '') + ' aria-label="減少數量">−</button>'
          + '<b>' + l.qty + '</b>'
          + '<button type="button" class="qtyBtn" data-inc="' + key + '"'
          + (l.qty >= (plan.maxQty || 1) ? ' disabled' : '') + ' aria-label="增加數量">+</button>'
          + '</span>'
        : '<span class="qtyFixed">' + l.qty + '</span>';

      row.innerHTML = '<span class="cItem"><b>' + esc(l.label) + '</b>'
        + (notes.length ? '<em>' + notes.join('　·　') + '</em>' : '') + '</span>'
        + '<span class="cQty" data-label="數量">' + qtyCell + '</span>'
        + '<span class="cPrice" data-label="單價">' + money(l.unit) + '</span>'
        + '<span class="cSum" data-label="小計">' + money(l.sum) + '</span>'
        + '<span class="cDel"><button type="button" class="delBtn" data-del="' + key
        + '" aria-label="從購物車移除">×</button></span>';
      return row;
    }));

    // 事件一次綁完。**用委派會更省，但這裡每次重畫都是全新的節點，
    // 直接綁反而不會有「舊監聽器殘留」的問題。**
    $('cartLines').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => { cart.delete(b.dataset.del); paintSelection(); refreshQuote(); };
    });
    $('cartLines').querySelectorAll('[data-inc]').forEach((b) => {
      b.onclick = () => { bumpQty(b.dataset.inc, 1); };
    });
    $('cartLines').querySelectorAll('[data-dec]').forEach((b) => {
      b.onclick = () => { bumpQty(b.dataset.dec, -1); };
    });

    $('cartAdj').replaceChildren(...(quote.adjustments || []).map((a) => {
      const row = document.createElement('div');
      row.className = 'cartRow adj';
      row.innerHTML = '<span>' + esc(a.label) + '</span><span>' + money(a.amount) + '</span>';
      return row;
    }));

    $('cartTotal').textContent = money(quote.total);

    const notes = [];
    if (quote.needsVpn) notes.push('代訂方案觀看時需自備 VPN，本服務不包含 VPN。');
    if (quote.hasManual) notes.push('代訂為人工服務，將於收款後三個工作日內完成。');
    // ⚠️ 這句話以前寫的是「將直接為您升級，不另行收費」，
    //    但程式碼並沒有那條流程，照樣會把人送去綠界收款——**畫面在說謊**。
    //    在真的做出自動免費升級之前，這裡只能說實話。
    if (quote.freeUpgrade) {
      notes.push('差額低於 NT$30，低於金流的最低收款金額，'
        + '請來信 pitlingo.office@gmail.com 附上授權碼，我們會直接為您升級。');
    }
    $('cartNote').textContent = notes.join(' ');
    // **折抵失敗一定要說出原因。** 只看到金額沒變，使用者會以為系統壞了。
    const cn = $('creditNote');
    if (cn) { cn.textContent = quote.creditNote || ''; cn.className = quote.creditNote ? 'warnText' : ''; }
  }

  // ---------------------------------------------------------------------
  // 結帳
  // ---------------------------------------------------------------------
  function showMsg(text, isErr) {
    const el = $('msg');
    el.className = 'msg' + (isErr ? ' err' : '');
    el.textContent = text || '';
  }

  function validate() {
    const okMail = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test($('email').value.trim());
    const ready = !!quote && cart.size > 0 && okMail && $('agree').checked;
    $('go').disabled = !ready;
    $('go').textContent = quote && cart.size
      ? `前往付款　${money(quote.total)}`
      : '請先選擇方案';
  }

  $('email').addEventListener('input', () => {
    validate();
    // email 會影響升級抵扣的金額，所以要重算
    if ($('upgrade') && $('upgrade').checked) refreshQuote();
  });
  $('agree').addEventListener('change', validate);
  if ($('upgrade')) $('upgrade').addEventListener('change', () => {
    if ($('upgradeKeyWrap')) $('upgradeKeyWrap').hidden = !$('upgrade').checked;
    refreshQuote();
  });
  if ($('upgradeKey')) $('upgradeKey').addEventListener('input', refreshQuote);

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('go').disabled) return;
    $('go').disabled = true;
    showMsg('前往付款頁…');

    try {
      const r = await fetch(API + '/v1/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: cartItems(),
          email: $('email').value.trim(),
          agreed: true,
          upgrade: $('upgrade') ? $('upgrade').checked : false,
          licenseKey: $('upgradeKey') ? $('upgradeKey').value.trim() : '',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));

      // 備援：萬一導回時拿不到訂單編號（例如使用者手動開 /paid），
      // 至少同一個分頁還記得剛才下的是哪一筆。
      // 主要路徑是 Worker 的 /v1/payment/result 帶 ?no= 轉回來。
      try { sessionStorage.setItem('pl_order', d.orderId || ''); } catch (e) { /* 無痕模式 */ }

      // 綠界只收 form post，不收 fetch
      const f = $('ecpay');
      f.action = d.action;
      f.replaceChildren(...Object.entries(d.params).map(([k, v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = v;
        return i;
      }));
      f.submit();
    } catch (e) {
      $('go').disabled = false;
      validate();
      showMsg(String(e.message || e) + '　若持續發生請來信 pitlingo.office@gmail.com', true);
    }
  });

  // 有賽季方案可選時才顯示升級選項
  loadPlans().then(() => {
    const hasSeason = plans.some((p) => /^season/.test(p.key));
    if ($('upgradeWrap')) $('upgradeWrap').hidden = !hasSeason;
    validate();
  });
})();
