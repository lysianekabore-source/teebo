#!/bin/sh
# teebo - demarrage du serveur API (Render, offre gratuite).
#
# CORRECTIF 13/11/2026-B : un seul processus, au PREMIER PLAN.
# La migration est executee d'abord (bornee a 120 s : elle ne peut pas bloquer),
# puis le serveur prend la main avec exec (PID 1). Le conteneur ne « sort » donc
# plus juste apres le demarrage du serveur (« Application exited early »).
set -e
cd "$(dirname "$0")"

# Le dossier db/ est cherche a cote de start.sh et a la racine de l'image.
export TEEBO_DB_DIR="${TEEBO_DB_DIR:-$(pwd)/db}"
export MIGRATION_MAX_MS="${MIGRATION_MAX_MS:-120000}"

echo "==> Dossier des migrations : $TEEBO_DB_DIR"
echo "==> Migration de la base (schemas 01 .. 33) ..."
node src/migrate.js || echo "!! Migration partielle (base indisponible ?) - le serveur demarre quand meme."

echo "==> Demarrage du serveur API ..."
exec node src/server.js
