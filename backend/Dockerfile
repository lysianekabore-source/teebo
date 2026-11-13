# teebo — image de l'API (production, Render)
#
# CORRECTIF 14/11/2026 — « failed to calculate checksum … "/docs": not found »
# ---------------------------------------------------------------------------
# Le contexte de build est désormais LE DOSSIER backend/ (celui du Dockerfile).
# Les fichiers de l'interface web ne sont PLUS recopiés un par un : le serveur
# n'en a pas besoin (Netlify sert le site) et une seule ligne manquante faisait
# échouer tout le déploiement.
#
# Le dossier db/ (migrations) est embarqué s'il est présent ; sinon le serveur
# démarre quand même (voir start.sh) et l'API reste accessible.
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

# --- Dépendances (le lockfile est exclu : npm résout depuis package.json) ---
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Code applicatif -------------------------------------------------------
COPY src ./src

# --- Migrations SQL -------------------------------------------------------
# Le dossier db/ est fourni à la racine du contexte de build : à la racine du
# dépôt en production, ou dans le dossier parent pour les archives livrées.
COPY db* ./db/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_DIR=/app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Le serveur ouvre le port immédiatement ; la migration tourne en arrière-plan
# et ne peut jamais empêcher la mise en ligne.
CMD ["sh", "-c", "(node src/migrate.js || true) & exec node src/server.js"]
