# teebo - image de l'API (production)
# NOTE : le contexte de build doit etre la RACINE du projet
# (voir render.yaml -> dockerContext: .)
FROM node:20-alpine

WORKDIR /app

# Dependances (cache optimise)
COPY backend/package.json ./backend/package.json
RUN cd backend && npm install --omit=dev

# Code applicatif
COPY backend/src ./backend/src

# Schema de base de donnees (necessaire pour la migration au demarrage)
COPY db ./db

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app/backend
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
