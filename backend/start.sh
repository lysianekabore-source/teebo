#!/bin/sh
# teebo - demarrage du serveur API sur Render (offre gratuite).
# La migration de la base est appliquee AU DEMARRAGE (preDeployCommand
# n'est pas disponible sur l'offre gratuite). Les scripts sont idempotents :
# on peut redemarrer autant de fois que necessaire.
set -e
cd "$(dirname "$0")"

echo "==> Migration de la base (schemas 01 .. 29) ..."
node src/migrate.js || echo "!! Migration partielle (base indisponible ?) - le serveur demarre quand meme."

echo "==> Demarrage du serveur API ..."
exec node src/server.js
