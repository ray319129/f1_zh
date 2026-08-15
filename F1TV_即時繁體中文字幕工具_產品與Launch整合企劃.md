# F1TV 即時繁體中文字幕工具｜產品與正式上線 整合企劃 

**給 Claude** 的產品背景、商業策略、技術架構與 **Launch Brief** 

版本：2026-08-16｜用途：讓 Claude 快速理解目前已完成產品與後續商業化方向 

## **1.** 一句話理解產品 

這是一個已經完成開發的瀏覽器擴充功能，讓 F1TV 使用者把 F1TV 的英文 CC 字幕即時翻譯成繁體中文。產品不提 供賽事串流，而是作 F1TV 的第三方中文化工具。核心價值不是「提供 F1 中文轉播」，而是「保留 F1TV 原本的多視角、Onboard、Team Radio、英文原聲等體驗，同時解決英文字幕閱讀障礙」。 

## **2.** 已知產品現況 

- 產品已經做好，現在進入正式商業化／正式 Launch 準備階段。 

- 每場比賽前 15 分鐘免費試用。 

- 預計提供賽季方案、單一比賽週末方案；月費目前不優先。 

- 目前構想的賽季價格為 NT$799。 

- 目前考慮單一比賽週末約 NT$79；單場可另測試 NT$49 左右，但不必第一版就同時提供太多選項。 

- 翻譯成本目前約每場比賽 < US$1。 

- 所有使用者共用同一場比賽的譯結果：後段收到最新譯後，同步給所有使用者。這是目前最大的成本 優勢。 

- 因此 AI 翻譯成本近似『每場比賽固定成本』，而不是『每個使用者的線性成本』。 

## **3. 核心定位** 

### **不要定位成** 

- 「F1 中文轉播」 

- 「比緯來／愛爾達更好的 F1」 

- 「AI 翻譯工具」 

- 「F1TV 中文版」 

### **建議定位** 

- 「F1TV 的繁體中文化工具」 

- 「保留 F1TV，讓它看得懂。」 

- 「F1TV 英文 CC → 即時繁體中文字幕」 

核心客群不是所有想看中文 F1 的人，而是已經使用或願意使用 F1TV、喜歡 F1TV 完整觀看體驗，但英文字 幕造成障礙的人。 

## **4. 台灣市場與競爭環境** 

目前討論過的市場結論：緯來體育與愛爾達是威脅，但主要威脅的是「想用中文看 F1」的客群，而不是產品 最核心的 F1TV 使用者。 

緯來目前有低價的 F1 月費方案；愛爾達則有中文體育內容與 F1。這代表不能用「便宜看中文 F1」作為產品 賣點。 

市場策略應該是：不要搶「看 F1 的人」，而要搶「已經選擇 F1TV、但想讓 F1TV 更容易看懂的人」。 

|方案／平台|主要優勢|主要弱點／缺口|與本產品關係|
|---|---|---|---|
|緯來|便宜、中文內容|不是F1TV完整體驗|替代『看F1』，但不是<br>直接同產品|
|愛爾達|中文體育生態、F1|同樣不是F1TV中文化<br>工具|替代『中文觀看』|
|F1TV|多視角、Onboard、<br>Team Radio、完整體驗|英文字幕／語言障礙|核心平台／使用情境|
|本<br>品<br>產|直接把F1TV CC中文化|依賴F1TV、需處理第三<br>方合規|F1TV companion|



## **5.** 品牌方向 

品牌應與 F1／F1TV 的官方品牌分離。不要讓品牌看起來像官方產品，也不要使用官方 Logo。品牌名稱最好 是獨立、可擴展、容易做社群內容的名字。 

### **目前候選** 

- PitLingo — 最推薦；Pit + Lingo，賽車感＋語言感，容易延伸。 

- PitTalk — 很適合 Team Radio／對話定位，未來可延伸到語音與賽事溝通。 

- RaceDecode — 偏「解碼賽事」，未來擴張性高。 

- BoxBox — F1 梗強、Hook 很強，但需要特別檢查名稱可用性與商標風險。 

- RaceLingo / GridLingo / PitSub / RaceCaption / PitTranslate — 備選。 

目前最推薦先以 PitLingo 作為工作品牌，但正式註冊前必須查網域、Instagram、Threads、TikTok、 Facebook、Chrome Web Store 名稱及商標可用性。 

### **品牌語言** 

- PitLingo / 看懂每一句。 

- 保留 F1TV，讓它看得懂。 

- Decode the race.（若走 RaceDecode） 

- What did they just say?（若走 PitTalk） 

## **6. 定價策略** 

目前最合理的第一版不是月費導向，而是依 F1 的比賽週期收費。因為使用者的需求集中在 Grand Prix 週 末，月費會讓使用者直接拿去和低價的中文 F1 服務比較。 

|方案|建議價格|目的|狀態|
|---|---|---|---|
|Free Trial|每場／每GP 15分鐘|降低第一次使用門檻|核心|
|Weekend Pass|NT$79|低門檻轉換、偶爾觀看<br>者|建議首發|
|Season Pass|NT$799|主力方案、核心使用者|建議首發|
|Single Race|可測試NT$49|極低門檻|可後續加入|
|Monthly|暫不做|避免直接與低價月費F1<br>服務比較|暫緩|



可做 Early Access：前 100 位 NT$599，正式價格 NT$799。Early Access 的目的不是永久低價，而是建立第 

一批付費使用者、收集回饋、驗證付費意願。 

## **7. 成本與單位經濟** 

目前每場翻譯成本約 < US$1，而且所有使用者共享同一場 GP 的翻譯結果。這意味著翻譯成本接近固定成 本。 

- 1 場 GP ≈ 1 譯工作→ N 個使用者共享。 

- 使用者增加時，翻譯成本不會線性增加。 

- 真正需要監控的不是只有 AI cost，而是翻譯延遲、同步延遲、伺服器穩定性與付費轉換率。 

示意：若一場成本 US$1、同場 100 位付費者，平均翻譯成本約 US$0.01／付費者；若 1,000 位，則約 US$0.001／付費者。實際成本仍應加入 server、payment fee、email、monitoring 等。 

## **8. Landing Page 結構** 

### **Hero** 

主標方向：『你不用放棄 F1TV，只需要讓它看得懂。』 

- F1TV 英文 CC → 即時繁體中文字幕 

- 每場比賽前 15 分鐘免費試用 

- CTA：免費開始使用 

- 次 CTA：觀看 Demo 

第二區：真實 **Demo** 

一定要直接展示英文字幕變成繁中，而不是只放產品 Logo。讓訪客在 2–3 秒內理解產品。 

第三區：價值 

- 不用換平台 

- 不用複製貼上 

- 不用開翻譯網站 

- 保留英文原聲與 F1TV 體驗 

### 第四區： **How it works** 

- 安裝 Extension 

- 開啟 F1TV 

- 開啟 CC 

- 自動顯示繁體中文 

### 第五區： **Pricing** 

- Weekend NT$79 

- Season NT$799（主推） 

- 每場 15 分鐘免費 

### 第六區：信任 

- 不需要 F1TV 帳號密碼 

- 清楚說明資料處理方式 

- Privacy Policy / Terms / Refund Policy 

- 明確聲明第三方獨立產品，不代表 F1／F1TV 官方 

### **FAQ** 

- 需要 F1TV 訂閱嗎？ 

- 支援哪些瀏覽器？ 

- 需要提供 F1TV 帳密嗎？ 

- 翻譯延遲大約多少？ 

- 如何啟用付費方案？ 

- 退款規則？ 

## **9. 付款與授權系統** 

台灣第一版可優先評估綠界或藍新。第一版若只有 Weekend / Season 一次付清，不需要一開始就做複雜的定 期扣款；月費未來確定有需求再加入。 

### **建議付款流程** 

Landing Page → 選方案→ Email → 付款→ Payment Webhook → Backend 建立／啟用 License → 寄啟用資 訊→ Extension 登入／定→ Backend 驗證→開放功能。 

### **授權資料** 

- User：user_id、email、created_at 

- License：license_id、user_id、plan、status、starts_at、expires_at、payment_id 

- Payment：provider、transaction_id、amount、status、paid_at 

Extension 不應自己決定是否付款成功；Backend 才是權威來源。 

## **10. 15 分鐘免費試用** 

試用應設計成每個 GP／賽事週期的一次體驗，而不是單純把 15 分鐘存在瀏覽器 Local Storage。否則清 Cookie、無痕、換 profile 等方式容易重置。 

- Backend 記錄 trial session / event_id / started_at / consumed time。 

- Extension 啟動後向 Backend 驗證 Trial 狀態。 

- 試用剩 5 分鐘：提示。 

- 剩 1 分鐘：強 CTA。 

- 到 0：只停止本產品翻譯功能，F1TV 本身必須保持正常。 

重要：不要只用前端 setTimeout 當唯一判定。 

## **11. 目前技術架構的商業優勢** 

核心架構是『共享翻譯流』：後段收到最新翻譯後同步給所有觀看者。這使一場比賽只需要做一次主要翻譯工 作。 

念架構：F1TV CC → Subtitle ingestion → Translation worker → Shared result/cache/pub-sub → 多個 Extension clients。 

### 應追蹤的核心 **Metrics** 

- Translation latency：字幕收到→ 翻譯完成 

- Broadcast latency：翻譯完成→使用者收到 

- Concurrent users：同時在線人數 

- Translation error rate 

- Cost / GP 

- Cost / paying user 

- Trial → paid conversion 

- Extension activation rate 

- DAU/GP、回訪率 

產品正式放大後，主要 Scaling 風險可能從 AI 成本轉向同步、延遲、第三方服務穩定性與 F1TV 更新造成的 相容性。 

## **12. Chrome Web Store** 

- 名稱與品牌需避免讓使用者誤以為是 F1／F1TV 官方產品。 

- 使用最小必要 permissions。 

- 清楚解釋每個 permission 為何需要。 

- Privacy Policy 必須與實際資料流一致。 

- Store screenshots 以『英文→繁中』 Demo 為主。 

- 不要 keyword stuffing。 

- 準備 support email、support website、privacy、terms、refund。 

Chrome Web Store 的政策會更新；正式提交前應再次檢查當時最新的 Developer Program Policies、User Data Policy、Listing Requirements。 

## **13. 法律／IP／條款風險：P0** 

這不是已經認定產品違法，而是正式商業化前必須確認的風險。F1/F1TV 是第三方品牌與服務，正式收費前 應檢查商標、官方品牌指南、F1TV 使用條款，以及目前實作的字幕取得方式。 

- 品牌與社群帳號不要使用官方 Logo。 

- 不要讓頁面看起來像官方服務。 

- 清楚寫第三方獨立產品與不隸屬／不受官方背書的聲明。 

- 尤其確認字幕取得方式：瀏覽器端處理使用者已看到的字幕，與後端抓取／儲存／再傳送內容，風險不 同。 

- 不要為了降低成本而建立未經確認授權的 F1TV 字幕資料庫或資料探勘系統。 

在正式 Launch 前，最好讓熟悉台灣軟體／IP／平台條款的律師快速檢視一次，尤其是：商標命名、Landing Page 文案、Extension permission、字幕來源／處理流程、Terms、Refund、Privacy。 

## **14. 官方社群帳號策略** 

第一階段不要同時經營十個平台。優先建立 Threads、Instagram、TikTok、Facebook；統一品牌、頭像、 Bio、網站連結。 

- Threads：核心社群、開發者故事、F1 討論、即時反應。 

- Instagram：品牌、Reels、產品 Demo。  TikTok：10–20 秒產品 Hook／Demo。 

- Facebook：官方門面＋F1 社團導流。 

### **Bio 方向** 

🏎️� F1TV 即時繁體中文字幕｜英文 CC → 繁中｜每場免費試用 15 分鐘｜↓開始使用 

若品牌確定，可統一使用 @brandname 或 @brandnameapp。正式註冊前查 username / domain / trademark。 

## **15. 宣傳核心：Hook** 

產品宣傳不應從『AI 即時翻譯』開始，而要從 F1 粉絲的痛點開始。 

### **高潛力 Hook** 

- 『你都花錢訂 F1TV 了，什還要看英文？』 

- 『F1 英文字幕，你真的看得懂嗎？』 

- 『我不是在做 F1 翻譯，我是在幫 F1TV 加中文字幕。』 

- 『如果你需要中文主播才能看懂 F1，那你可能會喜歡這個。』 

- 『我受不了 F1TV 沒有繁體中文字幕，所以自己做了一個。』 

### **固定內容系列** 

- 「PitLingo 翻譯一個 F1」：BOX BOX、UNDERCUT、LIFT AND COAST、GRaining、DEG 等。 

- 翻譯前後對比：英文 CC → 繁中。 

- F1TV 使用技巧＋字幕 Demo。 

- 開發者故事：為什麼做這個工具。 

- 比賽週末即時內容。 

## **16. 第一批宣傳素材** 

**短片 1** ：痛點 

0–2 秒：『F1TV 沒有繁體中文字幕？』→ 2–7 秒：真實英文 CC → 繁中→ 7–12 秒：『不用切換、不用複 製、不用等』→ 12–15 秒：『每場免費 15 分鐘』。 

**短片 2** ： **F1TV 使用者** 

『如果你已經訂 F1TV，這個可能很適合你。』→展示 Onboard／CC／繁中→『不用換平台。』 

**短片 3** ：獨立開發者 

『我受不了 F1TV 沒有繁體中文字幕，所以自己做了一個。』→直接 Demo → CTA。 

### **社群內容比例** 

- 50% F1 有趣／知識內容 

- 30% 產品 Demo／功能 

- 20% 直接銷售 

## **17.** 首批 **100 位付費使用者計** 畫 

**階段 A** ： **10 人** 

- 找真實 F1 粉絲測試完整比賽。 

- 重點不是問『能不能翻』，而是測延遲、準確率、字幕 UI、Crash、F1TV 相容性。 

### **階段 B** ： **20 人** 

- Beta 使用者。 

- 免費或低價，換取實際使用回饋。 

### **階段 C** ： **70 人** 

- Early Access。 

- 前 100 位 Season Pass NT$599。 

- 取得真實付款、啟用、客服、退款與使用行為資料。 

### **示意漏斗** 

1,000 次內容曝光→ 300 Landing Page 訪客→ 150 安裝→ 100 實際試用→ 30 高意願使用者→ 10 付費。 第一階段不是追求精準預測，而是建立可量測漏斗。 

### 第一階段 **KPI** 

- Install → activation：目標 70%+ 

- Trial 完整使用率：目標 50%+ 

- Trial → paid：早期目標 5–10%，低於約 3% 時優先檢查產品價值／付款阻力。 

- 同場 concurrent users 

- Translation latency / broadcast latency 

- 每 GP 收入與成本 

## **18. 正式 Launch 時程** 

|階段|主要工作|完成條件|
|---|---|---|
|Week 1：商業化基礎|品牌、Landing Page、<br>Payment、License、Trial、<br>Privacy、Terms|可以完成付款→啟用→使用|
|Week 2：Beta|10–30<br>位<br>實使用者、完整<br>真<br>GP<br>測試、修Bug|核心流程穩定|
|Week 3：Pre-launch|Threads／IG／TikTok／<br>Facebook、Demo、Email、<br>Chrome Store|可以導流並完成安裝|
|Week 4：Launch|Early Access NT$599<br>、首批100<br>位、比賽週末集中宣傳|取得第一批真實付費者|



## **19. 優先級** 

|優先級|項目|原因|
|---|---|---|
|P0|F1／F1TV條款、商標、字幕取得<br>方式風險確認|正式收費前最重要|
|P0|Payment + License + Trial|沒有這三個就無法安全商業化|
|P0|Chrome Web Store合規|主要分發入口|
|P0|Privacy/ Terms / Refund|建立信任與平台合規|
|P1|LandingPage + Demo|轉換流量|
|P1|Analytics|知道漏斗哪裡掉人|
|P1|社群帳號與前三支影片|取得第一批使用者|
|P2|F1專有名詞詞庫／翻譯品質|提高留存與口碑|
|P2|更低延遲|提高核心產品體驗|
|P3|月費、Team Radio等新<br>品<br>產|驗證核心模式後再做|



## **20. 給 Claude 的執行指令** 

請把以上內容視為產品的固定背景。後續協助時，優先以『正式商業化、首批 100 位付費使用者、可持續營運』為 。 目標，而不是把它當成單純 side project 

- 不要反覆建議從零開始開發 Extension；產品目前已完成。 

- 優先找出商業化流程中的風險、漏斗、轉換率、付款、授權、Trial、Chrome Store、社群與 Launch 問 題。 

- 不要把產品定位成與緯來／愛爾達競爭的中文 F1 轉播。核心客群是 F1TV 使用者。 

- 不要過度強調 AI；使用者買的是『看懂 F1TV』。 

- 目前成本優勢是所有使用者共享同一場比賽的翻譯結果，每場成本約 < US$1。 

- 如果提出定價，先以 Weekend NT$79、Season NT$799、Early Access NT$599／前 100 位作為基準， 再說明為何要調整。 

- 如果提出法律／IP 建議，要區分『已確認事實』與『需要律師／官方條款再次確認的風險』，不要把法律結 論講死。 

- 任何新的 F1TV、Chrome Web Store、支付平台、平台政策等時效性資訊，都應在需要時重新查證。 

## **21. 目前最重要的決策** 

1. 確定品牌名稱，並同時查 username / domain / trademark。 

2. 確認實際字幕取得與翻譯資料流，進行 F1TV 條款／IP 風險檢查。 

3. 完成 Weekend NT$79 + Season NT$799 的第一版付款。 

4. 完成 Backend License + GP-based 15 分鐘 Trial。 

5. 完成 Chrome Web Store 上架與 Privacy／permission 說明。 

6. 做 3 支 10–20 秒 Demo／Hook 短片。 

7. 找 10–30 位真實 F1TV 使用者完成 Beta。 

8. 以 Early Access NT$599 鎖定第一批 100 位付費者。 

9. 用第一個 GP 的實際數據決定是否調整價格、月費與單場方案。 

**— End of Product Brief —** 

