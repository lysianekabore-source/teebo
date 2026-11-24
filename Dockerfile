# =====================================================================
#  teebo — SERVEUR API (Render, runtime Docker) — paquet d'amorçage v72
#  Ce Dockerfile ne dépend d'AUCUN autre fichier du dépôt : il
#  décompresse le paquet livré (teebo-api-render-v72.zip), installe les
#  dépendances puis démarre le serveur. Il remplace l'ancien Dockerfile
#  du dépôt, resté sur une version de plusieurs semaines.
# =====================================================================
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Le paquet complet — doit être déposé à la RACINE du dépôt,
#    sous exactement ce nom : teebo-api-render-v72.zip
COPY teebo-api-render-v72.zip /tmp/app.zip
RUN unzip -o -q /tmp/app.zip -d /app && rm -f /tmp/app.zip && ls -1 /app

# 2) Dépendances de production (le verrou de version est dans le paquet)
RUN npm ci --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# 3) Démarrage : le serveur applique les migrations puis écoute
CMD ["node", "src/server.js"]

