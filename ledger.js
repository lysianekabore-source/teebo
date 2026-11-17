// =========================================================================
// teebo — GRAND LIVRE IMMUABLE (event sourcing + chaîne de hachage + HMAC)
// =========================================================================
// RÈGLE D'OR : aucun solde n'est « écrit à la main ». Le solde d'un compte est
// la SOMME ALGÉBRIQUE de ses lignes au grand livre. Une erreur ne se corrige
// jamais par un UPDATE : on passe une CONTRE-ÉCRITURE (event_type=annulation).
//
// Ce module fournit :
//   postJournalEntry()      écriture équilibrée (partie double) + scellement
//   accrueCommissions()     écritures de commission (délègue à commissions.js)
//   getAccountSaldo()       solde calculé (jamais stocké)
//   hashReceiptPayload()    contenu canonique « tx|collecteur|montant|horodatage »
//   signReceipt() / verifyReceiptSignature()  HMAC-SHA256 du QR Bluetooth
//   pushOfflineEvent()      synchronisation hors-ligne séquencée côté serveur
//   verifyChain()           contrôle d'intégrité de la chaîne (audit interne)
//
// Tout échec financier LÈVE une exception explicite (LedgerError) qui est
// journalisée dans audit_log par errors.js / audit.js.
// =========================================================================
import crypto from 'crypto';

/** Erreur financière : toujours explicite, jamais silencieuse. */
export class LedgerError extends Error {
  constructor(code, message, detail = null, status = 409) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;              // code métier (majuscules)
    this.detail = detail;
    this.status = status;          // HTTP à renvoyer
    this.expose = true;            // message affichable tel quel au client
    this.financial = true;         // marqueur : journalisé comme incident financier
  }
}

/** Devises autorisées (UEMOA/BCEAO). */
const CURRENCIES = new Set(['XOF', 'XAF', 'GHS', 'NGN']);

/** Clé HMAC des reçus. JAMAIS en base : uniquement dans l'environnement. */
function receiptSecret() {
  const s = process.env.TEEBO_RECEIPT_SECRET || process.env.TEEBO_APP_SECRET;
  if (!s || String(s).length < 16) {
    throw new LedgerError('receipt_secret_missing',
      'Le secret de signature des reçus n’est pas configuré sur le serveur ' +
      '(variable TEEBO_RECEIPT_SECRET, au moins 16 caractères).',
      { variable: 'TEEBO_RECEIPT_SECRET' }, 500);
  }
  return String(s);
}

/* ------------------------------------------------------------------ */
/*  1. ÉCRITURE COMPTABLE (partie double)                              */
/* ------------------------------------------------------------------ */
/**
 * Écrit une écriture au grand livre.
 *
 * @param {import('pg').PoolClient} c connexion de TRANSACTION (obligatoire)
 * @param {object} entry
 *   entry.institutionId  uuid de l'IMF
 *   entry.eventType      type d'événement (depot, frais, commission_*, …)
 *   entry.eventRef       id métier (operation.id, cash_closing.id…)
 *   entry.actorId        utilisateur à l'origine
 *   entry.deviceId       terminal (optionnel)
 *   entry.idempotencyKey clé anti-doublon (hors-ligne)
 *   entry.offline        true si l'opération a été faite hors réseau
 *   entry.deviceTimestamp horloge du terminal (immuable)
 *   entry.gps            { lat, lng }
 *   entry.payload        objet libre (jamais modifié ensuite)
 *   entry.lines          [{ accountId, ledgeKind, ledgerCode, clientId,
 *                           collecteurId, sens(+1/-1), montantCents,
 *                           currency, libelle }]
 * @returns {{entry:object, lines:object[]}}
 */
export async function postJournalEntry(c, entry) {
  if (!c || typeof c.query !== 'function') {
    throw new LedgerError('ledger_no_transaction',
      'Écriture comptable impossible : le grand livre exige une transaction.', null, 500);
  }
  const has = (v) => v != null && v !== '';

  // --- Contrôles d'entrée (aucune écriture partielle possible) -----------
  if (!has(entry.institutionId)) {
    throw new LedgerError('ledger_missing_institution',
      'Écriture comptable refusée : institution non précisée.');
  }
  if (!has(entry.eventType)) {
    throw new LedgerError('ledger_missing_event_type',
      'Écriture comptable refusée : type d’événement manquant.');
  }
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  if (lines.length < 2) {
    throw new LedgerError('ledger_unbalanced',
      'Écriture comptable refusée : une écriture doit comporter au moins deux lignes ' +
      '(partie double).');
  }

  let net = 0;
  let currency = null;
  for (const l of lines) {
    if (!has(l.sens) || ![-1, 1].includes(Number(l.sens))) {
      throw new LedgerError('ledger_bad_sens',
        'Écriture comptable refusée : sens de ligne invalide (débit -1 ou crédit +1).');
    }
    if (!Number.isInteger(Number(l.montantCents)) || Number(l.montantCents) < 0) {
      throw new LedgerError('ledger_bad_amount',
        'Écriture comptable refusée : montant négatif ou non entier.',
        { montant: l.montantCents });
    }
    const cur = (l.currency || 'XOF').toUpperCase();
    if (!CURRENCIES.has(cur)) {
      throw new LedgerError('ledger_bad_currency',
        'Écriture comptable refusée : devise non autorisée (' + cur + ').');
    }
    if (currency && currency !== cur) {
      throw new LedgerError('ledger_currency_mix',
        'Écriture comptable refusée : deux devises différentes dans la même écriture.');
    }
    currency = cur;
    net += Number(l.sens) * Number(l.montantCents);
  }
  if (net !== 0) {
    throw new LedgerError('ledger_unbalanced',
      'Écriture comptable refusée : l’écriture n’est pas équilibrée (débit ≠ crédit).',
      { ecart_cents: net });
  }

  // --- En-tête ----------------------------------------------------------
  const gps = entry.gps || {};
  let head;
  try {
    head = (await c.query(
      `INSERT INTO ledger_entry
         (institution_id, event_type, event_ref, actor_id, device_id,
          idempotency_key, offline, device_timestamp, gps_lat, gps_lng, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()),$9,$10,$11::jsonb)
       RETURNING *`,
      [entry.institutionId, entry.eventType, entry.eventRef || null,
       entry.actorId || null, entry.deviceId || null,
       entry.idempotencyKey || null, entry.offline === true,
       entry.deviceTimestamp || null,
       gps.lat != null ? gps.lat : null, gps.lng != null ? gps.lng : null,
       JSON.stringify(entry.payload || {})])).rows[0];
  } catch (e) {
    // 23505 = clé idempotente déjà utilisée : la transaction ENTIÈRE est
    // annulée par l'appelant. On traduit en refus explicite et non en 500.
    if (e && e.code === '23505') {
      throw new LedgerError('ledger_duplicate_event',
        'Opération déjà enregistrée (doublon détecté). Aucune somme n’a été débitée deux fois.',
        { idempotency_key: entry.idempotencyKey }, 409);
    }
    throw e;
  }

  // --- Lignes -----------------------------------------------------------
  const out = [];
  for (const l of lines) {
    const row = (await c.query(
      `INSERT INTO ledger_line
         (entry_id, institution_id, account_id, ledge_kind, ledger_code,
          client_id, collecteur_id, sens, montant_cents, currency, libelle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [head.id, entry.institutionId, l.accountId || null,
       l.ledgeKind || 'client', l.ledgerCode || null,
       l.clientId || null, l.collecteurId || null,
       Number(l.sens), Number(l.montantCents), currency,
       l.libelle || null])).rows[0];
    out.push(row);
  }
  return { entry: head, lines: out };
}

/**
 * Contre-écriture : annule une écriture SANS la modifier (immuabilité).
 * Crée une nouvelle écriture aux signes inversés, référençant l'originale.
 */
export async function reverseJournalEntry(c, { institutionId, entryId, actorId, motif }) {
  const src = (await c.query(
    'SELECT * FROM ledger_entry WHERE id=$1 AND institution_id=$2',
    [entryId, institutionId])).rows[0];
  if (!src) {
    throw new LedgerError('ledger_entry_not_found',
      'Écriture à annuler introuvable pour cette institution.', { entry_id: entryId }, 404);
  }
  const already = (await c.query(
    `SELECT 1 FROM ledger_entry WHERE institution_id=$1 AND event_ref=$2 AND event_type='annulation'`,
    [institutionId, 'REV-' + entryId])).rows.length;
  if (already) {
    throw new LedgerError('ledger_already_reversed',
      'Cette écriture a déjà été annulée (une seule annulation est autorisée).',
      { entry_id: entryId }, 409);
  }
  const lines = (await c.query('SELECT * FROM ledger_line WHERE entry_id=$1 ORDER BY id', [entryId])).rows;
  return postJournalEntry(c, {
    institutionId, eventType: 'annulation', eventRef: 'REV-' + entryId,
    actorId, payload: { source_entry_id: entryId, source_hash: src.hash, motif: motif || null },
    lines: lines.map((l) => ({
      accountId: l.account_id, ledgeKind: l.ledge_kind, ledgerCode: l.ledger_code,
      clientId: l.client_id, collecteurId: l.collecteur_id,
      sens: -l.sens, montantCents: l.montant_cents, currency: l.currency,
      libelle: 'Annulation : ' + (l.libelle || l.ledge_kind)
    }))
  });
}

/* ------------------------------------------------------------------ */
/*  2. SOLDES CALCULÉS                                                 */
/* ------------------------------------------------------------------ */
/** Solde d'un compte = somme algébrique des lignes (jamais stocké). */
export async function getAccountSaldo(c, accountId, currency = 'XOF') {
  const r = (await c.query(
    `SELECT COALESCE(SUM(sens::bigint * montant_cents), 0) AS solde
       FROM ledger_line WHERE account_id=$1 AND currency=$2`, [accountId, currency])).rows[0];
  return Number(r.solde || 0);
}

/** Position d'un collecteur : encaissé (caisse) et commissions acquises. */
export async function getCollecteurPosition(c, institutionId, collecteurId) {
  const r = (await c.query(
    `SELECT COALESCE(SUM(CASE WHEN ledge_kind='caisse' THEN sens::bigint*montant_cents END),0) AS encaisse,
            COALESCE(SUM(CASE WHEN ledge_kind='collecteur' THEN sens::bigint*montant_cents END),0) AS commissions
       FROM ledger_line WHERE institution_id=$1 AND collecteur_id=$2`,
    [institutionId, collecteurId])).rows[0];
  return { encaisse_cents: Number(r.encaisse || 0), commissions_cents: Number(r.commissions || 0) };
}

/* ------------------------------------------------------------------ */
/*  3. SIGNATURE HMAC-SHA256 DES REÇUS (QR Bluetooth)                  */
/* ------------------------------------------------------------------ */
/**
 * Contenu canonique signé : identifiant de transaction | collecteur |
 * montant en centimes | horodatage ISO-8601 (UTC). Ordre FIXE.
 */
export function receiptPayload({ transactionId, collecteurId, amountCents, timestamp }) {
  const ts = new Date(timestamp || Date.now()).toISOString();
  return [String(transactionId), String(collecteurId), String(Number(amountCents)), ts].join('|');
}

/** Calcule la signature HMAC-SHA256 (hex). */
export function signPayload(payload) {
  return crypto.createHmac('sha256', receiptSecret()).update(String(payload), 'utf8').digest('hex');
}

/** Signe un reçu : renvoie { signature, payload, algo }. */
export function signReceipt({ transactionId, collecteurId, amountCents, timestamp }) {
  const payload = receiptPayload({ transactionId, collecteurId, amountCents, timestamp });
  return { payload, signature: signPayload(payload), algo: 'HMAC-SHA256' };
}

/**
 * Vérifie une signature de reçu en temps constant (anti-timing attack).
 * @returns {{valide:boolean, raison?:string}}
 */
export function verifyReceiptSignature({ transactionId, collecteurId, amountCents, timestamp, signature }) {
  if (!signature) return { valide: false, raison: 'signature_absente' };
  let expected;
  try {
    expected = signReceipt({ transactionId, collecteurId, amountCents, timestamp }).signature;
  } catch (e) {
    return { valide: false, raison: 'secret_non_configure' };
  }
  const a = Buffer.from(String(signature).toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { valide: false, raison: 'signature_invalide' };
  return crypto.timingSafeEqual(a, b) ? { valide: true } : { valide: false, raison: 'signature_invalide' };
}

/** Contenu du QR code à imprimer / transmettre (texte compact, non signé). */
export function receiptQrPayload({ transactionId, collecteurId, amountCents, timestamp, signature }) {
  return JSON.stringify({
    v: 1, tx: String(transactionId), col: String(collecteurId),
    amt: Number(amountCents), ts: new Date(timestamp || Date.now()).toISOString(),
    algo: 'HMAC-SHA256', sig: signature
  });
}

/* ------------------------------------------------------------------ */
/*  4. SYNCHRONISATION HORS-LIGNE                                      */
/* ------------------------------------------------------------------ */
/**
 * Reçoit un événement du terrain (collecte faite sans réseau).
 * REFUSE (conflit) si :
 *   - l'horodatage du terminal est dans le FUTUR (horloge suspecte) ;
 *   - l'événement est arrivé trop tard par rapport à d'autres déjà traités
 *     (seq_local inférieure à une seq_local déjà reçue pour ce terminal) ;
 *   - la même clé idempotente a déjà été appliquée.
 * Le serveur attribue TOUJOURS la séquence maîtresse (seq_server).
 */
export async function pushOfflineEvent(c, {
  institutionId, eventUuid, deviceId, collecteurId, payload,
  seqLocal, deviceTimestamp, toleranceMinutes = 10
}) {
  if (!eventUuid) {
    throw new LedgerError('offline_missing_uuid',
      'Synchronisation refusée : identifiant d’événement manquant (impossible de garantir l’unicité).');
  }
  const dt = deviceTimestamp ? new Date(deviceTimestamp) : null;
  if (!dt || isNaN(dt.getTime())) {
    throw new LedgerError('offline_missing_timestamp',
      'Synchronisation refusée : horodatage du terminal manquant.');
  }
  if (dt.getTime() > Date.now() + toleranceMinutes * 60000) {
    throw new LedgerError('offline_clock_skew',
      'Synchronisation refusée : l’horloge du terminal est en avance sur le serveur. ' +
      'Réglez la date du téléphone puis relancez la synchronisation.',
      { device_timestamp: dt.toISOString(), server_time: new Date().toISOString() }, 409);
  }

  // Doublon ?
  const dup = (await c.query(
    'SELECT id, status, applied_entry_id FROM offline_sync_queue WHERE institution_id=$1 AND event_uuid=$2',
    [institutionId, eventUuid])).rows[0];
  if (dup) {
    return { duplicate: true, status: dup.status, applied_entry_id: dup.applied_entry_id };
  }

  // Conflit d'ordre : une séquence locale SUPÉRIEURE est déjà arrivée.
  if (seqLocal != null) {
    const ahead = (await c.query(
      `SELECT MAX(seq_local) AS m FROM offline_sync_queue
        WHERE institution_id=$1 AND device_id IS NOT DISTINCT FROM $2 AND status <> 'rejete'`,
      [institutionId, deviceId || null])).rows[0];
    if (ahead && ahead.m != null && Number(seqLocal) < Number(ahead.m)) {
      throw new LedgerError('offline_order_conflict',
        'Synchronisation refusée : cet événement arrive après un événement plus récent ' +
        `(séquence ${seqLocal} < ${ahead.m}). Les opérations doivent être renvoyées dans l’ordre.`,
        { seq_local: Number(seqLocal), seq_last: Number(ahead.m) }, 409);
    }
  }

  const seqServer = (await c.query(
    `SELECT nextval('seq_offline_global') AS s`)).rows[0].s;

  const row = (await c.query(
    `INSERT INTO offline_sync_queue
       (institution_id, event_uuid, device_id, collecteur_id, payload,
        seq_local, seq_server, device_timestamp, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'recu') RETURNING *`,
    [institutionId, eventUuid, deviceId || null, collecteurId || null,
     JSON.stringify(payload || {}), seqLocal != null ? seqLocal : null,
     seqServer, dt])).rows[0];

  return { duplicate: false, queue: row, seq_server: Number(seqServer) };
}

/** Marque un événement comme appliqué (après écriture au grand livre). */
export async function markOfflineApplied(c, queueId, entryId) {
  await c.query(
    `UPDATE offline_sync_queue SET status='applique', applied_entry_id=$2 WHERE id=$1`,
    [queueId, entryId]);
}

/** Marque un événement en conflit (refusé), avec sa raison. */
export async function markOfflineConflict(c, queueId, raison) {
  await c.query(
    `UPDATE offline_sync_queue SET status='conflit', conflit_raison=$2 WHERE id=$1`,
    [queueId, raison]);
}

/* ------------------------------------------------------------------ */
/*  5. INTÉGRITÉ DE LA CHAÎNE                                          */
/* ------------------------------------------------------------------ */
/**
 * Recalcule hash par hash et détecte toute rupture de chaîne.
 * (Contrôle d'audit : la RLS n'empêche pas la corruption, le hachage si.)
 */
export async function verifyChain(c, institutionId, limit = 5000) {
  const rows = (await c.query(
    `SELECT id, prev_hash, hash, event_type, event_at, payload
       FROM ledger_entry WHERE institution_id=$1 ORDER BY id DESC LIMIT $2`,
    [institutionId, limit])).rows.reverse();
  let prev = null;
  let checked = 0;
  const anomalies = [];
  for (const r of rows) {
    const attendu = crypto.createHash('sha256').update(
      (r.prev_hash || '') + '|' + institutionId + '|' + r.event_type + '|' +
      isoMicro(r.event_at) + '|' + JSON.stringify(r.payload), 'utf8').digest('hex');
    if (r.hash !== attendu) {
      anomalies.push({ id: r.id, raison: 'hash_altere' });
    }
    if (prev && r.prev_hash !== prev) {
      anomalies.push({ id: r.id, raison: 'chaine_rompue', prev_hash: r.prev_hash, attendu: prev });
    }
    prev = r.hash;
    checked++;
  }
  return { checked, anomalies, chaine_valide: anomalies.length === 0 };
}

/** ISO-8601 avec microsecondes, comme to_char() côté PostgreSQL. */
function isoMicro(d) {
  const dt = new Date(d);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T` +
         `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}.` +
         `${p(dt.getUTCMilliseconds(), 3)}000+00`;
}

export default {
  LedgerError, postJournalEntry, reverseJournalEntry, getAccountSaldo,
  getCollecteurPosition, receiptPayload, signPayload, signReceipt,
  verifyReceiptSignature, receiptQrPayload, pushOfflineEvent,
  markOfflineApplied, markOfflineConflict, verifyChain
};
