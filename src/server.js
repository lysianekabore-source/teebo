import secretariatRoutes from './routes/secretariat.js';
import {startSecWorker} from './secretariat_engine.js';
import {studio as cmsStudio,client as cmsClient,agent as cmsAgent} from './routes/cms.js';
import {startCmsWorker} from './cms_engine.js';
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import httpMod from 'http';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

import { q, tx, pool } from './db.js';
import { logEmailGateway } from './notify.js';
import { authenticate, attachUser, requireFreshPassword, requireRole, createSession, hashToken } from './auth.js';
import authRoutes, { court as authCourtesRoutes } from './routes/auth.js';
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
import workspaceRoutes from './routes/workspace.js';
import teeboRoutes from './routes/teebo.js';
import codesAccesRoutes from './routes/codes_acces.js'; // VAGUE 46 : codes d acces (console editeur)
import superAdminRoutes from './routes/super_admin.js'; // VAGUE 47 : console Super-Admin SaaS
import { gardeSaas } from './saas_engine.js';            // VAGUE 47 : statut contrat + modules
import deviceRoutes from './routes/devices.js';
import operationRoutes from './routes/operations.js';
import clientRoutes from './routes/clients.js';
import enrollmentRoutes from './routes/enrollment.js';
import productRoutes from './routes/products.js';
import visibilityRoutes from './routes/visibility.js';
import roundRoutes from './routes/round.js';
import monTableauBordRoutes from './routes/mon_tableau_bord.js'; // VAGUE 57 : tableau de bord personnel (agent de collecte)
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
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
// CORS : la variable d'environnement CORS_ORIGIN peut valoir « true » ou « * »
// (valeur recopiee telle quelle dans Render). Envoyee brute, elle produisait un
// en-tete « access-control-allow-origin: true » que les navigateurs rejettent,
// ce qui faisait echouer toute lecture directe de l'API depuis le site.
const corsOriginBrut = String(process.env.CORS_ORIGIN || '').trim();
const corsOrigin = (!corsOriginBrut || corsOriginBrut === 'true' || corsOriginBrut === '*')
  ? true : corsOriginBrut;
app.use(cors({ origin: corsOrigin, credentials: true }));
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
// REPONSES JSON COMPRESSEES (gzip) : sur un reseau mobile, une liste de clients
// ou un tableau de bord pesaient plusieurs centaines de Ko en clair. L'API n'a
// pas de dependance de compression : on utilise le module natif de Node.
app.use((req, res, next) => {
  if (!/^\/api\//.test(req.path)) return next();
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(ae)) return next();
  const jsonOriginal = res.json.bind(res);
  res.json = function (body) {
    try {
      if (res.headersSent || res.getHeader('Content-Encoding')) return jsonOriginal(body);
      const buf = Buffer.from(JSON.stringify(body === undefined ? null : body), 'utf8');
      if (buf.length < 1024) return jsonOriginal(body);
      zlib.gzip(buf, (err, out) => {
        if (err) return jsonOriginal(body);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(out.length));
        res.end(out);
      });
      return res;
    } catch (e) { return jsonOriginal(body); }
  };
  next();
});
app.use(cookieParser());

// Version du binaire en ligne (une seule source pour /version, /healthz et
// l'en-tete X-Teebo-Build).
startCmsWorker();
startSecWorker();
const API_BUILD = 'v81-secretariat-gouvernance-2026-11-26';
// Numéro de version affiché sur la page d'accueil de l'API : il permet de
// vérifier en UN clic, depuis un simple navigateur, quelle version est en ligne.
const BUILD_SHORT = API_BUILD.split('-')[0];
const API_KINDS = ['direction', 'department', 'service', 'agency', 'point_service'];
// L'en-tete X-Teebo-Build permet de verifier en une seconde, dans l'onglet
// « Reseau » du navigateur, quelle version du serveur a repondu.
app.use((_req, res, next) => {
  try { res.set('X-Teebo-Build', API_BUILD); } catch (_) {}
  next();
});
// CORRECTIF 18/11/2026 : identifie l'utilisateur pour TOUTE l'API, avant les
// routeurs. Les routeurs qui oubliaient authenticate ne renvoient plus un
// 401 trompeur qui ejectait l'utilisateur vers la page de connexion.
// ---------------------------------------------------------------------------
// REPERES DE DEPLOIEMENT — PUBLICS, VOLONTAIREMENT PLACES AVANT TOUT CONTROLE.
// Une route declaree plus loin passait par le cloisonnement et la garde SaaS :
// pour un visiteur non connecte elle pouvait repondre 403 au lieu de la version,
// ce qui faisait croire a un serveur ancien. Ici, aucune dependance : la reponse
// est toujours celle du binaire reellement en ligne.
// ---------------------------------------------------------------------------
app.get('/api/v1/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true, build: API_BUILD, attach_user: true,
    kinds: API_KINDS,
    // CAPACITÉS : le site adapte l'assistant de mise en place à ce que le
    // serveur RÉELLEMENT en ligne sait faire (aucun refus incompréhensible).
    caps: { org_setup: true, hierarchy_shortcuts: true, identity_update: true,
      point_service: true },
    routes: { mon_tableau_bord: true, clients: true, clients_new: true },
    corrections: { clients_agent_collecte: true, cache_saas_60s: true,
      cache_modules_30s: true, gzip_json: true, creation_client_agent: true,
      points_de_service: true, parcours_organisation: true },
    now: new Date().toISOString()
  });
});
app.get('/version', (_req, res) => { res.set('Cache-Control', 'no-store'); res.redirect(307, '/api/v1/version'); });
// CAPACITES D'ORGANISATION (public, sans donnee sensible) : le site lit ce que
// le serveur EN LIGNE accepte reellement, et n'offre jamais un rattachement qui
// sera refuse. Sert aussi de reperere de deploiement en une seule adresse.
app.get('/api/v1/org/capabilities', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true, build: API_BUILD,
    kinds: API_KINDS,
    hierarchy_shortcuts: true,
    point_service: true,
    parents: {
      direction: [],
      department: ['direction'],
      service: ['direction', 'department'],
      agency: ['direction', 'department', 'service'],
      point_service: ['agency']
    }
  });
});
app.get('/healthz', (_req, res) => res.json({ ok: true, build: BUILD_SHORT, api_build: API_BUILD, point_service: true, org_setup: true, attache: true, hierarchy_shortcuts: true, pca_role: true }));

// Diagnostic de session, public et sans donnee sensible : il dit seulement si
// le cookie arrive et si la session existe encore.
app.get('/api/v1/diag-session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const out = { build: API_BUILD, cookie_present: false, cookie_len: 0, session_found: false,
    user: null, idle_minutes: null, server_time: new Date().toISOString() };
  try {
    const token = (req.cookies && req.cookies.teebo_session) || '';
    out.cookie_present = !!token;
    out.cookie_len = token ? String(token).length : 0;
    if (token) {
      const r = await q(
        `SELECT s.last_seen_at, s.expires_at, s.revoked, u.role, u.code_user
           FROM session s JOIN app_user u ON u.id = s.user_id
          WHERE s.token_hash = $1`, [hashToken(token)]);
      if (r.rows.length) {
        const row = r.rows[0];
        out.session_found = !row.revoked;
        out.user = { role: row.role, code_user: row.code_user };
        out.idle_minutes = row.last_seen_at
          ? Math.round((Date.now() - new Date(row.last_seen_at).getTime()) / 60000) : null;
      }
    }
  } catch (e) { out.error = String(e && e.message || e).slice(0, 120); }
  res.json(out);
});


app.use('/api/client',cmsClient);
app.use('/api/v1', attachUser);

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
// VAGUE 47 : garde SaaS (statut du contrat, module souscrit, lecture seule apres
// impaye). Placee APRES le cloisonnement, AVANT les routeurs metier. Elle ne
// bloque jamais l'editeur et ne renvoie rien de nominatif.
app.use('/api/v1', gardeSaas);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', collecteurRoutes);              // caisse, clôture, commissions, zoning, hors-ligne
app.use('/api/v1', subscriptionRoutes);           // v36 : /institution/config + activation de module
app.use('/api/v1', adminConsoleRoutes);          // v36 : console admin (liste IMF, restriction, levée)
app.use('/api/v1', restrictionRoutes);            // v36 : restriction immédiate collecte seule
// VAGUE 48 : saasRoutes declare ses chemins avec le prefixe '/saas/...' :
// le montage sur /api/v1/saas ajoutait un second prefixe -> 404 sur 10 routes.
app.use('/api/v1', saasRoutes);                    // abonnement par module, licence unique, factures              // caisse, clôture, commissions, zoning, hors-ligne
app.use('/api/v1/requests', requestRoutes);       // parcours prospect (public)
// VAGUE 48 : les pages publiques d'inscription appellent /api/v1/uemoa-countries,
// /api/v1/plans, /:id/select-plan, /:id/proforma.pdf... qui sont declares dans
// requestRoutes SANS le prefixe '/requests'. On les rend donc aussi visibles
// a la racine de l'API, tout en conservant /api/v1/requests (compatibilite).
app.use('/api/v1', requestRoutes);
// VAGUE 48 : teeboRoutes declare DÉJÀ '/teebo/...' dans ses chemins :
// monte sur /api/v1 (le double prefixe renvoyait 404 sur 29 routes editeur).
app.use('/api/v1', teeboRoutes);             // tableau de bord teebo (admin)
app.use('/api/v1', codesAccesRoutes);               // VAGUE 46 : codes d acces /teebo/acces/*
// VAGUE 48 : le routeur super-admin declare ses chemins avec le prefixe
// '/super-admin/...' : on le monte sur /api/v1 (sinon double prefixe -> 404).
app.use('/api/v1', superAdminRoutes);    // VAGUE 47 : console editeur (onglets clients, modules, factures)
app.use('/api/v1', orgRoutes);                     // hiérarchie (authentifié)
app.use('/api/v1',secretariatRoutes);
app.use('/api/secretariat',(req,res,next)=>{const original=req.url;req.url='/secretariat'+req.url;secretariatRoutes(req,res,e=>{req.url=original;next(e);});});
app.use('/api/v1',cmsStudio);
app.use('/api/v1',cmsAgent);
app.use('/api/v1', workspaceRoutes);
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
// VAGUE 48e — CAUSE RACINE : /:id/proforma.pdf (requests.js, monté sur /api/v1)
// interceptait POST /api/v1/2fa/enroll/start avant le routeur d'auth :
// l'enrôlement 2FA renvoyait 401 « not_authenticated ». On re-sert les
// adresses courtes de la vague 48 EN AMONT, avec les tout premiers routeurs
// publics. Ce sont les mêmes traitements (aucune duplication).
app.use('/api/v1', (req, res, next) => {
  const p = String(req.path || '');
  if (!/^\/2fa\/|^\/(me|logout|keepalive|change-password)$/.test(p)) return next();
  return authCourtesRoutes(req, res, next);
});
app.use('/api/v1', visibilityRoutes);              // autorisations fines inter-entités
app.use('/api/v1', roundRoutes);                   // tournée du jour de la collectrice
// VAGUE 57 : tableau de bord personnel de l'agent de collecte (un seul appel :
// caisse vs plafond, versements, tournée, objectifs, commissions, crédit, historique).
app.use('/api/v1', monTableauBordRoutes);
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
app.use('/api/v1/governance', governanceConformiteRoutes);

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
    pret, base, tables, essai: etat.essai || 'en attente',
    ...(manquantes.length ? { tables_manquantes: manquantes } : {}),
    migration: etat.migration, reparation: etat.reparation || 'en attente',
    erreur: etat.erreur, depuis: etat.demarre
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
    console.log('Etat migration : ' + etat.migration);
    // CORRECTIF VAGUE 52 : migrate() s'arrete des que la base est « deja a jour »
    // et ne rejoue donc jamais les correctifs plus recents sur une base existante.
    // On applique ici, a chaque demarrage, une reparation ciblee et idempotente
    // des objets manquants (statut 'deleted', colonnes de access_request,
    // mentions legales). Un echec est journalise mais ne bloque jamais le service.
    if (ok) {
      try {
        const { reparerSchemaConsole } = await import('./schema_repair.js');
        const rep = await reparerSchemaConsole();
        etat.reparation = rep.ok ? 'ok' : ('partielle (' + rep.echecs.length + ')');
      } catch (e) {
        etat.reparation = 'differee';
        console.error('[schema] reparation non executee :', e && (e.message || e));
      }
      // VAGUE 66 — Une agence peut avoir des POINTS DE SERVICE rattachés
      // (guichet, caisse, marché). Le type est ajouté ici, idempotent, pour
      // que la création fonctionne dès le premier clic après le déploiement.
      try {
        await q("ALTER TYPE unit_kind ADD VALUE IF NOT EXISTS 'point_service'");
        // Bases historiques ou la colonne « kind » etait un texte avec une
        // contrainte limitant les valeurs : la contrainte empechait d'ecrire
        // « point_service ». On la retire (idempotent, sans perte de donnee).
        try { await q('ALTER TABLE org_unit DROP CONSTRAINT IF EXISTS org_unit_kind_check'); }
        catch (eC) { console.warn('[units] contrainte kind :', eC && (eC.message || eC)); }
        etat.point_service = 'ok';
        // VAGUE 71 — Le poste « Président du Conseil d'Administration » reçoit
        // le rôle de surveillance « pca_admin ». Ce rôle existe dans tout le
        // code mais manquait dans la base : la création du compte échouait avec
        // « Le format d'une valeur saisie est invalide ». On complète le type.
        try { await q("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'pca_admin'"); }
        catch (eR) { console.warn('[users] role pca_admin :', eR && (eR.message || eR)); }
      } catch (e) {
        etat.point_service = 'indisponible';
        console.warn('[units] type point_service :', e && (e.message || e));
      }
    }
    // VAGUES 44 + 45 : rattrapage des IMF passees en essai AVANT ce deploiement
    // (les IMF qui s inscrivent APRES ne sont PAS basculees : voir schema_v45.sql).
    // Une seule passe apres une migration reussie ; chaque IMF est isolee et
    // la fonction est idempotente (relancer ne change rien).
    if (ok) {
      try {
        const { rattraperEssaisAuDemarrage } = await import('./essai_bascule.js');
        const r = await rattraperEssaisAuDemarrage();
        etat.essai = r && r.ok ? 'verifie' : ('differe:' + (r && r.motif));
      } catch (e) {
        etat.essai = 'differe';
        console.error('[essai] rattrapage non execute :', e && (e.message || e));
      }
    }
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

// Sante : /healthz et /api/v1/version sont declares plus haut (publics).


// Pages (fallback HTML)
const SITE = process.env.PUBLIC_SITE_URL || 'https://teebo-imf.netlify.app';
function page(file) {
  return (_req, res) => {
    if (!hasSite) return res.redirect(302, SITE);
    res.sendFile(path.join(pub, file), (e) => { if (e && !res.headersSent) res.redirect(302, SITE); });
  };
}
// Page d'accueil de l'API : elle AFFICHE la version réellement en service.
// Un simple clic sur l'adresse du serveur suffit donc à savoir si le
// déploiement a bien remplacé l'ancienne version (avant, elle renvoyait
// silencieusement vers le site, sans aucune information).
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send('<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>teebo — API</title><style>body{font-family:system-ui,Arial,sans-serif;'
    + 'background:#eef0f6;color:#0b0c26;display:flex;align-items:center;justify-content:center;'
    + 'min-height:100vh;margin:0}.c{background:#fff;border-radius:14px;padding:30px 34px;'
    + 'max-width:520px;box-shadow:0 14px 44px rgba(11,12,38,.12)}h1{font-size:18px;margin:0 0 10px}'
    + 'p{font-size:13.5px;line-height:1.7;color:#3c3f57;margin:0 0 12px}'
    + 'a{display:inline-block;background:#0b0c26;color:#fff;text-decoration:none;font-weight:700;'
    + 'font-size:13px;padding:11px 18px;border-radius:9px}</style></head><body><div class="c">'
    + '<h1>Serveur API teebo — version ' + BUILD_SHORT + '</h1>'
    + '<p>Version en service : <b>' + BUILD_SHORT + '</b> — agences sous la Direction Générale, '
    + 'points de service, création des comptes.</p>'
    + '<p>Si cette page n\'affiche aucun numéro de version, c\'est que l\'ancien serveur '
    + 'est encore en ligne : le déploiement n\'a pas pris.</p>'
    + '<p><a href="' + SITE + '">Ouvrir l\'application teebo</a></p></div></body></html>');
});
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
    + '<h1>Serveur API teebo — version ' + BUILD_SHORT + '</h1>'
    + '<p>Cette adresse sert uniquement l’interface de programmation (API). '
    + 'L’application et les pages publiques sont sur le site teebo.</p>'
    + '<p style="font-size:12.5px;color:#6b7080">Version en service : <b>' + BUILD_SHORT + '</b> — '
    + 'agences sous la Direction Générale, points de service, création des comptes.</p>'
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
  // Etat de la passerelle e-mail : une seule ligne dans le journal dit si les
  // codes d'acces peuvent reellement partir (et pourquoi sinon).
  setTimeout(() => { logEmailGateway().catch(() => {}); }, 1500);
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
