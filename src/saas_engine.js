// ===========================================================================
// teebo — VAGUE 47 : MOTEUR SAAS (statut du tenant, modules, lecture seule)
// ---------------------------------------------------------------------------
// Ce module est la SEULE source de verite pour trois questions posees a
// chaque requete d'une IMF :
//
//   1. Le compte de l'IMF permet-il de travailler ?
//        ESSAI_GRATUIT non expire -> oui
//        ACTIF                    -> oui
//        SUSPENDU_IMPAYE          -> LECTURE SEULE (apres 7 jours de grace)
//        RESILIE                  -> non (sauf consultation / export)
//
//   2. Le module demande est-il souscrit et actif ?
//        tenant_modules_actifs.est_actif = TRUE
//        -> sinon 403 MODULE_NON_SOUSCRIT / ABONNEMENT_EXPIRE
//
//   3. L'utilisateur peut-il ecrire ?
//        lecture seule -> toute ecriture (POST/PUT/PATCH/DELETE) refusee,
//        la consultation et l'export restent ouverts (continuite BCEAO).
//
// Deux nomenclatures coexistent volotairement :
//   - les cles historiques (MODULE_COLLECTE_TONTINE, MODULE_DOSSIER_CREDIT,
//     MODULE_COMPLIANCE_KYC, MODULE_COMPTABILITE_AVANCEE) deja utilisees par
//     les ecrans existants et les abonnements en cours ;
//   - les codes courts du modele SaaS (COLLECTE, CREDIT, COMPTABILITE,
//     CONFORMITE, API_MOBILE_MONEY) demandes par le cahier des charges.
// Une table de correspondance unique evite toute divergence : c'est elle qui
// alimente le drapeau de tenant_modules_actifs et le filtre cote site.
// ===========================================================================
import { q } from './db.js';
import { MODULES } from './modules.js';

export const PLATFORM_ROLE = 'teebo_admin';

/** Codes courts SaaS -> module historique (null pour un module sans ecran). */
export const CODE_TO_MODULE = Object.freeze({
  COMMUNICATION_CMS: 'COMMUNICATION_CMS',
  COLLECTE: 'MODULE_COLLECTE_TONTINE',
  CREDIT: 'MODULE_DOSSIER_CREDIT',
  COMPTABILITE: 'MODULE_COMPTABILITE_AVANCEE',
  CONFORMITE: 'MODULE_COMPLIANCE_KYC',
  API_MOBILE_MONEY: null
});

/** Module historique -> code court SaaS. */
export const MODULE_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(CODE_TO_MODULE)
    .filter(([, m]) => m).map(([c, m]) => [m, c])));

/** Portee d'une requete : les prefixes historiques (modules.js) + les nôtres. */
export const CODE_PREFIXES = Object.freeze({
  COMMUNICATION_CMS: ['/cms','/cms-leads'],
  COLLECTE: ['/collecte', '/collecte-es', '/round', '/tontine', '/tournees', '/collecteurs', '/caisse'],
  CREDIT: ['/credit', '/credits', '/dossiers-credit', '/scoring', '/recouvrement'],
  COMPTABILITE: ['/comptabilite', '/ledger', '/accounting', '/journaux', '/grand-livre'],
  CONFORMITE: ['/conformite', '/compliance', '/kyc', '/sanctions', '/freeze', '/certificat-kyc'],
  API_MOBILE_MONEY: ['/mobile-money', '/momo', '/payments', '/paiements']
});

/** Statuts qui autorisent normalement l'ecriture. */
const STATUTS_ECRITURE = ['ACTIF', 'ESSAI_GRATUIT'];
const GRACE_JOURS = 7;

/** Jours de grace effectifs d'un tenant (defaut 7 si absent ou invalide). */
export function joursDeGrace(t) {
  const v = Number(t && t.jours_grace);
  return Number.isFinite(v) && v > 0 ? v : GRACE_JOURS;
}

/** Decision pure « peut-on ecrire ? » — utilisee par la garde et les tests. */
export function filtreEcrire(t) {
  const etat = evaluerTenant(t || {});
  return etat.autorise !== false && !etat.lecture_seule;
}

const cache = new Map();      // imf_id -> { exp, valeur }
const TTL_MS = 30 * 1000;     // 30 s : une bascule a chaud passe presque aussitot

function memoise(cle, chargeur) {
  const hit = cache.get(cle);
  if (hit && hit.exp > Date.now()) return hit.valeur;
  const promesse = chargeur().then((valeur) => {
    cache.set(cle, { exp: Date.now() + TTL_MS, valeur });
    return valeur;
  }).catch((e) => { cache.delete(cle); throw e; });
  cache.set(cle, { exp: Date.now() + TTL_MS, valeur: promesse });
  return promesse;
}

/** Vide le cache (appele apres toute bascule decidee par l'editeur). */
export function invaliderCache(imfId = null) {
  if (!imfId) return cache.clear();
  for (const k of cache.keys()) if (k.startsWith(String(imfId))) cache.delete(k);
}

/**
 * Etat SaaS d'une IMF (statut, essai, date d'echeance, modes).
 * Ne leve jamais : une base non migree renvoie un etat « autorise » pour ne pas
 * couper la production pendant un deploiement partiel.
 */
export async function etatTenant(imfId) {
  if (!imfId) return { autorise: true, lecture_seule: false, statut: null };
  return memoise('etat:' + imfId, async () => {
    try {
      const { rows } = await q(
        `SELECT t.statut_compte, t.date_expiration_essai, t.date_suspension,
                t.jours_grace, t.nom_imf, t.sigle
           FROM tenants t WHERE t.id = $1`, [imfId]);
      if (!rows.length) {
        // IMF anterieure a la vague 47 : on ne bloque rien, l'editeur la
        // classera depuis la console.
        return { autorise: true, lecture_seule: false, statut: null,
                 source: 'sans_contrat' };
      }
      return evaluerTenant(rows[0]);
    } catch (e) {
      console.error('[saas] etat tenant illisible : ' + (e && e.message));
      return { autorise: true, lecture_seule: false, statut: null, source: 'erreur' };
    }
  });
}

/** Regle pure (testable sans base) : statut + dates -> droits d'acces. */
export function evaluerTenant(t) {
  const auj = Date.now();
  const statut = String(t.statut_compte || 'ACTIF');
  const grace = joursDeGrace(t);
  const finEssai = t.date_expiration_essai ? new Date(t.date_expiration_essai).getTime() : null;

  if (statut === 'RESILIE') {
    return { autorise: false, lecture_seule: true, statut,
             motif: 'COMPTE_RESILIE',
             message: "Le contrat de votre institution est resilie : l'espace est en consultation seule (vos donnees restent exportables pendant 90 jours, exigence de continuite BCEAO)." };
  }
  if (statut === 'SUSPENDU_IMPAYE') {
    const depuis = t.date_suspension ? new Date(t.date_suspension).getTime() : auj;
    const jours = Math.floor((auj - depuis) / 86400000);
    if (jours < grace) {
      return { autorise: true, lecture_seule: false, statut, grace_restante: grace - jours };
    }
    return { autorise: true, lecture_seule: true, statut, motif: 'SUSPENDU_IMPAYE',
             jours_grace_depassee: jours - grace,
             message: "Facture d'abonnement impayee : votre espace est en LECTURE SEULE. La consultation et l'export de vos donnees restent disponibles ; les nouvelles operations reprendront des le reglement." };
  }
  if (statut === 'ESSAI_GRATUIT') {
    if (finEssai && finEssai < auj) {
      return { autorise: true, lecture_seule: true, statut, motif: 'ABONNEMENT_EXPIRE',
               message: "Votre periode d'essai est terminee : l'espace est en LECTURE SEULE. Souscrivez un abonnement pour reprendre les operations." };
    }
    return { autorise: true, lecture_seule: false, statut,
             jours_essai_restants: finEssai ? Math.max(0, Math.ceil((finEssai - auj) / 86400000)) : null };
  }
  if (STATUTS_ECRITURE.includes(statut)) {
    return { autorise: true, lecture_seule: false, statut };
  }
  return { autorise: true, lecture_seule: false, statut };
}

/**
 * Modules actifs d'une IMF, dans les deux nomenclatures.
 * La verite vient de tenant_modules_actifs (vague 47) ; si la ligne manque on
 * retombe sur les abonnements existants (institution_module_subscriptions)
 * puis sur les drapeaux historiques : aucune IMF ne perd un module au
 * deploiement.
 */
export async function modulesDuTenant(imfId) {
  if (!imfId) return { codes: [], legacy: [], inactifs: [] };
  return memoise('modules:' + imfId, async () => {
    const codes = new Set();
    const legacy = new Set();
    let lectureTenantModules = true;

    try {
      const { rows } = await q(
        `SELECT code_module::text AS code
           FROM tenant_modules_actifs
          WHERE tenant_id = $1 AND est_actif = TRUE
            AND (expires_at IS NULL OR expires_at::date >= CURRENT_DATE)`, [imfId]);
      rows.forEach((r) => codes.add(r.code));
    } catch (e) {
      lectureTenantModules = false;
      console.error('[saas] tenant_modules_actifs illisible : ' + (e && e.message));
    }

    // Repli / coherence avec les abonnements historiques.
    try {
      const { rows } = await q(
        `SELECT s.module_key, s.is_active, s.is_trial, s.trial_end_date
           FROM institution_module_subscriptions s
          WHERE s.institution_id = $1`, [imfId]);
      for (const r of rows) {
        const essaiFini = r.is_trial && r.trial_end_date &&
          String(r.trial_end_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
        if (r.is_active === true && !essaiFini) {
          legacy.add(r.module_key);
          const code = MODULE_TO_CODE[r.module_key];
          if (code) codes.add(code);
        }
      }
    } catch (e) { /* table absente : on garde seulement tenant_modules_actifs */ }

    if (!lectureTenantModules || legacy.size === 0) {
      // Dernier repli : drapeaux de institution_features.
      try {
        const { rows } = await q(
          'SELECT * FROM institution_features WHERE institution_id = $1', [imfId]);
        if (rows.length) {
          for (const [key, def] of Object.entries(MODULES)) {
            if (rows[0][def.column] === true) {
              legacy.add(key);
              const code = MODULE_TO_CODE[key];
              if (code) codes.add(code);
            }
          }
        }
      } catch (e) { /* rien */ }
    }

    try{const {cmsAccess}=await import('./cms_engine.js');await cmsAccess(imfId);codes.add('COMMUNICATION_CMS');legacy.add('COMMUNICATION_CMS');}catch{codes.delete('COMMUNICATION_CMS');legacy.delete('COMMUNICATION_CMS');}
    const inactifs = Object.keys(CODE_TO_MODULE).filter((c) => !codes.has(c));
    return { codes: Array.from(codes), legacy: Array.from(legacy), inactifs };
  });
}

/** Module exige par un chemin d'API (code court) ou null. */
export function codeModulePourChemin(pathname) {
  // On ne compare QUE le premier segment du chemin : sinon « /creditation »
  // ou « /comptabilite-annexe » declencheraient a tort le module.
  const path = String(pathname || '').toLowerCase();
  if (!path.startsWith('/')) return null;
  const segment = path.split('?')[0].split('/')[1] || '';
  for (const [code, prefixes] of Object.entries(CODE_PREFIXES)) {
    if (prefixes.some((p) => segment === p.slice(1))) return code;
  }
  return null;
}

const METHODES_LECTURE = ['GET', 'HEAD', 'OPTIONS'];

/** Une requete est-elle une ecriture ? (POST/PUT/PATCH/DELETE) */
export function estEcriture(req) {
  const m = String(req.method || 'GET').toUpperCase();
  if (METHODES_LECTURE.includes(m)) return false;
  const brut = String(req.path || req.originalUrl || '').toLowerCase();
  const p = brut.split('?')[0];
  // VAGUE 47 : la console editeur et la connexion ne dependent pas du contrat
  // d'une IMF (l'editeur doivent pouvoir gerer les impayes, donc jamais bloque).
  const HORS_CONTRAT = ['/super-admin', '/auth', '/me', '/health'];
  if (HORS_CONTRAT.some((f) => p === f || p.startsWith(f + '/'))) return false;
  // Les exports/exports PDF et les lectures longues restent ouverts.
  if (/(\/export|\/exports|\/pdf|\.pdf$|\/csv$|\/etats?|\/balance|\/grand-livre)/.test(p)) return false;
  // Les routes « libre service » (connexion, mot de passe, 2FA, abonnement,
  // support) doivent rester utilisables : sinon l'IMF ne peut plus payer.
  const LIBRES = ['/auth', '/me', '/institution', '/saas', '/requests', '/support',
                 '/tickets', '/notifications', '/devices', '/keepalive', '/health'];
  if (LIBRES.some((f) => p === f || p.startsWith(f + '/'))) return false;
  // Fiches PDF / etats imprimes ET exports (y compris POST /reports/exports).
  if (/\/exports?\b/.test(p)) return false;
  return true;
}

/**
 * Garde SaaS GLOBALE, posee une seule fois sur /api/v1 (apres tenantContext).
 * Ordre des controles, du plus general au plus precis :
 *   1. compte resilie / essai fini         -> lecture seule (ou refus)
 *   2. module non souscrit                 -> 403 MODULE_NON_SOUSCRIT
 *   3. ecriture pendant une suspension     -> 403 LECTURE_SEULE
 * L'editeur (teebo_admin) n'est jamais soumis a ces controles.
 */
// CACHE COURT (60 s) — l'etat du contrat et la liste des modules etaient relus
// en base a CHAQUE requete (plusieurs requetes SQL par appel d'ecran, sur un
// serveur d'entree de gamme) : les ecrans paraissaient tres lents. Un cache
// memoire de 60 secondes par IMF supprime ces aller-retours sans retarder une
// decision de l'editeur (une modification reste visible en moins d'une minute).
const _cacheSaas = new Map();
function etatEtModules(imfId) {
  const now = Date.now();
  const hit = _cacheSaas.get(imfId);
  if (hit && now - hit.at < 60000) return Promise.resolve(hit.val);
  return Promise.all([etatTenant(imfId), modulesDuTenant(imfId)]).then((val) => {
    if (_cacheSaas.size > 500) _cacheSaas.clear();
    _cacheSaas.set(imfId, { at: Date.now(), val });
    return val;
  });
}

export function gardeSaas(req, res, next) {
  const u = req.user;
  if (!u) return next();                 // route publique : elle repondra d'elle-meme
  if (u.role === PLATFORM_ROLE) return next();
  const imfId = req.dbImfId || u.imf_id;
  if (!imfId) return next();

  const chemin = String(req.path || req.originalUrl || '').split('?')[0];

  etatEtModules(imfId)
    .then(([etat, modules]) => {
      // 1. Statut du compte.
      if (etat && etat.autorise === false && estEcriture(req)) {
        return res.status(403).json({
          error: 'COMPTE_RESILIE', code: 'COMPTE_RESILIE', statut: etat.statut,
          message: etat.message || 'Compte resilie : consultation seule.'
        });
      }

      // 2. Module souscrit ?
      const codeRequis = codeModulePourChemin(chemin);
      if (codeRequis && !modules.codes.includes(codeRequis)) {
        const libelle = codeRequis.replace(/_/g, ' ');
        return res.status(403).json({
          error: 'MODULE_NON_SOUSCRIT', code: 'MODULE_NON_SOUSCRIT',
          module: codeRequis, module_label: libelle,
          modules_actifs: modules.codes,
          message: 'Le module ' + libelle + " n'est pas souscrit par votre institution. "
            + 'Demandez son activation a l editeur teebo depuis la rubrique Abonnement.'
        });
      }

      // 3. Ecriture autorisee ?
      if (etat && etat.lecture_seule && estEcriture(req)) {
        return res.status(403).json({
          error: etat.motif || 'LECTURE_SEULE', code: etat.motif || 'LECTURE_SEULE',
          lecture_seule: true, statut: etat.statut,
          message: etat.message || "Votre espace est en lecture seule : la consultation et l'export restent disponibles."
        });
      }

      req.saas = { etat, modules };
      next();
    })
    .catch((e) => {
      // Jamais de blocage total sur un incident de lecture (continuite de service).
      console.error('[saas] garde ignoree : ' + (e && e.message));
      next();
    });
}

/** Middleware cible : requireModule('CREDIT') sur un routeur precis. */
export function requireModule(code) {
  const attendu = String(code || '').toUpperCase();
  return async (req, res, next) => {
    try {
      const u = req.user;
      if (!u || u.role === PLATFORM_ROLE) return next();
      const imfId = req.dbImfId || u.imf_id;
      if (!imfId) return res.status(400).json({ error: 'institution_manquante' });
      const modules = await modulesDuTenant(imfId);
      if (modules.codes.includes(attendu)) return next();
      return res.status(403).json({
        error: 'MODULE_NON_SOUSCRIT', code: 'MODULE_NON_SOUSCRIT',
        module: attendu, modules_actifs: modules.codes,
        message: 'Module ' + attendu.replace(/_/g, ' ') + ' non souscrit par votre institution.'
      });
    } catch (e) { next(e); }
  };
}

/** Bloc « mes acces » renvoye a la connexion (/auth/me) pour le menu du site. */
export async function accesUtilisateur(user) {
  if (!user) return null;
  if (String(user.role) === PLATFORM_ROLE) {
    return { modules_actifs: Object.keys(CODE_TO_MODULE),
             modules_inactifs: [], lecture_seule: false, statut_compte: 'EDITEUR',
             espace: 'super_admin' };
  }
  const [etat, modules] = await Promise.all([etatTenant(user.imf_id), modulesDuTenant(user.imf_id)]);
  return {
    espace: 'imf',
    modules_actifs: modules.codes,
    modules_inactifs: modules.inactifs,
    modules_legacy: modules.legacy,
    statut_compte: (etat && etat.statut) || null,
    lecture_seule: Boolean(etat && etat.lecture_seule),
    motif_restriction: (etat && etat.motif) || null,
    message_restriction: (etat && etat.message) || null,
    jours_essai_restants: etat && etat.jours_essai_restants != null ? etat.jours_essai_restants : null
  };
}

export const MODULES_SAAS = Object.freeze([
  { code: 'COLLECTE', nom: 'Collecte & Tontines' },
  { code: 'CREDIT', nom: 'Credit' },
  { code: 'COMPTABILITE', nom: 'Comptabilite' },
  { code: 'CONFORMITE', nom: 'Conformite (LCB-FT / BCEAO)' },
  { code: 'API_MOBILE_MONEY', nom: 'API Mobile Money' }
]);

export default {
  CODE_TO_MODULE, MODULE_TO_CODE, CODE_PREFIXES, MODULES_SAAS,
  joursDeGrace, filtreEcrire,
  etatTenant, evaluerTenant, modulesDuTenant, codeModulePourChemin,
  estEcriture, gardeSaas, requireModule, accesUtilisateur, invaliderCache
};
