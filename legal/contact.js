/*
 * 客服工單表單。
 *
 * 送出後**一定要顯示工單編號**——那是使用者唯一能追蹤的東西，
 * 也是客服對得起來的鍵。只說「已送出」等於什麼都沒給。
 */
(function () {
  'use strict';

  const API = 'https://api.pitlingo.com';
  const $ = (id) => document.getElementById(id);

  function validate() {
    const okMail = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test($('contact').value.trim());
    const okMsg = $('message').value.trim().length >= 5;
    $('go').disabled = !(okMail && okMsg);
  }

  ['contact', 'message'].forEach((id) => $(id).addEventListener('input', validate));

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('go').disabled) return;
    $('go').disabled = true;
    $('msg').className = 'msg';
    $('msg').textContent = '送出中…';

    try {
      const r = await fetch(API + '/v1/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contact: $('contact').value.trim(),
          orderId: $('orderId').value.trim(),
          message: $('message').value.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));

      $('ticket').textContent = d.ticket;
      $('done').hidden = false;
      $('form').hidden = true;
      $('done').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      $('go').disabled = false;
      validate();
      $('msg').className = 'msg err';
      // 送不出去時一定要給退路，否則使用者就真的沒有辦法聯絡我們了
      $('msg').textContent = String(e.message || e)
        + '　請改寄 pitlingo.office@gmail.com';
    }
  });

  validate();
})();
