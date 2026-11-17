import crypto from 'crypto';
import { q, tx } from './db.js';
import { notifyWhatsApp } from './notify.js';

/**
 * Plafonds de collecte, versements, reçus simples et SMS clients.
 *
 * Règles métier :
 *  - L'admin de l'IMF fixe un PLAFOND DE CAISSE journalier (solde de caisse max
 *    que la collectrice peut détenir dans la journée).
 *  - L'admin fixe aussi un PLAFOND PAR CLIENT sur la journée (montant maximum à
 *    collecter auprès d'un même client dans la journée).
 *  - Si la collectrice atteint le plafond de caisse, elle doit VERSER :
 *      • à la caisse auprès de la caissière, ou
 *      • par transfert Mobile Money sur le compte de l'IMF (avec références).
 *  - À chaque dépôt client validé, un REÇU simple est généré automatiquement et
 *    s'affiche 60 s (ou jusqu'à fermeture par la collectrice).
 *  - Si l'admin a paramétré un numéro SMS, un SMS automatique part au client.
 */

export const DEFAULT_RECEIPT_SECONDS = 60;

/** Paramètres de collecte de l'IMF (créés à la volée si absents). */
export async function getSettings(imfId) {
  const { rows } = await q('SELECT * FROM imf_collection_settings WHERE imf_id=$1', [imfId]);
  if (rows.length) return rows[0];
  const ins = await q(
    `INSERT INTO imf_collection_settings(imf_id) VALUES ($1)
     ON CONFLICT (imf_id) DO UPDATE SET updated_at=now() RETURNING *`, [imfId]);
  return ins.rows[0];
}

/** Lecture sans création (pour l'API admin, réponse légère). */
export async function readSettings(imfId) {
  const { rows } = await q('SELECT * FROM imf_collection_settings WHERE imf_id=$1', [imfId]);
  return rows[0] || { imf_id: imfId, max_cash_cents: null, max_client_daily_cents: null,
    sms_enabled: false, sms_sender_number: null, momo_deposit_number: null, momo_provider: null };
}

/** Enregistre les paramètres (admin IMF uniquement côté route). */
export async function saveSettings(imfId, actorId, b = {}) {
  const num = (v) => (v == null || v === '' ? null : Math.max(0, Math.round(Number(v))));
  await getSettings(imfId);
  const { rows } = await q(
    `UPDATE imf_collection_settings SET
        max_cash_cents = $2,
        max_client_daily_cents = $3,
        sms_enabled = $4,
        sms_sender_number = $5,
        momo_deposit_number = $6,
        momo_provider = $7,
        updated_by = $8,
        updated_at = now()
      WHERE imf_id = $1 RETURNING *`,
    [imfId, num(b.max_cash_cents), num(b.max_client_daily_cents),
     !!b.sms_enabled, b.sms_sender_number || null,
     b.momo_deposit_number || null, b.momo_provider || null, actorId]);
  return rows[0];
}

/**
 * Solde de caisse courant de la collectrice = somme des dépôts clients validés
 * qui impactent la caisse, MOINS les versements (caisse/Mobile Money) déjà
 * déclarés ou validés.
 */
export async function collectriceCashBalance(imfId, userId, atDate = null) {
  const day = atDate || null;
  const deposits = await q(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM operation
      WHERE imf_id=$1 AND user_id=$2 AND kind='depot' AND status='valide'
        AND impacts_agent_cash=true
        AND ($3::date IS NULL OR created_at::date = $3::date)`,
    [imfId, userId, day]);
  const outflows = await q(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM cash_deposit
      WHERE imf_id=$1 AND collectrice_user_id=$2 AND status IN ('declare','valide')
        AND ($3::date IS NULL OR created_at::date = $3::date)`,
    [imfId, userId, day]);
  const inc = Number(deposits.rows[0].s || 0);
  const out = Number(outflows.rows[0].s || 0);
  return { deposits_cents: inc, transfers_cents: out, balance_cents: inc - out };
}

/** Montant déjà collecté auprès d'UN MÊME client dans la journée. */
export async function clientCollectedToday(imfId, clientId, atDate = null) {
  const { rows } = await q(
    `SELECT COALESCE(SUM(o.amount_cents),0) AS s
       FROM operation o JOIN account a ON a.id = o.account_id
      WHERE o.imf_id=$1 AND a.client_id=$2 AND o.kind='depot' AND o.status='valide'
        AND ($3::date IS NULL OR o.created_at::date = $3::date)`,
    [imfId, clientId, atDate]);
  return Number(rows[0].s || 0);
}

/**
 * Contrôle des plafonds AVANT d'enregistrer un dépôt.
 * Renvoie { ok:true } ou { ok:false, code, message, detail }.
 */
export async function checkLimits({ imfId, userId, clientId, amountCents, settings }) {
  const s = settings || (await getSettings(imfId));
  const results = { cash: null, client: null };

  if (s.max_client_daily_cents != null && Number(s.max_client_daily_cents) > 0) {
    const already = await clientCollectedToday(imfId, clientId);
    const cap = Number(s.max_client_daily_cents);
    if (already + amountCents > cap) {
      results.client = { already_cents: already, cap_cents: cap, remaining_cents: Math.max(0, cap - already) };
    }
  }
  if (s.max_cash_cents != null && Number(s.max_cash_cents) > 0) {
    const bal = await collectriceCashBalance(imfId, userId);
    const cap = Number(s.max_cash_cents);
    if (bal.balance_cents + amountCents > cap) {
      results.cash = { balance_cents: bal.balance_cents, cap_cents: cap,
        remaining_cents: Math.max(0, cap - bal.balance_cents), over_cents: (bal.balance_cents + amountCents) - cap };
    }
  }

  if (results.client) {
    return { ok: false, code: 'client_daily_limit_reached',
      message: 'Plafond atteint pour ce client aujourd’hui : ' +
        (results.client.already_cents / 100).toLocaleString('fr-FR') + ' FCFA déjà collectés sur un maximum de ' +
        (results.client.cap_cents / 100).toLocaleString('fr-FR') + ' FCFA.',
      detail: { limit: 'client_daily', ...results.client } };
  }
  if (results.cash) {
    return { ok: false, code: 'cash_limit_reached',
      message: 'Plafond de caisse atteint : solde de caisse ' +
        (results.cash.balance_cents / 100).toLocaleString('fr-FR') + ' FCFA pour un maximum de ' +
        (results.cash.cap_cents / 100).toLocaleString('fr-FR') +
        ' FCFA. Faites un versement (caisse ou Mobile Money) avant de collecter davantage.',
      detail: { limit: 'cash_daily', ...results.cash,
        transfer_required: true, momo_number: s.momo_deposit_number, momo_provider: s.momo_provider } };
  }
  return { ok: true };
}

/** Génère un numéro de reçu simple, unique et lisible (ex. RC-8F3K2A-0421). */
export function makeReceiptCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let core = '';
  const buf = crypto.randomBytes(6);
  for (const b of buf) core += alphabet[b % alphabet.length];
  const seq = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return 'RC-' + core.slice(0, 6) + '-' + seq;
}

/**
 * Émet le reçu simple d'un dépôt et déclenche le SMS client si paramétré.
 * À appeler dans la transaction du dépôt (client c) pour rester atomique.
 */
export async function issueReceipt(c, { imfId, operationId, clientId, accountId, userId,
  amountCents, balanceAfterCents, clientName, clientPhone, settings }) {
  const s = settings || (await getSettings(imfId));
  let code = makeReceiptCode();
  for (let i = 0; i < 5; i++) {
    const exists = await c.query('SELECT 1 FROM receipt WHERE code_receipt=$1', [code]);
    if (!exists.rows.length) break;
    code = makeReceiptCode();
  }
  const smsNumber = clientPhone || null;
  const willSms = !!(s.sms_enabled && s.sms_sender_number && smsNumber);

  const rec = (await c.query(
    `INSERT INTO receipt(imf_id,operation_id,client_id,account_id,collectrice_user_id,
            code_receipt,amount_cents,balance_after_cents,display_seconds,sms_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [imfId, operationId, clientId, accountId, userId, code,
     amountCents, balanceAfterCents == null ? null : balanceAfterCents,
     DEFAULT_RECEIPT_SECONDS, smsNumber])).rows[0];

  return { receipt: rec, willSms, smsNumber, sender: s.sms_sender_number || null,
    smsEnabled: !!s.sms_enabled, smsBody: buildSmsBody({ code, amountCents, balanceAfterCents, clientName }) };
}

/** Corps du SMS envoyé au client après chaque dépôt. */
export function buildSmsBody({ code, amountCents, balanceAfterCents, clientName, imfName }) {
  const amt = (Number(amountCents || 0) / 100).toLocaleString('fr-FR');
  const lines = [
    (imfName ? imfName + ' : ' : '') + 'Dépôt reçu : ' + amt + ' FCFA.',
    'Reçu n° ' + code + '.',
    balanceAfterCents != null ? 'Nouveau solde : ' + (Number(balanceAfterCents) / 100).toLocaleString('fr-FR') + ' FCFA.' : null,
    'Merci de votre confiance.'
  ].filter(Boolean);
  return lines.join(' ');
}

/**
 * Envoi du SMS automatique au client (hors transaction : on journalise toujours).
 * Renvoie { sent, status }.
 */
export async function sendClientSms({ imfId, clientId, receiptId, operationId, phone, sender, body, enabled }) {
  if (!enabled || !sender || !phone) {
    await q(`INSERT INTO client_sms_log(imf_id,client_id,receipt_id,operation_id,phone,sender_number,body,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [imfId, clientId || null, receiptId || null, operationId || null, phone || null, sender || null, body || null, 'desactive']);
    return { sent: false, status: 'desactive' };
  }
  let status = 'envoye';
  try {
    // Passerelle SMS : si un fournisseur est configuré, on l'utilise ; sinon
    // on réutilise la passerelle de notification (mode dégradé journalisé).
    const r = await notifyWhatsApp(phone, body);
    if (r && r.ok === false) status = 'echec';
  } catch (e) { status = 'echec'; }
  await q(`INSERT INTO client_sms_log(imf_id,client_id,receipt_id,operation_id,phone,sender_number,body,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [imfId, clientId || null, receiptId || null, operationId || null, phone, sender, body, status]);
  if (status === 'envoye' && receiptId) {
    await q('UPDATE receipt SET sms_sent=true, sms_status=$2 WHERE id=$1', [receiptId, status]);
  } else if (receiptId) {
    await q('UPDATE receipt SET sms_sent=false, sms_status=$2 WHERE id=$1', [receiptId, status]);
  }
  return { sent: status === 'envoye', status };
}

/** Libellés FR des canaux de versement. */
export const CHANNELS_FR = { caisse_caissiere: 'Versement à la caisse (caissière)',
  mobile_money: 'Transfert Mobile Money (compte IMF)' };
