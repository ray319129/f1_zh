# CLAUDE.md — 給 Claude Code 的專案指引

> 每次 session 自動載入。**跨電腦或清空對話後接手時，讀完這裡再讀 `handoff.md` 就能完全銜接。**

## 專案是什麼

**PitLingo** — F1TV 繁體中文即時字幕。攔截 F1TV 官方英文 CC，經 Claude Haiku 翻成台灣用語繁中，雙語疊字顯示。
目前在**商業化準備階段**，品牌已定案。

三個產物：

| 產物 | 角色 | 版本 |
|---|---|---|
| `f1tv-zh-subtitles.user.js` | Tampermonkey 版；同時當**管理員收割工具**（賽前把譯文灌進共用快取，v4.9.0 起可自動跑整個佇列） | v4.10.5 |
| `backend/` | Cloudflare Workers + KV，**共用譯文快取**、授權閘門、金流、賽程 | v5.9 |
| `extension/` | MV3 擴充功能，**商品化主體** | v0.21.2 |

## 文件地圖 — 先讀這些，不要重新推導

| 檔案 | 內容 | 何時讀 |
|---|---|---|
| **`handoff.md`** | **單一事實來源**。技術事實、架構、決策紀錄、**20 個踩過的坑**、成本演進、商業計畫、風險防禦、路線圖 | **一定要讀** |
| `handoff.md` **9.1** | **下一步清單** | **接手時從這裡開始** |
| `TUTORIAL.md` | userscript 的安裝、使用、疑難排解、**術語表維護** | 動 userscript 前 |
| `extension/README.md` | 擴充功能架構、載入測試、診斷 | 動擴充功能前 |
| `backend/README.md` | Workers 部署與 API | 動後端前 |
| `GO-TO-MARKET.md` | 社群、推廣、金流、客服 SOP、指標 | 談商業化時 |
| `SECURITY.md` | **攻擊面檢視、已修／未修清單、上線前資安檢查** | **上線前必讀** |
| `BUSINESS.md` | **定價、免費層、代訂服務的決策紀錄**（含我提過但未採納的保留意見） | 談商業時 |
| `legal/` | **隱私權政策與使用條款**。已部署到 Cloudflare Pages（專案 `pitlingo`），部署指令：`wrangler pages deploy legal --project-name pitlingo --branch main` | 上架前 |
| `AUDIT-2026-08-16.md` | **全面審查報告**：已修缺陷、刻意接受的風險、尚未驗證的部分、上線前阻擋項 | **接手或上線前必讀** |
| `LIVE-TEST.md` | **直播實測計畫**：五個要量的數字、三個 Chrome 設定檔的做法、判斷要不要做 DO 步驟 4~5 的準則 | **測直播前必讀** |
| `P3-PLAN.md` | **分階段推送、成本後台、金流比較、介面規劃、上線檢查清單** | **做 P3 時從這裡開始** |
| `F1TV_即時繁體中文字幕工具_產品與Launch整合企劃.md` | 品牌、定價、Landing Page、Launch 時程（使用者與 ChatGPT 討論的產物） | 談品牌／定價時 |

## 工作規則（使用者明確要求）

1. **每次修改程式碼，必須同步更新 `handoff.md`（版本號 + 更新紀錄）與對應的 README／TUTORIAL。** 不需要提醒。
2. **每一步都要詳細解釋在做什麼、改了什麼、為什麼。**
3. 修改後跑 `node tools/check-all.js`（8 個語法 + 8 項行為檢查）（含 `node --check` 與四支檢查）。
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
| 18 | **折扣價的取整一律用 floor**。round 會讓 599×1.0 變成 600，比牌價還貴 |
| 19 | **新增設定時問「這會不會關掉某個預設值」**。加 `[[routes]]` 會靜默關閉 workers.dev，所有安裝同時斷線（坑 #32） |
| 20 | **過濾條件不可以只看大小、不看型別**。`n < 300000` 把 HLS 音訊分段全掃進來，clone + 解碼每個分段 → **播放卡頓**，而註解還寫著「只 clone 小的文字類回應」（坑 #33）|
| 22 | **我們的背景請求要讓路給影片**。整軌預抓與影片打同一個 CDN，不標 `priority:'low'`、不看緩衝存量就會讓 ABR 降解析度（坑 #34）|
| 23 | **`node --check` 對 ESM 有盲點**。後端是 ESM 卻用 `.js` 副檔名，尾端多一個逗號它會放行而 wrangler 爆掉 → check-all 已加「以 ESM 解析」（坑 #35）|
| 24 | **正則字面量是延遲編譯的**。`node --check`、`new Function`、`vm.Script`、`esbuild` **四者全部放行**無效的正則，只在執行到那一行才爆炸 → `node tools/check-regex.js`（坑 #36）|
| 25 | **檢查工具載入後端時一定要 `'use strict'`**。`vm.runInContext` 跑的是 script＝非嚴格模式，對未宣告的變數賦值只會建立全域；真正的 Worker 是 ESM＝嚴格模式，同一行是 `ReferenceError`。**測試會是綠的**（坑 #37）|
| 21 | **字串裡的程式碼要單獨編譯過**。注入 worker 的那段是樣板字串，`node --check` 看不到它，壞掉時字幕完全不出現且不報錯 → `node tools/check-inject.js` |

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
| userscript 版本號 | 2（`@version`／`const VERSION`） | **診斷報告會說謊**——回報的版本不是實際跑的版本，排查全部被誤導 | `node tools/check-userscript-version.js` |

userscript 必須是單一檔案、backend 由 wrangler 打包，沒辦法共用模組，只能靠檢查工具擋漂移。

## 資料模型（帳號系統的地基，**不要破壞**）

目前沒有登入、沒有密碼，使用者的身分就是**購買時填的 email**。
這沒問題，但要能無痛長成帳號系統，只靠一個硬性契約：

```
Account（= 正規化過的 email，accountKey()）
  ├── Purchases     ord:<訂單編號>     結帳當下建立，不是付款成功才建立
  ├── Licenses      lic:<授權碼>       付款成功才建立
  └── Entitlements  簽出去的通行證      綁 installId，14 天效期
```

⚠️ **每一筆訂單與每一組授權碼都必須帶著 `acct`。**
少一筆就是一筆日後接不回帳號的孤兒，而且完全不會報錯——
只會在某個人登入後發現「我買的東西不見了」。
`check-backend.js` 會掃所有發碼路徑，漏寫就變紅。

後台的「查一個客戶（帳號視圖）」就是這個模型的預演：
日後真的做登入時，那一頁的內容就是使用者登入後看到的畫面，資料結構不必改。

### 日後導入 Google 一鍵登入（已定調，實作前先讀這段）

Ray 的決定：帳號系統要用 **Google 一鍵註冊／登入**。現在不做，但以下四件事
會決定日後能不能無痛接上，其中兩件**現在就必須成立**。

**實作方式（Ray 指定）：串 Google Identity Services，按一個按鈕就登入。**

前端放官方的 One Tap／按鈕（`accounts.google.com/gsi/client`），
取得 ID token 後 POST 給後端；後端用 Google 的 JWKS 驗簽，
驗 `aud`（我們的 client ID）、`iss`、`exp`、以及 **`email_verified`**。

⚠️ **驗簽一定要在後端做。** 前端拿到的 token 是使用者可以換掉的東西，
   前端「驗過了」等於沒驗。Workers 可以用 `crypto.subtle` 驗 RS256，
   JWKS 快取一小時即可（Google 的金鑰輪替頻率遠低於此）。

⚠️ **不要在擴充功能裡跑 OAuth。** MV3 的 `chrome.identity` 會把流程綁在
   Chrome 帳號上，Edge 與其他 Chromium 瀏覽器行為不一致。
   做在網站上（`pitlingo.com/account`），登入後產生授權碼／權杖，
   使用者貼進擴充功能——**與現在的流程完全一樣，擴充功能一行都不用改**。

事前準備（這一步只有你能做）：到 Google Cloud Console 建立專案 →
OAuth 同意畫面 → 建立「網頁應用程式」用戶端 ID →
授權來源填 `https://pitlingo.com`。client ID 不是機密，可以寫在前端；
**不需要** client secret（ID token 流程用不到）。

**現在就要成立的：**

1. **每筆訂單與授權碼都寫 `acct`**（= 正規化 email）。已實作，`check-backend` 會擋。
2. **`accountKey()` 不摺疊 Gmail 的點號與 +tag。** Google 回傳的 `email`
   是使用者的正規化地址，若我們自己先摺疊過，兩邊會對不上。

**實作時的四個坑（現在寫下來，免得屆時重新推導）：**

| | |
|---|---|
| `sub` 才是主鍵 | Google 的 `email` **會變**（改名、換網域）。首次登入時用 `email_verified` 的 email 認領既有資料，認領完把 `sub` 綁死；之後一律用 `sub` 查，email 只當顯示欄位 |
| `email_verified` 一定要驗 | 沒驗就等於「填什麼 email 就拿到誰的授權」——那是接管別人帳號，不是登入 |
| 購買 email ≠ Google email | 一定會發生（用公司信箱買、用私人 Google 登入）。**必須留一條「用授權碼認領」的路**，否則那些人永遠拿不回自己的東西 |
| 不要移除授權碼 | 登入上線後授權碼仍是唯一不需要網路帳號的啟用方式。擴充功能裝在別人電腦上、不想登入的人都靠它 |

⚠️ **不要在擴充功能裡做 OAuth。** MV3 的 `chrome.identity` 會把整個流程綁在
Chrome 帳號上，Edge 與其他瀏覽器的行為不一致。做在網站上（`pitlingo.com/account`），
登入後產生一組授權碼／權杖，使用者貼進擴充功能——**與現在的流程完全一樣**，
擴充功能一行都不用改。

## 商品模型：一個 Grand Prix = 一個商品

比賽週通行證（`PLANS.week`，鍵名不改）**不保存任何時間**，只綁 `gpId`。
效期由 `gpWindow()` 依賽事資料動態算，所以賽程異動時已售出的通行證會自動跟著調整。

區間 ＝ ［本場第一場賽事 − `WARMUP_LEAD_SEC`, 下一場第一場賽事 − `WARMUP_LEAD_SEC`）

⚠️ 往前一天是為了涵蓋**比賽週四的 warm-up 直播**。拿掉的話，某一站的暖身會
落進上一站的通行證裡。23 段必須**完美接合**，`check-backend` 會驗。

⚠️ **跳著買時中間那幾站不可以送。** 授權記錄存 `windows: [[from,until],…]`，
續期時只簽到「現在這一段」的結束（`entitlementUntil`）。
**不要把區間塞進通行證簽章**——那會改格式，已發出的通行證全部失效。

### 代訂附贈的比賽週：是商品列，不是折抵

`bundleWeeks: N` 代表**每一份**代訂附贈 N 張比賽週通行證
（1 個月每份 1 張、1 年 3 張、單一週末共用帳號不附贈）。

附贈的每一張都是**購物車裡一列 `NT$0` 的商品**，場次由買家自選。

⚠️ **不要改回折抵。** 舊做法是「同時買代訂與通行證就折抵 39」，而
**同一場買兩張的價值本來就是零**——一張訂單只發一張授權碼、區間會合併、
裝置上限綁授權不綁張數。那筆折抵不是折扣，是「先收一筆沒有內容的錢再退掉」，
買家仍然得自己算才知道拿到幾週。**折抵能算對金額，算不掉困惑。**

⚠️ **已被附贈涵蓋的場次不可以再賣一次。** 商品卡要標「代訂已附贈，無須購買」
並且加不進購物車；伺服器 `quoteCart` 也會擋（撞號直接回 error）。

⚠️ **賽季票 + 代訂時，附贈仍然要在購物車裡留一列**（寫「已包含於賽季通行證」）。
整季已經涵蓋，附贈沒有內容可給——但**憑空消失正是舊做法的毛病**。

⚠️ **附贈不計入升級折抵。** 兩道防線：`week_svc` 帶 `fromService`；
以及 `weekPaid` 只算 weekBound 那幾列的 `sum`（附贈是 0）。

⚠️ **賽季通行證 + 代訂時，附贈完全沒有作用**（整季已涵蓋），而且**不折價**。
理由不是小氣，是**我們偵測不到大部分的重複**：上個月買賽季票、今天才買代訂的人，
購物車裡看不出來。折了就變成「同一張購物車折得到、分兩次買折不到」，
而兩人拿到的東西一模一樣——**那比一律不折更不公平**。
補償方式是**講在前面**：加入購物車的當下就跳訊息（`giftRedundantNote()`），
條款第五條也明寫「不會產生額外權利，亦不折抵代訂方案之價格」。

### 日後若要讓「附贈的通行證可以送人」

還沒做，但**地基已經留好**：授權記錄有 `giftGpIds`，記著哪幾站原本是附贈的。

⚠️ **那個資訊只有結帳當下有。** 現在沒有任何程式讀它——但少記一次就永遠補不回來，
屆時只能對這段期間的訂單特殊處理。`check-plan-matrix` 會驗它有被寫進去。

真的要做時，需要改的只有三處（其餘不動）：

| 要改 | 為什麼 |
|---|---|
| 一訂單發多張碼 | 目前 webhook 只發 `quote.primary` 一張。附贈那幾站要各自成碼 |
| 寄信與 `/paid` | 要列出多張碼，並說明哪幾張是可轉贈的 |
| 後台訂單頁 | 一筆訂單對多張授權，查詢與撤銷都要跟著 |

**不必動的**：`quoteCart`、購物車介面、`gpWindow`、entitlement 簽章格式、擴充功能。

正式條款在 `legal/terms.html`「附贈比賽週通行證條款」六條。

⚠️ 場次時間目前是推估的（`est: 1`）。購買頁必須標示「時間待官方確認」，
**不可以假裝是官方時間**。`SCHEDULE_URL` + 每日 cron 會用官方資料覆蓋，
同步一律**先嚴格驗證**，不合理就整份拒絕並保留原賽程。

## 錯誤代碼

| 前綴 | 誰發的 | 看得到嗎 |
|---|---|---|
| `PL-Cxx` | 擴充功能 | 診斷報告一定有；嚴重時才顯示在畫面上 |
| `Exx` | 後端 | 附在 `PL-C02` 後面 |

⚠️ **`PL-C06`／`PL-C07` 不是故障**——那是免費層的正常行為。
兩種「沒有字幕」也刻意不給代碼（影片本來就沒字幕、中途長時間沒旁白）；
給了就是訓練使用者把正常現象當故障回報，真正的故障會淹沒在雜訊裡。

代碼一旦發出去**不可以改語意**。要淘汰就留著別再用。
對照表在後台「問題回報」分頁，來源是 `/v1/admin/codes`。

## 固定測試資料

翻譯品質的退化是靜默的：換模型、改 `SYSTEM_PROMPT`、動 `normKey`
都可能讓譯文變差而沒有任何測試失敗。

```bash
$env:ADMIN_TOKEN="..."; node tools/fetch-fixtures.js    # 建立（挑句數最多的 4 支）
node tools/check-fixtures.js                            # 離線比對，check-all 會跑
node tools/check-fixtures.js --live                     # 重翻一次比對，會花錢
```

**還沒建立時 `check-all` 會印黃色警告但不擋**——不吭聲的話那項檢查等於不存在。

## 成本現況（實測）

| 情境 | 每句 | 2 小時正賽 |
|---|---|---|
| 起點（純逐句） | $0.00083 | $1.66 |
| 整軌預抓 | $0.000155 | **約 $0.31** |
| 共用快取命中 | — | **≈ $0** |

輸出 token 佔 65%，是物理地板。輸入端已無優化空間。

## 環境

- Windows、PowerShell（Bash 工具也可用）
- 後端：`cd backend && wrangler deploy`。**上線後改用 `wrangler versions upload` + `wrangler versions deploy`**（按比例切流，回滾秒級）
  ⚠️ **但帶 DO migration 的那一次必須用 `wrangler deploy`**——Cloudflare 會用 code 10211 拒絕 versions upload（migration 是全域一次性狀態變更，與漸進式部署語意衝突）
- 擴充功能：`chrome://extensions` → 載入未封裝項目 → `extension/`。**改 manifest 後必須按「重新載入」**
- API key 存在 Cloudflare secrets 與 Tampermonkey `GM_setValue`，**不在程式碼裡**
- **後台已移到 `legal/admin.html`**，隨網站部署到 `https://pitlingo.com/admin`（跨裝置用）。
  唯一的門是 `ADMIN_TOKEN`——**上線前務必輪換，並考慮加 Cloudflare Access**
- 寄信用 Resend：`wrangler secret put RESEND_API_KEY`，`MAIL_FROM` 放 vars，網域要在 Resend 驗證
- **後台的方案與價格一律由 `/v1/admin/plans` 提供，不准寫死在 `admin.html` 裡**——
  寫死過一次，改價之後後台還在發早鳥碼，而且完全不報錯（`check-admin.js` 現在會擋）
- **後台已移到 `legal/admin.html`**，隨網站部署到 `https://pitlingo.com/admin`（跨裝置用）。
  唯一的門是 `ADMIN_TOKEN`——**上線前務必輪換，並考慮加 Cloudflare Access**
- 寄信用 Resend：`wrangler secret put RESEND_API_KEY`，`MAIL_FROM` 放 vars，網域要在 Resend 驗證
- `.gitignore` 已排除機密與 `.wrangler/`

## 測試工具（v0.5.0 起，**上線前必須移除**）

擴充功能的 `main.js` 有一段標著 `TESTING` 的區塊，掛在 `__pitlingo.t.*`。
Console 打 `__pitlingo.help()` 會列出全部。

**移除方式**：刪掉 `TESTING` 常數整段，以及 `window.__pitlingo` 裡的 `t:` 與 `help:` 兩行。
判斷依據：**`help()` 列在「上線前移除」那半邊的東西，正式版一律不該存在**——
它們會繞過防護（強制預抓）或洩漏內部狀態。

`diag()` / `events()` / `state` / `peek()` / `debug()` 要保留，那是回報問題的唯一管道。

## 診斷（回報問題的標準流程）

- 擴充功能：圖示 → 回報問題 → **「傳送診斷給開發者」**（回工單編號 `PL-YYMMDD-XXXX`，後台看得到）
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
