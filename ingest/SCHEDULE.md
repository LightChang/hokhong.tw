# 更新排程

站台跑在 **GitHub Actions + GitHub Pages**，排程由 [`.github/workflows/daily.yml`](../.github/workflows/daily.yml)
負責，**不需要在任何主機上裝 cron**。

| 項目 | 設定 |
|---|---|
| 觸發 | `cron: '17 21 * * *'`（UTC）＝ 台北 05:17，另可 `workflow_dispatch` 手動跑 |
| 為什麼是 :17 | 整點前後是 Actions 高峰，排程可能被延遲或丟棄，官方建議避開 |
| 一次跑多久 | transform + build 實測 69 秒，加上資料下載／上傳約 5–10 分鐘（timeout 設 60 分） |
| 費用 | public repo 使用標準 runner，Actions 分鐘數免費且無上限 |

## 資料怎麼在無狀態的 runner 之間延續

Actions 每次都是全新的機器，所以資料放在 release：

| Release tag | 內容 | 大小 | 更新頻率 |
|---|---|---|---|
| `data-history` | 2012–2025 的 raw 與 parquet | 346 MB + 223 MB | 永不變動 |
| `data-current` | 今年 raw／parquet、`data/observation`、`ingest/state.json` | 約 150 MB | 每天由 workflow 覆蓋回寫 |

歷史那份另外用 Actions cache（key `data-history-v1`，10 GB 額度）快取，穩定狀態下每天只下載當期那 150 MB。
`aggregate`／`identify`／`typhoon` 都用 `readL1()` 讀**全部** parquet，所以歷史 parquet 必須在場，
這是它要被快取而不是捨棄的原因。

首次上傳（在本機做一次）：

```bash
./scripts/publish-data.sh both
```

## 兩個會讓排程悄悄失效的坑

1. **public repo 的 scheduled workflow 在 60 天無活動後會自動停用。** GitHub 文件沒有明說
   「workflow 執行本身」算不算活動，所以 workflow 最後一步會 commit 一個
   `.github/last-update` 時間戳，確保 repo 每天有活動。
2. **rolling-window 來源漏抓就永久缺。** `tap-trans` 與 `taichung-retail` 的來源端只保留近一年，
   檔案以抓取日命名。排程若停掉數日，那幾天的資料補不回來。

## 若要改回自架主機

workflow 做的事等同於下面兩行 cron，`$HOKHONG` 換成專案絕對路徑：

```sh
# 1. Node 22 以上（本機實測 v22.17.0；用到原生 fetch 與 ??=）
node -v

# 1b. 安裝依賴（取得層只用原生 fetch，但轉換層要 DuckDB）
npm ci        # 沒有 package-lock.json 時用 npm install

# 2. 主計總處的憑證鏈缺中繼憑證，retail.mjs 需要這個環境變數
#    憑證已在 repo 內：ingest/certs/twca-secure-ssl-2023g3.pem
#    到期日 2030-10-16，到期前要重新從 AIA 下載：
#    curl -sS http://sslserver.twca.com.tw/cacert/secure_sha2_2023G3.crt | openssl x509 -inform DER -out ingest/certs/twca-secure-ssl-2023g3.pem

# 3. 日誌目錄
# $HOKHONG 換成本機的專案絕對路徑，例如 /srv/hokhong.tw
mkdir -p $HOKHONG/ingest/log

# 4. 第一次上主機要先做一次全史回補（約 4–5 小時、373 MB、5,368 個請求）
cd $HOKHONG && node ingest/sources/farm-trans.mjs
```

**磁碟**：`farm-trans` 全史 373 MB，之後每天約 90 KB（一年約 33 MB）。`tap-trans`、`taichung-retail` 每天各約 43 KB、95 KB（一年合計約 50 MB）。

**防重疊**：所有來源都由 `ingest/run.mjs` 這一個入口依序執行，所以只需要一把鎖。正常一輪 85 秒、每小時叫一次，不會重疊；但首次全史回補會跑 4–5 小時，那段期間的每小時排程就會撞上。

- Linux：`flock -n /tmp/hokhong-run.lock -c 'cd <專案> && node ingest/run.mjs'`
- macOS **沒有 flock**（本機實測），改用 `/usr/bin/shlock -f /tmp/hokhong-run.pid -p $$ && cd <專案> && node ingest/run.mjs`

撞上也不會壞資料（`farm-trans` 同一天重抓是覆寫、其他來源是整份覆蓋），只是白做一次；但日誌會難看，所以還是加鎖。

---

### crontab：只需要一行

頻次不寫在 crontab 裡，寫在 `ingest/run.mjs` 的來源表。cron 每小時叫一次它，它自己判斷哪幾支到期：

```cron
# hokhong.tw 資料取得。run.mjs 依各來源頻次自行判斷到期，漏跑會在下一個小時自動補。
SHELL=/bin/sh
PATH=/usr/local/bin:/usr/bin:/bin

0 * * * * cd $HOKHONG && node ingest/run.mjs >> ingest/log/run.log 2>&1

# 轉換層 + 站台重建：每天 03:30（daily 來源 02:00 抓完之後）。
# transform/run.mjs 的最後一步就是 astro build，所以這一行跑完，dist/ 就是最新的站台。
30 3 * * * cd $HOKHONG && node transform/run.mjs >> ingest/log/transform.log 2>&1
```

轉換層的九個步驟（`node transform/run.mjs --list` 可列出）：

```
to-parquet      raw → L1 Parquet
observe         偵測事後修正
identify        作物代碼 → 官方統一代碼
check-coverage  完整性對帳
origin-price    產地價 → Parquet（價格鏈用）
aggregate       旬／月／日聚合
typhoon         颱風影響與回穩天數
emit-page       產出 per-page JSON
build           astro build → dist/
```

轉換層故意**不**串在取得層後面（`&&`）：取得層每小時跑一次，但轉換沒必要每小時做；而且分開兩行，某一層失敗時從日誌一眼看得出是哪一層。轉換的順序相依由 `transform/run.mjs` 自己保證（任一步失敗就停，並提示用 `--from <步驟>` 續跑）。

**為什麼不用 9 行 cron 硬編時間**：主機沒開機、網路斷線、或那次執行失敗的話，硬編時間的 cron 會把那一次永久漏掉——對 `tap-trans`（2 天視窗）就是直接斷檔。`run.mjs` 把「下次到期時間」存進 `ingest/state.json`，到期未跑就一直是到期狀態，下一個小時會補跑；**失敗也不推遲到期時間**，所以會持續重試到成功。

各來源的頻次與執行時刻（台北時間）定義在 `ingest/run.mjs` 的 `jobs` 表，實測到期計算：

```
daily            每天 02:00     （01:00 執行 → 當日 02:00；03:00 執行 → 隔日 02:00）
weekly           每週一 03:00
monthly (1 日)   每月 1 日 04:00
monthly (6 日)   每月 6 日 04:00   主計總處月初發布
```

排在凌晨 2–4 點的理由：前一天的行情到當天深夜還在陸續上傳，越晚抓越完整；而且離峰時段對政府主機比較友善。

**首次執行會一次跑完全部 11 支**（state.json 還不存在 → 全部視為到期），實測 85 秒。其中 `origin-price` 是整份重抓，約 61 秒。

其他指令：

```sh
node ingest/run.mjs --list          # 列出每支的頻次、上次成功、下次到期，不執行
node ingest/run.mjs --dry           # 印出這次會跑哪些，不執行
node ingest/run.mjs --force <id>    # 不管到期與否，強制跑某一支
```

---

## 怎麼確認排程真的有在跑

**跑在 Actions 時**，看三個地方：

```sh
gh run list --workflow=daily.yml --limit 5        # 最近幾次執行與結果
gh release view data-current --json assets \
  --jq '.assets[] | "\(.name) \(.updatedAt)"'     # 當期資料的更新時間應該是今天
cat .github/last-update                            # workflow 每次成功都會更新這個時間戳
```

站台本身也看得出來：首頁副標寫著「更新至民國 ⋯」，那是最後一個交易日。

**跑在自架主機時**，用下面這些：

```sh
# 最快的檢查：每支的上次成功與下次到期（有 lastError 會一起顯示）
node ingest/run.mjs --list

# 轉換層：各層 meta 的時間戳應該是今天，且對帳要通過
cat data/coverage.meta.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('對帳', d['reconciled'], '| 孤兒列', d['orphanRows'], '|', d['checkedAt'])"
for f in data/parquet/farm_trans.meta.json data/observation/observe.meta.json data/identity/identity.meta.json data/agg/agg.meta.json; do
  python3 -c "import json;d=json.load(open('$f'));print('$f', d.get('builtAt') or d.get('ranAt'))"
done

# 今天有沒有抓到（滾動視窗來源，最該盯的兩支）
ls -la ingest/raw/tap-trans/ | tail -3
ls -la ingest/raw/taichung-retail/ | tail -3

# farm-trans 最近的取得記錄（每次取得一行）
tail -10 ingest/raw/farm-trans/manifest.jsonl

# 失敗
grep -h FAIL ingest/log/*.log | tail -20

# 全史統計（要跑約 45 秒，不用每天跑）
node --max-old-space-size=8192 ingest/probe/farm-trans-stats.mjs > ingest/probe/farm-trans-stats.json
```

**該警報的條件**（目前還沒做監控，要自己看或之後補一支檢查腳本）：

1. `ingest/raw/tap-trans/` 或 `ingest/raw/taichung-retail/` 今天沒有新檔 → 最嚴重，會掉資料。
2. `manifest.jsonl` 最後一行的 `date` 不是今天。
3. 某市場連續 3 個交易日沒有資料，且官方休市日曆上沒有休市（判別方式見 `ingest/probe/sources.md` §7 第 4 項；溪湖鎮蔬菜的日曆不準，要排除）。
4. 重抓近 7 天時筆數或內容有變 → 不是錯誤，是事後修正，要進 `observation_history`。

---

## 已知的坑（資料來源本身）

- **不要用 `/api/v1/*`**：非會員只回第一頁 1000 筆。大量取用一律走 `Service/OpenData/FromM/*`。
- **`$top` 上限 10000**，超過回 `[{"errMsg":…}]` 而不是截斷；`farm-trans.mjs` 已經處理分頁。
- **`data.coa.gov.tw` 已經 DNS 解析不到**，但官方資料集頁面的範例 URL 還是舊網域。
- **休市要看官方日曆，不要信 `rest` 記錄**（只存在 2015–2020、2025–2026，且 2025 年起有種類標錯）。
- **歷史作物名稱會被改寫成現行名稱**，代碼的生效期間只能靠 `amis-product-changed`。
