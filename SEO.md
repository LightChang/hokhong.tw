# SEO：被 Google 收錄、排得到

> 往哪裡長、下一步做什麼：見 [GROWTH.md](GROWTH.md)。

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
node scripts/seo-audit.mjs lastmod     # sitemap lastmod 逐筆重算比對
node scripts/seo-audit.mjs jsonld      # JSON-LD 依官方規則驗證（有錯誤 exit 1）
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
| S8 | **`lastmod` 逐頁化（2026-09-27）**。S1 之後全站仍是同一個日期，Google 一樣會判定不可信。改成每一頁取「該頁資料最後一次實際變動的交易日」：品項頁取該品項最新一筆交易日、品項×市場頁取該市場最新一筆、市場頁取最新到貨日、肉蛋頁取最新報價日；首頁、榜單、清單、颱風、節日、`/about/` 畫面上都有「更新至」與全站數字，用全站最後交易日。只讀 `data/page`、不看時鐘，同資料建兩次日期不變。檢查：`node scripts/seo-audit.mjs lastmod`（逐筆重算比對，有 ✗ 時 exit 1） | `src/lib/lastmod.mjs`、`astro.config.mjs`、`scripts/seo-audit.mjs` |
| S9 | **首頁與 `/cheap/` 的「最新行情」區塊（2026-09-27）**。依最近成交日排序、同日再依當天成交量，連到可收錄品項頁，避開同頁已列過的品項——每天換一批，讓爬蟲從入口頁走得到資料剛變動的品項頁 | `src/lib/pagedata.mjs`（`latestTradedCrops`）、`index.astro`、`cheap.astro` |

| S10 | **JSON-LD 集中產生、安全輸出、部署前驗證（2026-09-27）**。全部類型由 `src/lib/jsonld.mjs` 組、`src/components/JsonLd.astro` 在 `Base.astro` 的 `<head>` 輸出，頁面只傳資料（`crumbs`／`dataset`／`itemList`）；字串化後把 `<` 跳脫成 `\u003c`（值裡有 `</script>` 也不會截斷，測試在 `test/jsonld.test.mjs`）。停止輸出 `FAQPage`（Google 2026-05-07 起停止顯示）。市場頁與肉蛋頁的 Dataset description 補到 50 字以上，用畫面上同一個字串（副標、圖說、頁尾來源行）組成。daily.yml「檢查結構化資料」跑 `pnpm test` 與 `seo-audit.mjs jsonld`，有錯誤就不部署 | `src/lib/jsonld.mjs`、`src/components/JsonLd.astro`、`jsonld-pages.json`、`vendor/seo-ops-jsonld/`、`scripts/seo-audit.mjs` |

**noindex 頁不輸出 JSON-LD**：那些頁本來就不想被收錄，給了等於請引擎去理解一個我們說不要收的頁面。

## 結構化資料的規則從哪來、怎麼複查

規則以 Google 官方文件為準，查證紀錄（每條附來源網址與查證日）在 seo-ops：
`/mnt/yao-care/seo-ops/jsonld/README.md`（查證紀錄與「查不到或衝突」清單）、`rules.json`（機器可讀規則）。
本 repo 用的是它的副本 `vendor/seo-ops-jsonld/`（CI runner 沒有 `/mnt`），來源 commit 與同步指令見該目錄 README。
站台自己的頁型要求（哪一型必須有哪些類型、每條依據）在 `jsonld-pages.json`。

幾個會影響判斷的結論（2026-09-27 查證）：`FAQPage` 已停止顯示；`Dataset` 只用於 Dataset Search、不用於一般搜尋；
`BreadcrumbList` 臺灣可見但只在桌機；網站名稱（`WebSite`）所有語言與裝置可見；`ItemList` 在中文站沒有對應的強化結果。

**每季複查一次**（或 Search Central 更新紀錄出現結構化資料相關項目時）：

1. 依 `/mnt/yao-care/seo-ops/jsonld/README.md`「重做查證」的步驟更新正本（那一步在 seo-ops 做，不在這裡）。
2. 依 `vendor/seo-ops-jsonld/README.md`「同步」把新版拉進來，改來源 commit。
3. `node transform/run.mjs && node scripts/seo-audit.mjs jsonld`；有新錯誤就先修站台或調 `jsonld-pages.json`（附依據），不要調低嚴重度蓋過去。
4. 規則有變動時在上面「做了什麼」加一列。

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
