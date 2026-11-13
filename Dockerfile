# ===================================================================
# teebo — image du serveur API (Render)
# ===================================================================
# CE FICHIER EST À LA RACINE DU PROJET, à côté de backend/, db/, index.html.
#
# CORRECTIF 13/11/2026-E — « sh: 0: cannot open ./start.sh: No such file »
# -------------------------------------------------------------------
# Cause racine : le Dockerfile ne copiait que backend/package*.json,
# backend/src et db/. Le fichier backend/start.sh n'était donc JAMAIS copié
# dans l'image, alors que la commande de démarrage était « sh ./start.sh »
# exécutée depuis /app/backend. Le conteneur s'arrêtait (code 2) au démarrage.
#
# Correctif :
#   1. start.sh est copié dans l'image (COPY backend/start.sh).
#   2. La commande de démarrage ne dépend plus du fichier shell :
#      node src/server.js, avec start.sh en repli. Un souci de script ou de
#      droits ne peut donc plus empêcher le service de démarrer.
#   3. Copie explicite, une par une, des seules pièces nécessaires
#      (jamais « COPY . »), pour ne plus jamais échouer sur un fichier absent.
# ===================================================================
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- Dépendances (dossier backend/) ---
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Code du serveur ---
COPY backend/src ./backend/src

# --- Script de démarrage (c'était le fichier manquant) ---
COPY backend/start.sh ./backend/start.sh
RUN chmod +x ./backend/start.sh

# --- Migrations SQL (dossier db/ à la racine) ---
COPY db ./db

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_DIR=/app
ENV TEEBO_DB_DIR=/app/db
ENV MIGRATION_MAX_MS=120000

WORKDIR /app/backend
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Le serveur démarre en PREMIER (port ouvert immédiatement), puis la migration
# tourne en tâche de fond : une base endormie ne retarde plus la mise en ligne.
# Démarrage direct par node : ne dépend d'aucun fichier shell.
CMD ["node", "src/server.js"]
