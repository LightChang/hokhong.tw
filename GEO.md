# GEO：被生成引擎引用時，前提不被講錯

2026-09-16 執行。姊妹文件：[SEO.md](SEO.md)（被收錄、排得到）、[AEO.md](AEO.md)（成為直接答案）。

> **這份文件不寫現況數字。**
> 覆蓋頁數、爬蟲取得狀態都會變。要看現況跑指令，輸出即事實。
> 文件裡的數字只有標了日期的歷史快照，以及**資料本身的口徑常數**（例如「基準是近三年同一旬」
> 這種規則）。涵蓋範圍的數字——市場數、有零售實測的品項數——**一律不寫在這裡**，
> 因為它們會隨資料變動；權威來源是 `public/llms.txt` 與 `/about/`，取現值的指令見下方
> 「口徑改變時要一起改的地方」。

## 這一軸在防什麼

生成引擎不會只抄數字，它會抄一個句子。這個站的資料有幾個前提，漏掉任何一個，
抄出去的句子就是錯的：

- 「全國」不是全台灣——只有農糧署輔導的行情報導站每日上傳
- 批發價單位是**元/公斤**，零售價是**元/台斤**，而且兩者的倍數逐品項差很多
  （實際範圍寫在 `/about/`，不在這裡複製一份會過期的數字）
- 零售價只有臺中市公有零售市場，不是全台平均，而且只涵蓋部分品項
- 比較基準是「近三年同一旬」，不是昨天、不是去年同期
- 毛豬是批發成交價，家禽與蛋是**產地價**——產地價既不是零售也不是批發
- 颱風那段是往例統計，不是預測

所以這一軸做的不是「讓更多引擎抓到」（它們本來就抓得到），
而是**讓它們抓到的同時也拿到前提**。

## 怎麼查現況

```bash
# AI 爬蟲拿不拿得到內容（實際發請求，不是看設定）
while IFS='|' read -r NAME UA; do
  printf '%-16s ' "$NAME"
  curl -s -A "$UA" -o /dev/null -w 'llms %{http_code}  ' https://hokhong.tw/llms.txt
  curl -s -A "$UA" -o /dev/null -w 'crop %{http_code}  ' https://hokhong.tw/crop/n04-00201002001/
  curl -s -A "$UA" -o /dev/null -w 'home %{http_code}\n' https://hokhong.tw/
done <<'EOF'
ClaudeBot|Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)
GPTBot|Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot
PerplexityBot|Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)
Google-Extended|Mozilla/5.0 (compatible; Google-Extended/1.0)
EOF

# robots.txt 線上實況
curl -s https://hokhong.tw/robots.txt

# llms.txt 線上實況
curl -s https://hokhong.tw/llms.txt | head -30

# Dataset 標記的覆蓋與內容
node scripts/seo-audit.mjs schema
python3 -c "
import re,json; h=open('dist/crop/n04-00201002001/index.html').read()
for m in re.findall(r'<script type=\"application/ld\+json\">(.*?)</script>',h,re.S):
    o=json.loads(m)
    if o['@type']=='Dataset': print(json.dumps(o,ensure_ascii=False,indent=1))"
```

不跑 JS 的爬蟲實際看到什麼（生成引擎多半不執行 JavaScript）：

```bash
curl -s https://hokhong.tw/crop/n04-00201002001/ | python3 -c "
import sys,re
h=sys.stdin.read(); b=h[h.find('<body'):]
b=re.sub(r'<script[\s\S]*?</script>','',b)
t=re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',b)).strip()
print('純文字字元數:',len(t)); print(t[:400])"
```

## 監看：看哪個數字

生成引擎沒有 Search Console。沒有 API 能告訴你「ChatGPT 昨天引用了你幾次」，
所以這一軸的監看是**條件監看**，不是成效監看——確認「被正確引用的條件」還成立：

| 看什麼 | 怎麼取 | 判讀 |
|---|---|---|
| **爬蟲還拿得到嗎** | 上面的 UA 迴圈 | 全部 200。變成 403 通常是 CDN 或主機層擋的，跟 `robots.txt` 無關 |
| **`llms.txt` 還在線上嗎** | `curl -s https://hokhong.tw/llms.txt \| head -5` | 部署流程換過之後最容易掉的就是 `public/` 底下的靜態檔 |
| **前提有沒有跟資料脫節** | 比對 `public/llms.txt`、`/about/`、`GEO.md` 三處的口徑數字 | 這是**唯一需要人工判斷**的一項，見下方「口徑改變時要一起改的地方」 |
| **`Dataset` 標記有沒有壞** | `node scripts/seo-audit.mjs schema` 的解析失敗數 | 必須是 0 |
| **Google 有沒有認出 Dataset** | `node scripts/seo-status.mjs rich` | 檢索日早於最近部署就是還沒看到，不是錯誤 |
| **有沒有被引用**（只能人工） | 拿站上的獨有事實去問 ChatGPT／Claude／Perplexity，例如「台灣高麗菜批發價跟近三年同期比如何」 | 看它有沒有帶對前提（元/公斤、報導站不是全台、基準是近三年同旬）。引錯了就是 `llms.txt` 那一段寫得不夠前面或不夠白 |

## 做了什麼

| # | 任務 | 動到 |
|---|---|---|
| G1 | **`llms.txt`**。把最容易被講錯的前提寫在**最前面**，在頁面清單之前。生成引擎讀這份檔最省事 | 新增 `public/llms.txt` |
| G2 | **`Dataset` JSON-LD**。這個站的本體就是政府開放資料的加值整理，`Dataset` 是最貼的型別；它的欄位（`license`、`creator`、`temporalCoverage`、`variableMeasured.unitText`、`isBasedOn`）正好就是那些前提的機器可讀版本。肉蛋的 `creator` 換成農業部／中央畜產會，`isBasedOn` 跟著換 | `Base.astro` + 品項／品項×市場／市場／肉蛋／榜單頁 |
| G3 | **數字旁固定帶日期與單位**。答案句把品名、數字、單位、比較基準、日期放在同一句——引用時最常掉的就是「什麼時候的、什麼單位」 | 五種頁型（詳見 [AEO.md](AEO.md) A1） |
| G4 | **`robots.txt` 明列 AI 爬蟲**。`User-agent: *` 本來就已經允許，明列 GPTBot／ClaudeBot／PerplexityBot／Google-Extended／CCBot 等是把「開放」變成一個明確的決定而不是預設值。要改成不開放時改這些區塊，不要動 `*` | `public/robots.txt` |
| G5 | **首頁頁尾補來源機關與授權**。首頁是生成引擎最常抓的一頁，原本只有數字、說不出是誰發布的 | `index.astro` |

順帶修掉一個既有錯誤：肉蛋頁的 description 一律寫「比近三年」，但雞蛋因來源在民國 114 年 9 月
換算法只比得到一年。改成用 `refYears`，`llms.txt` 也寫明這件事。

## 口徑改變時要一起改的地方

這是這一軸最容易爛掉的部分。**資料的涵蓋範圍變了而文件沒跟著改，比沒有文件更糟**——
引擎會很有信心地引用一個過期的前提。口徑數字出現在四個地方，改一個就要改全部：

1. `public/llms.txt` 的「引用這個站之前，請先讀這幾條」
2. `src/pages/about.astro` 的「涵蓋範圍」與「肉蛋」兩個面板
3. `README.md` 的資料來源盤點
4. 本文件開頭的「這一軸在防什麼」

會觸發的情況：行情報導站增減、多一個縣市的零售價來源、產地價品項對應變動、
基準從「近三年同一旬」改掉、肉蛋來源再換算法。

查目前的實際值（不要從文件抄）：

```bash
# 市場數（依類別）與品項數
python3 -c "
import json,glob,collections
t=collections.Counter(json.load(open(f))['tc_type'] for f in glob.glob('data/page/market/*.json'))
print('市場×類別頁:',dict(t),'合計',sum(t.values()))
idx=json.load(open('data/page/index.json'))
print('counts:',idx['counts'],'lastDate:',idx['lastDate'])"

# 有臺中零售實測的品項數
python3 -c "
import json,glob
n=sum(1 for f in glob.glob('data/page/crop/*.json') if json.load(open(f)).get('retail'))
print('有零售實測的品項:',n)"
```

## 改動前的狀態（2026-09-16 快照，僅供對照）

- `llms.txt`：不存在
- `Dataset` JSON-LD：0 頁
- `robots.txt`：只有 `User-agent: *`，沒有明列任何 AI 爬蟲
- 全站沒有任何一處以機器可讀的形式說明涵蓋範圍與單位

爬蟲取得能力改動前就沒問題（2026-09-16 實測 ClaudeBot 取品項頁 200），
內容也一直是伺服器端渲染、不跑 JS 就讀得到數字——這兩點不是這次補的，是本來就對。

## 還沒做的

**外部訊號**。生成引擎的訓練與檢索都偏好被其他地方引用過的來源，而新站沒有任何外部連結。
切入點是本站獨有的：官方平台只留兩年資料。**這件事要對外發送，需要你決定，我不代發。**
