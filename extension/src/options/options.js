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

  // 一般使用者看不到「詳細日誌」——那是開發用的，放出去只會造成困惑。
// 需要時仍可在 F1TV 分頁的 Console 打 `__pitlingo.debug(true)` 打開。
const TOGGLES = ['enabled', 'showEnglish', 'hideNativeCC'];
  // holdMs 已移除：疊字改成跟著原生字幕收掉之後，那個計時器在正常播放時
  // 永遠不會觸發，放在設定頁上只是一個調了不會有反應的旋鈕。
  const RANGES = ['fontSize', 'bottomPct', 'subtitleOffset'];

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
    const detail = `本機已有 ${cached} 句譯文`
      + (s.harvestSkipped ? '　·　本片譯文已完整，將直接套用' : '');

    // 免費模式一定要把剩餘時間放在最顯眼的位置。
    // 使用者要決定買不買，唯一的依據就是「還剩多久」——
    // 把它藏在診斷報告裡等於沒有告訴他。
    if (!s.licensed) {
      if (!s.freeSession) {
        return setStatus('warn', '本片不在免費範圍',
          '免費試看僅涵蓋練習賽、衝刺賽、排位賽與正賽。',
          '啟用授權後即可觀看所有內容。');
      }
      const left = Math.max(0, s.freeLeft || 0);
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
      const total = Math.round((s.freeTotal || 900) / 60);
      if (left <= 0) {
        // 額度用完是**最需要給出路**的一刻。只說「已結束」等於把人擋在門口，
        // 而他此時正是最有意願購買的時候——狀態卡直接給連結，不必讓他自己找。
        return setStatus('warn', '免費試看已結束',
          `本片的免費 ${total} 分鐘已用完，原生英文字幕已恢復顯示。`,
          '<a class="buyBtn" href="https://pitlingo.com/buy" target="_blank" rel="noopener">'
          + '前往購買（NT$39 起）</a>'
          + '<span class="hint">已有授權碼？請於下方「授權」區塊輸入。</span>');
      }
      return setStatus('ok', `免費試看　剩餘 ${mm}:${ss}`,
        `${detail}　·　免費額度共 ${total} 分鐘`
        + (s.playing ? '' : '　·　目前暫停中，不計時'));
    }

    setStatus('ok', '運作中', detail);
  }

  // ---------------------------------------------------------------------
  // 授權
  // ---------------------------------------------------------------------
  let licState = null;

  function fmtDate(sec) {
    if (!sec) return '無期限';
    return new Date(sec * 1000).toLocaleDateString('zh-TW');
  }

  /**
   * @param {boolean} force 向後端重新確認一次，不用等背景那 24 小時的週期。
   *
   * 打開這一頁的當下就是使用者在確認授權狀態的當下。若只讀本機快取，
   * 授權在後台被停用或刪除之後，這裡最長會有 24 小時顯示錯的狀態——
   * **畫面說「已啟用」而伺服器早就不認**，那比顯示不出來更糟。
   */
  async function refreshLicense(force) {
    const res = await sw({ type: 'licenseStatus', force: !!force });
    licState = (res.ok && res.license) || null;
    const active = !!(licState && licState.active);

    $('licActive').hidden = !active;
    $('licInactive').hidden = active;
    if (!active) {
      // 被停用／刪除時要說明原因，否則使用者只看到「未啟用」會以為是自己弄丟了
      const why = licState && licState.reason;
      const el = $('licMsg');
      if (why && el) { el.className = 'result err'; el.textContent = why; }
      return;
    }

    // ⚠️ **方案名稱一律用伺服器回的 planLabel。**
    //    這裡本來寫死一份對照表，裡面還有一個根本不存在的鍵（weekend），
    //    而真正的鍵是 week——所以買一週通行證的人在這一頁看到的是
    //    英文鍵名「week」，而且完全不報錯。
    //    寫死的對照表在方案增減時一定會漂，這是第二次了（後台也發生過）。
    $('licPlan').textContent = licState.planLabel || licState.plan;
    // 買多站的人要看得出自己買了幾站——只顯示一個日期他分不出 1 站與 3 站
    $('licExp').textContent = (licState.gpName ? `${licState.gpName}　` : '')
      + (licState.expiresAt ? `有效期至 ${fmtDate(licState.expiresAt)}` : '無使用期限');
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
    const off = settings.subtitleOffset || 0;
    $('subtitleOffsetOut').textContent = off === 0 ? '跟隨官方字幕'
      : off < 0 ? `延後 ${(-off / 1000).toFixed(1)} 秒`
      : `提前 ${(off / 1000).toFixed(1)} 秒（僅重播）`;
    refreshOffsetLive();
  }

  /**
   * 問正在播放的分頁「這個設定現在真的生效了嗎」。
   *
   * 拿不到分頁不是錯誤——使用者可能只是在設定頁調整。
   * 但**絕對不能靜靜地什麼都不顯示**，那會讓人分不清「沒生效」與「沒查到」。
   */
  let offsetLiveTimer = null;
  function refreshOffsetLive() {
    clearTimeout(offsetLiveTimer);
    offsetLiveTimer = setTimeout(async () => {
      const el = $('offsetLive');
      if (!el) return;
      if ((settings.subtitleOffset || 0) === 0) { el.textContent = '　'; return; }
      const r = await toTab({ type: 'timingStatus' });
      if (r && r.noTab) { el.textContent = '目前狀態：沒有開啟中的 F1TV 分頁，無法確認是否生效'; return; }
      if (!r || !r.ok || !r.timing) { el.textContent = '目前狀態：查不到（請重新整理 F1TV 分頁）'; return; }
      el.textContent = '目前狀態：' + r.timing.text;
    }, 250);
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
  /**
   * 傳送診斷給開發者。
   *
   * 原本是「複製到剪貼簿再自己貼給我」——那對一般使用者太麻煩，
   * 而且他們常常貼一半、貼錯地方，或根本不知道要貼去哪裡。
   *
   * 改成直接送到後端並回一個工單編號。使用者只要記那組編號，
   * 客服對得起來就好。
   */
  $('rpSend').onclick = async () => {
    const btn = $('rpSend');
    const out = $('rpResult');
    btn.disabled = true;
    out.hidden = false; out.className = 'rpResult'; out.textContent = '收集中…';

    const got = await toTab({ type: 'collectDiagnostics' });
    if (got.noTab) {
      btn.disabled = false;
      out.className = 'rpResult err';
      out.textContent = '請先打開 F1TV 的分頁，我們才收集得到運作狀態。';
      return;
    }
    if (!got.ok || !got.report) {
      btn.disabled = false;
      out.className = 'rpResult err';
      out.textContent = '收集失敗。請重新整理 F1TV 的分頁後再試一次。';
      return;
    }

    out.textContent = '傳送中…';
    const res = await sw({
      type: 'sendReport',
      report: got.report,
      note: $('rpNote').value.trim(),
      contact: $('rpContact').value.trim(),
      version: chrome.runtime.getManifest().version,
    });
    btn.disabled = false;

    if (res.ok && res.result && res.result.ticket) {
      out.className = 'rpResult ok';
      out.innerHTML = '已送出，謝謝你的回報。<br>詢問進度時請提供這組編號：'
        + `<div class="ticket">${res.result.ticket}</div>`;
      $('rpNote').value = '';
    } else {
      // 送不出去時要給一條退路，不能讓使用者卡在這裡
      out.className = 'rpResult err';
      out.textContent = ((res.result && res.result.error) || res.error || '傳送失敗')
        + '。可以稍後再試，或到 Console 打 __pitlingo.diag() 自行複製。';
    }
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

    // 開啟這一頁時強制向後端確認一次，不要拿最多過時 24 小時的本機狀態去顯示
    await refreshLicense(true);
    await refreshStatus();
    // 彈出視窗開著的期間持續更新，使用者才看得到收割進度變化
    setInterval(refreshStatus, 3000);
  })();
})();
