import { Router } from 'express';
import { q, tx } from '../db.js';
import { requireRole, requirePermission, userHasPermission } from '../auth.js';
import {
  monthBounds, monthsStarted, computeCollectionFee, computeEarlyWithdrawalFee,
  chargeFee, recoverPendingFees, monthDeposits, minPermanentOf, isLastDayOfMonth, lastDayOfMonth,
} from '../fees.js';

const r = Router();

/* ===========================================================================
 * teebo — PRODUITS D'ÉPARGNE (spécifications IMF), FRAIS, RETRAIT ANTICIPÉ,
 *          DEMANDES PERSONNALISÉES ET DOSSIERS DE CRÉDIT
 * ========================================================================= */

const ADM   = ['admin_imf', 'direction'];
const SUP   = ['admin_imf', 'direction', 'department', 'service'];
const STAFF = ['admin_imf', 'direction', 'department', 'service', 'agency', 'staff'];
const OFFICER = ['admin_imf', 'direction', 'department', 'service'];  // Agent de crédit

const NATURES  = ['a_vue', 'bloquee', 'contractuelle'];
const TARGETS  = ['particuliers', 'commercants', 'groupements_feminins', 'jeunes', 'agriculteurs'];
const I_METHOD = ['solde_moyen', 'quinzaine', 'capitalise'];
const I_PERIOD = ['mensuelle', 'trimestrielle', 'semestrielle', 'annuelle'];
const W_PERIOD = ['a_vue', 'mensuelle', 'quinzaine', 'terme'];
const CF_MODE  = ['fixe', 'par_tranche', 'pourcentage'];

function int(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }

/* ------------------------------------------------------------------ */
/*  Types de compte d'épargne : catalogue complet (spécifications IMF)  */
/* ------------------------------------------------------------------ */
r.get('/savings-products', requireRole(...STAFF), async (req, res) => {
  const { rows } = await q(
    `SELECT code,label,description,is_active,
            nature,targets,
            opening_fee_cents,subscription_fee_cents,min_permanent_cents,
            min_opening_deposit_cents,min_deposit_cents,
            interest_rate_bp,interest_method,interest_period,
            withdrawal_period,closing_fee_cents,account_keeping_fee_cents,
            early_withdrawal_fee_bp,early_withdrawal_exempt_new_deposits,
            collection_fee_mode,collection_fee_fixed_cents,collection_fee_bp,collection_fee_tranches,
            min_balance_cents,requires_kyc_complete
       FROM savings_product WHERE is_active=true ORDER BY sort_order`);
  res.json({ products: rows });
});

/* ------------------------------------------------------------------ */
/*  Souscription d'un compte à un type d'épargne                        */
/*  Un compte est créé à l'ouverture du client ; on lui affecte ensuite  */
/*  le produit d'épargne choisi (frais de tenue, intérêts, commissions). */
/* ------------------------------------------------------------------ */
r.post('/accounts/:id/product', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String(b.product_code || '').trim().toLowerCase();
    if (!code) return res.status(400).json({ error: 'savings_product_required' });
    const out = await tx(async (c) => {
      const prod = (await c.query(
        'SELECT * FROM savings_product WHERE code=$1 AND is_active=true', [code])).rows[0];
      if (!prod) { const e = new Error('savings_product_inconnu'); e.status = 400; throw e; }
      const acc = (await c.query('SELECT * FROM account WHERE id=$1 AND imf_id=$2',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }
      if (acc.status === 'blocked') { const e = new Error('compte_bloque'); e.status = 409; throw e; }
      const upd = (await c.query(
        'UPDATE account SET product_code=$1 WHERE id=$2 RETURNING *', [prod.code, acc.id])).rows[0];
      return { account: upd, product: prod };
    });
    res.json({
      account: { id: out.account.id, code_account: out.account.code_account, product_code: out.account.product_code },
      savings_product: { code: out.product.code, label: out.product.label, nature: out.product.nature,
        interest_rate_bp: out.product.interest_rate_bp, interest_method: out.product.interest_method,
        account_keeping_fee_cents: out.product.account_keeping_fee_cents,
        collection_fee_mode: out.product.collection_fee_mode,
        early_withdrawal_fee_bp: out.product.early_withdrawal_fee_bp },
      note: 'Le compte est désormais régi par ce type d\'épargne.'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Création / mise à jour d'un type d'épargne (admin)                  */
/* ------------------------------------------------------------------ */
r.post('/savings-products', requireRole(...ADM), async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim().toLowerCase();
    if (!code || !b.label) return res.status(400).json({ error: 'missing_fields', missing: ['code', 'label'] });
    if (b.nature && !NATURES.includes(b.nature)) return res.status(400).json({ error: 'nature_invalide', allowed: NATURES });
    if (b.interest_method && !I_METHOD.includes(b.interest_method)) return res.status(400).json({ error: 'mode_calcul_invalide', allowed: I_METHOD });
    if (b.interest_period && !I_PERIOD.includes(b.interest_period)) return res.status(400).json({ error: 'periodicite_invalide', allowed: I_PERIOD });
    if (b.withdrawal_period && !W_PERIOD.includes(b.withdrawal_period)) return res.status(400).json({ error: 'periodicite_retrait_invalide', allowed: W_PERIOD });
    if (b.collection_fee_mode && !CF_MODE.includes(b.collection_fee_mode)) return res.status(400).json({ error: 'mode_frais_collecte_invalide', allowed: CF_MODE });
    const targets = Array.isArray(b.targets) ? b.targets.filter((t) => TARGETS.includes(t)) : ['particuliers'];

    const row = (await q(
      `INSERT INTO savings_product(code,label,description,is_active,nature,targets,
             opening_fee_cents,subscription_fee_cents,min_permanent_cents,
             min_opening_deposit_cents,min_deposit_cents,
             interest_rate_bp,interest_method,interest_period,
             withdrawal_period,closing_fee_cents,account_keeping_fee_cents,
             early_withdrawal_fee_bp,early_withdrawal_exempt_new_deposits,
             collection_fee_mode,collection_fee_fixed_cents,collection_fee_bp,collection_fee_tranches,
             min_balance_cents,requires_kyc_complete,sort_order)
       VALUES ($1,$2,$3,true,$4,$5::savings_target[],$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$8,$23,
               COALESCE((SELECT MAX(sort_order)+1 FROM savings_product),1))
       ON CONFLICT (code) DO UPDATE SET
             label=EXCLUDED.label, description=EXCLUDED.description, nature=EXCLUDED.nature,
             targets=EXCLUDED.targets, opening_fee_cents=EXCLUDED.opening_fee_cents,
             subscription_fee_cents=EXCLUDED.subscription_fee_cents, min_permanent_cents=EXCLUDED.min_permanent_cents,
             min_opening_deposit_cents=EXCLUDED.min_opening_deposit_cents, min_deposit_cents=EXCLUDED.min_deposit_cents,
             interest_rate_bp=EXCLUDED.interest_rate_bp, interest_method=EXCLUDED.interest_method,
             interest_period=EXCLUDED.interest_period, withdrawal_period=EXCLUDED.withdrawal_period,
             closing_fee_cents=EXCLUDED.closing_fee_cents, account_keeping_fee_cents=EXCLUDED.account_keeping_fee_cents,
             early_withdrawal_fee_bp=EXCLUDED.early_withdrawal_fee_bp,
             early_withdrawal_exempt_new_deposits=EXCLUDED.early_withdrawal_exempt_new_deposits,
             collection_fee_mode=EXCLUDED.collection_fee_mode,
             collection_fee_fixed_cents=EXCLUDED.collection_fee_fixed_cents,
             collection_fee_bp=EXCLUDED.collection_fee_bp, collection_fee_tranches=EXCLUDED.collection_fee_tranches,
             requires_kyc_complete=EXCLUDED.requires_kyc_complete, is_active=true
       RETURNING *`,
      [code, b.label, b.description || null, b.nature || 'a_vue', targets,
       int(b.opening_fee_cents), int(b.subscription_fee_cents), int(b.min_permanent_cents),
       int(b.min_opening_deposit_cents), int(b.min_deposit_cents),
       int(b.interest_rate_bp), b.interest_method || 'solde_moyen', b.interest_period || 'annuelle',
       b.withdrawal_period || 'a_vue', int(b.closing_fee_cents), int(b.account_keeping_fee_cents),
       int(b.early_withdrawal_fee_bp), b.early_withdrawal_exempt_new_deposits !== false,
       b.collection_fee_mode || 'pourcentage', int(b.collection_fee_fixed_cents), int(b.collection_fee_bp),
       JSON.stringify(Array.isArray(b.collection_fee_tranches) ? b.collection_fee_tranches : []),
       b.requires_kyc_complete === true])).rows[0];
    res.status(201).json({ product: row });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Types de demande personnalisés (admin, infinité) + frais fixes      */
/* ------------------------------------------------------------------ */
r.get('/request-types', requireRole(...STAFF), async (req, res) => {
  const { rows } = await q(
    `SELECT id,code,label,description,fee_cents,requires_doc,is_active,sort_order
       FROM request_type WHERE imf_id=$1 ORDER BY sort_order, label`, [req.user.imf_id]);
  res.json({ request_types: rows });
});

r.post('/request-types', requireRole(...ADM), async (req, res, next) => {
  try {
    const b = req.body || {};
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: 'missing_field', field: 'label' });
    const code = String(b.code || '').trim().toLowerCase() ||
      label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const row = (await q(
      `INSERT INTO request_type(imf_id,code,label,description,fee_cents,requires_doc,created_by,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT MAX(sort_order)+1 FROM request_type WHERE imf_id=$1),1))
       ON CONFLICT (imf_id,code) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description,
             fee_cents=EXCLUDED.fee_cents, requires_doc=EXCLUDED.requires_doc, is_active=true
       RETURNING *`,
      [req.user.imf_id, code, label, b.description || null, int(b.fee_cents), b.requires_doc === true, req.user.id])).rows[0];
    res.status(201).json({ request_type: row });
  } catch (e) { next(e); }
});

r.delete('/request-types/:id', requireRole(...ADM), async (req, res) => {
  const r0 = (await q(
    `UPDATE request_type SET is_active=false WHERE id=$1 AND imf_id=$2 RETURNING id`,
    [req.params.id, req.user.imf_id])).rows[0];
  if (!r0) return res.status(404).json({ error: 'type_introuvable' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Demande client : les frais sont DÉBITÉS À LA SOURCE sur son compte  */
/* ------------------------------------------------------------------ */
r.post('/client-requests', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await tx(async (c) => {
      const rt = (await c.query(
        'SELECT * FROM request_type WHERE id=$1 AND imf_id=$2 AND is_active=true',
        [b.request_type_id, req.user.imf_id])).rows[0];
      if (!rt) { const e = new Error('type_de_demande_introuvable'); e.status = 404; throw e; }
      const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
        [b.client_id, req.user.imf_id])).rows[0];
      if (!cl) { const e = new Error('client_introuvable'); e.status = 404; throw e; }
      const acc = (await c.query('SELECT * FROM account WHERE client_id=$1 ORDER BY opened_at LIMIT 1',
        [cl.id])).rows[0];

      const ref = (await c.query('SELECT fn_gen_request_ref($1) AS r', [req.user.imf_id])).rows[0].r;
      let feeRes = null;
      if (acc && Number(rt.fee_cents) > 0) {
        feeRes = await chargeFee(c, {
          imfId: req.user.imf_id, accountId: acc.id, kind: 'demande_personnalisee',
          amountCents: Number(rt.fee_cents), detail: { request_type: rt.code, request_ref: ref },
          userId: req.user.id, label: 'Frais demande — ' + rt.label,
        });
      }
      const cr = (await c.query(
        `INSERT INTO client_request(imf_id,reference,request_type_id,client_id,account_id,fee_cents,fee_charged,note,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.user.imf_id, ref, rt.id, cl.id, acc ? acc.id : null, Number(rt.fee_cents),
         !!feeRes, b.note || null, req.user.id])).rows[0];
      return { request: cr, type: rt, fee: feeRes, account: acc ? { id: acc.id, code_account: acc.code_account } : null };
    });
    res.status(201).json({
      request: { id: out.request.id, reference: out.request.reference, status: out.request.status },
      type: { code: out.type.code, label: out.type.label, fee_cents: Number(out.type.fee_cents) },
      account: out.account,
      fee: out.fee ? {
        status: out.fee.status,
        charged_cents: out.fee.charged_cents,
        pending_cents: out.fee.pending_cents,
        note: out.fee.status === 'en_attente'
          ? 'Frais débités à la source actés « en attente » (solde insuffisant) — récupération prioritaire au prochain crédit.'
          : 'Frais débités à la source sur le compte du client.'
      } : { status: 'preleve', charged_cents: 0, pending_cents: 0 },
    });
  } catch (e) { next(e); }
});

r.get('/client-requests', requireRole(...STAFF), async (req, res) => {
  const { rows } = await q(
    `SELECT cr.*, rt.label AS type_label, c.full_name AS client_name, c.code_client,
            a.code_account
       FROM client_request cr
       JOIN request_type rt ON rt.id = cr.request_type_id
       JOIN client c ON c.id = cr.client_id
       LEFT JOIN account a ON a.id = cr.account_id
      WHERE cr.imf_id=$1 ORDER BY cr.created_at DESC LIMIT 200`, [req.user.imf_id]);
  res.json({ requests: rows });
});

/* ------------------------------------------------------------------ */
/*  FRAIS : liste, en attente, et clôture mensuelle                     */
/* ------------------------------------------------------------------ */
r.get('/fees', requireRole(...STAFF), async (req, res) => {
  const { rows } = await q(
    `SELECT f.*, a.code_account, c.full_name AS client_name, c.code_client
       FROM account_fee f JOIN account a ON a.id=f.account_id JOIN client c ON c.id=a.client_id
      WHERE f.imf_id=$1 ORDER BY f.created_at DESC LIMIT 300`, [req.user.imf_id]);
  const pending = (await q(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS total, COUNT(*)::int AS n
       FROM account_fee WHERE imf_id=$1 AND status='en_attente'`, [req.user.imf_id])).rows[0];
  res.json({ fees: rows, pending: { total_cents: Number(pending.total), count: pending.n } });
});

r.get('/fees/pending', requireRole(...STAFF), async (req, res) => {
  const { rows } = await q(
    `SELECT f.id, f.kind, f.amount_cents, f.period_start, f.period_end, f.detail, f.created_at,
            a.code_account, a.balance_cents, c.full_name AS client_name, c.code_client,
            sp.min_permanent_cents
       FROM account_fee f
       JOIN account a ON a.id = f.account_id
       JOIN client c ON c.id = a.client_id
       LEFT JOIN savings_product sp ON sp.code = a.product_code
      WHERE f.imf_id=$1 AND f.status='en_attente'
      ORDER BY f.created_at ASC`, [req.user.imf_id]);
  res.json({ pending: rows, count: rows.length });
});

/**
 * Clôture mensuelle des frais.
 *   - Frais de tenue de compte : DÛ POUR TOUT MOIS ENTAMÉ, prélevé le dernier
 *     jour du mois (idempotent : une seule fois par compte et par mois).
 *   - Frais de collecte mobile : calculés sur le cumul mensuel des dépôts.
 *   - Si le solde disponible < solde minimum permanent => prélèvement ACTÉ
 *     « en attente » (rattrapage automatique).
 */
r.post('/fees/close-month', requireRole(...SUP), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ref = b.period_date ? new Date(b.period_date) : new Date();
    const { start, end } = monthBounds(ref);
    const force = b.force === true;
    const out = await tx(async (c) => {
      const accounts = (await c.query(
        `SELECT a.id, a.code_account, a.balance_cents, a.client_id,
                sp.code AS product_code, sp.label AS product_label,
                sp.account_keeping_fee_cents, sp.min_permanent_cents,
                sp.collection_fee_mode, sp.collection_fee_fixed_cents,
                sp.collection_fee_bp, sp.collection_fee_tranches,
                COALESCE(sp.early_withdrawal_exempt_new_deposits,true) AS ew_exempt
           FROM account a
           LEFT JOIN savings_product sp ON sp.code = a.product_code
          WHERE a.imf_id=$1 AND a.status <> 'closed'`, [req.user.imf_id])).rows;

      const results = [];
      for (const a of accounts) {
        const keeping = Number(a.account_keeping_fee_cents || 0);
        const done = (await c.query(
          `SELECT id FROM account_fee
            WHERE account_id=$1 AND kind='tenue_compte' AND period_start=$2::date AND period_end=$3::date`,
          [a.id, start, end])).rows[0];
        if (keeping > 0 && !done) {
          const rr = await chargeFee(c, {
            imfId: req.user.imf_id, accountId: a.id, kind: 'tenue_compte', amountCents: keeping,
            periodStart: start, periodEnd: end,
            detail: { month: start.slice(0, 7), rule: 'tout mois entamé — prélevé le dernier jour du mois' },
            userId: req.user.id, label: 'Frais de tenue de compte ' + start.slice(0, 7),
          });
          await c.query(
            `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,source_id,label,user_id)
             SELECT $1,$2,0,0,balance_cents,'fee_period',$3,$4,$5 FROM account WHERE id=$2`,
            [req.user.imf_id, a.id, rr.fee ? rr.fee.id : null, 'Période ' + start.slice(0, 7), req.user.id]);
          results.push({ account: a.code_account, kind: 'tenue_compte', status: rr.status,
            amount_cents: keeping, charged_cents: rr.charged_cents, pending_cents: rr.pending_cents });
        }
        // Frais de collecte mobile
        const mode = a.collection_fee_mode;
        const anyFee = mode === 'fixe' ? Number(a.collection_fee_fixed_cents || 0) > 0
          : mode === 'pourcentage' ? Number(a.collection_fee_bp || 0) > 0
          : (Array.isArray(a.collection_fee_tranches) && a.collection_fee_tranches.length > 0);
        if (anyFee) {
          const doneC = (await c.query(
            `SELECT id FROM account_fee
              WHERE account_id=$1 AND kind='collecte_mobile' AND period_start=$2::date AND period_end=$3::date`,
            [a.id, start, end])).rows[0];
          if (!doneC) {
            const base = await monthDeposits(c, a.id, start, end);
            const calc = computeCollectionFee(a, base);
            if (calc.amount_cents > 0) {
              const rr = await chargeFee(c, {
                imfId: req.user.imf_id, accountId: a.id, kind: 'collecte_mobile',
                amountCents: calc.amount_cents, periodStart: start, periodEnd: end,
                detail: { month: start.slice(0, 7), mode: calc.mode, base_cents: base, ...calc.detail },
                userId: req.user.id, label: 'Frais de collecte mobile ' + start.slice(0, 7),
              });
              results.push({ account: a.code_account, kind: 'collecte_mobile', status: rr.status,
                amount_cents: calc.amount_cents, charged_cents: rr.charged_cents,
                pending_cents: rr.pending_cents, base_cents: base, mode: calc.mode });
            }
          }
        }
      }
      return { period: { start, end }, last_day_of_month: isLastDayOfMonth(ref),
        forced: force, processed: results.length, results };
    });
    res.json({
      ...out,
      note: 'Clôture mensuelle exécutée. Les prélèvements impossibles ont été actés « en attente » (récupération prioritaire au prochain crédit).',
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Récupération PRIORITAIRE des frais en attente (à l'alimentation)    */
/* ------------------------------------------------------------------ */
r.post('/fees/recover/:accountId', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await tx(async (c) => {
      const acc = (await c.query('SELECT * FROM account WHERE id=$1 AND imf_id=$2',
        [req.params.accountId, req.user.imf_id])).rows[0];
      if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }
      const budget = b.credit_cents !== undefined ? int(b.credit_cents) : Number(acc.balance_cents);
      const rec = await recoverPendingFees(c, req.user.imf_id, acc.id, budget);
      if (rec.recovered_cents > 0) {
        const upd = (await c.query(
          'UPDATE account SET balance_cents = balance_cents - $1 WHERE id=$2 RETURNING balance_cents',
          [rec.recovered_cents, acc.id])).rows[0];
        await c.query(
          `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,label,user_id)
           VALUES ($1,$2,-1,$3,$4,'fee_recovery','Récupération prioritaire des frais en attente',$5)`,
          [req.user.imf_id, acc.id, rec.recovered_cents, upd.balance_cents, req.user.id]);
      }
      return rec;
    });
    res.json({ ...out, note: 'Récupération prioritaire des frais en attente effectuée.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  RETRAIT ANTICIPÉ — ordre de priorité strict                         */
/*   1. Frais de collecte mobile du mois du retrait                     */
/*   2. Commission de retrait anticipé (% du montant retiré)            */
/*   3. Exonération si le retrait n'entame pas les nouveaux dépôts      */
/* ------------------------------------------------------------------ */
r.post('/operations/withdraw-early', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = int(b.amount_cents);
    if (!(amount > 0)) return res.status(400).json({ error: 'montant_invalide' });
    const out = await tx(async (c) => {
      const acc = (await c.query(
        `SELECT a.*, sp.code AS product_code, sp.label AS product_label,
                sp.early_withdrawal_fee_bp, sp.early_withdrawal_exempt_new_deposits,
                sp.collection_fee_mode, sp.collection_fee_fixed_cents,
                sp.collection_fee_bp, sp.collection_fee_tranches,
                sp.min_permanent_cents, sp.nature, sp.withdrawal_period
           FROM account a LEFT JOIN savings_product sp ON sp.code=a.product_code
          WHERE a.code_account=$1 AND a.imf_id=$2 FOR UPDATE OF a`,
        [b.account_code, req.user.imf_id])).rows[0];
      if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }
      if (acc.status === 'blocked') { const e = new Error('compte_bloque'); e.status = 409; throw e; }

      const { start, end } = monthBounds();
      const depositsMonth = await monthDeposits(c, acc.id, start, end);
      const steps = [];

      // --- ÉTAPE 1 : frais de collecte mobile sur les dépôts DU MOIS DU RETRAIT ---
      const anyCF = acc.collection_fee_mode === 'fixe' ? Number(acc.collection_fee_fixed_cents || 0) > 0
        : acc.collection_fee_mode === 'pourcentage' ? Number(acc.collection_fee_bp || 0) > 0
        : (Array.isArray(acc.collection_fee_tranches) && acc.collection_fee_tranches.length > 0);
      let colFeeTotal = 0;
      if (anyCF) {
        const already = (await c.query(
          `SELECT COALESCE(SUM(amount_cents),0)::bigint AS t FROM account_fee
            WHERE account_id=$1 AND kind='collecte_mobile'
              AND period_start=$2::date AND period_end=$3::date AND status IN ('preleve','en_attente')`,
          [acc.id, start, end])).rows[0].t;
        const calc = computeCollectionFee(acc, depositsMonth);
        const rest = Math.max(0, calc.amount_cents - Number(already));
        colFeeTotal = rest;
        if (rest > 0) {
          const rr = await chargeFee(c, {
            imfId: req.user.imf_id, accountId: acc.id, kind: 'collecte_mobile', amountCents: rest,
            periodStart: start, periodEnd: end,
            detail: { month: start.slice(0, 7), mode: calc.mode, base_cents: depositsMonth,
              trigger: 'retrait_anticipe', priority: 1 },
            userId: req.user.id, label: 'Frais de collecte mobile (retrait anticipé) ' + start.slice(0, 7),
          });
          steps.push({ step: 1, kind: 'collecte_mobile', amount_cents: rest, status: rr.status,
            charged_cents: rr.charged_cents, pending_cents: rr.pending_cents,
            label: 'Frais de collecte mobile sur les dépôts du mois du retrait' });
        } else {
          steps.push({ step: 1, kind: 'collecte_mobile', amount_cents: 0, status: 'deja_preleve',
            label: 'Frais de collecte mobile déjà prélevés pour le mois' });
        }
      }

      // --- ÉTAPE 2 + 3 : commission de retrait anticipé / exonération ---
      // Solde antérieur = solde courant du compte MOINS les dépôts du mois en
      // cours (borné à 0). Sert à déterminer si le retrait entame les nouveaux
      // dépôts du mois (règle d'exonération).
      const priorBalance = Math.max(0, Number(acc.balance_cents || 0) - Number(depositsMonth || 0));
      const ew = computeEarlyWithdrawalFee(acc, amount, depositsMonth, priorBalance);
      let ewFee = 0;
      if (!ew.exempt && ew.amount_cents > 0) {
        ewFee = ew.amount_cents;
        const rr = await chargeFee(c, {
          imfId: req.user.imf_id, accountId: acc.id, kind: 'retrait_anticipe', amountCents: ewFee,
          periodStart: start, periodEnd: end,
          detail: { withdraw_cents: amount, rate_bp: Number(acc.early_withdrawal_fee_bp || 0),
            month_deposits_cents: depositsMonth, priority: 2 },
          userId: req.user.id, label: 'Commission de retrait anticipé',
        });
        steps.push({ step: 2, kind: 'retrait_anticipe', amount_cents: ewFee, status: rr.status,
          charged_cents: rr.charged_cents, pending_cents: rr.pending_cents,
          label: 'Commission de retrait anticipé (' + (Number(acc.early_withdrawal_fee_bp || 0) / 100) + ' % du montant retiré)' });
      } else {
        steps.push({ step: 3, kind: 'exoneration', amount_cents: 0, exempt: true, status: 'exonere',
          reason: ew.reason,
          label: 'Exonération : le retrait n\'entame pas les nouveaux dépôts du mois en cours' });
      }

      // --- Prélèvement effectif du montant du retrait ---
      const avail = Number(acc.balance_cents);
      const totalFees = steps.reduce((s, x) => s + (x.charged_cents || 0), 0);
      if (avail < amount + 0) { const e = new Error('solde_insuffisant'); e.status = 409; throw e; }
      const upd = (await c.query(
        'UPDATE account SET balance_cents = balance_cents - $1 WHERE id=$2 RETURNING balance_cents',
        [amount, acc.id])).rows[0];
      const op = (await c.query(
        `INSERT INTO operation(imf_id,account_id,user_id,kind,amount_cents,status,impacts_agent_cash,reference,note,
              gps_lat,gps_lng)
         VALUES ($1,$2,$3,'retrait_regul'::op_kind,0,'valide',false,$4,$5,$6,$7) RETURNING id`,
        [req.user.imf_id, acc.id, req.user.id, 'RA-' + Date.now(),
         'Retrait anticipé', b.gps_lat || null, b.gps_lng || null])).rows[0];
      await c.query(
        `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,source_id,label,user_id)
         VALUES ($1,$2,-1,$3,$4,'operation',$5,'Retrait anticipé',$6)`,
        [req.user.imf_id, acc.id, amount, upd.balance_cents, op.id, req.user.id]);

      return { account: { code_account: acc.code_account, product: acc.product_label || acc.product_code },
        requested_cents: amount, deposits_this_month_cents: depositsMonth,
        fees_charged_cents: totalFees, balance_after_cents: Number(upd.balance_cents), steps };
    });
    res.status(201).json({ ok: true, ...out,
      note: 'Ordre de priorité appliqué : 1) frais de collecte mobile du mois, 2) commission de retrait anticipé, 3) exonération si les nouveaux dépôts du mois ne sont pas entamés.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  DÉPÔT avec rattrapage automatique prioritaire des frais en attente  */
/* ------------------------------------------------------------------ */
r.post('/operations/deposit', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = int(b.amount_cents);
    if (!(amount > 0)) return res.status(400).json({ error: 'montant_invalide' });
    const out = await tx(async (c) => {
      const acc = (await c.query('SELECT * FROM account WHERE code_account=$1 AND imf_id=$2 FOR UPDATE',
        [b.account_code, req.user.imf_id])).rows[0];
      if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }
      if (acc.status === 'blocked') { const e = new Error('compte_bloque'); e.status = 409; throw e; }

      let bal = Number(acc.balance_cents) + amount;
      const mv = (await c.query(
        `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,label,user_id,occurred_at)
         VALUES ($1,$2,1,$3,$4,'operation',$5,$6,now()) RETURNING id`,
        [req.user.imf_id, acc.id, amount, bal, b.note || 'Dépôt de collecte', req.user.id])).rows[0];
      await c.query('UPDATE account SET balance_cents = balance_cents + $1 WHERE id=$2', [amount, acc.id]);

      // Règle de rattrapage : récupération PRIORITAIRE des frais en attente.
      const rec = await recoverPendingFees(c, req.user.imf_id, acc.id, bal);
      if (rec.recovered_cents > 0) {
        const upd = (await c.query(
          'UPDATE account SET balance_cents = balance_cents - $1 WHERE id=$2 RETURNING balance_cents',
          [rec.recovered_cents, acc.id])).rows[0];
        bal = Number(upd.balance_cents);
        await c.query(
          `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,source_id,label,user_id)
           VALUES ($1,$2,-1,$3,$4,'fee_recovery',$5,'Récupération prioritaire des frais en attente',$6)`,
          [req.user.imf_id, acc.id, rec.recovered_cents, bal, mv.id, req.user.id]);
      }
      return { movement_id: mv.id, deposited_cents: amount, balance_after_cents: bal,
        pending_fees_recovered_cents: rec.recovered_cents, fees_still_pending: rec.still_pending };
    });
    res.status(201).json({ ok: true, ...out,
      note: out.pending_fees_recovered_cents > 0
        ? 'Dépôt enregistré. ' + Math.round(out.pending_fees_recovered_cents / 100) + ' XOF de frais en attente ont été récupérés en priorité.'
        : 'Dépôt enregistré.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  GESTION DES SORTIES : clôture de compte (frais de clôture)          */
/* ------------------------------------------------------------------ */
r.post('/accounts/:id/close', requireRole(...SUP), async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const acc = (await c.query(
        `SELECT a.*, sp.closing_fee_cents, sp.min_permanent_cents
           FROM account a LEFT JOIN savings_product sp ON sp.code=a.product_code
          WHERE a.id=$1 AND a.imf_id=$2 FOR UPDATE OF a`, [req.params.id, req.user.imf_id])).rows[0];
      if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }
      const fee = Number(acc.closing_fee_cents || 0);
      let rr = null;
      if (fee > 0) {
        rr = await chargeFee(c, { imfId: req.user.imf_id, accountId: acc.id, kind: 'cloture',
          amountCents: fee, detail: { reason: 'cloture_de_compte' }, userId: req.user.id,
          label: 'Frais de clôture de compte' });
      }
      const acc2 = (await c.query(
        `UPDATE account SET status='closed', closed_at=now() WHERE id=$1 RETURNING id, code_account, status, balance_cents`,
        [acc.id])).rows[0];
      return { account: acc2, closing_fee: rr };
    });
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  SIMULATEUR DE FRAIS (barème + retrait anticipé) — transparence IMF  */
/* ------------------------------------------------------------------ */
r.post('/fees/simulate', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const prod = (await q('SELECT * FROM savings_product WHERE code=$1', [b.product_code])).rows[0];
    if (!prod) return res.status(404).json({ error: 'produit_introuvable' });
    const deposits = int(b.month_deposits_cents);
    const withdraw = int(b.withdraw_cents);
    // Solde antérieur optionnel pour simuler l'exonération (retrait couvert par
    // l'ancien solde). Absent => pas d'exonération simulée (commission due).
    const priorBalance = b.prior_balance_cents === undefined || b.prior_balance_cents === null
      ? null : int(b.prior_balance_cents);
    const cf = computeCollectionFee(prod, deposits);
    const ew = computeEarlyWithdrawalFee(prod, withdraw, deposits, priorBalance);
    res.json({
      product: { code: prod.code, label: prod.label, nature: prod.nature },
      opening: { opening_fee_cents: Number(prod.opening_fee_cents),
        subscription_fee_cents: Number(prod.subscription_fee_cents),
        min_opening_deposit_cents: Number(prod.min_opening_deposit_cents) },
      monthly: { account_keeping_fee_cents: Number(prod.account_keeping_fee_cents),
        collection_fee: cf },
      early_withdrawal: { amount_cents: ew.amount_cents, exempt: ew.exempt, reason: ew.reason, detail: ew.detail },
    });
  } catch (e) { next(e); }
});

/* ================================================================== */
/*  DOSSIERS DE CRÉDIT — suivi partagé Client / Collectrice / Sup.      */
/* ================================================================== */

const CREDIT_STATUSES = ['en_attente', 'a_l_etude', 'approuve', 'rejete', 'decaisse'];

async function logCreditEvent(c, fileId, from, to, user, note) {
  await c.query(
    `INSERT INTO credit_event(credit_file_id,from_status,to_status,actor_user_id,actor_role,note)
     VALUES ($1,$2,$3,$4,$5,$6)`, [fileId, from || null, to, user.id, user.role, note || null]);
}

/** Soumission : par le CLIENT ou saisie par la COLLECTRICE. */
r.post('/credits', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = int(b.amount_cents);
    if (!(amount > 0)) return res.status(400).json({ error: 'montant_invalide' });
    const origin = ['client', 'collectrice', 'guichet'].includes(b.origin) ? b.origin : 'collectrice';
    const out = await tx(async (c) => {
      const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
        [b.client_id, req.user.imf_id])).rows[0];
      if (!cl) { const e = new Error('client_introuvable'); e.status = 404; throw e; }
      const acc = (await c.query('SELECT id FROM account WHERE client_id=$1 ORDER BY opened_at LIMIT 1',
        [cl.id])).rows[0];
      const ref = (await c.query('SELECT fn_gen_credit_ref($1) AS r', [req.user.imf_id])).rows[0].r;
      const f = (await c.query(
        `INSERT INTO credit_file(imf_id,reference,client_id,account_id,origin,requested_by,
              collectrice_user_id,superviseur_user_id,amount_cents,duration_months,purpose,activity,
              collateral,comments,documents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING *`,
        [req.user.imf_id, ref, cl.id, acc ? acc.id : null, origin, req.user.id,
         cl.collectrice_user_id || req.user.id, cl.superviseur_user_id,
         amount, b.duration_months || null, b.purpose || null, b.activity || null,
         b.collateral || null, b.comments || null,
         JSON.stringify(Array.isArray(b.documents) ? b.documents : [])])).rows[0];
      await logCreditEvent(c, f.id, null, 'en_attente', req.user, 'Dossier soumis (' + origin + ')');
      return { file: f, client: cl };
    });
    res.status(201).json({
      credit: { id: out.file.id, reference: out.file.reference, status: out.file.status,
        amount_cents: Number(out.file.amount_cents) },
      client: { id: out.client.id, full_name: out.client.full_name, code_client: out.client.code_client },
      workflow: { en_attente: 'En attente', a_l_etude: 'À l\'étude', approuve: 'Approuvé', rejete: 'Rejeté', decaisse: 'Décaissé' },
      note: 'Dossier de crédit enregistré. Visible en temps réel par le Client, la Collectrice et le Superviseur.',
    });
  } catch (e) { next(e); }
});

/** Liste des dossiers — filtrée selon le rôle (visibilité partagée). */
r.get('/credits', requireRole(...STAFF), async (req, res) => {
  const role = req.user.role;
  const params = [req.user.imf_id];
  let where = 'cf.imf_id=$1';
  if (role === 'staff' || role === 'agency') {
    params.push(req.user.id);
    where += ` AND (cf.collectrice_user_id=$2 OR cf.requested_by=$2)`;
  } else if (role === 'service' || role === 'department') {
    params.push(req.user.id);
    where += ` AND (cf.superviseur_user_id=$2 OR cf.officer_user_id=$2 OR cf.collectrice_user_id=$2 OR cf.requested_by=$2)`;
  }
  if (req.query.status && CREDIT_STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where += ` AND cf.status=$${params.length}`;
  }
  const { rows } = await q(
    `SELECT cf.*, c.full_name AS client_name, c.code_client, a.code_account,
            col.full_name AS collectrice_name, sup.full_name AS superviseur_name,
            off.full_name AS officer_name,
            (SELECT COUNT(*)::int FROM credit_event e WHERE e.credit_file_id=cf.id) AS events
       FROM credit_file cf
       JOIN client c ON c.id = cf.client_id
       LEFT JOIN account a ON a.id = cf.account_id
       LEFT JOIN app_user col ON col.id = cf.collectrice_user_id
       LEFT JOIN app_user sup ON sup.id = cf.superviseur_user_id
       LEFT JOIN app_user off ON off.id = cf.officer_user_id
      WHERE ${where} ORDER BY cf.created_at DESC LIMIT 200`, params);
  const counts = (await q(
    `SELECT status, COUNT(*)::int AS n FROM credit_file WHERE imf_id=$1 GROUP BY status`,
    [req.user.imf_id])).rows;
  res.json({ credits: rows, counts,
    labels: { en_attente: 'En attente', a_l_etude: 'À l\'étude', approuve: 'Approuvé', rejete: 'Rejeté', decaisse: 'Décaissé' } });
});

/** ÉCRAN DE VALIDATION FINALE — file d'attente des dossiers à valider.
 *  Réservé aux postes habilités (credit.validate_final). Déclaré AVANT
 *  /credits/:id pour ne pas être capturé comme un identifiant. */
r.get('/credits/final-queue', requirePermission('credit.validate_final'), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT cf.id, cf.reference, cf.status, cf.amount_cents, cf.approved_amount_cents,
              cf.duration_months, cf.purpose, cf.origin, cf.created_at,
              c.full_name AS client_name, c.code_client,
              col.full_name AS collectrice_name, off.full_name AS officer_name
         FROM credit_file cf
         JOIN client c ON c.id=cf.client_id
         LEFT JOIN app_user col ON col.id=cf.collectrice_user_id
         LEFT JOIN app_user off ON off.id=cf.officer_user_id
        WHERE cf.imf_id=$1 AND cf.status IN ('en_attente','a_l_etude')
        ORDER BY cf.created_at`, [req.user.imf_id]);
    res.json({ queue: rows,
      labels: { en_attente: 'En attente', a_l_etude: 'À l\'étude', approuve: 'Approuvé', rejete: 'Rejeté', decaisse: 'Décaissé' } });
  } catch (e) { next(e); }
});

/** Tableau de bord partagé d'un dossier (Client, Collectrice, Superviseur). */
r.get('/credits/:id', requireRole(...STAFF), async (req, res, next) => {
  try {
    const f = (await q(
      `SELECT cf.*, c.full_name AS client_name, c.code_client, c.phone AS client_phone,
              a.code_account, a.balance_cents,
              col.full_name AS collectrice_name, sup.full_name AS superviseur_name,
              off.full_name AS officer_name
         FROM credit_file cf
         JOIN client c ON c.id=cf.client_id
         LEFT JOIN account a ON a.id=cf.account_id
         LEFT JOIN app_user col ON col.id=cf.collectrice_user_id
         LEFT JOIN app_user sup ON sup.id=cf.superviseur_user_id
         LEFT JOIN app_user off ON off.id=cf.officer_user_id
        WHERE cf.id=$1 AND cf.imf_id=$2`, [req.params.id, req.user.imf_id])).rows[0];
    if (!f) return res.status(404).json({ error: 'dossier_introuvable' });
    const events = (await q(
      `SELECT e.*, u.full_name AS actor_name FROM credit_event e
         LEFT JOIN app_user u ON u.id=e.actor_user_id
        WHERE e.credit_file_id=$1 ORDER BY e.created_at`, [f.id])).rows;
    const steps = ['en_attente', 'a_l_etude', 'approuve'];
    const idx = steps.indexOf(f.status);
    res.json({ credit: f, events,
      progress: { steps: ['en_attente', 'a_l_etude', 'approuve'],
        labels: { en_attente: 'En attente', a_l_etude: 'À l\'étude', approuve: 'Approuvé', rejete: 'Rejeté', decaisse: 'Décaissé' },
        current: idx, rejected: f.status === 'rejete' },
      shared_with: { client: f.client_name, collectrice: f.collectrice_name, superviseur: f.superviseur_name } });
  } catch (e) { next(e); }
});

/** Traitement par l'AGENT DE CRÉDIT (accès dédié) + superviseur. */
r.post('/credits/:id/process', requireRole(...OFFICER), async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = b.status;
    if (!CREDIT_STATUSES.includes(to)) return res.status(400).json({ error: 'statut_invalide', allowed: CREDIT_STATUSES });
    // VALIDATION FINALE réservée : l'octroi définitif (approuve / decaisse) exige
    // l'habilitation 'credit.validate_final'. L'instruction (a_l_etude) et le
    // rejet restent ouverts aux agents de crédit habilités (OFFICER).
    if ((to === 'approuve' || to === 'decaisse') &&
        !(await userHasPermission(req.user, 'credit.validate_final'))) {
      return res.status(403).json({ error: 'final_validation_reserved',
        message: 'L\'octroi définitif est réservé aux postes habilités à la validation finale du crédit.' });
    }
    const out = await tx(async (c) => {
      const f = (await c.query('SELECT * FROM credit_file WHERE id=$1 AND imf_id=$2 FOR UPDATE',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!f) { const e = new Error('dossier_introuvable'); e.status = 404; throw e; }
      const note = b.note || null;
      const officer = to === 'a_l_etude' ? req.user.id : f.officer_user_id;
      const approved = to === 'approuve' ? (b.approved_amount_cents !== undefined ? int(b.approved_amount_cents) : Number(f.amount_cents)) : f.approved_amount_cents;
      const decided = ['approuve', 'rejete'].includes(to) ? new Date() : f.decided_at;
      const f2 = (await c.query(
        `UPDATE credit_file SET status=$2::credit_status, officer_user_id=COALESCE($3,officer_user_id),
              assigned_at=CASE WHEN $2='a_l_etude' THEN COALESCE(assigned_at, now()) ELSE assigned_at END,
              decided_at=$4, decision_note=COALESCE($5,decision_note), approved_amount_cents=$6, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [f.id, to, officer, decided, note, approved])).rows[0];
      await logCreditEvent(c, f.id, f.status, to, req.user, note);
      return f2;
    });
    res.json({ credit: { id: out.id, reference: out.reference, status: out.status },
      note: 'Dossier mis à jour — la Collectrice, le Superviseur et le Client voient l\'avancement en temps réel.' });
  } catch (e) { next(e); }
});

/** VALIDATION FINALE d'un dossier (octroi définitif ou rejet définitif).
 *  Réservée aux postes habilités (credit.validate_final), réaffectables par
 *  l'admin IMF via /access/positions/:code/permission. */
r.post('/credits/:id/final-validate', requirePermission('credit.validate_final'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const decision = b.decision; // 'approuve' | 'rejete' | 'decaisse'
    if (!['approuve', 'rejete', 'decaisse'].includes(decision))
      return res.status(400).json({ error: 'decision_invalide', allowed: ['approuve', 'rejete', 'decaisse'] });
    const out = await tx(async (c) => {
      const f = (await c.query('SELECT * FROM credit_file WHERE id=$1 AND imf_id=$2 FOR UPDATE',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!f) { const e = new Error('dossier_introuvable'); e.status = 404; throw e; }
      const note = b.note || null;
      const approved = decision === 'approuve'
        ? (b.approved_amount_cents !== undefined ? int(b.approved_amount_cents) : Number(f.amount_cents))
        : f.approved_amount_cents;
      const decided = ['approuve', 'rejete'].includes(decision) ? new Date() : f.decided_at;
      const f2 = (await c.query(
        `UPDATE credit_file SET status=$2::credit_status,
              decided_at=$3, decision_note=COALESCE($4,decision_note),
              approved_amount_cents=$5, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [f.id, decision, decided, note, approved])).rows[0];
      await logCreditEvent(c, f.id, f.status, decision, req.user, note || 'Validation finale');
      return f2;
    });
    res.json({ ok: true, credit: { id: out.id, reference: out.reference, status: out.status,
      approved_amount_cents: out.approved_amount_cents !== null ? Number(out.approved_amount_cents) : null },
      note: 'Validation finale enregistrée — suivi visible en temps réel par la Collectrice, le Superviseur et le Client.' });
  } catch (e) { next(e); }
});

/** Suivi côté collectrice / superviseur (tableau de bord partagé). */
r.get('/credits/dashboard/summary', requireRole(...STAFF), async (req, res) => {  const rows = (await q(
    `SELECT cf.status, COUNT(*)::int AS n, COALESCE(SUM(cf.amount_cents),0)::bigint AS total_cents
       FROM credit_file cf WHERE cf.imf_id=$1 GROUP BY cf.status`, [req.user.imf_id])).rows;
  const { rows: recent } = await q(
    `SELECT cf.id, cf.reference, cf.status, cf.amount_cents, cf.created_at, c.full_name AS client_name
       FROM credit_file cf JOIN client c ON c.id=cf.client_id
      WHERE cf.imf_id=$1 ORDER BY cf.created_at DESC LIMIT 10`, [req.user.imf_id]);
  res.json({ by_status: rows, recent,
    labels: { en_attente: 'En attente', a_l_etude: 'À l\'étude', approuve: 'Approuvé', rejete: 'Rejeté', decaisse: 'Décaissé' } });
});

/* ------------------------------------------------------------------ */
/*  Tableau de bord IMF : soldes bloqués / état des demandes            */
/* ------------------------------------------------------------------ */
r.get('/imf/dashboard', requireRole(...STAFF), async (req, res) => {
  const blocks = (await q(
    `SELECT a.code_account, c.full_name AS client_name FROM account a JOIN client c ON c.id=a.client_id
      WHERE a.imf_id=$1 AND a.status='blocked' LIMIT 50`, [req.user.imf_id])).rows;
  const fees = (await q(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS t, COUNT(*)::int AS n
       FROM account_fee WHERE imf_id=$1 AND status='en_attente'`, [req.user.imf_id])).rows[0];
  const credits = (await q(
    `SELECT status, COUNT(*)::int AS n FROM credit_file WHERE imf_id=$1 GROUP BY status`, [req.user.imf_id])).rows;
  res.json({ blocked_accounts: blocks, pending_fees: { total_cents: Number(fees.t), count: fees.n }, credits_by_status: credits });
});

export default r;
