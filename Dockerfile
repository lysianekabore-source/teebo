# ============================================================================
# teeBo — image de l'API (Render, runtime Docker)
# ----------------------------------------------------------------------------
# CORRECTIF VAGUE 52 — CAUSE RACINE DE « Exited with status 2 »
#   Journal Render : « sh: 0: cannot open ./start.sh: No such file »
#
#   Le Dockerfile terminait par  CMD ["sh", "./start.sh"]  alors qu'AUCUNE
#   instruction COPY ne copiait start.sh dans l'image : le conteneur démarrait
#   donc sans le fichier qu'il devait exécuter, et sortait immédiatement.
#   Les correctifs précédents décrivaient ce COPY dans les commentaires… sans
#   jamais l'écrire. C'est exactement pour cela que l'erreur revenait.
#
#   DOUBLE SÉCURITÉ appliquée ici, pour que cela ne puisse PLUS revenir :
#     1. start.sh EST copié dans l'image (COPY + chmod) ;
#     2. la commande de démarrage n'en dépend plus : CMD lance node directement.
#        Même si start.sh disparaissait, le service démarrerait quand même.
#     3. une vérification de build (RUN test -f src/server.js) fait ÉCHOUER la
#        construction avec un message clair si l'image est incomplète, au lieu
#        d'échouer silencieusement au démarrage.
#
# Contexte de build attendu = ce dossier (celui qui contient ce Dockerfile).
# ============================================================================
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- Dépendances (le lockfile garantit des versions identiques à chaque build) ---
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Code applicatif ---
COPY src ./src

# --- Pages servies par l'API (console administrateur) ---
COPY public ./public

# --- Migrations SQL ---
COPY db* ./db/

# --- Script de démarrage : copié ET rendu exécutable (il ne l'était pas) ---
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# --- Garde-fou de build : image incomplète = échec IMMÉDIAT et lisible ---
RUN test -f /app/src/server.js || (echo "ERREUR BUILD : src/server.js absent de l'image" && exit 1)

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_DIR=/app
ENV TEEBO_DB_DIR=/app/db
ENV MIGRATION_MAX_MS=120000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Démarrage DIRECT par node : aucune dépendance à un script externe.
# (Le port s'ouvre immédiatement ; la migration tourne ensuite en tâche de fond.)
CMD ["node", "src/server.js"]
