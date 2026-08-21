#!/usr/bin/env node
/**
 * 產生賽事資料的字面量（貼進 backend/src/index.js 的 REMOTE_CONFIG.schedule）。
 *
 * 為什麼要用產生的而不是手打：23 站 × 5 個場次 = 115 個時間戳，
 * 手打一定會錯，而錯了**完全不會報錯**——只會讓某一張通行證的效期不對。
 *
 * ## 資料來源
 *
 * 場次時間抄自 f1calendar.com（以 **Europe/London** 顯示），
 * 衝刺賽站別依 F1 官方公布的 2026 Sprint Calendar 核對過：
 * **中國、邁阿密、加拿大、英國、荷蘭、新加坡**共六站。
 *
 * ⚠️ 這一版**不再有推估值**。先前用「標準時刻表」推估的版本有兩個實際錯誤：
 *    把比利時標成衝刺賽（實際不是），漏掉英國與荷蘭（實際是）。
 *    衝刺賽週的場次組成完全不同，錯了會讓商品卡列出不存在的場次。
 *
 * ⚠️ 時間一律換算成 **UTC 秒**存進資料裡。前端再依使用者的時區顯示——
 *    伺服器猜不到使用者在哪裡，猜錯的後果是他照著錯的時間去等排位賽。
 *
 * ⚠️ `start` / `end` 是**當地日期**，不是倫敦日期。拉斯維加斯的正賽在
 *    當地星期六深夜，換算倫敦已是星期日；兩者差一天是正常的。
 *
 * 用法：node tools/gen-schedule.js > /tmp/schedule.txt
 */

/* 站名 → 國家、國旗、時區、賽道。**只有這一份是人工維護的對照表。** */
const META = {
  澳洲: ['澳洲', '🇦🇺', 'Australia/Melbourne', 'Albert Park'],
  中國: ['中國', '🇨🇳', 'Asia/Shanghai', 'Shanghai'],
  日本: ['日本', '🇯🇵', 'Asia/Tokyo', 'Suzuka'],
  邁阿密: ['美國', '🇺🇸', 'America/New_York', 'Miami'],
  加拿大: ['加拿大', '🇨🇦', 'America/Toronto', 'Gilles Villeneuve'],
  摩納哥: ['摩納哥', '🇲🇨', 'Europe/Monaco', 'Monaco'],
  巴塞隆納: ['西班牙', '🇪🇸', 'Europe/Madrid', 'Barcelona-Catalunya'],
  奧地利: ['奧地利', '🇦🇹', 'Europe/Vienna', 'Red Bull Ring'],
  英國: ['英國', '🇬🇧', 'Europe/London', 'Silverstone'],
  比利時: ['比利時', '🇧🇪', 'Europe/Brussels', 'Spa-Francorchamps'],
  匈牙利: ['匈牙利', '🇭🇺', 'Europe/Budapest', 'Hungaroring'],
  荷蘭: ['荷蘭', '🇳🇱', 'Europe/Amsterdam', 'Zandvoort'],
  義大利: ['義大利', '🇮🇹', 'Europe/Rome', 'Monza'],
  '西班牙（馬德里）': ['西班牙', '🇪🇸', 'Europe/Madrid', 'Madring'],
  亞塞拜然: ['亞塞拜然', '🇦🇿', 'Asia/Baku', 'Baku City'],
  '巴林（馬來西亞 Sepang）': ['馬來西亞', '🇲🇾', 'Asia/Kuala_Lumpur', 'Sepang'],
  新加坡: ['新加坡', '🇸🇬', 'Asia/Singapore', 'Marina Bay'],
  美國: ['美國', '🇺🇸', 'America/Chicago', 'Circuit of the Americas'],
  墨西哥: ['墨西哥', '🇲🇽', 'America/Mexico_City', 'Hermanos Rodríguez'],
  巴西: ['巴西', '🇧🇷', 'America/Sao_Paulo', 'Interlagos'],
  拉斯維加斯: ['美國', '🇺🇸', 'America/Los_Angeles', 'Las Vegas Strip'],
  卡達: ['卡達', '🇶🇦', 'Asia/Qatar', 'Lusail'],
  阿布達比: ['阿拉伯聯合大公國', '🇦🇪', 'Asia/Dubai', 'Yas Marina'],
};

const N = ['fp1', 'fp2', 'fp3', 'quali', 'race'];
const S = ['fp1', 'sq', 'sprint', 'quali', 'race'];
const LABEL = {
  fp1: '第一次自由練習', fp2: '第二次自由練習', fp3: '第三次自由練習',
  sq: '衝刺排位賽', sprint: '衝刺賽', quali: '排位賽', race: '正賽',
};
/** 衝刺賽週只有一次自由練習，名稱不同。 */
const LABEL_SPRINT = Object.assign({}, LABEL, { fp1: '唯一自由練習' });

/**
 * 賽程。
 *   [輪次, 站名, 當地開始日, 當地結束日, 衝刺賽?, 場次時間（Europe/London）, 額外旗標]
 * 場次時間的順序固定：一般週末 FP1 FP2 FP3 Q R；衝刺賽週 FP1 SQ Sprint Q R。
 */
const RAW = [
  [1, '澳洲', '2026-03-06', '2026-03-08', false,
    ['03-06 01:30', '03-06 05:00', '03-07 01:30', '03-07 05:00', '03-08 04:00'], {}],
  [2, '中國', '2026-03-13', '2026-03-15', true,
    ['03-13 03:30', '03-13 07:30', '03-14 03:00', '03-14 07:00', '03-15 07:00'], {}],
  [3, '日本', '2026-03-27', '2026-03-29', false,
    ['03-27 02:30', '03-27 06:00', '03-28 02:30', '03-28 06:00', '03-29 06:00'], {}],
  [4, '邁阿密', '2026-05-01', '2026-05-03', true,
    ['05-01 17:00', '05-01 21:30', '05-02 17:00', '05-02 21:00', '05-03 18:00'], {}],
  [5, '加拿大', '2026-05-22', '2026-05-24', true,
    ['05-22 17:30', '05-22 21:30', '05-23 17:00', '05-23 21:00', '05-24 21:00'], {}],
  [6, '摩納哥', '2026-06-05', '2026-06-07', false,
    ['06-05 12:30', '06-05 16:00', '06-06 11:30', '06-06 15:00', '06-07 14:00'], {}],
  [7, '巴塞隆納', '2026-06-12', '2026-06-14', false,
    ['06-12 12:30', '06-12 16:00', '06-13 11:30', '06-13 15:00', '06-14 14:00'], {}],
  [8, '奧地利', '2026-06-26', '2026-06-28', false,
    ['06-26 12:30', '06-26 16:00', '06-27 11:30', '06-27 15:00', '06-28 14:00'], {}],
  [9, '英國', '2026-07-03', '2026-07-05', true,
    ['07-03 12:30', '07-03 16:30', '07-04 12:00', '07-04 16:00', '07-05 15:00'], {}],
  [10, '比利時', '2026-07-17', '2026-07-19', false,
    ['07-17 12:30', '07-17 16:00', '07-18 11:30', '07-18 15:00', '07-19 14:00'], {}],
  [11, '匈牙利', '2026-07-24', '2026-07-26', false,
    ['07-24 12:30', '07-24 16:00', '07-25 11:30', '07-25 15:00', '07-26 14:00'], {}],
  [12, '荷蘭', '2026-08-21', '2026-08-23', true,
    ['08-21 11:30', '08-21 15:30', '08-22 11:00', '08-22 15:00', '08-23 14:00'],
    { afterSummerBreak: true }],
  [13, '義大利', '2026-09-04', '2026-09-06', false,
    ['09-04 11:30', '09-04 15:00', '09-05 11:30', '09-05 15:00', '09-06 14:00'], {}],
  [14, '西班牙（馬德里）', '2026-09-11', '2026-09-13', false,
    ['09-11 12:30', '09-11 16:00', '09-12 11:30', '09-12 15:00', '09-13 14:00'], {}],
  [15, '亞塞拜然', '2026-09-24', '2026-09-26', false,
    ['09-24 09:30', '09-24 13:00', '09-25 09:30', '09-25 13:00', '09-26 12:00'], {}],
  [16, '巴林（馬來西亞 Sepang）', '2026-10-02', '2026-10-04', false,
    ['10-02 05:30', '10-02 09:00', '10-03 05:30', '10-03 09:00', '10-04 08:00'], {}],
  [17, '新加坡', '2026-10-09', '2026-10-11', true,
    ['10-09 09:30', '10-09 13:30', '10-10 10:00', '10-10 14:00', '10-11 13:00'], {}],
  [18, '美國', '2026-10-23', '2026-10-25', false,
    ['10-23 18:30', '10-23 22:00', '10-24 18:30', '10-24 22:00', '10-25 20:00'], {}],
  [19, '墨西哥', '2026-10-30', '2026-11-01', false,
    ['10-30 18:30', '10-30 22:00', '10-31 17:30', '10-31 21:00', '11-01 20:00'], {}],
  [20, '巴西', '2026-11-06', '2026-11-08', false,
    ['11-06 15:30', '11-06 19:00', '11-07 14:30', '11-07 18:00', '11-08 17:00'], {}],
  [21, '拉斯維加斯', '2026-11-19', '2026-11-21', false,
    ['11-20 00:30', '11-20 04:00', '11-21 00:30', '11-21 04:00', '11-22 04:00'], {}],
  [22, '卡達', '2026-11-27', '2026-11-29', false,
    ['11-27 13:30', '11-27 17:00', '11-28 14:30', '11-28 18:00', '11-29 16:00'],
    { tentative: true }],
  [23, '阿布達比', '2026-12-04', '2026-12-06', false,
    ['12-04 09:30', '12-04 13:00', '12-05 10:30', '12-05 14:00', '12-06 13:00'],
    { tentative: true }],
];

/** 某個時區在某個瞬間的 UTC 偏移（分鐘）。用 Intl 反推，不引任何套件。 */
function offsetMinutes(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return (asUtc - utcMs) / 60000;
}

/**
 * 倫敦時間 → UTC 秒。
 * **要迭代**，因為偏移本身取決於瞬間（英國夏令時間 BST 是 UTC+1，冬天 GMT 是 UTC+0）。
 */
function londonToUtcSec(md, hhmm) {
  const [M, D] = md.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  let guess = Date.UTC(2026, M - 1, D, h, mi);
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes('Europe/London', guess);
    const next = Date.UTC(2026, M - 1, D, h, mi) - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return Math.floor(guess / 1000);
}

const out = RAW.map(([r, name, start, end, sprint, times, extra]) => {
  const [country, flag, tz, circuit] = META[name];
  const kinds = sprint ? S : N;
  const labels = sprint ? LABEL_SPRINT : LABEL;
  if (times.length !== kinds.length) {
    throw new Error(`${name} 的場次數量不對：${times.length} vs ${kinds.length}`);
  }
  const sessions = kinds.map((k, i) => {
    const [md, hhmm] = times[i].split(' ');
    return { k, n: labels[k], t: londonToUtcSec(md, hhmm) };
  });
  // 場次時間必須遞增。抄錯順序完全不會報錯，只會讓「第一場賽事」算錯，
  // 而那直接決定通行證的生效與失效時間。
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].t <= sessions[i - 1].t) {
      throw new Error(`${name} 的場次時間沒有遞增：${sessions[i - 1].n} → ${sessions[i].n}`);
    }
  }

  const bits = [
    `r: ${r}`,
    `name: '${name}'`,
    `label: '${name}大獎賽'`,
    `country: '${country}'`,
    `flag: '${flag}'`,
    `circuit: '${circuit}'`,
    `tz: '${tz}'`,
    `start: '${start}'`,
    `end: '${end}'`,
  ];
  if (sprint) bits.push('sprint: true');
  if (extra.tentative) bits.push('tentative: true');
  if (extra.afterSummerBreak) bits.push('afterSummerBreak: true');
  bits.push('sessions: [' + sessions.map((s) => `{ k: '${s.k}', n: '${s.n}', t: ${s.t} }`).join(', ') + ']');
  return '    { ' + bits.join(', ') + ' },';
});

console.log('  schedule: [');
console.log(out.join('\n'));
console.log('  ],');
