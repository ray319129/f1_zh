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
    if (p.gp) bits.push(`即刻可用，效期至 ${fmt(p.gp.expiresAt)}（涵蓋${p.gp.name}大獎賽）`);
    if (p.limit) bits.push(`限量 ${p.limit} 組`);
    if (p.vpn) bits.push('<b class="warn">觀看時需自備 VPN</b>');
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
    const qtyBox = p.maxQty > 1
      ? `<div class="planQty">
           <label>站數
             <select data-qty="${p.key}">
               ${Array.from({ length: p.maxQty }, (_, i) =>
    `<option value="${i + 1}">${i + 1}</option>`).join('')}
             </select>
           </label>
           <span class="hint">一次可買到本賽季結束（還有 ${p.maxQty} 站）</span>
         </div>`
      : '';

    el.innerHTML =
      `<button type="button" class="planHead">
         <span class="planName">${esc(p.label)}</span>
         <span class="planPrice">${money(p.price)}</span>
       </button>`
      + qtyBox
      + (bits.length ? `<div class="planNote">${bits.join('　·　')}</div>` : '')
      + (desc ? `<details class="planMore"><summary>商品說明</summary><div>${desc}</div></details>` : '');

    // 選取與展開是兩件事，必須綁在不同的元素上
    if (p.locked) {
      el.querySelector('.planHead').disabled = true;
    } else {
      el.querySelector('.planHead').onclick = () => { toggle(p.key); };
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

  function renderPlans(d) {
    seasonInfo = d.season || null;
    const subs = plans.filter((p) => !/^svc_/.test(p.key));
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

  function paintSelection() {
    document.querySelectorAll('.plan').forEach((el) => {
      el.classList.toggle('on', cart.has(el.dataset.key));
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
      items: Array.from(cart, ([key, qty]) => ({ key, qty })),
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

  function paintCart() {
    const box = $('cart');
    if (!quote) { box.hidden = true; return; }
    box.hidden = false;

    $('cartLines').replaceChildren(...quote.lines.map((l) => {
      const row = document.createElement('div');
      row.className = 'cartRow';
      row.innerHTML = `<span>${esc(l.label)}${l.qty > 1 ? ` × ${l.qty}` : ''}`
        + `${l.note ? `<em>${esc(l.note)}</em>` : ''}</span>`
        + `<span>${money(l.sum)}</span>`;
      return row;
    }));

    $('cartAdj').replaceChildren(...(quote.adjustments || []).map((a) => {
      const row = document.createElement('div');
      row.className = 'cartRow adj';
      row.innerHTML = `<span>${esc(a.label)}</span><span>${money(a.amount)}</span>`;
      return row;
    }));

    $('cartTotal').textContent = money(quote.total);

    const notes = [];
    if (quote.needsVpn) notes.push('代訂方案觀看時需自備 VPN，本服務不包含 VPN。');
    if (quote.hasManual) notes.push('代訂為人工服務，將於收款後三個工作日內完成。');
    if (quote.freeUpgrade) notes.push('差額低於 NT$30，將直接為您升級，不另行收費。');
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
          items: Array.from(cart, ([key, qty]) => ({ key, qty })),
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
