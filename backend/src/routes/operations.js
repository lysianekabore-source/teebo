import { Router } from 'express';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { deviceFromReq } from './devices.js';
import { ensureSubscription, computeState } from '../subscription.js';
import { assertClientNotFrozen, isFrozen } from '../freeze.js';
import { getSettings, checkLimits, issueReceipt, sendClientSms } from '../collecte.js';

const r = Router();

/** Vrai si la date fournie est une date ISO valide (YYYY-MM-DD). */
function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * VALIDATION STRICTE (backend) : la DATE DE L’OPÉRATION et le MONTANT sont
 * OBLIGATOIRES pour les régularisations guichet et pour les demandes.
 * Lève { error:'missing_fields', missing:[...] } si l’un des deux manque.
 */
function requireDateAndAmount(b) {
  const missing = [];
  const amount = Number((b && b.amount_cents) || 0);
  if (!(amount > 0)) missing.push('montant de l\'opération');
  if (!isISODate(b && b.operation_date)) missing.push('date de l\'opération');
  return { ok: missing.length === 0, missing, amount };
}

/** La date ne peut pas être dans le futur (tolérance de fuseau : +1 jour). */
function isFutureDate(iso) {
  return new Date(iso).getTime() > Date.now() + 24 * 3600 * 1000;
}

/** Vérifie le couplage terminal <-> collectrice pour chaque écriture terrain. */
async function assertDevice(req) {
  const { imei, mac } = deviceFromReq(req);
  const { rows } = await q(
    'SELECT * FROM device WHERE imei=$1 AND mac_address=$2 AND imf_id=$3',
    [imei, mac, req.user.imf_id]);
  if (!rows.length || rows[0].status !== 'active') return null;
  if (rows[0].user_id !== req.user.id) return null;
  return rows[0];
}

/**
 * Recherche d’un compte client par CODE COMPTE, CODE CLIENT ou ID client.
 * Permet à la collectrice de SÉLECTIONNER le client concerné (guichet/demandes).
 */
async function findAccount({ imfId, account_code, client_code, client_id, collectriceId }) {
  const params = [imfId];
  const cond = [];
  if (client_id) { params.push(client_id); cond.push(`c.id = $${params.length}`); }
  if (account_code) { params.push(account_code); cond.push(`a.code_account = $${params.length}`); }
  if (client_code) { params.push(client_code); cond.push(`c.code_client = $${params.length}`); }
  if (!cond.length) return null;
  const where = cond.join(' OR ');
  const { rows } = await q(
    `SELECT a.*, c.id AS client_id, c.full_name AS client_name, c.code_client,
            c.frozen_at, c.is_frozen, c.frozen_reason
       FROM account a JOIN client c ON c.id = a.client_id
      WHERE a.imf_id = $1 AND (${where}) LIMIT 1`, params);
  return rows[0] || null;
}

/* ----------------------------- Opérations ------------------------------ */

r.get('/operations', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT o.*, a.code_account, c.id AS client_id, c.full_name AS client_name
       FROM operation o
       JOIN account a ON a.id = o.account_id
       JOIN client c ON c.id = a.client_id
      WHERE o.imf_id=$1 ORDER BY o.created_at DESC LIMIT 200`, [req.user.imf_id]);
  res.json({ operations: rows });
});

/** Dépôt de collecte (impacte la caisse physique de la collectrice).
 *
 * VAGUE 5 :
 *  - contrôle du PLAFOND PAR CLIENT (journée) et du PLAFOND DE CAISSE ;
 *  - génération d’un REÇU simple (affiché 60 s côté terrain) ;
 *  - SMS automatique au client si l’IMF l’a paramétré.
 */
r.post('/operations/deposit', requireRole('agency','staff','admin_imf','direction','department','service'), async (req, res, next) => {
  try {
    const { account_code, amount_cents, reference, note } = req.body || {};
    const amount = Number(amount_cents || 0);
    if (!(amount > 0)) return res.status(400).json({ error: 'Montant invalide' });
    // Contrôle éventuel du terminal (tolérant si non fourni côté serveur web).
    const acc = (await q('SELECT * FROM account WHERE code_account=$1 AND imf_id=$2',
      [account_code, req.user.imf_id])).rows[0];
    if (!acc) return res.status(404).json({ error: 'Compte client introuvable' });
    // --- PARCOURS IMPOSÉ : profil -> compte -> premier dépôt ---------------
    // Aucun dépôt possible sans compte bancaire ouvert (étape 2 obligatoire).
    if (!acc.journey_step || acc.journey_step === 'profil_cree')
      return res.status(409).json({ error: 'account_not_opened',
        message: 'Ouvrez d\'abord le compte bancaire du client avant tout dépôt (parcours : profil → compte → premier dépôt).' });
    // Un client GELÉ ne peut faire l’objet d’aucune opération.
    try { await assertClientNotFrozen(req.user.imf_id, acc.client_id); }
    catch (e) { return res.status(e.status || 409).json({ error: e.code || 'client_frozen',
      message: e.message, detail: e.detail || null }); }

    // --- Plafonds de collecte (PAR CLIENT et CAISSE) ----------------------
    const settings = await getSettings(req.user.imf_id);
    const limits = await checkLimits({ imfId: req.user.imf_id, userId: req.user.id,
      clientId: acc.client_id, amountCents: amount, settings });
    if (!limits.ok) {
      return res.status(409).json({ error: limits.code, message: limits.message, detail: limits.detail || null });
    }

    const dev = await assertDevice(req);
    const out = await tx(async (c) => {
      const op = (await c.query(
        `INSERT INTO operation(imf_id,account_id,device_id,user_id,kind,amount_cents,status,impacts_agent_cash,reference,note)
         VALUES ($1,$2,$3,$4,'depot',$5,'valide',true,$6,$7) RETURNING *`,
        [req.user.imf_id, acc.id, dev ? dev.id : null, req.user.id, amount, reference || null, note || null])).rows[0];
      await c.query('UPDATE account SET balance_cents = balance_cents + ($1::bigint * 1) WHERE id=$2', [amount, acc.id]);
      // Le premier dépôt de référence clôt l'étape 3 du parcours imposé.
      if (acc.journey_step !== 'premier_depot')
        await c.query(`UPDATE account SET journey_step='premier_depot' WHERE id=$1`, [acc.id]);
      // Mouvement d’épargne : sert de base aux frais de collecte mobile du mois.
      const bal = (await c.query('SELECT balance_cents FROM account WHERE id=$1', [acc.id])).rows[0].balance_cents;
      await c.query(
        `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,
               source,source_id,label,device_id,user_id)
         VALUES ($1,$2,1,$3,$4,'operation',$5,$6,$7,$8)`,
        [req.user.imf_id, acc.id, amount, bal, op.id, 'Dépôt ' + (reference || ''), dev ? dev.id : null, req.user.id]);

      // --- REÇU simple (numéro généré, affiché 60 s côté terrain) --------
      const cli = (await c.query('SELECT id, full_name, phone FROM client WHERE id=$1', [acc.client_id])).rows[0] || {};
      const rc = await issueReceipt(c, { imfId: req.user.imf_id, operationId: op.id,
        clientId: acc.client_id, accountId: acc.id, userId: req.user.id, amountCents: amount,
        balanceAfterCents: bal, clientName: cli.full_name, clientPhone: cli.phone, settings });
      await c.query('UPDATE operation SET receipt_id=$1 WHERE id=$2', [rc.receipt.id, op.id]);
      return { op, rc, cli, bal };
    });

    // SMS client : hors transaction (le journal SMS ne doit pas bloquer le dépôt).
    let sms = { sent: false, status: 'desactive' };
    try {
      sms = await sendClientSms({ imfId: req.user.imf_id, clientId: acc.client_id,
        receiptId: out.rc.receipt.id, operationId: out.op.id, phone: out.rc.smsNumber,
        sender: out.rc.sender, body: out.rc.smsBody, enabled: out.rc.smsEnabled });
    } catch (e) { sms = { sent: false, status: 'echec' }; }

    res.status(201).json({ operation: out.op, receipt: {
        id: out.rc.receipt.id, code_receipt: out.rc.receipt.code_receipt,
        amount_cents: out.rc.receipt.amount_cents, balance_after_cents: out.rc.receipt.balance_after_cents,
        display_seconds: out.rc.receipt.display_seconds, created_at: out.rc.receipt.created_at,
        client_name: out.cli.full_name || null },
      sms: { sent: sms.sent, status: sms.status, number: out.rc.smsNumber || null, sender: out.rc.sender || null } });
  } catch (e) { next(e); }
});

/**
 * Régularisation guichet : impacte le solde client mais PAS la caisse physique
 * de la collectrice (impacts_agent_cash = false). direction=+1 dépôt, -1 retrait.
 *
 * VALIDATION STRICTE : la DATE DE L’OPÉRATION et le MONTANT sont OBLIGATOIRES.
 */
r.post('/operations/guichet-regularization', requireRole('agency','staff','admin_imf','direction','department','service'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const dir = Number(b.direction || 0);

    // 1) Date + montant obligatoires (validation stricte côté serveur).
    const chk = requireDateAndAmount(b);
    if (!chk.ok) return res.status(400).json({ error: 'missing_fields', missing: chk.missing,
      message: 'La date de l’opération et le montant sont obligatoires.' });
    const amount = chk.amount;

    // 2) Sens obligatoire.
    if (![1, -1].includes(dir)) return res.status(400).json({ error: 'missing_fields', missing: ['sens de l\'opération'],
      message: 'Précisez le sens de l’opération (dépôt ou retrait).' });

    // 3) Date non future.
    if (isFutureDate(b.operation_date))
      return res.status(400).json({ error: 'date_invalide', message: 'La date de l’opération ne peut pas être dans le futur.' });

    // 4) SÉLECTION DU CLIENT : par identifiant client, code client ou code compte.
    const acc = await findAccount({ imfId: req.user.imf_id, account_code: b.account_code,
      client_code: b.client_code, client_id: b.client_id });
    if (!acc) return res.status(404).json({ error: 'client_introuvable',
      message: 'Sélectionnez un client valide (recherche par nom, code client ou code compte).' });

    // 5) Client gelé -> opération bloquée.
    if (isFrozen(acc)) return res.status(409).json({ error: 'client_frozen',
      message: 'Client gelé : régularisation bloquée jusqu’au dégel par le superviseur.',
      detail: { frozen_reason: acc.frozen_reason, frozen_at: acc.frozen_at } });

    const out = await tx(async (c) => {
      const op = (await c.query(
        `INSERT INTO operation(imf_id,account_id,client_id,user_id,kind,amount_cents,status,impacts_agent_cash,
               direction,reference,note,operation_date)
         VALUES ($1,$2,$3,$4,'retrait_regul',$5,'valide',false,$6,$7,$8,$9) RETURNING *`,
        [req.user.imf_id, acc.id, acc.client_id, req.user.id, amount, dir,
         b.reference || null, b.note || null, b.operation_date])).rows[0];
      await c.query('UPDATE account SET balance_cents = balance_cents + ($1::bigint * $2::int) WHERE id=$3',
        [amount, dir, acc.id]);
      return op;
    });
    res.status(201).json({ operation: out, impacts_agent_cash: false, client: {
      id: acc.client_id, code_client: acc.code_client, full_name: acc.client_name },
      note: 'Régularisation guichet enregistrée (date : ' + b.operation_date + ').' });
  } catch (e) { next(e); }
});

/** Recherche de client pour la collectrice (régularisation, demande de crédit…). */
r.get('/clients/search', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const Q = String(req.query.q || '').trim();
    const me = req.user;
    // Une collectrice ne voit que ses propres clients ; les profils de supervision voient l’IMF.
    const field = ['staff'].includes(me.role);
    const params = [me.imf_id];
    let where = 'c.imf_id=$1';
    if (field) { params.push(me.id); where += ` AND c.collectrice_user_id=$${params.length}`; }
    if (Q) {
      params.push('%' + Q + '%');
      const i = params.length;
      where += ` AND (c.full_name ILIKE $${i} OR c.code_client ILIKE $${i} OR a.code_account ILIKE $${i} OR c.phone ILIKE $${i} OR e.sig_account_no ILIKE $${i})`;
    }
    const { rows } = await q(
      `SELECT c.id, c.code_client, c.full_name, c.phone, c.origin,
              c.frozen_at, c.is_frozen,
              a.code_account, a.balance_cents, a.currency, a.status AS account_status,
              e.sig_account_no, e.status AS enrollment_status
         FROM client c
         LEFT JOIN account a ON a.client_id = c.id
         LEFT JOIN client_enrollment e ON e.client_id = c.id
        WHERE ${where}
        ORDER BY c.full_name LIMIT 30`, params);
    res.json({ clients: rows.map((x) => ({ ...x, frozen: !!x.frozen_at || x.is_frozen === true })),
      count: rows.length });
  } catch (e) { next(e); }
});

/** Historique des opérations pour une collectrice (aujourd’hui ou période). */
r.get('/operations/mine', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT o.*, a.code_account, c.id AS client_id, c.full_name AS client_name
       FROM operation o
       JOIN account a ON a.id = o.account_id
       JOIN client c ON c.id = a.client_id
      WHERE o.imf_id=$1 AND o.user_id=$2
      ORDER BY o.created_at DESC LIMIT 100`, [req.user.imf_id, req.user.id]);
  res.json({ operations: rows });
});

/**
 * Demande d’annulation d’une opération : reste EN ATTENTE de validation du
 * superviseur. Le solde n’est PAS modifié tant que ce n’est pas validé.
 */
r.post('/operations/:id/cancel-request', requireRole('agency','staff','admin_imf','direction','department','service'), async (req, res) => {
  const { reason } = req.body || {};
  const { rows } = await q(
    `UPDATE operation SET status='en_attente', cancel_requested_at=now(), cancel_reason=$3
      WHERE id=$1 AND imf_id=$2 AND status IN ('valide') RETURNING *`,
    [req.params.id, req.user.imf_id, reason || null]);
  if (!rows.length) return res.status(404).json({ error: 'Opération introuvable ou déjà en attente' });
  res.json({ operation: rows[0], note: 'Solde inchangé — en attente de validation superviseur' });
});

/** Validation/refus par le superviseur : ajuste le solde seulement à la validation. */
r.post('/operations/:id/cancel-validate', requireRole('admin_imf','direction','department','service'), async (req, res) => {
  const { approve } = req.body || {};
  const op = (await q('SELECT * FROM operation WHERE id=$1 AND imf_id=$2',
    [req.params.id, req.user.imf_id])).rows[0];
  if (!op) return res.status(404).json({ error: 'Opération introuvable' });
  if (op.status !== 'en_attente') return res.status(409).json({ error: 'Opération non en attente' });
  const out = await tx(async (c) => {
    if (approve) {
      // Annulation validée : on inverse l’effet sur le solde client.
      const sign = op.kind === 'depot' ? -1 : (op.direction === 1 ? -1 : 1);
      await c.query('UPDATE account SET balance_cents = balance_cents + ($1::bigint * $2::bigint) WHERE id=$3',
        [Math.abs(Number(op.amount_cents)), sign, op.account_id]);
    }
    const upd = (await c.query(
      `UPDATE operation SET status=$1, validated_by=$2, validated_at=now() WHERE id=$3 RETURNING *`,
      [approve ? 'annule' : 'valide', req.user.id, op.id])).rows[0];
    return upd;
  });
  res.json({ operation: out });
});

/**
 * Demande de crédit saisie par la collectrice.
 * VALIDATION STRICTE : le client, la DATE ET LE MONTANT sont obligatoires.
 */
r.post('/operations/credit-request', requireRole('agency','staff','admin_imf','direction','department','service'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // 1) Date + montant obligatoires.
    const chk = requireDateAndAmount(b);
    if (!chk.ok) return res.status(400).json({ error: 'missing_fields', missing: chk.missing,
      message: 'La date de l’opération et le montant sont obligatoires.' });
    // 2) Autres champs obligatoires de la demande.
    const required = ['purpose', 'duration_months', 'activity', 'id_verified'];
    const missing = required.filter((k) => !b[k]);
    if (!b.client_id && !b.client_code) missing.push('client');
    if (missing.length) return res.status(400).json({ error: 'missing_fields', missing,
      message: 'Informations obligatoires manquantes.' });
    if (isFutureDate(b.operation_date))
      return res.status(400).json({ error: 'date_invalide', message: 'La date ne peut pas être dans le futur.' });

    // 3) Sélection du client (id, code client ou code compte).
    const acc = await findAccount({ imfId: req.user.imf_id, account_code: b.client_code,
      client_code: b.client_code, client_id: b.client_id });
    if (!acc) return res.status(404).json({ error: 'client_introuvable',
      message: 'Sélectionnez un client valide.' });
    if (isFrozen(acc)) return res.status(409).json({ error: 'client_frozen',
      message: 'Client gelé : demande bloquée jusqu’au dégel par le superviseur.',
      detail: { frozen_reason: acc.frozen_reason, frozen_at: acc.frozen_at } });

    const dev = await assertDevice(req);
    const op = (await q(
      `INSERT INTO operation(imf_id,account_id,client_id,device_id,user_id,kind,amount_cents,status,
             impacts_agent_cash,operation_date,note)
       VALUES ($1,$2,$3,$4,$5,'credit_request',$6,'en_attente',false,$7,$8) RETURNING *`,
      [req.user.imf_id, acc.id, acc.client_id, dev ? dev.id : null, req.user.id, chk.amount,
       b.operation_date, JSON.stringify({
         purpose: b.purpose, duration_months: b.duration_months, activity: b.activity,
         id_verified: b.id_verified, collateral: b.collateral || null, comments: b.comments || null
       })])).rows[0];
    res.status(201).json({ request: op });
  } catch (e) { next(e); }
});

/**
 * Demande personnalisée (type de demande créé par l’admin).
 * VALIDATION STRICTE : le client, la DATE ET LE MONTANT sont obligatoires.
 */
r.post('/operations/request', requireRole('agency','staff','admin_imf','direction','department','service'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const chk = requireDateAndAmount(b);
    if (!chk.ok) return res.status(400).json({ error: 'missing_fields', missing: chk.missing,
      message: 'La date de l’opération et le montant sont obligatoires.' });
    if (!b.client_id && !b.client_code) return res.status(400).json({ error: 'missing_fields',
      missing: ['client'], message: 'Sélectionnez le client concerné.' });
    if (!b.request_type_code && !b.request_type_id && !b.request_type) return res.status(400).json({ error: 'missing_fields',
      missing: ['type de demande'], message: 'Précisez le type de demande.' });
    if (isFutureDate(b.operation_date))
      return res.status(400).json({ error: 'date_invalide', message: 'La date ne peut pas être dans le futur.' });

    const acc = await findAccount({ imfId: req.user.imf_id, account_code: b.account_code,
      client_code: b.client_code, client_id: b.client_id });
    if (!acc) return res.status(404).json({ error: 'client_introuvable', message: 'Sélectionnez un client valide.' });
    if (isFrozen(acc)) return res.status(409).json({ error: 'client_frozen',
      message: 'Client gelé : demande bloquée jusqu’au dégel par le superviseur.',
      detail: { frozen_reason: acc.frozen_reason, frozen_at: acc.frozen_at } });

    const op = (await q(
      `INSERT INTO operation(imf_id,account_id,client_id,user_id,kind,amount_cents,status,
             impacts_agent_cash,operation_date,note)
       VALUES ($1,$2,$3,$4,'request',$5,'en_attente',false,$6,$7) RETURNING *`,
      [req.user.imf_id, acc.id, acc.client_id, req.user.id, chk.amount, b.operation_date,
       JSON.stringify({ request_type_code: b.request_type_code || b.request_type || null, request_type_id: b.request_type_id || null,
         purpose: b.purpose || null, label: b.label || b.purpose || null, detail: b.detail || null })])).rows[0];
    res.status(201).json({ request: op });
  } catch (e) { next(e); }
});

/** Liste des demandes de crédit en attente (back-office superviseur). */
r.get('/credit-requests', requireRole('admin_imf','direction','department','service'), async (req, res) => {
  const { rows } = await q(
    `SELECT o.*, a.code_account, c.id AS client_id, c.full_name AS client_name
       FROM operation o JOIN account a ON a.id=o.account_id JOIN client c ON c.id=a.client_id
      WHERE o.imf_id=$1 AND o.kind='credit_request' ORDER BY o.created_at DESC`, [req.user.imf_id]);
  res.json({ requests: rows });
});

/* ------------------- État d’essai / abonnement ------------------------- */

r.get('/subscription/status', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const sub = await ensureSubscription(req.user.imf_id);
  res.json(computeState(sub));
});

export default r;
