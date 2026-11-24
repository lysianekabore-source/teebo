// =========================================================================
// teebo — VAGUES 44 + 45 : BASCULE AUTOMATIQUE DES IMF EN ESSAI
// =========================================================================
// RÈGLE (précisée par la vague 45) :
//   SEULES les IMF qui étaient DÉJÀ EN ESSAI AVANT le déploiement basculent sur
//   le seul module Collecte & tontines. Celles qui s'inscrivent APRÈS gardent
//   l'essai normal (module par module, tels qu'elles les ont choisis).
//   La frontière (« avant / après ») est une date posée une seule fois en base
//   (fonction fn_reference_bascule_essai) : elle ne bouge plus jamais.
//   La règle elle-même est écrite en base (db/schema_v44.sql puis
//   db/schema_v45.sql) ; ce module JS ne fait que la DÉCLENCHER au bon moment :
//
//   • après une connexion réussie (mot de passe + 2FA validés),
//   • après l'activation du compte par le code d'accès,
//   • à la validation d'un défi 2FA,
//   • au démarrage du serveur (rattrapage des IMF passées en essai AVANT le
//     déploiement ; les inscriptions postérieures ne sont jamais visées).
//
// GARANTIES :
//   1. IDEMPOTENT — dix connexions de suite ne créent ni doublon ni audit.
//   2. NON BLOQUANT — un incident ne fait JAMAIS échouer une connexion : on
//      journalise et on continue. L'utilisateur entre normalement.
//   3. NON DESTRUCTIF — aucune souscription supprimée : les autres modules
//      sont coupés (date + motif), donc réactivables en un clic après paiement.
//   4. SANS DOUBLON — la fonction SQL s'appuie sur la clé unique
//      (institution_id, module_key) : deux connexions simultanées de la même
//      IMF aboutissent au même état, jamais à deux lignes.
// =========================================================================
import { q } from './db.js';

export const ORIGINES = Object.freeze(['LOGIN', 'ACTIVATION', '2FA', 'DEMARRAGE', 'MANUEL']);

export const MODULE_COLLECTE_TONTINE = 'MODULE_COLLECTE_TONTINE';

/**
 * Applique la règle pour une IMF. Ne jette jamais : renvoie un compte rendu.
 * @param {string|null} imfId
 * @param {object} opts { par?: uuid, origine?: string }
 * @returns {Promise<{ok:boolean, applique?:boolean, deja?:boolean,
 *                    essai_collecte?:boolean, modules_coupes?:number, motif?:string}>}
 */
export async function appliquerEssaiCollecte(imfId, opts = {}) {
  if (!imfId) return { ok: false, motif: 'imf_absente' };
  const origine = ORIGINES.includes(opts.origine) ? opts.origine : 'LOGIN';
  try {
    const { rows } = await q(
      'SELECT fn_appliquer_essai_collecte($1,$2,$3) AS r',
      [imfId, opts.par || null, origine]
    );
    const r = (rows[0] && rows[0].r) || {};
    // VAGUE 45 : une IMF inscrite après le déploiement n'est pas basculée.
    // C'est NORMAL, pas une erreur : on ne journalise rien d'alarmant.
    if (r.motif === 'essai_posterieur_au_deploiement') {
      return { ok: true, ...r, origine };
    }
    if (r.applique && !r.deja) {
      console.log('[essai] IMF ' + imfId + ' basculée sur Collecte & tontines (origine '
        + origine + ', ' + (r.modules_coupes || 0) + ' module(s) coupé(s))');
    }
    return { ok: true, ...r, origine };
  } catch (e) {
    // Migration non encore passée, base momentanément indisponible… : on
    // n'empêche surtout pas la connexion. Le rattrapage au démarrage suivant
    // (ou la prochaine connexion) appliquera la règle.
    console.error('[essai] bascule ignorée (' + (e && (e.code || e.message)) + ')');
    return { ok: false, motif: (e && e.code) || 'erreur', message: e && e.message };
  }
}

/**
 * Variante « une seule fois par démarrage » pour le rattrapage global.
 * Traite TOUTES les IMF dont le statut est « trial » en une passe, chaque IMF
 * isolée : un échec sur l'une n'empêche pas les autres.
 */
export async function rattraperEssaisAuDemarrage() {
  try {
    await q('SELECT 1 FROM imf LIMIT 1');
  } catch (e) {
    console.log('[essai] rattrapage différé : base non joignable (' + (e && (e.code || e.message)) + ')');
    return { ok: false, motif: 'base_indisponible' };
  }
  // CORRECTIF 51 : on ne tente le rattrapage que si les fonctions SQL sont
  // bien presentes (sinon PostgreSQL repond 42883 et l'ecran /ready signalait
  // une « erreur » alors que rien n'etait casse).
  try {
    const { rows: pre } = await q(
      `SELECT to_regprocedure('public.fn_basculer_imfs_en_essai(uuid)') IS NOT NULL AS ok,
              to_regprocedure('public.fn_reference_bascule_essai()') IS NOT NULL AS ref`);
    if (!pre[0] || !pre[0].ok || !pre[0].ref) {
      console.log('[essai] rattrapage differe : fonctions SQL de la vague 45 absentes (migration a finir).');
      return { ok: false, motif: 'fonctions_absentes' };
    }
  } catch (e) {
    return { ok: false, motif: (e && e.code) || 'erreur' };
  }
  try {
    // La fonction SQL itère et isole chaque IMF (voir schema_v44.sql).
    const { rows } = await q('SELECT fn_basculer_imfs_en_essai(NULL) AS r');
    const r = (rows[0] && rows[0].r) || {};
    console.log('[essai] rattrapage au démarrage : ' + (r.imfs_traitees || 0)
      + ' IMF en essai antérieure(s) au déploiement traitée(s), ' + (r.modules_coupes || 0)
      + ' module(s) coupé(s). Les IMF inscrites après le déploiement ne sont pas concernées.');
    return { ok: true, ...r };
  } catch (e) {
    console.error('[essai] rattrapage impossible (' + (e && (e.code || e.message)) + ')');
    return { ok: false, motif: (e && e.code) || 'erreur' };
  }
}

/**
 * Lecture seule : IMF en essai ANTÉRIEURES au déploiement qui ne sont pas encore
 * sur Collecte seule. Sert au contrôle après déploiement (l'écran teebo peut
 * l'afficher). Les IMF inscrites après le déploiement n'y figurent pas.
 */
export async function imfsEssaiABasculer(limite = 200) {
  const { rows } = await q(
    `SELECT id, code_imf, name, statut_imf, trial_ends_at, modules_ouverts, modules_actifs
       FROM v_imfs_essai_a_basculer
      ORDER BY code_imf
      LIMIT $1`, [limite]);
  return rows;
}

export default { appliquerEssaiCollecte, rattraperEssaisAuDemarrage, imfsEssaiABasculer };
