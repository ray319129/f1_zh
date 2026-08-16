/*
 * 購買頁。
 *
 * 這頁唯一會「送出真實金錢請求」的地方，所以每一步都要擋在前面：
 *   - 沒選方案不能按
 *   - email 格式不對不能按
 *   - 沒勾同意不能按（法定要件，後端也會再驗一次）
 *   - 按下去之後立刻鎖住按鈕，避免重複點擊產生兩筆訂單
 */
const API = 'https://api.pitlingo.com';
const $ = (id) => document.getElementById(id);

let plans = [];
let chosen = null;

function money(n) { return 'NT$' + Number(n).toLocaleString(); }

function render() {
  $('plans').innerHTML = plans.map((p) => `
    <button type="button" class="plan${chosen === p.key ? ' on' : ''}${p.soldOut ? ' out' : ''}"
            data-k="${p.key}"${p.soldOut ? ' disabled' : ''}>
      <span class="pname">${p.label}</span>
      <span class="pprice">${money(p.price)}</span>
      <span class="pnote">${p.note}</span>
      ${p.soldOut ? '<span class="pout">已售完</span>' : ''}
    </button>`).join('');

  $('plans').querySelectorAll('button[data-k]').forEach((b) => {
    b.onclick = () => { chosen = b.dataset.k; render(); validate(); };
  });
}

function validate() {
  const emailOk = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test($('email').value.trim());
  const ready = !!chosen && emailOk && $('agree').checked;
  $('go').disabled = !ready;
  $('go').textContent = ready
    ? `前往付款　${money(plans.find((p) => p.key === chosen).price)}`
    : !chosen ? '選擇方案後即可結帳'
    : !emailOk ? '請填寫正確的 email'
    : '請先同意條款';
  return ready;
}

['email', 'agree'].forEach((id) => {
  $(id).addEventListener('input', validate);
  $(id).addEventListener('change', validate);
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) return;

  const btn = $('go');
  btn.disabled = true;
  btn.textContent = '建立訂單中…';
  $('msg').textContent = '';
  $('msg').className = 'msg';

  try {
    const res = await fetch(API + '/v1/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plan: chosen,
        email: $('email').value.trim(),
        agreed: $('agree').checked,
      }),
    });
    const d = await res.json();
    if (!res.ok || !d.ok) throw new Error(d.error || ('HTTP ' + res.status));

    // 綠界要用表單 POST，不能用 fetch —— 使用者必須真的離開到他們的收銀台
    const f = $('ecpay');
    f.action = d.action;
    f.innerHTML = '';
    for (const [k, v] of Object.entries(d.params)) {
      const i = document.createElement('input');
      i.type = 'hidden'; i.name = k; i.value = v;
      f.appendChild(i);
    }
    btn.textContent = '前往綠界付款…';
    f.submit();
  } catch (err) {
    btn.disabled = false;
    validate();
    $('msg').className = 'msg err';
    $('msg').textContent = String(err.message || err) + '　若持續發生請來信 pitlingo.office@gmail.com';
  }
});

// 早鳥剩幾組要即時反映——寫死「限量 20」但實際賣完了，是最容易被抱怨的那種
(async () => {
  let earlyLeft = null;
  try {
    const r = await fetch(API + '/v1/plans');
    if (r.ok) { const d = await r.json(); earlyLeft = d.earlyLeft; }
  } catch (e) { /* 拿不到就當還有，後端結帳時會再判一次 */ }

  plans = [
    {
      key: 'season_early', label: 'Season Early Access', price: 399,
      note: '限量 20 組　·　效期至賽季結束（隔年 1/31）',
      soldOut: earlyLeft === 0,
    },
    {
      key: 'season', label: 'Season', price: 599,
      note: '效期至賽季結束（隔年 1/31）',
      soldOut: false,
    },
  ];
  if (earlyLeft !== null && earlyLeft > 0) {
    plans[0].note = `僅剩 ${earlyLeft} 組　·　效期至賽季結束（隔年 1/31）`;
  }
  render();
  validate();
})();
