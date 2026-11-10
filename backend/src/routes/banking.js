import express from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requirePermission } from '../auth.js';
import { auditEvent } from '../audit.js';

/* ===========================================================================
 * teebo — VAGUE 15 : opérations bancaires fonctionnelles
 * ---------------------------------------------------------------------------
 * Rend réellement opérationnelles, dans l'espace des postes habilités :
 *   - Clients      : modifier une fiche client (clients.manage)
 *   - Caisse       : valider un dépassement de plafond (cash.approve) ;
 *                    arrêté de caisse & rapprochement (cash.approve)
 *   - Coffre       : approvisionner / délester (accounts.manage)
 *   - Comptabilité : saisir des écritures (accounts.manage) ;
 *                    clôture comptable & états financiers (accounts.manage)
 *   - Crédit       : suivi des impayés & recouvrement (credit.recovery)
 * Chaque habilitation est appliquée via requirePermission, qui consulte la
 * matrice des postes (position_default_permission). Cloisonnement imf_id
 * strict sur TOUTES les requêtes.
 * ========================================================================= */
const router = express.Router();
router.use(authenticate, requireFreshPassword);
router.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; }
function fcfa(cents) { return Math.round(Number(cents || 0) / 100); } // affichage FCFA

/* --------------------------------------------------------------------------
 * CLIENTS — Modifier une fiche client (le gel/dégel existe déjà : round.js)
 * ------------------------------------------------------------------------ */
router.patch('/clients/:id', requirePermission('clients.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'client_introuvable' });
    const full_name = (b.full_name !== undefined ? String(b.full_name).trim() : cur.full_name) || cur.full_name;
    const phone = b.phone !== undefined ? (String(b.phone).trim() || null) : cur.phone;
    const id_number = b.id_number !== undefined ? (String(b.id_number).trim() || null) : cur.id_number;
    const address = b.address !== undefined ? (String(b.address).trim() || null) : cur.address;
    const birth_date = b.birth_date !== undefined ? (b.birth_date || null) : cur.birth_date;
    const row = (await q(
      `UPDATE client SET full_name=$3, phone=$4, id_number=$5, address=$6, birth_date=$7
        WHERE id=$1 AND imf_id=$2 RETURNING id, code_client, full_name, phone, id_number, address, birth_date`,
      [req.params.id, req.user.imf_id, full_name, phone, id_number, address, birth_date])).rows[0];
    await auditEvent(req.user, { action: 'client.update', entity: 'client', entityId: row.id,
      payload: { full_name: row.full_name } });
    res.json({ ok: true, client: row, note: 'Fiche client mise à jour.' });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------------------
 * CAISSE — Dépassement de plafond : demande puis validation
 * ------------------------------------------------------------------------ */
// Saisir une demande de dépassement (agent de caisse / terrain)
router.post('/cash/overrun-requests', requirePermission('operations.write'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'caisse' ? 'caisse' : 'client';
    const amount = int(b.amount_cents);
    const cap = int(b.cap_cents);
    if (!(amount > 0)) return res.status(422).json({ error: 'montant_invalide' });
    const row = (await q(
      `INSERT INTO cash_overrun_request(imf_id, client_id, requested_by, kind, amount_cents, cap_cents, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.imf_id, b.client_id || null, req.user.id, kind, amount, cap,
       (b.reason || '').toString().slice(0, 500) || null])).rows[0];
    res.status(201).json({ ok: true, request: row, note: 'Demande de dépassement enregistrée — en attente de validation.' });
  } catch (e) { next(e); }
});

// Lister les demandes (lecture)
router.get('/cash/overrun-requests', requirePermission('operations.read'), async (req, res, next) => {
  try {
    const status = ['en_attente', 'approuve', 'rejete'].includes(req.query.status) ? req.query.status : null;
    const params = [req.user.imf_id];
    let where = 'o.imf_id=$1';
    if (status) { params.push(status); where += ' AND o.status=$2'; }
    const { rows } = await q(
      `SELECT o.*, c.full_name AS client_name, c.code_client,
              ru.full_name AS requested_by_name, du.full_name AS decided_by_name
         FROM cash_overrun_request o
         LEFT JOIN client c ON c.id=o.client_id
         LEFT JOIN app_user ru ON ru.id=o.requested_by
         LEFT JOIN app_user du ON du.id=o.decided_by
        WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`, params);
    res.json({ requests: rows });
  } catch (e) { next(e); }
});

// Valider / rejeter un dépassement (habilitation cash.approve)
router.post('/cash/overrun-requests/:id/decide', requirePermission('cash.approve'), async (req, res, next) => {
  try {
    const decision = req.body && req.body.decision;
    if (!['approuve', 'rejete'].includes(decision))
      return res.status(422).json({ error: 'decision_invalide', allowed: ['approuve', 'rejete'] });
    const row = (await q(
      `UPDATE cash_overrun_request
          SET status=$3, decided_by=$4, decided_at=now(), decision_note=$5
        WHERE id=$1 AND imf_id=$2 AND status='en_attente' RETURNING *`,
      [req.params.id, req.user.imf_id, decision, req.user.id,
       (req.body.note || '').toString().slice(0, 500) || null])).rows[0];
    if (!row) return res.status(409).json({ error: 'demande_introuvable_ou_deja_traitee' });
    await auditEvent(req.user, { action: 'cash.overrun.' + decision, entity: 'cash_overrun_request', entityId: row.id,
      payload: { amount_cents: Number(row.amount_cents) } });
    res.json({ ok: true, request: row, note: decision === 'approuve' ? 'Dépassement approuvé.' : 'Dépassement rejeté.' });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------------------
 * CAISSE — Arrêté de caisse & rapprochement
 * ------------------------------------------------------------------------ */
router.post('/cash/closings', requirePermission('cash.approve'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const theoretical = int(b.theoretical_cents);
    const counted = int(b.counted_cents);
    const gap = counted - theoretical;
    const status = gap === 0 ? 'equilibre' : 'ecart';
    const row = (await q(
      `INSERT INTO cash_closing(imf_id, user_id, closing_date, theoretical_cents, counted_cents, gap_cents, status, note, created_by)
       VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$2) RETURNING *`,
      [req.user.imf_id, req.user.id, b.closing_date || null, theoretical, counted, gap, status,
       (b.note || '').toString().slice(0, 500) || null])).rows[0];
    await auditEvent(req.user, { action: 'cash.closing', entity: 'cash_closing', entityId: row.id,
      payload: { gap_cents: gap, status } });
    res.status(201).json({ ok: true, closing: row,
      note: status === 'equilibre' ? 'Caisse équilibrée — arrêté enregistré.'
        : 'Écart de ' + fcfa(gap) + ' FCFA constaté — arrêté enregistré pour rapprochement.' });
  } catch (e) { next(e); }
});

router.get('/cash/closings', requirePermission('operations.read'), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT cc.*, u.full_name AS user_name FROM cash_closing cc
         LEFT JOIN app_user u ON u.id=cc.user_id
        WHERE cc.imf_id=$1 ORDER BY cc.closing_date DESC, cc.created_at DESC LIMIT 200`,
      [req.user.imf_id]);
    res.json({ closings: rows });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------------------
 * COFFRE — Approvisionner / Délester (mouvements tracés + solde courant)
 * ------------------------------------------------------------------------ */
router.get('/vault/movements', requirePermission('vault.manage'), async (req, res, next) => {
  try {
    const bal = (await q(
      `SELECT balance_after_cents FROM vault_movement WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.imf_id])).rows[0];
    const { rows } = await q(
      `SELECT vm.*, u.full_name AS created_by_name FROM vault_movement vm
         LEFT JOIN app_user u ON u.id=vm.created_by
        WHERE vm.imf_id=$1 ORDER BY vm.created_at DESC LIMIT 200`, [req.user.imf_id]);
    res.json({ balance_cents: bal ? Number(bal.balance_after_cents) : 0, movements: rows });
  } catch (e) { next(e); }
});

router.post('/vault/movements', requirePermission('vault.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const direction = b.direction === 'delestage' ? 'delestage' : 'approvisionnement';
    const amount = int(b.amount_cents);
    if (!(amount > 0)) return res.status(422).json({ error: 'montant_invalide' });
    const out = await tx(async (c) => {
      const last = (await c.query(
        `SELECT balance_after_cents FROM vault_movement WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [req.user.imf_id])).rows[0];
      const current = last ? Number(last.balance_after_cents) : 0;
      const next = direction === 'approvisionnement' ? current + amount : current - amount;
      if (next < 0) { const e = new Error('coffre_insuffisant'); e.status = 409; throw e; }
      return (await c.query(
        `INSERT INTO vault_movement(imf_id, direction, amount_cents, counterpart, reason, balance_after_cents, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.imf_id, direction, amount, (b.counterpart || null), (b.reason || '').toString().slice(0, 500) || null,
         next, req.user.id])).rows[0];
    });
    await auditEvent(req.user, { action: 'vault.' + direction, entity: 'vault_movement', entityId: out.id,
      payload: { amount_cents: amount, balance_after_cents: Number(out.balance_after_cents) } });
    res.status(201).json({ ok: true, movement: out, balance_cents: Number(out.balance_after_cents),
      note: (direction === 'approvisionnement' ? 'Coffre approvisionné' : 'Coffre délesté') +
        ' — nouveau solde : ' + fcfa(out.balance_after_cents) + ' FCFA.' });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------------------
 * COMPTABILITÉ — Saisir des écritures (charges, taxes) + clôture & états
 * ------------------------------------------------------------------------ */
router.get('/accounting/entries', requirePermission('accounts.manage'), async (req, res, next) => {
  try {
    const period = /^[0-9]{4}-[0-9]{2}$/.test(req.query.period || '') ? req.query.period : null;
    const params = [req.user.imf_id];
    let where = 'imf_id=$1';
    if (period) { params.push(period); where += ' AND period=$2'; }
    const { rows } = await q(
      `SELECT * FROM accounting_entry WHERE ${where} ORDER BY entry_date DESC, created_at DESC LIMIT 300`, params);
    const totals = (await q(
      `SELECT category, COALESCE(SUM(amount_cents),0)::bigint AS total FROM accounting_entry
        WHERE ${where} GROUP BY category`, params)).rows;
    const closed = period ? (await q(
      'SELECT 1 FROM accounting_period_close WHERE imf_id=$1 AND period=$2', [req.user.imf_id, period])).rows.length > 0 : false;
    res.json({ entries: rows, totals, period, period_closed: closed });
  } catch (e) { next(e); }
});

router.post('/accounting/entries', requirePermission('accounts.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const label = (b.label || '').toString().trim();
    if (!label) return res.status(422).json({ error: 'libelle_requis' });
    const amount = int(b.amount_cents);
    if (!(amount > 0)) return res.status(422).json({ error: 'montant_invalide' });
    const category = ['charge', 'taxe', 'produit', 'od'].includes(b.category) ? b.category : 'charge';
    const journal = (b.journal || 'OD').toString().slice(0, 12);
    const period = /^[0-9]{4}-[0-9]{2}$/.test(b.period || '') ? b.period : null;
    if (period) {
      const locked = (await q('SELECT 1 FROM accounting_period_close WHERE imf_id=$1 AND period=$2',
        [req.user.imf_id, period])).rows.length > 0;
      if (locked) return res.status(409).json({ error: 'periode_cloturee' });
    }
    const row = (await q(
      `INSERT INTO accounting_entry(imf_id, entry_date, journal, category, label, debit_account, credit_account, amount_cents, period, created_by)
       VALUES ($1, COALESCE($2,CURRENT_DATE), $3, $4, $5, $6, $7, $8, COALESCE($9, to_char(CURRENT_DATE,'YYYY-MM')), $10) RETURNING *`,
      [req.user.imf_id, b.entry_date || null, journal, category, label,
       b.debit_account || null, b.credit_account || null, amount, period, req.user.id])).rows[0];
    await auditEvent(req.user, { action: 'accounting.entry', entity: 'accounting_entry', entityId: row.id,
      payload: { category, amount_cents: amount } });
    res.status(201).json({ ok: true, entry: row, note: 'Écriture comptable enregistrée.' });
  } catch (e) { next(e); }
});

// Clôture comptable d'une période (verrouille les écritures)
router.post('/accounting/close-period', requirePermission('accounts.manage'), async (req, res, next) => {
  try {
    const period = /^[0-9]{4}-[0-9]{2}$/.test((req.body || {}).period || '') ? req.body.period : null;
    if (!period) return res.status(422).json({ error: 'periode_invalide', format: 'YYYY-MM' });
    const totals = (await q(
      `SELECT category, COALESCE(SUM(amount_cents),0)::bigint AS total FROM accounting_entry
        WHERE imf_id=$1 AND period=$2 GROUP BY category`, [req.user.imf_id, period])).rows;
    const agg = {}; totals.forEach((t) => { agg[t.category] = Number(t.total); });
    const row = (await q(
      `INSERT INTO accounting_period_close(imf_id, period, totals, closed_by)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (imf_id, period) DO UPDATE SET totals=EXCLUDED.totals, closed_by=EXCLUDED.closed_by, closed_at=now()
       RETURNING *`, [req.user.imf_id, period, JSON.stringify(agg), req.user.id])).rows[0];
    await q('UPDATE accounting_entry SET locked=true WHERE imf_id=$1 AND period=$2', [req.user.imf_id, period]);
    await auditEvent(req.user, { action: 'accounting.close', entity: 'accounting_period_close', entityId: row.id,
      payload: { period } });
    res.json({ ok: true, close: row, note: 'Période ' + period + ' clôturée.' });
  } catch (e) { next(e); }
});

// États financiers synthétiques d'une période (produits − charges − taxes)
router.get('/accounting/statements', requirePermission('accounts.manage'), async (req, res, next) => {
  try {
    const period = /^[0-9]{4}-[0-9]{2}$/.test(req.query.period || '') ? req.query.period : null;
    const params = [req.user.imf_id];
    let where = 'imf_id=$1';
    if (period) { params.push(period); where += ' AND period=$2'; }
    const rows = (await q(
      `SELECT category, COALESCE(SUM(amount_cents),0)::bigint AS total FROM accounting_entry
        WHERE ${where} GROUP BY category`, params)).rows;
    const m = {}; rows.forEach((r) => { m[r.category] = Number(r.total); });
    const produits = m.produit || 0, charges = m.charge || 0, taxes = m.taxe || 0;
    const resultat = produits - charges - taxes;
    res.json({ period, produits_cents: produits, charges_cents: charges, taxes_cents: taxes,
      resultat_net_cents: resultat, detail: m });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------------------
 * CRÉDIT — Suivi des impayés & recouvrement
 * ------------------------------------------------------------------------ */
// Marquer / mettre à jour l'impayé d'un dossier décaissé
router.post('/credits/:id/overdue', requirePermission('credit.recovery'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const overdue = b.overdue !== false;
    const amount = int(b.overdue_amount_cents);
    const row = (await q(
      `UPDATE credit_file SET overdue=$3, overdue_amount_cents=$4,
              overdue_since=CASE WHEN $3 THEN COALESCE(overdue_since, CURRENT_DATE) ELSE NULL END, updated_at=now()
        WHERE id=$1 AND imf_id=$2 RETURNING id, reference, overdue, overdue_amount_cents, overdue_since`,
      [req.params.id, req.user.imf_id, overdue, overdue ? amount : 0])).rows[0];
    if (!row) return res.status(404).json({ error: 'dossier_introuvable' });
    res.json({ ok: true, credit: row, note: overdue ? 'Dossier marqué en impayé.' : 'Impayé levé.' });
  } catch (e) { next(e); }
});

// File des impayés (dossiers décaissés marqués en retard)
router.get('/credits/arrears', requirePermission('credit.recovery'), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT cf.id, cf.reference, cf.amount_cents, cf.approved_amount_cents, cf.overdue_amount_cents,
              cf.overdue_since, c.full_name AS client_name, c.code_client, c.phone AS client_phone,
              (SELECT COUNT(*)::int FROM credit_recovery_action ra WHERE ra.credit_file_id=cf.id) AS actions
         FROM credit_file cf JOIN client c ON c.id=cf.client_id
        WHERE cf.imf_id=$1 AND cf.overdue=true ORDER BY cf.overdue_since NULLS LAST, cf.reference`,
      [req.user.imf_id]);
    const tot = (await q(
      `SELECT COALESCE(SUM(overdue_amount_cents),0)::bigint AS t, COUNT(*)::int AS n
         FROM credit_file WHERE imf_id=$1 AND overdue=true`, [req.user.imf_id])).rows[0];
    res.json({ arrears: rows, total_overdue_cents: Number(tot.t), count: tot.n });
  } catch (e) { next(e); }
});

// Enregistrer une action de recouvrement
router.post('/credits/:id/recovery-actions', requirePermission('credit.recovery'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const kind = ['relance', 'promesse', 'echeancier', 'contentieux', 'encaissement'].includes(b.kind) ? b.kind : 'relance';
    const amount = int(b.amount_cents);
    const f = (await q('SELECT id FROM credit_file WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id])).rows[0];
    if (!f) return res.status(404).json({ error: 'dossier_introuvable' });
    const out = await tx(async (c) => {
      const ra = (await c.query(
        `INSERT INTO credit_recovery_action(imf_id, credit_file_id, kind, amount_cents, note, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.imf_id, f.id, kind, amount, (b.note || '').toString().slice(0, 500) || null,
         b.due_date || null, req.user.id])).rows[0];
      if (kind === 'encaissement' && amount > 0) {
        await c.query(
          `UPDATE credit_file SET overdue_amount_cents=GREATEST(overdue_amount_cents-$3,0),
                  overdue=CASE WHEN overdue_amount_cents-$3<=0 THEN false ELSE overdue END,
                  overdue_since=CASE WHEN overdue_amount_cents-$3<=0 THEN NULL ELSE overdue_since END,
                  updated_at=now() WHERE id=$1 AND imf_id=$2`,
          [f.id, req.user.imf_id, amount]);
      }
      return ra;
    });
    await auditEvent(req.user, { action: 'credit.recovery.' + kind, entity: 'credit_recovery_action', entityId: out.id,
      payload: { credit_file_id: f.id, amount_cents: amount } });
    res.status(201).json({ ok: true, action: out, note: 'Action de recouvrement enregistrée.' });
  } catch (e) { next(e); }
});

// Historique de recouvrement d'un dossier
router.get('/credits/:id/recovery-actions', requirePermission('credit.read'), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT ra.*, u.full_name AS created_by_name FROM credit_recovery_action ra
         LEFT JOIN app_user u ON u.id=ra.created_by
        WHERE ra.imf_id=$1 AND ra.credit_file_id=$2 ORDER BY ra.created_at DESC`,
      [req.user.imf_id, req.params.id]);
    res.json({ actions: rows });
  } catch (e) { next(e); }
});

export default router;
