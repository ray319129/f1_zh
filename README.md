# F1TV 繁體中文即時字幕

把 F1TV 的英文 CC 字幕即時翻譯成台灣用語的繁體中文，雙語疊字顯示在影片上。

> **保留 F1TV，讓它看得懂。**
> 不是「中文轉播」，而是 F1TV 的繁體中文化工具——多視角、Onboard、Team Radio、英文原聲全部保留。

---

## 為什麼專門做一個

通用翻譯工具不懂 F1：

| 原文 | 通用翻譯 | 本工具 |
|---|---|---|
| box box box | 盒子盒子盒子 | **進站** |
| undercut | 削價競爭 | **提前進站搶位 (undercut)** |
| graining | 顆粒化 | **起顆粒** |
| flat spot | 平坦處 | **胎面平斑** |
| Bono, we're losing power | 波諾… | **Bono，動力在掉** |

內建約 250 條 F1 專屬術語，涵蓋 2026 技術規則、輪胎、空力、策略、旗號、賽道彎角俗名、歷代車手與車隊人物。

---

## 特色

- **零延遲**：重播模式會在開播時把整支影片的字幕預先翻譯完成
- **同步永遠正確**：顯示時機交給 F1TV 播放器本身，不做時間軸對齊
- **雙語顯示**：中文＋英文原文，字幕延遲時仍能靠英文關鍵字對上畫面
- **三層降級**：整軌預抓 → 即時攔截 → 逐句翻譯，任何一層失效都不會壞掉
- **成本極低**：一場 2 小時正賽約 US$0.31；接上共用後端後趨近於零

---

## 安裝

完整步驟見 **[TUTORIAL.md](./TUTORIAL.md)**。

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/)，並在 `chrome://extensions` 開啟「開發人員模式」與「允許存取檔案網址」
2. 新增腳本，貼上 [`f1tv-zh-subtitles.user.js`](./f1tv-zh-subtitles.user.js) 全部內容
3. 到 [console.anthropic.com](https://console.anthropic.com) 申請 API key 並儲值
4. 油猴選單 → 🔑 設定 API key
5. 開 F1TV，**播放器設定裡開啟英文 CC**，開始播放

---

## 共用譯文後端（選配）

所有人看同一支影片拿到的是同一份英文字幕，所以譯文可以共用。第一次有人看就翻一次存起來，之後所有人直接下載，**零 API 呼叫、零延遲**。

部署見 **[backend/README.md](./backend/README.md)**（Cloudflare Workers + KV，免費額度足夠）。

不設定也完全能用，只是每個人各自付自己的翻譯費用。

---

## 專案文件

| 檔案 | 內容 |
|---|---|
| [`handoff.md`](./handoff.md) | 技術架構、決策紀錄、踩過的坑、成本演進、路線圖 |
| [`TUTORIAL.md`](./TUTORIAL.md) | 安裝、使用、疑難排解、術語表維護、開發者指南 |
| [`GO-TO-MARKET.md`](./GO-TO-MARKET.md) | 社群、推廣、金流、客服 |
| [`CLAUDE.md`](./CLAUDE.md) | 給 AI 協作工具的專案指引 |

---

## 貢獻術語

**術語表是這個專案最重要的部分。** 看到翻錯的專有名詞或術語，開一個 issue 告訴我：

- 英文原文
- 目前的翻譯
- 你認為正確的翻譯

會直接加進詞庫。

---

## 聲明

本專案為**第三方獨立工具**，與 Formula 1、F1TV、Formula One World Championship Limited 無任何隸屬或合作關係，亦未獲其背書。所有商標歸原權利人所有。

本工具需要你自備有效的 F1TV 訂閱，不提供也不涉及任何賽事影音內容的取得或散布。

## 授權

MIT
