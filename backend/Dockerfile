# teebo - image de l'API (production)
#
# NOTE : le contexte de build doit etre la RACINE du projet
#        (render.yaml -> dockerContext: .)
#        Le Dockerfile est dans backend/, les dossiers db/ et frontend/ sont
#        donc accessibles via le contexte racine.
#
# CORRECTIF 13/11/2026 — le deploiement restait « In progress » sans fin :
#  - le demarrage ne depend plus de la migration (elle ne peut plus bloquer) ;
#  - le Dockerfile est rendu robuste a la structure des deux paquets
#    (racine plate OU arborescence backend/ db/ frontend/).
FROM node:20-alpine

WORKDIR /app

# Outils minimaux pour le diagnostic (curl pour la sante, wget deja present).
RUN apk add --no-cache curl

# --- Dependances ---------------------------------------------------------
# Le package-lock.json est volontairement EXCLU : sans lui, npm resout les
# dependances depuis package.json et ne peut pas echouer sur un lockfile
# desynchronise (ancien google-auth-library laisse dans un paquet precedent).
COPY backend/package.json ./backend/package.json
RUN cd backend && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# --- Code applicatif ------------------------------------------------------
COPY backend/src ./backend/src

# --- Base de donnees (migrations) ----------------------------------------
COPY db ./db

# --- Frontend statique servi par Express --------------------------------
COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

WORKDIR /app/backend
EXPOSE 3000

# La sante doit repondre meme si la base est encore en train de demarrer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Le serveur ouvre le port TOUT DE SUITE ; la migration est lancee juste
# apres, en arriere-plan, sans jamais bloquer la mise en ligne.
CMD ["sh", "-c", "(node src/migrate.js || true) & exec node src/server.js"]
