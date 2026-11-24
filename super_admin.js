// ===========================================================================
// teebo — VAGUE 47 : SUPER-ADMIN SAAS (souverainete des donnees)
// ---------------------------------------------------------------------------
// Le role SUPER_ADMIN_SAAS (enregistre dans app_user.role sous la valeur
// 'teebo_admin') administre la PLATEFORME : qui a le droit d'utiliser quoi,
// combien cela coute, et si c'est paye.
//
// REGLE ABSOLUE — aucune donnee financiere d'adherent n'est accessible :
//   pas de client, pas de solde d'epargne, pas de dossier de credit, pas de
//   declaration CENTIF, pas de piece comptable detailee. L'editeur ne voit
//   que des METADONNEES TECHNIQUES :
//     - nombre de comptes (par institution, par role, actifs/inactifs) ;
//     - volumes GLOBAUX et anonymises (nombre d'operations, montant total) ;
//     - etat des synchronisations terrain ;
//     - facturation, revenus recurrents (MRR/ARR).
//
// Ce fichier ne contient donc QUE des requetes COUNT / SUM agregees. Toute
// lecture de ligne nominative est interdite par conception (et par la regle
// de revue : interdiction_liste_donnees ci-dessous documente le perimetre).
// ===========================================================================
import { q } from './db.js';

export const ROLE_EDITEUR = 'teebo_admin';
export const ROLE_EDITEUR_LABEL = 'SUPER_ADMIN_SAAS';

/**
 * Perimetre documente, verifie automatiquement par les tests.
 * "autorise" : seulement des agregats techniques.
 * "interdit" : jamais de lecture, ni par API, ni par vue.
 */
export const PERIMETRE_EDITEUR = Object.freeze({
  autorise: [
    'metadata.tenants', 'metadata.utilisateurs_compte', 'metadata.volumes_agreges',
    'metadata.synchronisations', 'metadata.facturation', 'metadata.mrr_arr',
    'metadata.consommation_stockage'
  ],
  interdit: [
    'client', 'compte_epargne', 'solde', 'dossier_credit', 'echeancier',
    'remboursement', 'declaration_centif', 'operation_nominative',
    'piece_comptable', 'kyc_dossier'
  ],
  tables_interdites: [
    'client', 'account', 'account_movement', 'credit_file', 'client_schedule',
    'echeanciers_credit', 'remboursements_credit', 'dossiers_credit',
    'declaration_centif', 'declarations_centif', 'ledger_entry', 'ledger_line',
    'kyc_validation', 'freeze_list_hit'
  ]
});

/**
 * Statistiques publiees sur chaque IMF : exclusivement des nombres.
 * Aucune jointure vers une table de donnees clients : on ne lit que des
 * compteurs. `utilisateurs_actifs` = comptes actifs ayant une session ouverte
 * dans les 30 derniers jours (indicateur de dimensionnement).
 */
export async function statistiquesTenant(imfId) {
  const { rows } = await q(
    `SELECT
       (SELECT count(*) FROM app_user u WHERE u.imf_id=$1 AND u.role <> 'teebo_admin')          AS utilisateurs,
       (SELECT count(*) FROM app_user u WHERE u.imf_id=$1 AND u.role <> 'teebo_admin'
           AND u.is_active = TRUE)                                                                 AS utilisateurs_actifs,
       (SELECT count(DISTINCT s.user_id) FROM session s
          WHERE s.imf_id=$1 AND s.last_seen_at > now() - interval '30 days')                       AS utilisateurs_recent,
       (SELECT count(*) FROM session s WHERE s.imf_id=$1 AND s.revoked = FALSE
           AND s.expires_at > now())                                                               AS sessions_ouvertes,
       (SELECT count(*) FROM app_user u WHERE u.imf_id=$1 AND u.password_hash IS NULL)              AS comptes_sans_mdp`,
    [imfId]);
  return rows[0] || {};
}

/**
 * Volumes GLOBAUX et anonymises par institution : nombre d'operations et
 * montant total, jamais de detail par adherent. Sert au dimensionnement
 * serveur (le cahier des charges l'autorise explicitement).
 * Les tables absentes sont ignorees silencieusement.
 */
export async function volumesTenant(imfId) {
  const resultat = { operations: null, montant_total_xof: null, sources: [] };
  const essais = [
    { nom: 'operations',
      sql: `SELECT count(*)::bigint AS n, COALESCE(sum(amount_cents),0)::bigint AS m
              FROM operation WHERE imf_id=$1` },
    { nom: 'account_movement',
      sql: `SELECT count(*)::bigint AS n, COALESCE(sum(amount_cents),0)::bigint AS m
              FROM account_movement WHERE imf_id=$1` }
  ];
  let n = 0;
  let m = 0;
  for (const e of essais) {
    try {
      const { rows } = await q(e.sql, [imfId]);
      n += Number(rows[0].n || 0);
      m += Number(rows[0].m || 0);
      resultat.sources.push(e.nom);
    } catch (err) { /* table absente : ignoree */ }
  }
  resultat.operations = n;
  resultat.montant_total_xof = Math.round(m / 100);   // montants stockes en centimes
  return resultat;
}

/** Etat technique des synchronisations terrain (agregat, sans contenu). */
export async function syncTenant(imfId) {
  try {
    const { rows } = await q(
      `SELECT count(*) FILTER (WHERE synced_at IS NULL) AS en_attente,
              count(*) FILTER (WHERE synced_at > now() - interval '24 hours') AS dernieres_24h,
              max(synced_at) AS dernier
         FROM offline_sync_queue WHERE imf_id=$1`, [imfId]);
    return rows[0] || { en_attente: 0, dernieres_24h: 0, dernier: null };
  } catch (e) {
    return { en_attente: null, dernieres_24h: null, dernier: null };
  }
}

/**
 * Revenus recurrents : MRR (mensuel) et ARR (annuel) en XOF, calcules sur les
 * abonnements ACTIFS. Le montant retenu est la somme des prix mensuels des
 * modules souscrits, ramenee au mois selon la periodicite.
 */
export async function revenusRecurrents() {
  try {
    const { rows } = await q(
      `SELECT
          COALESCE(SUM(CASE
             WHEN a.periodicite = 'ANNUEL'      THEN a.montant_total_periodique_xof / 12.0
             WHEN a.periodicite = 'TRIMESTRIEL' THEN a.montant_total_periodique_xof / 3.0
             ELSE a.montant_total_periodique_xof END), 0) AS mrr,
          COUNT(DISTINCT a.tenant_id) AS clients_factures
         FROM abonnements_tenants a
        WHERE a.statut = 'ACTIF'`);
    const mrr = Number(rows[0].mrr || 0);
    return { mrr_xof: Math.round(mrr), arr_xof: Math.round(mrr * 12),
             clients_factures: Number(rows[0].clients_factures || 0) };
  } catch (e) {
    return { mrr_xof: 0, arr_xof: 0, clients_factures: 0 };
  }
}

/** Encours de facturation (impayes) : montant et nombre. */
export async function encoursFacturation() {
  try {
    const { rows } = await q(
      `SELECT COALESCE(SUM(montant_ttc_xof) FILTER (WHERE statut_paiement IN ('EN_ATTENTE','EN_RETARD')),0) AS du,
              count(*) FILTER (WHERE statut_paiement = 'EN_RETARD') AS en_retard,
              count(*) FILTER (WHERE statut_paiement = 'PAYEE') AS payees
         FROM factures_saas`);
    return { montant_du_xof: Math.round(Number(rows[0].du || 0)),
             factures_en_retard: Number(rows[0].en_retard || 0),
             factures_payees: Number(rows[0].payees || 0) };
  } catch (e) {
    return { montant_du_xof: 0, factures_en_retard: 0, factures_payees: 0 };
  }
}

/** Tableau de bord editeur : tout est agrege, rien n'est nominatif. */
export async function tableauDeBordEditeur() {
  const revenus = await revenusRecurrents();
  const encours = await encoursFacturation();
  let compteurs = { tenants: 0, actifs: 0, essais: 0, suspendus: 0, resilies: 0 };
  try {
    const { rows } = await q(
      `SELECT count(*) AS tenants,
              count(*) FILTER (WHERE statut_compte='ACTIF') AS actifs,
              count(*) FILTER (WHERE statut_compte='ESSAI_GRATUIT') AS essais,
              count(*) FILTER (WHERE statut_compte='SUSPENDU_IMPAYE') AS suspendus,
              count(*) FILTER (WHERE statut_compte='RESILIE') AS resilies
         FROM tenants`);
    compteurs = rows[0];
  } catch (e) { /* avant migration */ }
  return {
    tenants: {
      total: Number(compteurs.tenants || 0), actifs: Number(compteurs.actifs || 0),
      essais: Number(compteurs.essais || 0), suspendus: Number(compteurs.suspendus || 0),
      resilies: Number(compteurs.resilies || 0)
    },
    revenus,
    encours,
    genere_le: new Date().toISOString(),
    perimetre: PERIMETRE_EDITEUR.autorise
  };
}

/**
 * Journal d'acces de l'editeur : toute action du SUPER_ADMIN_SAAS est tracee
 * (obligation d'audit). Ecrit dans audit_log sans imf_id « metier » nuisible.
 */
export async function tracerActionEditeur(actor, action, cible, details) {
  try {
    await q(
      `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [cible && cible.tenant_id ? cible.tenant_id : null, actor && actor.id,
       action, cible && cible.entity ? cible.entity : 'saas',
       cible && cible.id ? cible.id : null, JSON.stringify(details || {})]);
  } catch (e) {
    console.error('[super_admin] trace impossible : ' + (e && e.message));
  }
}

export default {
  ROLE_EDITEUR, ROLE_EDITEUR_LABEL, PERIMETRE_EDITEUR,
  statistiquesTenant, volumesTenant, syncTenant,
  revenusRecurrents, encoursFacturation, tableauDeBordEditeur, tracerActionEditeur
};
