// =========================================================================
// teebo — MOTEUR DE COMMISSIONS DYNAMIQUE (tontines / collecte)
// =========================================================================
// Trois modèles paramétrables PAR IMF (table commission_rules) :
//
//  1. modèle « mise »   — on retient UNE SEULE cotisation sur le cycle.
//     Exemple : cycle de 31 jours, mise journalière de 1 000 FCFA.
//     Le client paie 31 000 FCFA ; l’IMF conserve 1 000 FCFA de commission
//     (1 cotisation sur 31) et le client récupère 30 000 FCFA de son épargne.
//     Formule : commission = montant_mise / jours_cycle (par cotisation),
//     soit une cotisation entière sur l’ensemble du cycle.
//
//  2. modèle « pourcentage » — taux en points de base sur le montant collecté
//     (500 = 5 %).
//
//  3. modèle « fixe » — montant fixe en FCFA par cotisation.
//
// RÉPARTITION DU REVENU : repartition_pct_imf / repartition_pct_collecteur.
//   La somme ne peut pas dépasser 100 % (contrainte SQL). La part IMF va au
//   compte de produit (7011 / COM-IMF), la part collecteur au compte
//   courant du collecteur (COM-COLLECTEUR).
//
// Les commissions sont ACQUISES immédiatement (le client a payé) mais
// deviennent DISPONIBLES pour le collecteur seulement quand la TOURNÉE est
// clôturée : c’est ce que distingue le statut « en_attente ».
//
// Chaque commission produit UNE écriture au grand livre immuable :
//   Débit  épargne client      (+ montant collecté = dépôt)
//   Crédit  épargne client      (- commission retenue)
//   Crédit  produit IMF          (part IMF)
//   Crédit  compte collecteur    (part collecteur)
// =========================================================================
import { LedgerError, postJournalEntry } from './ledger.js';

/** Arrondi bancaire au centime (FCFA : on arrondit à l’unité inférieure). */
function floorCents(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

/** Convertit un montant en centimes vers un entier de FCFA (affichage). */
export function toFcfa(cents) {
  return Math.round(Number(cents || 0) / 100);
}

/**
 * Charge la règle applicable à une IMF (et éventuellement un produit).
 * Priorité la plus faible d’abord ; une règle ciblant le produit passe avant
 * la règle générale. Aucune ligne → règle neutre (commission = 0).
 */
export async function loadRule(client, institutionId, savingsProductCode = null) {
  const { rows } = await client.query(
    `SELECT * FROM commission_rules
      WHERE institution_id=$1 AND actif=true
        AND (savings_product_code IS NULL OR savings_product_code=$2)
      ORDER BY (savings_product_code IS NOT NULL) DESC, priorite ASC, created_at DESC
      LIMIT 1`,
    [institutionId, savingsProductCode]);
  if (rows.length) return rows[0];
  // Règle neutre : aucune commission ne sera prélevée.
  return {
    id: null, code_rule: 'NEUTRE', libelle: 'Aucune commission',
    modele: 'pourcentage', taux_pct_bp: 0, montant_fixe_cents: 0,
    jours_cycle: 31, montant_mise_cents: 0,
    repartition_pct_imf: 100, repartition_pct_collecteur: 0,
    savings_product_code: null, priorite: 9999, actif: true
  };
}

/**
 * CALCUL PUR (sans base) — testable et vérifiable à la main.
 *
 * @param {object} rule      ligne commission_rules
 * @param {object} op
 *   op.montantCollecteCents montant de la cotisation encaissée
 *   op.nbCotisationsCycle   nombre de cotisations du cycle (31 si non fourni)
 *   op.cotisationsPayees    cotisations déjà payées dans le cycle
 * @returns {{commission, partImf, partCollecteur, assiette, detail}}
 */
export function computeCommission(rule, op = {}) {
  const assiette = Math.max(0, Math.round(Number(op.montantCollecteCents || 0)));
  const nbCycle = Math.max(1, Math.round(Number(op.nbCotisationsCycle || rule.jours_cycle || 31)));
  const payees = Math.max(0, Math.round(Number(op.cotisationsPayees || 0)));
  let commission = 0;
  let detail = '';

  if (rule.modele === 'pourcentage') {
    const bp = Math.max(0, Math.min(10000, Number(rule.taux_pct_bp || 0)));
    commission = floorCents((assiette * bp) / 10000);
    detail = `pourcentage ${(bp / 100).toFixed(2)} % de ${toFcfa(assiette)} FCFA`;
  } else if (rule.modele === 'fixe') {
    commission = floorCents(rule.montant_fixe_cents);
    detail = `montant fixe ${toFcfa(commission)} FCFA par cotisation`;
  } else if (rule.modele === 'mise') {
    // Commission de la cotisation courante : « mise / nb de cotisations »,
    // + le RÉSIDU de l’arrondi (FCFA entiers) rattaché à la DERNIÈRE
    // cotisation du cycle, pour que le total retenu soit EXACTEMENT une mise.
    // Ex. mise 1 000 F, cycle 31 : 32 F x 30 + 40 F = 1 000 F (et non 992 F).
    const mise = floorCents(rule.montant_mise_cents);
    const cycle = nbCycle;
    const uid = Math.floor(mise / cycle);
    const residu = mise - uid * cycle;
    // Après la fin du cycle, plus rien n'est retenu (une mise pour tout le cycle).
    const dernier = payees + 1 >= cycle;
    commission = uid + (dernier ? residu : 0);
    // Garde-fou absolu : le cumul du cycle ne peut JAMAIS dépasser une mise.
    const dejaRetenu = payees >= cycle ? mise : floorCents(uid * Math.min(payees, cycle));
    if (payees >= cycle) commission = 0;
    if (dejaRetenu + commission > mise) {
      commission = Math.max(0, mise - dejaRetenu);
    }
    detail = `mise : ${toFcfa(mise)} FCFA / ${cycle} cotisations = ` +
             `${toFcfa(commission)} FCFA retenus (1 cotisation sur ${cycle}` +
             (dernier && residu ? `, résidu d’arrondi +${toFcfa(residu)} FCFA` : '') + ')';
  } else {
    throw new LedgerError('commission_unknown_model',
      'Règle de commission invalide : modèle inconnu « ' + rule.modele + ' ».',
      { modele: rule.modele }, 422);
  }

  // La commission ne peut pas dépasser le montant collecté (sécurité).
  if (commission > assiette) commission = assiette;

  const pctImf = Number(rule.repartition_pct_imf == null ? 100 : rule.repartition_pct_imf);
  const pctCol = Number(rule.repartition_pct_collecteur == null ? 0 : rule.repartition_pct_collecteur);
  const partImf = floorCents((commission * pctImf) / 100);
  let partCollecteur = commission - partImf;              // le reste, jamais perdu
  if (pctCol === 0 && pctImf >= 100) partCollecteur = 0;
  if (partCollecteur > commission) partCollecteur = commission;

  return {
    commission,
    assiette,
    partImf,
    partCollecteur,
    detail,
    modele: rule.modele,
    part_pct_imf: pctImf,
    part_pct_collecteur: pctCol,
    nb_cotisations_cycle: nbCycle
  };
}

/**
 * Calcule ET COMPTABLE la commission d’une cotisation, dans la transaction
 * de la collecte (atomicité totale : pas de commission sans dépôt, pas de
 * dépôt sans sa trace au grand livre).
 *
 * @param {import('pg').PoolClient} c         connexion de transaction
 * @param {object} p
 *   p.institutionId, p.collecteurId, p.accountId, p.clientId,
 *   p.operationId, p.roundId, p.montantCollecteCents,
 *   p.savingsProductCode, p.nbCotisationsCycle, p.cotisationsPayees,
 *   p.actorId, p.deviceId, p.idempotencyKey
 * @returns {{ rule, calcul, accrue, entry }}
 */
export async function accrueOnDeposit(c, p) {
  const rule = await loadRule(c, p.institutionId, p.savingsProductCode || null);
  const calcul = computeCommission(rule, {
    montantCollecteCents: p.montantCollecteCents,
    nbCotisationsCycle: p.nbCotisationsCycle,
    cotisationsPayees: p.cotisationsPayees
  });

  // Aucune commission : on n’écrit rien (une écriture à zéro polluerait
  // le grand livre et la balance comptable).
  if (calcul.commission <= 0) return { rule, calcul, accrue: null, entry: null };

  const statutRound = p.roundId
    ? (await c.query('SELECT status FROM collection_round WHERE id=$1', [p.roundId])).rows[0]
    : null;
  const statut = statutRound && statutRound.status === 'done' ? 'acquis' : 'en_attente';

  // --- Écriture au grand livre : la commission est RETENUE de l’épargne ---
  const lines = [
    { accountId: p.accountId, ledgeKind: 'client', clientId: p.clientId,
      sens: -1, montantCents: calcul.commission, libelle: 'Commission retenue (' + rule.code_rule + ')' }
  ];
  if (calcul.partImf > 0) {
    lines.push({ ledgeKind: 'imf_income', ledgerCode: 'COM-IMF',
      sens: 1, montantCents: calcul.partImf, libelle: 'Produit commission IMF' });
  }
  if (calcul.partCollecteur > 0) {
    lines.push({ ledgeKind: 'collecteur', ledgerCode: 'COM-COLLECTEUR',
      collecteurId: p.collecteurId, sens: 1, montantCents: calcul.partCollecteur,
      libelle: 'Commission collecteur' });
  }

  const { entry } = await postJournalEntry(c, {
    institutionId: p.institutionId,
    eventType: 'commission_retention',
    eventRef: p.operationId || null,
    actorId: p.actorId, deviceId: p.deviceId || null,
    idempotencyKey: p.idempotencyKey ? 'COM-' + p.idempotencyKey : null,
    payload: { rule: rule.code_rule, modele: rule.modele, ...calcul },
    lines
  });

  const accrue = (await c.query(
    `INSERT INTO commission_accrual
       (imf_id, institution_id, collecteur_id, client_id, account_id, operation_id, round_id,
        rule_id, modele, assiette_cents, montant_cents, part_imf_cents, part_collecteur_cents,
        statut, ledger_entry_id)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [p.institutionId, p.collecteurId, p.clientId || null, p.accountId || null,
     p.operationId || null, p.roundId || null, rule.id,
     rule.modele, calcul.assiette, calcul.commission,
     calcul.partImf, calcul.partCollecteur, statut, entry.id])).rows[0];

  return { rule, calcul, accrue, entry };
}

/**
 * Règle les commissions « en_attente » d’une tournée clôturée :
 * elles passent en « acquis » (donc disponibles pour le collecteur).
 * @returns {number} nombre de lignes réglées
 */
export async function settleRoundCommissions(c, institutionId, roundId) {
  const { rows } = await c.query(
    `UPDATE commission_accrual SET statut='acquis'
      WHERE institution_id=$1 AND round_id=$2 AND statut='en_attente'
      RETURNING id`, [institutionId, roundId]);
  return rows.length;
}

/**
 * SYNTHÈSE pour le collecteur : acquis, en attente, historique jour/mois.
 * @param {import('pg').PoolClient|object} qq objet exposant query() (pool ou client)
 */
export async function commissionSummary(qq, institutionId, collecteurId, { from, to } = {}) {
  const fromD = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toD = to || new Date().toISOString().slice(0, 10);

  const tot = (await qq.query(
    `SELECT
       COALESCE(SUM(montant_cents),0)               AS total_cents,
       COALESCE(SUM(CASE WHEN statut='acquis' THEN montant_cents END),0)     AS acquis_cents,
       COALESCE(SUM(CASE WHEN statut='en_attente' THEN montant_cents END),0) AS attente_cents,
       COALESCE(SUM(part_imf_cents),0)              AS part_imf_cents,
       COALESCE(SUM(part_collecteur_cents),0)       AS part_collecteur_cents,
       COUNT(*)                                     AS nb_operations,
       COUNT(*) FILTER (WHERE statut='en_attente')   AS nb_en_attente
     FROM commission_accrual WHERE institution_id=$1 AND collecteur_id=$2`,
    [institutionId, collecteurId])).rows[0];

  const parJour = (await qq.query(
    `SELECT to_char(date_trunc('day', accrued_at), 'YYYY-MM-DD') AS jour,
            COALESCE(SUM(montant_cents),0) AS total_cents,
            COALESCE(SUM(part_collecteur_cents),0) AS part_collecteur_cents
       FROM commission_accrual
      WHERE institution_id=$1 AND collecteur_id=$2
        AND accrued_at::date BETWEEN $3::date AND $4::date
      GROUP BY 1 ORDER BY 1 DESC`,
    [institutionId, collecteurId, fromD, toD])).rows;

  const parMois = (await qq.query(
    `SELECT to_char(date_trunc('month', accrued_at), 'YYYY-MM') AS mois,
            COALESCE(SUM(montant_cents),0) AS total_cents,
            COALESCE(SUM(part_collecteur_cents),0) AS part_collecteur_cents
       FROM commission_accrual
      WHERE institution_id=$1 AND collecteur_id=$2
      GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
    [institutionId, collecteurId])).rows;

  // Détail des tournées non clôturées (ce qui bloque les commissions).
  const roundsOuverts = (await qq.query(
    `SELECT ca.round_id, r.round_date, r.status,
            COALESCE(SUM(ca.montant_cents),0) AS en_attente_cents,
            COUNT(*) AS nb
       FROM commission_accrual ca
       LEFT JOIN collection_round r ON r.id = ca.round_id
      WHERE ca.institution_id=$1 AND ca.collecteur_id=$2 AND ca.statut='en_attente'
      GROUP BY ca.round_id, r.round_date, r.status
      ORDER BY r.round_date DESC NULLS LAST LIMIT 20`,
    [institutionId, collecteurId])).rows;

  return {
    periode: { from: fromD, to: toD },
    total_cents: Number(tot.total_cents),
    acquis_cents: Number(tot.acquis_cents),
    en_attente_cents: Number(tot.attente_cents),
    part_imf_cents: Number(tot.part_imf_cents),
    part_collecteur_cents: Number(tot.part_collecteur_cents),
    nb_operations: Number(tot.nb_operations),
    nb_en_attente: Number(tot.nb_en_attente),
    historique_journalier: parJour.map((r) => ({ ...r,
      total_cents: Number(r.total_cents), part_collecteur_cents: Number(r.part_collecteur_cents) })),
    historique_mensuel: parMois.map((r) => ({ ...r,
      total_cents: Number(r.total_cents), part_collecteur_cents: Number(r.part_collecteur_cents) })),
    tournees_en_attente: roundsOuverts.map((r) => ({ ...r,
      en_attente_cents: Number(r.en_attente_cents), nb: Number(r.nb) }))
  };
}

export default {
  loadRule, computeCommission, accrueOnDeposit, settleRoundCommissions,
  commissionSummary, toFcfa
};
