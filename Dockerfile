# ===================================================================
# teebo — image du serveur API (Render)
# ===================================================================
# CE FICHIER EST À LA RACINE DU PROJET, à côté de backend/, db/, index.html.
#
# Pourquoi ce fichier existe : c'est ici qu'a échoué votre dernier
# déploiement. La construction s'arrêtait sur :
#     #12 [7/7] COPY db* ./db/  DONE 0.0s
#     ==> failed to calculate checksum ...  (donnée /docs absente)
# L'image était construite à partir du seul dossier "backend/", sans le
# dossier db/ : la migration ne trouvait alors aucun script SQL, et les
# dossiers attendus (assets, docs) n'existaient pas.
#
# Cette version ne dépend plus d'aucun réglage : elle se place à la racine du
# projet et copie explicitement, une par une, les seules pièces nécessaires
# (backend/src, backend/package*.json, db/). Elle n'utilise jamais « COPY . »
# et ne réclame pas de dossier optionnel : elle ne peut donc plus échouer sur
# un fichier manquant.
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
CMD ["sh", "./start.sh"]
