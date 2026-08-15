# f1zh-api — 共用譯文後端

Cloudflare Workers + KV。對應 `handoff.md` 路線圖的 **P1**。

## 為什麼需要它

所有人看同一支影片拿到的是**同一份英文字幕**，所以譯文可以共用。

```
第一次有人看  → 翻譯一次 → 存進 KV
之後所有人    → 直接下載，零 API 呼叫
```

| | 各自翻譯 | 共用快取 |
|---|---|---|
| 每用戶每月 API 成本 | $0.62 ~ $2.40 | **趨近 $0** |
| 整季全站 API 成本 | 隨用戶數線性成長 | **固定約 US$40** |

---

## 部署步驟

### 1. 安裝 wrangler 並登入

```bash
npm install -g wrangler
wrangler login
```

### 2. 建立 KV namespace

```bash
cd backend
wrangler kv namespace create SUBS
```

把回傳的 `id` 填進 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 3. 設定機密

```bash
wrangler secret put ANTHROPIC_API_KEY   # 你的 Anthropic 金鑰
wrangler secret put ADMIN_TOKEN         # 自己想一個長字串，只有你知道
wrangler secret put CLIENT_TOKEN        # 自己想一個長字串，會放進 userscript
```

產生隨機權杖：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 4. 部署

```bash
wrangler deploy
```

會得到一個網址，例如 `https://f1zh-api.<你的帳號>.workers.dev`

### 5. 驗證

```bash
curl https://f1zh-api.xxx.workers.dev/v1/health
```

預期回傳 `{"ok":true,...}`

---

## API

所有回應皆為 JSON，並帶 CORS 標頭。

### `GET /v1/health`
健康檢查。無需權杖。

### `GET /v1/config`
遠端設定（選擇器、contentId 規則、隱藏用 CSS）。無需權杖。

**這是 `handoff.md` 防禦順位第 1 名的實作。** F1TV 改版時改這裡就能熱修所有用戶，不用等 1~3 天的商店審核。選擇器是**陣列**，依序嘗試——灰度推送期間新舊版可同時支援。

### `GET /v1/subs?cid=<contentId>`
取回整支影片的譯文。需 `X-Client-Token`。

```json
{ "cid": "1000010512", "count": 1101, "updatedAt": "...", "lines": { "<正規化原文>": "譯文" } }
```

### `POST /v1/subs`
上傳譯文。需 `X-Admin-Token`。採**合併**寫入，不會覆蓋既有內容。

```json
{ "cid": "1000010512", "lines": { "<原文或正規化後的 key>": "譯文" } }
```

### `POST /v1/translate`
翻譯尚未快取的句子。需 `X-Client-Token`。

伺服器先查 `line:` 快取，未命中才呼叫 Anthropic，翻完寫回快取。**金鑰只存在伺服器端。**

```json
{ "cid": "1000010512", "lines": ["English line 1", "English line 2"] }
```

回應含 `cached` / `translated` / `usage`，可用來確認共用是否生效。

---

## 資料模型（KV）

| Key | 內容 | 寫入者 |
|---|---|---|
| `bundle:<cid>` | 整支影片的譯文 map | 管理員上傳 |
| `line:<cid>:<normKey>` | 單句譯文，TTL 180 天 | `/v1/translate` |
| `rl:<ip>:<分鐘>` | 速率限制計數，TTL 120 秒 | 自動 |

**`bundle` 走單一寫入者模型**（只有你的收割器會寫），所以 read-modify-write 沒有競態問題。
若日後開放用戶端上傳，要改用 Durable Objects 或改成純 `line:` 逐句寫入。

---

## Prompt 同步 ⚠️

`src/index.js` 的 `SYSTEM_PROMPT` 與 userscript 的 `SYSTEM_PROMPT` **必須語意一致**，否則同一句在兩邊會翻出不同結果，快取就失去意義。

後端這份是精簡版（只保留規則與核心術語），因為：

- 後端翻的是**未命中的零星句子**，量少
- 完整術語表在 userscript（收割器）那邊，那才是產生 bundle 的主力

**改動原則：規則區塊兩邊要一致；術語表可以只加在 userscript。**

日後若要單一來源，可改成後端用 `/v1/config` 一併下發 prompt，userscript 啟動時拉取。

---

## 成本與限制

- **Cloudflare 免費方案**：每天 100,000 次 Workers 請求、KV 每天 100,000 次讀 / 1,000 次寫。以早期規模綽綽有餘。
- **KV 寫入次數是最先會碰到的天花板**（每天 1,000 次）。`/v1/translate` 每翻一句寫一次，所以大量冷啟動時要留意。收割器改用 `POST /v1/subs` 一次寫一個 bundle，只佔 1 次寫入 —— **這是建議的主要灌注方式**。
- 速率限制 120 req/min/IP，KV 最終一致性，屬近似值。

---

## 尚未實作（商品化才需要）

- 帳號系統與 JWT
- 金流 webhook
- 免費層配額（每場比賽前 15 分鐘）
- 靜默失效遙測回報端點
- 直播收割器（見 `handoff.md` 7.2）
