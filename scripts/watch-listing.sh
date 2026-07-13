#!/bin/bash
# Poll the public OKX.AI listing page; when it goes live (HTTP 200), wire
# OKX_LISTING_URL into the env and restart — Buy/market "Hire on OKX.AI"
# links light up automatically. Self-disarms after firing once.
# Lives in the repo so rsync --delete deploys can never remove it (learned 07-13).
URL="https://www.okx.ai/agents/5089"
ENV=/var/www/license402/.env.local
DONE=/var/www/license402/data/.listing-live
LOG=/var/www/license402/data/listing-watch.log
[ -f "$DONE" ] && exit 0
code=$(curl -sL --max-time 20 -o /dev/null -w "%{http_code}" "$URL")
if [ "$code" = "200" ]; then
  grep -q "^OKX_LISTING_URL=" "$ENV" || echo "OKX_LISTING_URL=$URL" >> "$ENV"
  systemctl restart license402
  touch "$DONE"
  echo "$(date -u "+%F %T") listing LIVE (200) — OKX_LISTING_URL set, service restarted" >> "$LOG"
else
  echo "$(date -u "+%F %T") still $code" >> "$LOG"
fi
