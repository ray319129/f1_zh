const API = 'https://api.pitlingo.com';
const out = document.getElementById('out');

// 綠界會用 POST 導回來，參數在表單裡；直接開啟時則在 query string。
// 兩種都要能取到訂單編號。
function orderNo() {
  const q = new URLSearchParams(location.search).get('no')
    || new URLSearchParams(location.search).get('MerchantTradeNo');
  return q || sessionStorage.getItem('pl_order') || '';
}

function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function render(html) { out.innerHTML = html; }

async function check() {
  const no = orderNo();
  if (!no) {
    return render(`<h1>找不到訂單</h1>
      <p class="lead">請從付款完成的頁面回到這裡，或直接查看你的 email。</p>
      <p>授權碼會寄到你結帳時填寫的信箱。若沒收到，請來信
      <a href="mailto:pitlingo.office@gmail.com">pitlingo.office@gmail.com</a>。</p>`);
  }
  sessionStorage.setItem('pl_order', no);

  let d;
  try {
    const r = await fetch(`${API}/v1/order?no=${encodeURIComponent(no)}`);
    d = await r.json();
  } catch (e) {
    return render(`<h1>暫時查不到</h1>
      <p class="lead">網路或伺服器暫時有問題，但<b>這不影響你的訂單</b>。</p>
      <p>稍後重新整理，或直接查看 email。訂單編號：<code>${esc(no)}</code></p>`);
  }

  if (d.status === 'paid') {
    return render(`<h1>付款完成</h1>
      <p class="lead">謝謝你的支持。這是你的授權碼：</p>
      <div class="key">${esc(d.licenseKey)}</div>
      <p>同一份也已寄到你的信箱。<b>請保存好</b>——它跟著你走，換電腦、重灌都能用同一組啟用。</p>
      <h2>接下來</h2>
      <ol class="steps">
        <li>安裝 PitLingo 擴充功能</li>
        <li>點擴充功能圖示 → <b>授權</b> → 貼上授權碼 → 啟用</li>
        <li>打開 F1TV 影片，記得在播放器開啟英文字幕（CC）</li>
      </ol>
      <p class="hint">最多可在 3 台裝置同時啟用，可自行解除後轉移。</p>`);
  }

  if (d.status === 'awaiting_payment') {
    const p = d.payment || {};
    const rows = [
      p.bank && ['銀行代碼', p.bank],
      p.vAccount && ['繳費帳號', p.vAccount],
      p.payNo && ['超商繳費代碼', p.payNo],
      p.expire && ['繳費期限', p.expire],
    ].filter(Boolean);
    return render(`<h1>尚未完成付款</h1>
      <p class="lead">已為你取得繳費資訊。<b>完成繳費後授權碼才會寄出</b>，通常在款項入帳後幾分鐘內。</p>
      <table class="pay">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      <p>同樣的資訊綠界也會寄到你的信箱。訂單編號：<code>${esc(no)}</code></p>
      <p class="hint">繳費完成後回到這頁重新整理，就會看到授權碼。</p>`);
  }

  if (d.status === 'pending') {
    return render(`<h1>處理中</h1>
      <p class="lead">我們還沒收到付款通知。若你剛完成付款，請稍等幾分鐘後重新整理。</p>
      <p>訂單編號：<code>${esc(no)}</code></p>
      <button onclick="location.reload()">重新整理</button>`);
  }

  render(`<h1>查無此訂單</h1>
    <p class="lead">訂單編號 <code>${esc(no)}</code> 沒有紀錄。</p>
    <p>若你確實付了款，請來信
    <a href="mailto:pitlingo.office@gmail.com">pitlingo.office@gmail.com</a> 並附上訂單編號，我們會處理。</p>`);
}

check();
