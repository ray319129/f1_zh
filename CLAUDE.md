# CLAUDE.md — 給 Claude Code 的專案指引

> 這個檔案會在每次 session 自動載入。**跨電腦接手時，讀完這裡再讀 `handoff.md` 就能完全銜接。**

## 專案是什麼

F1TV 繁體中文即時字幕工具。攔截 F1TV 官方英文 CC，經 Claude Haiku 翻譯成台灣用語繁中，雙語疊字顯示。
目前在**商業化準備階段**。**品牌已定案：PitLingo**。

## 文件地圖 — 先讀這些，不要重新推導

| 檔案 | 內容 | 何時讀 |
|---|---|---|
| **`handoff.md`** | **單一事實來源**。技術事實、架構、決策紀錄、8 個踩過的坑、成本演進、商業計畫、風險防禦、路線圖 | **一定要讀** |
| `TUTORIAL.md` | 安裝、使用、疑難排解、術語表維護、開發者指南 | 動程式碼前 |
| `GO-TO-MARKET.md` | 社群、推廣、金流、客服 SOP、指標 | 談商業化時 |
| `F1TV_即時繁體中文字幕工具_產品與Launch整合企劃.md` | 使用者與 ChatGPT 討論的產品與 Launch 企劃（品牌、定價、Landing Page、社群、時程） | 談品牌／定價／Launch 時 |
| `backend/README.md` | Cloudflare Workers 後端部署與 API | 動後端時 |

## 工作規則（使用者明確要求）

1. **每次修改程式碼，必須同步更新 `handoff.md`（版本號 + 更新紀錄）與 `TUTORIAL.md` 受影響段落。** 不需要使用者提醒。
2. 改動 `SYSTEM_PROMPT` 後，提醒使用者跑選單的「🧮 檢查 token 數」確認 ≥ 4096。
3. 修改後執行 `node --check` 驗證語法。
4. 使用者已明確決定**不再討論 F1TV 條款的法務風險**。企劃書把法務列為 P0 並會找律師確認——尊重該安排，不要重複勸阻。
5. 回應用**繁體中文**。

## 絕對不要犯的錯（詳見 handoff.md 第 5 節）

| # | 鐵則 |
|---|---|
| 1 | 讀 DOM 文字**一律用 `textContent`**。`innerText` 對 `visibility:hidden` 的元素回傳空字串 |
| 2 | **網址絕不截斷**。F1TV 的 master m3u8 帶著很長的 base64 授權 token |
| 3 | **任何輪詢裡的重試都要有上限**，否則會無限重試洗版並打 CDN |
| 4 | **不要相信「註冊一次就永遠有效」**。SPA 會重建 DOM，observer 會靜默失聯——必須有主動輪詢備援 |
| 5 | 探索期的 log 不要被自己要偵錯的過濾器擋住 |
| 6 | 批次要用「**最長等待**」聚合，不是 debounce（debounce 會無限延後） |
| 7 | worker 內只 clone 小的文字類回應，否則持續 clone 影片分段會吃爆記憶體 |
| 8 | `URL.createObjectURL` 的 patch 必須用 `instanceof Blob` 過濾，**絕不能碰到 MediaSource**（那是影片本身） |

## 關鍵技術事實（已實測，不要重新驗證）

- F1TV 用 **HLS**，自訂播放器（CSS 前綴 `tm-`），核心是約 7MB 的 **WASM**
- **串流網路請求全在 blob Web Worker 內**，主執行緒 patch `fetch`/`XHR` 攔不到
- **`video.textTracks.length === 0`** — 沒有原生字幕軌
- 字幕 DOM：`.tm-subtitle-region-container` → `.tm-ui-subtitle-label` → `span`
- master m3u8 在 `ott-video-fer-cf.formula1.com/v2/pa_<base64 token>/...`，token `ttl:1440`（24 小時）
- 字幕軌以標準 HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` 宣告
- **cue 提前量中位數約 47~53 秒**（VTT 抵達 → 畫面顯示）
- 1 小時內容約 **1,101 句字幕、622 個 VTT 分段**

## 架構摘要

**三層取得字幕（自動降級，任何一層失效只是變貴，不會壞）**
1. 整軌預抓（僅重播）→ 2. Worker 注入即時攔截 → 3. DOM 逐句翻譯

**顯示路徑（獨立於上述）**
每 250ms 主動輪詢 DOM（主力）+ MutationObserver（加速器）

**共用譯文後端**（`backend/`，Cloudflare Workers + KV）
同一支影片的譯文所有人共用，第一次翻完之後零 API 成本

## 成本現況

| 版本 | 每句 | 2 小時正賽 |
|---|---|---|
| 起點（純逐句） | $0.00083 | $1.66 |
| 現在（整軌預抓） | $0.000155 | **約 $0.31** |
| 共用快取命中 | — | **≈ $0** |

輸出 token 佔 65%，是物理地板。輸入端已無優化空間。

## 環境

- Windows、PowerShell（Bash 工具也可用）
- 主程式：`f1tv-zh-subtitles.user.js`（Tampermonkey userscript）
- 後端：`backend/`（Cloudflare Workers，`wrangler deploy`）
- API key 存在 Tampermonkey 的 `GM_setValue`，**不在程式碼裡**
- `.gitignore` 已排除 `c api.txt`、`*.csv` 等機密與個資


## 擴充功能的關鍵事實（P2，2026-08-16 驗證）

- **必須用雙 world**：MAIN 負責注入 blob worker，ISOLATED 才有 `chrome.*` API
- **PLAY API 那條路走不通**（八個版本），程式碼保留但 `USE_PLAY_API = false`
- **F1TV 有 Imperva 機器人防護**（`reese84` cookie）——任何需要大量呼叫
  F1TV API 的設計都不可行；Worker 注入零額外流量，反而最安全
- 注入的 worker 腳本 **707,103 bytes**，與 userscript 攔到的完全一致

## 目前進度

| 階段 | 狀態 |
|---|---|
| 個人自用版 | ✅ 完成並驗證 |
| P0 免費開源驗證 | ⬜ 建議補做 |
| P1 共用譯文後端 | ✅ 已部署並驗證（100% 命中） |
| P2 MV3 擴充功能 | 🟢 v0.3.0 提前量已打通（Worker 注入） |
| P3 商業化（金流／授權／Trial） | ⬜ |
| P4 Chrome Web Store 上架 | ⬜ |

**最新待辦見 `handoff.md` 第 9、10 節。**
