// =========================================================================
// teebo — PONT ENTRE LA COLLECTE ET LE GRAND LIVRE
// =========================================================================
// Un SEUL point d'entrée, appelé par les routes de collecte (dépôt, guichet,
// enrôlement). Il enchaîne, DANS LA MÊME TRANSACTION, les contrôles et écritures :
//
//   1. plafond de caisse de la collectrice  (CASH_CEILING_EXCEEDED)
//   2. écriture équilibrée au grand livre   (débit caisse -> crédit client)
//   3. commission éventuelle                (retenue sur l'épargne, double part)
//   4. mise à jour de l'encours de caisse
//
// Si l'une des étapes échoue, TOUT est annulé : jamais d'argent en l'air.
// La fonction est IDEMPOTENTE : un renvoi du terminal (même idempotency_key)
// ne débite pas deux fois.
// =========================================================================
import {
  LedgerError, postJournalEntry, signReceipt
} from './ledger.js';
import { assertCeilingAllows, addToEncours } from './cash_ceiling.js';
import { accrueOnDeposit } from './commissions.js';

/**
 * Enregistre une collecte d'épargne au grand livre (+ commission + plafond).
 *
 * @param {object} c            client de transaction (déjà sous contexte tenant)
 * @param {object} p
 *   p.institutionId, p.collecteurId, p.actorId, p.deviceId,
 *   p.operationId (id de l'opération métier déjà créée),
 *   p.accountId, p.clientId, p.montantCents,
 *   p.idempotencyKey (uuid du terminal), p.deviceTimestamp, p.offline,
 *   p.gps {lat,lng}, p.assietteCommissionCents, p.cotisationsPayees, p.roundId,
 *   p.appliquerPlafond (true pour un encaissement terrain)
 * @returns {{entry:object, commission:object|null, signature:object|null}}
 */
export async function encaisserEpargne(c, p) {
  const montant = Math.round(Number(p.montantCents || 0));
  if (!(montant > 0)) {
    throw new LedgerError('montant_invalide',
      'Collecte refusée : le montant est invalide.', null, 400);
  }

  // 1. Plafond de caisse (contrôle AVANT toute écriture)
  if (p.appliquerPlafond !== false) {
    await assertCeilingAllows(c, p.institutionId, p.collecteurId, montant);
  }

  // 2. Grand livre : la caisse de la collectrice reçoit les espèces,
  //    le compte du client est crédité. Le solde client devient la somme
  //    algébrique de ce crédit et des débits éventuels (commission).
  const idem = p.idempotencyKey ? 'OP-' + p.idempotencyKey : null;
  const { entry } = await postJournalEntry(c, {
    institutionId: p.institutionId,
    eventType: 'depot',
    eventRef: p.operationId || null,
    actorId: p.actorId,
    deviceId: p.deviceId || null,
    idempotencyKey: idem,
    offline: p.offline === true,
    deviceTimestamp: p.deviceTimestamp || null,
    gps: p.gps || {},
    payload: { montant_cents: montant, account_id: p.accountId || null },
    lines: [
      { ledgeKind: 'caisse', collecteurId: p.collecteurId, sens: -1,
        montantCents: montant, libelle: 'Encaissement espèces (collecte)' },
      { accountId: p.accountId, ledgeKind: 'client', clientId: p.clientId,
        sens: 1, montantCents: montant, libelle: 'Dépôt épargne client' }
    ]
  });

  // 3. Commission (retenue sur le compte du client, répartie IMF / collecteur)
  let commission = null;
  try {
    commission = await accrueOnDeposit(c, {
      institutionId: p.institutionId,
      collecteurId: p.collecteurId,
      clientId: p.clientId,
      accountId: p.accountId,
      operationId: p.operationId,
      roundId: p.roundId || null,
      savingsProductCode: p.savingsProductCode || null,
      montantCollecteCents: p.assietteCommissionCents != null ? Number(p.assietteCommissionCents) : montant,
      cotisationsPayees: p.cotisationsPayees,
      actorId: p.actorId,
      deviceId: p.deviceId || null,
      idempotencyKey: p.idempotencyKey || null
    });
  } catch (e) {
    // Une erreur de commission ne doit jamais faire perdre la collecte :
    // on la remonte en avertissement (journalisée par l'appelant).
    commission = { erreur: e.code || 'commission_error', message: e.message };
  }

  // 4. Encours de caisse de la collectrice
  if (p.appliquerPlafond !== false) {
    await addToEncours(c, p.institutionId, p.collecteurId, montant);
  }

  // 5. Reçu signé (QR hors-ligne) : signature HMAC déterministe.
  let signature = null;
  if (p.receiptId) {
    signature = signReceipt({
      transactionId: p.operationId || p.receiptId,
      collecteurId: p.collecteurId,
      amountCents: montant,
      timestamp: p.timestamp || new Date()
    });
    await c.query(
      `UPDATE receipt SET signature_hmac=$2, signature_algo=$3,
              signed_payload=$4, signed_at=now()
        WHERE id=$1`,
      [p.receiptId, signature.signature, signature.algo, signature.payload]);
  }

  return { entry, commission, signature };
}

/**
 * Dépôt au guichet (caissière) : pas d'encours de caisse terrain, mais
 * toujours une écriture au grand livre (caisse agence -> compte client).
 */
export async function encaisserGuichet(c, p) {
  const montant = Math.round(Number(p.montantCents || 0));
  if (!(montant > 0)) {
    throw new LedgerError('montant_invalide',
      'Opération refusée : le montant est invalide.', null, 400);
  }
  const { entry } = await postJournalEntry(c, {
    institutionId: p.institutionId,
    eventType: p.eventType || 'depot',
    eventRef: p.operationId || null,
    actorId: p.actorId,
    deviceId: p.deviceId || null,
    idempotencyKey: p.idempotencyKey ? 'GUI-' + p.idempotencyKey : null,
    deviceTimestamp: p.deviceTimestamp || null,
    payload: { montant_cents: montant, canal: 'guichet' },
    lines: [
      { ledgeKind: 'caisse', ledgerCode: 'CAISSE-AGENCE', sens: -1,
        montantCents: montant, libelle: 'Encaissement guichet' },
      { accountId: p.accountId, ledgeKind: 'client', clientId: p.clientId,
        sens: 1, montantCents: montant, libelle: 'Dépôt guichet' }
    ]
  });
  return { entry };
}

export default { encaisserEpargne, encaisserGuichet };
