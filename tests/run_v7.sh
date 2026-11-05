#!/bin/bash
# ===================================================================
# teebo — VAGUE 7 : tests du module Objectifs
# Lance l'API sur une base fraiche, joue 45 verifications, puis s'arrete.
#
# Usage :  bash tests/run_v7.sh
# ===================================================================
set -u
cd "$(dirname "$0")/.."
: "${DATABASE_URL:=postgres://teebo:teebo@127.0.0.1:5432/teebo}"
: "${PORT:=3000}"
: "${HOST:=127.0.0.1}"
: "${TEEBO_ADMIN_EMAIL:=hello@teebo.africa}"
: "${TEEBO_ADMIN_PASSWORD:=Teebo#Admin2026}"
export DATABASE_URL PORT HOST TEEBO_ADMIN_EMAIL TEEBO_ADMIN_PASSWORD
export NODE_ENV=test CORS_ORIGIN=true

echo '[..] Preparation de la base...'
npm --prefix backend run migrate >/dev/null 2>&1 || { echo '[X] Migrate KO'; exit 1; }

cd backend
node src/server.js > ../tests/api-v7.log 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -sf "http://$HOST:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
node ../tests/v7.mjs
RC=$?
kill $API_PID 2>/dev/null
exit $RC
