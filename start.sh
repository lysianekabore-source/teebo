#!/bin/sh
# teebo — demarrage du serveur API (Render, offre gratuite)
# ---------------------------------------------------------------
# VAGUE 51 : ce fichier est desormais COPIÉ dans l'image par le Dockerfile
# (la vague 50 le lançait sans le copier : « cannot open ./start.sh »).
# Il n'est plus le point d'entree officiel (le Dockerfile lance node
# directement) mais il reste utilisable en local : sh start.sh
# ---------------------------------------------------------------
set -e
cd "$(dirname "$0")"

if [ ! -f src/server.js ]; then
  echo "ERREUR : src/server.js absent dans $(pwd) — image incomplete." >&2
  exit 1
fi

echo "==> Demarrage du serveur API (la base sera mise a jour en arriere-plan) ..."
exec node src/server.js
