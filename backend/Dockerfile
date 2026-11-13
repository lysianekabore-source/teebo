# teebo — image de l'API (production, Render)
#
# CORRECTIF 13/11/2026-B — « Application exited early » après un démarrage réussi
# ---------------------------------------------------------------------------
# Diagnostic : le code précédent lançait la migration en ARRIÈRE-PLAN avec
# « (node src/migrate.js || true) & exec node src/server.js ». Le serveur
# démarrait (log « teebo API en écoute sur 0.0.0.0:3000 ») puis tombait en
# faute de processus principal : l'image se terminait. Render affichait donc
# « Application exited early », et la migration — tuée avec le conteneur —
# ne finissait jamais (d'où « Dossier db/ illisible » et « Schéma absent »).
#
# Nouvelle logique : UN SEUL processus, au premier plan, qui ne sort jamais.
#   1. la migration tourne au premier plan (sans risque de blocage : le script
#      s'arrête seul au plus tard après 120 s) ;
#   2. le serveur prend ensuite la main (exec, PID 1).
#
# Le contexte de build est LE DOSSIER backend/ : aucun fichier du site n'est
# recopié (c'est Netlify qui sert les pages).
# CORRECTIF 13/11/2026-C — « ENOENT stat '/frontend/index.html' » et
# « ReferenceError: req is not defined » : le serveur cherchait un dossier
# /frontend inexistant et sa gestion d'erreurs plantait. Corrigé dans
# src/server.js (détection du dossier + redirection vers le site Netlify).
#
# On force node:20-bookworm-slim (Debian) : l'image alpine est très lente à
# démarrer sous Render et a provoqué des sorties prématurées.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- Dépendances ---
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Code applicatif ---
COPY src ./src

# --- Migrations SQL (fournies à la racine du contexte de build) ---
COPY db* ./db/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_DIR=/app
ENV TEEBO_DB_DIR=/app/db
ENV MIGRATION_MAX_MS=120000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Le serveur démarre en PREMIER (port ouvert tout de suite), puis la migration
# tourne en tâche de fond : une base endormie ne retarde plus la mise en ligne
# et ne peut plus provoquer « Application exited early ».
CMD ["sh", "./start.sh"]
