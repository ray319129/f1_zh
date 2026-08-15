// ==UserScript==
// @name         F1TV 即時繁中字幕 (Claude)
// @namespace    f1tv-zh-subs
// @version      4.4.0
// @description  攔截 F1TV 字幕，經 Claude Haiku 翻成繁體中文雙語顯示。VTT 前瞻預譯 + 批次翻譯 + prompt caching
// @author       you
// @match        https://f1tv.formula1.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.anthropic.com
// @connect      formula1.com
// @connect      workers.dev
// @connect      *
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // 網路層必須 patch 頁面環境的 fetch/XHR，不是沙箱的
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // ==========================================================================
  // 1. 設定區
  // ==========================================================================
  const CFG = {
    model: 'claude-haiku-4-5',
    maxTokens: 200,              // 逐句模式
    batchMaxTokens: 2000,        // 批次模式
    temperature: 0,
    useCache: true,

    prefetch: true,              // VTT 前瞻預譯（成本殺手）
    batchSize: 15,               // 一次 API 呼叫翻幾句（湊滿就立刻送）
    flushDelayMs: 8000,          // 還沒量到提前量之前的預設等待
    adaptiveFlush: true,         // 量測「cue 入列 → 畫面顯示」的實際提前量，自動用掉其中一半。
                                 // 固定值是瞎猜：等太短批次湊不大，等太長漏接率飆升反而更貴

    fullPrefetch: true,          // 重播模式：從 HLS manifest 找出字幕播放清單，整軌抓下來一次翻完
    fetchConcurrency: 3,         // 同時抓幾個分段（別開太大，避免對 CDN 造成突發負載）
    fetchGapMs: 60,              // 每抓一段之間的間隔
    progressive: false,          // 英文先上、中文後補。語速快時舊句譯文會被判過期而不顯示，預設關閉
    workerInject: true,          // 攔截 blob worker，把 hook 注入播放器的 worker 內部
    netlogAll: true,             // 記錄所有網路請求（探索用；確定架構後可關掉）

    showEnglish: true,
    fontSize: 26,
    bottomPct: 8,
    holdMs: 7000,

    maxQueue: 3,
    timeoutMs: 20000,            // 批次比較久，拉長
    debounceMs: 150,
    hideNativeCC: true,

    captionRoot: '.tm-subtitle-region-container',
    captionLabel: '.tm-ui-subtitle-label',

    // ---- 共用譯文後端（backend/ 目錄）----
    // 設定 URL 後才啟用。啟用時：換影片先向後端要整支譯文，命中就完全不用呼叫 API。
    // 後端無法連線時全自動退回本機翻譯，功能不受影響。
    backendUrl: '',              // 例：https://f1zh-api.xxx.workers.dev（用選單設定）
    backendUpload: true,         // 收割完是否把譯文上傳共用（需 ADMIN_TOKEN）

    // 韌性設定：F1TV 是 SPA，切換視角/畫質/影片時播放器會銷毀重建 DOM。
    // 不能相信「掛上 observer 就永遠有效」，必須主動輪詢驗證。
    captionPollMs: 250,          // 主動讀取畫面字幕的間隔（observer 只是加速器）
    noCaptionWarnMs: 45000,      // 播放中但這麼久沒字幕就提示使用者
    showCaptionHint: true,       // 在疊字層顯示「請確認 CC 已開啟」提示

    debug: false,
  };

  // ==========================================================================
  // 2. System Prompt（2026 賽季，>4096 tokens 以觸發 prompt caching）
  //    逐句與批次兩種模式共用同一份，才能共用同一份快取
  // ==========================================================================
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

  // ==========================================================================
  // 3. 狀態
  // ==========================================================================
  let enabled = true;
  const memo = new Map();            // normKey -> 譯文
  const MEMO_MAX = 5000;             // 預譯量大，放寬
  const history = [];
  const queue = [];
  let inflight = false;
  let lastRaw = '';
  let hideTimer = null, domTimer = null;
  let cacheChecked = false, vttAnnounced = false, booted = false;
  let playbackSecs = 0, prefetchWarned = false;   // 只在真的有播放時才計時與警告

  const prefetchSeen = new Set();
  const prefetchQueue = [];
  let prefetchBusy = false;

  const netlog = [];
  const manifests = [];              // 攔到的 HLS/DASH manifest，用來評估「整支一次抓」的可行性
  const enqueuedAt = new Map();      // normKey -> 入列時間，用來量測提前量
  const leadSamples = [];

  const stats = {
    calls: 0, batchCalls: 0, hits: 0, errors: 0, totalMs: 0,
    inTok: 0, outTok: 0, cacheWrite: 0, cacheRead: 0,
    vttSeen: 0, vttParsed: 0, prefetched: 0,
    workers: 0, workerCues: 0, workerPatched: 0, workerVtt: 0,
    playlistSegs: 0, segFetched: 0, segFailed: 0,
    beDownloaded: 0, beUploaded: 0, beHits: 0, beErrors: 0,
  };

  // 本次影片看過／翻過的所有 normKey，用來決定要上傳哪些。切換影片時清空。
  const sessionKeys = new Set();

  const log = (...a) => CFG.debug && console.log('%c[f1zh]', 'color:#e10600;font-weight:bold', ...a);

  // ==========================================================================
  // 4. 文字正規化與快取
  // ==========================================================================
  function clean(s) {
    return (s || '')
      .replace(/<[^>]*>/g, ' ')          // VTT 行內標籤 <v Speaker> <i> 等
      .replace(/\[[^\]]*\]/g, ' ')       // [MUSIC] [APPLAUSE]
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 快取一律用正規化後的鍵：忽略大小寫與標點差異，
  // 讓 VTT 原文和畫面上渲染的文字能對得起來，順便提高命中率
  function normKey(s) {
    try {
      return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function memoSet(text, zh) {
    const k = normKey(text);
    if (!k) return;
    memo.set(k, zh);
    sessionKeys.add(k);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  function memoGet(text) { return memo.get(normKey(text)); }

  // ==========================================================================
  // 5. 疊字層
  // ==========================================================================
  const box = document.createElement('div');
  box.id = 'f1zh-box';
  const zhEl = document.createElement('div'); zhEl.id = 'f1zh-zh';
  const enEl = document.createElement('div'); enEl.id = 'f1zh-en';
  box.appendChild(zhEl);
  box.appendChild(document.createElement('br'));
  box.appendChild(enEl);

  function injectStyles() {
    GM_addStyle(`
      #f1zh-box{
        position:fixed; z-index:2147483647; pointer-events:none;
        transform:translateX(-50%); text-align:center;
        font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
        line-height:1.35; opacity:0; transition:opacity .12s ease;
      }
      #f1zh-box.on{opacity:1}
      #f1zh-zh{
        color:#fff; font-weight:700; background:rgba(0,0,0,.72);
        border-radius:6px; padding:4px 14px; display:inline-block;
        text-shadow:0 2px 4px rgba(0,0,0,.9);
      }
      #f1zh-en{
        color:#c9c9c9; font-weight:400; background:rgba(0,0,0,.55);
        border-radius:5px; padding:2px 12px; display:inline-block; margin-top:3px;
        text-shadow:0 1px 3px rgba(0,0,0,.9);
      }
    `);
  }

  let hideStyleEl = null;
  function applyHideNative() {
    if (!document.head) return;
    if (CFG.hideNativeCC && !hideStyleEl) {
      hideStyleEl = document.createElement('style');
      // 用 opacity 而非 visibility：visibility:hidden 會讓 innerText 讀不到內容，
      // 而且我們還要靠這個容器的矩形定位，必須保留版面
      hideStyleEl.textContent = `${CFG.captionRoot}{opacity:0 !important}`;
      document.head.appendChild(hideStyleEl);
    } else if (!CFG.hideNativeCC && hideStyleEl) {
      hideStyleEl.remove(); hideStyleEl = null;
    }
  }

  function mount() {
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (host && box.parentElement !== host) host.appendChild(box);
  }

  function mainVideoRect() {
    let best = null;
    document.querySelectorAll('video').forEach(v => {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) return;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    });
    return best;
  }

  function reposition() {
    const vr = mainVideoRect();
    let r = null, tight = false;
    const c = document.querySelector(CFG.captionRoot);
    if (c) {
      const cr = c.getBoundingClientRect();
      if (cr.width > 40 && cr.height > 8) { r = cr; tight = true; }
    }
    if (!r) r = vr;
    if (!r) return;

    box.style.left = (r.left + r.width / 2) + 'px';
    box.style.bottom = tight
      ? (window.innerHeight - r.bottom) + 'px'
      : (window.innerHeight - r.bottom + r.height * CFG.bottomPct / 100) + 'px';
    box.style.maxWidth = (r.width * 0.95) + 'px';

    const scale = Math.max(0.5, (vr ? vr.width : r.width) / 1280);
    zhEl.style.fontSize = Math.round(CFG.fontSize * scale) + 'px';
    enEl.style.fontSize = Math.round(CFG.fontSize * 0.62 * scale) + 'px';
    enEl.style.display = CFG.showEnglish ? 'inline-block' : 'none';
  }

  let displayRaw = '';

  function show(zh, en) {
    if (!enabled) return;
    mount(); reposition();
    zhEl.style.display = 'inline-block';
    zhEl.style.opacity = '1';
    zhEl.textContent = zh;
    enEl.textContent = en || '';
    enEl.style.display = CFG.showEnglish ? 'inline-block' : 'none';
    displayRaw = en || '';
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), CFG.holdMs);
  }

  // 翻譯還沒回來時，先把英文推上畫面。使用者不會看到空白等待期，
  // 中文到了再原地覆蓋。這在逐句模式下把「感知延遲」實質降到 0。
  function showPending(en) {
    if (!enabled) return;
    mount(); reposition();
    zhEl.textContent = '';
    zhEl.style.display = 'none';
    enEl.textContent = en;
    enEl.style.display = 'inline-block';
    enEl.style.opacity = '0.85';
    displayRaw = en;
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), CFG.holdMs);
  }

  // ==========================================================================
  // 6. API
  // ==========================================================================
  function systemBlocks() {
    const b = { type: 'text', text: SYSTEM_PROMPT };
    if (CFG.useCache) b.cache_control = { type: 'ephemeral' };
    return [b];
  }

  function apiPost(path, body, timeout) {
    return new Promise((resolve, reject) => {
      const key = GM_getValue('apiKey', '');
      if (!key) return reject(new Error('尚未設定 API key'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/' + path,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        data: JSON.stringify(body),
        timeout: timeout || CFG.timeoutMs,
        onload: (res) => {
          if (res.status !== 200) {
            return reject(new Error(`HTTP ${res.status} ${String(res.responseText).slice(0, 200)}`));
          }
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('回應不是合法 JSON')); }
        },
        onerror: () => reject(new Error('網路錯誤')),
        ontimeout: () => reject(new Error('逾時')),
      });
    });
  }

  function tallyUsage(usage) {
    if (!usage) return;
    stats.inTok += usage.input_tokens || 0;
    stats.outTok += usage.output_tokens || 0;
    stats.cacheWrite += usage.cache_creation_input_tokens || 0;
    stats.cacheRead += usage.cache_read_input_tokens || 0;

    if (!cacheChecked && CFG.useCache) {
      cacheChecked = true;
      const w = usage.cache_creation_input_tokens || 0;
      const r = usage.cache_read_input_tokens || 0;
      if (w || r) {
        console.log(`%c[f1zh] ✅ Prompt caching 生效（寫入 ${w} / 讀取 ${r} tokens）`,
          'color:#0a0;font-weight:bold');
      } else {
        console.warn('[f1zh] ⚠ Prompt caching 未生效 — system prompt 可能未達 4096 tokens。');
      }
    }
  }

  function textOfResponse(data) {
    if (data.stop_reason === 'refusal') throw new Error('模型拒絕回應');
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }

  // ==========================================================================
  // 7. 逐句翻譯（VTT 沒命中時的後備）
  // ==========================================================================
  function buildUser(text) {
    const ctx = history.slice(-2).join(' ');
    return (ctx ? `【前文，僅供理解代名詞，不要翻譯這段】\n${ctx}\n\n` : '') +
           `【待翻譯】\n${text}`;
  }

  async function translateOne(text) {
    const data = await apiPost('messages', {
      model: CFG.model,
      max_tokens: CFG.maxTokens,
      temperature: CFG.temperature,
      system: systemBlocks(),
      messages: [{ role: 'user', content: buildUser(text) }],
    });
    tallyUsage(data.usage);
    return textOfResponse(data);
  }

  function push(raw) {
    if (!enabled) return;
    const text = clean(raw);
    if (!text || text.length < 2) return;
    if (text === lastRaw) return;
    lastRaw = text;

    // 量測提前量：這句 cue 是多久以前從 VTT 進到佇列的？
    // 這就是我們能拿來湊批次的預算，不用碰 VTT 時間軸也不用跟 currentTime 對齊。
    const nk = normKey(text);
    const t0 = enqueuedAt.get(nk);
    if (t0) {
      leadSamples.push(Date.now() - t0);
      if (leadSamples.length > 40) leadSamples.shift();
      enqueuedAt.delete(nk);
    }

    const cached = memoGet(text);
    if (cached) { stats.hits++; show(cached, text); remember(text); return; }

    if (CFG.progressive) showPending(text);   // 英文先上，中文稍後覆蓋

    queue.push(text);
    while (queue.length > CFG.maxQueue) queue.shift();
    drain();
  }

  function remember(text) {
    history.push(text);
    if (history.length > 4) history.shift();
  }

  async function drain() {
    if (inflight || !queue.length) return;
    inflight = true;
    const text = queue.shift();
    const t0 = performance.now();
    try {
      const zh = await translateOne(text);
      const ms = Math.round(performance.now() - t0);
      stats.calls++; stats.totalMs += ms;
      log(ms + 'ms 逐句', text, '→', zh);
      if (zh) {
        memoSet(text, zh);
        // 譯文回來時畫面若已經換到下一句，就只存快取不顯示，
        // 免得舊句的中文蓋掉新句的英文
        if (!CFG.progressive || !displayRaw || displayRaw === text) show(zh, text);
        else log('已過期，只存快取:', text);
      }
      remember(text);
    } catch (err) {
      stats.errors++;
      console.warn('[f1zh] 逐句翻譯失敗:', err.message);
      if (/401|authentication|invalid.*key/i.test(err.message)) {
        show('⚠ API key 無效，請用油猴選單重新設定', text);
      }
    } finally {
      inflight = false;
      if (queue.length) drain();
    }
  }

  // ==========================================================================
  // 8. VTT 攔截 —— 成本殺手
  //    只取「文字」不取時間軸：顯示時機仍交給播放器 + DOM 監聽，
  //    VTT 的作用是讓我們提前知道等一下會講什麼，先批次翻好放進快取。
  // ==========================================================================
  function isVttish(url, contentType) {
    const u = String(url || '');
    if (/text\/vtt|application\/x-subrip/i.test(contentType || '')) return true;
    return /\.vtt(\?|$)|\.webvtt(\?|$)|[/_-](sub|subs|subtitle|subtitles|caption|captions|text)[/_-]/i.test(u);
  }

  function noteUrl(url, kind) {
    netlog.push({ kind, url: String(url).slice(0, 220), t: new Date().toISOString().slice(11, 19) });
    if (netlog.length > 250) netlog.shift();
  }

  // 從任意物件裡撈出 cue 文字（worker postMessage 的內容形狀未知，只能廣撒）
  function ingestCueText(t) {
    if (!CFG.prefetch || !enabled) return 0;
    const c = clean(t);
    if (!c || c.length < 2) return 0;
    const k = normKey(c);
    if (!k || prefetchSeen.has(k) || memo.has(k)) return 0;
    prefetchSeen.add(k);
    prefetchQueue.push(c);
    return 1;
  }

  function scanForCues(data, depth) {
    depth = depth || 0;
    if (depth > 5 || data == null) return 0;

    if (typeof data === 'string') {
      // 整份 WebVTT
      if (data.length > 30 && data.indexOf('-->') !== -1) { onVttPayload(data, 'worker-msg'); return 0; }
      return 0;
    }
    if (typeof data !== 'object') return 0;

    if (Array.isArray(data)) {
      let n = 0;
      for (let i = 0; i < Math.min(data.length, 300); i++) n += scanForCues(data[i], depth + 1);
      return n;
    }

    // 看起來像 cue 物件：有 text 又有時間欄位
    const txt = (typeof data.text === 'string') ? data.text
              : (typeof data.payload === 'string') ? data.payload : null;
    const hasTime = ['startTime', 'start', 'startTimeMs', 'begin', 'pts']
      .some(k => typeof data[k] === 'number');
    if (txt && hasTime) return ingestCueText(txt);

    let n = 0;
    const keys = Object.keys(data);
    for (let i = 0; i < Math.min(keys.length, 40); i++) n += scanForCues(data[keys[i]], depth + 1);
    return n;
  }

  // ==========================================================================
  // 共用譯文後端
  // 所有人看同一支影片拿到同一份英文字幕，所以譯文可以共用。
  // 命中後端 = 該句零 API 成本、零延遲。連不上時全自動退回本機翻譯。
  // ==========================================================================
  function backendOn() { return !!GM_getValue('backendUrl', CFG.backendUrl); }
  function backendBase() { return String(GM_getValue('backendUrl', CFG.backendUrl)).replace(/\/+$/, ''); }

  function backendRequest(method, path, body, headers) {
    return new Promise((resolve, reject) => {
      const base = backendBase();
      if (!base) return reject(new Error('未設定後端網址'));
      GM_xmlhttpRequest({
        method,
        url: base + path,
        headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
        data: body ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            return reject(new Error(`HTTP ${res.status} ${String(res.responseText).slice(0, 160)}`));
          }
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('回應不是合法 JSON')); }
        },
        onerror: () => reject(new Error('網路錯誤')),
        ontimeout: () => reject(new Error('逾時')),
      });
    });
  }

  // 換影片時呼叫：把整支影片已有的譯文抓下來灌進本機快取
  async function backendPullBundle(cid) {
    if (!backendOn() || !cid) return;
    try {
      const d = await backendRequest('GET', `/v1/subs?cid=${encodeURIComponent(cid)}`, null,
        { 'x-client-token': GM_getValue('clientToken', '') });
      const lines = d.lines || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) {
        if (!k || !zh || memo.has(k)) continue;
        memo.set(k, zh);
        prefetchSeen.add(k);      // 已有譯文，不用再排進預譯佇列
        n++;
      }
      stats.beDownloaded += n;
      if (n) {
        console.log(`%c[f1zh] ☁ 從共用快取取得 ${n} 句譯文（cid ${cid}），這些不會再花錢`,
          'color:#0a0;font-weight:bold');
      }
    } catch (e) {
      stats.beErrors++;
      log('後端下載失敗（不影響功能）:', e.message);
    }
  }

  // 收割完成後呼叫：把本機翻好的譯文貢獻回共用快取
  async function backendPushBundle(cid) {
    if (!backendOn() || !CFG.backendUpload || !cid) return;
    const admin = GM_getValue('adminToken', '');
    if (!admin) return;                       // 沒有管理權杖就不上傳
    const lines = {};
    let n = 0;
    for (const k of sessionKeys) {
      const zh = memo.get(k);
      if (zh) { lines[k] = zh; n++; }
    }
    if (!n) return;
    try {
      const d = await backendRequest('POST', '/v1/subs', { cid, lines }, { 'x-admin-token': admin });
      stats.beUploaded += (d.added || 0);
      console.log(`%c[f1zh] ☁ 已上傳 ${d.added} 句到共用快取（該影片累計 ${d.total} 句）`,
        'color:#0a0;font-weight:bold');
    } catch (e) {
      stats.beErrors++;
      console.warn('[f1zh] 後端上傳失敗:', e.message);
    }
  }

  // ==========================================================================
  // 整軌預抓（重播專用）
  // master m3u8 裡的 #EXT-X-MEDIA:TYPE=SUBTITLES 帶著字幕播放清單的位址，
  // 那份清單列出整支影片每一個 VTT 分段。全部抓下來就能一次翻完，
  // 之後整場零呼叫、100% 命中，也不怕使用者拖動進度條。
  // ==========================================================================
  function findSubtitlePlaylist() {
    // 路徑 1（最穩）：worker 本來就會去抓字幕的 media playlist，我們的 hook 也會攔到。
    // 直接用那一份 —— 網址是原封不動的，body 也已經在手上，連 fetch 都不用，
    // 更不會有相對路徑解析錯誤的風險。
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) {
        return { url: m.url, body: m.body, lang: 'eng', how: '直接攔到字幕清單' };
      }
    }
    // 路徑 2：從 master 的 #EXT-X-MEDIA:TYPE=SUBTITLES 解析相對位址
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (!/#EXT-X-STREAM-INF/i.test(m.body)) continue;
      const re = /#EXT-X-MEDIA:([^\n]*TYPE=SUBTITLES[^\n]*)/gi;
      let mt, best = null;
      while ((mt = re.exec(m.body))) {
        const attrs = mt[1];
        const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1];
        if (!uri) continue;
        const lang = (attrs.match(/LANGUAGE="([^"]+)"/i) || [])[1] || '';
        if (!best) best = { uri, lang };
        if (/^en/i.test(lang)) { best = { uri, lang }; break; }   // 優先英文軌
      }
      if (!best) continue;
      try {
        return { url: new URL(best.uri, m.url).href, body: null, lang: best.lang, how: '由 master 解析' };
      } catch (e) { /* master 網址不完整，換下一份 */ }
    }
    return null;
  }

  // CDN 對播放器開了 CORS，原生 fetch 通常可行；失敗才退回 GM_xmlhttpRequest
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const viaGM = () => {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 15000,
          onload: (res) => res.status === 200 ? resolve(res.responseText)
                                             : reject(new Error('HTTP ' + res.status)),
          onerror: () => reject(new Error('網路錯誤')),
          ontimeout: () => reject(new Error('逾時')),
        });
      };
      try {
        fetch(url, { credentials: 'omit' })
          .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
          .then(t => { settled = true; resolve(t); })
          .catch(() => { if (!settled) viaGM(); });
      } catch (e) { viaGM(); }
    });
  }

  function parseMediaPlaylist(body, baseUrl) {
    const segs = [];
    let dur = 0;
    body.replace(/\r/g, '').split('\n').forEach(raw => {
      const t = raw.trim();
      if (!t) return;
      if (/^#EXTINF:/i.test(t)) { dur = parseFloat(t.slice(8)) || 0; return; }
      if (t[0] === '#') return;
      try { segs.push({ url: new URL(t, baseUrl).href, dur }); } catch (e) { /* noop */ }
      dur = 0;
    });
    return { segs, isVod: /#EXT-X-ENDLIST/i.test(body) };
  }

  let fullPrefetchStarted = false;
  let prefetchAttempts = 0;
  const PREFETCH_MAX_ATTEMPTS = 3;

  async function fetchSegments(list) {
    let idx = 0;
    const worker = async () => {
      while (idx < list.length && enabled && CFG.fullPrefetch) {
        const s = list[idx++];
        try {
          const t = await httpGet(s.url);
          stats.segFetched++;
          onVttPayload(t, s.url);
        } catch (e) { stats.segFailed++; }
        if (CFG.fetchGapMs) await new Promise(r => setTimeout(r, CFG.fetchGapMs));
      }
    };
    harvesting = true;
    try {
      await Promise.all(new Array(Math.max(1, CFG.fetchConcurrency)).fill(0).map(worker));
    } finally {
      harvesting = false;
    }
    console.log(`%c[f1zh] ✅ 整軌預抓完成：成功 ${stats.segFetched} 段、失敗 ${stats.segFailed} 段，` +
      `待翻 ${prefetchQueue.length} 句`, 'color:#0a0;font-weight:bold');
    drainPrefetch();
    // 等佇列翻完再上傳，讓共用快取拿到完整的一支
    waitForPrefetchIdleThenUpload();
  }

  let uploadTimer = null;
  function waitForPrefetchIdleThenUpload() {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      if (prefetchBusy || prefetchQueue.length) { waitForPrefetchIdleThenUpload(); return; }
      backendPushBundle(currentContentId());
    }, 5000);
  }

  async function startFullPrefetch(force) {
    if (fullPrefetchStarted || !CFG.fullPrefetch || !CFG.prefetch || !enabled) return;
    // 失敗就別再無限重試 —— 這個函式掛在 1.5 秒的輪詢裡，
    // 沒有上限的話會一直洗版並反覆打 CDN
    if (!force && prefetchAttempts >= PREFETCH_MAX_ATTEMPTS) return;
    const sp = findSubtitlePlaylist();
    if (!sp) return;
    fullPrefetchStarted = true;
    prefetchAttempts++;
    try {
      console.log(`%c[f1zh] 🎯 找到字幕播放清單（${sp.lang || '?'}，${sp.how}），開始整軌預抓`,
        'color:#0a0;font-weight:bold');
      const body = sp.body || await httpGet(sp.url);   // 已經有內容就不用再抓一次
      const { segs, isVod } = parseMediaPlaylist(body, sp.url);
      stats.playlistSegs = segs.length;

      if (!isVod) {
        // 直播的播放清單是滑動視窗，未來的字幕根本還不存在。
        // 這種情況維持 worker 即時攔截就好。
        console.log('[f1zh] 偵測到直播（無 EXT-X-ENDLIST），維持即時攔截模式');
        return;
      }
      console.log(`[f1zh] 字幕分段共 ${segs.length} 個，開始抓取`);

      // 從目前播放位置開始排序，讓馬上要用到的先翻，不要先去翻片尾
      const v = document.querySelector('video');
      const cur = (v && isFinite(v.currentTime)) ? v.currentTime : 0;
      let acc = 0, startIdx = 0;
      for (let i = 0; i < segs.length; i++) {
        if (acc + segs[i].dur > cur) { startIdx = i; break; }
        acc += segs[i].dur;
      }
      await fetchSegments(segs.slice(startIdx).concat(segs.slice(0, startIdx)));
    } catch (e) {
      fullPrefetchStarted = false;
      const left = PREFETCH_MAX_ATTEMPTS - prefetchAttempts;
      console.warn(`[f1zh] 整軌預抓失敗（${e.message}），維持即時攔截。` +
        (left > 0 ? `還會重試 ${left} 次。` : '已達重試上限，不再自動重試（可用選單手動觸發）。'));
      console.warn('[f1zh] 使用的清單網址:', sp.url);
    }
  }

  // ---- 注入 blob worker ----
  // F1TV 的串流跑在 blob: worker 裡（7MB WASM）。worker 有自己的全域環境，
  // 主執行緒的 fetch/XHR patch 完全碰不到。
  // 解法：攔截 URL.createObjectURL —— 在 worker 腳本 blob 被建立的那一刻，
  // 讀出原始碼、把 hook 前置進去、回傳改造後的 blob URL。
  // hook 在 worker 內部 patch 它自己的 fetch/XHR，透過 BroadcastChannel 把 VTT 送回主執行緒
  //（不用 postMessage，避免污染播放器自己的訊息通道而弄壞播放）。
  const WORKER_HOOK = `
(function(){
  try{
    var BC=null; try{ BC=new BroadcastChannel('f1zh-vtt'); }catch(e){}
    function send(o){ try{ if(BC) BC.postMessage(o); }catch(e){} }
    function emit(t,u){
      try{
        if(!t || typeof t!=='string') return;
        // 網址絕對不能截斷：F1TV 的 master 網址帶著很長的 base64 授權 token，
        // 截掉之後相對路徑解析會把 token 那段吃掉，CDN 直接回 400。
        var url=String(u||'');
        if(t.indexOf('-->')!==-1){ send({vtt:t, url:url}); return; }
        // HLS / DASH manifest：裡面會列出整支影片所有字幕分段的位置。
        // 兩小時的正賽字幕清單可能有上千段，別切太短。
        if(/#EXTM3U|<MPD/i.test(t.slice(0,400))) send({manifest:t.slice(0,600000), url:url});
      }catch(e){}
    }
    // 只碰小的、文字類的回應，絕不 clone 影片分段（會吃記憶體）
    function interesting(url,ct,len){
      if(/text|vtt|json|xml|mpegurl|dash/i.test(ct||'')) return true;
      if(/\\.vtt|\\.webvtt|\\.m3u8|\\.mpd|subtitle|caption|\\bsub\\b|\\btext\\b/i.test(String(url||''))) return true;
      var n=parseInt(len||'0',10);
      return n>0 && n<300000;
    }
    var of=self.fetch;
    if(typeof of==='function'){
      self.fetch=function(){
        var args=arguments, p=of.apply(this,args);
        try{
          var a0=args[0], u=(typeof a0==='string')?a0:((a0&&a0.url)||'');
          p.then(function(r){
            try{
              var h=r.headers, ct=(h&&h.get)?h.get('content-type'):'', cl=(h&&h.get)?h.get('content-length'):'';
              if(!interesting(u,ct,cl)) return;
              r.clone().text().then(function(t){emit(t,u);}).catch(function(){});
            }catch(e){}
          }).catch(function(){});
        }catch(e){}
        return p;
      };
    }
    var XP=self.XMLHttpRequest && self.XMLHttpRequest.prototype;
    if(XP && !XP.__f1zh){
      XP.__f1zh=true;
      var oo=XP.open, os=XP.send;
      XP.open=function(m,u){ try{this.__u=u;}catch(e){} return oo.apply(this,arguments); };
      XP.send=function(){
        try{
          this.addEventListener('load',function(){
            try{
              var ct=this.getResponseHeader?this.getResponseHeader('content-type'):'';
              var cl=this.getResponseHeader?this.getResponseHeader('content-length'):'';
              if(!interesting(this.__u,ct,cl)) return;
              var t=null, rt=this.responseType;
              if(rt===''||rt==='text') t=this.responseText;
              else if(rt==='arraybuffer'&&this.response) t=new TextDecoder('utf-8',{fatal:false}).decode(new Uint8Array(this.response));
              emit(t,this.__u);
            }catch(e){}
          });
        }catch(e){}
        return os.apply(this,arguments);
      };
    }
  }catch(e){}
})();
`;

  function installBroadcastListener() {
    try {
      const bc = new BroadcastChannel('f1zh-vtt');
      bc.onmessage = (ev) => {
        try {
          const d = ev.data;
          if (!d) return;
          if (typeof d.vtt === 'string') {
            stats.workerVtt++;
            if (d.url) noteUrl(d.url, 'worker:VTT');
            onVttPayload(d.vtt, d.url || 'worker');
          } else if (typeof d.manifest === 'string') {
            if (!manifests.some(m => m.url === d.url)) {
              manifests.push({ url: d.url, body: d.manifest });
              if (manifests.length > 12) manifests.shift();
              noteUrl(d.url, 'worker:MANIFEST');
              console.log('%c[f1zh] 攔到 manifest:', 'color:#e10600;font-weight:bold',
                String(d.url).slice(0, 140));
            }
          }
        } catch (e) { /* noop */ }
      };
    } catch (e) { console.warn('[f1zh] BroadcastChannel 不可用:', e.message); }
  }

  function installBlobWorkerInjection() {
    try {
      const U = W.URL || W.webkitURL;
      if (!U || U.__f1zhPatched) return;
      const orig = U.createObjectURL.bind(U);
      U.__f1zhPatched = true;

      U.createObjectURL = function (obj) {
        const url = orig(obj);
        if (!CFG.workerInject) return url;
        try {
          // MediaSource 等非 Blob 物件直接放行（MSE 就是走這條，絕不能動）
          if (typeof Blob === 'undefined' || !(obj instanceof Blob)) return url;
          if (obj.size > 8e6) return url;
          const ty = (obj.type || '').toLowerCase();
          if (ty && !/javascript|ecmascript|text\/plain/.test(ty)) return url;

          // blob: 的同步讀取沒有網路成本，瞬間完成
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, false);
          xhr.send();
          const src = xhr.responseText || '';
          if (!src || !/self\.|onmessage|postMessage|importScripts|addEventListener/.test(src)) return url;

          const patched = new Blob([WORKER_HOOK, '\n', src], { type: obj.type || 'text/javascript' });
          const newUrl = orig(patched);
          stats.workerPatched++;
          console.log(`%c[f1zh] ✅ 已注入 Worker hook（原始腳本 ${src.length} bytes）`,
            'color:#0a0;font-weight:bold');
          return newUrl;
        } catch (e) {
          console.warn('[f1zh] Worker 注入失敗，改用原始腳本:', e.message);
          return url;
        }
      };
    } catch (e) { console.warn('[f1zh] createObjectURL patch 失敗:', e.message); }
  }

  // ---- Worker 探測（被動，作為注入的後備）----
  // F1TV 的串流在 Worker 裡跑（7MB WASM），主執行緒的 fetch/XHR patch 碰不到。
  // 這裡被動觀察 worker 往主執行緒送的訊息，看 cue 資料會不會經過。
  // 抓不到也無妨——至少會把 worker 的腳本網址記進 netlog。
  function installWorkerHooks() {
    try {
      const OrigWorker = W.Worker;
      if (typeof OrigWorker !== 'function' || OrigWorker.__f1zh) return;

      const Patched = function (url, opts) {
        const w = new OrigWorker(url, opts);
        try {
          noteUrl(url, 'WORKER');
          stats.workers++;
          console.log('%c[f1zh] 偵測到 Web Worker:', 'color:#e10600', String(url).slice(0, 160));
          w.addEventListener('message', (ev) => {
            try {
              const n = scanForCues(ev.data, 0);
              if (n) {
                stats.workerCues += n;
                if (!vttAnnounced) {
                  vttAnnounced = true;
                  console.log('%c[f1zh] ✅ 從 Worker 訊息撈到字幕 cue，已啟動前瞻預譯',
                    'color:#0a0;font-weight:bold');
                }
                scheduleFlush();   // 走批次，不要一到就送
              }
            } catch (e) { /* noop */ }
          });
        } catch (e) { /* noop */ }
        return w;
      };
      Patched.prototype = OrigWorker.prototype;
      Patched.__f1zh = true;
      W.Worker = Patched;
    } catch (e) {
      console.warn('[f1zh] Worker hook 失敗:', e.message);
    }
  }

  // 極簡 WebVTT parser：只要 cue 文字，不要時間軸
  function parseVttText(raw) {
    const out = [];
    if (!raw || raw.indexOf('-->') === -1) return out;
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    let cur = null;
    for (const ln of lines) {
      if (ln.indexOf('-->') !== -1) {
        if (cur && cur.length) out.push(cur.join(' '));
        cur = [];
        continue;
      }
      if (cur === null) continue;             // 還沒遇到第一個時間軸列（檔頭、NOTE、STYLE）
      if (ln.trim() === '') {
        if (cur.length) { out.push(cur.join(' ')); cur = null; }
        continue;
      }
      cur.push(ln.trim());
    }
    if (cur && cur.length) out.push(cur.join(' '));
    return out;
  }

  function onVttPayload(raw, url) {
    if (!CFG.prefetch || !enabled) return;
    stats.vttSeen++;
    const cues = parseVttText(raw);
    if (!cues.length) return;
    stats.vttParsed++;

    if (!vttAnnounced) {
      vttAnnounced = true;
      console.log('%c[f1zh] ✅ 攔截到 VTT 字幕，已啟動前瞻批次預譯', 'color:#0a0;font-weight:bold');
    }

    let added = 0;
    for (const c of cues) {
      const t = clean(c);
      if (!t || t.length < 2) continue;
      const k = normKey(t);
      // 分段 VTT 前後會重疊，且同一句可能已翻過
      if (!k || prefetchSeen.has(k) || memo.has(k)) continue;
      prefetchSeen.add(k);
      prefetchQueue.push(t);
      enqueuedAt.set(k, Date.now());
      if (enqueuedAt.size > 3000) enqueuedAt.delete(enqueuedAt.keys().next().value);
      added++;
    }
    if (added) { log('VTT +' + added + ' 句，佇列 ' + prefetchQueue.length); scheduleFlush(); }
  }

  // 每個 VTT 分段只帶 2~3 句 cue。若一到就送，等於每 2 句付一次 4,801 tokens 的
  // 快取讀取，批次完全沒發揮作用。改成：湊滿 batchSize 立刻送，否則從「第一句進佇列」
  // 起算最多等 flushDelayMs。這是最長等待而非 debounce，所以不會因為持續有新句而無限延後。
  function medianLead() {
    if (leadSamples.length < 6) return null;
    const s = leadSamples.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // 等待時間 = 實測提前量的一半，再扣掉一次翻譯的耗時。
  // 用一半是留安全邊際：提前量會隨網路和緩衝狀況波動，抓太滿就會開始漏接。
  function effectiveFlushDelay() {
    if (!CFG.adaptiveFlush) return CFG.flushDelayMs;
    const m = medianLead();
    if (m == null) return CFG.flushDelayMs;
    const n = stats.calls + stats.batchCalls;
    const avgCall = n ? stats.totalMs / n : 1500;
    return Math.max(2000, Math.min(30000, m * 0.5 - avgCall));
  }

  let flushTimer = null;
  let harvesting = false;      // 整軌預抓進行中

  function scheduleFlush() {
    if (prefetchQueue.length >= CFG.batchSize) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      drainPrefetch();
      return;
    }
    // 整軌預抓期間不用計時器 flush：分段會在幾十秒內全部到齊，
    // 靠計時器會把零星的新句切成一堆迷你批次（實測平均只有 2.7 句）。
    // 收割結束後一次處理，才能湊出滿批。
    if (harvesting) return;
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; drainPrefetch(); }, effectiveFlushDelay());
    }
  }

  async function translateBatch(lines) {
    // 只有一句時走逐句路徑。批次的編號協定與【輸出規則】的「只輸出譯文本身」衝突，
    // 模型在只有一句時會直接給譯文而不加編號，導致整批解析失敗。
    if (lines.length === 1) {
      const t0single = performance.now();
      const zh = await translateOne(lines[0]);
      stats.batchCalls++;
      stats.totalMs += Math.round(performance.now() - t0single);
      if (zh) { memoSet(lines[0], zh); stats.prefetched++; }
      return;
    }

    const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const t0 = performance.now();
    const data = await apiPost('messages', {
      model: CFG.model,
      max_tokens: CFG.batchMaxTokens,
      temperature: CFG.temperature,
      system: systemBlocks(),
      messages: [{ role: 'user', content: `【批次翻譯】共 ${lines.length} 句\n${numbered}` }],
    }, Math.max(CFG.timeoutMs, 30000));

    tallyUsage(data.usage);
    stats.batchCalls++;
    stats.totalMs += Math.round(performance.now() - t0);

    const txt = textOfResponse(data);
    const map = {};
    txt.split('\n').forEach(ln => {
      const m = ln.match(/^\s*(\d+)\s*[.、:：)]\s*(.*)$/);
      if (m) map[parseInt(m[1], 10)] = m[2].trim();
    });

    let ok = 0;
    lines.forEach((l, i) => {
      const zh = map[i + 1];
      if (zh) { memoSet(l, zh); ok++; }
    });

    // 編號協定失敗時的後備：若回應的非空行數剛好等於輸入行數，就按順序位置對應。
    // 模型偶爾會忘記加編號，但順序幾乎不會錯。
    if (ok === 0) {
      const plain = txt.split('\n').map((s) => s.trim()).filter(Boolean);
      if (plain.length === lines.length) {
        lines.forEach((l, i) => { memoSet(l, plain[i]); ok++; });
        log(`批次編號解析失敗，改用位置對應（${ok} 句）`);
      }
    }

    stats.prefetched += ok;
    log(`批次 ${lines.length} 句，成功對應 ${ok} 句`);

    // 對應率太低代表模型沒照編號格式走。不特別補救——
    // 沒進快取的句子等畫面播到時會自動走逐句路徑，只是那幾句比較貴。
    if (ok < lines.length * 0.5) {
      console.warn(`[f1zh] ⚠ 批次對應率偏低（${ok}/${lines.length}），該批將退回逐句翻譯`);
    }
  }

  async function drainPrefetch() {
    if (prefetchBusy || !prefetchQueue.length) return;
    prefetchBusy = true;
    try {
      while (prefetchQueue.length && enabled) {
        const batch = prefetchQueue.splice(0, CFG.batchSize);
        await translateBatch(batch);
      }
    } catch (e) {
      stats.errors++;
      console.warn('[f1zh] 批次預譯失敗:', e.message);
    } finally {
      prefetchBusy = false;
    }
  }

  // ---- 網路層 patch（必須在 document-start 執行，早於播放器載入）----
  function installNetHooks() {
    // fetch
    try {
      const origFetch = W.fetch;
      if (typeof origFetch === 'function') {
        W.fetch = function (...args) {
          const p = origFetch.apply(this, args);
          try {
            const req = args[0];
            const url = (typeof req === 'string') ? req : (req && req.url) || '';
            p.then(res => {
              try {
                const ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
                if (CFG.netlogAll) noteUrl(url, 'fetch');
                if (!isVttish(url, ct)) return;
                noteUrl(url, 'fetch:VTT');
                // 必須 clone，否則會吃掉播放器要用的 body
                res.clone().text().then(t => onVttPayload(t, url)).catch(() => {});
              } catch (e) { /* noop */ }
            }).catch(() => {});
          } catch (e) { /* noop */ }
          return p;
        };
      }
    } catch (e) { console.warn('[f1zh] fetch hook 失敗:', e.message); }

    // XMLHttpRequest（改 prototype，保留 instanceof 與播放器自己的包裝）
    try {
      const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (XP && !XP.__f1zhPatched) {
        XP.__f1zhPatched = true;
        const origOpen = XP.open;
        XP.open = function (method, url) {
          try { this.__f1zhUrl = url; } catch (e) { /* noop */ }
          return origOpen.apply(this, arguments);
        };
        const origSend = XP.send;
        XP.send = function () {
          try {
            this.addEventListener('load', function () {
              try {
                const url = this.__f1zhUrl || this.responseURL || '';
                const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
                if (CFG.netlogAll) noteUrl(url, 'xhr:' + (this.responseType || 'text'));
                if (!isVttish(url, ct)) return;
                noteUrl(url, 'xhr:VTT');
                let t = null;
                const rt = this.responseType;
                if (rt === '' || rt === 'text') t = this.responseText;
                else if (rt === 'arraybuffer' && this.response) {
                  t = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(this.response));
                }
                if (t) onVttPayload(t, url);
              } catch (e) { /* noop */ }
            });
          } catch (e) { /* noop */ }
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) { console.warn('[f1zh] XHR hook 失敗:', e.message); }
  }

  // ==========================================================================
  // 9. DOM 字幕來源（顯示觸發器，永遠是同步的權威）
  // ==========================================================================
  function textOf(el) {
    const parts = [];
    el.querySelectorAll('*').forEach(n => {
      if (n.firstElementChild) return;
      const t = (n.textContent || '').trim();
      if (t) parts.push(t);
    });
    if (!parts.length) {
      const t = (el.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  function captionContainers() {
    return Array.from(document.querySelectorAll(CFG.captionRoot));
  }

  // 多視角時可能同時存在多個字幕容器（各路訊號一個）。
  // 挑面積最大的，也就是主畫面那一格，避免把兩路字幕黏在一起。
  function activeCaptionContainer() {
    const list = captionContainers();
    if (list.length <= 1) return list[0] || null;
    let best = null, bestArea = -1;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = el; }
    }
    return best;
  }

  function collectCaption() {
    const root = activeCaptionContainer();
    if (!root) return '';
    const parts = [];
    root.querySelectorAll(CFG.captionLabel).forEach(el => {   // 限定在該容器內尋找
      const t = textOf(el);
      if (t) parts.push(t);
    });
    if (!parts.length) {
      const t = textOf(root);
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---- 主動輪詢：這是字幕偵測的主力 ----
  // MutationObserver 只是加速器。播放器重建 DOM 時 observer 會靜默失聯，
  // 而輪詢不依賴任何註冊狀態，因此不可能失效。
  let lastSeenCaption = '';
  let lastNonEmptyAt = Date.now();

  function pollCaption() {
    if (!enabled) return;
    const cur = collectCaption();
    if (cur === lastSeenCaption) return;
    lastSeenCaption = cur;

    if (!cur) {
      // 字幕清空：可能只是換句空檔，也可能是切換視角導致播放器重建。
      // 一定要重置 lastRaw —— 否則切回主訊號時，若第一句與切走前那句相同，
      // 會被去重邏輯擋掉而永遠不顯示。這正是「切回來要重點一次」的成因之一。
      lastRaw = '';
      return;
    }
    lastNonEmptyAt = Date.now();
    push(cur);
  }

  // ---- 觀察者：偵測到節點集合變動就整組重掛 ----
  let hookedRoots = 0;
  let observedNodes = new Set();
  const observers = [];

  function hookDom() {
    const now = captionContainers();
    let changed = now.length !== observedNodes.size;
    if (!changed) {
      for (const el of now) { if (!observedNodes.has(el)) { changed = true; break; } }
    }
    if (!changed) return;

    // 節點集合變了 → 舊 observer 可能掛在已銷毀的節點上，全部重來。
    // 不再用 node.__f1zh 標記，因為那等於「相信掛過就永遠有效」。
    observers.forEach(o => { try { o.disconnect(); } catch (e) { /* noop */ } });
    observers.length = 0;
    observedNodes = new Set(now);

    now.forEach(node => {
      const o = new MutationObserver(() => {
        clearTimeout(domTimer);
        domTimer = setTimeout(pollCaption, CFG.debounceMs);
      });
      o.observe(node, { childList: true, subtree: true, characterData: true });
      observers.push(o);
      hookedRoots++;
    });
    if (now.length) log('重新掛載字幕容器 ×' + now.length);
  }

  // ---- 影片切換偵測（SPA 換頁不會重新載入腳本）----
  function currentContentId() {
    const m = location.pathname.match(/\/detail\/(\d+)/);
    return m ? m[1] : null;
  }

  let lastContentId = null;
  function checkContentChange() {
    const cid = currentContentId();
    if (cid === lastContentId) return;
    const prev = lastContentId;
    lastContentId = cid;
    if (prev === null) return;                 // 首次載入不算切換

    console.log(`%c[f1zh] 偵測到影片切換 ${prev} → ${cid}，重置狀態`, 'color:#e10600');
    backendPushBundle(prev);                   // 先把舊影片的成果貢獻出去
    sessionKeys.clear();
    playbackSecs = 0; prefetchWarned = false;  // 新影片重新計時
    // memo 保留（key 是正規化後的原文，不同影片不會撞，重看還能受惠），其餘全清
    lastRaw = ''; lastSeenCaption = '';
    prefetchSeen.clear();
    prefetchQueue.length = 0;
    enqueuedAt.clear();
    leadSamples.length = 0;
    manifests.length = 0;                      // 舊影片的 manifest 不能拿來預抓新影片
    fullPrefetchStarted = false;
    prefetchAttempts = 0;
    observedNodes = new Set();                 // 強制下次 hookDom 重掛
    backendPullBundle(cid);                    // 新影片先問共用快取有沒有現成的
  }

  // ---- 健康檢查：播放中卻長時間沒有字幕 ----
  let hintShownAt = 0;
  function checkCaptionHealth() {
    if (!enabled) return;
    const v = document.querySelector('video');
    if (!v || v.paused || !captionContainers().length) { lastNonEmptyAt = Date.now(); return; }
    if (Date.now() - lastNonEmptyAt < CFG.noCaptionWarnMs) return;
    lastNonEmptyAt = Date.now();                       // 重置，避免連續觸發
    if (Date.now() - hintShownAt < 120000) return;     // 兩分鐘內只提示一次
    hintShownAt = Date.now();
    console.warn('[f1zh] ⚠ 播放中但長時間沒有字幕 — 切換視角後播放器可能把 CC 關掉了，' +
      '請到播放器設定重新開啟英文字幕。');
    if (CFG.showCaptionHint) show('⚠ 未偵測到字幕，請確認播放器的 CC 已開啟', '');
  }

  function hookTracks(video) {
    const attach = (t) => {
      if (!t || t.__f1zh) return;
      if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
      t.__f1zh = true; t.mode = 'hidden';
      t.addEventListener('cuechange', () => {
        const cues = t.activeCues;
        if (cues && cues.length) push(Array.from(cues).map(c => c.text || '').join(' '));
      });
      log('已掛上原生 textTrack');
    };
    for (const t of video.textTracks) attach(t);
    video.textTracks.addEventListener('addtrack', e => attach(e.track));
  }

  // ==========================================================================
  // 10. 啟動
  // ==========================================================================
  // 讀回使用者的 Worker 注入偏好（若曾因播放異常而關閉，重整後要記得）
  try { CFG.workerInject = GM_getValue('workerInject', CFG.workerInject); } catch (e) { /* noop */ }

  // 這三個必須在 document-start 立刻執行，早於播放器建立 worker
  installBlobWorkerInjection();   // 主力：把 hook 注入 worker 內部
  installBroadcastListener();     // 接收 worker 送回來的 VTT
  installNetHooks();              // 主執行緒的 fetch/XHR（後備）
  installWorkerHooks();           // 被動觀察 worker 訊息（後備）

  function boot() {
    if (booted) return;
    booted = true;
    injectStyles();
    applyHideNative();
    mount();

    lastContentId = currentContentId();
    backendPullBundle(lastContentId);          // 首次載入也要問共用快取

    // 快輪詢：字幕偵測的主力。observer 失聯時由它接手，最多晚 250ms。
    setInterval(pollCaption, CFG.captionPollMs);

    // 慢輪詢：結構性檢查
    setInterval(() => {
      const v = document.querySelector('video');
      if (v && !v.__f1zh) { v.__f1zh = true; hookTracks(v); }
      checkContentChange();   // SPA 換影片
      hookDom();              // 節點集合變動就重掛
      mount();                // 疊字層可能被播放器重建時一起移除
      reposition();
      checkCaptionHealth();
      startFullPrefetch();    // manifest 一到就啟動，內部有 guard 只會跑一次
    }, 1500);

    ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach(e =>
      window.addEventListener(e, () => { mount(); reposition(); }, true)
    );

    // 前瞻預譯的警告只在「真的有在播影片」時才有意義。
    // 掛在片庫或首頁時跳這個訊息只會嚇到使用者。改為累計實際播放秒數。
    setInterval(() => {
      const v = document.querySelector('video');
      const playing = v && !v.paused && v.currentTime > 0 && !!currentContentId();
      if (playing) playbackSecs += 1.5;
      if (prefetchWarned || !CFG.prefetch) return;
      if (playbackSecs < 90) return;
      if (stats.vttParsed || stats.workerCues || stats.workerVtt || stats.beDownloaded) return;
      prefetchWarned = true;
      console.warn(`[f1zh] 播放 90 秒仍未取得前瞻字幕，目前以逐句模式運作（功能正常，只是成本較高）。\n` +
        `  Worker 注入：${stats.workerPatched} 個 / 偵測到 Worker：${stats.workers} 個\n` +
        '  若「已注入 > 0」但沒收到 VTT，代表字幕不是走 worker 的 fetch/XHR。\n' +
        '  執行 __f1zh.netlog() 可看攔到哪些網址。');
    }, 1500);

    console.log(`%c[f1zh] F1TV 繁中字幕 v4.4.0 已載入（共用譯文後端：${backendOn() ? '已啟用' : '未設定'}）`,
      'color:#e10600;font-weight:bold');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ==========================================================================
  // 11. 油猴選單
  // ==========================================================================
  GM_registerMenuCommand('🔑 設定 Anthropic API key', () => {
    const v = prompt('貼上你的 Anthropic API key（sk-ant-...）：', GM_getValue('apiKey', ''));
    if (v !== null) { GM_setValue('apiKey', v.trim()); alert('已儲存。重新整理頁面生效。'); }
  });

  GM_registerMenuCommand('⏯ 開 / 關字幕翻譯', () => {
    enabled = !enabled;
    if (!enabled) box.classList.remove('on');
    alert('字幕翻譯：' + (enabled ? '開啟' : '關閉'));
  });

  GM_registerMenuCommand('🚀 開 / 關前瞻預譯', () => {
    CFG.prefetch = !CFG.prefetch;
    alert('前瞻預譯：' + (CFG.prefetch ? '開啟（省錢、零延遲）' : '關閉（退回逐句模式）'));
  });

  GM_registerMenuCommand('☁ 設定共用譯文後端', () => {
    const cur = GM_getValue('backendUrl', CFG.backendUrl);
    const u = prompt('後端網址（留空 = 停用，只用本機翻譯）：\n例 https://f1zh-api.xxx.workers.dev', cur);
    if (u === null) return;
    GM_setValue('backendUrl', u.trim().replace(/\/+$/, ''));
    if (u.trim()) {
      const c = prompt('CLIENT_TOKEN（讀取與翻譯用）：', GM_getValue('clientToken', ''));
      if (c !== null) GM_setValue('clientToken', c.trim());
      const a = prompt('ADMIN_TOKEN（上傳用，只有你需要填。一般使用者留空）：', GM_getValue('adminToken', ''));
      if (a !== null) GM_setValue('adminToken', a.trim());
    }
    alert('已儲存。重新整理頁面生效。');
  });

  GM_registerMenuCommand('☁ 測試後端連線', async () => {
    if (!backendOn()) { alert('尚未設定後端網址。'); return; }
    try {
      const h = await backendRequest('GET', '/v1/health');
      const cid = currentContentId();
      let subs = '（不在播放頁，未查詢）';
      if (cid) {
        const d = await backendRequest('GET', `/v1/subs?cid=${cid}`, null,
          { 'x-client-token': GM_getValue('clientToken', '') });
        subs = `${d.count} 句（更新於 ${d.updatedAt || '尚無資料'}）`;
      }
      alert(`✅ 後端正常\n\n模型：${h.model}\n目前影片快取：${subs}\n\n` +
            `ADMIN_TOKEN：${GM_getValue('adminToken', '') ? '已設定（可上傳）' : '未設定（唯讀）'}`);
    } catch (e) { alert('❌ 連線失敗：' + e.message); }
  });

  GM_registerMenuCommand('☁ 立即上傳本片譯文', async () => {
    const cid = currentContentId();
    if (!cid) { alert('不在播放頁。'); return; }
    if (!GM_getValue('adminToken', '')) { alert('未設定 ADMIN_TOKEN，無法上傳。'); return; }
    await backendPushBundle(cid);
    alert('上傳完成，詳情見 Console。');
  });

  GM_registerMenuCommand('🎯 立即整軌預抓（重播用）', () => {
    if (!manifests.length) { alert('還沒攔到 manifest。請先開始播放，等幾秒再試。'); return; }
    const sp = findSubtitlePlaylist();
    if (!sp) { alert('攔到 ' + manifests.length + ' 份 manifest，但找不到字幕清單。'); return; }
    fullPrefetchStarted = false;
    prefetchAttempts = 0;
    startFullPrefetch(true);
    alert('已啟動整軌預抓（' + sp.how + '）。\n進度請看 Console 與統計面板。');
  });

  GM_registerMenuCommand('🧬 開 / 關 Worker 注入', () => {
    CFG.workerInject = !CFG.workerInject;
    GM_setValue('workerInject', CFG.workerInject);
    alert('Worker 注入：' + (CFG.workerInject ? '開啟' : '關閉') +
      '\n\n需重新整理頁面生效。\n若影片無法播放，請關閉此項後重整。');
  });

  GM_registerMenuCommand('🔤 切換雙語 / 純中文', () => {
    CFG.showEnglish = !CFG.showEnglish; reposition();
  });

  GM_registerMenuCommand('👁 顯示 / 隱藏原生英文字幕', () => {
    CFG.hideNativeCC = !CFG.hideNativeCC; applyHideNative();
    alert('原生英文字幕：' + (CFG.hideNativeCC ? '隱藏' : '顯示'));
  });

  GM_registerMenuCommand('🩺 掛載狀態自我診斷', () => {
    const v = document.querySelector('video');
    const rootEl = document.querySelector(CFG.captionRoot);
    const rawLen = rootEl ? (rootEl.textContent || '').trim().length : 0;
    alert(
      `video 元素：${v ? '有' : '無'}\n` +
      `字幕容器：${document.querySelectorAll(CFG.captionRoot).length} 個（已掛載 ${hookedRoots}）\n` +
      `字幕文字元素：${document.querySelectorAll(CFG.captionLabel).length} 個\n` +
      `容器原始文字長度：${rawLen} 字（0 = 播放器真的沒送字幕）\n` +
      `目前抓到的英文：${collectCaption() || '（空）'}\n` +
      `距上次看到字幕：${Math.round((Date.now() - lastNonEmptyAt) / 1000)} 秒\n` +
      `目前 contentId：${currentContentId() || '（不在播放頁）'}\n\n` +
      `── 共用譯文後端 ──\n` +
      `狀態：${backendOn() ? backendBase() : '未設定（純本機模式）'}\n` +
      `權限：${GM_getValue('adminToken', '') ? '可上傳' : '唯讀'}\n` +
      `本次下載：${stats.beDownloaded} 句 ／ 上傳：${stats.beUploaded} 句 ／ 錯誤：${stats.beErrors}\n\n` +
      `── 前瞻預譯 ──\n` +
      `狀態：${CFG.prefetch ? '開啟' : '關閉'}\n` +
      `整軌預抓：${CFG.fullPrefetch ? '開啟' : '關閉'}，清單 ${stats.playlistSegs} 段 / ` +
      `已抓 ${stats.segFetched} 段（失敗 ${stats.segFailed}）\n` +
      `Worker 注入：${CFG.workerInject ? '開啟' : '關閉'}，已注入 ${stats.workerPatched} 個\n` +
      `偵測到 Web Worker：${stats.workers} 個\n` +
      `從 Worker 收到的 VTT：${stats.workerVtt} 份\n` +
      `從 Worker 訊息撈到的 cue：${stats.workerCues} 句\n` +
      `主執行緒攔到的 VTT：${stats.vttSeen} 次（成功解析 ${stats.vttParsed} 次）\n` +
      `已預譯句數：${stats.prefetched}\n` +
      `待預譯佇列：${prefetchQueue.length}\n` +
      `快取內譯文：${memo.size} 句\n\n` +
      `隱藏原生字幕：${CFG.hideNativeCC ? '是' : '否'}\n` +
      `API key：${GM_getValue('apiKey', '') ? '已設定' : '未設定'}\n` +
      `翻譯：${enabled ? '開啟' : '關閉'}`
    );
  });

  GM_registerMenuCommand('🧮 檢查 system prompt token 數', async () => {
    try {
      const d = await apiPost('messages/count_tokens', {
        model: CFG.model,
        system: [{ type: 'text', text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: 'x' }],
      });
      const n = d.input_tokens;
      alert(
        `System prompt：${n} tokens\n\nHaiku 4.5 快取門檻：4096 tokens\n` +
        (n >= 4096
          ? `✅ 已跨過門檻，prompt caching 生效，輸入成本降至 0.1 倍。`
          : `⚠ 還差 ${4096 - n} tokens，加了 cache_control 也不會生效。`)
      );
    } catch (e) { alert('查詢失敗：' + e.message); }
  });

  GM_registerMenuCommand('📊 顯示本場統計', () => {
    const totalCalls = stats.calls + stats.batchCalls;
    const avg = totalCalls ? Math.round(stats.totalMs / totalCalls) : 0;
    const cost = (stats.inTok / 1e6) * 1
               + (stats.cacheWrite / 1e6) * 1.25
               + (stats.cacheRead / 1e6) * 0.10
               + (stats.outTok / 1e6) * 5;
    const shown = stats.hits + stats.calls;
    const avgBatch = stats.batchCalls ? (stats.prefetched / stats.batchCalls).toFixed(1) : '0';
    alert(
      `逐句呼叫：${stats.calls} 次\n` +
      `批次呼叫：${stats.batchCalls} 次（預譯 ${stats.prefetched} 句）\n` +
      `平均批次大小：${avgBatch} 句/次（越接近 ${CFG.batchSize} 越省）\n` +
      `實測提前量中位數：${medianLead() != null ? medianLead() + ' ms' : '樣本不足'}\n` +
      `目前採用的等待：${Math.round(effectiveFlushDelay())} ms\n` +
      `快取命中：${stats.hits} 次\n` +
      `命中率：${shown ? Math.round(stats.hits / shown * 100) : 0}%（越高越省）\n` +
      `錯誤：${stats.errors} 次\n` +
      `平均呼叫耗時：${avg} ms\n\n` +
      `未快取輸入：${stats.inTok.toLocaleString()} tokens\n` +
      `快取寫入：${stats.cacheWrite.toLocaleString()} tokens\n` +
      `快取讀取：${stats.cacheRead.toLocaleString()} tokens\n` +
      `輸出：${stats.outTok.toLocaleString()} tokens\n\n` +
      `實際花費：US$${cost.toFixed(4)}`
    );
  });

  GM_registerMenuCommand('🌐 顯示攔截到的網址', () => {
    if (!netlog.length) { alert('尚未攔截到任何網址。'); return; }
    console.table(netlog);
    alert(`已攔截 ${netlog.length} 筆，明細印在 Console（console.table）。`);
  });

  GM_registerMenuCommand('📜 顯示攔截到的 manifest', () => {
    if (!manifests.length) {
      alert('尚未攔到 manifest。\n可能字幕分段的網址不含 .m3u8/.mpd，或 manifest 在腳本載入前就取得了。');
      return;
    }
    manifests.forEach((m, i) => {
      console.log(`%c[f1zh] manifest #${i}: ${m.url}`, 'color:#e10600;font-weight:bold');
      console.log(m.body);
    });
    alert(`攔到 ${manifests.length} 份 manifest，全文印在 Console。`);
  });

  // ==========================================================================
  // 12. 除錯把手
  // ==========================================================================
  const API = {
    cfg: CFG, stats, memo, prefetchQueue,
    test: (s) => {
      if (!enabled) console.warn('[f1zh] ⚠ 翻譯目前關閉，先執行 __f1zh.on()');
      push(s);
    },
    peek: () => collectCaption(),
    netlog: () => { console.table(netlog); return netlog.length; },
    manifests: () => { manifests.forEach(m => { console.log('=== ' + m.url); console.log(m.body); }); return manifests.length; },
    lead: () => ({ median: medianLead(), samples: leadSamples.slice(), using: Math.round(effectiveFlushDelay()) }),
    subPlaylist: () => {
      const s = findSubtitlePlaylist();
      if (s) console.log('[f1zh] 字幕清單:', s.how, '\n', s.url, '\nbody 已在手上:', !!s.body);
      else console.log('[f1zh] 找不到字幕清單，manifest 數量:', manifests.length);
      return s;
    },
    fullPrefetch: () => { fullPrefetchStarted = false; prefetchAttempts = 0; return startFullPrefetch(true); },
    // 手動餵一段 VTT 內容測試 parser，例如 __f1zh.feedVtt(await (await fetch(url)).text())
    feedVtt: (raw) => { onVttPayload(raw, 'manual'); return prefetchQueue.length; },
    on: () => { enabled = true; console.log('[f1zh] 翻譯已開啟'); },
    off: () => { enabled = false; box.classList.remove('on'); console.log('[f1zh] 翻譯已關閉'); },
  };
  window.__f1zh = API;
  try { if (W !== window) W.__f1zh = API; } catch (e) { /* noop */ }
})();
