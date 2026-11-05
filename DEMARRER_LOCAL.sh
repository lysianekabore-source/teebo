#!/bin/bash
# ===================================================================
# teebo — LANCEMENT LOCAL COMPLET (une seule commande)
#
# Ce script :
#   1. vérifie Node.js
#   2. installe les dépendances si besoin
#   3. prépare la base (migrate)
#   4. démarre l'API en arrière-plan
#   5. remplit la base avec une IMF de démonstration complète
#   6. affiche les accès de test
#
# Usage :  bash DEMARRER_LOCAL.sh
# (Sous Windows : utilisez WSL ou Git Bash.)
# ===================================================================
set -u
cd "$(dirname "$0")"

# --- Configuration (modifiable via variables d'environnement) ---
: "${DATABASE_URL:=postgres://teebo:teebo@127.0.0.1:5432/teebo}"
: "${PORT:=3000}"
: "${HOST:=127.0.0.1}"
: "${TEEBO_ADMIN_EMAIL:=hello@teebo.africa}"
: "${TEEBO_ADMIN_PASSWORD:=Teebo#Admin2026}"
export DATABASE_URL PORT HOST TEEBO_ADMIN_EMAIL TEEBO_ADMIN_PASSWORD
export NODE_ENV=development CORS_ORIGIN=true
export TEEBO_WHATSAPP='+22650321432' TEEBO_EMAIL='hello@teebo.africa'

echo ''
echo '====================================================='
echo '  teebo — démarrage local complet'
echo '====================================================='
echo ''

# 1) Node.js
if ! command -v node >/dev/null 2>&1; then
  echo '[X] Node.js introuvable. Installez Node.js 20+ : https://nodejs.org'
  exit 1
fi
echo "[OK] Node.js $(node -v)"

# 2) dépendances
cd backend
if [ ! -d node_modules ]; then
  echo '[..] Installation des dépendances (npm install)...'
  npm install || { echo '[X] npm install a échoué'; exit 1; }
fi
echo '[OK] Dépendances présentes'

# 3) migration (crée l''admin éditeur teebo si absent)
echo '[..] Préparation de la base (migrate)...'
npm run migrate || { echo '[X] Migration échouée — vérifiez DATABASE_URL'; exit 1; }

# 4) démarrage API
if curl -sf "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  echo '[OK] Une API répond déjà sur ce port.'
else
  echo '[..] Démarrage de l''API...'
  nohup node src/server.js > ../api-local.log 2>&1 &
  for i in $(seq 1 40); do
    curl -sf "http://$HOST:$PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

if curl -sf "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  echo '[OK] API démarrée.'
else
  echo '[X] L''API ne répond pas. Voir api-local.log'; exit 1
fi

# 5) seed de démonstration
echo '[..] Remplissage de la base de démonstration...'
node ../tools/seed-demo.mjs || echo '[!] Seed déjà effectué ou partiellement appliqué.'

echo '====================================================='
echo '  ACCÈS DE TEST'
echo '====================================================='
echo "  API        : http://$HOST:$PORT"
echo '  Pages web  : ouvrez frontend/login.html dans votre navigateur'
echo ''
echo '  Administrateur IMF : admin@demo-teebo.bf / DemoAdmin#2026'
echo '  Directeur général  : dg@demo-teebo.bf    / DemoDg#2026x'
echo '  Superviseur        : sup@demo-teebo.bf   / DemoSup#2026x'
echo '  Collectrices       : c1/c2/c3@demo-teebo.bf / DemoCol#2026x'
echo '  Console éditeur    : hello@teebo.africa  / Teebo#Admin2026'
echo ''
echo "  Journal API : api-local.log   (arrêt : kill \$(cat /tmp/teebo-api.pid 2>/dev/null))"
echo '====================================================='
echo ''
