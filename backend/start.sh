#!/bin/sh
# teebo — démarrage du serveur API (Render, offre gratuite)
# ---------------------------------------------------------------
# CORRECTIF 13/11/2026-D — l'ordre a été inversé :
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

echo "==> Démarrage du serveur API (la base sera mise à jour en arrière-plan) ..."
exec node src/server.js
