#!/bin/bash
# Cloud Shell helper: pull the latest functions from GitHub and deploy them.
set -e
cd ~/nb
R=https://raw.githubusercontent.com/kevinteixeiras7/New-Business/main
curl -sfL -o functions/index.js "$R/functions/index.js?x=$RANDOM"
curl -sfL -o functions/package.json "$R/functions/package.json?x=$RANDOM"
gcloud services enable sheets.googleapis.com --project seventy7-newbiz --quiet
(cd functions && npm install --silent --no-audit --no-fund >/dev/null 2>&1)
npx -y firebase-tools@13 deploy --only functions --project seventy7-newbiz --non-interactive --force 2>&1 | grep -E "Successful|Deploy complete|Error" || true
gcloud scheduler jobs run firebase-schedule-dailyRadar-europe-west2 --location europe-west2 --project seventy7-newbiz && echo RADAR_RUN_OK
echo ALL_DONE
