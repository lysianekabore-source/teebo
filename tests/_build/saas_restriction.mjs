// =========================================================================
// teebo — RESTRICTION IMMÉDIATE « COLLECTE SEULE » (vague 36)
// =========================================================================
// Ce module porte la décision de l'administrateur teebo : une IMF en essai
// n'utilise QUE la collecte, les autres briques sont coupées SUR-LE-CHAMP.
//
// Trois garanties, dans cet ordre :
//   1. la BASE décide (fn_restrict_imf_to_collecte) : souscriptions coupées,
//      collecte maintenue en essai, audit écrit, menus recalés — le tout dans
//      UNE transaction (COMMIT global ou ROLLBACK automatique) ;
//   2. le MIDDLEWARE lit l'état à chaque requête (aucun cache) : la 403
//      « Feature Disabled » tombe dès la requête suivante ;
//   3. l'ÉCRAN reçoit une configuration recalculée : les menus disparaissent.
//
// Règle inchangée (vague 35) : un module ne bénéficie qu'UNE fois de l'essai
// gratuit. Une réactivation par l'IMF ne redonne donc jamais d'essai, sauf
// si le module n'a jamais été testé.
// =========================================================================
import { tx } from './db.mjs';
import { buildInstitutionConfig, MODULE_KEYS } from './modules.mjs';

export const MODULE_COLLECTE = 'MODULE_COLLECTE_TONTINE';

/** Erreur métier exposée telle quelle à la console (message français). */
function metier(message, code, status = 400) {
  const e = new Error(message);
  e.status = status; e.code = code; e.expose = true;
  return e;
}

/** Vrai pour un identifiant UUID valide. */
export function estUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/* ------------------------------------------------------------------------- */
/*  1. RESTREINDRE : collecte seule                                          */
/* ------------------------------------------------------------------------- */
/**
 * Restriction immédiate d'une IMF au module collecte (essai).
 * @param {string} imfId     identifiant de l'IMF visée
 * @param {object} actor     { id, role } de l'administrateur teebo
 * @param {string} raison    motif affiché dans l'audit
 * @returns {Promise<object>} compte rendu + configuration recalculée
 */
export async function restreindreCollecteSeule(imfId, actor = {}, raison = null) {
  if (!estUuid(imfId)) throw metier('Identifiant d’institution invalide.', 'imf_id_invalide');
  const motif = (raison && String(raison).slice(0, 500))
    || 'Essai : accès limité au module Collecte & tontines';

  // Verification PREALABLE, hors transaction : contrat de la fonction SQL
  // (table de restrictions + fonctions presentes). Si la migration n'est pas
  // passee, on renvoie un message clair au lieu d'une erreur technique.
  try {
    await tx(async (c) => c.query(
      'SELECT 1 FROM imf_access_restrictions LIMIT 1'));
  } catch (e) {
    throw metier('La table des restrictions n’existe pas encore : exécutez '
      + 'db/migration_restrict_essai.sql (en simulation d’abord) sur la base.',
      'migration_manquante', 409);
  }

  // Transaction unique : ou la restriction complète passe, ou rien n'est écrit.
  const resultat = await tx(async (c) => {
    const imf = (await c.query(
      `SELECT id, code_imf, name, status::text AS status,
              trial_started_at, trial_ends_at
         FROM imf WHERE id = $1 FOR UPDATE`, [imfId])).rows[0];
    if (!imf) throw metier('Institution introuvable.', 'imf_introuvable', 404);

    // La fonction SQL fait tout le travail « métier » (coupe, essai, audit).
    const out = (await c.query(
      'SELECT fn_restrict_imf_to_collecte($1,$2,$3,$4) AS r',
      [imfId, actor.id || null, actor.role || null, motif])).rows[0].r;

    // La vague 32 range les menus dans institution_features : on les recale
    // DANS la même transaction pour que l'écran bascule instantanément.
    await c.query(
      `INSERT INTO institution_features
         (institution_id, module_collecte_tontine, module_dossier_credit,
          module_compliance_kyc, module_comptabilite_avancee, updated_by)
       VALUES ($1, TRUE, FALSE, FALSE, FALSE, $2)
       ON CONFLICT (institution_id) DO UPDATE SET
         module_collecte_tontine     = TRUE,
         module_dossier_credit       = FALSE,
         module_compliance_kyc       = FALSE,
         module_comptabilite_avancee = FALSE,
         updated_by                  = COALESCE($2, institution_features.updated_by),
         updated_at                  = now()`, [imfId, actor.id || null]);

    return { imf, out };
  });

  // Hors transaction : lecture de ce que les clients verront (une seule requête).
  const etat = await lireEtatModules(imfId);
  const config = await buildInstitutionConfig(imfId);

  return {
    institution: {
      id: resultat.imf.id, code_imf: resultat.imf.code_imf,
      name: resultat.imf.name, status: resultat.imf.status
    },
    restriction: 'COLLECTE_ONLY',
    module_autorise: MODULE_COLLECTE,
    modules_coupes: resultat.out && resultat.out.modules_coupes != null
      ? Number(resultat.out.modules_coupes) : 0,
    applique_le: new Date().toISOString(),
    modules: etat,
    configuration_ui: config,
    message: 'Accès restrictif appliqué : seule la Collecte & tontines reste disponible '
      + '(en essai). Les autres modules répondent désormais 403 « Feature Disabled ».'
  };
}

/* ------------------------------------------------------------------------- */
/*  2. LEVER LA RESTRICTION                                                  */
/* ------------------------------------------------------------------------- */
export async function leverRestriction(imfId, actor = {}, raison = null) {
  if (!estUuid(imfId)) throw metier('Identifiant d’institution invalide.', 'imf_id_invalide');
  const motif = (raison && String(raison).slice(0, 500)) || 'Restriction levée par teebo';
  const out = await tx(async (c) => {
    const r = (await c.query(
      'SELECT fn_lift_imf_restriction($1,$2,$3) AS r',
      [imfId, actor.id || null, motif])).rows[0].r;
    // Les menus sont recalculés à partir des souscriptions réellement actives.
    const actifs = (await c.query(
      `SELECT module_key FROM institution_module_subscriptions
        WHERE institution_id=$1 AND is_active = TRUE`, [imfId])).rows.map((x) => x.module_key);
    const col = {
      MODULE_COLLECTE_TONTINE: 'module_collecte_tontine',
      MODULE_DOSSIER_CREDIT: 'module_dossier_credit',
      MODULE_COMPLIANCE_KYC: 'module_compliance_kyc',
      MODULE_COMPTABILITE_AVANCEE: 'module_comptabilite_avancee'
    };
    // On ecrit la ligne de menus (creation si elle n'existe pas encore :
    // une IMF restreinte avant la vague 32 n'en avait aucune, et un UPDATE
    // seul n'aurait rien fait, d'ou lever() inoperant).
    await c.query(
      `INSERT INTO institution_features (institution_id) VALUES ($1)
       ON CONFLICT (institution_id) DO NOTHING`, [imfId]);
    await c.query(
      `UPDATE institution_features SET
         module_collecte_tontine     = $2,
         module_dossier_credit       = $3,
         module_compliance_kyc       = $4,
         module_comptabilite_avancee = $5,
         updated_by = COALESCE($6, updated_by),
         updated_at = now()
       WHERE institution_id = $1`,
      [imfId,
        actifs.includes('MODULE_COLLECTE_TONTINE'),
        actifs.includes('MODULE_DOSSIER_CREDIT'),
        actifs.includes('MODULE_COMPLIANCE_KYC'),
        actifs.includes('MODULE_COMPTABILITE_AVANCEE'),
        actor.id || null]);
    return r;
  });
  return { ...out, configuration_ui: await buildInstitutionConfig(imfId) };
}

/* ------------------------------------------------------------------------- */
/*  3. LECTURE D'ÉTAT (middleware + écran)                                   */
/* ------------------------------------------------------------------------- */
/**
 * État réel des modules d'une IMF, lu à la volée (aucun cache).
 * `utilisable` tient compte de l'activation ET de la fin éventuelle d'essai.
 */
export async function lireEtatModules(imfId) {
  const { rows } = await tx(async (c) => c.query(
    `SELECT module_key, is_active, is_trial, trial_end_date,
            deactivated_reason, restriction_code,
            (is_active AND NOT (is_trial AND trial_end_date IS NOT NULL
                                AND trial_end_date < CURRENT_DATE)) AS is_usable
       FROM institution_module_subscriptions
      WHERE institution_id = $1
      ORDER BY module_key`, [imfId]));
  return rows.map((r) => ({
    module_key: r.module_key,
    actif: r.is_active === true,
    essai: r.is_trial === true,
    fin_essai: r.trial_end_date ? String(r.trial_end_date).slice(0, 10) : null,
    utilisable: r.is_usable === true,
    motif_coupure: r.deactivated_reason || null
  }));
}

/** Vrai si l'IMF est actuellement en restriction collecte seule. */
export async function estRestreinteCollecteSeule(imfId) {
  const { rows } = await tx(async (c) => c.query(
    `SELECT 1 FROM imf_access_restrictions
      WHERE institution_id = $1 AND is_active = TRUE LIMIT 1`, [imfId]));
  return rows.length > 0;
}

/**
 * État de tous les modules tel que le verra le middleware :
 * { MODULE_X: true|false } — prêt pour une vérification immédiate.
 */
export async function droitsUtilisables(imfId) {
  const etat = await lireEtatModules(imfId);
  const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, false]));
  for (const m of etat) if (m.utilisable) out[m.module_key] = true;
  return out;
}

/* ------------------------------------------------------------------------- */
/*  4. RÉACTIVATION APRÈS RESTRICTION (droit d'upgrade)                      */
/* ------------------------------------------------------------------------- */
/**
 * Réactive un module même si l'IMF est restreinte (l'upgrade est toujours
 * possible), et accorde AUTOMATIQUEMENT 30 jours d'essai si ce module n'a
 * JAMAIS été testé par cette IMF.
 *
 * @param {string} imfId
 * @param {string} moduleKey
 * @param {object} p { demander_essai?: boolean, trial_end_date?: string }
 * @param {object} actor { id, role }
 */
export async function reactiverModule(imfId, moduleKey, p = {}, actor = {}) {
  if (!estUuid(imfId)) throw metier('Identifiant d’institution invalide.', 'imf_id_invalide');
  if (!MODULE_KEYS.includes(moduleKey)) {
    throw metier('Module inconnu : ' + moduleKey, 'module_inconnu', 400);
  }

  return tx(async (c) => {
    const ligne = (await c.query(
      `SELECT * FROM institution_module_subscriptions
        WHERE institution_id=$1 AND module_key=$2 FOR UPDATE`, [imfId, moduleKey])).rows[0];

    // L'essai a-t-il déjà été consommé ? (colonne v35 trial_used, ou trace
    // d'une ligne de facture « essai gratuit »).
    let essaiDejaUtilise = !!(ligne && (ligne.trial_used === true
      || (ligne.trial_started_at && ligne.trial_end_date)));
    if (!essaiDejaUtilise) {
      essaiDejaUtilise = (await c.query(
        `SELECT EXISTS (SELECT 1 FROM saas_invoice_lines
                          WHERE institution_id=$1 AND module_key=$2
                            AND (statut_ligne='essai_gratuit' OR trial_end_date IS NOT NULL)) AS d`,
        [imfId, moduleKey])).rows[0].d === true;
    }

    // ESSAI DÉJÀ UTILISÉ = jamais de second essai. On s'appuie d'abord sur la
    // colonne trial_used, puis sur la simple existence d'un essai soldé
    // (is_trial FALSE après avoir été en essai), marquée par trial_used.
    const veutEssai = !essaiDejaUtilise;
    const finEssai = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    if (!essaiDejaUtilise && veutEssai) {
      // 30 jours d'essai AUTOMATIQUES : le module n'a jamais été testé.
      await c.query(
        `INSERT INTO institution_module_subscriptions
           (institution_id, module_key, is_active, activated_at, is_trial,
            trial_end_date, created_by, deactivated_reason, restriction_code)
         VALUES ($1,$2,TRUE,CURRENT_DATE,TRUE,$3,$4,NULL,NULL)
         ON CONFLICT (institution_id, module_key) DO UPDATE SET
           is_active          = TRUE,
           activated_at       = CASE WHEN institution_module_subscriptions.is_active = FALSE
                                     THEN CURRENT_DATE
                                     ELSE institution_module_subscriptions.activated_at END,
           is_trial           = TRUE,
           trial_end_date     = COALESCE(institution_module_subscriptions.trial_end_date, $3),
           trial_started_at   = COALESCE(institution_module_subscriptions.trial_started_at, CURRENT_DATE),
           deactivated_at     = NULL,
           deactivated_reason = NULL,
           restricted_at      = NULL,
           restriction_code   = NULL,
           updated_at         = now()`,
        [imfId, moduleKey, finEssai, actor.id || null]);
    } else {
      // Essai déjà utilisé : réactivation PAYANTE (règle de la vague 35).
      await c.query(
        `INSERT INTO institution_module_subscriptions
           (institution_id, module_key, is_active, activated_at, is_trial,
            trial_end_date, created_by, deactivated_reason, restriction_code)
         VALUES ($1,$2,TRUE,CURRENT_DATE,FALSE,NULL,$3,NULL,NULL)
         ON CONFLICT (institution_id, module_key) DO UPDATE SET
           is_active          = TRUE,
           activated_at       = CASE WHEN institution_module_subscriptions.is_active = FALSE
                                     THEN CURRENT_DATE
                                     ELSE institution_module_subscriptions.activated_at END,
           is_trial           = FALSE,
           trial_end_date     = NULL,
           deactivated_at     = NULL,
           deactivated_reason = NULL,
           restricted_at      = NULL,
           restriction_code   = NULL,
           updated_at         = now()`,
        [imfId, moduleKey, actor.id || null]);
    }

    // Le module redevient visible dans institution_features. On cree la ligne
    // si elle manque, sinon l'INSERT ... ON CONFLICT ne changerait rien.
    const col = {
      MODULE_COLLECTE_TONTINE: 'module_collecte_tontine',
      MODULE_DOSSIER_CREDIT: 'module_dossier_credit',
      MODULE_COMPLIANCE_KYC: 'module_compliance_kyc',
      MODULE_COMPTABILITE_AVANCEE: 'module_comptabilite_avancee'
    }[moduleKey];
    if (col) {
      await c.query(
        `INSERT INTO institution_features (institution_id) VALUES ($1)
         ON CONFLICT (institution_id) DO NOTHING`, [imfId]);
      await c.query(
        `INSERT INTO institution_features (institution_id, ${col}, updated_by)
         VALUES ($1, TRUE, $2)
         ON CONFLICT (institution_id) DO UPDATE SET
           ${col} = TRUE, updated_by = COALESCE($2, institution_features.updated_by),
           updated_at = now()`, [imfId, actor.id || null]);
    }

    // Trace : la restriction ne disparaît pas, on note seulement l'upgrade.
    await c.query(
      `INSERT INTO audit_log (imf_id, actor_id, action, entity, entity_id, payload)
       VALUES ($1,$2,'IMF_MODULE_REACTIVATED','institution_module_subscriptions',$3,$4::jsonb)`,
      [imfId, actor.id || null, moduleKey,
        JSON.stringify({ module: moduleKey, essai_accorde: !essaiDejaUtilise,
          fin_essai: essaiDejaUtilise ? null : finEssai,
          acteur_role: actor.role || null })]);

    const apres = (await c.query(
      `SELECT is_active, is_trial, trial_end_date, activated_at
         FROM institution_module_subscriptions
        WHERE institution_id=$1 AND module_key=$2`, [imfId, moduleKey])).rows[0];

    // Garde-fou : si la relecture ne renvoie rien (base inattendue), on renvoie
    // l'etat que l'on vient d'ecrire plutot que de planter la reponse.
    const etatFinal = apres || {
      is_active: true,
      is_trial: !essaiDejaUtilise,
      trial_end_date: essaiDejaUtilise ? null : finEssai
    };

    return {
      module_key: moduleKey,
      actif: etatFinal.is_active === true,
      essai: etatFinal.is_trial === true,
      fin_essai: etatFinal.trial_end_date ? String(etatFinal.trial_end_date).slice(0, 10) : null,
      essai_accorde: !essaiDejaUtilise,
      message: !essaiDejaUtilise
        ? 'Module réactivé avec 30 jours d’essai gratuit (premier essai de ce module).'
        : 'Module réactivé en formule payante : son essai gratuit a déjà été utilisé.'
    };
  });
}

export default {
  MODULE_COLLECTE, estUuid, restreindreCollecteSeule, leverRestriction,
  lireEtatModules, estRestreinteCollecteSeule, droitsUtilisables, reactiverModule
};
