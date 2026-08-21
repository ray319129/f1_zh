#!/usr/bin/env node
/**
 * 產生賽事資料的字面量（貼進 backend/src/index.js 的 REMOTE_CONFIG.schedule）。
 *
 * 為什麼要用產生的而不是手打：23 站 × 5 個場次 = 115 個時間戳，
 * 手打一定會錯，而錯了**完全不會報錯**——只會讓某一張通行證的效期不對。
 *
 * ⚠️ **哪些是事實、哪些是推估，必須分清楚：**
 *
 *   事實（來自既有、使用者已確認過的資料）：
 *     場次日期 start / end、衝刺賽週、待定場次、夏休界線
 *
 *   推估（這支自己補的，全部標 `est: 1`）：
 *     每個場次的實際開始時間。用的是 F1 的標準時刻表（當地時間），
 *     再依該站時區換算成 UTC。**真實時間以官方公布為準**，
 *     `/v1/admin/schedule/sync` 會用官方來源覆蓋掉推估值。
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

/* 既有資料（日期是事實，不要改） */
const RAW = [
  [1, '澳洲', '2026-03-06', '2026-03-08', {}],
  [2, '中國', '2026-03-13', '2026-03-15', { sprint: true }],
  [3, '日本', '2026-03-27', '2026-03-29', {}],
  [4, '邁阿密', '2026-05-01', '2026-05-03', { sprint: true }],
  [5, '加拿大', '2026-05-22', '2026-05-24', { sprint: true }],
  [6, '摩納哥', '2026-06-05', '2026-06-07', {}],
  [7, '巴塞隆納', '2026-06-12', '2026-06-14', {}],
  [8, '奧地利', '2026-06-26', '2026-06-28', {}],
  [9, '英國', '2026-07-03', '2026-07-05', {}],
  [10, '比利時', '2026-07-17', '2026-07-19', { sprint: true }],
  [11, '匈牙利', '2026-07-24', '2026-07-26', {}],
  [12, '荷蘭', '2026-08-21', '2026-08-23', { afterSummerBreak: true }],
  [13, '義大利', '2026-09-04', '2026-09-06', {}],
  [14, '西班牙（馬德里）', '2026-09-11', '2026-09-13', {}],
  [15, '亞塞拜然', '2026-09-24', '2026-09-26', {}],
  [16, '巴林（馬來西亞 Sepang）', '2026-10-02', '2026-10-04', {}],
  [17, '新加坡', '2026-10-09', '2026-10-11', { sprint: true }],
  [18, '美國', '2026-10-23', '2026-10-25', {}],
  [19, '墨西哥', '2026-10-30', '2026-11-01', {}],
  [20, '巴西', '2026-11-06', '2026-11-08', {}],
  [21, '拉斯維加斯', '2026-11-19', '2026-11-21', {}],
  [22, '卡達', '2026-11-27', '2026-11-29', { tentative: true }],
  [23, '阿布達比', '2026-12-04', '2026-12-06', { tentative: true }],
];

/**
 * F1 的標準時刻表（當地時間）。
 * 一般週末與衝刺賽週末的場次組成不同——**排錯的話效期會算錯**。
 * `d` 是相對於 start 的天數（0 = 第一天）。
 */
const NORMAL = [
  { kind: 'fp1', label: '第一次自由練習', d: 0, at: '13:30' },
  { kind: 'fp2', label: '第二次自由練習', d: 0, at: '17:00' },
  { kind: 'fp3', label: '第三次自由練習', d: 1, at: '12:30' },
  { kind: 'quali', label: '排位賽', d: 1, at: '16:00' },
  { kind: 'race', label: '正賽', d: 2, at: '15:00' },
];
const SPRINT = [
  { kind: 'fp1', label: '唯一自由練習', d: 0, at: '12:30' },
  { kind: 'sq', label: '衝刺排位賽', d: 0, at: '16:30' },
  { kind: 'sprint', label: '衝刺賽', d: 1, at: '12:00' },
  { kind: 'quali', label: '排位賽', d: 1, at: '16:00' },
  { kind: 'race', label: '正賽', d: 2, at: '15:00' },
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

/** 當地時間 → UTC 秒。**要迭代一次**，因為偏移本身取決於瞬間（日光節約）。 */
function localToUtcSec(tz, ymd, hhmm) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  let guess = Date.UTC(Y, M - 1, D, h, mi);
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes(tz, guess);
    const next = Date.UTC(Y, M - 1, D, h, mi) - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return Math.floor(guess / 1000);
}

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const out = RAW.map(([r, name, start, end, extra]) => {
  const [country, flag, tz, circuit] = META[name];
  const tpl = extra.sprint ? SPRINT : NORMAL;
  const sessions = tpl.map((s) => ({
    k: s.kind,
    n: s.label,
    t: localToUtcSec(tz, addDays(start, s.d), s.at),
  }));
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
  if (extra.sprint) bits.push('sprint: true');
  if (extra.tentative) bits.push('tentative: true');
  if (extra.afterSummerBreak) bits.push('afterSummerBreak: true');
  bits.push('est: 1');
  bits.push('sessions: [' + sessions.map((s) => `{ k: '${s.k}', n: '${s.n}', t: ${s.t} }`).join(', ') + ']');
  return '    { ' + bits.join(', ') + ' },';
});

console.log('  schedule: [');
console.log(out.join('\n'));
console.log('  ],');
