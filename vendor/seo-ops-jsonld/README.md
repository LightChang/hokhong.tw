# vendor/seo-ops-jsonld（副本，不要在這裡改）

四站共用 JSON-LD 規則與驗證器的副本。正本在 `/mnt/yao-care/seo-ops/jsonld/`（seo-ops repo 的 `jsonld/`），
規則的查證紀錄、來源網址與每季複查步驟都在正本的 `README.md`。

放副本的原因：GitHub Actions runner 沒有 `/mnt/yao-care/seo-ops`，而部署前要跑驗證（daily.yml「檢查結構化資料」）。

| 檔案 | 用途 |
|---|---|
| `rules.json` | 官方文件查證結果（每條附 `source`、`verifiedAt`） |
| `validate.mjs` | 驗證器；本站由 `scripts/seo-audit.mjs jsonld` 呼叫 |
| `validate.test.mjs` | 驗證器自身的測試：`node --test vendor/seo-ops-jsonld/*.test.mjs` |

**來源 commit：`057f8b2`**（seo-ops，2026-09-27「四站共用 JSON-LD 規則檔與驗證器」）

## 同步

正本更新後（例如每季複查改了 `rules.json`），在本 repo 根目錄：

```sh
C=$(git -C /mnt/yao-care/seo-ops log -1 --format=%h -- jsonld)
for f in validate.mjs rules.json validate.test.mjs; do
  git -C /mnt/yao-care/seo-ops show "$C:jsonld/$f" > "vendor/seo-ops-jsonld/$f"
done
node --test vendor/seo-ops-jsonld/*.test.mjs && node scripts/seo-audit.mjs jsonld
```

然後把上面的「來源 commit」改成 `$C`，與站台調整一起 commit。只改站台頁型要求就改根目錄的 `jsonld-pages.json`，不動這裡。
