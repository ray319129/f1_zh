/*
 * 設定頁／彈出視窗。
 *
 * 設計原則：
 *   1. **打開就看得到現在是什麼狀況。** 使用者按圖示多半是因為「怎麼沒字幕」，
 *      不是想調字級。所以狀態放最上面，而且每個錯誤都要說「現在能做什麼」。
 *   2. **每個非同步動作都要有失敗的樣子。** 後端掛掉、沒開 F1TV、權杖過期，
 *      都不能只是靜靜地沒反應。
 *   3. **授權跟著人走。** 這裡要讓使用者清楚知道換電腦不會失效，
 *      並且能自己管理裝置——不要讓他寫信問客服。
 */
(function () {
  'use strict';

  const { sanitizeSettings, DEFAULT_SETTINGS, BACKEND } = self.PL;
  const $ = (id) => document.getElementById(id);

  const TOGGLES = ['enabled', 'showEnglish', 'hideNativeCC', 'debug'];
  const RANGES = ['fontSize', 'bottomPct', 'holdMs'];

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  // ---------------------------------------------------------------------
  // 與 service worker / content script 通訊
  // ---------------------------------------------------------------------
  function sw(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false, error: '沒有回應' }));
        });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }

  /** 對目前的 F1TV 分頁說話。沒有那個分頁時要明確講，不要靜靜失敗。 */
  function toTab(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: 'https://f1tv.formula1.com/*' }, (tabs) => {
        if (!tabs || !tabs.length) return resolve({ ok: false, noTab: true });
        chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false }));
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // 狀態卡
  // ---------------------------------------------------------------------
  function setStatus(level, text, detail, actionHtml) {
    $('dot').className = 'dot ' + level;
    $('statusText').textContent = text;
    $('statusDetail').textContent = detail || '';
    const a = $('statusAction');
    if (actionHtml) { a.innerHTML = actionHtml; a.hidden = false; } else { a.hidden = true; }
  }

  async function refreshStatus() {
    if (!settings.enabled) {
      return setStatus('', '翻譯已關閉', '在下方「顯示」把它打開即可。收割仍會在背景進行。');
    }

    const st = await sw({ type: 'status' });
    if (!st.ok) {
      return setStatus('err', '無法連線到服務',
        st.error || '', '字幕功能暫時無法使用。請稍後再試，或按下方的「匯出診斷」回報。');
    }

    // 有沒有開著 F1TV 分頁
    const tab = await toTab({ type: 'quickStatus' });
    if (tab.noTab) {
      return setStatus('', '待命中', '打開 F1TV 的影片頁面就會自動開始。');
    }
    if (!tab.ok) {
      return setStatus('warn', '尚未在這個分頁啟動',
        '', '請重新整理 F1TV 的分頁。剛安裝或剛更新時需要重整一次。');
    }

    const s = tab.state || {};
    if (!s.everSawCaption) {
      return setStatus('warn', '尚未偵測到字幕', '',
        '請確認 F1TV 播放器的 <b>英文字幕（CC）已開啟</b>：播放器右下角齒輪 → Subtitles → English。');
    }
    const cached = (s.memo || 0).toLocaleString();
    setStatus('ok', '運作中',
      `本機已有 ${cached} 句譯文` + (s.harvestSkipped ? '　·　這支影片已完整翻譯，不會再花錢' : ''));
  }

  // ---------------------------------------------------------------------
  // 授權
  // ---------------------------------------------------------------------
  let licState = null;

  function fmtDate(sec) {
    if (!sec) return '無期限';
    return new Date(sec * 1000).toLocaleDateString('zh-TW');
  }

  async function refreshLicense() {
    const res = await sw({ type: 'licenseStatus' });
    licState = (res.ok && res.license) || null;
    const active = !!(licState && licState.active);

    $('licActive').hidden = !active;
    $('licInactive').hidden = active;
    if (!active) return;

    $('licPlan').textContent = ({ season: '賽季方案', lifetime: '永久授權', trial: '試用' })[licState.plan] || licState.plan;
    $('licExp').textContent = licState.expiresAt
      ? `有效期至 ${fmtDate(licState.expiresAt)}`
      : '無使用期限';
  }

  $('licActivate').onclick = async () => {
    const key = $('licKey').value.trim();
    const msg = $('licMsg');
    if (!key) { msg.className = 'result err'; msg.textContent = '請先貼上授權碼'; return; }

    $('licActivate').disabled = true;
    msg.className = 'result'; msg.textContent = '啟用中…';
    const res = await sw({ type: 'licenseActivate', licenseKey: key });
    $('licActivate').disabled = false;

    if (res.ok && res.result && res.result.ok) {
      msg.className = 'result ok'; msg.textContent = '啟用成功';
      $('licKey').value = '';
      await refreshLicense();
      return;
    }
    const r = (res.result || {});
    // 裝置上限是最需要好好講的錯誤——使用者要知道「現在能做什麼」
    if (r.needsDeactivate) {
      msg.className = 'result err';
      msg.textContent = r.error || '已達裝置上限';
      showDevices(r.devices || [], key);
      return;
    }
    msg.className = 'result err';
    msg.textContent = r.error || res.error || '啟用失敗，請確認授權碼是否正確';
  };

  function showDevices(devices, key) {
    const box = $('licDeviceList');
    box.hidden = false;
    box.innerHTML = devices.length
      ? devices.map((d) => `<div class="dev"><span>裝置 ${d.id}　<span class="hint">最後使用 ${d.lastSeen ? fmtDate(d.lastSeen) : '—'}</span></span>`
        + `<button class="secondary" data-dev="${d.id}">解除</button></div>`).join('')
      : '<div class="hint">沒有已啟用的裝置。</div>';

    box.querySelectorAll('button[data-dev]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        const res = await sw({ type: 'licenseDeactivate', licenseKey: key || $('licKey').value.trim(), installId: b.dataset.dev });
        if (res.ok && res.result && res.result.ok) {
          b.closest('.dev').remove();
          $('licMsg').className = 'result ok';
          $('licMsg').textContent = '已解除，可以再按一次「啟用」';
        } else {
          b.disabled = false;
          $('licMsg').className = 'result err';
          $('licMsg').textContent = (res.result && res.result.error) || '解除失敗';
        }
      };
    });
  }

  $('licDevices').onclick = async () => {
    const box = $('licDeviceList');
    if (!box.hidden) { box.hidden = true; return; }
    const res = await sw({ type: 'licenseDevices' });
    showDevices((res.ok && res.devices) || [], licState && licState.licenseKey);
  };

  $('licRemove').onclick = async () => {
    // 停用是使用者主動放棄這台的存取權，要再問一次
    if (!confirm('在這台電腦停用授權？\n授權碼不會失效，之後可以再啟用回來。')) return;
    await sw({ type: 'licenseClear' });
    await refreshLicense();
    await refreshStatus();
  };

  // ---------------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------------
  function renderOutputs() {
    $('fontSizeOut').textContent = settings.fontSize + ' px';
    $('bottomPctOut').textContent = settings.bottomPct + ' %';
    $('holdMsOut').textContent = (settings.holdMs / 1000).toFixed(1) + ' 秒';
  }

  function paint() {
    TOGGLES.forEach((k) => { $(k).checked = !!settings[k]; });
    RANGES.forEach((k) => { $(k).value = settings[k]; });
    renderOutputs();
  }

  let saveTimer = null;
  function save() {
    settings = sanitizeSettings(settings);
    renderOutputs();
    // 拉滑桿會連續觸發，節流一下避免狂寫 storage
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ settings }), 120);
  }

  TOGGLES.forEach((k) => { $(k).onchange = () => { settings[k] = $(k).checked; save(); refreshStatus(); }; });
  RANGES.forEach((k) => { $(k).oninput = () => { settings[k] = Number($(k).value); save(); }; });

  // ---------------------------------------------------------------------
  // 疑難排解
  // ---------------------------------------------------------------------
  $('diag').onclick = async () => {
    const btn = $('diag');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '收集中…';
    const res = await toTab({ type: 'collectDiagnostics' });
    btn.disabled = false;

    if (res.noTab) { btn.textContent = '請先打開 F1TV 分頁'; }
    else if (res.ok && res.report) {
      try {
        await navigator.clipboard.writeText(res.report);
        btn.textContent = '已複製到剪貼簿';
      } catch (e) { btn.textContent = '複製失敗，請改用 Console'; }
    } else {
      btn.textContent = '收集失敗，請重整 F1TV 分頁';
    }
    setTimeout(() => { btn.textContent = old; }, 2600);
  };

  $('reloadCfg').onclick = async () => {
    const btn = $('reloadCfg');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '重新載入中…';
    const res = await toTab({ type: 'applyConfigNow' });
    btn.disabled = false;
    btn.textContent = res.noTab ? '請先打開 F1TV 分頁'
      : res.ok ? (res.changed ? `已更新到 v${res.version}` : '已是最新設定')
      : '載入失敗';
    setTimeout(() => { btn.textContent = old; }, 2600);
  };

  $('onboardDone').onclick = () => {
    $('onboard').hidden = true;
    chrome.storage.local.set({ onboarded: true });
  };

  // ---------------------------------------------------------------------
  // 啟動
  // ---------------------------------------------------------------------
  (async () => {
    const st = await chrome.storage.local.get(['settings', 'onboarded']);
    settings = sanitizeSettings(st.settings);
    paint();

    $('onboard').hidden = !!st.onboarded;
    $('ver').textContent = `版本 ${chrome.runtime.getManifest().version}　·　後端 ${BACKEND.replace(/^https:\/\//, '')}`;

    await refreshLicense();
    await refreshStatus();
    // 彈出視窗開著的期間持續更新，使用者才看得到收割進度變化
    setInterval(refreshStatus, 3000);
  })();
})();
