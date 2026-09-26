# hokhong.tw 專案手冊（索引）

好康 hokhong.tw：農產品批發行情主題站。**服務對象是買菜的人**——首頁一頁寬一頁高，只回答「這週什麼划算、什麼先別買」；品項用俗名（甘藍→高麗菜）；主數字是「比常年便宜／貴幾 %」而非價格。

**本檔只寫查法與紅線，不寫現況數字。**詳細設計與來源盤點見 `README.md`（單一真實來源），各主題另有專檔（見下方文件地圖）。主機層維運知識（volume、pm2、NPM、seo-ops 全貌）見 `/root/CLAUDE.md`——cwd 在 `/mnt` 時它不會自動載入，需要時自己讀。

## § 現況一律用指令查

文件禁止寫死列數、頁數、幾支來源、幾步轉換、覆蓋率、站台品項數——資料每天更新，寫進 Markdown 隔天就是錯的。**輸出即事實**：

| 要知道什麼 | 查法 |
|---|---|
| 全部（排程／資料／頁面／release／線上） | `node scripts/status.mjs` |
| 取得層幾支、轉換層幾步與步名順序 | `node scripts/status.mjs steps`、`node transform/run.mjs --list` |
| 解釋層各支的判準與「算不出來就不給」的條件 | `transform/STORAGE.md` §6 的表；數字一律看該支的 stderr 輸出 |
| 各來源上次成功與下次到期 | `node ingest/run.mjs --list` |
| 列數、交易日數、對帳、作物身分、覆蓋率、磁碟 | `node scripts/status.mjs data` |
| 頁數、可收錄比例、零售與價格鏈覆蓋、颱風 | `node scripts/status.mjs page` |
| **線上現況**（最近幾次 daily.yml、Pages 設定、sitemap 筆數） | `node scripts/status.mjs online` |
| 搜尋引擎線上表現（需 gcloud 登入） | `node scripts/seo-status.mjs` |
| 本機 `dist/` 的 SEO/AEO/GEO 自檢 | `node scripts/seo-audit.mjs` |

**本機 checkout 的 `data/` 常落後線上好幾天**——每日更新發生在 Actions runner 上。要講「站上現在有幾頁」，權威是 `status.mjs online` 與該次 run 的 log，不是本機。

文件裡容許的數字只有三種：外部來源的事實（政府平台公布的市場家數）、設計常數（門檻、規則、單位）、標了日期的歷史快照。

## § 架構速覽

- **無主機**。GitHub Pages 靜態站（Astro），repo `LightChang/hokhong.tw`（public）。
- **每天 05:17（台北）** 由 `.github/workflows/daily.yml` 自己跑：下載當期資料 → 抓新行情 → 轉換 → `astro build` → 部署 Pages → 寫回 release。
- **資料不進 git**（`data/` 已在 `.gitignore`），放在 release：`data-history`（回補全史，永不變動）與 `data-current`（當期，每天覆蓋）。
- 取得層 `ingest/sources/`，排程執行器 `ingest/run.mjs` 依各來源頻次算下次到期；轉換層 `transform/`，入口 `transform/run.mjs` 一次跑完全部步驟，**最後一步是 `astro build`**，跑完 `dist/` 就是最新站台。

## § 常用指令

```bash
pnpm install                       # CI 用 pnpm install --frozen-lockfile
node transform/run.mjs             # 本機重建全站（最後一步 build）
npx astro preview --port 4400      # 看完一定要 kill（紅線，見下）
./scripts/publish-data.sh both     # 把本機資料上傳到 release（首次設定，需 gh CLI）
DESIGN_TOKENS_SRC=/path/to/templates/styles.css pnpm run sync:tokens   # 設計 token 由另一 repo 同步，非必要不跑
```

## § 文件地圖

| 主題 | 檔案 |
|---|---|
| 來源盤點、產品定位、競品缺口、對應 seh.tw v2 架構、刻意不做的事 | `README.md` |
| 排程規格、資料如何在無狀態 runner 間延續、兩個會讓排程悄悄失效的坑 | `ingest/SCHEDULE.md` |
| 儲存結構與設計決定（含 §12 作物身分規則） | `transform/STORAGE.md` |
| 2026-09-11 來源實測結果（端點、起始年、資料形狀） | `ingest/probe/sources.md` |
| 被 Google 收錄 | `SEO.md` |
| 成為直接答案 | `AEO.md` |
| 被生成引擎引用時前提不被講錯 | `GEO.md` |

## § seo-ops 納管（2026-09-17 起）

由 **yao-care 實例** `/mnt/yao-care/seo-ops/` 管理，不是 `/root/seo-ops`（不存在）。

- 站台設定：`/mnt/yao-care/seo-ops/sites/hokhong.tw.json`；策略拍板：`playbooks/hokhong.tw.md`；反思輸出：`reflections/hokhong.tw/`
- 排程（collect／reflect／brain／週報）：`grep hokhong /etc/cron.d/seo-ops-yao-care`
- 維護與審查的單一真實來源：`/mnt/yao-care/seo-ops/MAINTENANCE.md`
- Google 身分：GCP 專案 `hokhong-tw` 的專屬服務帳號，**與其他站不共用**（身分隔離紅線）。站台自己的 `scripts/seo-status.mjs` 走 gcloud 模擬不用金鑰，seo-ops 框架走金鑰檔，兩條路同一個 SA。
- Slack 頻道與 token 路徑見上述 site json。

## § 解釋層（2026-09-26 起）

同一份資料換角度切出來的答案，各自一支轉換、各自一份 `data/page/*.json`（清單與判準見
`transform/STORAGE.md` §6）。設計原則兩條，改動時不要破壞：

- **算不出可靠結論就不給數字**，不要給一個沒有根據的。相關係數不夠、樣本不夠、對照年不夠、
  量差超出樣本範圍、累積天數不夠——每一支都有自己的擋門，頁面只讀結果不重新發明門檻。
- **門檻是設計常數，照實際分佈訂一次就寫死**，不要每天重算（重算會讓「會跳的品項」這種
  標籤每天換一批）。訂的時候把當時的分佈寫進註解，日後才知道為什麼是這個數。

踩過的坑都留在各支的註解裡：進行中的旬不能拿來跟常年比（會得到假的「量少 57%」）、
颱風季會把年節效應灌水、休市日集中在固定星期所以星期別比較要控星期、「其他」這個統包桶
不能算進品種價差、線性迴歸不要外推到樣本邊緣。

## § 紅線

- **現況數字不入文件**：見第一節。發現任何檔寫死現況，當場改成查法。
- **自己起的 preview／測試 server 一定要收**（用完必 kill；astro 換 port 會掩蓋洩漏）。
- **資料不進 git**：`*.tar.gz` 已忽略——曾因 `publish-data.sh` 執行到一半跑 `git add -A`，把 569 MB 的 tar 加進 commit。
- **跨年時的 `HISTORY_UNTIL`**：`data-current` 必須涵蓋 `HISTORY_UNTIL` **之後的所有年份**，不是只有今年；否則跨年時去年的 parquet 既不在 current 也不在 history，而 actions/cache 只在 miss 時儲存，等於整年資料消失。要把某一年併進 history：本機跑 `./scripts/publish-data.sh history` 後才把 `daily.yml` 裡的數字往上調。
- **scheduled workflow 的 60 天保活**：public repo 的排程在「60 天無活動」後會被自動停用，daily.yml 最後一步 commit 時間戳就是為此，別拿掉。
- **零售價不可用單一倍數推估**：零售÷批發的倍率逐品項差很多（範圍見 `status.mjs page`，站上權威版本在 `/about/`）；對不上的品項只給批發價，不推估攤價。
- **單一來源的 confidence 不能給 1.0**：開放平台筆數少於原系統、有延遲與事後修正，機制見 `README.md` §1 與 `transform/STORAGE.md`。
- **站間連結不掛 UTM**（站群共用 GA4 時會把 organic 洗成 owned）：`grep -rn 'utm_source=' src/`。
- **設計規範**：oklch token／`--text-*` 字級階梯（≥18px）／禁寫死 px 字級／禁 CDN；token 來自 templates repo，改樣式前先確認是否該回上游改。
