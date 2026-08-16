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
 *   POST /v1/complete                  標記整支已完整收割（需 CLIENT_TOKEN）
 *
 * 環境變數（wrangler secret put）
 *   ANTHROPIC_API_KEY   Anthropic 金鑰
 *   ADMIN_TOKEN         上傳用的管理權杖
 *   CLIENT_TOKEN        用戶端權杖
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
const REMOTE_CONFIG = {
  version: 1,
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
// 工具
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-client-token,x-admin-token',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
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
async function handleTranslate(request, env, ip) {
  if (await rateLimited(env, ip)) return err('rate limited', 429);

  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const cid = String(body.cid || 'misc');
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (!input.length) return err('缺少 lines');
  if (input.length > 200) return err('一次最多 200 句');

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

  // 2) 未命中的才呼叫模型
  let translated = 0;
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  for (let i = 0; i < missing.length; i += BATCH_MAX) {
    const chunk = missing.slice(i, i + BATCH_MAX);
    try {
      const { out, usage } = await translateBatch(env, chunk.map((m) => m.en));
      for (const m of chunk) {
        const zh = out[m.en];
        if (!zh) continue;
        result[m.k] = zh;
        bundle.lines[m.k] = zh;       // 本次請求的快取，避免同批重複
        added[m.k] = zh;              // 寫回時只合併這些，見 mergeWrite
        translated++;
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
  if (translated) await mergeWrite(env, cid, added);

  return json({
    cid,
    lines: result,
    requested: input.length,
    cached: input.length - missing.length,
    translated,
    usage: usageTotals,
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
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
        return json(cfg, 200, { 'cache-control': 'public, max-age=60' });
      }

      // 熱修入口：改選擇器不用重新部署，也不用等商店審核
      if (path === '/v1/config' && request.method === 'POST') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return err('unauthorized', 401);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sites)) return err('需要 { version, sites: [...] }');
        await env.SUBS.put('config', JSON.stringify(body));
        return json({ ok: true, version: body.version, sites: body.sites.length });
      }

      // 出事時的還原鍵：刪掉 KV 就回到內建預設
      if (path === '/v1/config' && request.method === 'DELETE') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return err('unauthorized', 401);
        await env.SUBS.delete('config');
        return json({ ok: true, reverted: true, version: REMOTE_CONFIG.version });
      }

      if (path === '/v1/subs' && request.method === 'GET') {
        if (request.headers.get('x-client-token') !== env.CLIENT_TOKEN) return err('unauthorized', 401);
        return handleGetSubs(request, env, url);
      }

      if (path === '/v1/subs' && request.method === 'POST') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return err('unauthorized', 401);
        return handlePostSubs(request, env);
      }

      if (path === '/v1/translate' && request.method === 'POST') {
        if (request.headers.get('x-client-token') !== env.CLIENT_TOKEN) return err('unauthorized', 401);
        return handleTranslate(request, env, ip);
      }

      if (path === '/v1/complete' && request.method === 'POST') {
        if (request.headers.get('x-client-token') !== env.CLIENT_TOKEN) return err('unauthorized', 401);
        return handleComplete(request, env);
      }

      return err('not found', 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
