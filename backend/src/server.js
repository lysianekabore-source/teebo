import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import { q, tx } from './db.js';
import { authenticate, requireFreshPassword, requireRole, createSession } from './auth.js';
import authRoutes from './routes/auth.js';
import requestRoutes from './routes/requests.js';
import orgRoutes from './routes/org.js';
import teeboRoutes from './routes/teebo.js';
import deviceRoutes from './routes/devices.js';
import operationRoutes from './routes/operations.js';
import clientRoutes from './routes/clients.js';
import enrollmentRoutes from './routes/enrollment.js';
import productRoutes from './routes/products.js';
import visibilityRoutes from './routes/visibility.js';
import roundRoutes from './routes/round.js';
import collecteRoutes from './routes/collecte.js';
import collecte6Routes from './routes/collecte6.js';
import objectiveRoutes from './routes/objectives.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Limitation des tentatives (anti brute-force)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/v1/auth/login', loginLimiter);

// ----------------------------- API ----------------------------------------
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/requests', requestRoutes);       // parcours prospect (public)
app.use('/api/v1/teebo', teeboRoutes);             // tableau de bord teebo (admin)
app.use('/api/v1', orgRoutes);                     // hiérarchie (authentifié)
app.use('/api/v1', deviceRoutes);                  // terminaux + alertes sécurité
app.use('/api/v1', operationRoutes);               // opérations terrain + crédit
// Enrôlement clients / ouverture de compte / chaîne de collecte : monté AVANT
// clients.js afin que /clients/enroll, /clients/new, /clients/completeness…
// ne soient pas capturés par la route paramétrée /clients/:id.
app.use('/api/v1', enrollmentRoutes);
// Produits d'épargne IMF, frais (tenue de compte, collecte mobile, rattrapage),
// retrait anticipé, demandes personnalisées et dossiers de crédit.
// Monté AVANT clients.js / operations.js : /operations/deposit, /operations/withdraw-early,
// /savings-products… doivent primer sur les routes génériques.
app.use('/api/v1', productRoutes);
app.use('/api/v1', clientRoutes);                  // clients, espaces en ligne, relevés
app.use('/api/v1', visibilityRoutes);              // autorisations fines inter-entités
app.use('/api/v1', roundRoutes);                   // tournée du jour de la collectrice
// VAGUE 5 : plafonds de collecte, versements caisse/Mobile Money, reçus simples,
// journal SMS clients. Monté après clients.js (les chemins /collecte/* sont
// distincts) mais avant le fallback HTML.
app.use('/api/v1', collecteRoutes);
// VAGUE 6 : anti-doublons, affectations superviseur → collectrice, relevé BCEAO,
// approbation caissière + export Excel des dépôts de collecte.
app.use('/api/v1', collecte6Routes);
// VAGUE 7 : module Objectifs hiérarchiques (DG -> Superviseur -> Collectrice),
// contrôle de cohérence d'équipe + roll-up temps réel de la progression.
app.use('/api/v1', objectiveRoutes);

// ----------------------------- Frontend -----------------------------------
const pub = path.resolve(__dirname, '../../frontend');
app.use(express.static(pub, { extensions: ['html'] }));

// Santé
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Pages (fallback HTML)
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(pub, 'app.html')));
app.get('/teebo', (_req, res) => res.sendFile(path.join(pub, 'teebo.html')));
app.get('/terrain', (_req, res) => res.sendFile(path.join(pub, 'terrain.html')));
app.get('/essai', (_req, res) => res.sendFile(path.join(pub, 'essai.html')));
app.get('/autorisations', (_req, res) => res.sendFile(path.join(pub, 'autorisations.html')));
app.get('/securite', (_req, res) => res.sendFile(path.join(pub, 'securite.html')));
app.get('/documentation', (_req, res) => res.sendFile(path.join(pub, 'documentation.html')));

// Gestion d'erreurs
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.code || 'server_error' });
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`teebo API en écoute sur ${host}:${port}`));
