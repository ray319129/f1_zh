/**
 * 選項頁
 *
 * 所有設定寫進 chrome.storage.local。content script 有掛 storage.onChanged，
 * 所以調整字級或開關會**立刻反映在正在播放的頁面上**，不用重新整理。
 */

const DEFAULTS = {
  enabled: true,
  showEnglish: true,
  fontSize: 26,
  bottomPct: 8,
  holdMs: 7000,
  hideNativeCC: true,
  debug: false,
};

const $ = (id) => document.getElementById(id);
const TOGGLES = ['enabled', 'showEnglish', 'hideNativeCC', 'debug'];
const RANGES = ['fontSize', 'bottomPct', 'holdMs'];

function renderOutputs(s) {
  $('fontSizeOut').textContent = s.fontSize + ' px';
  $('bottomPctOut').textContent = s.bottomPct + ' %';
  $('holdMsOut').textContent = (s.holdMs / 1000).toFixed(1) + ' 秒';
}

async function load() {
  const { settings, clientToken } = await chrome.storage.local.get(['settings', 'clientToken']);
  const s = Object.assign({}, DEFAULTS, settings || {});
  TOGGLES.forEach((k) => { $(k).checked = !!s[k]; });
  RANGES.forEach((k) => { $(k).value = s[k]; });
  $('clientToken').value = clientToken || '';
  renderOutputs(s);
  return s;
}

async function save() {
  const s = {};
  TOGGLES.forEach((k) => { s[k] = $(k).checked; });
  RANGES.forEach((k) => { s[k] = Number($(k).value); });
  renderOutputs(s);
  await chrome.storage.local.set({ settings: s });
}

TOGGLES.concat(RANGES).forEach((k) => {
  $(k).addEventListener('input', save);
  $(k).addEventListener('change', save);
});

$('clientToken').addEventListener('change', async () => {
  await chrome.storage.local.set({ clientToken: $('clientToken').value.trim() });
  $('testResult').textContent = '金鑰已儲存，建議按一次「測試連線」';
  $('testResult').className = 'result';
});

$('test').addEventListener('click', async () => {
  const out = $('testResult');
  out.textContent = '測試中…';
  out.className = 'result';
  const res = await chrome.runtime.sendMessage({ type: 'health' });
  if (res && res.ok) {
    out.textContent = `✅ 連線正常（模型 ${res.health.model}）`;
    out.className = 'result ok';
  } else {
    out.textContent = `❌ 連線失敗：${(res && res.error) || '未知錯誤'}`;
    out.className = 'result err';
  }
});

/**
 * 向 F1TV 分頁的 content script 要一份完整診斷報告並複製到剪貼簿。
 * 報告涵蓋預抓狀態、命中率、事件時間軸——回報問題時貼這一份就夠。
 */
$('diag').addEventListener('click', async () => {
  const out = $('diagResult');
  out.textContent = '收集中…';
  out.className = 'result';
  try {
    const tabs = await chrome.tabs.query({ url: 'https://f1tv.formula1.com/*' });
    if (!tabs.length) {
      out.textContent = '❌ 找不到 F1TV 分頁，請先開啟並播放影片';
      out.className = 'result err';
      return;
    }
    const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'collectDiagnostics' });
    if (!res || !res.ok) throw new Error((res && res.error) || '沒有回應');
    await navigator.clipboard.writeText(res.report);
    out.textContent = `✅ 已複製 ${res.report.length} 字元`;
    out.className = 'result ok';
    console.log(res.report);
  } catch (e) {
    out.textContent = `❌ ${String(e.message || e)}（請重新整理 F1TV 分頁再試）`;
    out.className = 'result err';
  }
});

/**
 * 立刻丟掉設定快取並重抓，然後叫 F1TV 分頁就地套用。
 *
 * 沒有這顆按鈕的話，改了後端設定要等「SW 快取 TTL + content script 重讀間隔」，
 * 最壞約三分鐘——驗證熱修流程時很難確認到底生效了沒。
 * 緊急狀況下自己也用得到。
 */
$('reloadCfg').addEventListener('click', async () => {
  const out = $('reloadCfgResult');
  out.textContent = '重新載入中…';
  out.className = 'result';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'refreshConfig' });
    if (!res || !res.ok) throw new Error((res && res.error) || '沒有回應');
    const v = res.config && res.config.version;

    // 通知所有 F1TV 分頁就地套用，不用等下一次輪詢
    let applied = 0;
    const tabs = await chrome.tabs.query({ url: 'https://f1tv.formula1.com/*' });
    for (const t of tabs) {
      try {
        const r = await chrome.tabs.sendMessage(t.id, { type: 'applyConfigNow' });
        if (r && r.ok) applied++;
      } catch (e) { /* 該分頁還沒載入 content script */ }
    }
    out.textContent = `✅ 設定版本 v${v}，已通知 ${applied} 個 F1TV 分頁套用`;
    out.className = 'result ok';
    refreshStatus();
  } catch (e) {
    out.textContent = `❌ ${String(e.message || e)}`;
    out.className = 'result err';
  }
});

/** 顯示目前分頁的即時狀態，方便自己與使用者排查 */
async function refreshStatus() {
  const lines = [];
  try {
    const cfg = await chrome.runtime.sendMessage({ type: 'getConfig' });
    const v = cfg && cfg.ok ? cfg.config.version : '?';
    lines.push(`遠端設定版本：${v}${v === 0 ? '（內建預設，尚未取得遠端設定）' : ''}`);
  } catch (e) { lines.push('遠端設定：讀取失敗'); }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /f1tv\.formula1\.com/.test(tab.url || '')) {
      lines.push(`目前分頁：${tab.url.slice(0, 80)}`);
    } else {
      lines.push('目前分頁不是 F1TV。請開啟 F1TV 播放頁後再看狀態。');
    }
  } catch (e) { /* popup 以外的情境可能沒有 tabs 權限，忽略 */ }

  $('status').textContent = lines.join('\n');
}

load().then(refreshStatus);
