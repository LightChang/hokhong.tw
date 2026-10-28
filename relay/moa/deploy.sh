#!/usr/bin/env bash
# 部署（或更新）農業部資料的台灣轉發。在 Google Cloud Shell（https://shell.cloud.google.com）貼上執行：
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/LightChang/hokhong.tw/main/relay/moa/deploy.sh)
#
# 做的事：開 Cloud Run API → 用 node 官方映像部署 moa-relay 到 asia-east1（台灣）→ 實際打一次農業部的行情 API
# → 印出要填進 GitHub secret MOA_RELAY 的值。重跑會沿用原本的金鑰（GitHub 那邊不用改）。
# 費用：max-instances 1、沒有請求時縮到 0；每天幾十個請求，在 Cloud Run 免費額度內。專案要已綁定帳單帳戶。
set -euo pipefail
PROJECT=${PROJECT:-hokhong-tw}
REGION=asia-east1
SERVICE=moa-relay
SRC=https://raw.githubusercontent.com/LightChang/hokhong.tw/main/relay/moa/index.cjs

gcloud config set project "$PROJECT" >/dev/null
echo "▸ 開啟 Cloud Run API（已開會直接略過）"
gcloud services enable run.googleapis.com

KEY=$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json 2>/dev/null \
  | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="RELAY_KEY") | .value' || true)
[ -n "$KEY" ] || KEY=$(openssl rand -hex 24)

work=$(mktemp -d)
curl -fsSL "$SRC" -o "$work/index.cjs"
{ echo "RELAY_KEY: \"$KEY\""; echo "RELAY_SRC: |"; sed 's/^/  /' "$work/index.cjs"; } > "$work/env.yaml"

echo "▸ 部署 $SERVICE 到 $REGION"
gcloud run deploy "$SERVICE" --region "$REGION" \
  --image docker.io/library/node:22-alpine \
  --command node --args='-e,eval(process.env.RELAY_SRC)' \
  --env-vars-file "$work/env.yaml" \
  --allow-unauthenticated --timeout 300 --max-instances 1 --concurrency 4 --memory 512Mi --cpu 1 --quiet

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
RELAY="$URL/$KEY"

echo "▸ 測試：經由台灣轉發抓農業部行情"
code=$(curl -s -o "$work/t.json" -w '%{http_code}' --max-time 240 "$RELAY/data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx?\$top=2&\$skip=0")
echo "  HTTP $code"; head -c 300 "$work/t.json"; echo

echo
if [ "$code" = 200 ]; then
  echo "✅ 轉發可用。到 https://github.com/LightChang/hokhong.tw/settings/secrets/actions/new 新增："
else
  echo "⚠️ 農業部從 GCP 台灣機房也連不上（HTTP $code）——把上面的訊息貼回給 Claude。若仍要先設定，GitHub secret："
fi
echo "    Name:   MOA_RELAY"
echo "    Secret: $RELAY"
