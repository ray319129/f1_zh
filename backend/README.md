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

`src/index.js` 的 `SYSTEM_PROMPT` 與 userscript 的 `SYSTEM_PROMPT` **必須逐字相同**。改完跑：

```bash
node tools/check-prompt.js
```

### 為什麼是「逐字相同」而不是「語意一致」

v1.3 以前後端只放精簡版（34 條術語），理由是「後端只翻零星未命中句，完整術語表放收割器就好」。**這個理由是錯的**，錯在兩個地方：

1. **擴充功能的翻譯 100% 由後端執行。** 使用者沒有 API key，沒有收割器。共用快取沒命中時，他拿到的就是精簡術語表翻出來的結果——比 userscript 差一截。
2. **精簡版約 650 tokens，低於 Haiku 的 4,096 快取門檻。** `cache_control` 在門檻以下是**靜默失效**的：不報錯，只是每次都全額計費。等於為了「省 prompt」反而一直多付錢。

搬完整份之後兩個問題一起解決：術語表補齊，token 數也跨過門檻。

### 為什麼用複製而不是共用模組

userscript 必須是單一檔案（Tampermonkey），backend 由 wrangler 打包，兩邊沒有共用模組的辦法。所以比照 `normKey()` 的前例：允許複製，但用 `tools/check-prompt.js` 擋漂移。

---

## 成本與限制

- **Cloudflare 免費方案**：每天 100,000 次 Workers 請求、KV 每天 100,000 次讀 / 1,000 次寫。以早期規模綽綽有餘。
- **KV 寫入次數是最先會碰到的天花板**（每天 1,000 次）。v1.3 起 `/v1/translate` 不論翻幾句都只寫 1 次 KV（v1.2 以前是每句一次，實測 38 分鐘就把當日額度用光，見 handoff 坑 #19）。收割器的 `POST /v1/subs` 一次寫一個 bundle 也只佔 1 次 —— **仍是建議的主要灌注方式**，因為它能在賽前就把整支影片灌滿。
- 速率限制 120 req/min/IP，KV 最終一致性，屬近似值。

---

## 尚未實作（商品化才需要）

- 帳號系統與 JWT
- 金流 webhook
- 免費層配額（每場比賽前 15 分鐘）
- 靜默失效遙測回報端點
- 直播收割器（見 `handoff.md` 7.2）
