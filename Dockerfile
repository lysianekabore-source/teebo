# teebo — image de l'API (production, Render)
#
# ---------------------------------------------------------------------------
# VAGUE 51 — CORRECTIF « sh: 0: cannot open ./start.sh: No such file »
# ---------------------------------------------------------------------------
# CAUSE RACINE (deploiement du 18/11/2026, statut « Deploy failed ») :
#   Le CMD lançait « sh ./start.sh » alors que le Dockerfile ne copiait ce
#   fichier dans AUCUNE ligne : seuls src/, public/ et db/ etaient copiés.
#   Le conteneur sortait donc avec le code 2 avant de demarrer.
#   (La meme erreur avait deja ete signalee le 13/11 : le commentaire disait
#   « c'est corrigé », mais la ligne COPY n'avait jamais ete ajoutee.)
#
# DOUBLE CORRECTIF :
#   1. start.sh est explicitement copié dans l'image ;
#   2. le conteneur ne depend plus de lui — il lance node directement.
#   Meme si un fichier manquait encore, le service demarrerait.
#
# Le Dockerfile accepte les DEUX contextes de build possibles :
#   a) contexte = dossier backend/  (Dockerfile a cote de src/, db/, public/)
#   b) contexte = racine du depot    (Dockerfile a cote de backend/)
# Ce double support est volontaire : les echecs precedents venaient justement
# d'un contexte de build qui ne correspondait pas aux chemins ecrits ici.
# ---------------------------------------------------------------------------

# ===========================================================================
# ETAPE 1 — inspection du contexte (detecte ou sont reellement les sources)
# ===========================================================================
FROM node:20-bookworm-slim AS inspect
WORKDIR /ctx
COPY . .
# Ecrit un fichier /plan qui memorise l'emplacement des sources, puis verifie
# que l'essentiel est present. Un message clair remplace l'echec silencieux.
RUN set -e; \
    if [ -f src/server.js ] && [ -f package.json ]; then \
      echo "." > /plan; \
      echo 'OK — sources a la racine du contexte'; \
    elif [ -f backend/src/server.js ] && [ -f backend/package.json ]; then \
      echo "backend" > /plan; \
      echo 'OK — sources dans backend/'; \
    else \
      echo 'ERREUR : ni src/server.js ni backend/src/server.js dans le contexte.' >&2; \
      echo 'Verifiez le Root Directory du service Render (vide, ou = backend).' >&2; \
      exit 1; \
    fi

# ===========================================================================
# ETAPE 2 — image finale
# ===========================================================================
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# L'emplacement des sources est repris de l'etape 1.
COPY --from=inspect /plan /tmp/plan

# --- Dependances (couche mise en cache par Docker) ---
COPY --from=inspect /ctx/ /tmp/ctx/
RUN set -e; SRC=/tmp/ctx/$(cat /tmp/plan); \
    echo "Sources : $SRC" ; \
    cp "$SRC/package.json" "$SRC/package-lock.json" /app/ ; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Code applicatif, pages publiques, migrations ---
RUN set -e; SRC=/tmp/ctx/$(cat /tmp/plan); \
    cp -r "$SRC/src" /app/src ; \
    if [ -d "$SRC/public" ]; then cp -r "$SRC/public" /app/public; fi ; \
    if [ -d "$SRC/test" ]; then cp -r "$SRC/test" /app/test; fi ; \
    if [ -f "$SRC/start.sh" ]; then cp "$SRC/start.sh" /app/start.sh; chmod 755 /app/start.sh; fi ; \
    if [ -d "$SRC/db" ]; then cp -r "$SRC/db" /app/db; \
    elif [ -d /tmp/ctx/db ]; then cp -r /tmp/ctx/db /app/db; \
    elif [ -d /tmp/ctx/backend/db ]; then cp -r /tmp/ctx/backend/db /app/db; fi ; \
    echo '--- contenu de /app ---' ; ls -la /app ; \
    echo '--- migrations ---' ; ls /app/db | wc -l ; \
    test -f /app/src/server.js

RUN rm -rf /tmp/ctx /tmp/plan

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_DIR=/app
ENV TEEBO_DB_DIR=/app/db
ENV MIGRATION_MAX_MS=120000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Demarrage DIRECT par node : aucune dependance a un script externe.
CMD ["node", "src/server.js"]
