#!/usr/bin/env bash
# ===========================================================================
# teebo - Demarrage LOCAL (une seule commande) : API + site
# Paquet « SITE NETLIFY » : le site est a la RACINE, le serveur dans backend/.
#   1. Une base PostgreSQL doit etre joignable (DATABASE_URL).
#   2. bash DEMARRER_LOCAL.sh
#   3. Ouvrir http://127.0.0.1:3000
# ===========================================================================
set -e
cd "$(dirname "$0")"

if [ -z "$DATABASE_URL" ]; then
  echo '[!] DATABASE_URL absente.'
  echo '    Exemple : export DATABASE_URL=postgres://teebo@127.0.0.1:5432/teebo'
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo '[X] Node.js 20+ requis.'; exit 1; }
echo "[OK] Node.js $(node -v)"

cd backend
if [ ! -d node_modules ]; then
  echo '[..] Installation des dependances (npm install)...'
  npm install --omit=dev || { echo '[X] npm install a echoue'; exit 1; }
fi

echo '[..] Migration de la base (schemas 01 .. 28)...'
npm run migrate || { echo '[X] Migration echouee - verifiez DATABASE_URL'; exit 1; }

echo '[..] Demarrage du serveur : http://127.0.0.1:3000'
exec node src/server.js
