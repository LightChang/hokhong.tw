#!/usr/bin/env bash
# 把本機已經建好的資料上傳到 GitHub release，讓 Actions 每天接著用。
#
#   ./scripts/publish-data.sh history   # 一次性：2012–2025 的 raw 與 parquet（約 570 MB，永不改變）
#   ./scripts/publish-data.sh current   # 當期：今年資料 + observation + 抓取狀態（約 150 MB）
#   ./scripts/publish-data.sh both
#
# 為什麼分兩包：歷史那部分永遠不會變，Actions 用固定 key 快取，只在快取失效時才下載一次；
# 當期那包每天由 workflow 覆蓋回寫。
set -euo pipefail
cd "$(dirname "$0")/.."

HISTORY_TAG=data-history
CURRENT_TAG=data-current
# 必須與 .github/workflows/daily.yml 的 HISTORY_UNTIL 一致：
# history 收 這一年以前（含），current 收 之後的所有年份。
HISTORY_UNTIL=${HISTORY_UNTIL:-2025}
MODE=${1:-both}

command -v gh >/dev/null || { echo "需要 gh CLI：brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "請先 gh auth login"; exit 1; }

ensure_release() {   # $1=tag  $2=標題
  gh release view "$1" >/dev/null 2>&1 || \
    gh release create "$1" --title "$2" --notes "由 scripts/publish-data.sh 上傳，供 GitHub Actions 每日更新使用。" --latest=false
}

pack_history() {
  echo "== 打包歷史資料（2012–$HISTORY_UNTIL）"
  ensure_release "$HISTORY_TAG" "資料：歷史（永不變動）"
  # release 單檔上限 2 GiB。raw 與 parquet 分開兩個檔，各自遠低於上限，也方便單獨重傳。
  local years_raw=() years_pq=()
  for y in $(seq 2012 "$HISTORY_UNTIL"); do
    [ -d "ingest/raw/farm-trans/$y" ] && years_raw+=("ingest/raw/farm-trans/$y")
    [ -d "data/parquet/farm_trans/year=$y" ] && years_pq+=("data/parquet/farm_trans/year=$y")
  done
  [ ${#years_pq[@]} -gt 0 ] || { echo "找不到任何 <= $HISTORY_UNTIL 的 parquet 年份分區"; exit 1; }
  tar -czf history-raw.tar.gz "${years_raw[@]}"
  tar -czf history-parquet.tar.gz "${years_pq[@]}"
  ls -lh history-raw.tar.gz history-parquet.tar.gz | awk '{print "  ", $9, $5}'
  gh release upload "$HISTORY_TAG" history-raw.tar.gz history-parquet.tar.gz --clobber
  rm -f history-raw.tar.gz history-parquet.tar.gz
}

pack_current() {
  echo "== 打包當期資料（$((HISTORY_UNTIL+1)) 年起的所有年份）"
  ensure_release "$CURRENT_TAG" "資料：當期（每日由 Actions 覆蓋）"
  # 收 HISTORY_UNTIL 之後的**所有**年份，不是只有今年：跨年時去年才不會兩邊都沒有。
  local paths=(data/observation ingest/raw/tap-trans ingest/raw/taichung-retail ingest/state.json)
  local d y
  for d in data/parquet/farm_trans/year=*; do
    y=${d##*year=}
    [ "$y" -gt "$HISTORY_UNTIL" ] && paths+=("$d")
  done
  for d in ingest/raw/farm-trans/*/; do
    y=$(basename "$d")
    case "$y" in [0-9][0-9][0-9][0-9]) [ "$y" -gt "$HISTORY_UNTIL" ] && paths+=("$d");; esac
  done
  for d in ingest/raw/*.gz; do [ -e "$d" ] && paths+=("$d"); done
  echo "   內容：${paths[*]}"
  tar -czf current.tar.gz "${paths[@]}"
  ls -lh current.tar.gz | awk '{print "  ", $9, $5}'
  gh release upload "$CURRENT_TAG" current.tar.gz --clobber
  rm -f current.tar.gz
}

case "$MODE" in
  history) pack_history ;;
  current) pack_current ;;
  both)    pack_history; pack_current ;;
  *) echo "用法：$0 [history|current|both]"; exit 2 ;;
esac
echo "完成。"
