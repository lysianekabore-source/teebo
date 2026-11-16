import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import httpMod from 'http';
import { fileURLToPath } from 'url';

import { q, tx, pool } from './db.js';
import { authenticate, requireFreshPassword, requireRole, createSession } from './auth.js';
import authRoutes from './routes/auth.js';
import { tenantContext } from './tenant.js';
import { checkModuleActivation } from './modules.js';
import collecteurRoutes from './routes/collecteurs.js';
import saasRoutes from './routes/saas.js';
import subscriptionRoutes from './routes/subscription.js';
import restrictionRoutes from './routes/saas_restriction_patch.js';
import adminConsoleRoutes from './routes/admin_console.js';
import requestRoutes from './routes/requests.js';
import orgRoutes from './routes/org.js';
import settingsRoutes from './routes/settings.js';
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
import collecteEsRoutes from './routes/collecte_es.js';
import creditRoutes from './routes/credit.js';           // VAGUE 38 : module crédit BCEAO
import conformiteRoutes from './routes/conformite.js';   // VAGUE 41 : KYC / KYB / visites GPS LBC-FT
import certificatKycRoutes from './routes/certificat_kyc.js'; // VAGUE 42 : certificat de diligence KYC/KYB
import objectiveRoutes from './routes/objectives.js';
import structureRoutes from './routes/structure.js';
import accessRoutes from './routes/access.js';
import governanceRoutes from './routes/governance.js';
import { gcRouter as governanceConformiteRoutes } from './governance_conformite.js';
import bankingRoutes from './routes/banking.js';
import { gestionnaireErreurs, routeInconnue } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Dernière origine de site connue (voir middleware X-Site-URL ci-dessous).
export let SITE_ORIGIN_SEEN = '';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      // CORRECTIF 13/11/2026-E bis — les pages HTML servies par l'API
      // (page d'information /, page « Export indisponible », 404, redirections)
      // contiennent des styles INLINE. Avec « style-src 'self' » seul, le
      // navigateur BLOQUAIT ces styles : pages affichées sans mise en forme,
      // impression illisible. On autorise donc les styles inline (le texte
      // reste échappé, aucun script inline n'est admis).
      styleSrc: ["'self'", "'unsafe-inline'"],
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
// 12 Mo : les scans de pièces et les signatures tracées au stylet transitent
// en data URL (base64) et dépassent largement 1 Mo ; une limite trop basse
// renvoyait un 413 masqué en « Une erreur est survenue » lors de la
// confrontation / signature. On autorise donc des corps plus volumineux.
// CONTEXTE DU SITE : quel site le visiteur utilise-t-il ? (Netlify, domaine
// propre, aperçu de déploiement…). Le front envoie l'origine réelle dans
// l'en-tête X-Site-URL ; on la mémorise pour que les messages envoyés
// (code d'accès, mot de passe oublié) contiennent LE lien de connexion du
// client et non l'adresse Render de l'API. Aucune valeur n'est acceptée sans
// contrôle : seules les origines http(s) valides et non locales sont gardées.
app.use((req, _res, next) => {
  try {
    const raw = req.headers['x-site-url'] || req.headers.origin || req.headers.referer;
    const v = String(raw || '').trim();
    if (v) {
      const u = new URL(v);
      if (/^https?:$/.test(u.protocol) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(u.origin)) {
        SITE_ORIGIN_SEEN = u.origin;
        globalThis.__TEEBO_SITE_ORIGIN__ = u.origin;
      }
    }
  } catch (_) { /* en-tête absent ou illisible : on garde la dernière valeur connue */ }
  next();
});
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

// Limitation des tentatives (anti brute-force)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/v1/auth/login', loginLimiter);
// « Mot de passe oublié » : limite plus stricte (anti-abus / anti e-mail bombing).
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
app.use('/api/v1/auth/forgot-password', resetLimiter);
app.use('/api/v1/auth/reset-password', resetLimiter);

// ----------------------------- API ----------------------------------------
// Cloisonnement (RLS + header IMF) et modules activés : appliqués à TOUTE l'API.
app.use('/api/v1', tenantContext, checkModuleActivation);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', collecteurRoutes);              // caisse, clôture, commissions, zoning, hors-ligne
app.use('/api/v1', subscriptionRoutes);           // v36 : /institution/config + activation de module
app.use('/api/v1', adminConsoleRoutes);          // v36 : console admin (liste IMF, restriction, levée)
app.use('/api/v1', restrictionRoutes);            // v36 : restriction immédiate collecte seule
app.use('/api/v1', saasRoutes);                    // abonnement par module, licence unique, factures              // caisse, clôture, commissions, zoning, hors-ligne
app.use('/api/v1/requests', requestRoutes);       // parcours prospect (public)
app.use('/api/v1/teebo', teeboRoutes);             // tableau de bord teebo (admin)
app.use('/api/v1', orgRoutes);                     // hiérarchie (authentifié)
app.use('/api/v1', settingsRoutes);                // paramètres IMF (branding + mentions légales)
app.use('/api/v1', deviceRoutes);                  // terminaux + alertes sécurité
app.use('/api/v1', operationRoutes);               // opérations terrain + crédit
// Enrôlement clients / ouverture de compte / chaîne de collecte : monté AVANT
// clients.js afin que /clients/enroll, /clients/new, /clients/completeness…
// ne soient pas capturés par la route paramétrée /clients/:id.
app.use('/api/v1', enrollmentRoutes);
// VAGUE 15 : opérations bancaires fonctionnelles (modif client, dépassement de
// plafond, arrêté de caisse, coffre, écritures comptables, impayés/recouvrement).
// Monté AVANT productRoutes pour que /credits/arrears prime sur /credits/:id.
app.use('/api/v1', bankingRoutes);
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
// VAGUE 37 : module Collecte & Epargne securise - synchronisation hors-ligne
// idempotente, contre-passation, sessions de caisse, billetage FCFA, carnets
// tontine (31 jours + commission IMF), recus et notifications.
app.use('/api/v1', collecteEsRoutes);
// VAGUE 38 : module Credit BCEAO complet - produits, simulateur TEG,
// dossiers (4 yeux + plafonds), garanties dont epargne bloquee, decaissement
// avec echeancier fige, remboursements imputes penalites -> interets -> capital,
// recouvrement, tache quotidienne declassement/provision et PAR 30/90.
// Chemins /credit/... distincts des routes historiques /credits/... (vague 15).
// Le SCORING ALTERNATIF (vague 40 : grilles ponderees, score 5 piliers, plafond
// soutenable, avis BIC UEMOA) est monte DANS ce routeur, sous /credit/... :
// aucune ligne a ajouter ici, les chemins /credit/scoring/... et
// /credit/dossiers/:id/score sont servis par creditRoutes.
app.use('/api/v1', creditRoutes);
// VAGUE 41 : conformite LBC/FT/FP (Instruction BCEAO n°003-03-2025) — dossier
// KYC personne physique, KYB personnes morales (beneficiaires effectifs > 25 %
// + mandataires), criblage flou des listes sanctions / PPE, visites de terrain
// hors-ligne GPS, controle quotidien des pieces echees et feu vert de
// decaissement. Chemins /conformite/... distincts des registres v27/v29.
app.use('/api/v1', conformiteRoutes);
// VAGUE 42 : CERTIFICAT DE DILIGENCE KYC/KYB & VISITE TERRAIN. Le meme routeur
// est monte sous /api/v1 (generation, disponibilite, historique, annulation) ET
// a la racine pour la page PUBLIQUE /verify-certificat/:empreinte, ouverte par
// le QR code sans jeton. Chemins distincts de ceux de la vague 41.
app.use('/api/v1', certificatKycRoutes);
app.use('/', certificatKycRoutes);
// VAGUE 7 : module Objectifs hiérarchiques (DG -> Superviseur -> Collectrice),
// contrôle de cohérence d'équipe + roll-up temps réel de la progression.
app.use('/api/v1', objectiveRoutes);
// VAGUE 11 : structure org fine (8 départements/services), matrice RBAC par
// verbe et consultation de la piste d'audit immuable (IA anti-fraude).
app.use('/api/v1', structureRoutes);
// VAGUE 13 : habilitations éditables (catalogue custom, postes custom, toggles
// par poste / par utilisateur) + garde de l'écran de validation finale crédit.
app.use('/api/v1', accessRoutes);
// VAGUE 27 : gouvernance & conformite (loi-cadre UMOA) — 6 registres
// cloisonnes par IMF + tableau de bord et rapport imprimable.
app.use('/api/v1', governanceRoutes);
// VAGUE 29 — conformite prudentielle, risques & PCA, echeancier, exports reglementaires
app.use('/api/v1', governanceConformiteRoutes);

// État de préparation, exposé sur /ready (et utilisé par /healthz).
const etat = { migration: 'en attente', demarre: new Date().toISOString(), erreur: null };
app.get('/ready', async (_req, res) => {
  // Vérification RÉELLE de la base à la demande (Render ne l'appelle pas,
  // c'est pour vous : ouvrez /ready dans le navigateur pour savoir où en est
  // le service). Ne bloque pas : 3 s maximum.
  let base = 'injoignable';
  let tables = 0;
  let manquantes = [];
  try {
    await Promise.race([q('SELECT 1'), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 3000))]);
    base = 'connectee';
    const t = await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
    tables = t.rows[0].n;
    // CORRECTIF 13/11/2026-E bis : /ready ne dit plus seulement « prêt ou
    // pas », il NOMME les tables essentielles absentes. C'est ce qui manquait
    // pour comprendre pourquoi un écran renvoyait une erreur 500
    // (« relation ... does not exist ») alors que /healthz répondait ok.
    try {
      const ess = ['imf', 'app_user', 'client', 'session', 'detenteurs_capital',
        'mouvements_titres', 'parametres_capital', 'ag_quorum', 'sessions_et_pv'];
      const r = await q(
        "SELECT t.n AS nom, (SELECT 1 FROM information_schema.tables i " +
        "WHERE i.table_schema='public' AND i.table_name=t.n) AS present " +
        'FROM unnest($1::text[]) AS t(n)', [ess]);
      manquantes = r.rows.filter((x) => !x.present).map((x) => x.nom);
    } catch (e) { /* le détail est facultatif : ne bloque pas /ready */ }
  } catch (e) { base = 'injoignable (' + (e && e.message) + ')'; }
  const pret = base === 'connectee' && tables > 10 && manquantes.length === 0;
  res.status(pret ? 200 : 503).json({
    pret, base, tables,
    ...(manquantes.length ? { tables_manquantes: manquantes } : {}),
    migration: etat.migration, erreur: etat.erreur, depuis: etat.demarre
  });
});

// ---------------------------------------------------------------------------
// CORRECTIF 13/11/2026-D — le serveur n'attend PLUS la base pour se mettre en
// ligne. Ordre des opérations :
//   1. le port s'ouvre immédiatement (Render voit le service en vie) ;
//   2. la migration tourne ensuite en tâche de fond, sans jamais bloquer ;
//   3. si la base était endormie, elle est réessayée automatiquement toutes
//      les 20 s (3 tentatives en arrière-plan après le démarrage).
// Avant, la migration passait AVANT le démarrage : une base endormie rendait
// le service « injoignable » alors que rien n'était cassé dans le code.
// ---------------------------------------------------------------------------
let essaisRestants = 3;
async function lancerMigration() {
  try {
    etat.migration = 'en cours';
    const { default: migrate } = await import('./migrate.js');
    const ok = await migrate();
    etat.migration = ok ? 'terminee' : 'reportee';
    etat.erreur = ok ? null : 'Base injoignable pour le moment';
    console.log('État migration : ' + etat.migration);
    if (!ok && essaisRestants > 0) {
      essaisRestants--;
      setTimeout(lancerMigration, 20000).unref();
    }
  } catch (e) {
    etat.migration = 'erreur';
    etat.erreur = String((e && e.message) || e);
    console.error('Migration non aboutie :', etat.erreur);
    if (essaisRestants > 0) { essaisRestants--; setTimeout(lancerMigration, 20000).unref(); }
  }
}

// ----------------------------- Frontend -----------------------------------
// CORRECTIF 13/11/2026-C — « ENOENT ... stat '/frontend/index.html' »
// L'API cherchait les pages web dans un dossier /frontend qui n'existe pas
// dans l'image (les pages sont servies par Netlify). Toute visite de
// l'adresse du serveur (.onrender.com) declenchait donc une erreur 404 en
// boucle. Desormais : si les pages sont presentes (developpement local, APP_DIR)
// on les sert ; sinon on repond proprement par une page d'information.
const pub = process.env.APP_DIR && process.env.APP_DIR !== '/app'
  ? path.resolve(process.env.APP_DIR)
  : path.resolve(__dirname, '../../frontend');
const hasSite = (() => {
  try { return fs.existsSync(path.join(pub, 'index.html')); } catch (e) { return false; }
})();
if (hasSite) {
  app.use(express.static(pub, { extensions: ['html'], index: 'index.html' }));
} else {
  console.log('Pages web non embarquees : le site est servi par ' +
    (process.env.PUBLIC_SITE_URL || 'Netlify') + ' (API seule sur ce serveur).');
}

// Sante
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Pages (fallback HTML)
const SITE = process.env.PUBLIC_SITE_URL || 'https://teebo-imf.netlify.app';
function page(file) {
  return (_req, res) => {
    if (!hasSite) return res.redirect(302, SITE);
    res.sendFile(path.join(pub, file), (e) => { if (e && !res.headersSent) res.redirect(302, SITE); });
  };
}
app.get(['/', '/index.html'], page('index.html'));
app.get('/login', page('login.html'));
app.get('/app', page('app.html'));
app.get('/teebo', page('teebo.html'));
app.get('/terrain', page('terrain.html'));
app.get('/essai', page('essai.html'));
app.get('/autorisations', page('autorisations.html'));
app.get('/securite', page('securite.html'));
app.get('/documentation', page('documentation.html'));

// VAGUE 36 — Console administrateur REELLE (restriction collecte seule).
// Servie par l'API elle-meme : elle agit sur les routes /api/v1/admin/...
// du meme domaine, sans dependre du site Netlify. Script externe (pas de
// script inline) : conforme a la politique de securite du serveur.
// Emplacement de la console : /app/public dans l'image, backend/public en
// local. On essaie les deux, puis le dossier du site s'il est embarque.
function chercherPage(nom) {
  const pistes = [
    path.resolve(__dirname, '../public', nom),
    path.resolve(process.cwd(), 'public', nom)
  ];
  if (typeof pub !== 'undefined') pistes.push(path.resolve(pub, nom));
  for (const p of pistes) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return pistes[0];
}
const CONSOLE_FILE = chercherPage('console-admin.html');
const CONSOLE_JS = chercherPage('console-admin.js');
app.get('/console-admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(CONSOLE_FILE, (e) => {
    if (e && !res.headersSent) {
      res.status(500).type('text/plain; charset=utf-8')
        .send('Page console absente de l’image : verifiez le dossier public/.');
    }
  });
});
// VAGUE 42 : script de la page publique de verification du certificat. Le
// document est servi par l'API elle-meme ; le bouton "Imprimer" a besoin d'un
// script EXTERNE (la politique de securite interdit les scripts en ligne).
const CERTIFICAT_JS = chercherPage('certificat-kyc.js');
app.get('/certificat-kyc.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(CERTIFICAT_JS, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
app.get('/console-admin.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(CONSOLE_JS, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
// Toute autre adresse inconnue : explication claire au lieu d'une erreur brute.
app.use((req, res, next) => {
  if (req.method !== 'GET' || String(req.path || '').startsWith('/api/')) return next();
  res.status(404).send('<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>teebo — API</title><style>body{font-family:system-ui,Arial,sans-serif;'
    + 'background:#eef0f6;color:#0b0c26;display:flex;align-items:center;justify-content:center;'
    + 'min-height:100vh;margin:0}.c{background:#fff;border-radius:14px;padding:30px 34px;'
    + 'max-width:520px;box-shadow:0 14px 44px rgba(11,12,38,.12)}h1{font-size:18px;margin:0 0 10px}'
    + 'p{font-size:13.5px;line-height:1.7;color:#3c3f57;margin:0 0 12px}'
    + 'a{display:inline-block;background:#0b0c26;color:#fff;text-decoration:none;font-weight:700;'
    + 'font-size:13px;padding:11px 18px;border-radius:9px}</style></head><body><div class="c">'
    + '<h1>Serveur API teebo — en fonctionnement</h1>'
    + '<p>Cette adresse sert uniquement l’interface de programmation (API). '
    + 'L’application et les pages publiques sont sur le site teebo.</p>'
    + '<p><a href="' + SITE + '">Ouvrir l’application teebo</a></p></div></body></html>');
});

// ---------------------------------------------------------------------------
// GESTION GLOBALE DES ERREURS (VAGUE 31)
// Le traitement vit désormais dans ./errors.js : signature correcte, garde-fou
// res.headersSent, traduction des erreurs PostgreSQL, identifiant d'incident
// (en-tête X-Error-Id), aucun détail technique exposé en production.
// ---------------------------------------------------------------------------
app.use(routeInconnue());          // 404 JSON explicite pour /api/*
app.use(gestionnaireErreurs());    // unique porte de sortie des erreurs

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`teebo API en écoute sur ${host}:${port}`);
  // La migration démarre juste après l'ouverture du port, en arrière-plan.
  setTimeout(lancerMigration, 300);
  // Sonde de vie : garde le service éveillé sur l'offre gratuite Render
  // (les instances gratuites s'endorment après 15 min d'inactivité).
  setInterval(() => {
    if (process.env.TEEBO_KEEPALIVE === '0') return;
    const url = 'http://127.0.0.1:' + port + '/healthz';
    const h = require_http();
    const r = h.get(url, (res) => res.resume());
    r.on('error', () => {});
  }, 10 * 60 * 1000).unref();
});

function require_http() { return httpMod; }

// Un dernier incident ne doit pas tuer le service silencieusement.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && (e.message || e)));
process.on('uncaughtException', (e) => {
  console.error('uncaughtException (service maintenu):', e && (e.stack || e.message || e));
  // CORRECTIF 13/11/2026-C : un incident isole ne doit plus arreter le service.
  // (Un ReferenceError dans la gestion d'erreurs avait coupe l'API.)
});

// Arrêt propre demandé par Render (SIGTERM) : on rend la main vite.
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}));
