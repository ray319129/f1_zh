# CLAUDE.md — 給 Claude Code 的專案指引

> 每次 session 自動載入。**跨電腦或清空對話後接手時，讀完這裡再讀 `handoff.md` 就能完全銜接。**

## 專案是什麼

**PitLingo** — F1TV 繁體中文即時字幕。攔截 F1TV 官方英文 CC，經 Claude Haiku 翻成台灣用語繁中，雙語疊字顯示。
目前在**商業化準備階段**，品牌已定案。

三個產物：

| 產物 | 角色 | 版本 |
|---|---|---|
| `f1tv-zh-subtitles.user.js` | Tampermonkey 版；同時當**管理員收割工具**（賽前把譯文灌進共用快取） | v4.8.0 |
| `backend/` | Cloudflare Workers + KV，**共用譯文快取** | v1.7 |
| `extension/` | MV3 擴充功能，**商品化主體** | v0.5.4 |

## 文件地圖 — 先讀這些，不要重新推導

| 檔案 | 內容 | 何時讀 |
|---|---|---|
| **`handoff.md`** | **單一事實來源**。技術事實、架構、決策紀錄、**20 個踩過的坑**、成本演進、商業計畫、風險防禦、路線圖 | **一定要讀** |
| `handoff.md` **9.1** | **下一步清單** | **接手時從這裡開始** |
| `TUTORIAL.md` | userscript 的安裝、使用、疑難排解、**術語表維護** | 動 userscript 前 |
| `extension/README.md` | 擴充功能架構、載入測試、診斷 | 動擴充功能前 |
| `backend/README.md` | Workers 部署與 API | 動後端前 |
| `GO-TO-MARKET.md` | 社群、推廣、金流、客服 SOP、指標 | 談商業化時 |
| `P3-PLAN.md` | **分階段推送、成本後台、金流比較、介面規劃、上線檢查清單** | **做 P3 時從這裡開始** |
| `F1TV_即時繁體中文字幕工具_產品與Launch整合企劃.md` | 品牌、定價、Landing Page、Launch 時程（使用者與 ChatGPT 討論的產物） | 談品牌／定價時 |

## 工作規則（使用者明確要求）

1. **每次修改程式碼，必須同步更新 `handoff.md`（版本號 + 更新紀錄）與對應的 README／TUTORIAL。** 不需要提醒。
2. **每一步都要詳細解釋在做什麼、改了什麼、為什麼。**
3. 修改後跑 `node tools/check-all.js`（含 `node --check` 與四支檢查）。
   **改動擴充功能後 `node --check` 不夠**——它抓不到「宣告被刪掉」這種執行期錯誤，一定要跑 `tools/smoke-extension.js`（見坑 #22）。
4. 改動 userscript 的 `SYSTEM_PROMPT` 後，提醒跑選單的「🧮 檢查 token 數」確認 ≥ 4096。
5. 使用者已決定**不再討論 F1TV 條款的法務風險**。企劃書把法務列為 P0 並會找律師——尊重該安排，不要重複勸阻。
6. 回應用**繁體中文**。

## 絕對不要犯的錯（詳見 `handoff.md` 第 5 節的 20 個坑）

| # | 鐵則 |
|---|---|
| 1 | 讀 DOM 文字**一律用 `textContent`**。`innerText` 對隱藏元素回傳空字串 |
| 2 | **網址絕不截斷**。F1TV 的 master m3u8 帶著很長的 base64 授權 token |
| 3 | **任何輪詢裡的重試都要有上限** |
| 4 | **不要相信「註冊一次就永遠有效」**。SPA 會重建 DOM，observer 會靜默失聯——必須有主動輪詢備援 |
| 5 | 探索期的 log 不要被自己要偵錯的過濾器擋住 |
| 6 | 批次要用「**最長等待**」聚合，不是 debounce |
| 7 | worker 內只 clone 小的文字類回應，否則會吃爆記憶體 |
| 8 | `URL.createObjectURL` 的 patch 必須用 `instanceof Blob` 過濾，**絕不能碰到 MediaSource**（那是影片本身） |
| 9 | **非同步結果回來時世界已經變了**——補顯示前要當場重讀 DOM 比對，不能只信變數 |
| 10 | **KV 寫入是 Cloudflare 免費方案的天花板**（1,000/天），任何「每筆資料寫一次」的設計都要先估算 |
| 18 | **使用者說慢就是慢**。量不到只代表量錯地方——先確認量測範圍涵蓋「出現」與「消失」（坑 #27） |
| 11 | **傳播延遲是所有快取層的總和**，不是最短那層。**已在此跌倒三次**（遠端設定 6 小時／SW bundle 無 TTL／HTTP `max-age=60`）——加快取前先把該路徑上所有層列出來 |
| 12 | **prompt 低於 4,096 tokens 時 `cache_control` 靜默失效**——不報錯，只是每次全額計費 |
| 13 | **在某個檔案學到的規則，要主動確認它在別的檔案成不成立**。坑 #21 就是規則只套用在 userscript、後端漏掉 |
| 14 | **驗證強度要配得上改動性質**。批次刪除後 `node --check` 不夠，少一個宣告在語法上完全合法（坑 #22） |
| 15 | **寫了 `at`／時間戳就要有人去讀它**。快取沒 TTL 不會報錯，只會靜默回舊值（坑 #23） |
| 16 | **KV 沒有 CAS**。任何「讀→慢操作→寫回」都會互相覆蓋，寫回前要重讀合併（坑 #24） |
| 17 | **移植 userscript 的能力時，逐項確認它在沒有 ADMIN_TOKEN 的世界裡還成立**（坑 #25） |

## 關鍵技術事實（已實測，不要重新驗證）

- F1TV 用 **HLS**，自訂播放器（CSS 前綴 `tm-`），核心是約 7MB 的 **WASM**
- **串流網路請求全在 blob Web Worker 內**，主執行緒 patch `fetch`/`XHR` 攔不到
- **`video.textTracks.length === 0`** — 沒有原生字幕軌
- 字幕 DOM：`.tm-subtitle-region-container` → `.tm-ui-subtitle-label` → `span`
- **cue 提前量中位數約 47~53 秒**（VTT 抵達 → 畫面顯示）——這是所有批次策略的預算來源
- 1 小時內容約 **1,101 句字幕、622 個 VTT 分段**
- **F1TV 有 Imperva 機器人防護**（`reese84` cookie）。任何需要大量呼叫 F1TV API 的設計都不可行
- **PLAY API 那條路走不通**（八個版本，詳見 `handoff.md` 7.7）。`USE_PLAY_API = false`

## 架構摘要

**取得字幕（自動降級，任何一層失效只是變貴）**

| | userscript | extension |
|---|---|---|
| 1 | 整軌預抓 | **整軌預抓**（v0.4.0 補上，入口是 worker 攔到的 m3u8，不是 PLAY API） |
| 2 | Worker 注入即時攔截 | **Worker 注入**（MAIN world） |
| 3 | DOM 逐句翻譯 | DOM 逐句翻譯 |

**顯示（獨立於上述）**：每 250ms 主動輪詢 DOM（主力）+ MutationObserver（加速器）

**擴充功能是雙 world**：MAIN 負責注入，ISOLATED 才有 `chrome.*` API，靠 `window.postMessage` 相接。

**⚠️ 兩個跨檔案的硬性契約，壞掉都不會報錯：**

| 契約 | 份數 | 壞掉的後果 | 檢查 |
|---|---|---|---|
| `normKey()` | 3（backend／extension／userscript） | 同一句算出不同快取鍵，共用快取整個失效 | `node tools/check-normkey.js` |
| `SYSTEM_PROMPT` | 2（backend／userscript） | 兩個產物翻出不同結果；低於 4,096 tokens 還會讓 prompt 快取失效 | `node tools/check-prompt.js` |

userscript 必須是單一檔案、backend 由 wrangler 打包，沒辦法共用模組，只能靠檢查工具擋漂移。

## 成本現況（實測）

| 情境 | 每句 | 2 小時正賽 |
|---|---|---|
| 起點（純逐句） | $0.00083 | $1.66 |
| 整軌預抓 | $0.000155 | **約 $0.31** |
| 共用快取命中 | — | **≈ $0** |

輸出 token 佔 65%，是物理地板。輸入端已無優化空間。

## 環境

- Windows、PowerShell（Bash 工具也可用）
- 後端：`cd backend && wrangler deploy`
- 擴充功能：`chrome://extensions` → 載入未封裝項目 → `extension/`。**改 manifest 後必須按「重新載入」**
- API key 存在 Cloudflare secrets 與 Tampermonkey `GM_setValue`，**不在程式碼裡**
- `.gitignore` 已排除機密與 `.wrangler/`

## 測試工具（v0.5.0 起，**上線前必須移除**）

擴充功能的 `main.js` 有一段標著 `TESTING` 的區塊，掛在 `__pitlingo.t.*`。
Console 打 `__pitlingo.help()` 會列出全部。

**移除方式**：刪掉 `TESTING` 常數整段，以及 `window.__pitlingo` 裡的 `t:` 與 `help:` 兩行。
判斷依據：**`help()` 列在「上線前移除」那半邊的東西，正式版一律不該存在**——
它們會繞過防護（強制預抓）或洩漏內部狀態。

`diag()` / `events()` / `state` / `peek()` / `debug()` 要保留，那是回報問題的唯一管道。

## 診斷（回報問題的標準流程）

- 擴充功能：圖示 → **「匯出診斷（複製到剪貼簿）」**
- userscript：油猴選單 → **「📋 匯出完整診斷」**

兩份都含事件時間軸，**刻意不含任何權杖內容**。
**這套診斷已經抓出 6 個肉眼看不到的 bug**——遇到問題先請使用者匯出，不要用猜的。

## 目前進度

| 階段 | 狀態 |
|---|---|
| 個人自用版 | ✅ 完成並驗證 |
| P0 免費開源驗證 | ⬜ 仍建議補做 |
| P1 共用譯文後端 | ✅ 已部署並驗證 |
| P2 MV3 擴充功能 | 🟢 **功能面完成**（命中率 99.5%、遠端設定熱修已驗證），剩形式要件 |
| P3 商業化（金流／授權／Trial） | ⬜ |
| P4 Chrome Web Store 上架 | ⬜ |

**下一步的完整清單見 `handoff.md` 9.1。**
