# PitLingo — Chrome 擴充功能（MV3）

對應 `handoff.md` 路線圖的 **P2**。目前是 `v0.2.0`，可以載入測試。

---

## 與 userscript 的關鍵差異

| | Userscript | 擴充功能 |
|---|---|---|
| 執行環境 | 頁面環境（`unsafeWindow`） | **ISOLATED world** |
| 取得字幕 | 整軌收割 → Worker 注入 → DOM | **PLAY API 預抓 → DOM** |
| contentId | 攔截網路請求 | **`performance.getEntriesByType('resource')`** |
| API 金鑰 | 存在使用者本機 | **不存在，後端保管** |
| 網路請求 | userscript 直接發 | **全部經過 service worker** |
| 權限 | 全域 | 兩個網域 |

### 為什麼不需要 Worker 注入，卻仍有提前量

擴充功能若**只讀 DOM**，提前量是 **0**——字幕出現在畫面上我們才知道有這句，
翻譯來回 1~3 秒而轉播每 3~4 秒一句，永遠追不上。
（v0.1.x 就是這樣，實測明顯跳句。）

但播放器本來就會**提前約 50 秒**下載字幕分段。userscript 靠注入 Worker 攔那些請求；
擴充功能不必——**master 網址來自主執行緒的 PLAY API，我們有 `host_permissions`，
可以自己發同一個請求**：

```
PLAY API（帶使用者 session）
  → master m3u8
  → #EXT-X-MEDIA:TYPE=SUBTITLES → 字幕清單
  → VTT 分段 → 批次翻譯 → 存進共用快取
```

| | Worker 注入 | 直接呼叫 PLAY API |
|---|---|---|
| 提前量 | 50 秒 | **整支（重播）／滑動視窗（直播）** |
| 審核風險 | 高（改寫頁面 Worker） | 低（一般 API 請求） |
| F1TV 改版 | 播放器一改就壞 | 只有 API 路徑會變 |

**直播**：字幕清單是滑動視窗，每 20 秒重抓補新分段。
觀眾本來就落後 live edge 20~40 秒，所以仍有餘裕。

### 其他不做 Worker 注入的理由

`handoff.md` 7.3 的決策：

1. 有伺服器共用快取就不需要——使用者只要 contentId 就能拿到整支譯文
2. 修改頁面建立的 Worker 是商店審核的紅旗
3. F1TV 一改播放器就得跟著改，維護成本高

**「第一次收割」由你自己用 userscript 當管理員工具完成**，賽前把譯文灌進後端。
沒被收割過的影片，擴充功能會退回逐句即時翻譯（走後端，成本由該次呼叫吸收）。

---

## 專案結構

```
extension/
  manifest.json              權限、進入點
  src/
    shared/
      normalize.js           clean() 與 normKey() ⚠️ 必須與後端、userscript 一致
      defaults.js            內建設定、預設選項、遠端設定合併
    background/
      sw.js                  唯一對外通訊處：後端 API、設定與 bundle 快取
    content/
      main.js                contentId、字幕讀取、疊字顯示
      overlay.css            疊字層樣式
    options/
      options.html/.js/.css  設定頁（同時當作工具列彈出視窗）
```

### ⚠️ `normKey()` 是三份程式碼之間的硬性契約

`extension/src/shared/normalize.js`、`backend/src/index.js`、`f1tv-zh-subtitles.user.js`
三處的 `normKey()` 必須**完全一致**。不一致的話同一句話會算出不同的鍵，
共用快取整個失效——而且**不會報錯，只會默默重翻**。改動時三邊要一起改。

---

## 載入測試

1. Chrome 網址列輸入 `chrome://extensions`
2. 右上角開啟「**開發人員模式**」
3. 點「**載入未封裝項目**」，選擇 `extension/` 資料夾
4. 點擴充功能圖示 → 填入**存取金鑰**（就是後端的 `CLIENT_TOKEN`）→ 按「測試連線」
5. 開 F1TV 播放頁，**在播放器設定裡開啟英文 CC**

### 預期的 Console 輸出

```
[PitLingo] PitLingo 已啟動 | 設定版本 1 | 翻譯：開啟
[PitLingo] 從共用快取取得 1823 句譯文（cid 1000010262），這些不會再花錢
[PitLingo] 已偵測到第一句字幕，CC 運作正常
```

### 除錯

在 F1TV 頁面的 Console：

```js
__pitlingo.state      // contentId、快取句數、待翻數、是否曾看到字幕
__pitlingo.peek()     // 現在畫面上抓到什麼英文
__pitlingo.site()     // 目前套用的選擇器設定（來自遠端或內建）
```

Service worker 的 log 要另外看：`chrome://extensions` → PitLingo → 「Service Worker」。

---

## 遠端設定（F1TV 改版時的救命索）

`sw.js` 啟動時會向後端要 `/v1/config`，內容是選擇器、contentId 規則、隱藏用 CSS。

- **選擇器是陣列，依序嘗試** —— F1TV 灰度推送期間新舊版同時存在，兩邊都能用
- 拿不到就用 `defaults.js` 的內建值，功能不會因為後端掛掉而中斷
- 快取 6 小時

F1TV 改版時：**改後端 JSON → 幾分鐘內所有使用者恢復**，
而不是改程式碼 → 送審 → 等 1~3 天。

⚠️ 這是**資料**不是程式碼。商店明文禁止下載並執行遠端程式碼，界線要守住。

---

## ⚠️ 測試前必讀

**userscript 與擴充功能不能同時啟用**——兩個都會抓同一組字幕、畫出兩層疊字。
測試擴充功能時請先在 Tampermonkey 停用 PitLingo 腳本。

### 三條路徑，由快到慢

| 路徑 | 何時 | 延遲 |
|---|---|---|
| 共用快取命中 | 有人翻過這支 | **0 ms** |
| PLAY API 預抓 | 沒人翻過，但拿得到串流位址 | **0 ms**（提前 50 秒翻好） |
| 逐句即時翻譯 | 前兩者都失敗 | 1~3 秒，會跳句 |

**第三條是最後的後備，不是正常運作模式。** 若診斷報告顯示停在「逐句模式」，
代表 PLAY API 或字幕清單取不到——那才是要修的問題。

### 診斷

擴充功能圖示 → **匯出診斷（複製到剪貼簿）**。
報告包含預抓狀態、命中率、事件時間軸，回報問題貼這一份就夠。

Console 也可以：`__pitlingo.diag()` / `__pitlingo.events()` / `__pitlingo.prefetch()`

## 尚未實作

| 項目 | 何時做 |
|---|---|
| 圖示（16/32/48/128 png） | 上架前必備 |
| 帳號登入與 JWT | P3 |
| 每場 GP 15 分鐘免費試用 | P3 |
| 金流（綠界／藍新） | P3 |
| 靜默失效遙測回報 | P3 |
| 隱私權政策、使用條款 | P4 上架前 |
| 多語系 `_locales` | 之後 |
