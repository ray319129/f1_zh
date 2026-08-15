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
 *
 * 環境變數（wrangler secret put）
 *   ANTHROPIC_API_KEY   Anthropic 金鑰
 *   ADMIN_TOKEN         上傳用的管理權杖
 *   CLIENT_TOKEN        用戶端權杖
 * KV binding: SUBS
 */

const MODEL = 'claude-haiku-4-5';
const BATCH_MAX = 20;              // 一次 API 呼叫最多翻幾句
const RATE_LIMIT_PER_MIN = 120;    // 每 IP 每分鐘的 /v1/translate 上限
const BUNDLE_MAX_LINES = 20000;    // 單支影片的譯文上限，防呆

// ---------------------------------------------------------------------------
// 翻譯用的 system prompt
// ⚠️ 必須與 userscript 的 SYSTEM_PROMPT 保持一致，否則同一句在兩邊會翻出不同結果。
//    維護方式見 backend/README.md 的「Prompt 同步」章節。
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是 F1 賽事轉播的即時字幕翻譯器。將輸入的英文轉播評論翻譯成台灣賽車圈慣用的繁體中文。

【輸出規則 — 最高優先】
1. 只輸出譯文本身。禁止任何解釋、前言、引號、標記、註解或原文回顯。
2. 輸入是即時字幕，可能是不完整的句子片段。直接翻譯你看到的部分，不要腦補補完。
3. 語氣口語、短促，像現場轉播員在講話。
4. 省略英文口語贅字：well, you know, I mean, sort of, kind of, actually, basically。
5. 標點只用「，」「。」「！」「？」。
6. 若輸入是雜音標記或無意義字串，輸出空字串。

【批次模式】
若輸入以「【批次翻譯】」開頭、每行以「數字.」起始：
- 逐行翻譯，輸出同樣每行以「數字.」起始，編號與行數完全對應。
- 不要合併、拆分、重排或省略任何一行。
- 除了編號行以外不要輸出任何其他文字。

【專有名詞】
車手、車隊、賽道、彎角名一律保留英文原文，不音譯，不用中國大陸譯名。
保留不譯的縮寫：DRS, ERS, MGU-K, PU, ICE, VSC, SC, FIA, GP, Q1~Q3, P1~P20, DNF, DSQ

【核心術語】
box / box box → 進站
undercut → 提前進站搶位 (undercut)
overcut → 延後進站搶位 (overcut)
stint → 該段輪胎里程
out lap / in lap → 出站圈 / 進站圈
degradation / deg → 輪胎衰退
graining → 起顆粒
blistering → 起水泡
flat spot → 胎面平斑
soft / medium / hard → 軟胎 / 中性胎 / 硬胎
intermediates → 半雨胎
dirty air → 亂流
slipstream / tow → 尾流
lock up → 鎖死煞車
understeer / oversteer → 轉向不足 / 轉向過度
apex → 彎心
track limits → 賽道界線
safety car / VSC → 安全車 / 虛擬安全車
red flag / yellow flag / blue flag → 紅旗 / 黃旗 / 藍旗
five-second penalty → 五秒加罰
drive-through penalty → 通過維修道處罰
pole position → 竿位
backmarker → 後段車手
purple sector → 全場最速分段
gap / delta → 差距
deploy → 電能釋放
Manual Override → 手動超車模式 (Manual Override)
active aero → 主動式空力
X-mode / Z-mode → X 模式 / Z 模式
harvest / recharge → 回收電能 / 回充
clipping → 電能耗盡掉速
unsafe release → 危險放行
parc ferme → 賽後封存 (parc ferme)
stewards → 賽會幹事`;

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
async function translateBatch(env, lines) {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `【批次翻譯】共 ${lines.length} 句\n${numbered}` }],
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
  }, 200, { 'cache-control': 'public, max-age=60' });
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
        bundle.lines[m.k] = zh;       // 只改記憶體，最後一次寫回
        translated++;
      }
      usageTotals.input_tokens += usage.input_tokens || 0;
      usageTotals.output_tokens += usage.output_tokens || 0;
      usageTotals.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    } catch (e) {
      // 已經翻好的先存起來，不要因為後面失敗就整批丟掉
      if (translated) { try { await writeBundle(env, cid, bundle); } catch (e2) { /* noop */ } }
      return json({ lines: result, translated, error: String(e.message || e) }, 502);
    }
  }

  // 3) 一次請求只寫一次 KV
  if (translated) await writeBundle(env, cid, bundle);

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

      return err('not found', 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
