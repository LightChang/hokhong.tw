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
| S11 | **畫面上的麵包屑（2026-09-27）**。首頁以外每一型頁面在 `h1` 上方加一行小字麵包屑（`src/components/Breadcrumbs.astro`），路徑與 `BreadcrumbList` 同取 `crumbTrail()`；`seo-audit.mjs jsonld` 逐頁比對兩者名稱、連結、順序，不一致就不部署。390／768／1280 寬實測不破版 | `src/lib/jsonld.mjs`、`src/components/Breadcrumbs.astro`、各頁、`site.css` |
| S12 | **版面檢查（2026-09-28）**。市場清單的「導航」鈕吃到 `.rows a` 的 grid＋負邊距（2026-09-16 起），手機凸出列外、寬螢幕壓到「N 天」；改成 `.rows a:not(.nav-btn)`。新增 `scripts/layout-check.mjs`：headless chromium 在 360／390／430／768／1280 寬量各頁型，查水平捲動、按鈕超出列或視窗、按鈕壓到文字，不過 exit 1。playwright 不是站台相依，本機跑：`PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… pnpm check:layout`（加 `--base=https://hokhong.tw` 量線上） | `src/styles/site.css`、`scripts/layout-check.mjs` |
| S13 | **方法說明與警語集中到 `/about/#method`（2026-09-28）**。品項、品項×市場、市場、肉蛋、清單、颱風、節日頁的口徑、門檻、限制、提醒移到 /about/「資料怎麼算」各小節，頁面只留結論與小字「怎麼算？」（`src/components/MethodLink.astro`，錨點與共用門檻在 `src/lib/method.mjs`）。檢查：`node scripts/seo-audit.mjs method` | `src/pages/about.astro`、各頁、`scripts/seo-audit.mjs` |
| S14 | **每週菜單（2026-09-28）**。`/festival/` 改為 52 週總覽（導覽列「每週菜單」），每週一個主題（農曆節日→民俗節點→立冬補冬→當季）與 3–6 道有來源的菜；新增民俗節點頁與春夏秋冬四個季節頁（顯示這週菜單），舊節日頁網址不變。日期取自香港天文台表（`scripts/hko-calendar.mjs` → `overrides/lunar-calendar.json`），當季菜從 `overrides/recipes.json` 食譜池依盛產與輪替挑。測試：`test/weekly-menu.test.mjs` | `transform/festival-menu.mjs`、`src/pages/festival/`、`overrides/` |
| S15 | **市場頁看得見的行情表標題、0% 措辭（2026-09-28）**。市場頁的價格表原本只有 `sr-only` 標題，畫面上沒有「行情表／批發」字眼；分頁上方加 `h2`「{市場}今日行情表」與一行「{旬} 批發均價 · 元/公斤 · 更新至民國 {日期}」。`<title>`／meta description 不動（觀察窗到 10/16）。另修措辭：漲跌四捨五入為 0 時不再寫「便宜 0%」「貴 0%」，單獨出現寫「跟常年差不多」（`changeWord`），句中「比 X…」改由 `compareWord` 整句寫成「跟 X 差不多」、不上漲跌色；量價換算的「價格便宜 0%」同樣改寫。這會改到少數品項／肉蛋頁 title 的尾巴，10/16 判讀時註記 | `src/pages/market/[slug].astro`、`src/lib/pagedata.mjs`、呼叫 `changeWord` 的各頁、`site.css` |
| S16 | **節日／季節頁版面（2026-09-28）**。`h1`／答案句／`h2` 改為可見、三段全開（見 [AEO.md](AEO.md) A8）；`<title>` 不動（不在 10/16 觀察窗那批）。「每週菜單」依週次順序列，夾在中間的別主題週寫成「10/12–10/18 是重陽主題 →」連過去，隔年的週另起一段標「明年」（原本只列本主題的週，看起來像亂序又漏週）；逐道菜的數字標成「查得到價格 3／6 樣」；「其他主題」與「看每週菜單總覽 →」分開 | `src/pages/festival/[slug].astro`、`site.css` |
| S17 | **需求收錄路徑（2026-09-28，站主核可放寬 noindex 門檻）**。原門檻 `INDEX_IN`（近 90 天 ≥30 個交易日且交易量 ≥10,000 公斤）不變，另加一條：有需求證據的蔬果（`overrides/search-demand.json` 的 GSC 查詢或 Google 自動完成「{品名} 價格」、臺中零售有訪價、每週菜單食材、盛產表列得到），品項頁近 90 天 ≥10 個交易日且最近 14 天內有成交就收錄（`DEMAND_IN`）；品項×市場頁要交易日 ≥30、交易量 ≥3,000 公斤（`DEMAND_CM`）。每頁的 `quality.indexBy`（`volume`／`demand`）與 `quality.demand`（證據種類）記在 `data/page/crop*/`。清單頁、買菜清單選單、`llms-full.txt` 跟著用同一個 `indexable`。新收錄頁的 `<title>` 沿用品項頁既有格式（程式同一支）。需求證據重查：`node scripts/search-demand.mjs`（連 Google 自動完成；GSC 讀本機 `data/seo-daily`，CI 沒有，所以結果進版控） | `transform/emit-page.mjs`、`overrides/search-demand.json`、`scripts/search-demand.mjs` |
| S18 | **當季蔬果與今日菜價兩種新頁型（2026-09-28，站主核可）**。`/season/`（12 個月總表）、`/season/{1–12}/`（該月當季水果、蔬菜：資料所在月份給最近交易日批發價、跟常年同旬比、臺中零售；其他月份給往年同月批發均價與一年裡最便宜的月份）、`/today/`（全部可收錄蔬果＋肉蛋的查價表，頁內搜尋是漸進增強，表格全在 HTML 裡）。當季定義用農糧署盛產表，不用 crop-profile 的量累積（後者有上百個品項全年都算產季）。資料每天由 `transform/season-today.mjs` 重算（`season.json`、`today.json`）。導覽列加「今日菜價」「N 月當季」，首頁一行入口，品項頁列盛產月份連到各月頁。sitemap 照一般頁進（lastmod 用全站最後交易日）；`llms.txt` 主要頁面與頁面型別補上兩者。頁面上沒有方法說明，口徑在 `/about/#m-today`、`#m-seasonal` | `transform/season-today.mjs`、`src/pages/season/`、`src/pages/today.astro`、`SiteNav.astro`、`index.astro`、`crop/[slug].astro`、`about.astro`、`jsonld-pages.json` |
| S19 | **市場頁、品項頁、`/crop/` 的標題與行情表（2026-10-02，站主核可提前結束 9/25 起的標題觀察窗）**。依 GSC 查詢（台東果菜市場行情、台東批發市場、溪湖果菜市場行情表、宜蘭批發市場、小黃瓜批發價格、今天菱角批價）：①市場名稱 title／short／place 去掉市／鎮／區／鄉（台東市果菜市場→台東果菜市場），正式全名改放 H1 下方副標；②市場頁 title／H1 為「{市場}蔬菜行情」「{市場}水果行情」＋最近交易日，蔬菜／水果兩頁在頁首互連；摘要給日期、到貨量、量最大品項的均價；③市場頁第一個分頁改為最近交易日全品項行情表（上價＝各品種上價最高、平均價＝交易量加權、下價＝各品種下價最低、交易量；品項層沒有可加總的中價，所以不列中價），原「今日行情表」兩分頁改名「這旬比常年便宜／貴」、欄名寫旬均價；④品項頁 title「{品名}批發價格 {日期} 每公斤 X 元｜比常年貴／便宜 N%」，摘要帶日期與價格（與 `/today/` 同一個數字）；⑤`/crop/` 標題與看得見的 H1「蔬菜水果批發價格總覽」＋一句介紹。日期一律取自資料（`shortDate`，跨年時改給民國全日期），不看時鐘 | `overrides/market-names.json`、`transform/emit-page.mjs`（`latestDay`）、`src/lib/pagedata.mjs`、`src/pages/market/[slug].astro`、`src/pages/crop/[slug].astro`、`src/pages/crop/index.astro` |
| S20 | **市場頁的查詢字分工與前一交易日對照（2026-10-02，SERP 意圖檢查後的四個交接）**。①行情表加「與前一交易日漲跌」欄（`emit-page` 的 `latestDay.items[].dodPct` 一位小數，前一交易日沒成交寫「—」），臺北農產運銷與農業資料開放平臺都只給單日數字；②台東（代號 930）n05 當主頁，title／H1 保留「台東果菜市場行情」（水果寫在括號與 title 後段）並在頁首連「蔬菜行情看這裡」，n04 改以「台東蔬菜批發行情」為主詞並回連 n05（`SPLIT` 常數）；③標題日期：最近一次交易距資料截止日超過 7 天就不放日期，摘要改寫「最近一次交易」；④西螺（648）蔬菜頁 title、表格 H2、摘要首句改用「交易行情」（`TRADE_WORD` 常數）。數字全取自資料管線 | `src/pages/market/[slug].astro`、`transform/emit-page.mjs` |

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
