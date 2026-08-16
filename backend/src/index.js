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
 *   POST /v1/payment/webhook           金流回呼：驗簽 → 防重放 → 自動發碼
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

// 撤銷清單。整份放一個 key，因為它應該永遠很小（只有濫用與退款會進來）。
// 用 isolate 內快取避免每個請求都讀 KV。
let revCache = { at: 0, set: null };
async function revokedSet(env) {
  if (revCache.set && Date.now() - revCache.at < 60000) return revCache.set;
  let list = [];
  try { list = JSON.parse((await env.SUBS.get('revoked')) || '[]'); } catch (e) { /* 壞掉當空的 */ }
  revCache = { at: Date.now(), set: new Set(list) };
  return revCache.set;
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
const PLANS = {
  // 免費層。不需要授權碼——四種正式場次的前 15 分鐘，見 REMOTE_CONFIG.freeTier。
  // 列在這裡是為了讓後台與統計有一致的名稱可用。
  trial: { label: 'GP Trial', price: 0, days: null, public: true, free: true },

  // 早鳥。限量 20 組，賣完就只剩正式價。
  season_early: { label: 'Season Early Access', price: 399, untilSeasonEnd: true, limit: 20 },

  // 正式價。
  season: { label: 'Season', price: 599, untilSeasonEnd: true },

  // 客服補償用，不公開販售。
  comp: { label: '客服補償', price: 0, days: 30 },
};

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

function planExpiry(plan, from) {
  const p = PLANS[plan];
  if (!p) return null;
  if (p.untilSeasonEnd) return seasonEndSec(from);
  if (p.days) return Math.floor((from || Date.now()) / 1000) + p.days * 86400;
  return null;
}

/** 早鳥還剩幾組。用 KV 計數，發碼時遞增。 */
async function earlyRemaining(env) {
  const n = parseInt((await env.SUBS.get('early:count')) || '0', 10);
  return Math.max(0, EARLY_LIMIT - n);
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

const freeKey = (installId) => `free:${installId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * 判定這次請求能翻幾句。回傳 { allowed, reason, plan }。
 *
 * 設計原則：**任何不確定的情況都往寬鬆解釋**。
 * 讀不到授權、KV 暫時有問題、通行證剛好在續期空窗——
 * 這些都不該讓付了錢的人被擋。真正要擋的是「明確沒有授權且已超過免費額度」。
 */
async function checkEntitlement(env, auth, request, wantLines) {
  const ent = request.headers.get('x-entitlement') || '';

  if (ent) {
    const v = await verifyEntitlement(env, ent);
    // 通行證必須是簽給這個安裝的，否則等於一張到處傳的萬用票
    if (v.ok && v.installId === auth.installId) {
      if ((await revokedSet(env)).has(auth.installId)) {
        return { allowed: 0, reason: 'revoked', plan: null };
      }
      return { allowed: wantLines, reason: 'licensed', plan: v.plan };
    }
    // 通行證壞掉或過期 → 不直接拒絕，往下走免費層。
    // 使用者可能只是續期失敗，讓他至少還有免費額度可用。
  }

  // ---- 免費層 ----
  const k = freeKey(auth.installId);
  let used = 0;
  try { used = parseInt((await env.SUBS.get(k)) || '0', 10) || 0; } catch (e) { used = 0; }
  const left = Math.max(0, FREE_DAILY_LINES - used);
  if (left <= 0) return { allowed: 0, reason: 'free_quota_exhausted', plan: 'trial' };
  return { allowed: Math.min(wantLines, left), reason: 'free', plan: 'trial', used, left };
}

/**
 * 記錄免費層用量。
 *
 * 取樣寫入（每 5 句才寫一次並一次加 5），因為 KV 免費額度是 1,000 puts/天，
 * 逐句寫必定撞爆（坑 #19 的教訓）。額度因此是近似值，但配合成本熔斷已足夠。
 */
async function noteFreeUsage(env, installId, n) {
  if (!n) return;
  if (Math.random() >= n / 5) return;                 // 期望值等於 n/5 次寫入
  const k = freeKey(installId);
  const cur = parseInt((await env.SUBS.get(k)) || '0', 10) || 0;
  await env.SUBS.put(k, String(cur + 5), { expirationTtl: 2 * 86400 });
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
  if (env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV) {
    const expect = await ecpayMac(p, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
    if (!safeEqual(String(p.CheckMacValue || '').toUpperCase(), expect)) {
      return new Response('0|bad mac', { status: 401 });
    }
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
  const email = String(p.CustomerEmail || p.email || '').trim();
  const plan = planFromItem(p.ItemName || p.plan);
  const key = normLicense(licenseKeyNew());
  const lic = {
    plan, email, orderId,
    expiresAt: planExpiry(plan),
    devices: [], createdAt: nowSec(), revoked: false,
    source: 'webhook',
  };
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  await env.SUBS.put(dedupeKey, key, { expirationTtl: 400 * 86400 });
  if (email) {
    const ik = `licmail:${email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    if (!arr.includes(key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
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
 *   3. 已刪除的碼不再能啟用（KV 讀不到 → 404），但**已經發出去的通行證
 *      仍會在有效期內運作**——那是刻意的，避免誤刪立刻把人踢下線，
 *      最長 14 天內你還有機會重新發碼補救。
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
  const plan = PLANS[body.plan] ? String(body.plan) : 'season';
  const lic = {
    plan,
    email: String(body.email || ''),            // 來自金流，用於補發，不另外收集
    orderId: String(body.orderId || ''),
    // 期限一律由伺服器依方案算。只有明確傳 expiresAt 時才覆寫（客服調整用）。
    expiresAt: body.expiresAt ? Number(body.expiresAt) : planExpiry(plan),
    devices: [],
    createdAt: nowSec(),
    revoked: false,
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
  });
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

function err(message, status = 400) {
  return json({ error: message }, status);
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
  await env.SUBS.put(bundleKey(cid), JSON.stringify(bundle));
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
async function handleTranslate(request, env, ip, auth) {
  if (await rateLimited(env, auth.installId === 'legacy' ? ip : auth.installId)) {
    return err('rate limited', 429);
  }

  // 成本熔斷：超過當日上限就停掉會花錢的路徑。
  // **共用快取的讀取不受影響**——已翻好的影片完全照常，
  // 退化的只是「新影片暫時不翻」，不是整個壞掉。
  if (await overBudget(env)) {
    return json({
      lines: {}, translated: 0,
      error: '今日翻譯額度已用盡，已翻譯過的影片仍可正常觀看',
      overBudget: true,
    }, 503);
  }

  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const cid = String(body.cid || 'misc');
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (!input.length) return err('缺少 lines');

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
    }, 402);
  }
  if (input.length > 200) return err('一次最多 200 句');

  // 每句的長度上限。沒有這個限制的話，200 句 × 每句 100KB = 20MB 進模型，
  // 一次請求就能燒掉大量 token —— **成本放大攻擊**。
  // 真實字幕一句不會超過 300 字元，1,000 已經非常寬鬆。
  const MAX_LINE_LEN = 1000;
  if (input.some((l) => typeof l === 'string' && l.length > MAX_LINE_LEN)) {
    return err(`單句長度不可超過 ${MAX_LINE_LEN} 字元`);
  }

  // 1) 讀一次 bundle 當快取（取代先前逐句讀 line: key）
  const bundle = await readBundle(env, cid);
  const result = {};
  const added = {};       // 這次請求新翻出來的，寫回時只合併這些
  const missing = [];
  for (const raw of input) {
    const en = String(raw || '').trim();
    if (!en) continue;
    const k = normKey(en);
    if (!k) continue;
    if (bundle.lines[k]) { result[k] = bundle.lines[k]; continue; }
    missing.push({ en, k });
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


/** 管理端路由。權限已在外層驗過，這裡只管分派。 */
async function routeAdmin(path, request, env, url) {
  const m = request.method;

  if (path === '/v1/admin/license/issue' && m === 'POST') return handleLicenseIssue(request, env);
  // license/revoke 與 license/lookup 已由 license/patch（revoked 欄位）與
  // license/list（?q= 可搜 email）取代。**同一件事不留兩種做法**——
  // 後台只會用其中一條，另一條遲早會漂掉而沒人發現。
  if (path === '/v1/admin/license/list' && m === 'GET') return handleLicenseList(request, env, url);
  if (path === '/v1/admin/license/patch' && m === 'POST') return handleLicensePatch(request, env);
  if (path === '/v1/admin/license/delete' && m === 'POST') return handleLicenseDelete(request, env);
  if (path === '/v1/admin/reports/patch' && m === 'POST') return handleReportPatch(request, env);
  if (path === '/v1/admin/reports' && m === 'GET') return handleReportList(env, url);

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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isAdmin = path.startsWith('/v1/admin/');

    // 預檢。管理端點要帶 CORS，否則本機開的後台連問都問不到。
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: isAdmin ? ADMIN_CORS : CORS });
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
      // 金流回呼。**不需要用戶端權杖**（金流平台不會帶），改用簽章驗證。
      if (path === '/v1/payment/webhook' && request.method === 'POST') {
        return handlePaymentWebhook(request, env);
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
  },
};
