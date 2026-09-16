# SEO：被 Google 收錄、排得到

2026-09-16 執行。姊妹文件：[AEO.md](AEO.md)（成為直接答案）、[GEO.md](GEO.md)（被生成引擎引用時前提不被講錯）。

> **這份文件不寫現況數字。**
> 收錄數、入鏈數、曝光量每天都在動，寫進 Markdown 隔天就是錯的，而且錯得很有說服力。
> 要看現況就跑下面兩支指令，輸出即事實。
> 文件裡出現的數字只有兩種：**標了日期的歷史快照**（用來對照「改之前長怎樣」），
> 以及**設計常數**（門檻、規則）。兩者都不會因為今天資料更新而失效。

## 怎麼查現況

```bash
# 線上：GSC 收錄進度、結構化資料判定、曝光、GA4 流量來源
node scripts/seo-status.mjs            # 全部
node scripts/seo-status.mjs index      # 只看收錄
node scripts/seo-status.mjs traffic    # 只看曝光與流量

# 本機：dist/ 的 sitemap 一致性、內部連結、結構化資料覆蓋
npx astro build && node scripts/seo-audit.mjs
node scripts/seo-audit.mjs links       # 只看內部連結
node scripts/seo-audit.mjs sitemap     # 只看 sitemap 一致性
```

`seo-status.mjs` 不下載金鑰：以 gcloud 使用者 token 模擬服務帳號
`hokhong-index@hokhong-tw.iam.gserviceaccount.com`。先決條件是 `gcloud auth login` 過，
且該服務帳號已在 GSC／GA 後台加為使用者。

## 監看：看哪個數字

**不要看 sitemap 報表的 `indexed`。** 2026-09-16 實測：該欄位回報 `indexed: 0`，
但同一時間用 URL 檢查 API 逐頁查，首頁、`/cheap/`、`/crop/n04-00201002001/`、
`/market/n04-109/`、`/about/` 都已經是「已提交並建立索引」。sitemap 報表會落後好幾天，
拿它當進度會得到「完全沒被收錄」的錯誤結論。

| 看什麼 | 怎麼取 | 判讀 |
|---|---|---|
| **收錄進度** | `node scripts/seo-status.mjs index` 的逐頁抽查 | `PASS` ／「已提交並建立索引」的比例往上走就對了。九個樣本涵蓋每一種頁型，某一型全部卡住才是訊號 |
| **檢索是否正常** | 同上，看 `✗` 標記 | 正常時不該出現任何 `✗robots=` `✗fetch=` `✗canonical→`。出現就是真的要修 |
| **曝光與查詢** | `node scripts/seo-status.mjs traffic` | 曝光離開 0 之後，才有資料做關鍵字調整（見下方待辦） |
| **自然搜尋流量** | 同上，GA4 區塊的 `google / organic` | 與 GSC 點擊對照，長期落差大再查追蹤碼 |
| **本機是否有結構性錯誤** | `node scripts/seo-audit.mjs` | 每個 `✓` 都該維持是 `✓`。sitemap 混進 noindex 頁、canonical 不等於自身、孤兒頁，這三個是會直接吃掉收錄的 |

`seo-status.mjs` 的期間固定取「昨天往前 28 天」，不含今天——GSC 有 2–3 天延遲，
把今天算進去會看到假的下跌。

## 做了什麼

| # | 任務 | 動到 |
|---|---|---|
| S1 | **`lastmod` 不再每天刷新**。原本是 `lastmod: new Date()`，每天 build 都把全站的 lastmod 往前推，等於宣告「每一頁每天都改」，Google 會停止採信這個欄位。改成讀 `data/page/index.json` 的 `lastDate`（資料最後交易日）：來源沒有新資料的那天，lastmod 就不動 | `astro.config.mjs` |
| S2 | **補內部連結**。品項×市場頁互連同品項的其他市場、並回連市場頁；市場頁列出主力品項連到品項×市場頁；肉蛋頁互連 | `crop/[slug]/[market].astro`、`market/[slug].astro`、`meat/[slug].astro` |
| S3 | **新增 `/meat/` 索引頁**。原本 `/meat/` 是 404，而每個肉蛋頁只能借 `/crop/` 當麵包屑上層、語意是錯的。這頁刻意不做成 `/crop/` 肉蛋分頁的複製：那邊只有品名與漲跌，這裡給價格、單位與來源口徑差異 | 新增 `src/pages/meat/index.astro` |
| S4 | **`BreadcrumbList`／`WebSite`／`Organization`（含 logo）／`WebPage`（含 `dateModified`）JSON-LD**。`dateModified` 取資料最後交易日，不是 build 時間 | `Base.astro` |
| S5 | **`ItemList`**。`/cheap/`、`/crop/`、`/market/`、`/meat/` 的本體就是排序清單 | 四支清單頁 |
| S6 | **`og:image`／`og:site_name`／`twitter:card`** | `Base.astro` |
| S7 | **首頁頁尾補來源聲明**。首頁是 `bare` 模式，原本沒有來源機關與授權。這是全站權重最強、也是生成引擎最常抓的一頁 | `index.astro` |

**noindex 頁不輸出 JSON-LD**：那些頁本來就不想被收錄，給了等於請引擎去理解一個我們說不要收的頁面。

## 改動前的狀態（2026-09-16 快照，僅供對照）

跑 `node scripts/seo-audit.mjs` 看現在的值；下面這些是**改之前**量到的，不是現況。

- 可收錄頁裡，只有 1 個入鏈的：1,201 頁
- 可收錄頁入鏈中位數：1
- JSON-LD：0 頁
- `og:image`：0 頁
- sitemap `lastmod`：1,395 筆全部同值，且每天 build 刷新
- `/meat/`：404

**點擊深度刻意沒有改**：品項×市場頁仍在第 3 層（現值跑 `node scripts/seo-audit.mjs links` 看
「點擊深度」那行）。那是 `/crop/{品項}/{市場}/` 這個網址結構本來就決定的，互連是橫向的、
拉不上來。入鏈數才是這批頁面原本的瓶頸，深度 3 本身不是問題。

## 還沒做的

- **外部連結**。新站沒有任何外部訊號。切入點是本站獨有的：官方平台只留兩年，
  這裡有民國 101 年起的全史，且做了產地→批發→零售的縱向對照。
  **這件事要對外發送，需要你決定，我不代發。**
- **關鍵字層級調整**。等 `node scripts/seo-status.mjs traffic` 的曝光離開 0，
  再抓 query 維度找「曝光高但點擊低」的頁調 title、以及「有曝光但沒有對應頁」的需求補頁。
  現在做是無資料猜測。

## 擬定計劃時錯掉的兩條前提

留著當記錄：這兩條都是「用一個數字套到另一個範圍」造成的，執行前實測才發現。

- **「`/crop/` 只連 174 個、要連滿 1,339」** → 錯。`data/page/index.json` 的 `counts.crops`
  才是品項總數，`/crop/` 已經把其中可收錄的全部列出；1,339 是把 `counts.cropMarket`
  一起算進去的數字。真正的缺口是品項×市場頁彼此不相連。
  （現值：`python3 -c "import json;print(json.load(open('data/page/index.json'))['counts'])"`）
- **「`/meat/` 在第 3 層」** → 錯。實測是深度 2。真正的問題是入鏈只有 1 個。
