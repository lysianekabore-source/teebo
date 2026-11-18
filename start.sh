#!/bin/sh
# teebo — démarrage du serveur API (Render, offre gratuite)
# ---------------------------------------------------------------
# CORRECTIF 13/11/2026-E — « cannot open ./start.sh : No such file »
#   Le fichier n'était pas copié dans l'image (le Dockerfile l'a oublié).
#   Il l'est désormais (COPY backend/start.sh), et le démarrage ne dépend
#   plus de ce script : la commande du Dockerfile lance directement node.
#
# Ordre volontaire :
#   1. le serveur démarre IMMÉDIATEMENT (le port s'ouvre, Render le voit en vie) ;
#   2. la migration tourne ensuite EN TÂCHE DE FOND, sans jamais bloquer ;
#   3. si la base dort, elle est réessayée automatiquement (voir src/server.js).
#
# Ne JAMAIS revenir à « node src/migrate.js ; node src/server.js » :
# une base endormie retardait alors tout le démarrage, et Render affichait
# « Application exited early » / « service injoignable ».
# ---------------------------------------------------------------
set -e
cd "$(dirname "$0")"

# Si src/server.js manque, on le signale en clair : plus de « No such file »
# muet impossible à diagnostiquer depuis les journaux Render.
if [ ! -f src/server.js ]; then
  echo "ERREUR : src/server.js absent dans $(pwd) — image incomplète." >&2
  exit 1
fi

echo "==> Démarrage du serveur API (la base sera mise à jour en arrière-plan) ..."
exec node src/server.js
