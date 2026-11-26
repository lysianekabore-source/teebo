// =========================================================================
// teebo — ACTIVATION MODULAIRE (feature flipping par institution)
// =========================================================================
// Chaque IMF souscrit à des MODULES. Un module désactivé :
//   1. n'apparaît PAS dans son menu (route /api/v1/institution/config) ;
//   2. renvoie 403 « Feature Disabled » sur son API (middleware global).
//
// Le contrôle est fait CÔTÉ SERVEUR : masquer un menu ne protège rien, un
// utilisateur pourrait appeler l'URL directement. Les deux vont ensemble.
//
// Catalogue (clés stables, partagées avec institution_features) :
//   MODULE_COLLECTE_TONTINE      Collecte terrain / tontines
//   MODULE_DOSSIER_CREDIT        Dossiers de crédit (5C, échéanciers)
//   MODULE_COMPLIANCE_KYC        Conformité BCEAO / LCB-FT / KYC
//   MODULE_COMPTABILITE_AVANCEE  Comptabilité (grand livre, états BCEAO)
// =========================================================================
import { q } from './db.js';

/** Catalogue des modules : clé -> { colonne, libellé, préfixes d'URL, menus }. */
export const MODULES = Object.freeze({
  SECRETARIAT_DIRECTION:{column:null,label:'Secrétariat de Direction & Gouvernance',description:'Courriers, instances, résolutions, notes et agenda.',prefixes:['/secretariat'],menus:['secretariat']},
  COMMUNICATION_CMS: {column:'communication_cms',label:'Communication & Médias',description:'Studio multimédia et actualités client.',prefixes:['/cms','/cms-leads'],menus:['communication-cms']},
  MODULE_COLLECTE_TONTINE: {
    column: 'module_collecte_tontine',
    label: 'Collecte & tontines',
    description: 'Tournées de collecte, dépôts, versements, reçus et tontines.',
    prefixes: ['/operations', '/collecte', '/round', '/tontine', '/receipts',
               '/collecteurs', '/clients/collecte'],
    menus: ['tournee', 'collecte', 'versements', 'tontines', 'clients']
  },
  MODULE_DOSSIER_CREDIT: {
    column: 'module_dossier_credit',
    label: 'Dossiers de crédit',
    description: 'Demandes, analyse 5C, comité, décaissement et échéanciers.',
    prefixes: ['/credit', '/credits', '/dossiers-credit', '/echeances'],
    menus: ['credit', 'dossiers', 'comite', 'recouvrement']
  },
  MODULE_COMPLIANCE_KYC: {
    column: 'module_compliance_kyc',
    label: 'Conformité & KYC (LCB-FT)',
    description: 'Validation KYC, PPE, listes de sanctions, gel et déclarations.',
    prefixes: ['/compliance', '/kyc', '/conformite', '/sanctions', '/freeze'],
    menus: ['conformite', 'kyc', 'sanctions', 'declarations']
  },
  MODULE_COMPTABILITE_AVANCEE: {
    column: 'module_comptabilite_avancee',
    label: 'Comptabilité avancée',
    description: 'Grand livre immuable, journaux, balance et états BCEAO.',
    prefixes: ['/comptabilite', '/ledger', '/accounting', '/journaux'],
    menus: ['comptabilite', 'grand-livre', 'balance', 'etats-bceao']
  }
});

/** Liste des clés connues (validation des entrées). */
export const MODULE_KEYS = Object.freeze(Object.keys(MODULES));

/**
 * Lecture des modules d'une IMF. Crée la ligne par défaut si absente
 * (aucune erreur possible sur une IMF créée après la migration).
 */
export async function getFeatures(imfId) {
  const { rows } = await q(
    'SELECT * FROM institution_features WHERE institution_id=$1', [imfId]);
  if (rows.length) return rows[0];
  const ins = await q(
    `INSERT INTO institution_features (institution_id) VALUES ($1)
     ON CONFLICT (institution_id) DO UPDATE SET updated_at=now() RETURNING *`, [imfId]);
  return ins.rows[0];
}

/**
 * Vrai si le module est actif pour l'IMF.
 */
export async function isModuleActive(imfId, moduleKey) {
  if(moduleKey==='SECRETARIAT_DIRECTION')return (await verifierModule(imfId,moduleKey)).utilisable;
  const def = MODULES[moduleKey];
  if (!def) return false;
  const f = await getFeatures(imfId);
  return f[def.column] === true;
}

/**
 * Middleware GLOBAL : refuse l'accès à un module non souscrit.
 * À placer APRÈS authenticate et tenantContext, AVANT les routeurs.
 *
 * Tolérance volontaire : si la table n'existe pas encore (migration en cours)
 * ou si l'IMF est introuvable, on LAISSE PASSER (fail-open) pour ne jamais
 * casser un service en production ; l'erreur est journalisée.
 */
export function checkModuleActivation(req, res, next) {
  const p = String(req.path || '').toLowerCase();
  const key = REQUIRED_MODULE_FOR_PATH(p);
  if (!key) return next();

  const imfId = req.dbImfId || (req.user && req.user.imf_id) || null;
  if (!imfId) return next();                        // non authentifié : la route répondra 401

  // VAGUE 36 : la vérité vient des SOUSCRIPTIONS (is_active + fin d'essai),
  // pas d'un cache. Une restriction appliquée à l'instant coupe donc la
  // requête SUIVANTE. institution_features sert seulement de repli pour les
  // IMF antérieures à la vague 32 (aucune ligne de souscription).
  verifierModule(imfId, key)
    .then((verdict) => {
      if (verdict.utilisable) return next();
      return res.status(403).json({
        error: 'feature_disabled',
        code: 'FEATURE_DISABLED',
        module: key,
        module_label: (MODULES[key] && MODULES[key].label) || key,
        motif: verdict.motif || null,
        message: 'Feature Disabled — le module ' + ((MODULES[key] && MODULES[key].label) || key)
          + ' n’est pas actif pour votre institution.'
          + (verdict.motif === 'RESTRICTION_COLLECTE_ONLY'
            ? ' Votre accès est limité à la Collecte & tontines pendant l’essai.'
            : verdict.motif === 'ESSAI_EXPIRE'
              ? ' Votre période d’essai est terminée : vous pouvez activer ce module depuis Abonnement.'
              : ' Contactez l’administrateur de votre IMF ou activez-le depuis Abonnement.')
      });
    })
    .catch((e) => {
      // Fail-open : ne jamais bloquer la production sur un incident de lecture.
      console.error('[modules] vérification ignorée : ' + (e && e.message));
      next();
    });
}

/**
 * Décision d'accès à un module, relue à chaque requête (aucun cache).
 * @returns {Promise<{utilisable:boolean, motif:string|null}>}
 */
// CACHE COURT (30 s) : cette verification etait faite en base a CHAQUE requete,
// en plus de la garde SaaS, ce qui multipliait les aller-retours SQL et rendait
// les ecrans lents. Une restriction reste appliquee en moins de 30 secondes.
const _cacheModule = new Map();
export async function verifierModule(imfId, moduleKey) {
  if(moduleKey==='SECRETARIAT_DIRECTION'){try{const {secAccess}=await import('./secretariat_engine.js');await secAccess(imfId);return {utilisable:true,motif:null};}catch{return {utilisable:false,motif:'MODULE_INACTIF'};}}
  if(moduleKey==='COMMUNICATION_CMS'){const {cmsAccess}=await import('./cms_engine.js');try{await cmsAccess(imfId);return {utilisable:true,motif:null};}catch{return {utilisable:false,motif:'MODULE_INACTIF'};}}
  const def = MODULES[moduleKey];
  if (!def) return { utilisable: false, motif: 'MODULE_INCONNU' };

  const cleCache = String(imfId) + '|' + moduleKey;
  const hit = _cacheModule.get(cleCache);
  if (hit && Date.now() - hit.at < 30000) return hit.val;

  try {
    const { rows } = await q(
      `SELECT is_active, is_trial, trial_end_date, deactivated_reason, restriction_code
         FROM institution_module_subscriptions
        WHERE institution_id = $1 AND module_key = $2`, [imfId, moduleKey]);

    if (rows.length) {
      const r = rows[0];
      if (r.is_active !== true) {
        return { utilisable: false,
          motif: r.restriction_code || r.deactivated_reason || 'MODULE_INACTIF' };
      }
      // Essai terminé : le module ne donne plus accès jusqu'à activation payante.
      if (r.is_trial === true && r.trial_end_date) {
        const fin = String(r.trial_end_date).slice(0, 10);
        const auj = new Date().toISOString().slice(0, 10);
        if (fin < auj) return { utilisable: false, motif: 'ESSAI_EXPIRE' };
      }
      const val = { utilisable: true, motif: null };
      if (_cacheModule.size > 500) _cacheModule.clear();
      _cacheModule.set(cleCache, { at: Date.now(), val });
      return val;
    }
  } catch (e) {
    // Table absente (base pas encore migrée) : on retombe sur institution_features.
    console.error('[modules] souscriptions illisibles : ' + (e && e.message));
  }

  // Repli : drapeau historique de institution_features.
  const f = await getFeatures(imfId);
  return { utilisable: f[def.column] === true, motif: null };
}

/**
 * Détermine le module exigé par un chemin d'API (ou null si libre).
 * Les routes transverses (auth, institution, clients, paramètres) restent
 * accessibles même module coupé : sinon l'IMF ne pourrait plus se connecter.
 */
export function REQUIRED_MODULE_FOR_PATH(pathname) {
  const path = String(pathname || '').toLowerCase();
  if (!path.startsWith('/')) return null;
  const FREE = ['/auth', '/institution', '/settings', '/me', '/devices', '/saas',
                '/notifications', '/requests', '/teebo', '/super-admin', '/health', '/ready'];
  // /saas : abonnement et factures — doivent rester accessibles même si un
  // module est coupé, sinon l'IMF ne pourrait plus le réactiver.
  if (FREE.some((f) => path === f || path.startsWith(f + '/'))) return null;
  for (const [key, def] of Object.entries(MODULES)) {
    if (def.prefixes.some((pre) => path === pre || path.startsWith(pre + '/'))) return key;
  }
  return null;
}

/**
 * Configuration exposée à l'UI : uniquement ce à quoi l'IMF a droit.
 */
export async function buildInstitutionConfig(imfId, user = null) {
  const f = await getFeatures(imfId);
  const imf = (await q(
    'SELECT id, code_imf, name, type, country_code, city, status FROM imf WHERE id=$1',
    [imfId])).rows[0] || null;

  const modules = {};
  const menus = [];
  for (const [key, def] of Object.entries(MODULES)) {
    const active = ['COMMUNICATION_CMS','SECRETARIAT_DIRECTION'].includes(key)?(await verifierModule(imfId,key)).utilisable:f[def.column] === true;
    modules[key] = { key, label: def.label, description: def.description, active };
    if (active) menus.push({ module: key, items: def.menus });
  }

  return {
    institution: imf && {
      id: imf.id, code: imf.code_imf, name: imf.name, type: imf.type,
      country_code: imf.country_code, city: imf.city, status: imf.status
    },
    // Forme « booléens » (pratique pour un if dans le front) :
    features: Object.fromEntries(Object.keys(MODULES).map((k) => [k, modules[k].active])),
    // Forme « détaillée » (libellés + drapeaux, pour l'écran d'administration) :
    modules,
    // Menus à afficher, calculés côté serveur : rien d'autre ne doit être rendu.
    menus,
    // Options fines libres (réglages par module).
    options: f.options || {},
    // Rôle courant, utile à l'UI (l'autorisation réelle reste serveur).
    user: user ? { id: user.id, role: user.role, full_name: user.full_name } : null,
    updated_at: f.updated_at
  };
}

/** Met à jour les modules d'une IMF (réservé à l'admin IMF / éditeur). */
export async function updateFeatures(imfId, changes = {}, actorId = null) {
  await getFeatures(imfId);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, value] of Object.entries(changes || {})) {
    const def = MODULES[key];
    if (!def) continue;
    if(key==='SECRETARIAT_DIRECTION'){throw Object.assign(new Error('Activez ce module via le catalogue SaaS.'),{status:403,expose:true});}
    sets.push(`${def.column} = $${i++}`);
    vals.push(value === true);
  }
  if (changes && changes.options && typeof changes.options === 'object') {
    sets.push(`options = COALESCE(options,'{}'::jsonb) || $${i++}::jsonb`);
    vals.push(JSON.stringify(changes.options));
  }
  if (!sets.length) return getFeatures(imfId);
  sets.push('updated_by = $' + i++);
  vals.push(actorId);
  sets.push('updated_at = now()');
  vals.push(imfId);
  const { rows } = await q(
    `UPDATE institution_features SET ${sets.join(', ')} WHERE institution_id = $${i} RETURNING *`, vals);
  return rows[0];
}

export default {
  MODULES, MODULE_KEYS, getFeatures, isModuleActive,
  checkModuleActivation, verifierModule, buildInstitutionConfig, updateFeatures,
  REQUIRED_MODULE_FOR_PATH
};
