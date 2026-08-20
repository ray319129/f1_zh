#!/usr/bin/env node
/**
 * 注入到 worker 內部的程式碼是**字串**，`node --check inject.js` 只會檢查外層檔案，
 * 字串裡的語法錯誤完全看不到——而它壞掉的後果是「影片還能播，但字幕永遠不出現」，
 * 沒有任何錯誤訊息會浮到我們這邊（那段程式碼跑在 worker 裡，還被 try/catch 包著）。
 *
 * 這支做兩件事：
 *   1. 把 WORKER_HOOK 抽出來實際 `new Function()` 一次，確認語法過得去
 *   2. 用實際的 URL／content-type 樣本驗 `interesting()` 與 `looksText()`
 *      —— 那兩個函式判斷錯的後果是**播放卡頓**，見坑 #33
 *
 * 用法：node tools/check-inject.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(root, 'extension/src/content/inject.js'), 'utf8');
const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 1. 抽出 WORKER_HOOK ---------------------------------------------------
const m = src.match(/const WORKER_HOOK = `([\s\S]*?)`;\r?\n/);
if (!m) {
  bad('找不到 WORKER_HOOK 樣板字串——這支檢查失效了，先修它');
  process.exit(1);
}
// 要重現「樣板字串被求值之後」的樣子，兩件事都得做：
//   1. ${...} 是產生時代入的，換成不影響語法的常值
//   2. **跳脫要還原**。檔案裡寫的 `\\.` 在求值後是 `\.`；直接拿原始文字去編譯，
//      正則會變成「比對一個反斜線」，測出來的行為跟實際跑的完全不同。
const hook = m[1]
  .replace(/\$\{[^}]*\}/g, '"__x__"')
  .replace(/\\([\s\S])/g, (_, c) => (c === '\\' || c === '`' || c === '$' ? c : '\\' + c));

try {
  new Function(hook);
  ok('WORKER_HOOK 語法正確（實際編譯過，不是只看檔案）');
} catch (e) {
  bad(`WORKER_HOOK 有語法錯誤：${e.message} —— 注入後字幕會完全不出現且不報錯`);
  process.exit(1);
}

// --- 2. 在沙箱裡取出兩個判斷函式 -------------------------------------------
// hook 是 IIFE，把內部函式掛到 globalThis 才拿得到。
const probe = hook.replace(
  'var of=self.fetch;',
  'self.__interesting=interesting; self.__looksText=looksText; var of=self.fetch;');
const sandbox = {
  self: {}, BroadcastChannel: function () { this.postMessage = () => {}; },
  TextDecoder, console: { log() {} },
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(probe, sandbox);

const interesting = sandbox.__interesting;
const looksText = sandbox.__looksText;
if (typeof interesting !== 'function' || typeof looksText !== 'function') {
  bad('取不到 interesting() / looksText()——檢查的探針失效了');
  process.exit(1);
}

// --- 3. 媒體分段絕對不可以被攔 ---------------------------------------------
// 這是坑 #33：舊版最後一條規則只看大小（<300KB），HLS 的音訊分段幾乎全部
// 落在那個範圍內，於是每個分段都被 clone + TextDecoder 解一遍 → 播放卡頓。
const MEDIA = [
  ['https://cdn.f1tv.com/out/v1/abc/seg_00123.m4s', 'video/mp4', '180000'],
  ['https://cdn.f1tv.com/out/v1/abc/seg_00123.m4s', 'audio/mp4', '48000'],
  ['https://cdn.f1tv.com/out/v1/abc/audio_128k_00042.aac', '', '42000'],
  ['https://cdn.f1tv.com/out/v1/abc/video_5000k_00042.ts', '', '250000'],
  ['https://cdn.f1tv.com/out/v1/abc/init.mp4', 'application/octet-stream', '1200'],
  ['https://cdn.f1tv.com/out/v1/abc/frag_9.cmfv', '', '210000'],
  ['https://cdn.f1tv.com/out/v1/abc/frag_9.cmfa', '', '30000'],
  ['https://cdn.f1tv.com/thumb/x.jpg', 'image/jpeg', '90000'],
];
const leaked = MEDIA.filter(([u, c, l]) => interesting(u, c, l)).map(([u]) => u.split('/').pop());
leaked.length
  ? bad(`媒體分段被當成可攔截：${leaked.join('、')} —— 會 clone + 解碼每個分段，播放會卡頓`)
  : ok(`${MEDIA.length} 種媒體分段全部被排除`);

// --- 4. 字幕與清單一定要攔得到 ---------------------------------------------
const WANT = [
  ['https://cdn.f1tv.com/out/v1/abc/index_14_0.m3u8', 'application/vnd.apple.mpegurl', '40000'],
  ['https://cdn.f1tv.com/out/v1/abc/master.m3u8', '', '8000'],
  ['https://cdn.f1tv.com/out/v1/abc/sub_en_00042.vtt', 'text/vtt', '900'],
  ['https://cdn.f1tv.com/out/v1/abc/subtitle/00042', '', '900'],
  ['https://cdn.f1tv.com/out/v1/abc/manifest.mpd', 'application/dash+xml', '20000'],
  ['https://cdn.f1tv.com/opaque/segment/00042', '', '1500'],   // 判斷不出型別的小回應
];
const missed = WANT.filter(([u, c, l]) => !interesting(u, c, l)).map(([u]) => u.split('/').pop());
missed.length
  ? bad(`字幕／清單沒被攔到：${missed.join('、')} —— 會失去提前量，字幕退回逐句翻譯`)
  : ok(`${WANT.length} 種字幕與清單全部攔得到`);

// --- 5. 二進位垃圾不可以被當成文字 -----------------------------------------
// 媒體分段硬解成字串時偶爾會湊出 "-->"，那時整段垃圾會被當成 VTT 送去翻譯，
// 後端回「單句長度不可超過 1000 字元」。實際發生過。
const binary = Array.from({ length: 300 }, (_, i) => String.fromCharCode(i % 7 === 0 ? 0 : (i * 31) % 256)).join('');
looksText(binary) ? bad('二進位內容被判定成文字') : ok('含 NUL 的二進位內容被擋下');

const binaryNoNul = Array.from({ length: 300 }, (_, i) => String.fromCharCode(1 + (i * 31) % 255)).join('');
looksText(binaryNoNul) ? bad('大量控制字元的內容被判定成文字') : ok('大量控制字元的內容被擋下');

const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBox box box, Max.\n';
looksText(vtt) ? ok('正常 VTT 判定為文字') : bad('正常 VTT 被誤判成二進位 —— 字幕會完全不出現');

const m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nseg_1.vtt\n';
looksText(m3u8) ? ok('m3u8 判定為文字') : bad('m3u8 被誤判成二進位');

const cjk = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n進站進站，Max。\n';
looksText(cjk) ? ok('含中文的內容判定為文字') : bad('含中文的內容被誤判成二進位');

console.log(errors.length ? `\n❌ ${errors.length} 個問題` : '\n✅ 注入層檢查全部通過');
process.exit(errors.length ? 1 : 0);
