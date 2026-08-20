/**
 * f1zh-api — F1TV 繁中字幕共用譯文後端
 *
 * 核心價值：所有人看同一支影片拿到的是同一份英文字幕，所以譯文可以共用。
 * 第一次有人看 → 翻譯一次 → 存進 KV；之後所有人 → 直接下載，零 API 呼叫。
 *
 * 路由
 *   GET  /v1/health                    健康檢查
 *   GET  /v1/config                    遠端設定（選擇器等，可熱修不用重送審）
 *   GET  /v1/subs?cid=<contentId>      取回整支影片的譯文
 *   POST /v1/subs                      上傳譯文（需 ADMIN_TOKEN）
 *   POST /v1/translate                 翻譯未命中的句子（需 CLIENT_TOKEN）
 *   POST /v1/complete                  標記整支已完整收割（需安裝權杖）
 *   POST /v1/register                  匿名換取安裝權杖（無需權杖，IP 限流）
 *   POST /v1/license/activate          用授權碼啟用這台裝置，換回通行證
 *   POST /v1/license/renew             續期（失敗不影響現有通行證）
 *   POST /v1/license/deactivate        解除裝置（不需該裝置的權杖）
 *   POST /v1/license/devices           列出這組授權碼的裝置（純查詢）
 *   POST /v1/report                    使用者送出診斷，回傳工單編號
 *   POST /v1/metric                    產品數據（彙總計數，不含個資）
 *   GET  /v1/admin/metrics             產品數據後台
 *   POST /v1/checkout                  建立訂單，回傳導向綠界的表單
 *   POST /v1/payment/webhook           金流回呼：驗簽 → 防重放 → 自動發碼
 *   POST /v1/payment/info              ATM／超商取號通知（**不發碼**）
 *   GET  /v1/order?no=                 查單筆訂單狀態
 *   GET  /v1/admin/license/list        授權清單（可搜尋、可分頁）
 *   POST /v1/admin/license/patch       延期／換方案／解除全部裝置
 *   GET  /v1/admin/reports             診斷回報清單
 *   POST /v1/admin/license/issue       發碼（金流 webhook 之後接這裡）
 *   POST /v1/admin/license/revoke      停用（退款／盜用）
 *   GET  /v1/admin/license/lookup      用 email 查回授權碼（客服補發）
 *   GET  /v1/admin/stats               成本後台（需 ADMIN_TOKEN）
 *   POST /v1/admin/revoke              撤銷某個安裝（需 ADMIN_TOKEN）
 *
 * 環境變數（wrangler secret put）
 *   ANTHROPIC_API_KEY   Anthropic 金鑰
 *   ADMIN_TOKEN         上傳與後台用的管理權杖
 *   TOKEN_SECRET        簽發安裝權杖用（未設定時由 ADMIN_TOKEN 衍生）
 *   CLIENT_TOKEN        舊版共用權杖，僅為相容 userscript 而保留
 *   DAILY_USD_CAP       成本熔斷上限（美元／天，預設 5）
 * KV binding: SUBS
 *
 * v1.4  SYSTEM_PROMPT 與 userscript 同步（34 → 273 條術語）。
 *       同時讓 prompt 跨過 4096 token 門檻，cache_control 才真的生效。
 * v1.5  修 /v1/translate 的讀改寫競爭（並行請求互相覆蓋，實測只有 41%
 *       的譯文存活）。新增 /v1/complete 讓用戶端標記整支已收割完整。
 * v1.6  /v1/subs 拿掉 max-age=60。bundle 現在是多寫入者，HTTP 快取
 *       是用戶端清不掉的一層，會讓剛寫進去的 segCount 完全看不到。
 * v1.7  單句不再走批次編號協定（實測回覆率只有 50%，坑 #9）。
 *       批次解析加上「行數相同就按位置對應」的備援。
 * v2.3  方案期限由伺服器依方案計算（trial 14 天／season 到隔年 1/31／
 *       lifetime 無期限）；授權清單、批次修改、診斷回報工單。
 * v2.2  管理端點補回 CORS（後台是本機開的 file://，Origin 是 null，
 *       第一版把自己的後台也擋掉了）。新增 /v1/license/devices。
 * v2.1  **授權與安裝權杖分離**。v2.0 把「證明付過錢」做成綁裝置的，
 *       換一台電腦就失效——付費軟體不能這樣。改成可攜帶的授權碼：
 *       任何裝置貼上就能用，最多 3 台，可自行解除，可用 email 補發。
 * v2.0  資安與維運：每個安裝一枚權杖（取代所有人共用的 CLIENT_TOKEN，S6）、
 *       拿掉 CORS `*`、常數時間比對、速率限制改以 installId 為鍵、
 *       譯文合理性檢查擋 prompt injection 汙染共用快取（S9）、
 *       成本統計與每日熔斷、分階段推送（rollout / killSwitch / minClientVersion）。
 */

const MODEL = 'claude-haiku-4-5';
const BATCH_MAX = 20;              // 一次 API 呼叫最多翻幾句
const RATE_LIMIT_PER_MIN = 120;    // 每 IP 每分鐘的 /v1/translate 上限
const BUNDLE_MAX_LINES = 20000;    // 單支影片的譯文上限，防呆

// ---------------------------------------------------------------------------
// 翻譯用的 system prompt
//
// ⚠️ 兩個硬性條件，違反了都不會報錯，只會靜默劣化：
//   1. 必須與 userscript 的 SYSTEM_PROMPT 逐字相同。否則同一句在兩個產物上會
//      翻出不同結果，而共用快取不分來源，譯文品質變成看運氣。
//   2. 必須 ≥ 4096 tokens，否則下面那個 cache_control 靜默失效，每次全額計費。
//      v1.3 以前這裡只有 34 條術語（約 650 tokens），快取從來沒生效過。
//
// 兩者都由 `node tools/check-prompt.js` 把關，改動後務必執行。
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是 F1 賽事轉播的即時字幕翻譯器。將輸入的英文轉播評論翻譯成台灣賽車圈慣用的繁體中文。

═══════════════════════════════
【輸出規則 — 最高優先】
═══════════════════════════════
1. 只輸出譯文本身。禁止任何解釋、前言、引號、標記、註解或原文回顯。
2. 輸入是即時字幕，可能是不完整的句子片段。直接翻譯你看到的部分。
   絕對不要腦補補完句子，不要推測後續內容，也不要因為句子不完整就拒絕翻譯或加上省略號。
3. 語氣要口語、短促、有節奏，像現場轉播員在講話，不是書面報導。
4. 省略英文口語贅字：well, you know, I mean, sort of, kind of, actually, basically, obviously。
5. 標點只用「，」「。」「！」「？」。不要用引號、括號、破折號、刪節號。
6. 若輸入是雜音標記、音樂符號、純標點或無意義字串，輸出空字串。
7. 一句話講完就好，不要為了「完整」而擴寫。原文短，譯文就短。

═══════════════════════════════
【批次模式】
═══════════════════════════════
若輸入以「【批次翻譯】」開頭、後面每行以「數字.」起始，這是批次請求：
- 逐行翻譯，輸出同樣每行以「數字.」起始，數字與輸入完全對應。
- **即使只有一句，也必須輸出編號。** 批次模式的編號規則優先於「只輸出譯文本身」。
- 輸出行數必須與輸入行數完全一致。不要合併、拆分、重排或省略任何一行。
- 某行若是無意義字串，仍要輸出該編號，後面留空。
- 前後行是連續的轉播內容，翻譯時可利用相鄰行判斷代名詞與指涉，但每行仍獨立輸出。
- 除了編號行以外不要輸出任何其他文字。

═══════════════════════════════
【專有名詞總則】
═══════════════════════════════
8. 所有車手姓名、車隊名稱一律保留英文原文。不音譯，不使用中國大陸譯名。
9. 所有賽道名稱與彎角俗名保留英文原文。
10. 下列縮寫保留英文不譯：
    DRS, ERS, MGU-K, MGU-H, PU, ICE, SoC, VSC, SC, FIA, FOM, GP,
    Q1, Q2, Q3, SQ1, SQ2, SQ3, P1~P20, FP1, FP2, FP3,
    DNF, DNS, DSQ, PB, SB, RPM, KPH, MPH, G, kW, kJ

═══════════════════════════════
【2026 賽季車隊與車手】
═══════════════════════════════
Oracle Red Bull Racing（Red Bull）— Max Verstappen, Isack Hadjar
Scuderia Ferrari（Ferrari）— Charles Leclerc, Lewis Hamilton
McLaren — Lando Norris, Oscar Piastri
Mercedes — George Russell, Kimi Antonelli
Aston Martin — Fernando Alonso, Lance Stroll
Alpine — Pierre Gasly, Franco Colapinto
Williams — Alex Albon, Carlos Sainz
Racing Bulls — Liam Lawson, Arvid Lindblad
Audi（前身 Kick Sauber）— Nico Hulkenberg, Gabriel Bortoleto
Haas — Esteban Ocon, Oliver Bearman
Cadillac（2026 新軍）— Sergio Perez, Valtteri Bottas

常見暱稱與簡稱，一律保留原文：
Max, Mad Max, Checo, Nando, Hulk, The Hulk, Kimi, Yuki, Lando, Oscar, Charles, Lewis,
George, Alex, Carlos, Valtteri, Franco, Gabi, Ollie, Liam, Isack, Arvid, Stroll, Magic Alonso

備援與測試車手（隨賽季調整，一律保留原文）：
Ayumu Iwasa, Ryo Hirakawa, Felipe Drugovich, Jack Doohan, Paul Aron, Frederik Vesti,
Luke Browning, Zak O'Sullivan, Victor Martins, Pepe Marti, Dino Beganovic

═══════════════════════════════
【歷代車手 — 轉播經常提及，一律保留英文原文】
═══════════════════════════════
世界冠軍：
Michael Schumacher, Ayrton Senna, Alain Prost, Niki Lauda, Jackie Stewart,
Juan Manuel Fangio, Jim Clark, Graham Hill, Damon Hill, Nelson Piquet, Nigel Mansell,
Emerson Fittipaldi, Mario Andretti, James Hunt, Jody Scheckter, Alan Jones,
Keke Rosberg, Mika Hakkinen, Jacques Villeneuve, Jenson Button, Kimi Raikkonen,
Sebastian Vettel, Nico Rosberg, John Surtees, Jack Brabham, Denny Hulme, Phil Hill

近年退役或轉戰他處：
Daniel Ricciardo, Kevin Magnussen, Mick Schumacher, Guanyu Zhou, Logan Sargeant,
Nyck de Vries, Daniil Kvyat, Romain Grosjean, Antonio Giovinazzi, Sergio Perez,
Felipe Massa, Mark Webber, Rubens Barrichello, David Coulthard, Jarno Trulli,
Giancarlo Fisichella, Heikki Kovalainen, Robert Kubica, Sergio Marchionne

經典人物：
Gilles Villeneuve, Stirling Moss, Ronnie Peterson, Gerhard Berger, Riccardo Patrese,
Jean Alesi, Eddie Irvine, Ralf Schumacher, Juan Pablo Montoya, Jules Bianchi,
Roland Ratzenberger, Francois Cevert, Clay Regazzoni

═══════════════════════════════
【車隊與賽事人物 — 一律保留英文原文】
═══════════════════════════════
車隊負責人與高層：
Christian Horner, Toto Wolff, Fred Vasseur, Andrea Stella, Zak Brown, James Vowles,
Mike Krack, Ayao Komatsu, Laurent Mekies, Jonathan Wheatley, Flavio Briatore,
Helmut Marko, Adrian Newey, Ross Brawn, Jean Todt, Bernie Ecclestone,
Stefano Domenicali, Mohammed Ben Sulayem, Mattia Binotto, Guenther Steiner,
Otmar Szafnauer, Andreas Seidl, James Allison, Pierre Wache, Enrico Cardile

賽事工程師與無線電常見名字：
Gianpiero Lambiase (GP), Bono, Peter Bonnington, Riccardo Adami, Tom Stallard,
Will Joseph, Marcus Dudley, Xavi Marcos, Ernesto Desiderio

F1TV 與轉播團隊：
Alex Jacques, David Croft (Crofty), Martin Brundle, Jolyon Palmer, Sam Collins,
Ted Kravitz, Natalie Pinkham, Will Buxton, Lawrence Barretto, Ariana Bravo,
Harry Benjamin, Damon Hill, Anthony Davidson, Karun Chandhok, Naomi Schiff

贊助與供應商品牌，一律保留原文：
Pirelli, Brembo, Shell, Petronas, Mobil 1, Aramco, Oracle, Rolex, DHL, Heineken,
Santander, Puma, Tag Heuer, Honda, Ferrari, Mercedes, Renault, Cosworth

═══════════════════════════════
【2026 技術規則新名詞】
═══════════════════════════════
Manual Override / override mode → 手動超車模式 (Manual Override)
   註：2026 起取代 DRS 的超車輔助系統，靠額外電能而非可變尾翼
active aerodynamics / active aero → 主動式空力
X-mode → X 模式（直線低阻力設定）
Z-mode → Z 模式（彎道高下壓力設定）
movable front wing / movable rear wing → 可動前翼 / 可動尾翼
50-50 power split → 引擎與電能各半的動力配比
sustainable fuel / e-fuel / drop-in fuel → 永續燃料
lighter car / nimbler car → 更輕的賽車 / 更靈活的賽車
reduced wheelbase → 縮短的軸距
narrower car → 更窄的車身
energy management → 能量管理
recharge / harvest / harvesting → 回充 / 回收電能
state of charge / SoC → 電池電量狀態
deployment / deploy → 電能釋放
clipping → 電能耗盡導致直線末端掉速
derate / derating → 電能不足降功率
full deploy → 全力釋放電能
charge mode / push mode / quali mode → 回充模式 / 推進模式 / 排位模式

═══════════════════════════════
【動力單元】
═══════════════════════════════
power unit / PU → 動力單元
internal combustion engine / ICE → 內燃機
MGU-K → 動能回收馬達 (MGU-K)
turbo / turbocharger → 渦輪
battery / energy store → 電池組
control electronics → 控制電子
engine mode / PU mode → 引擎模式
engine penalty / grid penalty → 引擎更換處罰 / 發車位處罰
component allocation → 零件配額
power unit change → 更換動力單元
reliability → 可靠度
engine blow / blow up / let go → 引擎爆缸
smoke / flames → 冒煙 / 起火

═══════════════════════════════
【輪胎】
═══════════════════════════════
soft / medium / hard → 軟胎 / 中性胎 / 硬胎
C1 C2 C3 C4 C5 C6 → 保留原文（Pirelli 配方代號）
intermediates / inters → 半雨胎
full wets / extreme wets → 全雨胎
slick → 光頭胎
degradation / deg → 輪胎衰退
thermal degradation → 熱衰退
graining → 起顆粒
blistering → 起水泡
flat spot → 胎面平斑
overheating / cooking the tyres → 輪胎過熱
switch on the tyres → 讓輪胎進入工作溫度
tyre window / operating window → 輪胎工作溫區
warm-up / out lap warm-up → 暖胎
tyre pressure → 胎壓
camber → 外傾角
fresh set / scrubbed set / used set → 全新胎 / 磨合過的胎 / 用過的胎
stint → 該段輪胎里程
long run → 長距離測試
tyre life → 輪胎壽命
cliff / falling off the cliff → 輪胎抓地力斷崖式下滑
marbles → 胎屑
dirty side of the grid → 發車位的髒側

═══════════════════════════════
【空力與底盤】
═══════════════════════════════
downforce → 下壓力
drag → 空氣阻力
dirty air → 亂流
clean air → 乾淨氣流
slipstream / tow → 尾流
floor → 底板
diffuser → 擴散器
sidepod → 側箱
front wing / rear wing → 前翼 / 尾翼
endplate → 端板
halo → Halo 護駕環
ride height → 離地高度
rake → 前後高低差角度
porpoising / bouncing → 海豚跳 / 彈跳
plank / skid block → 底板磨耗塊
sparks → 火花
setup → 車輛設定
low downforce spec / high downforce spec → 低下壓力設定 / 高下壓力設定
balance → 車輛平衡
understeer → 轉向不足
oversteer → 轉向過度
snap / snap of oversteer → 突然的轉向過度
traction → 抓地力
grip → 抓地力
mechanical grip / aero grip → 機械抓地力 / 空力抓地力
brake bias / brake migration → 煞車配比 / 煞車配比遷移
diff / differential → 差速器
kerb riding → 壓路緣
bottoming out → 底板觸地

═══════════════════════════════
【駕駛與圈速】
═══════════════════════════════
apex → 彎心
turn-in → 入彎點
exit → 出彎
braking point → 煞車點
lock up → 鎖死煞車
locking a wheel → 鎖死一輪
lift and coast → 提前收油滑行
short shift → 提前換檔
kerb → 路緣石
track limits → 賽道界線
lap time deleted → 圈速被刪除
purple sector → 全場最速分段
green sector → 個人最速分段
yellow sector → 未破紀錄的分段
personal best / PB → 個人最速
session best / SB → 本節最速
fastest lap → 最速圈
gap / delta → 差距
delta positive / delta negative → 落後目標時間 / 領先目標時間
sector one / two / three → 第一 / 二 / 三分段
flying lap / hot lap → 計時圈
prep lap → 準備圈
out lap / in lap → 出站圈 / 進站圈
cool down lap → 降溫圈
banker lap → 保底圈
tow lap → 借尾流的計時圈
traffic → 塞車 / 遇到慢車
compromised lap → 被影響的一圈

═══════════════════════════════
【策略與進站】
═══════════════════════════════
box / box box box → 進站
pit stop → 進站
pit window → 進站窗口
undercut → 提前進站搶位 (undercut)
overcut → 延後進站搶位 (overcut)
double stack → 兩車連續進站
one-stop / two-stop / three-stop → 一停 / 二停 / 三停
pit lane → 維修道
pit wall → 維修牆
garage → 維修站
unsafe release → 危險放行
slow stop → 進站失誤
jack → 千斤頂
wheel gun → 氣動扳手
cross-threaded → 螺帽鎖歪
stack up → 排隊等候
Plan A / Plan B → A 計畫 / B 計畫
offset → 輪胎新舊差
track position → 賽道位置
free stop → 免費進站機會
lap down / lapped car → 被套圈的車
backmarker → 後段車手
blue flags → 藍旗
let him by / give the position back → 讓位

═══════════════════════════════
【賽會、旗號與處罰】
═══════════════════════════════
Race Control → 賽事控制中心
stewards → 賽會幹事
Clerk of the Course → 賽事總監
noted by the stewards → 已被賽會記錄
under investigation → 調查中
investigated after the race → 賽後調查
no further action → 不予處分
safety car / SC → 安全車
virtual safety car / VSC → 虛擬安全車
safety car window → 安全車進站窗口
red flag → 紅旗
yellow flag / double yellow → 黃旗 / 雙黃旗
green flag → 綠旗
blue flag → 藍旗
black and white flag → 黑白旗警告
black flag → 黑旗
chequered flag → 方格旗
five-second penalty / ten-second penalty → 五秒加罰 / 十秒加罰
drive-through penalty → 通過維修道處罰
stop-go penalty → 停車加罰
grid penalty / grid drop → 發車位倒退處罰
reprimand → 申誡
disqualification / DSQ → 取消資格
penalty points → 罰分
jump start / false start → 起跑犯規
formation lap → 暖胎圈
standing start / rolling start → 靜止起跑 / 滾動起跑
grid slot → 發車格
parc ferme → 賽後封存 (parc ferme)
scrutineering → 技術檢查
technical directive → 技術指令
cost cap → 成本上限
curfew → 宵禁

═══════════════════════════════
【賽制與統計】
═══════════════════════════════
practice / FP1 FP2 FP3 → 練習賽
qualifying / quali → 排位賽
sprint / sprint race → 衝刺賽
sprint qualifying / sprint shootout → 衝刺排位賽
pole position → 竿位
front row → 首排
grid → 發車順序
podium → 頒獎台
constructors championship → 車隊冠軍
drivers championship → 車手冠軍
points finish → 積分完賽
championship lead → 積分榜領先
retirement / retired → 退賽
DNF → 退賽
lapped → 被套圈
classified → 完賽成績有效
race distance → 比賽距離
lap count → 圈數
50 laps to go → 還剩 50 圈

═══════════════════════════════
【2026 賽季賽道 — 一律保留英文原文】
═══════════════════════════════
Bahrain International Circuit (Sakhir)          — 巴林
Jeddah Corniche Circuit                          — 沙烏地
Albert Park (Melbourne)                          — 澳洲
Suzuka Circuit                                   — 日本
Shanghai International Circuit                   — 中國
Miami International Autodrome                    — 邁阿密
Circuit Gilles Villeneuve (Montreal)             — 加拿大
Circuit de Monaco                                — 摩納哥
Circuit de Barcelona-Catalunya                   — 西班牙
Red Bull Ring (Spielberg)                        — 奧地利
Silverstone Circuit                              — 英國
Circuit de Spa-Francorchamps                     — 比利時
Hungaroring                                      — 匈牙利
Circuit Zandvoort                                — 荷蘭
Autodromo Nazionale Monza                        — 義大利
Madring (Madrid)                                 — 西班牙馬德里，2026 新賽道
Baku City Circuit                                — 亞塞拜然
Marina Bay Street Circuit                        — 新加坡
Circuit of the Americas (COTA, Austin)           — 美國
Autodromo Hermanos Rodriguez                     — 墨西哥
Autodromo Jose Carlos Pace (Interlagos)          — 巴西
Las Vegas Strip Circuit                          — 拉斯維加斯
Lusail International Circuit                     — 卡達
Yas Marina Circuit                               — 阿布達比

賽道所在地名可翻譯（巴林、鈴鹿、蒙地卡羅、銀石），但賽道正式名稱保留原文。

═══════════════════════════════
【彎角俗名 — 全部保留英文原文，絕不翻譯或音譯】
═══════════════════════════════
Spa: La Source, Eau Rouge, Raidillon, Kemmel Straight, Les Combes, Malmedy,
     Rivage, Bruxelles, Pouhon, Fagnes, Campus, Stavelot, Blanchimont,
     Bus Stop Chicane, Paul Frere
Monza: Rettifilo, Variante del Rettifilo, Curva Grande, Variante della Roggia,
       Lesmo 1, Lesmo 2, Serraglio, Variante Ascari, Parabolica, Curva Alboreto
Monaco: Sainte Devote, Beau Rivage, Massenet, Casino Square, Mirabeau,
        Grand Hotel Hairpin, Fairmont Hairpin, Loews, Portier, Tunnel,
        Nouvelle Chicane, Tabac, Swimming Pool, Piscine, La Rascasse,
        Anthony Noghes
Silverstone: Abbey, Farm Curve, Village, The Loop, Aintree, Wellington Straight,
             Brooklands, Luffield, Woodcote, Copse, Maggotts, Becketts, Chapel,
             Hangar Straight, Stowe, Vale, Club
Suzuka: First Curve, Esses, S Curves, Dunlop Curve, Degner 1, Degner 2,
        Hairpin, Spoon Curve, 130R, Casio Triangle, Crossover
Zandvoort: Tarzan, Gerlach, Hugenholtz, Hunserug, Scheivlak, Mastersbocht,
           Arie Luyendyk
Interlagos: Senna S, Reta Oposta, Descida do Lago, Ferradura, Laranja,
            Pinheirinho, Bico de Pato, Mergulho, Juncao, Subida dos Boxes,
            Arquibancadas
Red Bull Ring: Niki Lauda Kurve, Remus, Schlossgold, Rindt, Jochen Rindt Kurve
Catalunya: Elf, Renault, Repsol, Seat, Wurth, Campsa, La Caixa,
           Banc Sabadell, New Holland
Montreal: Senna Corner, L'Epingle, Casino Straight, Wall of Champions
Baku: Castle Section, Old Town
Singapore: Sling Shot, Anderson Bridge, Memorial Corner, Marina Bay
Mexico: Foro Sol, Stadium Section, Peraltada, Esses
COTA: Turn 1, the Esses, Triple Apex, Hairpin
Hungaroring / Shanghai / Miami / Las Vegas / Lusail / Yas Marina / Madring
   — 多以編號稱呼（Turn 1、Turn 9），保留原文即可

歷史賽道與經典彎角（轉播回顧時常提及，保留原文）：
Nurburgring, Nordschleife, Karussell, Flugplatz, Fuchsrohre, Bergwerk,
Adenauer Forst, Brunnchen, Pflanzgarten, Schwedenkreuz,
Hockenheimring, Motodrom, Sachskurve,
Imola, Tamburello, Villeneuve, Tosa, Piratella, Acque Minerali,
Variante Alta, Rivazza,
Istanbul Park (Turn 8), Sepang, Estoril, Magny-Cours, Adelaide, Kyalami,
Paul Ricard, Mugello, Portimao, Buddh, Valencia, Jerez, Donington,
Brands Hatch, Watkins Glen, Long Beach, Indianapolis, Fuji, Osterreichring

**規則：任何賽道名或彎角名，若不確定，一律保留英文原文。**

═══════════════════════════════
【纏鬥與駕駛動作】
═══════════════════════════════
racing line → 走線
defensive line → 防守走線
switchback / cutback → 反切
dummy → 假動作
late braking → 延後煞車
dive bomb / lunge → 硬切內線
send it → 直接殺進去
wheel-to-wheel → 輪對輪纏鬥
side by side → 並排
three wide → 三車並行
squeeze / chop → 擠壓對手走線
weaving → 蛇行阻擋
one move rule → 只能防守一次的規定
hung out to dry → 被卡在外線吃虧
sandwiched → 被夾在中間
divebomb defence → 防守內線
slipstream battle → 尾流互咬
DRS train → DRS 車陣
tow into the corner → 借尾流進彎
brake test → 惡意煞車
contact → 碰撞
puncture → 爆胎
front wing damage → 前翼受損
spin → 打滑失控
off / run wide → 衝出賽道
gravel trap → 碎石區
run-off area → 緩衝區
barrier / wall → 護欄
beached → 卡在碎石區動不了
recovery → 車輛回收
double waved yellows → 雙黃旗區段

═══════════════════════════════
【天候與賽道狀況】
═══════════════════════════════
greasy → 路面濕滑
damp → 微濕
drying line → 乾線
standing water → 積水
aquaplaning → 水漂
spray → 水花
visibility → 能見度
crossover point → 換胎時機點
inters window → 半雨胎適用區間
track temperature → 路面溫度
ambient temperature → 氣溫
tailwind / headwind → 順風 / 逆風
grip level → 抓地水準
rubbered in → 賽道橡膠層形成
green track → 賽道橡膠不足
track evolution → 賽道演進

═══════════════════════════════
【賽季與合約用語】
═══════════════════════════════
rookie → 新人
sophomore season → 第二個賽季
silly season → 車手轉會傳聞期
contract extension → 續約
seat → 車手席次
seat fitting → 座艙適配
shakedown → 車輛試跑
filming day → 拍攝日
promotional event → 宣傳活動
launch → 新車發表
livery → 塗裝
upgrade package → 升級套件
development race → 開發競賽
token → 開發配額
Grand Slam / Grand Chelem → 大滿貫（竿位＋最速圈＋全程領先＋奪冠）
hat-trick → 帽子戲法
Driver of the Day → 當日最佳車手
title fight → 冠軍爭奪戰
mathematically out → 數學上已無奪冠可能

═══════════════════════════════
【車隊無線電常用語】
═══════════════════════════════
box box box → 進站 進站
push push push → 全力推進
copy / copy that → 收到
understood → 了解
stay out → 繼續留在場上
we are checking → 我們正在確認
how are the tyres → 輪胎狀況如何
target plus two → 目標配速加兩秒
mode push / mode charge → 切推進模式 / 切回充模式
overtake enabled → 超車模式已啟用
that is P3 → 目前第三名
gap behind → 後方差距
gap ahead → 前方差距
we have a problem → 車輛有狀況
retire the car → 收車退賽
hammer time → 全力進攻
plan B → 執行 B 計畫
good job / great drive → 幹得好 / 開得漂亮
sorry mate → 抱歉

═══════════════════════════════
【翻譯風格範例 — 照這個長度與語氣】
═══════════════════════════════
"And we're looking at Charles Leclerc down to turn number one."
→ 我們看到 Charles Leclerc 進一號彎

"Verstappen is boxing this lap, that's the undercut on Norris."
→ Verstappen 這圈進站，這是對 Norris 的 undercut

"He's got the overtake mode deployed here, big run down the straight."
→ 他啟動了超車模式，直線上速度差很大

"Massive lock-up into the hairpin and he's flat-spotted the front left."
→ 髮夾彎前嚴重鎖死，左前胎磨出平斑了

"That's a five-second penalty for the unsafe release."
→ 危險放行，五秒加罰`;

// ---------------------------------------------------------------------------
// 遠端設定 —— 改這裡就能熱修所有用戶，不用重新送審擴充功能
// 選擇器用陣列依序嘗試：F1TV 灰度推送期間新舊版會同時存在
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 遠端設定
//
// 除了選擇器，還帶三個**分階段推送**用的欄位（P3-PLAN 第 1 節）：
//
//   rollout          0~100。只有這個比例的安裝會套用這一版，其餘沿用上一版。
//                    分流依 installId 雜湊，同一個人永遠落在同一組，不會忽新忽舊。
//   killSwitch       true = 所有用戶端停用疊字，乾淨退回原生英文字幕。
//                    F1TV 大改版而我們一時修不好時，這比讓使用者看錯亂的疊字好。
//   minClientVersion 低於此版的用戶端顯示「請更新」並停止翻譯。
//
// 為什麼需要：`wrangler deploy` 與 `POST /v1/config` 現在都是「一改就全中」。
// 收費之後，一次失誤 = 所有付費使用者同時故障。
// ---------------------------------------------------------------------------
const REMOTE_CONFIG = {
  version: 1,
  rollout: 100,
  killSwitch: false,
  minClientVersion: '0.0.0',

  // ---- 免費層 ----
  // 四種正式賽事場次的前 15 分鐘免費，其餘 F1TV 影片（賽後節目、紀錄片、
  // 集錦、車手訪談⋯）不含在免費內。
  //
  // 用網址 slug 分類，而且**放在遠端設定**——F1TV 隨時可能改命名規則，
  // 寫死在用戶端的話就得重新送審。實測到的 slug：
  //   2026-barcelona-gp-practice-1 / 2026-barcelona-gp-qualifying
  //   2026-miami-gp-sprint         / （正賽推測為 -race）
  // 不免費的：post-race-show-monaco、weekend-warm-up-miami
  // ---- 2026 賽程 ----
  //
  // ⚠️ **放在遠端設定，不是寫死在用戶端。** 2026 這個賽季特別容易變動：
  //    中東戰事已經讓四月整個月的兩場比賽消失，而年底兩場還在待決。
  //    寫死在擴充功能裡的話，每次賽程異動都要重新送審、等 1~3 天、
  //    再等使用者更新——而 Weekend Pass 賣的就是「某一場比賽的週末」，
  //    賽程錯了就是使用者付錢買到錯的日期。
  //
  // 資料來源與查證日期：2026-08-17，以 formula1.com、Wikipedia、
  // Sky Sports／FIA 公告三方交叉比對。
  //
  // 2026 的三項異動：
  //   · 巴林（原 4/10–12 Sakhir）與沙烏地（原 4/17–19 Jeddah）因伊朗戰事取消
  //   · 巴林 GP 移師馬來西亞 Sepang，10/02–04 舉行，
  //     官方名稱為「Formula 1 Gulf Air Bahrain Grand Prix in Malaysia」
  //   · 西班牙站移至馬德里新賽道 Madring（不是巴塞隆納；巴塞隆納是 6 月那場）
  // 結果是 23 場而非原定的 24 場，且**四月完全沒有比賽**。
  //
  // `tentative: true` 代表尚未確定。卡達與阿布達比仍受中東情勢影響，
  // F1 訂在九月中做決定；若取消，賽季將改在歐洲收尾（Imola／Portimão 為候選）。
  // **計算「剩餘場次」時待決場次不計入**——寧可低估，也不要拿一場可能不存在的
  // 比賽去說服使用者買方案。
  //
  // 日期格式 YYYY-MM-DD，`start` 是練習賽第一天、`end` 是正賽當天。
  // 時區一律用 UTC 判斷，不做各站當地時間換算：Weekend Pass 的範圍會往兩邊
  // 各放寬一天，那個緩衝遠大於任何時區差。
  seasonYear: 2026,
  schedule: [
    { r: 1, name: '澳洲', start: '2026-03-06', end: '2026-03-08' },
    { r: 2, name: '中國', start: '2026-03-13', end: '2026-03-15', sprint: true },
    { r: 3, name: '日本', start: '2026-03-27', end: '2026-03-29' },
    { r: 4, name: '邁阿密', start: '2026-05-01', end: '2026-05-03', sprint: true },
    { r: 5, name: '加拿大', start: '2026-05-22', end: '2026-05-24', sprint: true },
    { r: 6, name: '摩納哥', start: '2026-06-05', end: '2026-06-07' },
    { r: 7, name: '巴塞隆納', start: '2026-06-12', end: '2026-06-14' },
    { r: 8, name: '奧地利', start: '2026-06-26', end: '2026-06-28' },
    { r: 9, name: '英國', start: '2026-07-03', end: '2026-07-05', sprint: true },
    { r: 10, name: '比利時', start: '2026-07-17', end: '2026-07-19' },
    { r: 11, name: '匈牙利', start: '2026-07-24', end: '2026-07-26' },
    // ⚠️ `afterSummerBreak` 標的是**夏休之後的第一場**，定價的分界就在這裡。
    //    為什麼用人工標記而不是「自動抓最長間隔」：2026 最長的間隔在四月
    //    （3/29 日本 → 5/01 邁阿密，33 天，因為巴林與沙烏地被取消），
    //    比真正的夏休（7/26 匈牙利 → 8/21 荷蘭，26 天）還長。
    //    自動偵測會把分界點放在四月，整個上半季賣錯價而且不會報錯。
    { r: 12, name: '荷蘭', start: '2026-08-21', end: '2026-08-23', sprint: true, afterSummerBreak: true },
    { r: 13, name: '義大利', start: '2026-09-04', end: '2026-09-06' },
    { r: 14, name: '西班牙（馬德里）', start: '2026-09-11', end: '2026-09-13' },
    { r: 15, name: '亞塞拜然', start: '2026-09-24', end: '2026-09-26' },
    { r: 16, name: '巴林（馬來西亞 Sepang）', start: '2026-10-02', end: '2026-10-04' },
    { r: 17, name: '新加坡', start: '2026-10-09', end: '2026-10-11', sprint: true },
    { r: 18, name: '美國', start: '2026-10-23', end: '2026-10-25' },
    { r: 19, name: '墨西哥', start: '2026-10-30', end: '2026-11-01' },
    { r: 20, name: '巴西', start: '2026-11-06', end: '2026-11-08' },
    { r: 21, name: '拉斯維加斯', start: '2026-11-19', end: '2026-11-21' },
    { r: 22, name: '卡達', start: '2026-11-27', end: '2026-11-29', tentative: true },
    { r: 23, name: '阿布達比', start: '2026-12-04', end: '2026-12-06', tentative: true },
  ],

  freeTier: {
    seconds: 900,
    // 順序有意義：先排除，再納入。避免 "sprint-qualifying" 之類的組合誤判。
    exclude: ['post-race', 'weekend-warm-up', 'highlights', 'press-conference', 'review', 'documentary'],
    include: ['practice', 'qualifying', 'sprint', '-race$', 'grand-prix$'],
  },
  sites: [
    {
      host: 'f1tv.formula1.com',
      captionRoot: ['.tm-subtitle-region-container'],
      captionLabel: ['.tm-ui-subtitle-label'],
      contentIdPattern: '/detail/(\\d+)',
      hideCss: '.tm-subtitle-region-container{opacity:0 !important}',
    },
  ],
};

// ---------------------------------------------------------------------------
// 授權：每個安裝一枚權杖（取代所有人共用的 CLIENT_TOKEN）
//
// 為什麼非改不可（SECURITY.md S6）：
// CLIENT_TOKEN 隨擴充功能發給每一位使用者，任何人解開 .crx 就拿得到——**等於公開**。
// 搭配 CORS `*`，任何網站都能無限呼叫 /v1/translate 燒掉 Anthropic 額度。
// 這不是加檢查能解決的，必須讓「每個安裝有自己的身分」。
//
// 設計取捨：**不做帳號系統**。使用者不需要註冊、不需要 email，
// 首次啟動時匿名換一枚權杖就好。這樣：
//   - 每個安裝可獨立限額、獨立撤銷（濫用或退款時）
//   - 速率限制終於有意義的鍵（IP 換 proxy 就繞過，installId 不行）
//   - P3 要接付費時，同一枚權杖加上 plan 欄位即可，不用重做
//
// 權杖格式：<installId>.<exp>.<HMAC-SHA256 簽章>
// 驗證只需要 HMAC，**不必讀 KV**，所以每次請求的成本是零。
// 撤銷才需要查 KV，而撤銷清單很小且可快取。
// ---------------------------------------------------------------------------
const TOKEN_TTL_DAYS = 90;

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

/**
 * 常數時間比對。
 * 一般的 `!==` 會在第一個不同的位元組就返回，理論上可由回應時間推出正確值。
 * 跨網路且有速率限制時實務上不可行，但比對密鑰本來就該用常數時間——
 * 成本是三行，沒有理由不做。（SECURITY.md S11）
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 把 installId 穩定地映射到 0~99 的一個桶。
 * 同一個安裝永遠落在同一個桶，所以推送 10% 時，那 10% 的人不會忽新忽舊。
 */
async function bucketOf(installId) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(installId)));
  return new Uint8Array(buf)[0] % 100;
}

function tokenSecret(env) {
  // 沒有專用 secret 時退回 ADMIN_TOKEN 衍生，讓既有部署不會壞。
  // 正式環境應該 `wrangler secret put TOKEN_SECRET`。
  return env.TOKEN_SECRET || (env.ADMIN_TOKEN ? env.ADMIN_TOKEN + ':install' : null);
}

async function issueInstallToken(env) {
  const secret = tokenSecret(env);
  if (!secret) throw new Error('伺服器未設定 TOKEN_SECRET');
  const installId = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86400;
  const payload = `${installId}.${exp}`;
  return { token: `${payload}.${await hmac(secret, payload)}`, installId, exp };
}

// 撤銷清單。整份放一個 key，用 isolate 內快取避免每個請求都讀 KV。
//
// **這份清單是「停用／刪除授權」唯一能立刻生效的機制。**
// 通行證（entitlement）是簽出去的，簽完就獨立生效到期限為止——
// 後端刪掉授權碼並不會讓已經發出去的通行證失效。所以停用或刪除時
// 必須把該授權底下的所有安裝寫進這裡，`entitlementGate` 才擋得住。
//
// 項目格式演進（兩種都要讀得懂）：
//   舊："installId"                 —— 永久有效，會無限累積
//   新：{ i: installId, u: 到期秒 } —— 只需要撐到該通行證自然過期
//
// 為什麼要有到期時間：通行證最長 14 天，過期後那筆撤銷紀錄就沒有意義了。
// 不清掉的話，每刪一組授權就永久留下最多 3 筆，這份「應該永遠很小」的清單
// 會慢慢長大，而它是每次翻譯都要讀的東西。
let revCache = { at: 0, set: null };

/** 讀出並整理撤銷清單。回傳 { list, set }，list 已剔除過期項目。 */
async function revokedRead(env) {
  let raw = [];
  try { raw = JSON.parse((await env.SUBS.get('revoked')) || '[]'); } catch (e) { /* 壞掉當空的 */ }
  if (!Array.isArray(raw)) raw = [];
  const now = nowSec();
  const list = [];
  const set = new Set();
  for (const it of raw) {
    if (typeof it === 'string') { list.push(it); set.add(it); continue; }   // 舊格式，永久保留
    if (!it || typeof it.i !== 'string') continue;
    if (it.u && it.u < now) continue;                                       // 已過期，順手剔除
    list.push(it); set.add(it.i);
  }
  return { list, set };
}

async function revokedSet(env) {
  if (revCache.set && Date.now() - revCache.at < 60000) return revCache.set;
  const { set } = await revokedRead(env);
  revCache = { at: Date.now(), set };
  return set;
}

/**
 * 通行證作廢清單。**與 `revoked` 是不同的東西，不要合併。**
 *
 * | | `revoked` | `entvoid`（這裡） |
 * |---|---|---|
 * | 語意 | 封鎖整個安裝 | 只讓已發出的通行證失效 |
 * | 後果 | 連免費層都用不了 | **退回免費層**，還能看每場前 15 分鐘 |
 * | 用途 | 濫用、盜用 | 刪除授權碼、停用、清空裝置 |
 *
 * 為什麼一定要分開：刪掉一組發錯的授權碼，不該讓那個人的瀏覽器連免費層
 * 都用不了——那是懲罰，不是修正。但用同一份清單就會變成那樣，
 * 而且完全不會報錯，只會有人寫信來說「我連免費的都不能用了」。
 */
let voidCache = { at: 0, set: null };

async function entVoidRead(env) {
  let raw = [];
  try { raw = JSON.parse((await env.SUBS.get('entvoid')) || '[]'); } catch (e) { /* 壞掉當空的 */ }
  if (!Array.isArray(raw)) raw = [];
  const now = nowSec();
  const list = [];
  const set = new Set();
  for (const it of raw) {
    if (!it || typeof it.i !== 'string') continue;
    if (it.u && it.u < now) continue;               // 通行證早就自然過期了，剔除
    list.push(it); set.add(it.i);
  }
  return { list, set };
}

async function entVoidSet(env) {
  if (voidCache.set && Date.now() - voidCache.at < 60000) return voidCache.set;
  const { set } = await entVoidRead(env);
  voidCache = { at: Date.now(), set };
  return set;
}

/**
 * 讓這些安裝手上的通行證失效。
 *
 * ⚠️ KV 沒有 CAS（坑 #24）。這是「讀→改→寫」，兩個管理動作同時進行會互相覆蓋。
 *    頻率極低，但**漏掉一筆的後果是被停用的人還能繼續用**，
 *    所以寫回前重讀合併，成本一次 KV 讀取。
 */
async function voidEntitlements(env, installIds, untilSec) {
  const ids = (installIds || []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return 0;
  // 只需要撐到通行證自然過期為止；再久就是無意義地讓清單長大。
  const until = untilSec || (nowSec() + ENTITLEMENT_DAYS * 86400);
  const { list, set } = await entVoidRead(env);
  for (const id of ids) {
    if (set.has(id)) continue;
    list.push({ i: id, u: until });
  }
  await env.SUBS.put('entvoid', JSON.stringify(list));
  voidCache = { at: 0, set: null };
  return list.length;
}

/** 恢復。後台按「恢復」時要走這條，否則畫面說成功、使用者還是不能用。 */
async function unvoidEntitlements(env, installIds) {
  const ids = new Set((installIds || []).filter(Boolean));
  if (!ids.size) return 0;
  const { list } = await entVoidRead(env);
  const next = list.filter((it) => !ids.has(it.i));
  await env.SUBS.put('entvoid', JSON.stringify(next));
  voidCache = { at: 0, set: null };
  return next.length;
}

/**
 * 驗證用戶端權杖。回傳 { ok, installId } 或 { ok:false, reason }。
 *
 * 相容性：舊的共用 CLIENT_TOKEN 仍然接受，但會標記成 legacy。
 * 這是為了讓 userscript（管理員工具）與尚未更新的安裝不會突然壞掉——
 * **但 legacy 走比較嚴格的限額**，見 handleTranslate。
 */
async function authClient(env, request) {
  const raw = request.headers.get('x-client-token') || '';
  if (!raw) return { ok: false, reason: 'missing token' };

  const parts = raw.split('.');
  if (parts.length === 3) {
    const [installId, expStr, sig] = parts;
    const secret = tokenSecret(env);
    if (!secret) return { ok: false, reason: 'server misconfigured' };
    const expect = await hmac(secret, `${installId}.${expStr}`);
    if (!safeEqual(sig, expect)) return { ok: false, reason: 'bad signature' };
    if (Number(expStr) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
    if ((await revokedSet(env)).has(installId)) return { ok: false, reason: 'revoked' };
    return { ok: true, installId, legacy: false };
  }

  // 舊格式：所有人共用的那一枚
  if (env.CLIENT_TOKEN && safeEqual(raw, env.CLIENT_TOKEN)) {
    return { ok: true, installId: 'legacy', legacy: true };
  }
  return { ok: false, reason: 'invalid token' };
}

function authAdmin(env, request) {
  return !!env.ADMIN_TOKEN && safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN);
}

// ---------------------------------------------------------------------------
// 成本統計與熔斷
//
// 為什麼要自己做：Anthropic 的帳單是事後的，被攻擊時你會在月底才知道。
// 這裡要能即時回答「今天花了多少」「哪支影片最貴」「快取還有沒有生效」。
//
// 為什麼不用 KV 逐筆寫：KV 免費額度 1,000 puts/天，已經撞過一次（坑 #19）。
// 改成 **isolate 內累積、每 15 分鐘或滿 200 筆才落地一次**，
// 最壞 96 puts/天。代價是 isolate 被回收時會掉最後一小段——
// 成本可觀測性容許近似值，額度不容許。
// ---------------------------------------------------------------------------

// Haiku 4.5 每百萬 token 的美元單價。改模型時要一起改。
const PRICE = { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };

const STATS_FLUSH_MS = 15 * 60 * 1000;
const STATS_FLUSH_N = 200;
let pending_ = { at: Date.now(), n: 0, rows: {} };

function statsKey(d) {
  const t = new Date(d || Date.now());
  return `stats:${t.toISOString().slice(0, 10)}`;      // 一天一個 key
}

function costOf(u) {
  return (u.input_tokens || 0) / 1e6 * PRICE.in
    + (u.output_tokens || 0) / 1e6 * PRICE.out
    + (u.cache_read_input_tokens || 0) / 1e6 * PRICE.cacheRead
    + (u.cache_creation_input_tokens || 0) / 1e6 * PRICE.cacheWrite;
}

/**
 * 每位使用者的用量。
 *
 * 為什麼要獨立一份，而不是加在 stats 的每支影片底下：
 * **兩個問題不一樣。** 「哪支影片花最多錢」是內容問題（要不要預先收割）；
 * 「哪個安裝花最多錢」是濫用與單位經濟問題（有人在燒錢嗎？付費者的
 * 平均成本是多少？）。混在一起會讓兩邊的維度都變成笛卡兒積，資料量爆掉。
 *
 * ⚠️ **一天一個 key，跟著 stats 同一次 flush 落地。**
 *    KV 寫入是免費方案的天花板（1,000/天，坑 #10），
 *    所以絕不能「每位使用者一個 key」——那是每天上萬次寫入。
 *
 * ⚠️ 筆數要有上限。無界成長的 value 遲早撞上 KV 的 25MB 單值上限，
 *    而那會**讓整份統計寫不進去**（連帶影響成本熔斷）。
 *    超過上限的併進 __others，寧可失去尾端的解析度也不要整份掉。
 */
const USTATS_MAX_ROWS = 2000;
let upending_ = {};

function ustatsKey(d) {
  const t = new Date(d || Date.now());
  return `ustats:${t.toISOString().slice(0, 10)}`;
}

function recordUserUsage(installId, plan, usage, translated, cachedHits) {
  const id = String(installId || 'unknown').slice(0, 40);
  const r = upending_[id] || (upending_[id] = {
    calls: 0, translated: 0, cached: 0,
    in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
  });
  r.calls++;
  r.translated += translated || 0;
  r.cached += cachedHits || 0;
  r.in += usage.input_tokens || 0;
  r.out += usage.output_tokens || 0;
  r.cacheRead += usage.cache_read_input_tokens || 0;
  r.cacheWrite += usage.cache_creation_input_tokens || 0;
  r.plan = plan || r.plan;
  r.last = nowSec();
}

async function flushUserStats(env) {
  const mine = upending_;
  if (!Object.keys(mine).length) return;
  upending_ = {};
  const key = ustatsKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { day = {}; }
  for (const [id, r] of Object.entries(mine)) {
    // 已經滿了就併進 __others，不要讓 value 無界成長
    const target = (day[id] || Object.keys(day).length < USTATS_MAX_ROWS) ? id : '__others';
    const d = day[target] || (day[target] = {
      calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
    });
    for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
      d[k] = (d[k] || 0) + r[k];
    }
    d.plan = r.plan || d.plan;
    d.last = Math.max(d.last || 0, r.last || 0);
  }
  await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: 120 * 86400 });
}

function recordUsage(cid, usage, translated, cachedHits) {
  const r = pending_.rows[cid] || (pending_.rows[cid] = {
    calls: 0, translated: 0, cached: 0,
    in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
  });
  r.calls++;
  r.translated += translated || 0;
  r.cached += cachedHits || 0;
  r.in += usage.input_tokens || 0;
  r.out += usage.output_tokens || 0;
  r.cacheRead += usage.cache_read_input_tokens || 0;
  r.cacheWrite += usage.cache_creation_input_tokens || 0;
  pending_.n++;
}

function shouldFlush() {
  return pending_.n >= STATS_FLUSH_N || (pending_.n > 0 && Date.now() - pending_.at > STATS_FLUSH_MS);
}

/** 落地統計。與 bundle 一樣是多寫入者，所以同樣要「重讀再合併」（坑 #24）。 */
async function flushStats(env) {
  if (!pending_.n) return;
  const mine = pending_.rows;
  pending_ = { at: Date.now(), n: 0, rows: {} };
  const key = statsKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { /* 壞掉重來 */ }
  for (const [cid, r] of Object.entries(mine)) {
    const d = day[cid] || (day[cid] = { calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    for (const k of Object.keys(r)) d[k] = (d[k] || 0) + r[k];
  }
  await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: 400 * 86400 });
  // 每位使用者的那份跟著同一次落地。**不要另外排一個時程**——
  // 兩份各自 flush 等於 KV 寫入翻倍，而那是這個專案的天花板。
  try { await flushUserStats(env); } catch (e) { /* 使用者統計失敗不影響成本熔斷 */ }
}

/**
 * 成本熔斷。
 *
 * 沒有這個的話，S6 的共用密鑰被濫用時，你會在帳單來的時候才知道。
 * 超過上限就停掉「會花錢的路徑」（/v1/translate），
 * **但共用快取的讀取照常** —— 已經翻好的影片仍然完全可用，
 * 使用者體驗只退化成「新影片暫時不翻」，不是整個壞掉。
 */
const DAILY_USD_CAP_DEFAULT = 5;

async function dailyCost(env) {
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(statsKey())) || '{}'); } catch (e) { /* noop */ }
  let usd = 0;
  for (const r of Object.values(day)) {
    usd += costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    });
  }
  // 加上還沒落地的部分，否則熔斷會慢 15 分鐘
  for (const r of Object.values(pending_.rows)) {
    usd += costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    });
  }
  return usd;
}

let breakerCache = { at: 0, usd: 0 };
async function overBudget(env) {
  const cap = Number(env.DAILY_USD_CAP || DAILY_USD_CAP_DEFAULT);
  if (!(cap > 0)) return false;
  if (Date.now() - breakerCache.at > 60000) {
    breakerCache = { at: Date.now(), usd: await dailyCost(env) };
  }
  return breakerCache.usd >= cap;
}

/**
 * 譯文合理性檢查（SECURITY.md S9）。
 *
 * `/v1/translate` 的輸入直接進模型，攻擊者可以用 prompt injection 讓輸出
 * 受他控制，再寫進**他指定的 cid**——所有後續觀看者都會拿到被汙染的譯文。
 *
 * 完全防不了 injection，但可以讓「被汙染的東西進不了共用快取」：
 * 不合格的譯文仍然回傳給請求者（他自己愛看什麼是他的事），只是不寫回 bundle。
 */
const INJECTION_HINT = /ignore (all |the )?(previous|above)|system prompt|you are now|<\|.*?\|>|assistant:|忽略(上述|先前)|你現在是/i;

function plausibleTranslation(en, zh) {
  if (typeof zh !== 'string') return false;
  const t = zh.trim();
  if (!t) return false;
  if (t.length > Math.max(120, en.length * 3)) return false;   // 譯文暴長 = 不對勁
  if (INJECTION_HINT.test(t)) return false;
  // 正常譯文一定有中文；純英文回來通常代表模型照抄或被帶偏
  if (!/[\u4e00-\u9fff]/.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 授權（License）—— 與「安裝權杖」是兩件不同的事，不可混為一談
//
//   安裝權杖  綁**裝置**。用途是濫用防護：限額、撤銷、分階段推送的分流。
//             匿名換發，不需要也不應該跟著人走。
//   授權      綁**人**。用途是證明付過錢。**換電腦、重灌、換瀏覽器都必須還在。**
//
// v2.0 把後者做成前者是設計錯誤：付費使用者換一台電腦就失效。
//
// 設計：不做密碼登入，但保留「找得回來」的能力。
//   1. 付款成功 → 產生授權碼 PL-XXXX-XXXX-XXXX，寄到金流回傳的 email
//   2. 使用者在**任何**裝置貼上授權碼 → 綁定該安裝，換回一張有期限的通行證
//   3. 通行證離線可驗（HMAC），**後端掛掉時已付費的人照常能用**
//   4. 同時最多 3 台裝置；第 4 台會被擋，使用者可自行解除舊的
//   5. 忘記授權碼 → 用 email 查回（email 來自金流，我們不另外收集）
//
// 這不是帳號系統：沒有密碼、沒有註冊流程、沒有個人資料頁。
// 就是一組可攜帶、可補發、可撤銷的授權碼——獨立軟體最常見的做法。
// ---------------------------------------------------------------------------
const MAX_DEVICES = 3;

/**
 * 方案定義。
 *
 * 期限必須由**伺服器**算，不能靠發碼時手填——手填一定會錯，
 * 而錯的方向通常是「多給」或「少給」，兩邊都是糾紛。
 *
 *   trial     14 天。給「想先試試看」的人，或客服補償用。
 *             不是免費層——免費層是另一回事（每支影片前 N 句），不需要授權碼。
 *   season    到該賽季結束（隔年 1 月 31 日）。F1 賽季橫跨年底，
 *             用「12 月 31 日」會讓最後幾場比賽剛好斷掉。
 *   lifetime  無期限。
 */
// 單場價。定價守門用得到它（整季票不可比單場×剩餘週末貴），
// 所以宣告在 PLANS 之前——放後面會 TDZ，而那要到執行時才炸。
const WEEKEND_PRICE = 39;

// 兩段整季價。**同樣必須宣告在 PLANS 之前**——season_next 的 price 直接引用它，
// 放在後面會 TDZ： 完全過得去，只有真的載入時才炸（實際踩過）。
const PRICE_FIRST_HALF = 599;
const PRICE_SECOND_HALF = 299;

const PLANS = {
  // 免費層。不需要授權碼——四種正式場次的前 15 分鐘，見 REMOTE_CONFIG.freeTier。
  // 列在這裡是為了讓後台與統計有一致的名稱可用。
  trial: { label: 'GP Trial', price: 0, days: null, public: true, free: true },

  // 早鳥。限量 20 組，賣完就只剩正式價。
  season_early: { desc: "與 Season 完全相同，僅價格不同。限量供應，售完即止。", label: 'Season Early Access', price: 399, untilSeasonEnd: true, limit: 20 },

  // 正式價。
  season: { desc: "整個賽季不限時數、不限場次。涵蓋所有練習賽、排位賽、衝刺賽與正賽，以及 F1TV 上的重播與節目。效期至賽季結束（隔年 1 月 31 日）。", label: 'Season', price: 599, untilSeasonEnd: true },

  // 下一賽季通行證。
  //
  // 為什麼要獨立成一個方案，而不是讓 season 在季末自動變成「下一季」？
  // 因為那樣**同一張卡片會在某一天突然換成另一個商品**，價格還從 299 跳回 599。
  // 使用者看到的是「漲價」，實際上是換商品——那種困惑沒有文案救得回來。
  //
  // 拆開之後兩張卡各自說自己的話：
  //   本賽季通行證  上半季 599／夏休起 299，隨時買得到
  //   下一賽季通行證 599，**平常鎖住**，本季剩不到 8 個比賽週末才開放預購
  //
  // ⚠️ 鎖住不等於隱藏。留在頁面上並說明為什麼不能買，比整張消失好——
  //    消失會讓人以為賣完了或網站壞了，而「即將開放」本身就是預告。
  season_next: {
    desc: "下一個賽季的完整通行證，涵蓋該季所有場次。於本賽季尾聲開放預購，購買後本賽季剩餘場次一併附贈。",
    label: '下一賽季通行證', price: PRICE_FIRST_HALF, nextSeasonOnly: true,
  },

  // 一週通行證。**不是「比賽週末」而是完整七天。**
  //
  // 改動理由（使用者觀察，正確）：F1TV 就算不在比賽週也有大量重播可看，
  // 只給週四到週日太窄，而且「一週」在銷售上比「一個週末」好講。
  //
  // 生效方式見 `weekWindow()`：**購買當下立刻可用（贈送），正式七天從
  // 下一個比賽週的星期一起算**。使用者不必做任何決定，也不會算錯。
  week: { desc: "完整七天，不限時數。購買當下即可使用，正式七日自下一個比賽週的星期一起算，因此一定完整涵蓋該週的練習賽、排位賽與正賽。非比賽週亦可觀看 F1TV 上的重播與節目。", label: '一週通行證', price: WEEKEND_PRICE, days: 7, weekBound: true },

  // 客服補償用，不公開販售。
  comp: { label: '客服補償', price: 0, days: 30 },

  // ---- 代訂附帶的兩個內部方案（不公開販售，只由 webhook 發出）----
  //
  // 為什麼要獨立成方案，而不是直接發一張 week？
  // **後台要分得出「這一週是代訂送的」還是「使用者自己花 39 元買的」。**
  // 兩者的商業意義完全不同：前者是成本，後者是營收；退款、續購、
  // 升級抵扣的處理也不一樣（送的那一週不該拿來折抵賽季票，
  // 否則等於用我們送的東西折我們自己的錢）。
  //
  // ⚠️ 這同時修掉一個嚴重的漏洞。**在此之前，只買代訂（購物車裡全是
  //    manual 項目）時，quoteCart 的 primary 會取到代訂方案本身，
  //    而代訂方案沒有 days／untilSeasonEnd／weekBound，
  //    planExpiry 回 null ＝「無期限」——買一次 79 元的五天代訂，
  //    拿到的是一張永遠不會過期的字幕授權。** 不報錯，只是白送。
  week_svc: {
    label: '一週通行證（代訂）', price: 0, days: 7, weekBound: true,
    internal: true, fromService: true,
  },
  // 五天代訂不附贈字幕授權（商品說明已寫明）。仍然要發一筆記錄讓後台
  // 追得到這張訂單，但它**不可以帶著任何字幕使用權**——
  // 所以給一個立刻到期的期限，而不是 null（null ＝ 無期限）。
  svc_none: {
    label: '代訂服務（不含字幕授權）', price: 0, internal: true, noSubs: true,
  },

  // ---- 代訂服務 ----
  //
  // ⚠️ 這些**不是軟體授權，是人工服務**。付款後由人去操作，
  //    所以 `manual: true`：發的授權碼只代表「已付款、待處理」，
  //    後台要看得到並手動結案。把它們放進同一個 PLANS 是為了讓
  //    購物車、金流、訂單查詢共用同一套流程，不必再寫一份。
  //
  // `bundleWeek: true` 代表附贈一個比賽週的翻譯使用權（五天方案不附）。
  // ⚠️ 鍵名保留了 `_own` 後綴，但**那個區分已經取消**（2026-08-17）。
  //    原本每個時長有「自備帳號／無自備帳號」兩種，實際作業沒有差別，
  //    只是讓買家多做一次不必要的選擇；現在統一成一種，只需要 email。
  //    **鍵名不改**——改了會讓既有訂單與授權記錄裡的 `plan` 對不上，
  //    而那是查不回來的資料。命名難看勝過資料對不起來。
  //
  // 自備帳號省下開帳號的工，但多了帳號往返的溝通，兩邊打平。
  //
  // ⚠️ **全部都必須標示「觀看時需自備 VPN」**：台灣訂閱 F1TV 需要 VPN，
  //    這是買家最容易忽略、事後最容易變成糾紛的一點。
  svc_pro_5d: { desc: "代為完成 F1TV Pro 五天訂閱。Pro 方案包含：所有場次無廣告直播與隨選、車上鏡頭、車隊無線電、F2／F3／F1 學院／保時捷超級盃、比賽週末獨家節目、即時計時與遙測、輪胎使用與車手位置圖、延遲重播、車隊無線電精選、獨家節目與紀錄片。**不含** Multiview 多視角、4K UHD／HDR、六台裝置同時觀看。本方案不附贈字幕翻譯使用權。", label: 'F1TV Pro 代訂 5 天', price: 79, manual: true, vpn: true },
  svc_pro_1m_own: { desc: "代為完成訂閱，僅需提供您的 email。隨附一個比賽週的字幕翻譯使用權。", label: 'F1TV Pro 代訂 1 個月', price: 329, manual: true, vpn: true, bundleWeek: true },
  svc_prem_1m_own: { desc: "代為完成訂閱，僅需提供您的 email。隨附一個比賽週的字幕翻譯使用權。", label: 'F1TV Premium 代訂 1 個月', price: 699, manual: true, vpn: true, bundleWeek: true },
  svc_pro_1y_own: { desc: "與上者相同，但使用您自備的 F1TV 帳號完成訂閱。隨附一個比賽週的字幕翻譯使用權。", label: 'F1TV Pro 代訂 1 年', price: 2199, manual: true, vpn: true, bundleWeek: true },
  svc_prem_1y_own: { desc: "與上者相同，但使用您自備的 F1TV 帳號完成訂閱。隨附一個比賽週的字幕翻譯使用權。", label: 'F1TV Premium 代訂 1 年', price: 4599, manual: true, vpn: true, bundleWeek: true },
};

/**
 * 賽季中的分段定價。
 *
 * 問題：8 月才加入的人，付 599 卻只看得到剩下 8 場，會覺得不划算——
 * 而「覺得不划算」不會變成客訴，會變成**不買**。
 *
 * 用固定分段而不是按場次比例：比例定價每天都不同價，
 * 使用者會覺得「明天會不會更便宜」而拖延；分段是明確的門檻，
 * 而且好溝通（「現在是下半季價」比「現在是 62% 價」清楚得多）。
 *
 * 分段以**月份**為界，因為 F1 賽季的場次分布每年不同，
 * 用月份切才不必每年重寫。賽季大約 3 月開跑、12 月結束。
 */
/**
 * Season Pass 的分段價目表。**依「剩餘比賽週末」，不依月份。**
 *
 * ⚠️ 這裡在 2026-08-17 改過依據，原本是按月份切（1~5 月全價／6~8 月七折⋯）。
 *    月份原本是「還剩多少可看」的代理指標，但 2026 把這個代理打壞了：
 *    中東戰事讓四月兩場消失，於是「6~8 月」這一段從 6/1 的 18 個週末
 *    一路掉到 8/17 的 10 個週末——**同一個價格帶橫跨的價值差了快一倍**。
 *    以 8/17 為例，399 元買 10 個週末等於每個週末 40 元，
 *    比單買 Weekend Pass（39 元）還貴，Season Pass 變成負價值商品。
 *
 * 為什麼算「比賽週末」而不是「場次」：一個 GP 週末裡有三場練習、可能有衝刺賽、
 * 排位賽、正賽，再加上一堆 F1TV 自製節目。使用者心裡的單位是週末，
 * 賣的也是週末，用場次去算只會得出對不上的數字。
 *
 * 門檻是解出來的，條件是**每個週末永遠 ≤ 27 元**，
 * 也就是至少比單買 Weekend Pass（39 元）便宜 30%。
 * 沒有這個約束就會出現「整季反而比單買貴」那種會被算出來的定價。
 */
// ---------------------------------------------------------------------------
// 定價（2026-08-17 第二次定案，使用者決定）
//
// **只有三個價格。** 上一版是四段的階梯（599／399／259／129），
// 雖然每一段都算得出道理，但使用者的判斷是：**選項太多會讓人猶豫**，
// 而猶豫的結果不是選便宜的那個，是不買。這個判斷我同意——
// 定價的正確性不只看每一段划不划算，也看使用者能不能一眼看懂。
//
//   夏休前（上半季）  NT$599
//   夏休起（下半季）  NT$299
//   單場比賽週末      NT$39
//
// 分界用 **F1 的夏休**，不用月份也不用剩餘場次：那是每個看 F1 的人
// 本來就知道的界線，不需要解釋。「夏休前加入 599／夏休後加入 299」
// 一句話講得完，而「剩 15 個週末以上 599」要先問「那現在剩幾個」。
// ---------------------------------------------------------------------------
// PRICE_FIRST_HALF / PRICE_SECOND_HALF 已移到 PLANS 之前宣告（TDZ，見那裡的說明）

/**
 * 低於這個數量就不再賣「本賽季」，改賣**下一個賽季**。
 *
 * 使用者的決定（2026-08-17）：不停售，但要賣得誠實——賣的是下賽季的，
 * 而且**購買頁與結帳都必須明講**。本賽季剩下的週末一併附贈：
 * 共用快取讓它幾乎零成本，而「現在就能開始用」比任何折扣都好溝通。
 *
 * ⚠️ 門檻是 **8**，是算出來的：下半季價 299 ÷ 39（單場）≈ 7.7，
 *    也就是剩不到 8 個週末時，整季票會比一場一場買**還貴**——
 *    那是使用者自己算得出來的事，不能讓它發生。
 *    到那個時候就該改賣下一賽季（本季剩下的附贈），對雙方都比較好。
 */
const NEXT_SEASON_MIN_WEEKENDS = 8;

// ---------------------------------------------------------------------------
// 賽程查詢
//
// 資料在 REMOTE_CONFIG.schedule（放遠端才能熱更新，見那裡的說明）。
// 這些函式刻意**全部容忍賽程是空的或壞的**：賽程只是讓定價與 Weekend Pass
// 更精準的輔助資料，拿不到時要能退回「不看賽程」的舊行為，
// 而不是讓整個購買流程掛掉。
// ---------------------------------------------------------------------------

/** 一天的秒數界線。用 UTC 是刻意的，見 schedule 的註解。 */
function dayStartSec(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}

function scheduleList(cfg) {
  const list = (cfg && Array.isArray(cfg.schedule)) ? cfg.schedule : REMOTE_CONFIG.schedule;
  return Array.isArray(list) ? list.filter((g) => g && dayStartSec(g.start) && dayStartSec(g.end)) : [];
}

/**
 * 還剩幾個比賽週末。**待決場次也算進去。**
 *
 * ⚠️ 這個判斷在 2026-08-17 改過方向。原本刻意排除待決場次（「寧可低估」），
 *    使用者的決定是**不要低估**：那兩場是 F1 官方排定的賽程，取消與否
 *    是他們的決定，不是我們的。事先自己打折扣等於替別人的不確定性買單，
 *    而真的取消時該處理的是退費或補償，不是預先少賣。
 *
 *    影響：以 2026-08-17 為例，剩餘從 10 變成 12。
 */
function racesLeft(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  return scheduleList(cfg).filter((g) => dayStartSec(g.end) + 86400 > now).length;
}

/** 其中有幾個是待確認的。購買頁要標示出來，讓使用者自己知道。 */
function racesLeftTentative(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  return scheduleList(cfg).filter((g) => g.tentative && dayStartSec(g.end) + 86400 > now).length;
}

/**
 * 下一場（或正在進行中的那一場）比賽週末。
 *
 * Weekend Pass 賣的是「某一場 GP 的週末」，不是「發碼後 4 天」。
 * 舊的做法在使用者提前一週購買時會**在比賽開始前就過期**——
 * 付了錢卻什麼都看不到，而且不會有任何錯誤訊息。
 *
 * 前後各放寬一天：涵蓋各站的當地時區，也涵蓋賽前的媒體日內容。
 */
const WEEKEND_PAD_SEC = 86400;

function nextGrandPrix(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  const list = scheduleList(cfg).slice().sort((a, b) => dayStartSec(a.start) - dayStartSec(b.start));
  // 先找「現在正在進行中」的，再找「接下來最近的一場」
  return list.find((g) => dayStartSec(g.end) + WEEKEND_PAD_SEC > now) || null;
}

/** 現在買 season 要多少錢。回傳 { price, tier }。 */
/**
 * 現在買 Season Pass 是什麼價、買到的是哪一季。
 *
 * 回傳 `{ price, tier, weekendsLeft, nextSeason, until }`。
 * `nextSeason: true` 代表**賣的是下一個賽季**——呼叫端一律要把這件事顯示出來，
 * 靜靜地收全價然後給一個要等好幾個月才用得到的東西，是最糟的那種體驗。
 *
 * `base` 只在賽程讀不到時當作退路，正常情況價格完全由價目表決定。
 */
/** 夏休已經開始了嗎（含夏休期間本身）。標記見 schedule 的 `afterSummerBreak`。 */
function afterSummerBreak(from, cfg) {
  const list = scheduleList(cfg);
  const first = list.find((g) => g.afterSummerBreak);
  if (!first) return false;                       // 沒標就一律當上半季，寧可收全價
  const prev = list.filter((g) => dayStartSec(g.end) < dayStartSec(first.start)).pop();
  // 界線取「夏休前最後一場結束的隔天」。夏休期間買到的就是下半季價——
  // 那段時間本來就沒有比賽，使用者買的是接下來的下半季。
  const boundary = prev ? dayStartSec(prev.end) + 86400 : dayStartSec(first.start);
  return Math.floor((from || Date.now()) / 1000) >= boundary;
}

function seasonPriceNow(base, from, cfg) {
  const now = from || Date.now();
  const left = racesLeft(now, cfg);

  // 賽程拿不到（設定壞掉、還沒推新賽季）就回上半季牌價。
  // 寧可收全價也不要因為讀不到資料就亂打折——那種錯誤沒有人會來反映。
  if (!scheduleList(cfg).length) {
    return {
      price: base || PRICE_FIRST_HALF, tier: '上半季',
      weekendsLeft: null, nextSeason: false, until: seasonEndSec(now),
    };
  }

  // ⚠️ **本賽季通行證永遠只賣本賽季。**
  //
  //    舊版在剩不到 8 個比賽週末時，把這張票整個換成「下一賽季」並收 599。
  //    使用者的決定（2026-08-19）是不要那樣做：剩幾場、值不值得，讓他自己判斷，
  //    我們不替他決定「這時候買本季不划算」。想買下一季的人去買 season_next。
  //
  //    這也移除了一個很難解釋的現象——同一張卡片會在某一天突然從 299 變成 599，
  //    而那其實是換了商品，不是漲價。
  let second = afterSummerBreak(now, cfg);

  // ⚠️ **絕對底線：整季票不可以比「單場 × 剩餘週末」還貴。**
  //
  // 只有兩個整季價，就代表上半季那個價要涵蓋很長一段時間。2026 的賽季被
  // 戰事削短之後，夏休前的最後幾週只剩 11 個週末——這時 599 元的整季票
  // 比買 11 張單場票（429 元）貴了 40%。使用者按計算機就會發現，
  // 而發現之後失去的不只是這一單。
  //
  // 這裡不引入第三個價格（那正是使用者要避免的複雜度），而是**提早套用
  // 下半季價**。價格種類仍然只有兩個，故事也還說得通：
  // 「夏休後 299；本季所剩不多時提早適用」。
  // 之所以一定接得住，是因為 NEXT_SEASON_MIN_WEEKENDS = 8 保證了
  // 剩餘至少 8 個週末，而 299 < 39 × 8 = 312。
  if (!second && PRICE_FIRST_HALF > WEEKEND_PRICE * left) second = true;

  return {
    price: second ? PRICE_SECOND_HALF : PRICE_FIRST_HALF,
    tier: second ? '下半季' : '上半季',
    weekendsLeft: left,
    nextSeason: false,
    until: seasonEndSec(now),
  };
}

/**
 * 升級補差價：Season 價 − 這個 email 本賽季已付的一週通行證金額。
 *
 * 規則一句話講得完，但實作有六個一定要釘死的點（全部踩過或想過）：
 *
 *   1. **綁 email**：授權本來就是綁人不綁裝置，email 是唯一的自然鍵。
 *      不同 email 買的不能互相抵——那是界線，不是限制。
 *   2. **只算本賽季**：用 `expiresAt` 落在同一個賽季界線內來判斷。
 *   3. **用升級當下的 Season 價**：不是購買時的。
 *   4. **抵扣無上限**（使用者決定）：買滿就免費升級。實質效果是
 *      「買散的最多跟買整季一樣貴」，對最忠實的使用者不做懲罰。
 *   5. **已抵扣過的不能再抵**：`creditedAt` 標記，否則明年還能再用一次。
 *   6. **差額 < 30 元直接送**：綠界超商代收一筆 25 元、ATM 10~15 元，
 *      收 20 元淨得可能是負的。而且 `TotalAmount` 不能是 0。
 */
const UPGRADE_FREE_BELOW = 30;

async function weekCreditFor(env, email, from, licenseKey) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !env.SUBS) return { credit: 0, keys: [] };

  // ⚠️ **只有 email 不足以證明所有權。**
  //
  // 第一版是「填 email 就查得到可折抵金額」。那等於：任何人填別人的 email
  // 就能拿到那個人的折抵，而新授權碼會在付款完成頁上直接顯示給付款的人看——
  // **等於用受害者的錢買自己的授權**。email 是公開資訊，不是憑證。
  //
  // 現在要求同時提供**一組屬於自己的一週通行證授權碼**：
  //   · 授權碼是隨機 12 碼、只寄給買家本人，猜不到
  //   · 那組碼的 email 必須與這次填的 email 相符，否則不給折抵
  // 兩個條件都成立，才算證明「這些一週通行證確實是你的」。
  const proof = normLicense(licenseKey || '');
  if (!proof) return { credit: 0, keys: [], reason: 'need_key' };
  const proofLic = await readLicense(env, proof);
  if (!proofLic) return { credit: 0, keys: [], reason: 'key_not_found' };
  if (String(proofLic.email || '').toLowerCase() !== mail) {
    return { credit: 0, keys: [], reason: 'email_mismatch' };
  }
  if (!PLANS[proofLic.plan] || !PLANS[proofLic.plan].weekBound) {
    return { credit: 0, keys: [], reason: 'not_week_pass' };
  }
  // 代訂附贈的那一週是**我們送的**，拿它折抵等於用我們送的東西折我們的錢。
  if (PLANS[proofLic.plan].fromService) {
    return { credit: 0, keys: [], reason: 'gifted_week' };
  }

  let arr = [];
  try { arr = JSON.parse((await env.SUBS.get(`licmail:${mail}`)) || '[]'); } catch (e) { /* noop */ }
  if (!Array.isArray(arr) || !arr.length) return { credit: 0, keys: [] };

  const seasonEnd = seasonEndSec(from);
  let credit = 0;
  const keys = [];
  for (const k of arr) {
    const lic = await readLicense(env, k);
    if (!lic || lic.revoked) continue;
    const p = PLANS[lic.plan];
    if (!p || !p.weekBound) continue;               // 只有一週通行證能抵
    if (lic.creditedAt) continue;                   // 已經抵過了
    // 本賽季：到期日必須落在這個賽季界線之前
    if (!lic.expiresAt || lic.expiresAt > seasonEnd) continue;
    credit += Number(lic.paid || p.price) || 0;
    keys.push(k);
  }
  return { credit, keys };
}

/** 升級後把用掉的那些標記起來，避免重複抵扣。 */
async function markCredited(env, keys, orderId) {
  for (const k of keys || []) {
    const lic = await readLicense(env, k);
    if (!lic || lic.creditedAt) continue;
    lic.creditedAt = nowSec();
    lic.creditedBy = String(orderId || '');
    await env.SUBS.put(licKey(k), JSON.stringify(lic));
  }
}

// 早鳥限量。賣完自動改用正式價——**不能靠人工盯著改**，
// 賣超了要嘛食言要嘛虧錢，兩個都不該發生。
const EARLY_LIMIT = 20;

// 通行證有效期。用戶端每 24 小時回報一次，這個 14 天只是**離線緩衝**——
// 後端掛掉時已付費的人還能撐兩週（見 SECURITY.md 的授權模型）。
const ENTITLEMENT_DAYS = 14;

/** 賽季結束時間：隔年 1 月 31 日。今天已過 1/31 就算到明年的 1/31。 */
function seasonEndSec(from) {
  const d = new Date((from || Date.now()));
  const y = d.getUTCFullYear();
  const thisSeasonEnd = Date.UTC(y, 0, 31, 23, 59, 59);      // 今年 1/31
  const end = d.getTime() <= thisSeasonEnd ? thisSeasonEnd : Date.UTC(y + 1, 0, 31, 23, 59, 59);
  return Math.floor(end / 1000);
}

/**
 * 下一個賽季結束的時間。
 *
 * 賽季末期賣的是下一季的通行證，效期要蓋到那一季跑完為止。
 * 直接在 `seasonEndSec` 上再加一年——F1 賽季固定橫跨年底，
 * 用「隔年 1/31」這個界線推一年就是下一季的界線。
 */
function nextSeasonEndSec(from) {
  const d = new Date(seasonEndSec(from) * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 31, 23, 59, 59) / 1000);
}

/**
 * Weekend Pass 涵蓋的時段：**該比賽週的星期四 → 該週末結束**。
 *
 * ⚠️ 舊版是「發碼後 4 天」，那在使用者提前購買時會**在比賽開始前就過期**——
 *    付了錢卻什麼都看不到，而且不會有任何錯誤訊息。賣的是「某一場 GP 的週末」，
 *    效期就該綁那一場，不是綁購買時間。
 *
 * 結束時間取正賽日的隔天 00:00 UTC。各站時區差很多（拉斯維加斯的正賽在
 * 當地週六晚上、澳洲的正賽在 UTC 週六），統一往後蓋一天才不會有人
 * 在自己的星期天發現通行證已經過期。
 */
function weekendWindow(from, cfg) {
  const gp = nextGrandPrix(from, cfg);
  if (!gp) return null;
  const thursday = dayStartSec(gp.start) - 86400;      // start 是練習賽第一天（週五）
  const closes = dayStartSec(gp.end) + 86400;
  return { gp, startsAt: thursday, expiresAt: closes };
}

/**
 * 一週通行證的時段。
 *
 * **設計取捨**：使用者原本想讓買家自己選「立刻啟用或延後啟用」。
 * 我建議不要——那是一個需要解釋的決定，而買東西時最不想做的就是做決定；
 * 「我以為我選了延後」會直接變成退款爭議，而且沒有乾淨的裁決依據。
 *
 * 改成規則固定、購買頁一句話講完：
 *
 *   購買當下 ──立刻可用（贈送）──► 下一個比賽週的星期一 ──7 天──► 到期
 *
 * 這樣正式的七天一定完整涵蓋週五六日的比賽，買家不必算、也不會算錯，
 * 而購買到比賽週之間的空檔變成「送的」——那段時間 F1TV 本來就有大量重播，
 * 對買家是實質好處，對我們幾乎零成本（共用快取）。
 *
 * `GRACE_MAX_SEC` 是必要的上限：夏休期間買，下一個比賽週可能在四週後，
 * 沒有上限的話「贈送」會變成「幾乎白送一個月」。
 */
const WEEK_GRACE_MAX_SEC = 14 * 86400;

/**
 * 一張通行證的最短效期。
 *
 * 買得再晚都至少有這麼久。**這是為了讓「最後一刻購買」不會變成詐欺**：
 * 正賽快結束時買，若只算到該站結束，等於花 39 元買了十分鐘。
 *
 * ⚠️ 72 小時是**算過的上限**，不是隨便訂的：背靠背的兩站之間，
 *    前一站結束（週日）到後一站開始（週五）中間有 5 天。
 *    保底 3 天不會蓋到下一站，4 天就會有風險。改這個數字前先重算。
 */
const MIN_PASS_SEC = 72 * 3600;

/**
 * 這張通行證涵蓋哪幾站、到什麼時候。
 *
 * ⚠️ **這個方案賣的是「比賽週末」，不是「固定七天」。**
 *
 *    舊版是「購買起算七天」，在背靠背的兩站之間會出事：正賽當天買，
 *    七天後正好是下一站的正賽日，一張票看了兩場。實測 2026 的 23 站
 *    有 9 站會漏——近四成的購買時機都在白送一場。
 *
 *    現在改成錨定賽程：涵蓋接下來的 count 站，效期到最後一站結束的隔天。
 *    加一天是因為**各站時區不同**——拉斯維加斯的正賽在當地週六深夜，
 *    換算 UTC 已經是週日；只算到 end 當天會讓那一站的正賽看不完。
 *
 *    代價是誠實的：買得早（上一站剛結束）大約 10~12 天，
 *    買在比賽週當中大約 3~5 天。**所以「一週」這個名字現在名不副實**，
 *    購買頁必須顯示伺服器算出來的實際到期日與涵蓋的站名。
 */
function weekWindow(from, cfg, count) {
  const now = Math.floor((from || Date.now()) / 1000);
  const list = scheduleList(cfg).slice()
    .sort((a, b) => dayStartSec(a.start) - dayStartSec(b.start));
  // 「正在進行中」也算，所以用 end + 一天寬限來找
  const idx = list.findIndex((g) => dayStartSec(g.end) + WEEKEND_PAD_SEC > now);
  if (idx < 0) return null;

  const n = Math.max(1, Math.min(Number(count) || 1, list.length - idx));
  const gp = list[idx];
  const last = list[idx + n - 1];

  // 立刻可用；顯示用的「這一站的比賽週從哪天算起」
  let monday = dayStartSec(gp.start) - 3 * 86400;
  if (monday < now) monday = now;
  const graceStart = Math.max(now, monday - WEEK_GRACE_MAX_SEC);

  // 涵蓋到最後一站結束的隔天（各站時區 + 賽後內容）
  let expiresAt = dayStartSec(last.end) + WEEKEND_PAD_SEC;
  // 保底：買得再晚都至少 MIN_PASS_SEC
  expiresAt = Math.max(expiresAt, now + MIN_PASS_SEC);
  // ⚠️ **安全優先於慷慨**：夾在最後。保底若把效期推進了範圍外的下一站，
  //    仍然要砍掉——不然就回到「一張票看兩場」的老問題。
  //    實務上碰不到（見 MIN_PASS_SEC 的算式），但這裡不靠算式，靠把關。
  const after = list[idx + n];
  if (after) expiresAt = Math.min(expiresAt, dayStartSec(after.start));

  return {
    gp,
    count: n,
    // 涵蓋的站名，購買頁與授權記錄都要用它——使用者買的是「哪幾站」
    gpNames: list.slice(idx, idx + n).map((g) => g.name),
    lastGp: last,
    // 立刻可用，所以沒有 startsAt（不設限）
    startsAt: null,
    graceFrom: graceStart,
    weekFrom: monday,
    expiresAt,
  };
}

function planExpiry(plan, from, cfg, count) {
  const p = PLANS[plan];
  if (!p) return null;
  // ⚠️ **不含字幕授權的方案要回「已經到期」，不可以回 null。**
  //    null 在這裡的語意是「無期限」，回錯方向就是白送一張永久授權。
  if (p.noSubs) return Math.floor((from || Date.now()) / 1000) - 1;
  // 代訂方案本身也一樣。字幕使用權是靠附贈的 week_svc 給的，代訂方案自己
  //    **從來不該帶著任何期限**——它沒有 days／weekBound／untilSeasonEnd，
  //    若走到下面就會回 null＝永久授權。primary 的選法已經不會挑到它了，
  //    但這裡是最後一道：日後任何新路徑發錯方案，最壞的結果是「立刻過期」，
  //    而不是「白送一張永久授權」。**要壞就壞在安全的那一邊。**
  if (p.manual) return Math.floor((from || Date.now()) / 1000) - 1;
  // 賽季方案：季末改賣下一季，效期要跟著那一季走（見 seasonPriceNow）
  // 下一賽季通行證：效期到**下一季**結束，本季剩餘場次一併附贈（所以現在就能用）
  if (p.nextSeasonOnly) return nextSeasonEndSec(from);
  if (p.untilSeasonEnd) return seasonPriceNow(p.price, from, cfg).until;
  if (p.weekBound) {
    const w = weekWindow(from, cfg, count);
    // 賽程讀不到就退回「購買後 7 天」，不要因為缺資料就發不出通行證
    if (w) return w.expiresAt;
    return Math.floor((from || Date.now()) / 1000) + (p.days || 7) * 86400;
  }
  if (p.days) return Math.floor((from || Date.now()) / 1000) + p.days * 86400;
  return null;
}

/**
 * 生效時間。一週通行證**購買當下就能用**，所以一律回 null（不設限）。
 * 保留這個函式是因為授權記錄有 `startsAt` 欄位，日後若有需要延後生效的
 * 方案（例如預購下一季）可以在這裡加，而 `licenseProblem` 已經會處理。
 */
function planStart(plan, from, cfg) {
  return null;
}

/**
 * 早鳥還剩幾組。
 *
 * ⚠️ **不用獨立計數器。**
 * 「讀 count → +1 → 寫回」在 KV 上是 lost update：兩筆同時付款都讀到 19、
 * 都寫 20 → 發出 21 組早鳥價。20 個名額本來就不多，賣超一組就是食言。
 * 而且計數器會與實際發出的碼漂移（刪碼、發錯、手動改都會），
 * 漂了之後沒有任何辦法對得回來。
 *
 * 改成**直接數實際發出去的早鳥碼**。名額只有 20，掃描成本可忽略，
 * 而且來源就是事實本身，不可能漂移。
 */
async function earlyIssued(env) {
  if (!env.SUBS || typeof env.SUBS.list !== 'function') return 0;
  let n = 0, cursor;
  do {
    const page = await env.SUBS.list({ prefix: 'lic:', limit: 1000, cursor });
    for (const k of page.keys) {
      const raw = await env.SUBS.get(k.name);
      if (!raw) continue;
      try { if (JSON.parse(raw).plan === 'season_early') n++; } catch (e) { /* 壞掉的略過 */ }
      // 數到上限就夠了——我們只需要知道「還有沒有名額」，不需要精確總數。
      // 授權碼變多之後，全掃一次是 O(n) 次 KV 讀取，不能每次發碼都做。
      if (n >= EARLY_LIMIT) return n;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n;
}

async function earlyRemaining(env) {
  return Math.max(0, EARLY_LIMIT - (await earlyIssued(env)));
}

function licenseKeyNew() {
  // 去掉容易看錯的 0/O/1/I/L，因為使用者要用手打
  const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b).map((x) => AB[x % AB.length]).join('');
  return `PL${s}`;
}

function normLicense(k) {
  return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function prettyLicense(k) {
  const n = normLicense(k).replace(/^PL/, '');
  return 'PL-' + (n.match(/.{1,4}/g) || []).join('-');
}

const licKey = (k) => `lic:${normLicense(k)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 通行證（entitlement）：<installId>.<plan>.<exp>.<簽章>
 *
 * 用戶端存起來離線驗證。**後端不可用時只要還沒過期就繼續服務**——
 * 伺服器出問題是我們的錯，不該讓付費使用者看不到字幕。
 */
async function issueEntitlement(env, installId, plan, until) {
  const secret = tokenSecret(env);
  const exp = Math.min(until || 4102444800, nowSec() + ENTITLEMENT_DAYS * 86400);
  const payload = `${installId}.${plan}.${exp}`;
  return { entitlement: `${payload}.${await hmac(secret, payload)}`, exp, plan };
}

/**
 * 驗證通行證。
 *
 * ⚠️ **這個驗證只能在伺服器做，用戶端做不到。**
 * 簽章是 HMAC，需要 TOKEN_SECRET，而那個絕不能發給用戶端。
 *
 * 所以分工是：
 *   用戶端  只讀通行證裡的 exp 判斷「還沒過期」，用來決定 UI 顯示什麼。
 *           **那是體驗，不是防護**——使用者當然可以自己塞一個假的進 storage。
 *   伺服器  在會花錢的端點（/v1/translate）實際驗簽。
 *           偽造的通行證拿不到翻譯，這才是真正的那道牆。
 *
 * 把防線放在伺服器而不是用戶端，也讓「後端掛掉時已付費的人照常能用」
 * 這件事成立——用戶端不會因為驗不了簽就把功能鎖起來。
 */
async function verifyEntitlement(env, ent) {
  const parts = String(ent || '').split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [installId, plan, expStr, sig] = parts;
  const expect = await hmac(tokenSecret(env), `${installId}.${plan}.${expStr}`);
  if (!safeEqual(sig, expect)) return { ok: false, reason: 'bad signature' };
  if (Number(expStr) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, installId, plan, exp: Number(expStr) };
}

async function readLicense(env, key) {
  const raw = await env.SUBS.get(licKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 授權碼目前能不能用。回傳 null 代表可用，否則回傳要給使用者看的原因。 */
function licenseProblem(lic) {
  if (!lic) return { msg: '查無此授權碼，請確認有沒有打錯', status: 404 };
  if (lic.revoked) return { msg: '這組授權碼已停用（退款或違規）。如有疑問請聯絡客服', status: 403 };
  if (lic.expiresAt && lic.expiresAt * 1000 < Date.now()) return { msg: '授權已過期，請續訂', status: 403 };
  // Weekend Pass 提前買的情況。**要說出從哪一天開始能用**——
  // 只回「尚未生效」會讓人以為買錯了或系統壞了。
  if (lic.startsAt && lic.startsAt * 1000 > Date.now()) {
    const d = new Date(lic.startsAt * 1000);
    const ymd = `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
    return {
      msg: `這張 Weekend Pass 涵蓋的是 ${lic.gpName || '下一場'} 大獎賽週末，`
        + `將於 ${ymd}（該週星期四）起生效`,
      status: 403,
    };
  }
  return null;
}

/** 啟用：把授權碼綁到這個安裝，換回通行證。同一組碼可在任何裝置操作。 */
async function handleLicenseActivate(request, env, auth) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  if (key.length < 8) return err('授權碼格式不正確');

  const lic = await readLicense(env, key);
  const bad = licenseProblem(lic);
  if (bad) return err(bad.msg, bad.status);

  const iid = auth.installId;
  lic.devices = Array.isArray(lic.devices) ? lic.devices : [];
  const known = lic.devices.find((d) => d.installId === iid);

  if (!known) {
    if (lic.devices.length >= MAX_DEVICES) {
      // **不要自動踢掉別台。** 使用者可能正在另一台看比賽，
      // 靜默踢掉會變成兩台互相把對方擠下線。讓他自己決定解除哪一台。
      return json({
        error: `已達裝置上限（${MAX_DEVICES} 台）。請先解除其中一台再啟用`,
        needsDeactivate: true,
        devices: lic.devices.map((d) => ({ id: d.installId.slice(0, 8), lastSeen: d.lastSeen })),
      }, 409);
    }
    lic.devices.push({ installId: iid, addedAt: nowSec(), lastSeen: nowSec() });
  } else {
    known.lastSeen = nowSec();
  }

  await env.SUBS.put(licKey(key), JSON.stringify(lic));

  // ⚠️ **啟用一定要把作廢紀錄清掉。**
  //    作廢清單是以 installId 為鍵的，不是以通行證為鍵。所以「清空裝置後
  //    請使用者重新啟用」這條最常見的客服流程會變成：重新啟用成功、
  //    拿到新的通行證，但這個 installId 還在作廢清單裡 → 伺服器照樣擋。
  //    畫面顯示已啟用、實際不能用，而且完全不報錯——付費使用者直接壞掉。
  await unvoidEntitlements(env, [iid]);

  const ent = await issueEntitlement(env, iid, lic.plan || 'season', lic.expiresAt);
  return json({ ok: true, plan: lic.plan || 'season', expiresAt: lic.expiresAt, devices: lic.devices.length, ...ent });
}

/** 解除裝置。換電腦、賣掉舊電腦、或撞到上限時自己處理。 */
async function handleLicenseDeactivate(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const target = String((body && body.installId) || '').trim();
  if (!key || !target) return err('需要 licenseKey 與 installId');

  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);
  const before = (lic.devices || []).length;
  // 允許用前 8 碼指認，因為使用者在畫面上只看得到那幾碼
  lic.devices = (lic.devices || []).filter(
    (d) => d.installId !== target && !d.installId.startsWith(target));
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  return json({ ok: true, removed: before - lic.devices.length, remaining: lic.devices.length });
}

/** 續期。**呼叫失敗不影響現有通行證**，過期前都還能用。 */
async function handleLicenseRenew(request, env, auth) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  const bad = licenseProblem(lic);
  if (bad) return err(bad.msg, bad.status);

  const d = (lic.devices || []).find((x) => x.installId === auth.installId);
  if (!d) return err('這台裝置尚未啟用此授權', 403);
  d.lastSeen = nowSec();
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  return json({ ok: true, ...(await issueEntitlement(env, auth.installId, lic.plan || 'season', lic.expiresAt)) });
}

/** 列出這組授權碼底下的裝置。純查詢，不會改動任何東西。 */
async function handleLicenseDevices(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);
  return json({
    ok: true,
    max: MAX_DEVICES,
    devices: (lic.devices || []).map((d) => ({ id: d.installId.slice(0, 8), lastSeen: d.lastSeen })),
  });
}

// ---------------------------------------------------------------------------
// 伺服器端的授權閘門
//
// **用戶端的授權檢查只是 UI，這裡才是真正的牆。**
// 用戶端沒有 TOKEN_SECRET，驗不了通行證的簽章；而且使用者本來就能改自己
// 電腦上的 storage。所以「有沒有付費」必須在會花錢的端點上判定。
//
// 免費層的配額也在這裡。用戶端負責「播到 15 分鐘就不再顯示」（那是產品承諾），
// 伺服器負責「未授權的安裝每天最多翻 N 句」（那是成本保護）。
// 兩者目的不同，都要有——只做前者的話，改個 storage 就能無限用。
// ---------------------------------------------------------------------------

// 免費層每天的翻譯句數上限。
// 一場練習賽 15 分鐘約 250~300 句，四種場次一天最多兩場，抓 800 已經寬鬆。
// 超過就退回「只讀共用快取」——**已經有人翻過的影片仍然完全可用**，
// 使用者不會覺得壞掉，只是新影片當天不再幫他翻。
const FREE_DAILY_LINES = 800;

// IP 層的額度倍率。同一個 IP 後面可能是整個家庭或宿舍的 NAT，
// 設太緊會誤傷正常使用者，而那種傷害是靜默的——他只會覺得壞掉然後解除安裝。
const FREE_IP_MULTIPLIER = 3;

const freeKey = (installId) => `free:${installId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * 判定這次請求能翻幾句。回傳 { allowed, reason, plan }。
 *
 * 設計原則：**任何不確定的情況都往寬鬆解釋**。
 * 讀不到授權、KV 暫時有問題、通行證剛好在續期空窗——
 * 這些都不該讓付了錢的人被擋。真正要擋的是「明確沒有授權且已超過免費額度」。
 */
async function checkEntitlement(env, auth, request, wantLines) {
  // userscript 是**管理員收割工具**，它的工作就是賽前把整支影片翻完灌進共用快取。
  // 用免費額度擋它等於把整個共用快取的來源掐死——而且 legacy 全體共用
  // 一個 installId，第一個人用完 800 句，其他人全部被擋。
  // 它拿的是 CLIENT_TOKEN（只有你有），本來就不是一般使用者。
  if (auth.legacy) return { allowed: wantLines, reason: 'legacy', plan: 'admin' };

  const ent = request.headers.get('x-entitlement') || '';

  if (ent) {
    const v = await verifyEntitlement(env, ent);
    // 通行證必須是簽給這個安裝的，否則等於一張到處傳的萬用票
    if (v.ok && v.installId === auth.installId) {
      if ((await revokedSet(env)).has(auth.installId)) {
        return { allowed: 0, reason: 'revoked', plan: null };
      }
      // 授權碼被刪除／停用／清空裝置時，簽出去的通行證要在這裡被擋下。
      // 沒有這一步，刪掉授權碼在伺服器端**完全沒有效果**，最長 14 天照樣放行。
      // 注意這裡是 break 不是 return —— 讓他退回免費層，而不是整個擋死。
      if (!(await entVoidSet(env)).has(auth.installId)) {
        return { allowed: wantLines, reason: 'licensed', plan: v.plan };
      }
    }
    // 通行證壞掉或過期 → 不直接拒絕，往下走免費層。
    // 使用者可能只是續期失敗，讓他至少還有免費額度可用。
  }

  // ---- 免費層 ----
  //
  // 兩個鍵一起看：**installId** 與 **IP**。
  //
  // 只看 installId 的話，重裝擴充功能就換一組新的、額度全新——那是原理上
  // 擋不住的（installId 存在使用者自己的 storage 裡）。加上 IP 這一層之後，
  // 想重複拿免費額度就得連 IP 一起換，難度差很多：重裝是點兩下，換 IP 要
  // 換網路或掛 VPN，而願意為了省 NT$299 每天做這件事的人不是我們的客戶。
  //
  // ⚠️ IP 的額度**刻意開得比 installId 寬**（3 倍）。同一個 IP 後面可能是
  //    整個家庭、宿舍或公司的 NAT，設太緊會誤傷完全正常的使用者，
  //    而那種傷害是靜默的：他只會覺得「這東西壞掉了」然後解除安裝。
  const ipRaw = request.headers.get('cf-connecting-ip') || '';
  const k = freeKey(auth.installId);
  let used = 0;
  try { used = parseInt((await env.SUBS.get(k)) || '0', 10) || 0; } catch (e) { used = 0; }
  const left = Math.max(0, FREE_DAILY_LINES - used);
  if (left <= 0) return { allowed: 0, reason: 'free_quota_exhausted', plan: 'trial' };

  let ipLeft = Infinity;
  if (ipRaw) {
    // 只存雜湊，不存 IP 本身——這是隱私權政策裡承諾過的，也沒有必要存原文。
    const ipKey = freeKey('ip:' + (await hmac(tokenSecret(env) || 'x', ipRaw)).slice(0, 16));
    let ipUsed = 0;
    try { ipUsed = parseInt((await env.SUBS.get(ipKey)) || '0', 10) || 0; } catch (e) { ipUsed = 0; }
    ipLeft = Math.max(0, FREE_DAILY_LINES * FREE_IP_MULTIPLIER - ipUsed);
    if (ipLeft <= 0) return { allowed: 0, reason: 'free_quota_exhausted_ip', plan: 'trial' };
  }

  return {
    allowed: Math.min(wantLines, left, ipLeft),
    reason: 'free', plan: 'trial', used, left,
    ipKey: ipRaw ? true : false,
  };
}

/**
 * 這個網址後綴算不算免費場次。
 *
 * ⚠️ **這條規則以前只存在於用戶端。** 後端的免費層只認「今天用掉幾句」，
 *    完全不知道使用者在看哪支影片——所以「免費只涵蓋四種正式場次的前 15 分鐘」
 *    這件事，只要改一下用戶端就繞得過去。那不是取捨，是疏漏。
 *
 * ⚠️ **slug 的來源順序有意義。**
 *    1. bundle.slug —— 收割時由我們自己寫入，一般使用者改不到，是可信的
 *    2. body.slug   —— 用戶端送的，可以偽造，只在我們還沒有記錄時才用
 *
 *    兩者都沒有時**放行**（fail open）。理由：真正值得白嫖的是正賽、排位這些
 *    熱門影片，而那些一定被收割過、一定有 bundle.slug；為了堵一個不存在的
 *    情境去擋掉「還沒被收割的新影片」，代價是把新使用者第一次的體驗弄壞，
 *    而那是我們的獲客漏斗。免費層本來就還有每日句數上限兜著。
 */
function isFreeSlug(slug) {
  const ft = REMOTE_CONFIG.freeTier || {};
  const s = String(slug || '').toLowerCase();
  if (!s) return null;                                  // 沒有資訊，不做判斷
  try {
    if ((ft.exclude || []).some((p) => new RegExp(p).test(s))) return false;
    return (ft.include || []).some((p) => new RegExp(p).test(s));
  } catch (e) {
    return null;                                        // 設定裡的正則壞掉：不擋
  }
}

/**
 * 記錄免費層用量。
 *
 * 取樣寫入（每 5 句才寫一次並一次加 5），因為 KV 免費額度是 1,000 puts/天，
 * 逐句寫必定撞爆（坑 #19 的教訓）。額度因此是近似值，但配合成本熔斷已足夠。
 */
async function noteFreeUsage(env, installId, n) {
  if (!n) return;

  // ⚠️ 取樣的數學要對，否則兩邊都錯。
  //
  // 原本寫成 `if (Math.random() >= n/5) return;` 然後固定 `+5`：
  //   n ≥ 5 時機率恆為 1 → **每批都寫一次 KV**，一支影片 100 批就是 100 puts，
  //   直接把 1,000/天的額度吃掉（坑 #19 的老路）。
  //   而且固定 +5，n=20 時只記 5 句 → 免費額度被低估 4 倍，等於白送。
  //
  // 正解：機率 1/SAMPLE，命中時加 n*SAMPLE。期望值 = n，且寫入次數與 n 無關。
  const SAMPLE = 10;
  if (Math.random() >= 1 / SAMPLE) return;
  const k = freeKey(installId);
  const cur = parseInt((await env.SUBS.get(k)) || '0', 10) || 0;
  await env.SUBS.put(k, String(cur + n * SAMPLE), { expirationTtl: 2 * 86400 });
}

// ---------------------------------------------------------------------------
// 產品數據（彙總，不可識別個人）
//
// **只收「能改善產品與定價」的東西，其餘一律不收。**
//
// 收：場次類型的使用分布、免費額度用到第幾分鐘、免費 → 付費的轉換、
//     各版本的錯誤率、共用快取命中率。
// 不收：看了哪一支影片（cid 不進這裡）、IP、瀏覽紀錄、任何跨站識別碼。
//
// 為什麼刻意不收 cid：那等於觀看紀錄。它對「優化商業方案」沒有幫助
// （我知道「排位賽佔 30%」就夠了，不需要知道「這個人看了摩納哥排位賽」），
// 卻會讓隱私政策難寫、商店審查難過、資料外洩時的後果嚴重得多。
//
// 儲存方式與成本統計相同：isolate 內累積，每 15 分鐘或滿 200 筆才落地，
// 避開 KV 1,000 puts/天 的天花板。
// ---------------------------------------------------------------------------
const METRIC_TTL_DAYS = 400;

let mPending = { at: Date.now(), n: 0, rows: {} };

function metricKey(d) {
  return `metric:${new Date(d || Date.now()).toISOString().slice(0, 10)}`;
}

/**
 * 合法的事件與維度。**白名單制**——用戶端傳什麼我們都不照單全收，
 * 否則哪天多送了一個欄位，個資就從那裡漏出去了。
 */
const METRIC_EVENTS = {
  session_start: ['sessionType', 'licensed', 'version'],
  free_exhausted: ['sessionType', 'minutes', 'version'],
  license_activated: ['plan', 'version'],
  playback_error: ['kind', 'version'],
};

const SESSION_TYPES = ['practice', 'qualifying', 'sprint', 'race', 'other'];
const PLAN_NAMES = ['season_early', 'season', 'comp', 'trial'];

/** 把用戶端送來的值收斂成有限集合，避免變成自由文字而夾帶內容。 */
function normDim(key, v) {
  if (key === 'sessionType') return SESSION_TYPES.includes(v) ? v : 'other';
  if (key === 'plan') return PLAN_NAMES.includes(v) ? v : 'other';
  if (key === 'licensed') return v ? 'yes' : 'no';
  if (key === 'version') return /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v) : 'unknown';
  if (key === 'minutes') {
    // 分桶而不是原值——原值精確到秒等於一條時間軸，分桶才是統計
    const n = Number(v);
    if (!Number.isFinite(n)) return 'unknown';
    return n < 5 ? '0-5' : n < 10 ? '5-10' : n < 15 ? '10-15' : '15+';
  }
  if (key === 'kind') {
    const K = ['no_caption', 'prefetch_failed', 'backend_error', 'poll_stall'];
    return K.includes(v) ? v : 'other';
  }
  return 'other';
}

function recordMetric(event, dims) {
  const allowed = METRIC_EVENTS[event];
  if (!allowed) return;                     // 不認識的事件直接丟掉
  const parts = [event];
  for (const k of allowed) parts.push(`${k}=${normDim(k, dims && dims[k])}`);
  const key = parts.join('|');
  mPending.rows[key] = (mPending.rows[key] || 0) + 1;
  mPending.n++;
}

function metricsShouldFlush() {
  return mPending.n >= 200 || (mPending.n > 0 && Date.now() - mPending.at > 15 * 60 * 1000);
}

async function flushMetrics(env) {
  if (!mPending.n) return;
  const mine = mPending.rows;
  mPending = { at: Date.now(), n: 0, rows: {} };
  const key = metricKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { /* 壞掉重來 */ }
  // 與 bundle 一樣是多寫入者，同樣要重讀後合併（坑 #24）
  for (const [k, v] of Object.entries(mine)) day[k] = (day[k] || 0) + v;
  await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: METRIC_TTL_DAYS * 86400 });
}

/** 用戶端回報事件。刻意不需要授權以外的任何資訊。 */
async function handleMetric(request, env, auth) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  for (const e of events) {
    if (e && typeof e.event === 'string') recordMetric(e.event, e.dims || {});
  }
  if (metricsShouldFlush()) { try { await flushMetrics(env); } catch (e2) { /* 統計不擋主流程 */ } }
  return json({ ok: true, accepted: events.length });
}

/**
 * 管理端：讀統計。整理成「能拿來做決定」的形狀，不是丟一堆原始計數。
 */
async function handleMetrics(env, url) {
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
  const agg = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(metricKey(d))) || '{}'); } catch (e) { /* noop */ }
    for (const [k, v] of Object.entries(day)) agg[k] = (agg[k] || 0) + v;
  }

  const pick = (prefix) => Object.entries(agg)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => [k.split('|').slice(1), v]);

  // 場次類型分布 —— 回答「該不該把免費層擴大到別的內容」
  const bySession = {};
  for (const [dims, v] of pick('session_start|')) {
    const t = (dims.find((d) => d.startsWith('sessionType=')) || '').slice(12);
    bySession[t] = (bySession[t] || 0) + v;
  }

  // 免費額度用到第幾分鐘就走 —— 回答「15 分鐘夠不夠」
  const freeDropoff = {};
  for (const [dims, v] of pick('free_exhausted|')) {
    const m = (dims.find((d) => d.startsWith('minutes=')) || '').slice(8);
    freeDropoff[m] = (freeDropoff[m] || 0) + v;
  }

  // 轉換率 —— 回答「定價對不對」
  let freeStarts = 0, paidStarts = 0;
  for (const [dims, v] of pick('session_start|')) {
    const lic = (dims.find((d) => d.startsWith('licensed=')) || '').slice(9);
    if (lic === 'yes') paidStarts += v; else freeStarts += v;
  }
  const activations = pick('license_activated|').reduce((a, [, v]) => a + v, 0);

  // 各版本的錯誤 —— 回答「這次推送是不是推壞了」
  const errorsByVersion = {};
  for (const [dims, v] of pick('playback_error|')) {
    const ver = (dims.find((d) => d.startsWith('version=')) || '').slice(8);
    const kind = (dims.find((d) => d.startsWith('kind=')) || '').slice(5);
    errorsByVersion[ver] = errorsByVersion[ver] || {};
    errorsByVersion[ver][kind] = (errorsByVersion[ver][kind] || 0) + v;
  }

  return json({
    days,
    sessionTypes: bySession,
    freeDropoffMinutes: freeDropoff,
    sessions: { free: freeStarts, licensed: paidStarts },
    activations,
    conversionHint: freeStarts ? +(activations / freeStarts).toFixed(4) : null,
    errorsByVersion,
    note: '所有數據皆為彙總計數，不含 contentId、IP 或任何可識別個人的資訊。',
  });
}

// ---------------------------------------------------------------------------
// 診斷回報
//
// 使用者按「傳送診斷」→ 後端收下、給一個工單編號、存進 KV。
//
// **為什麼不是直接寄信**：從 Cloudflare 寄到 Gmail 需要一個已驗證的寄件網域
// （SPF/DKIM）。在 pitlingo.com 買下並設定好之前，任何寄信方案的送達率
// 都會很差，甚至直接進垃圾桶——那比沒有更糟，因為你會以為沒人回報。
//
// 所以分兩層：
//   1. 一律存進 KV，後台看得到（**這層永遠可靠，不依賴任何外部服務**）
//   2. 設定了 REPORT_WEBHOOK 就額外推一份出去（Email API、Discord、Slack 都行）
//      —— 網域好了之後填上去即可，不用改程式。
// ---------------------------------------------------------------------------
const REPORT_TTL_DAYS = 90;

/** 工單編號：PL-YYMMDD-XXXX。使用者報修時報這組，我們就查得到。 */
function ticketId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => AB[x % AB.length]).join('');
  return `PL-${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${r}`;
}

async function handleReportSubmit(request, env, auth) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');

  const report = String(body.report || '');
  if (!report.trim()) return err('診斷內容是空的');
  if (report.length > 200000) return err('診斷內容過大');

  // 使用者可能填了聯絡方式（選填）。沒填就靠工單編號對。
  const contact = String(body.contact || '').slice(0, 200);
  const note = String(body.note || '').slice(0, 2000);

  const id = ticketId();
  const rec = {
    id, at: nowSec(),
    installId: auth.installId,
    version: String(body.version || ''),
    contact, note, report,
  };
  await env.SUBS.put(`report:${id}`, JSON.stringify(rec), { expirationTtl: REPORT_TTL_DAYS * 86400 });

  // 第二層：有設定就推出去。**失敗不影響回報成功**——
  // 東西已經存進 KV 了，使用者不該因為我們的通知管道有問題而被要求重送。
  // 訂單標記為已付款。**放在寄信之後**，這樣 mailed 才是真的結果——
  // 後台靠這個欄位挑出「已付款但信沒寄出去」的訂單去補寄。
  try {
    await patchOrder(env, orderId, {
      status: 'paid', paidAt: nowSec(),
      licenseKey: prettyLicense(key), plan, email,
      price: Number(lic.paid) || 0,
      mailed: !!mailed.sent,
      mailReason: mailed.sent ? '' : String(mailed.reason || ''),
      services: lic.services || [],
      summary: (lic.items || []).map((i) => ((PLANS[i.key] || {}).label || i.key)
        + (i.qty > 1 ? ' x' + i.qty : '')).join('、') || (PLANS[plan] || {}).label || plan,
    });
  } catch (e) { /* 訂單記錄失敗絕不擋發碼——碼已經發出去了 */ }

  if (env.REPORT_WEBHOOK) {
    try {
      await fetch(env.REPORT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: `[PitLingo] 診斷回報 ${id}`,
          to: env.REPORT_TO || 'pitlingo.office@gmail.com',
          ticket: id, version: rec.version, contact, note,
          text: report.slice(0, 60000),
        }),
      });
    } catch (e) { /* 通知失敗不影響回報本身 */ }
  }

  return json({ ok: true, ticket: id });
}

/** 管理端：列出回報。內容很長，清單只給摘要，點開才看全文。 */
async function handleReportList(env, url) {
  const id = url.searchParams.get('id');
  if (id) {
    const raw = await env.SUBS.get(`report:${id}`);
    if (!raw) return err('查無此工單', 404);
    return json(JSON.parse(raw));
  }
  const listed = await env.SUBS.list({ prefix: 'report:', limit: 200 });
  const rows = [];
  for (const k of listed.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let r; try { r = JSON.parse(raw); } catch (e) { continue; }
    rows.push({
      id: r.id, at: r.at, version: r.version, contact: r.contact, note: r.note,
      resolved: !!r.resolved, adminNote: r.adminNote || '',
      // 摘要抓幾個一眼能判斷的欄位，不用點開就能分類
      summary: (r.report.match(/^目前階段.*$/m) || [''])[0].trim()
        + '　' + (r.report.match(/^命中 \/ 未命中.*$/m) || [''])[0].trim(),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return json({ rows });
}

// ---------------------------------------------------------------------------
// 結帳（綠界 AioCheckOut V5）
//
// 流程：
//   1. 使用者在 /buy 選方案、勾選同意條款 → POST /v1/checkout
//   2. 我們建立訂單、算 CheckMacValue、回傳一份「自動送出的表單」
//   3. 瀏覽器把表單 POST 到綠界的收銀台
//   4. 使用者付款
//   5. 綠界 **伺服器對伺服器** POST 到 ReturnURL（/v1/payment/webhook）→ 我們發碼
//   6. 綠界把瀏覽器導回 OrderResultURL（/paid）→ 顯示授權碼
//
// ⚠️ 發碼**只認第 5 步**，不認第 6 步。
//    第 6 步是瀏覽器導向，任何人都能自己打開那個網址並偽造參數。
//    只有 ReturnURL 的通知帶得出正確的 CheckMacValue。
//
// ⚠️ ATM 與超商是**非即時付款**：
//    綠界會先送一次「取號成功」（RtnCode=2）到 PaymentInfoURL，
//    幾天後真的付款了才送 RtnCode=1 到 ReturnURL。
//    **RtnCode=2 絕對不能發碼**——那時候錢還沒進來。
// ---------------------------------------------------------------------------

// 正式與測試的收銀台位址。測試環境用綠界公開的共用帳號，
// 可以走完整流程而不會真的扣款——**正式環境上線前唯一能驗證的方法**。
const ECPAY_URL = {
  production: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
  stage: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
};

// 綠界公開的測試帳號（官方文件公佈，不是機密）
const ECPAY_TEST = {
  merchantId: '3002607',
  hashKey: 'pwFHCqoQZGmho4w6',
  hashIV: 'EkRm7iFT261dpevs',
};

function ecpayConf(env, mode) {
  if (mode === 'stage') {
    return { ...ECPAY_TEST, url: ECPAY_URL.stage, mode: 'stage' };
  }
  return {
    merchantId: env.ECPAY_MERCHANT_ID || '',
    hashKey: env.ECPAY_HASH_KEY || '',
    hashIV: env.ECPAY_HASH_IV || '',
    url: ECPAY_URL.production,
    mode: 'production',
  };
}

/**
 * 綠界的訂單編號：英數字，最長 20 碼，**必須唯一**。
 *
 * ⚠️ 時間戳只到秒，所以同一秒內的訂單完全靠隨機碼區分。
 *    第一版寫成「3 bytes → base36 → 截 5 碼」，實測 3000 次撞 12 次——
 *    因為單一 byte 轉 base36 最多兩碼再補零，分布嚴重傾斜，實際只有約 18 bits。
 *    綠界收到重複的訂單編號會直接拒絕，**使用者付不了錢而且看不懂為什麼**。
 *
 *    改成直接從字元表均勻取樣：6 碼 × log2(36) ≈ 31 bits，同一秒內幾乎不可能撞。
 */
const TRADE_AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';   // 36 個

function tradeNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // 時間戳只到「分」，把省下的兩碼讓給隨機。
  // 秒級時間戳 + 6 碼隨機在 20000 次仍會偶爾碰撞（生日問題）；
  // 分級 + 8 碼隨機把同一分鐘內的空間拉到 36^8 ≈ 2.8×10^12。
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;

  // 拒絕取樣去掉模數偏差（256 不是 36 的倍數）。成本可忽略，何必留個歪的分布。
  let r = '';
  while (r.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b >= 252) continue;                  // 252 = 7 × 36
      r += TRADE_AB[b % 36];
      if (r.length === 8) break;
    }
  }
  return `PL${stamp}${r}`;                     // PL + 10 + 8 = 20 碼，剛好在上限
}

/** 綠界要的時間格式：yyyy/MM/dd HH:mm:ss，且必須是台北時間。 */
function tradeDate() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);   // UTC+8
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * 把購物車算成一張報價單。
 *
 * **結帳與畫面顯示一定要走同一個函式**，否則畫面寫一個數字、綠界收另一個，
 * 那是最直接的糾紛。`/v1/quote` 與 `/v1/checkout` 都呼叫這裡。
 *
 * 三條規則按順序套用：
 *   1. 賽季方案用 `seasonPriceNow`（分段價、早鳥賣完自動降級）
 *   2. **代訂附贈一週 + 另外買翻譯 → 折抵 39**（使用者決定）
 *   3. 升級補差價：扣掉這個 email 本賽季已付的一週通行證
 */
async function quoteCart(env, items, opts) {
  const o = opts || {};
  const ops = await opsConfig(env);          // 後台可覆寫價格與下架方案
  const lines = [];
  let total = 0;
  let bundledWeek = false;
  let hasWeekPurchase = false;
  let seasonKey = null;

  for (const it of items) {
    const key = String((it && it.key) || '');
    const p = PLANS[key];
    if (!p || p.internal || !(p.price > 0)) return { error: `方案不存在或不販售：${key}` };
    if (ops.hidden.includes(key)) return { error: `此方案目前未販售：${p.label}` };
    const lock = planLock(key);
    if (lock) return { error: `${p.label} 目前無法購買——${lock}` };
    // 數量上限。
    // ⚠️ 一般方案維持 5（買 5 張賽季票沒有意義，多半是誤操作）；
    //    **通行證的上限是「本賽季剩餘比賽週」**——使用者的決定：
    //    想一次買到季末就讓他買，那是我們最不用行銷的一種營收。
    //    上限一定要有：沒有上限的話 999 張會算出一個跨到明年的效期。
    const maxQty = p.weekBound ? Math.max(1, racesLeft()) : 5;
    const qty = Math.max(1, Math.min(maxQty, Number(it.qty) || 1));

    let unit = planPrice(key, ops);          // 後台覆寫優先，沒設就用程式碼裡的牌價
    let note = '';
    if (p.untilSeasonEnd) {
      // 早鳥賣完自動改正式方案。**在結帳前決定**，否則使用者看到 399 卻被收 599。
      let k = key;
      if (k === 'season_early' && (await earlyIssued(env)) >= EARLY_LIMIT) k = 'season';
      const sp = seasonPriceNow(PLANS[k].price);
      unit = sp.price;
      note = sp.nextSeason ? `${sp.tier}（本賽季剩餘週末一併附贈）` : sp.tier;
      seasonKey = k;
    }
    if (p.weekBound) {
      hasWeekPurchase = true;
      // **買了幾張就涵蓋接下來幾站，不是「同一站買幾份」。**
      // 不講清楚的話，買 3 張的人會以為自己重複買了同一站。
      const w = weekWindow(undefined, undefined, qty);
      if (w) {
        note = w.count > 1
          ? `涵蓋接下來 ${w.count} 站：${w.gpNames.join('、')}`
          : `涵蓋${w.gpNames[0]}大獎賽週末`;
      }
    }
    if (p.bundleWeek) bundledWeek = true;

    lines.push({
      key, label: p.label, qty, unit, sum: unit * qty, note,
      vpn: !!p.vpn, manual: !!p.manual,
      // primary 的判斷要用得到它：全是代訂時，有沒有附贈一週決定發哪一種內部方案
      bundleWeek: !!p.bundleWeek,
    });
    total += unit * qty;
  }

  const adjustments = [];

  // ---- 代訂附贈的一週，不該讓買家再付一次 ----
  // 使用者的決定：同時買「有附贈一週的代訂」與「一週通行證」時折抵 39。
  // 只折一次——附贈的就是一週，買兩週的人第二週仍然要付。
  if (bundledWeek && hasWeekPurchase) {
    adjustments.push({ label: '代訂已附贈一週，折抵', amount: -WEEKEND_PRICE });
    total -= WEEKEND_PRICE;
  }

  // ---- 升級補差價 ----
  let creditKeys = [];
  let creditNote = null;
  if (o.upgrade && seasonKey && o.email) {
    const c = await weekCreditFor(env, o.email, Date.now(), o.licenseKey);
    if (c.credit > 0) {
      const use = Math.min(c.credit, total);      // 不會變成負數
      adjustments.push({ label: `已購一週通行證折抵（本賽季 ${c.keys.length} 張）`, amount: -use });
      total -= use;
      creditKeys = c.keys;
    }
  }

  total = Math.max(0, Math.round(total));
  return {
    lines,
    adjustments,
    total,
    creditKeys,
    // 主方案：發碼與統計要有一個代表。
    //
    // ⚠️ **購物車全是代訂時，絕對不可以拿代訂方案當主方案。**
    //    代訂方案沒有期限欄位，planExpiry 會回 null＝無期限，
    //    等於送出一張永不過期的字幕授權（實際存在過的漏洞）。
    //    全是代訂時改發內部方案：有附贈一週的發 week_svc，
    //    沒有的發 svc_none（立刻到期，只用來讓後台追得到這張訂單）。
    primary: (lines.find((l) => !l.manual) || {}).key
      || (lines.some((l) => l.bundleWeek) ? 'week_svc' : 'svc_none'),
    // 差額低到不值得走金流時直接送（見 UPGRADE_FREE_BELOW）
    creditNote,
    freeUpgrade: !!(o.upgrade && total > 0 && total < UPGRADE_FREE_BELOW),
    needsVpn: lines.some((l) => l.vpn),
    hasManual: lines.some((l) => l.manual),
  };
}

async function handleCheckout(request, env, url) {
  const ops = await opsConfig(env);
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');

  // ⚠️ 法定要件：七天鑑賞期的排除需要「經消費者事先同意」。
  //    沒有這個勾選，排除條款在法律上不成立，使用者仍可主張無條件退貨。
  if (!body.agreed) return err('請先閱讀並同意使用條款與隱私權政策');

  const email = String(body.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    return err('請填寫正確的 email —— 授權碼會寄到這個信箱，也是日後補發的唯一依據');
  }

  // 舊的單品格式（`plan`）與新的購物車格式（`items`）都要收。
  // 購買頁改版是漸進的，中間一定有兩種格式並存的時間。
  const raw = Array.isArray(body.items) && body.items.length
    ? body.items
    : (body.plan ? [{ key: body.plan, qty: 1 }] : []);
  if (!raw.length) return err('購物車是空的');
  if (raw.length > 10) return err('一次最多 10 個項目');

  const quote = await quoteCart(env, raw, { email, upgrade: !!body.upgrade, licenseKey: body.licenseKey });
  if (quote.error) return err(quote.error);
  const price = quote.total;
  const finalPlan = quote.primary;
  if (price < 1) {
    // 綠界不收 0 元。差額被抵光時走的是「直接發碼」那條路，不該進到這裡。
    return err('本次應付金額為 0，請改用免費升級流程', 400);
  }

  const conf = ecpayConf(env, body.mode === 'stage' ? 'stage' : 'production');
  if (!conf.merchantId || !conf.hashKey || !conf.hashIV) {
    return err('金流尚未設定完成，請稍後再試或聯絡客服', 503);
  }

  const no = tradeNo();
  const site = env.SITE_URL || 'https://pitlingo.com';
  const api = env.API_URL || 'https://api.pitlingo.com';

  // 官方規格的硬性限制，違反了綠界會直接拒絕而且錯誤訊息很難懂：
  //   ReturnURL 必須 HTTPS（443）、不可指定埠號、不可含中文
  //   ReturnURL 與 OrderResultURL 不可相同
  if (!/^https:\/\/[^:/]+(\/|$)/.test(api) || !/^https:\/\/[^:/]+(\/|$)/.test(site)) {
    return err('伺服器設定不正確（回呼網址必須是 https 且不可指定埠號）', 500);
  }

  const params = {
    MerchantID: conf.merchantId,
    MerchantTradeNo: no,
    MerchantTradeDate: tradeDate(),
    PaymentType: 'aio',
    TotalAmount: String(price),
    // 官方規格：TradeDesc String(200)「不可有特殊字元」。用純英數與空格最保險。
    TradeDesc: 'PitLingo subtitle service',
    // ⚠️ ItemName 用 # 分隔多項商品，所以商品名稱本身**絕對不能含 #**。
    //    我們只有一項，但方案名稱是外部可改的，先過濾掉。
    // 多項商品用 # 分隔（綠界規格）。名稱本身絕不能含 #，所以先濾掉。
    // 折抵不列成項目——綠界沒有負數金額的概念，`TotalAmount` 已經是折抵後的數字，
    // 折抵明細記在我們自己的訂單裡（`pending`），出問題時對得回來。
    ItemName: quote.lines
      .map((l) => `PitLingo ${l.label}${l.qty > 1 ? ` x${l.qty}` : ''}`.replace(/#/g, ' '))
      .join('#').slice(0, 400),
    ReturnURL: `${api}/v1/payment/webhook`,
    // ⚠️ **不要同時設 ClientBackURL 與 OrderResultURL。**
    //    官方文件：兩者都設時 OrderResultURL 優先，ClientBackURL 會失效——
    //    留著只會讓人以為它有作用。我們要的是「付款後導回並顯示授權碼」，
    //    所以只留 OrderResultURL。
    //    另外它與 ReturnURL **不可相同**，否則綠界的判斷會錯亂。
    // ⚠️ **綠界是用 POST 導回來的，而 `/paid` 是 Cloudflare Pages 的靜態頁。**
    //    靜態頁拿不到 POST body，於是頁面上什麼訂單資訊都沒有——
    //    實測就是這個症狀：付款成功卻看不到授權碼。
    //    改成先導到 Worker，由它接住 POST、驗簽，再 302 帶著訂單編號轉到 /paid。
    OrderResultURL: `${api}/v1/payment/result`,
    // ATM／超商取號時的通知。**與 ReturnURL 分開**，因為取號不等於付款。
    PaymentInfoURL: `${api}/v1/payment/info`,
    // ⚠️ **綠界錯誤 10300023「本次交易未提供任何付款方式」就是這一行造成的。**
    //
    //    "ALL" 的語意是「顯示商店已開通的全部方式」，但若商店在綠界後台
    //    **一項都還沒開通**（或該筆金額不在任何一種方式的可用區間內），
    //    過濾之後就一種都不剩，綠界直接回這個錯誤。
    //    常見於測試帳號轉正式帳號、審核尚未完成時。
    //
    //    改成可由後台設定（ops:config 的 choosePayment），用途有二：
    //      1. 商店只開通信用卡時填 "Credit"，就不會被 ALL 過濾成空
    //      2. 想暫時只收某一種方式時不必改程式碼重新部署
    ChoosePayment: ops.choosePayment || 'ALL',
    EncryptType: '1',
    CustomerEmail: email,
    NeedExtraPaidInfo: 'N',
  };
  params.CheckMacValue = await ecpayMac(params, conf.hashKey, conf.hashIV);

  // 先把訂單記下來。webhook 回來時要靠它知道「這筆是什麼方案、寄給誰」——
  // 綠界的通知不會帶我們自己的欄位。
  await env.SUBS.put(`pending:${no}`, JSON.stringify({
    plan: finalPlan, price, email, at: nowSec(), mode: conf.mode,
    // 購物車全貌要留著：webhook 回來時要知道發哪些碼、哪些是待人工處理的代訂，
    // 以及哪幾張一週通行證已經被拿去抵扣了（不標記的話明年還能再抵一次）。
    items: quote.lines.map((l) => ({ key: l.key, qty: l.qty, unit: l.unit })),
    adjustments: quote.adjustments,
    creditKeys: quote.creditKeys,
    manual: quote.hasManual,
  }), { expirationTtl: 30 * 86400 });          // 超商代碼最長可繳 30 天

  // 訂單記錄。**與 pending 是兩回事**：pending 只是 webhook 要用的暫存，
  // 發完碼就刪掉；訂單記錄要留到明年，後台才看得到「有人結帳但沒付成功」。
  // 沒有這一份的話，付款失敗在系統裡完全不留痕跡（實際踩過）。
  await patchOrder(env, no, {
    no, at: nowSec(), status: 'created',
    price, email, plan: finalPlan, mode: conf.mode,
    summary: quote.lines.map((l) => `${l.label}${l.qty > 1 ? ' x' + l.qty : ''}`).join('、'),
    items: quote.lines.map((l) => ({ key: l.key, label: l.label, qty: l.qty, unit: l.unit })),
    adjustments: quote.adjustments,
    services: quote.lines.filter((l) => l.manual)
      .map((l) => ({ key: l.key, label: l.label, qty: l.qty, status: 'pending' })),
    mailed: false,
  });

  return json({ ok: true, action: conf.url, params, orderId: no, plan: finalPlan, price, mode: conf.mode });
}

/**
 * ATM／超商「取號成功」的通知。
 * **這裡絕對不能發碼**——取號只代表拿到繳費代碼，錢還沒進來。
 * 存起來只是為了讓使用者在 /paid 頁面看得到繳費資訊。
 */
async function handlePaymentInfo(request, env) {
  const ct = request.headers.get('content-type') || '';
  let p = {};
  if (ct.includes('json')) p = await request.json().catch(() => ({}));
  else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) p[k] = String(v);
  }
  const no = String(p.MerchantTradeNo || '').trim();
  if (!no) return new Response('0|no order id', { status: 400 });

  const conf = ecpayConf(env, 'production');
  const stage = ecpayConf(env, 'stage');
  const okProd = conf.hashKey && safeEqual(String(p.CheckMacValue || '').toUpperCase(),
    await ecpayMac(p, conf.hashKey, conf.hashIV));
  const okStage = safeEqual(String(p.CheckMacValue || '').toUpperCase(),
    await ecpayMac(p, stage.hashKey, stage.hashIV));
  if (!okProd && !okStage) return new Response('0|bad mac', { status: 401 });

  await env.SUBS.put(`payinfo:${no}`, JSON.stringify({
    bank: p.BankCode || '', vAccount: p.vAccount || '',
    payNo: p.PaymentNo || '', expire: p.ExpireDate || '',
    at: nowSec(),
  }), { expirationTtl: 30 * 86400 });

  // 後台要分得出「還沒去繳」與「付款失敗」——ATM／超商取號的人常常隔天才繳，
  // 把它們混在 created 裡會讓人以為訂單流失了。
  await patchOrder(env, no, { status: 'awaiting' });

  return new Response('1|OK');
}

/** 讓 /paid 頁面查自己那筆訂單的狀態。只回「這筆訂單」的資訊，不列舉。 */
async function handleOrderStatus(env, url) {
  const no = String(url.searchParams.get('no') || '').trim();
  if (!/^PL[A-Z0-9]{5,24}$/.test(no)) return err('訂單編號格式不正確');

  const licKeyRaw = await env.SUBS.get(`order:${no}`);
  if (licKeyRaw) {
    return json({ status: 'paid', licenseKey: prettyLicense(licKeyRaw) });
  }
  const info = await env.SUBS.get(`payinfo:${no}`);
  if (info) return json({ status: 'awaiting_payment', payment: JSON.parse(info) });

  const pend = await env.SUBS.get(`pending:${no}`);
  if (pend) return json({ status: 'pending' });
  return json({ status: 'unknown' }, 404);
}

// ---------------------------------------------------------------------------
// 金流 webhook —— 付款成功後自動發碼
//
// 為什麼要驗簽：webhook 的網址是公開的，任何人都能 POST 一筆假訂單過來換取
// 免費授權。綠界用 CheckMacValue（參數排序後接上 HashKey/HashIV 再雜湊）。
//
// 為什麼要防重放：金流平台在沒收到 200 時會**重送同一筆通知**，
// 不擋的話同一筆訂單會發出好幾組授權碼。以訂單編號為鍵記錄已處理過的。
// ---------------------------------------------------------------------------

/** 綠界的 CheckMacValue。演算法固定，錯一個環節就全錯。 */
async function ecpayMac(params, hashKey, hashIV) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  // 綠界指定的 URL encode 規則（.NET UrlEncode：小寫，且部分字元不編碼）
  const enc = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, '+').replace(/%21/g, '!').replace(/%2a/g, '*')
    .replace(/%28/g, '(').replace(/%29/g, ')').replace(/%27/g, "'");
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(enc));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * 商品代號 → 方案。對不上就用 season——
 * **寧可多給也不要讓付了錢的人拿不到東西**，客服可以事後調整，
 * 但「付了錢沒東西」是最傷的。
 */
function planFromItem(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('early') || n.includes('早鳥')) return 'season_early';
  return 'season';
}

async function handlePaymentWebhook(request, env) {
  const ct = request.headers.get('content-type') || '';
  let p = {};
  if (ct.includes('json')) {
    p = await request.json().catch(() => ({}));
  } else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) p[k] = String(v);
  }

  const orderId = String(p.MerchantTradeNo || p.orderId || '').trim();
  if (!orderId) return new Response('0|no order id', { status: 400 });

  // --- 驗簽 ---
  // 正式與測試兩組憑證都試。測試環境用綠界公開的帳號，
  // 讓我們能在**不花真錢**的情況下驗證整條路徑——正式環境上線前唯一的辦法。
  if (env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV) {
    const prodOk = safeEqual(String(p.CheckMacValue || '').toUpperCase(),
      await ecpayMac(p, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV));
    const stageOk = safeEqual(String(p.CheckMacValue || '').toUpperCase(),
      await ecpayMac(p, ECPAY_TEST.hashKey, ECPAY_TEST.hashIV));
    if (!prodOk && !stageOk) return new Response('0|bad mac', { status: 401 });
  } else if (env.WEBHOOK_SECRET) {
    // 通用備援：自訂金流或測試時用 header 驗
    if (!safeEqual(request.headers.get('x-webhook-secret') || '', env.WEBHOOK_SECRET)) {
      return new Response('0|unauthorized', { status: 401 });
    }
  } else {
    // 沒設定任何驗證方式就不處理。**寧可不發也不要開一個誰都能領的窗口。**
    return new Response('0|webhook not configured', { status: 503 });
  }

  // 未付款成功也要回 1，否則金流會一直重送
  const paid = String(p.RtnCode || p.status || '') === '1' || p.status === 'paid';
  if (!paid) return new Response('1|OK');

  // --- 防重放 ---
  const dedupeKey = `order:${orderId}`;
  const seen = await env.SUBS.get(dedupeKey);
  if (seen) return new Response('1|OK', { headers: { 'x-pitlingo-license': seen } });

  // --- 發碼 ---
  // ⚠️ 方案要從**我們自己建立訂單時記下的** pending 讀，不要從綠界回傳的
  //    商品名稱猜。使用者結帳當下看到的是什麼價格，就該拿到什麼方案——
  //    靠字串比對猜商品名，改一次文案就會發錯方案，而且不會有人發現。
  let pending = null;
  try { pending = JSON.parse((await env.SUBS.get(`pending:${orderId}`)) || 'null'); } catch (e) { /* noop */ }

  const email = String((pending && pending.email) || p.CustomerEmail || p.email || '').trim();
  let plan = pending && PLANS[pending.plan] ? pending.plan : planFromItem(p.ItemName || p.plan);

  // 金額對不上就不發碼。綠界的通知帶著實付金額，與我們記錄的價格不符
  // 代表有人竄改了結帳參數，或我們自己算錯了——兩種都不該默默發下去。
  if (pending && p.TradeAmt !== undefined && Number(p.TradeAmt) !== Number(pending.price)) {
    return new Response('0|amount mismatch', { status: 400 });
  }
  // 早鳥賣完就給正式方案。金流那邊可能還在賣舊連結，這裡是最後一道。
  // **寧可少賣一組也不要賣超**——名額只有 20，食言的代價比少賺一筆高得多。
  if (plan === 'season_early' && (await earlyIssued(env)) >= EARLY_LIMIT) plan = 'season';
  const key = normLicense(licenseKeyNew());
  // Weekend Pass 要記下它涵蓋的是哪一場、從哪一天起生效。
  // 少了這兩個欄位，提前購買的人會拿到一張「現在就能用、但比賽前就過期」的通行證。
  // ⚠️ **數量一定要從購物車讀回來。**
  //    買 3 張通行證卻只發一張的效期，是安靜地少給使用者他付過錢的東西——
  //    不報錯，只有他自己會在第二站發現看不了。
  const weekQty = (pending && Array.isArray(pending.items))
    ? pending.items.filter((i) => PLANS[i.key] && PLANS[i.key].weekBound)
      .reduce((n, i) => n + (Number(i.qty) || 1), 0)
    : 1;
  const w = PLANS[plan] && PLANS[plan].weekBound ? weekWindow(undefined, undefined, weekQty) : null;

  // 代訂是**人工服務**：付款只代表「已收款、待處理」，不是已完成。
  // 把它列進授權記錄是為了讓後台看得到、追得到、結得了案——
  // 沒有這個欄位，代訂訂單付完款就從系統裡消失，只剩你信箱裡的一封通知。
  const cartItems = (pending && Array.isArray(pending.items)) ? pending.items : [];
  const services = cartItems.filter((i) => PLANS[i.key] && PLANS[i.key].manual);

  const lic = {
    plan, email, orderId,
    // 帳號鍵。**日後導入登入時，靠這個欄位把既有資料接回帳號**——
    // 少一筆就是一筆接不回去的孤兒，而且完全不會報錯（見 accountKey）。
    acct: accountKey(email),
    expiresAt: planExpiry(plan, undefined, undefined, weekQty),
    startsAt: planStart(plan),
    // 涵蓋的站名。買多站時要全部列出來，客服與使用者才對得上
    gpName: w ? (w.count > 1 ? `${w.gpNames[0]}～${w.gpNames[w.count - 1]}（${w.count} 站）` : w.gp.name) : null,
    gpNames: w ? w.gpNames : null,
    gpCount: w ? w.count : null,
    weekFrom: w ? w.weekFrom : null,          // 正式七天從哪天起算（之前是贈送期）
    // 這筆訂單實付多少。升級抵扣要用它，不能用牌價——
    // 折抵過的訂單若用牌價回算，會把折掉的金額再抵一次。
    paid: pending ? Number(pending.price) || 0 : (PLANS[plan] || {}).price || 0,
    items: cartItems,
    services: services.length ? services.map((s) => ({
      key: s.key, qty: s.qty, label: PLANS[s.key].label, status: 'pending',
    })) : null,
    devices: [], createdAt: nowSec(), revoked: false,
    source: 'webhook',
  };
  await env.SUBS.put(licKey(key), JSON.stringify(lic));

  // 拿去抵扣的一週通行證要標記，否則下一次升級還能再抵一次同樣的金額。
  // ⚠️ 一定要在發碼**之後**做：先標記後發碼的話，發碼失敗會讓使用者
  //    既沒拿到新授權、舊的額度也被吃掉。
  if (pending && Array.isArray(pending.creditKeys) && pending.creditKeys.length) {
    await markCredited(env, pending.creditKeys, orderId);
  }
  await env.SUBS.put(dedupeKey, key, { expirationTtl: 400 * 86400 });
  await env.SUBS.delete(`pending:${orderId}`);
  if (email) {
    const ik = `licmail:${email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    if (!arr.includes(key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
  }

  // 寄授權碼給買家。
  // ⚠️ **絕不能讓寄信失敗影響發碼。** 授權碼此刻已經寫進資料庫了，
  //    寄不出去客服補得回來；但如果因為寄信拋例外而讓 webhook 回非 200，
  //    綠界會重送，而重送會被去重擋掉——結果是買家永遠收不到、後台也查不出原因。
  let mailed = { sent: false, reason: 'no_email' };
  if (email) {
    try {
      mailed = await sendLicenseMail(env, email, key, lic);
    } catch (e) {
      mailed = { sent: false, reason: String(e && e.message || e) };
    }
    if (!mailed.sent) {
      // 寄不出去一定要留下紀錄，否則只會變成「買家說沒收到」的無頭公案
      try {
        await env.SUBS.put(`mailfail:${orderId}`, JSON.stringify({
          orderId, email, key, reason: mailed.reason, at: nowSec(),
        }), { expirationTtl: 90 * 86400 });
      } catch (e) { /* 連記錄都失敗就算了，不擋主流程 */ }
    }
  }

  if (env.REPORT_WEBHOOK) {
    try {
      await fetch(env.REPORT_WEBHOOK, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: `[PitLingo] 新訂單 ${orderId}`,
          to: env.REPORT_TO,
          text: `方案 ${plan}\nemail ${email}\n授權碼 ${prettyLicense(key)}`,
        }),
      });
    } catch (e) { /* 通知失敗不影響發碼 */ }
  }

  return new Response('1|OK');
}

/**
 * 管理端：列出所有授權碼。
 *
 * 量大之後「一組一組查」是不能用的。這裡直接掃 KV 的 lic: 前綴，
 * 支援關鍵字過濾（授權碼／email／訂單編號）與狀態過濾。
 *
 * KV 的 list 有游標，所以要能分頁——一次撈完在幾百組之後會逾時。
 */
async function handleLicenseList(request, env, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  const status = url.searchParams.get('status') || 'all';
  const cursor = url.searchParams.get('cursor') || undefined;

  const listed = await env.SUBS.list({ prefix: 'lic:', limit: 200, cursor });
  const rows = [];
  for (const k of listed.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let lic; try { lic = JSON.parse(raw); } catch (e) { continue; }
    const key = k.name.slice(4);

    const expired = !!(lic.expiresAt && lic.expiresAt * 1000 < Date.now());
    const state = lic.revoked ? 'revoked' : expired ? 'expired' : 'active';
    if (status !== 'all' && status !== state) continue;
    if (q && ![key, lic.email, lic.orderId].some((v) => String(v || '').toLowerCase().includes(q))) continue;

    rows.push({
      licenseKey: prettyLicense(key),
      raw: key,
      plan: lic.plan,
      planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
      email: lic.email || '',
      orderId: lic.orderId || '',
      createdAt: lic.createdAt || null,
      expiresAt: lic.expiresAt || null,
      devices: (lic.devices || []).length,
      state,
    });
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ rows, cursor: listed.list_complete ? null : listed.cursor, complete: listed.list_complete });
}

/**
 * 管理端：改一組授權碼（延期、換方案、解除全部裝置）。
 * 客服最常做的三件事，不做的話每次都要重發一組新碼。
 */
async function handleLicensePatch(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);

  // ⚠️ 一定要在任何修改**之前**取。`clearDevices` 會把 `lic.devices` 清成空陣列，
  //    等到下面才讀就一個 installId 都拿不到，於是「清空裝置」在伺服器端毫無效果。
  const idsBefore = (lic.devices || []).map((d) => d.installId).filter(Boolean);

  if (body.plan && PLANS[body.plan]) {
    lic.plan = body.plan;
    if (body.recalcExpiry) lic.expiresAt = planExpiry(body.plan);
  }
  if (body.expiresAt !== undefined) lic.expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
  if (body.extendDays) lic.expiresAt = (lic.expiresAt || nowSec()) + Number(body.extendDays) * 86400;
  if (body.revoked !== undefined) { lic.revoked = !!body.revoked; lic.revokedAt = body.revoked ? nowSec() : null; }
  if (body.clearDevices) lic.devices = [];
  if (body.email !== undefined) lic.email = String(body.email);

  await env.SUBS.put(licKey(key), JSON.stringify(lic));

  // 通行證作廢要跟著 `revoked` 走**兩個方向**。
  // 只處理停用不處理恢復的話，後台按了「恢復」畫面會說成功，
  // 但那台裝置的通行證仍在作廢清單裡 → 使用者依舊用不了，且沒有任何錯誤訊息。
  if (body.revoked === true) await voidEntitlements(env, idsBefore);
  else if (body.revoked === false) await unvoidEntitlements(env, idsBefore);
  // 清空裝置＝把那些安裝踢掉，它們手上的通行證也要一起失效，
  // 否則「清空裝置」只是清掉一份名單，被踢掉的人照樣能用到通行證過期。
  if (body.clearDevices) await voidEntitlements(env, idsBefore);
  return json({ ok: true, licenseKey: prettyLicense(key), plan: lic.plan, expiresAt: lic.expiresAt, revoked: !!lic.revoked, devices: (lic.devices || []).length });
}

/**
 * 管理端：**永久刪除**一組授權碼。
 *
 * 與「停用」是不同的東西，兩個都要有：
 *   停用  資料留著。退款、盜用、chargeback 用——**日後有爭議時你需要那筆紀錄**。
 *   刪除  資料清掉。測試用的、發錯的、重複發的用。
 *
 * 安全設計：
 *   1. **有裝置啟用過的碼預設不給刪**，除非明確帶 force。
 *      真實使用者的碼被誤刪 = 他付了錢卻突然失效，那是最嚴重的傷害。
 *   2. 刪除時把 email 索引與訂單去重鍵一起清掉，否則會留下指向空值的索引，
 *      客服查詢時看到一組查不到內容的碼，比沒有更困惑。
 *   3. 已刪除的碼不再能啟用（KV 讀不到 → 404），**而且已經發出去的通行證
 *      會立刻作廢**（寫進 `entvoid`）。
 *
 * ⚠️ 第 3 點在 2026-08-17 改過，原本的設計是「通行證仍在有效期內運作，
 *    避免誤刪立刻把人踢下線」。實際回報的症狀是：**後台刪除授權碼，
 *    擴充功能仍顯示已啟用，而且伺服器端真的還在放行**——
 *    對「刪除」這個動作而言那是錯的，管理員按了刪除就是要它立刻停。
 *    誤刪的保護留在第 1 點（有裝置就必須帶 force），那才是正確的位置。
 *
 *    作廢用的是 `entvoid` 而不是 `revoked`：前者退回免費層，後者是整個安裝封鎖。
 *    刪掉一組發錯的碼不該讓那個人連每場 15 分鐘的免費額度都沒有。
 */
async function handleLicenseDelete(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);

  const devices = (lic.devices || []).length;
  if (devices > 0 && !body.force) {
    return json({
      error: `這組授權碼有 ${devices} 台裝置啟用中，不能直接刪除。`
        + '若確定要刪，請先確認不是真實使用者（誤刪會讓付費者立刻失效）。',
      needsForce: true, devices,
    }, 409);
  }

  // ⚠️ **刪掉授權碼不會讓已經發出去的通行證失效。**
  //    通行證是簽出去的獨立憑證，最長 14 天，`entitlementGate` 只驗簽章與期限。
  //    實際回報過的症狀：後台刪除授權碼，使用者的擴充功能仍顯示「已啟用」——
  //    而且不只是畫面，伺服器端也真的還在放行。
  //    所以刪除時必須把底下的安裝寫進撤銷清單，那是唯一能立刻生效的機制。
  await voidEntitlements(env, (lic.devices || []).map((d) => d.installId));

  await env.SUBS.delete(licKey(key));

  // 連帶清掉索引，不留下指向空值的殘骸
  if (lic.email) {
    const ik = `licmail:${lic.email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    arr = arr.filter((k) => k !== key);
    if (arr.length) await env.SUBS.put(ik, JSON.stringify(arr));
    else await env.SUBS.delete(ik);
  }
  // 訂單去重鍵也要清，否則同一筆訂單日後補發會被當成重放而拒絕
  if (lic.orderId) await env.SUBS.delete(`order:${lic.orderId}`);

  return json({ ok: true, deleted: prettyLicense(key), hadDevices: devices });
}

/** 管理端：把工單標成已解決／未解決。 */
async function handleReportPatch(request, env) {
  const body = await request.json().catch(() => null);
  const id = String((body && body.id) || '').trim();
  if (!id) return err('缺少工單編號');
  const raw = await env.SUBS.get(`report:${id}`);
  if (!raw) return err('查無此工單', 404);
  const rec = JSON.parse(raw);

  if (body.resolved !== undefined) {
    rec.resolved = !!body.resolved;
    rec.resolvedAt = body.resolved ? nowSec() : null;
  }
  if (body.adminNote !== undefined) rec.adminNote = String(body.adminNote).slice(0, 2000);
  if (body.delete) { await env.SUBS.delete(`report:${id}`); return json({ ok: true, deleted: id }); }

  // 保留原本的 TTL 計算方式，避免「編輯一次就重新計時 90 天」
  const age = nowSec() - (rec.at || nowSec());
  const left = Math.max(86400, REPORT_TTL_DAYS * 86400 - age);
  await env.SUBS.put(`report:${id}`, JSON.stringify(rec), { expirationTtl: left });
  return json({ ok: true, id, resolved: !!rec.resolved });
}

/** 管理端：發碼。P3 接上金流後由 webhook 呼叫，現在先手動。 */
async function handleLicenseIssue(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const key = normLicense(body.licenseKey || licenseKeyNew());
  let plan = PLANS[body.plan] ? String(body.plan) : 'season';

  // 早鳥限量。**不能靠人工盯著改**——賣超了要嘛食言要嘛虧錢，兩個都不該發生。
  // 超過就自動降級成正式價，並在回應裡說明，讓發碼的人知道發生了什麼。
  let downgraded = false;
  let earlyUsed = -1;
  if (plan === 'season_early') {
    earlyUsed = await earlyIssued(env);
    if (earlyUsed >= EARLY_LIMIT) { plan = 'season'; downgraded = true; }
    else earlyUsed += 1;                    // 這一張也算進去
  }
  // ⚠️ **後台發的碼必須與 webhook 發的碼有相同欄位。**
  //    少了 weekFrom，一週通行證的正式七天不知道從哪天算；
  //    少了 paid，這張碼日後升級賽季票時折抵金額會算成 0——
  //    兩者都不會報錯，只會在幾週後變成一筆客訴。
  // 後台手動發通行證時也能指定涵蓋幾站（客服補償常常要給不只一站）
  const wkQty = Math.max(1, Math.min(Number(body.gpCount) || 1, Math.max(1, racesLeft())));
  const wk = (PLANS[plan] && PLANS[plan].weekBound) ? weekWindow(undefined, undefined, wkQty) : null;
  const opsNow = await opsConfig(env);
  const lic = {
    plan,
    email: String(body.email || ''),            // 來自金流，用於補發，不另外收集
    acct: accountKey(body.email),               // 帳號鍵，見 accountKey 的說明
    orderId: String(body.orderId || ''),
    // 期限一律由伺服器依方案算。只有明確傳 expiresAt 時才覆寫（客服調整用）。
    expiresAt: body.expiresAt ? Number(body.expiresAt) : planExpiry(plan, undefined, undefined, wkQty),
    startsAt: planStart(plan),
    gpName: wk ? (wk.count > 1 ? `${wk.gpNames[0]}～${wk.gpNames[wk.count - 1]}（${wk.count} 站）` : wk.gp.name) : null,
    gpNames: wk ? wk.gpNames : null,
    gpCount: wk ? wk.count : null,
    weekFrom: wk ? wk.weekFrom : null,
    // 實付金額。手動發碼時預設用此刻的實際售價；補償碼是 0，折抵時自然算不到。
    paid: body.paid !== undefined ? Number(body.paid) || 0 : (planPrice(plan, opsNow) || 0),
    items: [{ key: plan, qty: 1, unit: planPrice(plan, opsNow) || 0 }],
    services: PLANS[plan] && PLANS[plan].manual
      ? [{ key: plan, qty: 1, label: PLANS[plan].label, status: 'pending' }] : null,
    devices: [],
    createdAt: nowSec(),
    revoked: false,
    source: 'admin',
  };
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  // 建 email 索引，讓「忘記授權碼」查得回來
  if (lic.email) {
    const ik = `licmail:${lic.email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    if (!arr.includes(key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
  }
  return json({
    ok: true, licenseKey: prettyLicense(key), plan: lic.plan,
    planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
    expiresAt: lic.expiresAt,
    downgraded,
    // 只有發早鳥時才知道剩幾組；發正式方案時不為了顯示而多掃一次 KV
    earlyLeft: earlyUsed < 0 ? null : Math.max(0, EARLY_LIMIT - earlyUsed),
  });
}

/**
 * 寄出授權碼。
 *
 * ⚠️ **買家看不到訂單資訊，是目前最嚴重的體驗缺口**——付了錢卻什麼都沒收到，
 *    第一個念頭是被騙。付款完成頁可以顯示，但那一頁關掉就再也找不回來，
 *    而授權碼是他日後換電腦、重灌時唯一的憑據。
 *
 * 用 Resend（免費層每月 3,000 封，設定最簡單）。**沒設定金鑰時不報錯、
 * 只記一筆事件**——寄信失敗絕不能影響發碼：授權碼已經在資料庫裡了，
 * 客服補寄得回來，但如果因為寄信炸掉而讓發碼流程中斷，那是真的損失。
 *
 * 需要的設定：
 *   wrangler secret put RESEND_API_KEY
 *   MAIL_FROM（vars，例如 "PitLingo <noreply@pitlingo.com>"，網域要在 Resend 驗證過）
 */
async function sendLicenseMail(env, to, key, lic, quote) {
  if (!env.RESEND_API_KEY || !to) return { sent: false, reason: 'not_configured' };

  const pretty = prettyLicense(key);
  const items = (lic.items || []).map((i) => {
    const p = PLANS[i.key];
    return `<li>${p ? p.label : i.key}${i.qty > 1 ? ` × ${i.qty}` : ''}</li>`;
  }).join('');
  const svc = (lic.services || []).length
    ? '<p><b>代訂服務</b>將於三個工作日內處理完成，完成後另行以本信箱通知。'
      + '請注意：<b>觀看 F1TV 需自行準備 VPN</b>。</p>'
    : '';
  const exp = lic.expiresAt
    ? new Date(lic.expiresAt * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    : '無期限';

  const html = [
    '<div style="font:16px/1.7 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">',
    '<h1 style="font-size:22px;margin:0 0 8px">PitLingo 訂單完成</h1>',
    '<p>感謝您的購買。以下是您的授權碼，<b>請妥善保存</b>——',
    '它以使用者為單位，換電腦或重新安裝都用同一組啟用。</p>',
    `<div style="font:600 24px/1.4 ui-monospace,monospace;letter-spacing:2px;padding:16px;`,
    `text-align:center;border:2px dashed #0a7c4a;border-radius:12px;margin:16px 0">${pretty}</div>`,
    `<p>訂單編號：<code>${lic.orderId || '-'}</code>　·　有效期至：${exp}</p>`,
    items ? `<p><b>購買項目</b></p><ul>${items}</ul>` : '',
    svc,
    '<h2 style="font-size:17px;margin:20px 0 6px">啟用方式</h2>',
    '<ol><li>安裝 PitLingo 擴充功能</li>',
    '<li>點擴充功能圖示 → 授權 → 貼上授權碼 → 啟用</li>',
    '<li>打開 F1TV 影片，並在播放器開啟英文字幕（CC）</li></ol>',
    '<p style="font-size:14px;color:#666">最多可在 3 台裝置同時啟用，可自行解除後轉移。<br>',
    '如有問題請至 <a href="https://pitlingo.com/contact">pitlingo.com/contact</a> 與我們聯繫。</p>',
    '</div>',
  ].join('');

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'PitLingo <noreply@pitlingo.com>',
        to: [to],
        subject: `PitLingo 授權碼 ${pretty}`,
        html,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { sent: false, reason: `HTTP ${r.status} ${t.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: String(e && e.message || e) };
  }
}

/** 管理端：停用（退款、盜用、chargeback）。 */
async function handleLicenseRevoke(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);
  lic.revoked = true;
  lic.revokedAt = nowSec();
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  // 與刪除同理：光是把 `revoked` 寫進授權記錄，只會讓**下一次續期**被拒；
  // 在那之前（最長 24 小時）已發出的通行證照樣通過伺服器端閘門。
  // 退款與盜用都要求立刻生效，所以一併讓通行證作廢。
  await voidEntitlements(env, (lic.devices || []).map((d) => d.installId));
  return json({ ok: true, devices: (lic.devices || []).length });
}

/** 管理端：用 email 查回授權碼（客服補發用）。 */
async function handleLicenseLookup(request, env, url) {
  const email = String(url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return err('需要 email');
  let arr = [];
  try { arr = JSON.parse((await env.SUBS.get(`licmail:${email}`)) || '[]'); } catch (e) { /* noop */ }
  const out = [];
  for (const k of arr) {
    const lic = await readLicense(env, k);
    if (lic) out.push({ licenseKey: prettyLicense(k), plan: lic.plan, expiresAt: lic.expiresAt, revoked: !!lic.revoked, devices: (lic.devices || []).length });
  }
  return json({ email, licenses: out });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
// ⚠️ **不要放 Access-Control-Allow-Origin: '*'。**
//
// 原本是 `*`，等於任何網站都能從瀏覽器直接打這個 API。搭配「權杖等同公開」
// （S6），一個惡意網頁就能無限燒 Anthropic 額度。
//
// 而我們**根本不需要 CORS**：
//   - 擴充功能的請求由 service worker 發出，有 host_permissions，不受 CORS 限制
//   - userscript 用 GM_xmlhttpRequest，也不受限制
// 拿掉之後，瀏覽器端的跨站呼叫會被瀏覽器自己擋下來，攻擊面直接消失。
const CORS = {
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-client-token,x-admin-token',
  'Access-Control-Max-Age': '86400',
};

/**
 * 管理端點需要 CORS，一般端點不需要。
 *
 * 一般端點拿掉 CORS 是對的（用戶端都不受 CORS 限制，開著只是徒增攻擊面）。
 * 但**後台是本機開的 HTML 檔**，`file://` 的 Origin 是 `null`，
 * 沒有 CORS 就完全打不到 API——第一版把自己的後台也擋掉了。
 *
 * 這裡放寬是安全的：管理端點一律要 `x-admin-token`，而那個權杖
 * **不在任何發佈出去的程式碼裡**（不像 CLIENT_TOKEN 隨擴充功能發給所有人）。
 * 沒有權杖的跨站請求照樣是 401。
 */
const ADMIN_CORS = { ...CORS, 'Access-Control-Allow-Origin': '*' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/** 管理端點專用的回應（帶 CORS） */
function adminJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...ADMIN_CORS },
  });
}

/**
 * 錯誤代碼表。
 *
 * 為什麼需要：**訊息會隨文案調整而變，代碼不會。** 使用者截圖回報時，
 * 「翻譯失敗，請稍後再試」查不出任何東西；「PL-E31」一秒就定位。
 *
 * ⚠️ **不是每個異常都該給使用者代碼。** 這個專案有兩種「沒有字幕」是正常的：
 *      · 這支影片本來就沒有字幕（宣傳片、純畫面）
 *      · 有字幕的影片中途長時間沒旁白（賽後訪問、頒獎）
 *    給那兩種發代碼，等於訓練使用者把正常現象當故障回報，
 *    然後真正的故障就淹沒在雜訊裡。判準是：
 *      **「使用者的體驗確實壞了」且「我們拿到代碼真的查得出東西」** 才給。
 *
 * ⚠️ 代碼一旦發出去就**不可以改語意**。要淘汰就留著別再用，
 *    不要回收給別的錯誤——使用者手上與工單裡的舊代碼會永遠存在。
 */
const ERR_CODES = {
  E10: '請求格式不正確',
  E11: '缺少必要欄位',
  E12: '一次送出的句數超過上限',
  E13: '單句長度超過上限（整批都超過才會擋）',
  E20: '安裝權杖無效或已過期',
  E21: '這個安裝已被封鎖',
  E22: '授權碼有問題（不存在／已停用／已過期／尚未生效）',
  E30: '免費額度今日已用完',
  E31: '這支影片不在免費範圍內',
  E32: '請求太頻繁',
  E40: '今日翻譯成本已達上限（共用快取不受影響）',
  E41: '翻譯服務暫時不可用',
  E50: '金流參數驗證失敗',
  E51: '訂單不存在',
};

/**
 * 錯誤回應。
 *
 * code 是給使用者回報用的短代碼。訊息會隨文案調整而變，
 * 代碼不會——使用者截圖給我們時，代碼才是查得回來的東西。
 */
function err(message, status = 400, code) {
  return json(code ? { error: message, code } : { error: message }, status);
}

/** 與 userscript 的 normKey() 必須完全一致，否則兩邊算出的 key 不同 */
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bundleKey(cid) { return `bundle:${cid}`; }
// 註：曾經有 line:<cid>:<normKey> 的逐句快取，因為每句一次 KV put 會炸掉
// 免費額度（1,000/天）而移除。譯文現在一律存在 bundle:<cid> 裡。

async function readBundle(env, cid) {
  const raw = await env.SUBS.get(bundleKey(cid));
  if (!raw) return { v: 1, cid, updatedAt: null, segCount: 0, lines: {} };
  try {
    const b = JSON.parse(raw);
    if (typeof b.segCount !== 'number') b.segCount = 0;
    return b;
  } catch { return { v: 1, cid, updatedAt: null, segCount: 0, lines: {} }; }
}

/**
 * 標記「這支影片的字幕已經被完整收割過」。
 *
 * 用途：讓後續的觀看者跳過整軌預抓。沒有這個標記的話，每個人開啟同一支影片
 * 都會再向 CDN 抓一次全部分段（實測 383 段、約 80 秒），而那些分段幾乎不會
 * 帶來任何新句子——純粹的浪費，還會多累積一次 Imperva 的曝險。
 *
 * userscript 早就有這個判斷（`bundleSegCount === segs.length`），
 * 但它是靠 ADMIN_TOKEN 走 `POST /v1/subs` 寫進去的。擴充功能的使用者
 * 不該持有 ADMIN_TOKEN，所以獨立成這支只能寫 segCount 的端點。
 *
 * 防呆：只准往上加。這樣就算某個用戶端算錯或惡意回報，最壞也只是讓別人
 * 略過預抓、退回 worker 攔截（仍有提前量），不會弄壞既有譯文。
 */
async function handleComplete(request, env) {
  let body = null;
  try { body = await request.json(); } catch { return err('invalid json'); }
  const cid = String((body && body.cid) || '').trim();
  const segCount = Number(body && body.segCount) || 0;
  if (!cid) return err('缺少 cid');
  if (!(segCount > 0 && segCount < 100000)) return err('segCount 不合理');

  const bundle = await readBundle(env, cid);
  // 影片的網址後綴。**這是後台唯一能用來分辨「這是哪一場的哪個場次」的東西**——
  // 我們只存 contentId，那是一串數字，人看不出是澳洲正賽還是賽後訪問。
  // 用戶端本來就知道自己在哪一頁，順手帶上來即可。
  const slug = String((body && body.slug) || '').slice(0, 120);
  if (slug && !bundle.slug) bundle.slug = slug;

  const lineCount = Object.keys(bundle.lines || {}).length;
  // 沒有譯文就不該標記完整——否則別人會跳過預抓卻什麼也拿不到
  if (!lineCount) return json({ ok: false, reason: 'bundle 沒有譯文，不標記', segCount: bundle.segCount });
  if (bundle.segCount >= segCount) {
    return json({ ok: true, unchanged: true, segCount: bundle.segCount, lineCount });
  }

  bundle.segCount = segCount;
  await writeBundle(env, cid, bundle);
  return json({ ok: true, segCount, lineCount });
}

/**
 * 重讀 → 合併 → 寫回。**不要直接寫 handler 一開始讀到的那份。**
 *
 * 為什麼：`/v1/translate` 的流程是「讀 bundle → 呼叫模型（1~2 秒）→ 寫回」。
 * 用戶端同時最多有 3 個請求在飛，三個都讀到同一份舊快照，然後依序整份覆蓋——
 * 只有最後寫的那個活下來，前面的譯文全部消失。
 *
 * 實測：一輪翻了 363 句，後端只多了 148 句（41%），與 3 個並行請求的預期吻合。
 * **完全不會報錯**——每個請求自己都成功，使用者也拿得到譯文，
 * 只有下一個觀看者要重新付費。
 *
 * KV 沒有 CAS，所以做不到完全無損；但把競爭視窗從「模型呼叫的 1~2 秒」縮到
 * 「讀+寫的幾十毫秒」，已經是數量級的差別。（handoff 坑 #24）
 */
async function mergeWrite(env, cid, added) {
  const keys = Object.keys(added || {});
  if (!keys.length) return;
  const fresh = await readBundle(env, cid);
  for (const k of keys) {
    // 上限也要在這裡擋。原本只有 handlePostSubs 檢查，
    // 但擴充功能上線後絕大多數寫入都走這條路。
    if (Object.keys(fresh.lines).length >= BUNDLE_MAX_LINES) break;
    if (!fresh.lines[k]) fresh.lines[k] = added[k];   // 只補、不覆蓋別人的
  }
  await writeBundle(env, cid, fresh);
}

async function writeBundle(env, cid, bundle) {
  bundle.updatedAt = new Date().toISOString();
  // ⚠️ **一定要同時寫 KV metadata。**
  //
  // 後台要列出「哪些影片翻好了、各有幾句」，而 `list()` 只回傳鍵名——
  // 沒有 metadata 的話，要知道句數就得把每一份 bundle 都讀出來，
  // 一份兩千句約 200KB，一百支就是 20MB 的讀取，一次列表就會逾時。
  //
  // metadata 有 1KB 上限，所以只放摘要，不放內容。
  await env.SUBS.put(bundleKey(cid), JSON.stringify(bundle), {
    metadata: {
      n: Object.keys(bundle.lines || {}).length,
      seg: bundle.segCount || 0,
      at: bundle.updatedAt,
      slug: String(bundle.slug || '').slice(0, 120),
    },
  });
}

/**
 * 粗略的每 IP 速率限制。
 * KV 是最終一致性，所以本來就是近似值 —— 目的是擋住失控迴圈，不是精算配額。
 *
 * ⚠️ 每次請求都寫一次 KV 會吃掉免費額度（1,000 puts/天）。
 * 改成取樣：平均每 SAMPLE 次才寫一次，寫入時直接加 SAMPLE 補回來。
 * 精度變差但門檻仍然守得住，而寫入量降為 1/SAMPLE。
 */
const RL_SAMPLE = 10;

/**
 * 速率限制。
 *
 * 鍵從 IP 換成 installId（SECURITY.md S8）：IP 換個 proxy 就繞過，
 * 而 installId 要繞過就得不斷重新註冊——而註冊本身另有 IP 限制。
 *
 * 仍然用取樣寫入（每 10 次才寫一次 KV），因為每次都寫必定撞爆
 * 1,000 puts/天 的額度。取樣讓限制變成近似值，但配合成本熔斷已經足夠。
 */
async function rateLimited(env, ip) {
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = parseInt((await env.SUBS.get(key)) || '0', 10);
  if (n >= RATE_LIMIT_PER_MIN) return true;
  if (Math.random() < 1 / RL_SAMPLE) {
    await env.SUBS.put(key, String(n + RL_SAMPLE), { expirationTtl: 120 });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anthropic 批次翻譯
// ---------------------------------------------------------------------------
/**
 * 呼叫模型。逐句與批次共用同一份 system，才能共用同一份 prompt cache。
 */
async function callModel(env, userContent, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // 一定要先看 stop_reason 再讀 content
  if (data.stop_reason === 'refusal') throw new Error('model refusal');
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text, usage: data.usage || {} };
}

/**
 * ⚠️ 只有一句時**不要走批次編號協定**（userscript 坑 #9）。
 *
 * prompt 內部有衝突：【輸出規則】說「只輸出譯文本身」，【批次模式】說「每行加編號」。
 * 句數多時模型照批次規則走；**只有一句時它會照輸出規則直接給譯文、不加編號**，
 * 於是解析端一個都對不上，整批作廢。
 *
 * 實測就是這樣：單句批次回覆率只有 50%（送 2 句回 1 句），而且完全不報錯——
 * 沒對上的那句只是「沒有譯文」，下次再翻一遍，白花一次錢。
 */
async function translateOne(env, line) {
  const r = await callModel(env, line, 200);
  return { out: r.text ? { [line]: r.text } : {}, usage: r.usage };
}

async function translateBatch(env, lines) {
  if (lines.length === 1) return translateOne(env, lines[0]);

  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const r = await callModel(env, `【批次翻譯】共 ${lines.length} 句\n${numbered}`, 2500);
  const text = r.text;
  const data = { usage: r.usage };

  const map = {};
  text.split('\n').forEach((ln) => {
    const m = ln.match(/^\s*(\d+)\s*[.、:：)]\s*(.*)$/);
    if (m) map[parseInt(m[1], 10)] = m[2].trim();
  });

  const out = {};
  lines.forEach((l, i) => {
    const zh = map[i + 1];
    if (zh) out[l] = zh;
  });

  // 備援：一個編號都沒對上，但回應行數剛好等於輸入行數 → 按位置對應。
  // 模型偶爾會整批漏掉編號，這時位置資訊仍然可信，不該整批丟掉重翻。
  if (!Object.keys(out).length) {
    const rows = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (rows.length === lines.length) {
      lines.forEach((l, i) => {
        const zh = rows[i].replace(/^\s*\d+\s*[.、:：)]\s*/, '').trim();
        if (zh) out[l] = zh;
      });
    }
  }
  return { out, usage: data.usage || {} };
}

// ---------------------------------------------------------------------------
// 路由處理
// ---------------------------------------------------------------------------
async function handleGetSubs(request, env, url) {
  const cid = url.searchParams.get('cid');
  if (!cid || !/^\d{1,20}$/.test(cid)) return err('缺少或格式錯誤的 cid');
  const bundle = await readBundle(env, cid);
  return json({
    cid,
    count: Object.keys(bundle.lines).length,
    // segCount > 0 代表曾經有人「完整無失敗」地收割過這支影片。
    // 用戶端拿它和字幕清單的分段數比對，相同就可以完全跳過整軌預抓。
    segCount: bundle.segCount || 0,
    updatedAt: bundle.updatedAt,
    lines: bundle.lines,
    // ⚠️ 絕對不要在這裡放 max-age。
    //
    // 原本是 `public, max-age=60`。v1.2 那時 bundle 只有管理員會寫，一分鐘的
    // 陳舊無所謂。現在每個使用者的 /v1/translate 與 /v1/complete 都會改它，
    // 而瀏覽器的 HTTP 快取是**我們清不掉的一層**——用戶端把自己的記憶體快取
    // 作廢也沒用，fetch 仍然回舊的 body。
    //
    // 實測：01:03:06 查核（存進 HTTP 快取，segCount=0）→ 01:03:11 標記完整
    // → 01:03:48 重開，42 秒還在快取內，於是拿到 segCount=0，跳過判斷永遠
    // 不成立，整支又重抓 383 段。（handoff 坑 #26）
    //
    // 重複請求由用戶端 SW 的 90 秒記憶體快取吸收，這層不需要也不該再快取。
  }, 200, { 'cache-control': 'no-store' });
}

async function handlePostSubs(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const { cid, lines, segCount } = body;
  if (!cid || !/^\d{1,20}$/.test(String(cid))) return err('缺少或格式錯誤的 cid');
  if (!lines || typeof lines !== 'object') return err('缺少 lines');

  const bundle = await readBundle(env, String(cid));
  // 只有「完整無失敗」的收割才會帶 segCount 上來，代表這份 bundle 已涵蓋整支影片
  if (typeof segCount === 'number' && segCount > (bundle.segCount || 0)) {
    bundle.segCount = segCount;
  }
  // 網址後綴：後台的翻譯清單靠它分辨這是哪一場的哪個場次。
  // 只在還沒有的時候寫入——先到先得，避免不同來源互相覆蓋。
  const slug = String(body.slug || '').slice(0, 120);
  if (slug && !bundle.slug) bundle.slug = slug;
  let added = 0;
  for (const [rawKey, zh] of Object.entries(lines)) {
    if (typeof zh !== 'string' || !zh) continue;
    const k = normKey(rawKey);
    if (!k) continue;
    if (bundle.lines[k] === zh) continue;
    if (Object.keys(bundle.lines).length >= BUNDLE_MAX_LINES) break;
    bundle.lines[k] = zh;
    added++;
  }
  await writeBundle(env, String(cid), bundle);
  return json({
    ok: true, cid: String(cid), added,
    total: Object.keys(bundle.lines).length,
    segCount: bundle.segCount || 0,
  });
}

/**
 * 翻譯未命中的句子。
 *
 * ⚠️ 這裡的 KV 寫入次數是整個系統最容易爆掉的地方。
 * 初版是「每翻一句寫一個 line: key」，實測一場 550 句就寫了 550 次——
 * 免費額度只有 1,000 puts/天，一場正賽（約 2,000 句）光一個觀看者就超額兩倍，
 * 之後所有寫入回 429，表現為用戶端連續拿到 HTTP 500。
 *
 * 改成「讀一次 bundle、寫一次 bundle」：一次請求固定 1 put，
 * 一場正賽約 140 puts。
 *
 * 併發時的 read-modify-write 可能掉幾句（多人同時看同一支全新內容），
 * 但那只是那幾句之後會被重翻一次，不影響正確性。
 */
/**
 * 認領一句話的翻譯權。回傳 true 代表「這句由我翻」。
 *
 * 為什麼用 Cache API 不用 KV：見 `handleTranslate` 裡的說明（KV 寫入額度）。
 *
 * ⚠️ **失敗一律回 true（放行）。** 這是刻意的：去重是省錢的優化，
 *    不是正確性的要件。Cache API 不可用時最壞就是回到現在的行為（重複翻），
 *    而如果寫成「失敗就不翻」，一個機房的 cache 出問題就會讓那裡的
 *    所有使用者完全沒有字幕——用省錢的機制製造出功能性故障是不能接受的。
 */
const CLAIM_TTL_SEC = 25;

/**
 * ─────────────────────────────────────────────────────────────────
 *  Durable Object：每支影片一個實例，負責「誰去翻哪幾句」
 * ─────────────────────────────────────────────────────────────────
 *
 * **為什麼非它不可**：`claimLine`（Cache API 版）是 check-then-act，
 * 而 Cache API 與 KV **都沒有 CAS**——10 個請求同時抵達時，
 * 全部會先 `match` 到空的，才依序 `put`，去重完全失效。
 * `tools/check-live-concurrency.js` 實測：10 個並發 → 10 次模型呼叫。
 *
 * DO 的特性正好對症：**同一個 id 的所有請求都排到同一個單執行緒實例**，
 * 所以「檢查再認領」在這裡是原子操作，不需要任何鎖。
 *
 * ⚠️ **這裡只做協調，絕不做翻譯。**
 *    DO 是單執行緒且**運算時間要計費**。把 Anthropic 的呼叫放進來的話：
 *      1. 第 2 個人要等第 1 個人的 API 來回（1~3 秒）才輪得到
 *      2. 那 1~3 秒的等待會被計入 GB-秒
 *    進出必須在毫秒級。
 *
 * ⚠️ 認領記錄**刻意只放記憶體**，不寫 `state.storage`。
 *    它的壽命只有 25 秒，寫進儲存等於為了一個短暫的旗標付儲存費與 IO。
 *    實例被回收時記錄跟著消失——那時最壞的後果是重複翻一次，可以接受。
 */
export class SubtitleRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.claims = new Map();          // normKey -> 到期時間（毫秒）
  }

  async fetch(request) {
    let body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    const keys = Array.isArray(body && body.keys) ? body.keys : [];
    const ttlMs = Math.min(120000, Math.max(1000, Number(body && body.ttlMs) || CLAIM_TTL_SEC * 1000));
    const now = Date.now();

    const mine = [];
    for (const k of keys) {
      if (typeof k !== 'string' || !k) continue;
      const exp = this.claims.get(k);
      if (exp && exp > now) continue;   // 別人正在翻，而且還沒逾時
      this.claims.set(k, now + ttlMs);
      mine.push(k);
    }

    // 清掉過期的。**要有上界**——直播兩小時的句數上千，
    // 不清的話這個 Map 會一直長大，而 DO 的記憶體是計費資源。
    if (this.claims.size > 4000) {
      for (const [k, v] of this.claims) if (v <= now) this.claims.delete(k);
    }

    return new Response(JSON.stringify({ mine, held: this.claims.size }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}

/**
 * 向 DO 認領一批句子。回傳「這次該由我翻的」那些。
 *
 * ⚠️ **DO 不可用時一律退回舊路徑**（Cache API），不是直接放行也不是直接擋。
 *    DO 是新的單點：第一次上線就全部依賴它是不必要的風險。
 *    退回舊路徑最壞只是回到「去重不保證」，服務本身不受影響。
 *
 * `locationHint: 'apac'` 是刻意指定的：DO 實例的位置在第一次建立時決定，
 * 不指定的話可能建在美國，台灣使用者每次認領都多一趟跨太平洋往返（約 150ms）。
 * 直播的即時性吃不起那個延遲。
 */
async function claimViaDO(env, cid, keys) {
  if (!env.ROOM || !keys.length) return null;
  try {
    const id = env.ROOM.idFromName(String(cid || 'misc'));
    const stub = env.ROOM.get(id, { locationHint: 'apac' });
    const res = await stub.fetch('https://room.pitlingo.internal/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys, ttlMs: CLAIM_TTL_SEC * 1000 }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d && d.mine) ? d.mine : null;
  } catch (e) {
    return null;                      // 退回 Cache API 版
  }
}

async function claimLine(cid, key) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return true;
    // 用一個合法但不會與真實路由相撞的網址當 cache key
    const url = `https://claim.pitlingo.internal/${encodeURIComponent(cid)}/${encodeURIComponent(key)}`;
    const hit = await caches.default.match(url);
    if (hit) return false;                       // 別人正在翻
    await caches.default.put(url, new Response('1', {
      headers: { 'cache-control': `max-age=${CLAIM_TTL_SEC}` },
    }));
    return true;
  } catch (e) {
    return true;                                 // 任何差錯都放行，見上面的說明
  }
}

async function handleTranslate(request, env, ip, auth) {
  if (await rateLimited(env, auth.installId === 'legacy' ? ip : auth.installId)) {
    return err('請求太頻繁，請稍後再試', 429, 'E32');
  }

  // 成本熔斷：超過當日上限就停掉會花錢的路徑。
  // **共用快取的讀取不受影響**——已翻好的影片完全照常，
  // 退化的只是「新影片暫時不翻」，不是整個壞掉。
  if (await overBudget(env)) {
    return json({
      lines: {}, translated: 0,
      error: '今日翻譯額度已用盡，已翻譯過的影片仍可正常觀看',
      overBudget: true,
      code: 'E40',
    }, 503);
  }

  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON', 400, 'E10');
  const cid = String(body.cid || 'misc');
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (!input.length) return err('缺少 lines', 400, 'E11');

  // ⚠️ 授權閘門。用戶端的檢查只是 UI，**這裡才是真正的牆**。
  const gate = await checkEntitlement(env, auth, request, input.length);
  if (!gate.allowed) {
    return json({
      lines: {}, translated: 0,
      error: gate.reason === 'revoked'
        ? '這組授權已停用。如有疑問請聯絡客服。'
        : '免費額度今日已用完。已翻譯過的影片仍可正常觀看，或購買 Season 解除限制。',
      reason: gate.reason,
      plan: gate.plan,
      code: gate.reason === 'revoked' ? 'E21' : 'E30',
    }, 402);
  }
  if (input.length > 200) return err('一次最多 200 句', 400, 'E12');

  // 每句的長度上限。沒有這個限制的話，200 句 × 每句 100KB = 20MB 進模型，
  // 一次請求就能燒掉大量 token —— **成本放大攻擊**。
  // 真實字幕一句不會超過 300 字元，1,000 已經非常寬鬆。
  //
  // ⚠️ **只丟掉超長的那幾句，不要整批退回。**
  //    舊版是整批 400。防成本放大的效果一模一樣（超長的那句同樣沒進模型），
  //    但代價完全不同：F1TV 偶爾會把整段節目介紹塞進字幕容器，
  //    那一句就會讓**同批 199 句正常字幕一起被拒**，
  //    使用者看到的是「不可超過 1000 字元」然後整段沒有字幕——
  //    一個與他無關、也無從處理的錯誤訊息。
  const MAX_LINE_LEN = 1000;
  const tooLong = input.filter((l) => typeof l === 'string' && l.length > MAX_LINE_LEN).length;
  const lines2 = tooLong
    ? input.filter((l) => !(typeof l === 'string' && l.length > MAX_LINE_LEN))
    : input;
  // 整批都是超長的才算真的有問題（那不像字幕，像是有人在灌資料）
  if (!lines2.length) {
    return err(`整批字幕都超過 ${MAX_LINE_LEN} 字元，已全數略過`, 400, 'E13');
  }

  // 1) 讀一次 bundle 當快取（取代先前逐句讀 line: key）
  const bundle = await readBundle(env, cid);

  // 免費使用者只能翻**免費場次**的影片。見 isFreeSlug 的說明。
  // 已付費的（gate.reason === 'licensed'）與收割工具（legacy）不受這條限制。
  if (gate.reason === 'free') {
    const known = isFreeSlug(bundle.slug || body.slug);
    if (known === false) {
      return json({
        lines: {}, translated: 0,
        error: '這支影片不在免費範圍內。免費試看涵蓋練習賽、排位賽、衝刺賽與正賽的前 15 分鐘。',
        reason: 'not_free_session',
        code: 'E31',
        plan: 'trial',
      }, 402);
    }
  }
  // 順手把 slug 記下來，下一次就有可信的來源了（先到先得，不覆蓋）
  if (!bundle.slug && body.slug) bundle.slug = String(body.slug).slice(0, 120);
  const result = {};
  const added = {};       // 這次請求新翻出來的，寫回時只合併這些
  const missing = [];
  for (const raw of lines2) {
    const en = String(raw || '').trim();
    if (!en) continue;
    const k = normKey(en);
    if (!k) continue;
    if (bundle.lines[k]) { result[k] = bundle.lines[k]; continue; }
    missing.push({ en, k });
  }

  // 1.5) **直播的並發去重。**
  //
  // 直播時所有觀眾在同一秒看到同一批新的 VTT 分段，於是同時發現快取沒有、
  // 同時送同一批句子來翻。10 個人在線就是 **10 倍的錢翻同樣的內容**，
  // 而且 10 份寫回同一個 bundle（KV 沒有 CAS，還會互相覆蓋）。
  //
  // 用 **Cache API 當認領記號**，不用 KV：
  //   · KV 寫入是免費方案的天花板（1,000/天，坑 #19），不能為了去重再加寫入
  //   · Cache API 不計入 KV 額度，而且**是 per-colo 的**——這正好符合需求，
  //     同一場直播的觀眾多半連到同一個機房，去重就發生在他們之間
  //   · 認領失敗不是錯誤：讓路的人直接拿 bundle 裡現有的，
  //     幾秒後下一批請求就會看到別人翻好的結果
  //
  // TTL 只有 25 秒：認領者如果斷線或超時，最多卡住別人 25 秒，之後自動重試。
  // 寧可偶爾重複翻一次，也不要因為一個人網路慢就讓所有人都拿不到字幕。
  // ⚠️ **「現在就要用」的句子絕對不讓路。**
  //
  // 這是使用者指出的漏洞，而且他是對的：讓路的人要等別人翻完再從快取讀，
  // 而直播字幕每 3~4 秒換一句——如果那句是「現在螢幕上這一句」，
  // 等回來的時候畫面早就換過了，等於**那句對他就是沒有顯示**。
  //
  // 但不是所有句子都這麼急。兩條路徑的時間預算差了兩個數量級：
  //
  //   前瞻預譯（`ingestVtt`）  播放器提前下載的分段 → **幾十秒後**才會顯示
  //   DOM 逐句（`handleCaption`）  已經在螢幕上了 → **現在**就要
  //
  // 所以只有前瞻那條路讓步。用戶端會用 `urgent` 標出來，
  // 而**預設是急件**——沒標的一律不讓路，漏標的後果是多花錢，
  // 標錯方向的後果是使用者看不到字幕，兩者嚴重程度差很多。
  const urgent = body.urgent !== false;
  if (missing.length && !urgent) {
    // 先試 Durable Object（單執行緒，認領是原子的）。
    // 拿不到就退回 Cache API 版——去重不保證，但服務不受影響。
    const viaDO = await claimViaDO(env, cid, missing.map((m) => m.k));
    let keep;
    if (viaDO) {
      const ok = new Set(viaDO);
      keep = missing.filter((m) => ok.has(m.k));
    } else {
      keep = [];
      for (const m of missing) {
        if (await claimLine(cid, m.k)) keep.push(m);
      }
    }
    // 全部都被別人認領了 → 這次不翻，讓使用者拿現有的。
    // 用戶端會改去讀 bundle（一次 KV 讀取），不是重送翻譯請求。
    if (!keep.length) {
      return json({ lines: result, translated: 0, pendingElsewhere: missing.length, retryAfterMs: 1200 });
    }
    missing.length = 0;
    missing.push(...keep);
  }

  // 2) 未命中的才呼叫模型。
  //    免費層可能只允許一部分——**先翻的是排在前面的**，也就是使用者
  //    正在看的那一段，不是隨機丟掉。
  if (missing.length > gate.allowed) missing.length = gate.allowed;
  let translated = 0;
  let rejected = 0;                   // 通過模型但沒通過合理性檢查、不寫入快取的數量
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  for (let i = 0; i < missing.length; i += BATCH_MAX) {
    const chunk = missing.slice(i, i + BATCH_MAX);
    try {
      const { out, usage } = await translateBatch(env, chunk.map((m) => m.en));
      for (const m of chunk) {
        const zh = out[m.en];
        if (!zh) continue;
        result[m.k] = zh;             // 請求者拿得到（他自己愛看什麼是他的事）
        translated++;
        // 但**不合理的譯文不進共用快取**（S9）。攻擊者能用 prompt injection
        // 讓輸出受控，再寫進他指定的 cid 汙染所有後續觀看者。
        if (!plausibleTranslation(m.en, zh)) { rejected++; continue; }
        bundle.lines[m.k] = zh;
        added[m.k] = zh;
      }
      usageTotals.input_tokens += usage.input_tokens || 0;
      usageTotals.output_tokens += usage.output_tokens || 0;
      usageTotals.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    } catch (e) {
      // 已經翻好的先存起來，不要因為後面失敗就整批丟掉
      if (translated) { try { await mergeWrite(env, cid, added); } catch (e2) { /* noop */ } }
      return json({ lines: result, translated, error: String(e.message || e) }, 502);
    }
  }

  // 3) 一次請求只寫一次 KV，而且是「重讀後合併」不是直接覆蓋
  if (Object.keys(added).length) await mergeWrite(env, cid, added);

  recordUsage(cid, usageTotals, translated, input.length - missing.length);
  // 每位使用者一份。直播時要回答的是「誰在燒錢」，那用 cid 分組看不出來。
  recordUserUsage(auth.installId, gate.plan, usageTotals, translated, input.length - missing.length);
  if (gate.reason === 'free' && translated) {
    try { await noteFreeUsage(env, auth.installId, translated); } catch (e) { /* 統計不擋主流程 */ }
  }
  if (shouldFlush()) { try { await flushStats(env); } catch (e) { /* 統計不該影響主流程 */ } }

  return json({
    cid,
    lines: result,
    requested: input.length,
    cached: input.length - missing.length,
    translated,
    rejected,
    usage: usageTotals,
  });
}

/**
 * 成本後台。回答四個問題：
 *   今天花了多少？哪支影片最貴？prompt 快取還有沒有生效？共用快取的命中率？
 *
 * 第三個特別重要：prompt cache 命中率掉下來，代表 SYSTEM_PROMPT 又低於
 * 4,096 tokens 了（坑 #21），那是**每次全額計費卻不報錯**的狀態。
 */
async function handleStats(env, url) {
  const days = Math.min(31, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
  const out = [];
  let total = { usd: 0, calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = statsKey(d);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { /* noop */ }
    const vids = Object.entries(day).map(([cid, r]) => ({
      cid,
      usd: +costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      }).toFixed(4),
      calls: r.calls, translated: r.translated, cached: r.cached,
    })).sort((a, b) => b.usd - a.usd);

    const dayUsd = vids.reduce((a, v) => a + v.usd, 0);
    for (const r of Object.values(day)) {
      total.calls += r.calls; total.translated += r.translated; total.cached += r.cached;
      total.in += r.in; total.out += r.out; total.cacheRead += r.cacheRead; total.cacheWrite += r.cacheWrite;
    }
    total.usd += dayUsd;
    out.push({ date: key.slice(6), usd: +dayUsd.toFixed(4), videos: vids.slice(0, 10) });
  }

  const promptIn = total.in + total.cacheRead;
  return json({
    days,
    total: {
      usd: +total.usd.toFixed(4),
      calls: total.calls,
      translated: total.translated,
      sharedCacheHits: total.cached,
      // 共用快取命中率 = 整個商業模式的分母
      sharedHitRate: (total.cached + total.translated)
        ? +(total.cached / (total.cached + total.translated)).toFixed(4) : null,
      // prompt 快取命中率：掉下來就是坑 #21 復發
      promptCacheHitRate: promptIn ? +(total.cacheRead / promptIn).toFixed(4) : null,
      usdPerTranslatedLine: total.translated ? +(total.usd / total.translated).toFixed(6) : null,
    },
    budget: {
      dailyCapUsd: Number(env.DAILY_USD_CAP || DAILY_USD_CAP_DEFAULT),
      todayUsd: +(out[0] ? out[0].usd : 0).toFixed(4),
    },
    daily: out,
  });
}



// ---------------------------------------------------------------------------
// 訂單記錄
// ---------------------------------------------------------------------------
/**
 * 為什麼要獨立存一份訂單，而不是靠授權碼記錄？
 *
 * 因為**授權碼只在付款成功後才存在**。付款失敗、取號了沒去繳、
 * 使用者按到一半跑掉——這些在系統裡完全不留痕跡，
 * 於是後台看到的永遠只有「成功的那些」，而真正需要人去看的正是失敗的那些。
 *
 * 狀態機（只會往前，不會倒退）：
 *   created  → 已建立訂單，導向綠界了
 *   awaiting → ATM／超商已取號，等繳費
 *   paid     → 綠界的伺服器對伺服器通知確認收款，授權碼已發
 *   failed   → 綠界回報付款失敗
 *
 * ⚠️ **paid 是終點，任何東西都不准把它改回去。** 導回頁是使用者的瀏覽器送的，
 *    可以偽造；若允許它覆寫，別人就能把已付款的訂單標成失敗。
 */
const ORDER_TTL = 400 * 86400;
const ORDER_RANK = { created: 0, awaiting: 1, failed: 2, paid: 3 };

function ordKey(no) { return `ord:${no}`; }

/**
 * 訂單的 metadata。後台列表**只讀 metadata、不逐筆 get**——
 * 一次 list 就把整張表撈回來，KV 操作數與訂單數無關。
 * KV 對 metadata 有 1024 bytes 上限，所以欄位名用單字母、字串都截短。
 */
function ordMeta(o) {
  return {
    s: o.status,
    at: o.at || 0,
    t: Number(o.price) || 0,
    e: String(o.email || '').slice(0, 60),
    l: String(o.summary || '').slice(0, 80),
    n: (o.services || []).some((x) => x && x.status !== 'done') ? 1 : 0,
    m: o.mailed ? 1 : 0,
  };
}

async function readOrder(env, no) {
  try { return JSON.parse((await env.SUBS.get(ordKey(no))) || 'null'); } catch (e) { return null; }
}

/**
 * 更新訂單。
 * ⚠️ 讀→改→寫在 KV 上沒有 CAS（坑 #24），但訂單是**單一訂單編號**的線性流程，
 *    競爭只會發生在「導回頁」與「webhook」同時到達時——
 *    用 ORDER_RANK 擋住降級就足夠：兩邊都寫，贏的一定是狀態較後面的那個。
 */
async function patchOrder(env, no, fields) {
  if (!env.SUBS || !no) return null;
  const o = (await readOrder(env, no)) || { no, at: nowSec(), status: 'created' };
  const f = Object.assign({}, fields);
  if (f.status && ORDER_RANK[f.status] < ORDER_RANK[o.status || 'created']) delete f.status;
  Object.assign(o, f, { updatedAt: nowSec() });
  await env.SUBS.put(ordKey(no), JSON.stringify(o), {
    expirationTtl: ORDER_TTL, metadata: ordMeta(o),
  });
  return o;
}

/**
 * 帳號鍵。
 *
 * ⚠️ **這是日後導入帳號系統時唯一的接點，現在就必須釘死。**
 *
 * 目前沒有帳號、沒有密碼，使用者的身分就是**購買時填的 email**。
 * 那沒問題——授權碼本來就是綁人不綁機器。但要能無痛長成
 *
 *     Account
 *       ├── Purchases     ord:<訂單編號>     （已經有了）
 *       ├── Licenses      lic:<授權碼>       （已經有了）
 *       └── Entitlements  簽出去的通行證      （已經有了）
 *
 * 唯一的前提是：**每一筆訂單與每一組授權碼都必須帶著同一個正規化過的 email。**
 * 少一筆就是一筆日後接不回帳號的孤兒資料，而且不會報錯——
 * 只會在某個人登入後發現「我買的東西不見了」。
 *
 * 正規化規則刻意保守：只做 trim + 小寫。
 * **不做 Gmail 的點號與 +tag 摺疊**——那會把兩個在法律上不同的
 * 收件人視為同一個人，退款與爭議時說不清楚。
 */
function accountKey(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * 管理端：一個帳號（email）底下的全部東西。
 *
 * 這同時是**客服最常需要的那一頁**（「這個人寄信來，他買了什麼？」）
 * 與**帳號系統的預演**：日後真的做登入時，這支的回傳內容就是
 * 使用者登入後看到的畫面，不需要改資料結構。
 */
async function handleAccount(env, url) {
  const acct = accountKey(url.searchParams.get('email'));
  if (!acct || !acct.includes('@')) return err('請提供 email', 400, 'E10');

  // Licenses：走既有的 email 索引
  let keys = [];
  try { keys = JSON.parse((await env.SUBS.get(`licmail:${acct}`)) || '[]'); } catch (e) { keys = []; }
  const licenses = [];
  for (const k of keys.slice(0, 50)) {
    const lic = await readLicense(env, normLicense(k));
    if (!lic) continue;
    const expired = !!(lic.expiresAt && lic.expiresAt * 1000 < Date.now());
    licenses.push({
      licenseKey: prettyLicense(normLicense(k)),
      plan: lic.plan,
      planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
      state: lic.revoked ? 'revoked' : expired ? 'expired' : 'active',
      expiresAt: lic.expiresAt || null,
      devices: (lic.devices || []).length,
      orderId: lic.orderId || '',
      paid: lic.paid || 0,
      // 代訂送的那一週要標出來——它與使用者自己買的意義完全不同
      fromService: !!(PLANS[lic.plan] && PLANS[lic.plan].fromService),
    });
  }

  // Purchases：掃訂單的 metadata（不逐筆 get）
  const purchases = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await env.SUBS.list({ prefix: 'ord:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      if (accountKey(m.e) !== acct) continue;
      purchases.push({
        no: k.name.slice(4), status: m.s || 'created', at: m.at || 0,
        price: m.t || 0, summary: m.l || '', mailed: !!m.m, manual: !!m.n,
      });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  purchases.sort((a, b) => (b.at || 0) - (a.at || 0));

  const paid = purchases.filter((p) => p.status === 'paid');
  return json({
    ok: true,
    account: acct,
    licenses,
    purchases,
    summary: {
      licenses: licenses.length,
      active: licenses.filter((l) => l.state === 'active').length,
      orders: purchases.length,
      paidOrders: paid.length,
      lifetimeTwd: paid.reduce((n, p) => n + (p.price || 0), 0),
      // 孤兒偵測：有授權碼卻找不到對應的訂單，日後接帳號時會接不上
      orphanLicenses: licenses.filter((l) => l.orderId
        && !purchases.some((p) => p.no === l.orderId)).length,
    },
  });
}

/**
 * 管理端：單位經濟。
 *
 * ⚠️ **量得到的與估出來的必須分開標示。**
 *
 *    量得到：成本（token 實際用量 × 單價）、營收（已付款訂單）、
 *            使用者數、翻譯句數、快取命中率。
 *    估出來：匯率、行銷花費、續訂季數——這三個系統裡沒有資料，只能由你填。
 *
 *    把兩者混在一起呈現，會讓一個「我猜的續訂率」看起來像實測的 LTV，
 *    然後那個數字被拿去決定廣告預算。所以回傳裡 assumptions 是獨立欄位，
 *    後台也必須把它標成估算。
 */
async function handleEcon(env, url) {
  const days = Math.max(1, Math.min(120, Number(url.searchParams.get('days')) || 30));
  const ops = await opsConfig(env);
  const fx = ops.fxTwdPerUsd;

  // ---- 成本（實測）----
  let usd = 0;
  let translated = 0;
  let cachedHits = 0;
  const perVideo = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(statsKey(d))) || '{}'); } catch (e) { day = {}; }
    for (const [cid, r] of Object.entries(day)) {
      const c = costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      });
      usd += c;
      translated += r.translated || 0;
      cachedHits += r.cached || 0;
      perVideo[cid] = (perVideo[cid] || 0) + c;
    }
  }

  // ---- 使用者（實測）----
  let users = 0;
  let paidUsers = 0;
  let freeUsers = 0;
  let usdPaid = 0;
  let usdFree = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(ustatsKey(d))) || '{}'); } catch (e) { day = {}; }
    for (const [id, r] of Object.entries(day)) {
      if (id === '__others') continue;
      users++;
      const c = costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      });
      if (r.plan && r.plan !== 'trial') { paidUsers++; usdPaid += c; } else { freeUsers++; usdFree += c; }
    }
  }
  // ⚠️ 跨日會重複計算同一個安裝（我們刻意不做跨日去重——那需要保存
  //    每個 installId 的全部歷史，成本與隱私都不划算）。
  //    所以這裡是**人日**，不是「不重複人數」。名字要誠實。
  const userDays = users;

  // ---- 營收（實測，來自訂單）----
  let revenueTwd = 0;
  let orders = 0;
  let cursor;
  const since = nowSec() - days * 86400;
  for (let page = 0; page < 5; page++) {
    const r = await env.SUBS.list({ prefix: 'ord:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      if (m.s !== 'paid' || (m.at || 0) < since) continue;
      revenueTwd += Number(m.t) || 0;
      orders++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }

  const costTwd = usd * fx;
  const grossTwd = revenueTwd - costTwd;
  const arpu = orders ? revenueTwd / orders : null;

  return json({
    ok: true,
    days,
    measured: {
      costUsd: +usd.toFixed(4),
      costTwd: +costTwd.toFixed(1),
      revenueTwd,
      orders,
      grossTwd: +grossTwd.toFixed(1),
      grossMargin: revenueTwd ? +(grossTwd / revenueTwd).toFixed(4) : null,
      translated,
      cachedHits,
      cacheHitRate: (translated + cachedHits) ? +(cachedHits / (translated + cachedHits)).toFixed(4) : null,
      // 題目要的那幾個「每 X 成本」
      usdPerTranslation: translated ? +(usd / translated).toFixed(6) : null,
      usdPerCacheMiss: translated ? +(usd / translated).toFixed(6) : null,
      usdPerRace: Object.keys(perVideo).length
        ? +(usd / Object.keys(perVideo).length).toFixed(4) : null,
      videos: Object.keys(perVideo).length,
      userDays,
      paidUserDays: paidUsers,
      freeUserDays: freeUsers,
      usdPerActiveUserDay: userDays ? +(usd / userDays).toFixed(6) : null,
      usdPerPaidUserDay: paidUsers ? +(usdPaid / paidUsers).toFixed(6) : null,
      usdPerTrialUserDay: freeUsers ? +(usdFree / freeUsers).toFixed(6) : null,
      arpuTwd: arpu == null ? null : +arpu.toFixed(1),
    },
    // ⚠️ 以下三個是**你填的估算值**，不是量出來的
    assumptions: {
      fxTwdPerUsd: fx,
      marketingTwd: ops.marketingTwd,
      ltvSeasons: ops.ltvSeasons,
    },
    estimated: {
      // CAC：行銷花費 ÷ 這段期間的付費訂單數
      cacTwd: orders ? +(ops.marketingTwd / orders).toFixed(1) : null,
      // LTV：平均客單價 × 預期續訂季數 − 服務該客戶的成本
      ltvTwd: arpu == null ? null
        : +((arpu * ops.ltvSeasons) - (paidUsers ? (usdPaid / paidUsers) * fx : 0)).toFixed(1),
      ltvCac: (orders && ops.marketingTwd > 0 && arpu != null)
        ? +(((arpu * ops.ltvSeasons) - (paidUsers ? (usdPaid / paidUsers) * fx : 0))
            / (ops.marketingTwd / orders)).toFixed(2)
        : null,
    },
  });
}

/**
 * 管理端：每位使用者花了多少。
 *
 * 直播測試要回答的問題就是這一個——「有沒有人在燒錢」「付費者的平均成本」。
 * 用影片分組看不出來：一支熱門影片的成本可能來自 1 個人也可能來自 100 個人，
 * 那兩件事的意義完全相反。
 */
async function handleUserStats(env, url) {
  const days = Math.max(1, Math.min(31, Number(url.searchParams.get('days')) || 1));
  const merged = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(ustatsKey(d))) || '{}'); } catch (e) { day = {}; }
    for (const [id, r] of Object.entries(day)) {
      const t = merged[id] || (merged[id] = {
        calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
      });
      for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
        t[k] = (t[k] || 0) + (r[k] || 0);
      }
      t.plan = r.plan || t.plan;
      t.last = Math.max(t.last || 0, r.last || 0);
    }
  }

  const rows = Object.entries(merged).map(([id, r]) => ({
    installId: id,
    plan: r.plan || 'trial',
    calls: r.calls,
    translated: r.translated,
    cached: r.cached,
    // 共用快取命中率：這是整個商業模式的分母
    hitRate: (r.translated + r.cached) ? r.cached / (r.translated + r.cached) : null,
    usd: +costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    }).toFixed(6),
    lastAt: r.last || null,
  })).sort((a, b) => b.usd - a.usd);

  const paid = rows.filter((r) => r.plan && r.plan !== 'trial');
  const free = rows.filter((r) => !r.plan || r.plan === 'trial');
  const sum = (a) => a.reduce((x, r) => x + r.usd, 0);

  return json({
    ok: true,
    days,
    rows: rows.slice(0, 300),
    totals: {
      users: rows.length,
      paidUsers: paid.length,
      freeUsers: free.length,
      usd: +sum(rows).toFixed(4),
      usdPaid: +sum(paid).toFixed(4),
      usdFree: +sum(free).toFixed(4),
      // 單位經濟的兩個核心數字
      usdPerPaidUser: paid.length ? +(sum(paid) / paid.length).toFixed(4) : null,
      usdPerFreeUser: free.length ? +(sum(free) / free.length).toFixed(4) : null,
    },
  });
}

/**
 * 管理端：訂單列表。
 *
 * 只讀 metadata，所以一頁 1000 筆等於 1 次 KV 操作。
 * KV 的 list 是照鍵名字典序，而訂單編號的前綴是零補的時間戳，
 * 所以**掃回來的順序是由舊到新**——要顯示最新的必須全部撈回來再反轉。
 * 上限設五頁（5,000 筆）；真的超過時寧可截斷並說出來，也不要讓後台逾時打不開。
 */
async function handleOrderList(env, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  const status = url.searchParams.get('status') || 'all';
  const feed = url.searchParams.get('feed') === '1';

  const rows = [];
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page++) {
    const r = await env.SUBS.list({ prefix: 'ord:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      rows.push({
        no: k.name.slice(4),
        status: m.s || 'created',
        at: m.at || 0,
        price: m.t || 0,
        email: m.e || '',
        summary: m.l || '',
        manual: !!m.n,
        mailed: !!m.m,
      });
    }
    if (r.list_complete) { cursor = null; break; }
    cursor = r.cursor;
    if (page === 4) truncated = true;
  }
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));

  // 通知輪詢用的輕量模式：只回最新一筆已付款的摘要，回應只有幾十位元組
  if (feed) {
    const paid = rows.filter((r) => r.status === 'paid');
    return json({
      ok: true,
      latest: paid[0] || null,
      paidCount: paid.length,
      pendingManual: paid.filter((r) => r.manual).length,
      mailFailed: paid.filter((r) => !r.mailed).length,
    });
  }

  const out = rows.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (q && ![r.no, r.email, r.summary].some((v) => String(v).toLowerCase().includes(q))) return false;
    return true;
  });
  return json({
    ok: true, rows: out.slice(0, 500), total: rows.length,
    shown: Math.min(out.length, 500), truncated,
  });
}

/** 管理端：單筆訂單的完整內容（列表只有摘要）。 */
async function handleOrderGet(env, url) {
  const no = String(url.searchParams.get('no') || '').trim();
  const o = await readOrder(env, no);
  if (!o) return err('查無此訂單', 404);
  let mf = null;
  let pay = null;
  try { mf = JSON.parse((await env.SUBS.get(`mailfail:${no}`)) || 'null'); } catch (e) { /* noop */ }
  try { pay = JSON.parse((await env.SUBS.get(`payinfo:${no}`)) || 'null'); } catch (e) { /* noop */ }
  return json({ ok: true, order: o, mailFail: mf, payInfo: pay });
}

/**
 * 管理端：改一筆訂單。
 *
 * 只開放三件客服真的要做的事：
 *   note        寫備註（例如「已用 LINE 聯繫」）
 *   serviceDone 代訂結案——**不做這個的話，代訂訂單付完款就沒人知道處理了沒**
 *   resendMail  補寄授權碼信。寄信失敗是會發生的（網域沒驗、信箱打錯），
 *               沒有這個按鈕就只能請買家自己去「忘記授權碼」，體驗差很多
 *
 * ⚠️ **刻意不提供「手動標記為已付款」。** 那等於在後台開一個發碼後門，
 *    誤點或權杖外流的代價是直接送出商品。要補償請用發碼頁的「客服補償」。
 */
async function handleOrderPatch(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const no = String(b.no || '').trim();
  const o = await readOrder(env, no);
  if (!o) return err('查無此訂單', 404);

  if (b.note !== undefined) o.note = String(b.note).slice(0, 500);

  if (b.serviceDone !== undefined && Array.isArray(o.services)) {
    const i = Number(b.serviceDone);
    if (o.services[i]) {
      o.services[i].status = o.services[i].status === 'done' ? 'pending' : 'done';
      o.services[i].doneAt = nowSec();
    }
  }

  let mail = null;
  if (b.resendMail) {
    if (o.status !== 'paid' || !o.licenseKey) return err('這筆訂單還沒發碼，沒有東西可以寄');
    const lic = await readLicense(env, normLicense(o.licenseKey));
    if (!lic) return err('找不到對應的授權碼，可能已被刪除');
    const to = String(b.email || o.email || '').trim();
    try {
      mail = await sendLicenseMail(env, to, normLicense(o.licenseKey), lic);
    } catch (e) { mail = { sent: false, reason: String((e && e.message) || e) }; }
    if (mail.sent) {
      o.mailed = true;
      o.email = to || o.email;
      await env.SUBS.delete(`mailfail:${no}`);
    }
  }

  await env.SUBS.put(ordKey(no), JSON.stringify(o), {
    expirationTtl: ORDER_TTL, metadata: ordMeta(o),
  });
  return json({ ok: true, order: o, mail });
}

/**
 * 管理端：目前有哪些方案、實際價格是多少。
 *
 * ⚠️ **後台的方案下拉不可以寫死。** 之前就是寫死的，於是定價從
 *    「早鳥 399／正式 599」改成「上半季 599／下半季 299／一週 39」之後，
 *    後台還在發早鳥碼——發出去的方案與網站上賣的根本是兩套東西，
 *    而且不會有任何錯誤訊息。
 *
 * 這裡回的是**伺服器此刻真正會用的價格**（含後台覆寫與賽季分段），
 * 而不是程式碼裡的牌價。
 */
async function handleAdminPlans(env) {
  const ops = await opsConfig(env);
  const out = [];
  for (const [key, p] of Object.entries(PLANS)) {
    const row = {
      key,
      label: p.label,
      listPrice: p.price,
      price: planPrice(key, ops),
      kind: /^svc_/.test(key) ? 'service' : (p.free || !p.price) ? 'internal' : 'sub',
      hidden: ops.hidden.includes(key),
      manual: !!p.manual,
      weekBound: !!p.weekBound,
      // ⚠️ **發碼下拉只能列出「發了有用」的方案。**
      //    代訂方案本身發出去是一張立刻到期的碼（字幕使用權是靠附贈的
      //    week_svc 給的）；trial 是免費層，根本不需要授權碼。
      //    把它們列進去只會讓客服在壓力下選錯，而選錯完全不報錯——
      //    使用者拿到一張「看起來正常、貼上去卻說已過期」的碼。
      issuable: !p.manual && !p.noSubs && !p.free,
      locked: planLock(key),
      note: '',
    };
    if (p.untilSeasonEnd) {
      const sp = seasonPriceNow(row.price);
      row.price = sp.price;
      row.note = sp.tier + (sp.nextSeason ? '（次一賽季）' : '');
    }
    if (!row.note && p.days) row.note = `${p.days} 天`;
    out.push(row);
  }
  return json({ ok: true, plans: out, earlyLeft: Math.max(0, EARLY_LIMIT - (await earlyIssued(env))) });
}

/** 管理端路由。權限已在外層驗過，這裡只管分派。 */
async function routeAdmin(path, request, env, url) {
  const m = request.method;

  if (path === '/v1/admin/license/issue' && m === 'POST') return handleLicenseIssue(request, env);
  if (path === '/v1/admin/plans' && m === 'GET') return handleAdminPlans(env);
  if (path === '/v1/admin/account' && m === 'GET') return handleAccount(env, url);
  if (path === '/v1/admin/econ' && m === 'GET') {
    try { await flushStats(env); } catch (e) { /* 先落地再讀 */ }
    return handleEcon(env, url);
  }
  if (path === '/v1/admin/users' && m === 'GET') {
    try { await flushStats(env); } catch (e) { /* 先落地再讀 */ }
    return handleUserStats(env, url);
  }
  // 代碼表。後台照著顯示，不必自己抄一份（抄了就會漂）。
  if (path === '/v1/admin/codes' && m === 'GET') return json({ ok: true, codes: ERR_CODES });
  // 單一影片的完整譯文。用途有二：後台抽查翻譯品質、以及 tools/fetch-fixtures.js
  // 抓固定測試資料。**不做分頁**——一支影片最多 BUNDLE_MAX_LINES 句，回得完。
  if (path === '/v1/admin/bundle' && m === 'GET') {
    const cid = String(url.searchParams.get('cid') || '').trim();
    if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    return json({
      ok: true, cid, slug: b.slug || '', segCount: b.segCount || 0,
      count: Object.keys(b.lines || {}).length, lines: b.lines || {},
    });
  }
  if (path === '/v1/admin/orders' && m === 'GET') return handleOrderList(env, url);
  if (path === '/v1/admin/orders/get' && m === 'GET') return handleOrderGet(env, url);
  if (path === '/v1/admin/orders/patch' && m === 'POST') return handleOrderPatch(request, env);
  // license/revoke 與 license/lookup 已由 license/patch（revoked 欄位）與
  // license/list（?q= 可搜 email）取代。**同一件事不留兩種做法**——
  // 後台只會用其中一條，另一條遲早會漂掉而沒人發現。
  if (path === '/v1/admin/license/list' && m === 'GET') return handleLicenseList(request, env, url);
  if (path === '/v1/admin/license/patch' && m === 'POST') return handleLicensePatch(request, env);
  if (path === '/v1/admin/license/delete' && m === 'POST') return handleLicenseDelete(request, env);
  if (path === '/v1/admin/reports/patch' && m === 'POST') return handleReportPatch(request, env);
  if (path === '/v1/admin/reports' && m === 'GET') return handleReportList(env, url);
  if (path === '/v1/admin/metrics' && m === 'GET') {
    try { await flushMetrics(env); } catch (e) { /* 先落地再讀 */ }
    return handleMetrics(env, url);
  }

  if (path === '/v1/admin/stats' && m === 'GET') {
    try { await flushStats(env); } catch (e) { /* 先落地再讀，讀不到也不擋 */ }
    return handleStats(env, url);
  }

  // 撤銷某個安裝（濫用、盜用時用；退款請用 license/revoke）
  if (path === '/v1/admin/revoke' && m === 'POST') {
    const b = await request.json().catch(() => null);
    const id = b && String(b.installId || '').trim();
    if (!id) return err('缺少 installId');
    let list = [];
    try { list = JSON.parse((await env.SUBS.get('revoked')) || '[]'); } catch (e) { /* noop */ }
    if (!list.includes(id)) list.push(id);
    await env.SUBS.put('revoked', JSON.stringify(list));
    revCache = { at: 0, set: null };       // 立刻讓快取失效
    return json({ ok: true, revoked: list.length });
  }

  return null;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/**
 * 網站自己的來源。**只開這幾個，不開 `*`。**
 *
 * ⚠️ 上面 `CORS` 的註解說「我們根本不需要 CORS」——那句話在當時是對的，
 *    因為只有擴充功能（service worker + host_permissions）與 userscript
 *    （GM_xmlhttpRequest）在打 API，兩者都不受 CORS 限制。
 *
 *    但 **`pitlingo.com/buy` 是一般的瀏覽器頁面**，它的 fetch 一定受 CORS 管。
 *    購買頁改成向後端要價格之後，這個「不需要 CORS」的前提就不成立了，
 *    症狀是使用者按下結帳看到 `Failed to fetch`，而 Console 才有真正的原因。
 *
 *    這是坑 #13 的又一次：**在某個檔案（或某個時期）成立的規則，
 *    要主動確認它在新的使用情境下還成不成立。**
 *
 *    開放範圍刻意只到「我們自己的網站 + 我們自己需要的端點」，
 *    不回到 `*`——那會把原本消除掉的攻擊面整個放回來。
 */
const SITE_ORIGINS = new Set([
  'https://pitlingo.com',
  'https://www.pitlingo.com',
]);

// 購買頁與客服頁實際會打的端點。沒列在這裡的一律維持「不開 CORS」。
const SITE_PATHS = new Set([
  '/v1/plans', '/v1/quote', '/v1/checkout', '/v1/contact', '/v1/order',
]);

/**
 * 可由後台修改的營運設定。**存在 KV，不用重新部署就能改。**
 *
 * 使用者的要求：「整個網站我要能夠自訂」。目前開放這些——
 * 都是會隨營運調整、而每次調整都要我改程式碼重新部署的東西：
 *
 *   prices        各方案價格（覆寫程式碼裡的預設）
 *   earlyLimit    早鳥限量組數
 *   hidden        要下架的方案（不刪除，只是不顯示也不能買）
 *   choosePayment 綠界的付款方式（見 `ecpayPayment` 的說明）
 *   notice        購買頁最上方的公告，空字串就不顯示
 *
 * ⚠️ **覆寫只接受「已知的方案鍵」與合理範圍的數字。**
 *    後台被誤操作或貼錯 JSON 時，最糟只是某個價格沒被覆寫，
 *    不會變成 0 元或負數——那種錯誤會直接變成金錢損失。
 */
/**
 * 站名的英文關鍵字，用來把影片的網址後綴對回賽程。
 *
 * 為什麼需要一張對照表：`REMOTE_CONFIG.schedule` 的 `name` 是中文（「荷蘭」），
 * 而 F1TV 的 slug 是英文（`2026-dutch-grand-prix-race`）——直接比對永遠對不上。
 * 這張表跟賽程放在一起維護，改賽程時要記得一起改。
 *
 * 關鍵字要夠獨特：用 `usa` 會誤中 `usual`，所以用 `united-states`／`austin`。
 */
const GP_SLUG_HINTS = {
  1: ['australia', 'australian', 'melbourne'],
  2: ['china', 'chinese', 'shanghai'],
  3: ['japan', 'japanese', 'suzuka'],
  4: ['miami'],
  5: ['canada', 'canadian', 'montreal'],
  6: ['monaco'],
  7: ['barcelona', 'catalunya'],
  8: ['austria', 'austrian', 'spielberg', 'red-bull-ring'],
  9: ['britain', 'british', 'silverstone'],
  10: ['belgium', 'belgian', 'spa'],
  11: ['hungary', 'hungarian', 'hungaroring', 'budapest'],
  12: ['dutch', 'netherlands', 'zandvoort'],
  13: ['italy', 'italian', 'monza'],
  14: ['madrid', 'madring', 'spanish', 'spain'],
  15: ['azerbaijan', 'baku'],
  16: ['bahrain', 'sakhir', 'sepang', 'malaysia'],
  17: ['singapore', 'marina-bay'],
  18: ['united-states', 'austin', 'americas', 'cota'],
  19: ['mexico', 'mexican'],
  20: ['brazil', 'brazilian', 'sao-paulo', 'interlagos'],
  21: ['las-vegas', 'vegas'],
  22: ['qatar', 'lusail'],
  23: ['abu-dhabi', 'yas-marina'],
};

const OPS_KEY = 'ops:config';
let opsCache = { at: 0, data: null };

async function opsConfig(env) {
  if (opsCache.data && Date.now() - opsCache.at < 30000) return opsCache.data;
  let raw = null;
  try { raw = JSON.parse((await env.SUBS.get(OPS_KEY)) || 'null'); } catch (e) { raw = null; }
  const o = (raw && typeof raw === 'object') ? raw : {};

  const prices = {};
  if (o.prices && typeof o.prices === 'object') {
    for (const [k, v] of Object.entries(o.prices)) {
      // 只認得的方案、只收 1~99999 的整數。0 或負數一律忽略。
      if (!PLANS[k]) continue;
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 1 && n <= 99999) prices[k] = n;
    }
  }
  const data = {
    prices,
    earlyLimit: Number.isFinite(Number(o.earlyLimit)) && Number(o.earlyLimit) >= 0
      ? Math.min(9999, Math.round(Number(o.earlyLimit))) : null,
    hidden: Array.isArray(o.hidden) ? o.hidden.filter((k) => PLANS[k]) : [],
    choosePayment: typeof o.choosePayment === 'string' && /^[A-Za-z]+$/.test(o.choosePayment)
      ? o.choosePayment : null,
    notice: typeof o.notice === 'string' ? o.notice.slice(0, 500) : '',
    // ---- 單位經濟的三個輸入 ----
    // ⚠️ 這三個**我們量不到，只能由你填**。填之前後台會明講是估算值，
    //    不會拿假數字冒充實測——單位經濟算錯的代價是「以為賺錢其實在虧」。
    fxTwdPerUsd: Number(o.fxTwdPerUsd) > 0 ? Number(o.fxTwdPerUsd) : 32,
    marketingTwd: Number(o.marketingTwd) >= 0 ? Number(o.marketingTwd) : 0,
    // 一個付費者預期會續訂幾季。**沒有資料之前一律是 1**——
    // 用 2、3 會讓 LTV 憑空變兩三倍，然後據此決定廣告預算，那是最貴的一種錯。
    ltvSeasons: Number(o.ltvSeasons) > 0 ? Number(o.ltvSeasons) : 1,
  };
  opsCache = { at: Date.now(), data };
  return data;
}

/**
 * 這個方案現在能不能買。回傳 null＝可以，否則回傳鎖住的原因。
 *
 * ⚠️ **鎖住的方案仍然要回給購買頁**，只是不能結帳。
 *    直接從清單裡拿掉會讓人以為賣完了或網站壞了；
 *    留著並說明「什麼時候會開放」，那本身就是預告。
 *
 * ⚠️ 這個判斷必須同時擋住 quoteCart（結帳）與 checkout，不能只做在畫面上——
 *    購買頁的按鈕是用戶端的東西，繞過它只要開一個 devtools。
 */
function planLock(key, from, cfg) {
  const p = PLANS[key];
  if (!p) return '方案不存在';
  if (!p.nextSeasonOnly) return null;
  const left = racesLeft(from, cfg);
  if (left < NEXT_SEASON_MIN_WEEKENDS) return null;
  return `本賽季還有 ${left} 個比賽週末，下一賽季通行證要到剩 ${NEXT_SEASON_MIN_WEEKENDS} 個週末時才開放預購`;
}

/** 這個方案現在的牌價（後台覆寫優先）。 */
function planPrice(key, ops) {
  const p = PLANS[key];
  if (!p) return 0;
  return (ops && ops.prices && ops.prices[key] != null) ? ops.prices[key] : p.price;
}

function siteCorsFor(request, path) {
  const origin = request.headers.get('origin') || '';
  if (!SITE_ORIGINS.has(origin)) return null;
  if (!SITE_PATHS.has(path)) return null;
  return {
    ...CORS,
    'Access-Control-Allow-Origin': origin,
    // 來源不只一個，快取必須依 Origin 分開，否則 CDN 會把 A 的允許標頭回給 B
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const res = await handleRequest(request, env);
    try {
      const c = siteCorsFor(request, new URL(request.url).pathname);
      if (!c) return res;
      // Response 的 headers 是唯讀的，要重建一份才改得動
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(c)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      return res;
    }
  },
};

async function handleRequest(request, env) {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const isAdmin = path.startsWith('/v1/admin/');

    // 預檢。三種情況要分開：
    //   管理端點  本機開的 `file://` 後台，Origin 是 null，要放寬
    //   網站端點  只允許我們自己的網域（見 SITE_ORIGINS）
    //   其他      維持不開 CORS，瀏覽器端的跨站呼叫直接被擋掉
    if (request.method === 'OPTIONS') {
      const site = siteCorsFor(request, path);
      return new Response(null, { status: 204, headers: isAdmin ? ADMIN_CORS : (site || CORS) });
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    try {
      if (path === '/v1/health') {
        return json({ ok: true, ts: new Date().toISOString(), model: MODEL });
      }

      // 遠端設定優先讀 KV，讀不到才用內建預設。
      // 這樣 F1TV 改版時只要 POST 一次就能救所有使用者，不必重新部署 Worker。
      if (path === '/v1/config' && request.method === 'GET') {
        const raw = await env.SUBS.get('config');
        let cfg = REMOTE_CONFIG;
        if (raw) { try { cfg = JSON.parse(raw); } catch (e) { /* 壞掉就用內建的 */ } }

        // 分階段推送：用戶端帶自己的 installId，伺服器決定他該拿哪一版。
        // 分流在伺服器做而不是用戶端，這樣才能單方面收回一次失敗的推送。
        const rollout = cfg.rollout === undefined ? 100 : Number(cfg.rollout);
        const iid = url.searchParams.get('iid') || '';
        if (rollout < 100 && iid && (await bucketOf(iid)) >= rollout) {
          const prev = await env.SUBS.get('config:prev');
          if (prev) { try { cfg = JSON.parse(prev); } catch (e) { /* 用現行的 */ } }
          else cfg = REMOTE_CONFIG;
        }
        // ⚠️ 不可以放 max-age：推送與 killSwitch 要能即時生效（坑 #26 同一類）
        return json(cfg, 200, { 'cache-control': 'no-store' });
      }

      // 熱修入口：改選擇器不用重新部署，也不用等商店審核
      if (path === '/v1/config' && request.method === 'POST') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return err('unauthorized', 401);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sites)) return err('需要 { version, sites: [...] }');
        // rollout 必須合法，否則推錯一個數字就等於全站生效或全站失效
        if (body.rollout !== undefined
            && !(Number.isFinite(body.rollout) && body.rollout >= 0 && body.rollout <= 100)) {
          return err('rollout 必須是 0~100');
        }
        // 保留上一版，讓不在推送範圍內的安裝有東西可用
        const prevRaw = await env.SUBS.get('config');
        if (prevRaw) await env.SUBS.put('config:prev', prevRaw);
        await env.SUBS.put('config', JSON.stringify(body));
        return json({
          ok: true, version: body.version, sites: body.sites.length,
          rollout: body.rollout === undefined ? 100 : body.rollout,
        });
      }

      // 出事時的還原鍵：刪掉 KV 就回到內建預設
      if (path === '/v1/config' && request.method === 'DELETE') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return err('unauthorized', 401);
        await env.SUBS.delete('config');
        return json({ ok: true, reverted: true, version: REMOTE_CONFIG.version });
      }

      // 匿名註冊：換一枚屬於這個安裝的權杖。不需要帳號、不收任何個資。
      // 用 IP 限制頻率，避免有人狂刷權杖來繞過 installId 的限額。
      if (path === '/v1/register' && request.method === 'POST') {
        if (await rateLimited(env, `reg:${ip}`)) return err('rate limited', 429);
        try {
          const t = await issueInstallToken(env);
          return json({ ok: true, token: t.token, exp: t.exp });
        } catch (e) {
          return err(String(e.message || e), 500);
        }
      }

      if (path === '/v1/subs' && request.method === 'GET') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleGetSubs(request, env, url);
      }

      if (path === '/v1/subs' && request.method === 'POST') {
        if (!authAdmin(env, request)) return err('unauthorized', 401);
        return handlePostSubs(request, env);
      }

      if (path === '/v1/translate' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleTranslate(request, env, ip, a);
      }

      if (path === '/v1/complete' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleComplete(request, env);
      }

      // ---- 授權（綁人，不綁裝置）----
      if (path === '/v1/license/activate' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleLicenseActivate(request, env, a);
      }
      // 公開的方案資訊。購買頁用它顯示價格與早鳥剩餘數——
      // **價格寫死在前端會漂**，改後端就得改兩個地方，遲早忘記一個。
      // 購物車報價。購買頁每次改動都打這裡，**畫面上的數字一律由後端算**——
      // 前端自己算就一定會跟結帳收的錢漂掉，而那是最直接的糾紛。
      if (path === '/v1/quote' && request.method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b) return err('body 不是合法 JSON');
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) return err('購物車是空的');
        if (items.length > 10) return err('一次最多 10 個項目');
        const q = await quoteCart(env, items, { email: b.email, upgrade: !!b.upgrade, licenseKey: b.licenseKey });
        if (q.error) return err(q.error);
        return json({
          ok: true,
          lines: q.lines, adjustments: q.adjustments, total: q.total,
          needsVpn: q.needsVpn, hasManual: q.hasManual, freeUpgrade: q.freeUpgrade,
          creditNote: q.creditNote || null,
        });
      }

      /**
       * 翻譯清單：哪些影片翻好了、各有幾句、屬於哪一場 GP。
       *
       * ⚠️ **只讀 metadata，不讀 bundle 本體。** 一份兩千句的 bundle 約 200KB，
       *    一百支就是 20MB——一次列表就會逾時，而且把 KV 讀取額度吃光。
       *    `list()` 直接回傳 metadata，那是為這種用途設計的。
       *
       * 舊資料沒有 metadata（在加上之前寫入的），會列在「待補資料」那一組，
       * 下次那支影片被寫入時就會自動補上——**不另外做回填**，
       * 回填要把每一份都讀出來再寫回去，代價正是我們要避免的那件事。
       */
      if (path === '/v1/admin/bundles' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);

        const items = [];
        let cursor;
        // KV list 一次最多 1000 筆，用 cursor 翻頁。上限 10 頁當防呆——
        // 真的有上萬支影片時，該做的是分頁 UI 而不是一次全撈。
        for (let page = 0; page < 10; page++) {
          const r = await env.SUBS.list({ prefix: 'bundle:', limit: 1000, cursor });
          for (const k of r.keys) {
            const m = k.metadata || {};
            items.push({
              cid: k.name.slice('bundle:'.length),
              lines: Number(m.n) || 0,
              segCount: Number(m.seg) || 0,
              at: m.at || null,
              slug: m.slug || '',
            });
          }
          if (r.list_complete) break;
          cursor = r.cursor;
        }

        // 依比賽週分組。用 slug 比對賽程的站名——slug 是英文，賽程是中文，
        // 所以額外帶一份英文關鍵字對照。對不上的歸「其他／未分類」。
        const cfg = REMOTE_CONFIG;
        const groups = new Map();
        const put = (key, label, order, it) => {
          if (!groups.has(key)) groups.set(key, { key, label, order, items: [] });
          groups.get(key).items.push(it);
        };
        for (const it of items) {
          const s = String(it.slug || '').toLowerCase();
          let hit = null;
          if (s) {
            hit = scheduleList(cfg).find((g) => {
              const kw = GP_SLUG_HINTS[g.r] || [];
              return kw.some((w) => s.includes(w));
            });
          }
          if (hit) put(`r${hit.r}`, `R${hit.r} ${hit.name}（${hit.start}）`, hit.r, it);
          else if (!it.slug) put('nometa', '待補資料（在記錄摘要之前寫入的）', 998, it);
          else put('other', '其他／未分類', 999, it);
        }

        const out = [...groups.values()].sort((a, b) => a.order - b.order).map((g) => ({
          key: g.key,
          label: g.label,
          videos: g.items.length,
          lines: g.items.reduce((a, x) => a + x.lines, 0),
          complete: g.items.filter((x) => x.segCount > 0).length,
          items: g.items.sort((a, b) => b.lines - a.lines),
        }));

        return adminJson({
          ok: true,
          totals: {
            videos: items.length,
            lines: items.reduce((a, x) => a + x.lines, 0),
            complete: items.filter((x) => x.segCount > 0).length,
            noMeta: items.filter((x) => !x.slug).length,
          },
          groups: out,
        });
      }

      /**
       * 回填舊 bundle 的摘要（metadata）。
       *
       * ⚠️ 我原本主張「不做回填，讓它自然補上」——**那個判斷是錯的**。
       *    自然補上的前提是「那支影片會再被寫入」，但已經完整收割過的影片
       *    正好**永遠不會再被寫入**（沒有新句子就不會上傳）。
       *    結果是最有價值的資料——已經翻好的那些——永遠停在「待補資料」。
       *
       * 一次處理一批，用 cursor 續跑。**每一份都要讀出來再寫回**，
       * 那正是列表時要避免的成本——但回填是一次性的，值得。
       *
       * `slug` 舊資料裡沒有，**無法從 contentId 反推**。這裡只補得回
       * 句數與分段數；slug 會在該影片下次被觀看或收割時補上（見 /v1/subs）。
       */
      if (path === '/v1/admin/backfill' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => ({}));
        const cursor = b && b.cursor ? String(b.cursor) : undefined;
        // 一批 25 支。再多會逼近 Worker 的 CPU 時間上限（每支要 JSON.parse 200KB）
        const r = await env.SUBS.list({ prefix: 'bundle:', limit: 25, cursor });

        let done = 0;
        let skipped = 0;
        for (const k of r.keys) {
          // 已經有摘要就跳過——回填是為了補舊資料，不是重寫全部
          if (k.metadata && typeof k.metadata.n === 'number') { skipped++; continue; }
          const cid = k.name.slice('bundle:'.length);
          const bundle = await readBundle(env, cid);
          if (!bundle) continue;
          await writeBundle(env, cid, bundle);     // writeBundle 會順手寫入 metadata
          done++;
        }

        return adminJson({
          ok: true,
          scanned: r.keys.length,
          filled: done,
          skipped,
          cursor: r.list_complete ? null : r.cursor,
          complete: !!r.list_complete,
        });
      }

      /**
       * 補齊 slug。
       *
       * ⚠️ **slug 無法從 contentId 反推**——我們只存數字，而 F1TV 不提供反查
       *    （`/detail/<id>` 只會回 404，而且有 Imperva 不能爬）。
       *
       * 但那份資料其實已經存在：**userscript 的收割佇列裡就是完整路徑**。
       * 所以讓它把 `done` 與 `queue` 的路徑送上來，後端逐一對上 cid。
       * 這比要求管理員手工填 30 筆務實得多。
       *
       * 只在「還沒有 slug」時寫入——先到先得，不覆蓋既有的。
       */
      if (path === '/v1/admin/bundles/slugs' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        const paths = Array.isArray(b && b.paths) ? b.paths.slice(0, 500) : [];
        if (!paths.length) return adminJson({ error: '沒有收到任何路徑' }, 400);

        let updated = 0, missing = 0, already = 0;
        for (const raw of paths) {
          const m = String(raw || '').match(/\/detail\/(\d+)(\/[A-Za-z0-9\-_]+)/);
          if (!m) continue;
          const cid = m[1];
          const slug = `/detail/${cid}${m[2]}`;
          const cur = await env.SUBS.get(bundleKey(cid));
          if (!cur) { missing++; continue; }        // 這支還沒有任何譯文
          let bundle;
          try { bundle = JSON.parse(cur); } catch (e) { continue; }
          if (bundle.slug) { already++; continue; }
          bundle.slug = slug;
          await writeBundle(env, cid, bundle);
          updated++;
        }
        return adminJson({ ok: true, updated, already, missing, received: paths.length });
      }

      // 營運設定的讀寫。只有帶 ADMIN_TOKEN 才改得動。
      if (path === '/v1/admin/ops' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const ops0 = await opsConfig(env);
        let raw = null;
        try { raw = JSON.parse((await env.SUBS.get(OPS_KEY)) || 'null'); } catch (e) { raw = null; }
        return adminJson({
          ok: true,
          current: raw || {},
          applied: await opsConfig(env),
          // 讓後台知道有哪些方案可以調，不必憑記憶打字。
          //
          // ⚠️ **一定要回「此刻實際會收的錢」（effective），不能只回牌價。**
          //    賽季方案的牌價是 599，但季中分段定價可能讓實收變成 299。
          //    後台只看得到牌價時，你會以為改了 599 就是改了售價——
          //    然後發現綠界收的是另一個數字。那正是這個專案已經踩過的坑。
          plans: Object.entries(PLANS)
            .filter(([, v]) => v.price > 0 && !v.internal)
            .map(([k, v]) => {
              const list = planPrice(k, ops0);
              const sp = v.untilSeasonEnd ? seasonPriceNow(list) : null;
              return {
                key: k, label: v.label,
                defaultPrice: v.price,
                effective: sp ? sp.price : list,
                tier: sp ? sp.tier : '',
                kind: /^svc_/.test(k) ? 'service' : 'sub',
              };
            }),
        });
      }
      if (path === '/v1/admin/ops' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        if (!b || typeof b !== 'object') return adminJson({ error: 'body 不是合法 JSON' }, 400);
        await env.SUBS.put(OPS_KEY, JSON.stringify(b));
        opsCache = { at: 0, data: null };            // 立刻讓快取失效
        return adminJson({ ok: true, applied: await opsConfig(env) });
      }

      if (path === '/v1/plans' && request.method === 'GET') {
        const ops = await opsConfig(env);
        const left = await earlyRemaining(env);
        const season = seasonPriceNow(PLANS.season.price);
        const w = weekWindow();
        const plans = Object.entries(PLANS)
          .filter(([, v]) => v.price > 0)
          .map(([k, v]) => {
            // 賽季方案要顯示**當下實際會收的錢**，不是牌價。
            // 顯示 599 卻收 420（或反過來）都是糾紛。
            // 牌價要走 planPrice，後台改過的價格才會反映到畫面上。
            // 只改 quoteCart 不改這裡的話，會變成「顯示舊價、收新價」——
            // 那正是這一版要修掉的那個問題，只是換個地方發生。
            const list = planPrice(k, ops);
            const sp = v.untilSeasonEnd ? seasonPriceNow(list) : null;
            return {
              key: k, label: v.label,
              // 鎖住的方案照樣回給購買頁，只是不能結帳（見 planLock 的說明）
              locked: planLock(k),
              price: sp ? sp.price : list,
              listPrice: list,
              tier: sp ? sp.tier : null,
              limit: v.limit || null,
              // 賣的是下一季時一定要標出來，購買頁才有辦法講清楚
              nextSeason: !!(sp && sp.nextSeason),
              until: sp ? sp.until : null,
              // 一週通行證涵蓋的是哪一場、到什麼時候
              gp: v.weekBound && w ? { name: w.gp.name, weekFrom: w.weekFrom, expiresAt: w.expiresAt } : null,
              // 通行證可以一次買多站。上限是本賽季剩餘的比賽週。
              maxQty: v.weekBound ? Math.max(1, racesLeft()) : 1,
              vpn: !!v.vpn,
              desc: v.desc || '',
              bundleWeek: !!v.bundleWeek,
            };
          })
          // ⚠️ 早鳥價一旦不比當期 Season 價便宜就自動下架。
          //    2026 的分段價會掉到 259／129，那時還掛著「限量 20 組早鳥價 399」
          //    等於在賣一個比正常價還貴的東西——沒有人會來反映，只會不買。
          //    用「比較價格」而不是「比較日期」，才不必每年維護一個截止日。
          .filter((p) => !ops.hidden.includes(p.key))
          .filter((p) => !(p.key === 'season_early' && p.price >= season.price));

        return json({
          plans,
          earlyLeft: left,
          notice: ops.notice || '',
          season: {
            weekendsLeft: season.weekendsLeft,
            tentative: racesLeftTentative(),
            nextSeason: season.nextSeason,
            tier: season.tier,
          },
        }, 200, { 'cache-control': 'public, max-age=60' });
      }

      // ---- 金流 ----
      // 結帳不需要用戶端權杖：使用者是在網頁上買，不是在擴充功能裡。
      if (path === '/v1/checkout' && request.method === 'POST') {
        if (await rateLimited(env, `co:${ip}`)) return err('操作太頻繁，請稍後再試', 429);
        return handleCheckout(request, env, url);
      }
      // 金流回呼。**不需要用戶端權杖**（金流平台不會帶），改用簽章驗證。
      if (path === '/v1/payment/webhook' && request.method === 'POST') {
        return handlePaymentWebhook(request, env);
      }
      // ATM／超商取號通知。**這裡不發碼**——取號不等於付款。
      if (path === '/v1/payment/info' && request.method === 'POST') {
        return handlePaymentInfo(request, env);
      }
      /**
       * 綠界付款後的瀏覽器導回點。
       *
       * 綠界用 **POST** 導回，而付款結果頁是靜態的 Pages——靜態頁讀不到 POST body。
       * 所以由 Worker 接住，取出訂單編號與結果碼，再 302 轉到 `/paid`。
       *
       * ⚠️ **這裡不發碼、不改任何狀態。** 發碼只在 `/v1/payment/webhook`（伺服器對伺服器）。
       *    瀏覽器導回是使用者可以偽造的——把發碼掛在這裡等於開放任何人自行下單。
       */
      if (path === '/v1/payment/result' && request.method === 'POST') {
        let p = {};
        try {
          const form = await request.formData();
          for (const [k, v] of form) p[k] = String(v);
        } catch (e) { p = {}; }

        const no = String(p.MerchantTradeNo || '').slice(0, 32);
        const okPay = String(p.RtnCode) === '1';

        // ⚠️ **這是使用者的瀏覽器送過來的，內容可以偽造。**
        //    所以要記進訂單之前必須先驗綠界的簽章；驗不過就只轉址、不改任何狀態。
        //    （驗過了也只允許往 failed 走，patchOrder 的 ORDER_RANK 擋住把
        //      已付款的訂單改回去——不然任何人都能把別人的訂單標成失敗。）
        if (no && !okPay) {
          try {
            const prod = ecpayConf(env, 'production');
            const stg = ecpayConf(env, 'stage');
            const mine = String(p.CheckMacValue || '').toUpperCase();
            const good = (prod.hashKey && safeEqual(mine, await ecpayMac(p, prod.hashKey, prod.hashIV)))
              || safeEqual(mine, await ecpayMac(p, stg.hashKey, stg.hashIV));
            if (good) {
              await patchOrder(env, no, {
                status: 'failed',
                failCode: String(p.RtnCode || ''),
                failMsg: String(p.RtnMsg || '').slice(0, 200),
              });
            }
          } catch (e) { /* 記不起來也要把人導回去，不能卡在這裡 */ }
        }
        const site = env.SITE_URL || 'https://pitlingo.com';
        // 失敗時把綠界的訊息一起帶過去，讓使用者知道為什麼被拒
        const msg = encodeURIComponent(String(p.RtnMsg || '').slice(0, 120));
        const to = okPay
          ? `${site}/paid?no=${encodeURIComponent(no)}`
          : `${site}/paid?no=${encodeURIComponent(no)}&failed=1&msg=${msg}`;
        return new Response(null, { status: 302, headers: { Location: to } });
      }

      if (path === '/v1/order' && request.method === 'GET') {
        return handleOrderStatus(env, url);
      }

      // 產品數據。彙總計數，不含任何可識別個人的資訊。
      if (path === '/v1/metric' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleMetric(request, env, a);
      }

      // 網站的客服工單。
      //
      // ⚠️ 與 `/v1/report` 刻意分開：那條需要安裝權杖（避免被當成匿名投遞箱），
      //    但網站訪客**沒有**安裝權杖——買家可能根本還沒裝擴充功能。
      //    這裡改用 IP 速率限制當防濫用，並寫進同一份 `report:` 儲存，
      //    後台就不必再做第二套介面（工單編號、已解決標記、列表全部共用）。
      if (path === '/v1/contact' && request.method === 'POST') {
        if (await rateLimited(env, `web:${ip}`)) return err('送出太頻繁，請稍後再試', 429);
        const b = await request.json().catch(() => null);
        if (!b) return err('body 不是合法 JSON');
        const msg = String(b.message || '').trim();
        if (msg.length < 5) return err('請描述你遇到的問題（至少 5 個字）');
        if (msg.length > 4000) return err('內容過長，請精簡在 4000 字以內');
        const contact = String(b.contact || '').trim().slice(0, 200);
        if (!contact) return err('請留下 email，否則我們無法回覆你');

        const id = ticketId();
        await env.SUBS.put(`report:${id}`, JSON.stringify({
          id,
          source: 'web',                         // 後台要分得出來源，處理方式不同
          contact,
          note: msg,
          orderId: String(b.orderId || '').slice(0, 40),
          report: '(網站客服工單，無診斷內容)',
          at: nowSec(),
          resolved: false,
        }), { expirationTtl: REPORT_TTL_DAYS * 86400 });

        return json({ ok: true, ticket: id });
      }

      // 診斷回報。需要安裝權杖，避免被當成匿名投遞箱。
      if (path === '/v1/report' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        if (await rateLimited(env, `rep:${a.installId}`)) return err('回報太頻繁，請稍後再試', 429);
        return handleReportSubmit(request, env, a);
      }

      if (path === '/v1/license/devices' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleLicenseDevices(request, env);
      }
      if (path === '/v1/license/renew' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleLicenseRenew(request, env, a);
      }
      // 解除裝置刻意**不要求**該裝置的權杖——電腦壞了、賣掉了、重灌了都要能解除。
      // 只要拿得出授權碼就有權處理自己的裝置。
      if (path === '/v1/license/deactivate' && request.method === 'POST') {
        if (await rateLimited(env, `lic:${ip}`)) return err('rate limited', 429);
        return handleLicenseDeactivate(request, env);
      }

      // ---- 管理後台 ----
      // 權限在這裡驗一次，回應一律補 CORS —— 後台是本機開的 file:// 網頁，
      // Origin 是 null，沒有 CORS 連問都問不到（第一版把自己的後台擋掉了）。
      if (isAdmin) {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const res = await routeAdmin(path, request, env, url);
        if (!res) return adminJson({ error: 'not found' }, 404);
        return new Response(await res.text(), { status: res.status || 200, headers: ADMIN_CORS });
      }

      return err('not found', 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
}
