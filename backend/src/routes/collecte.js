import { Router } from 'express';
import { habilit } from '../rbac_strict.js';
import { q, tx } from '../db.js';
import { requireRole, canViewTeamData } from '../auth.js';
import { getSettings, readSettings, saveSettings, collectriceCashBalance,
  clientCollectedToday, CHANNELS_FR } from '../collecte.js';

/**
 * VAGUE 5 — Collecte : plafonds, versements (caisse / Mobile Money),
 * reçus simples et journaux SMS.
 *
 * Rôles :
 *  - admin_imf / direction : paramètrent les plafonds et le numéro SMS ;
 *  - caissier / admin_imf : valident ou rejettent les versements déclarés ;
 *  - collectrice (agency/staff/service/department) : consultent leur solde de
 *    caisse et déclarent un versement.
 */
const r = Router();
const READ_ROLES = ['admin_imf','direction','department','service','agency','staff','caissier'];
const WRITE_ROLES = ['admin_imf','direction'];
const DECLARE_ROLES = ['agency','staff','service','department','admin_imf','direction'];
const VALIDATE_ROLES = ['caissier','admin_imf','direction'];
// Postes pouvant superviser des collectrices (rapports de caisse remontés).
const SUP_REPORT_ROLES = ['admin_imf','direction','department','service','agency'];

/* ------------------------------ Paramètres ------------------------------- */

/** Lire les paramètres de collecte (plafonds, SMS, compte MoMo de l’IMF). */
r.get('/collecte/settings', requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const s = await readSettings(req.user.imf_id);
    res.json({ settings: s, channels: CHANNELS_FR });
  } catch (e) { next(e); }
});

/** Enregistrer les paramètres de collecte (admin IMF / direction). */
r.post('/collecte/settings', requireRole(...WRITE_ROLES), habilit('round.manage','collecte.assign'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // Validation douce des montants (en centimes).
    for (const k of ['max_cash_cents', 'max_client_daily_cents']) {
      if (b[k] != null && b[k] !== '' && (Number(b[k]) < 0 || !Number.isFinite(Number(b[k]))))
        return res.status(422).json({ error: 'invalid_amount', field: k });
    }
    if (b.momo_provider && !['orange_money','moov_money','wave','autre'].includes(b.momo_provider))
      return res.status(422).json({ error: 'invalid_momo_provider' });
    const s = await saveSettings(req.user.imf_id, req.user.id, b);
    res.json({ ok: true, settings: s });
  } catch (e) { next(e); }
});

/* ------------------------------- Caisse ---------------------------------- */

/**
 * Solde de caisse de la collectrice + état des plafonds.
 * ?user_id=… permet à l’admin de consulter la caisse d’une collectrice.
 */
r.get('/collecte/cash', requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const s = await getSettings(req.user.imf_id);
    const targetId = (req.query.user_id && [...WRITE_ROLES, 'caissier'].includes(req.user.role))
      ? req.query.user_id : req.user.id;
    const bal = await collectriceCashBalance(req.user.imf_id, targetId);
    const cap = s.max_cash_cents == null ? null : Number(s.max_cash_cents);
    const transferRequired = cap != null && cap > 0 && bal.balance_cents >= cap;
    let collectrice = null;
    if (targetId !== req.user.id) {
      const u = (await q('SELECT full_name, email, code_user FROM app_user WHERE id=$1 AND imf_id=$2',
        [targetId, req.user.imf_id])).rows[0];
      collectrice = u ? { id: targetId, full_name: u.full_name, email: u.email, code_user: u.code_user } : null;
    }
    res.json({
      user_id: targetId,
      collectrice,
      balance_cents: bal.balance_cents,
      deposits_cents: bal.deposits_cents,
      transfers_cents: bal.transfers_cents,
      max_cash_cents: cap,
      remaining_cents: cap == null ? null : Math.max(0, cap - bal.balance_cents),
      over_cents: cap == null ? 0 : Math.max(0, bal.balance_cents - cap),
      transfer_required: transferRequired,
      momo_deposit_number: s.momo_deposit_number,
      momo_provider: s.momo_provider,
      sms_enabled: !!s.sms_enabled,
      sms_sender_number: s.sms_sender_number
    });
  } catch (e) { next(e); }
});

/**
 * Déclarer un versement :
 *  - channel = 'caisse_caissiere' : remise des espèces à la caissière ;
 *  - channel = 'mobile_money'      : transfert sur le compte MoMo de l’IMF
 *    (les RÉFÉRENCES de transfert sont OBLIGATOIRES).
 */
r.post('/collecte/cash-deposits', requireRole(...DECLARE_ROLES), habilit('cash.declare'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = Number(b.amount_cents || 0);
    const channel = b.channel || 'caisse_caissiere';
    if (!(amount > 0)) return res.status(400).json({ error: 'invalid_amount', message: 'Montant invalide.' });
    if (!['caisse_caissiere','mobile_money'].includes(channel))
      return res.status(422).json({ error: 'invalid_channel', channels: CHANNELS_FR });

    const s = await getSettings(req.user.imf_id);
    const bal = await collectriceCashBalance(req.user.imf_id, req.user.id);
    if (amount > bal.balance_cents)
      return res.status(409).json({ error: 'amount_exceeds_cash',
        message: 'Le montant dépasse votre solde de caisse (' + (bal.balance_cents / 100).toLocaleString('fr-FR') + ' FCFA).',
        detail: { balance_cents: bal.balance_cents } });

    let momoProvider = null, momoNumber = null, transferRef = null, transferDate = null, proofNote = null;
    if (channel === 'mobile_money') {
      transferRef = (b.transfer_ref || '').trim();
      if (!transferRef) return res.status(400).json({ error: 'transfer_ref_required',
        message: 'Saisissez la référence du transfert Mobile Money.' });
      momoProvider = b.momo_provider || s.momo_provider || null;
      momoNumber = b.momo_number || s.momo_deposit_number || null;
      transferDate = b.transfer_date && /^\d{4}-\d{2}-\d{2}$/.test(b.transfer_date) ? b.transfer_date : new Date().toISOString().slice(0, 10);
      proofNote = b.proof_note || null;
    } else {
      proofNote = b.proof_note || null;
    }

    const out = await tx(async (c) => {
      const dep = (await c.query(
        `INSERT INTO cash_deposit(imf_id,collectrice_user_id,channel,amount_cents,status,
                momo_provider,momo_number,transfer_ref,transfer_date,proof_note)
         VALUES ($1,$2,$3,$4,'declare',$5,$6,$7,$8,$9) RETURNING *`,
        [req.user.imf_id, req.user.id, channel, amount, momoProvider, momoNumber,
         transferRef, transferDate, proofNote])).rows[0];
      return dep;
    });
    res.status(201).json({ ok: true, cash_deposit: out, channel_label: CHANNELS_FR[channel],
      message: channel === 'mobile_money'
        ? 'Versement Mobile Money déclaré. En attente de validation par la caissière.'
        : 'Versement à la caisse déclaré. Remettez les espèces à la caissière.' });
  } catch (e) { next(e); }
});

/** Lister les versements (la collectrice voit les siens, la caissière/admin voit tout). */
r.get('/collecte/cash-deposits', requireRole(...READ_ROLES), async (req, res, next) => {
  const scope = canViewTeamData(req.user.role)
    ? [req.user.imf_id, null] : [req.user.imf_id, req.user.id];
  const status = req.query.status || null;
  const { rows } = await q(
    `SELECT cd.*, u.full_name AS collectrice_name, v.full_name AS validated_by_name
       FROM cash_deposit cd
       LEFT JOIN app_user u ON u.id = cd.collectrice_user_id
       LEFT JOIN app_user v ON v.id = cd.validated_by
      WHERE cd.imf_id=$1 AND ($2::uuid IS NULL OR cd.collectrice_user_id=$2)
        AND ($3::text IS NULL OR cd.status=$3)
      ORDER BY cd.created_at DESC LIMIT 200`,
    [scope[0], scope[1], status]);
  res.json({ cash_deposits: rows, channels: CHANNELS_FR });
});

/**
 * RAPPORTS DE CAISSE REMONTÉS AU SUPERVISEUR.
 * Une Collectrice mobile pousse ses rapports de caisse vers son superviseur :
 * ce dernier voit ici les versements déclarés par les collectrices qu'il
 * supervise. Le lien de supervision est déduit de la chaîne de collecte
 * (client.superviseur_user_id = req.user.id -> collectrices rattachées),
 * en respectant strictement le cloisonnement imf_id.
 */
r.get('/collecte/supervisor-reports', requireRole(...SUP_REPORT_ROLES), async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const { rows } = await q(
      `SELECT cd.*, u.full_name AS collectrice_name, v.full_name AS validated_by_name
         FROM cash_deposit cd
         JOIN app_user u ON u.id = cd.collectrice_user_id
         LEFT JOIN app_user v ON v.id = cd.validated_by
        WHERE cd.imf_id=$1
          AND cd.collectrice_user_id IN (
                SELECT DISTINCT cl.collectrice_user_id
                  FROM client cl
                 WHERE cl.imf_id=$1 AND cl.superviseur_user_id=$2
                   AND cl.collectrice_user_id IS NOT NULL)
          AND ($3::text IS NULL OR cd.status=$3)
        ORDER BY cd.created_at DESC LIMIT 300`,
      [req.user.imf_id, req.user.id, status]);
    res.json({ cash_deposits: rows, channels: CHANNELS_FR });
  } catch (e) { next(e); }
});

/** Valider ou rejeter un versement (caissière / admin IMF). */
r.post('/collecte/cash-deposits/:id/validate', requireRole(...VALIDATE_ROLES), habilit('cash.validate','cash.approve'), async (req, res, next) => {
  try {
    const decision = (req.body && req.body.decision) || 'valide';
    if (!['valide','rejete'].includes(decision))
      return res.status(422).json({ error: 'invalid_decision', allowed: ['valide','rejete'] });
    const out = await tx(async (c) => {
      const dep = (await c.query('SELECT * FROM cash_deposit WHERE id=$1 AND imf_id=$2 FOR UPDATE',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!dep) { const e = new Error('Versement introuvable.'); e.status = 404; throw e; }
      if (dep.status !== 'declare') { const e = new Error('Ce versement a déjà été traité.'); e.status = 409; e.code='already_handled'; throw e; }
      // SÉPARATION DES TÂCHES (anti-fraude) : celui qui a DÉCLARÉ le versement ne
      // peut pas le valider lui-même. Empêche l'auto-approbation d'un encaissement.
      const declarant = dep.collectrice_user_id || null;
      const isAdmin = ['admin_imf'].includes(req.user.role);
      if (declarant && String(declarant) === String(req.user.id) && !isAdmin) {
        const e = new Error('Vous ne pouvez pas valider un versement que vous avez vous-même déclaré (séparation des tâches).');
        e.status = 403; e.code = 'sod_self_validation'; throw e;
      }
      const upd = (await c.query(
        `UPDATE cash_deposit SET status=$2, validated_by=$3, validated_at=now(),
                rejected_reason=$4 WHERE id=$1 RETURNING *`,
        [dep.id, decision, req.user.id, decision === 'rejete' ? ((req.body && req.body.reason) || null) : null])).rows[0];
      return upd;
    });
    res.json({ ok: true, cash_deposit: out,
      message: decision === 'valide' ? 'Versement validé.' : 'Versement rejeté.' });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message }); next(e); }
});

/* -------------------------------- Reçus ---------------------------------- */

/** Détail d’un reçu (par id ou par numéro de reçu). */
r.get('/collecte/receipts/:id', requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const byCode = /^RC-/.test(req.params.id);
    const { rows } = await q(
      `SELECT r.*, c.full_name AS client_name, c.code_client,
              a.code_account, u.full_name AS collectrice_name
         FROM receipt r
         LEFT JOIN client c ON c.id = r.client_id
         LEFT JOIN account a ON a.id = r.account_id
         LEFT JOIN app_user u ON u.id = r.collectrice_user_id
        WHERE r.imf_id=$1 AND ${byCode ? 'r.code_receipt=$2' : 'r.id=$2'}`,
      [req.user.imf_id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Receipt introuvable' });
    res.json({ receipt: rows[0] });
  } catch (e) { next(e); }
});

/** Derniers reçus de la collectrice (pratique pour retrouver un reçu). */
r.get('/collecte/receipts', requireRole(...READ_ROLES), async (req, res) => {
  const scope = canViewTeamData(req.user.role)
    ? [req.user.imf_id, null] : [req.user.imf_id, req.user.id];
  const { rows } = await q(
    `SELECT r.*, c.full_name AS client_name, c.code_client
       FROM receipt r LEFT JOIN client c ON c.id = r.client_id
      WHERE r.imf_id=$1 AND ($2::uuid IS NULL OR r.collectrice_user_id=$2)
      ORDER BY r.created_at DESC LIMIT 100`, [scope[0], scope[1]]);
  res.json({ receipts: rows });
});

/* ------------------------- Journal SMS clients --------------------------- */

/** Journal des SMS envoyés aux clients (admin IMF / direction). */
r.get('/collecte/sms-log', requireRole('admin_imf','direction','department','service'), async (req, res) => {
  const { rows } = await q(
    `SELECT s.*, c.full_name AS client_name, c.code_client
       FROM client_sms_log s LEFT JOIN client c ON c.id = s.client_id
      WHERE s.imf_id=$1 ORDER BY s.created_at DESC LIMIT 200`, [req.user.imf_id]);
  res.json({ sms_log: rows });
});

/**
 * Contexte client pour le terrain : solde de caisse, plafonds, montant déjà
 * collecté aujourd’hui auprès de ce client (utile avant de saisir un dépôt).
 */
r.get('/collecte/client-context/:clientId', requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const s = await getSettings(req.user.imf_id);
    const collected = await clientCollectedToday(req.user.imf_id, req.params.clientId);
    const capC = s.max_client_daily_cents == null ? null : Number(s.max_client_daily_cents);
    res.json({ client_id: req.params.clientId, collected_today_cents: collected,
      max_client_daily_cents: capC,
      remaining_cents: capC == null ? null : Math.max(0, capC - collected),
      client_limit_reached: capC != null && capC > 0 && collected >= capC });
  } catch (e) { next(e); }
});

export default r;
