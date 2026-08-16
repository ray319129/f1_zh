#!/usr/bin/env node
/**
 * 把診斷報告裡的 CDN 存取權杖洗掉。
 *
 * 背景：v0.4.0 為了偵錯把網址的截斷拿掉，順手破壞了「報告不含任何權杖」
 * 的原設計（坑 #31）。v0.6.1 已在產生端修好（maskUrl），
 * 但那之前產生的報告已經存在 repo 裡。
 *
 * 這支處理的是**已經存在的檔案**。保留報告的診斷價值（網域、路徑結構、
 * 全長），只把授權段換成遮蔽版——與 maskUrl 的輸出格式一致。
 *
 * ⚠️ 不重寫 git 歷史。那些權杖 24 小時內就會過期，而 repo 是 private，
 *    重寫歷史的風險與代價遠高於收益。**要判斷的是比例，不是「越乾淨越好」。**
 *
 * 用法：node tools/scrub-reports.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dry = process.argv.includes('--dry');

// F1TV 的授權段：/v2/pa_<很長的 base64>/...
const TOKEN_RE = /pa_([A-Za-z0-9_\-=]{40,})/g;

function mask(token) {
  return `pa_${token.slice(0, 8)}…${token.slice(-6)}[共${token.length}字元·已遮蔽]`;
}

let files;
try {
  files = execSync('git -c core.quotepath=off ls-files', { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => f.includes('診斷報告'));
} catch (e) {
  console.error('讀不到 git 檔案清單：' + e.message);
  process.exit(1);
}

let changed = 0, tokens = 0;
for (const rel of files) {
  const p = path.join(root, rel);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
  if (!TOKEN_RE.test(text)) { TOKEN_RE.lastIndex = 0; continue; }
  TOKEN_RE.lastIndex = 0;

  let n = 0;
  const out = text.replace(TOKEN_RE, (m, tok) => { n++; return mask(tok); });
  tokens += n;
  changed++;
  console.log(`${dry ? '[預覽] ' : ''}${rel} — 遮蔽 ${n} 處`);
  if (!dry) fs.writeFileSync(p, out, 'utf8');
}

console.log('');
console.log(dry
  ? `[預覽] 共 ${changed} 個檔案、${tokens} 處權杖。加 --dry 以外的參數才會實際寫入。`
  : `✅ 已處理 ${changed} 個檔案、${tokens} 處權杖。報告的診斷價值不受影響。`);
