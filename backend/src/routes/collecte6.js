/* ===================================================================
 * teebo — VAGUE 6 : routes
 *   - anti-doublons (check + validation à la création)
 *   - affectations superviseur -> collectrice (motifs + durée)
 *   - relevé BCEAO (HTML / CSV)
 *   - approbation caissière + export Excel des dépôts
 * =================================================================== */
import { Router } from 'express';
import { habilit } from '../rbac_strict.js';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import {
  ASSIGN_REASONS, reasonRequiresDays, reasonLabel,
  findClientDuplicate, logDuplicate, clientHasActiveAccount,
  listAssignments, listCollectrices, computeEndsOn,
  buildBceaoStatement, renderBceaoHtml, renderBceaoCsv,
  buildCollectionExport, renderCollectionExcel
} from '../collecte_extra.js';

const r = Router();
const READ = ['admin_imf','direction','department','service','agency','staff','caissier'];
const SUP = ['admin_imf','direction','department','service','agency'];
const CASHIER = ['admin_imf','direction','caissier'];

/* --------------------------- Référentiels -------------------------------- */

/** Motifs d'affectation + indication « nombre de jours requis ». */
r.get('/collecte/assign-reasons', (_req, res) => res.json({ reasons: ASSIGN_REASONS }));

/** Collectrices de l'IMF (pour l'écran d'affectation du superviseur). */
r.get('/collecte/collectrices', requireRole(...SUP), async (req, res) => {
  res.json({ collectrices: await listCollectrices(req.user.imf_id) });
});

/* --------------------------- Anti-doublons ------------------------------- */

/** Vérifie l'existence d'un doublon AVANT création (client). */
r.post('/clients/check-duplicate', requireRole(...SUP, 'staff'), async (req, res, next) => {
  try {
    const out = await findClientDuplicate(req.user.imf_id, req.body || {});
    if (out.duplicate)
      await logDuplicate({ imfId: req.user.imf_id, entity: 'client',
        matchedId: out.matches[0].id, reason: out.matches[0].reason,
        payload: { input: req.body }, actorId: req.user.id });
    res.json(out);
  } catch (e) { next(e); }
});

/* --------------------------- Affectations -------------------------------- */

/** Liste des affectations actives. */
r.get('/collecte/assignments', requireRole(...READ), async (req, res, next) => {
  try { res.json({ assignments: await listAssignments(req.user.imf_id) }); }
  catch (e) { next(e); }
});

/**
 * Affecter des clients à une collectrice.
 *   scope  : 'tous' | 'selection'
 *   reason : demission | conge | absence | deces
 *   days   : requis pour demission / conge / absence
 *   client_ids : requis si scope = 'selection'
 */
r.post('/collecte/assignments', requireRole(...SUP), habilit('collecte.assign','round.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const scope = b.scope === 'tous' ? 'tous' : 'selection';
    const reason = String(b.reason || '').trim();
    if (!ASSIGN_REASONS.some((x) => x.code === reason))
      return res.status(422).json({ error: 'invalid_reason', allowed: ASSIGN_REASONS.map(x => x.code) });
    const days = b.days != null && b.days !== '' ? Number(b.days) : null;
    if (reasonRequiresDays(reason) && (!days || days < 1))
      return res.status(422).json({ error: 'days_required',
        message: 'Précisez le nombre de jours d\'affectation pour ce motif.' });
    if (!b.collectrice_user_id)
      return res.status(422).json({ error: 'collectrice_required', message: 'Choisissez la collectrice.' });
    const col = (await q(
      `SELECT id, full_name FROM app_user WHERE id=$1 AND imf_id=$2 AND is_active`,
      [b.collectrice_user_id, req.user.imf_id])).rows[0];
    if (!col) return res.status(404).json({ error: 'collectrice_not_found' });

    let ids = Array.isArray(b.client_ids) ? b.client_ids : [];
    if (scope === 'selection' && !ids.length)
      return res.status(422).json({ error: 'client_ids_required', message: 'Sélectionnez au moins un client.' });

    const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(b.starts_on || '') ? b.starts_on : new Date().toISOString().slice(0, 10);
    const endsOn = computeEndsOn(startsOn, reason, days);

    const out = await tx(async (c) => {
      const a = (await c.query(
        `INSERT INTO collectrice_assignment(imf_id,collectrice_user_id,scope,reason,days,starts_on,ends_on,note,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.user.imf_id, col.id, scope, reason, reasonRequiresDays(reason) ? days : null,
         startsOn, endsOn, b.note || null, req.user.id])).rows[0];

      if (scope === 'tous') {
        ids = (await c.query('SELECT id FROM client WHERE imf_id=$1', [req.user.imf_id])).rows.map(x => x.id);
        // « tous les clients » : on réaffecte aussi le référentiel client.
        await c.query('UPDATE client SET collectrice_user_id=$1 WHERE imf_id=$2', [col.id, req.user.imf_id]);
      } else {
        const valid = (await c.query(
          'SELECT id FROM client WHERE imf_id=$1 AND id = ANY($2::uuid[])',
          [req.user.imf_id, ids])).rows.map(x => x.id);
        ids = valid;
        for (const cid of ids)
          await c.query('UPDATE client SET collectrice_user_id=$1 WHERE id=$2 AND imf_id=$3', [col.id, cid, req.user.imf_id]);
      }
      for (const cid of ids)
        await c.query('INSERT INTO collectrice_assignment_client(assignment_id,client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [a.id, cid]);
      return { assignment: a, clients_count: ids.length };
    });

    res.status(201).json({ ok: true, ...out, collectrice_name: col.full_name,
      reason_label: reasonLabel(reason), days: reasonRequiresDays(reason) ? days : null, ends_on: endsOn,
      message: 'Affectation enregistrée : ' + out.clients_count + ' client(s) confiés à ' + col.full_name + '.' });
  } catch (e) { next(e); }
});

/** Clôturer une affectation (retour à la normale). */
r.post('/collecte/assignments/:id/close', requireRole(...SUP), habilit('collecte.assign','collecte.supervise'), async (req, res, next) => {
  try {
    const out = (await q(
      `UPDATE collectrice_assignment SET status='closed' WHERE id=$1 AND imf_id=$2 RETURNING *`,
      [req.params.id, req.user.imf_id])).rows[0];
    if (!out) return res.status(404).json({ error: 'assignment_not_found' });
    res.json({ ok: true, assignment: out });
  } catch (e) { next(e); }
});

/* ------------------------- Relevé BCEAO client --------------------------- */

/** Structure normalisée du relevé (JSON). */
r.get('/clients/:id/statement-bceao', requireRole(...READ), async (req, res, next) => {
  try {
    const from = req.query.from || null, to = req.query.to || null;
    const st = await buildBceaoStatement(req.user.imf_id, req.params.id, { from, to });
    if (!st) return res.status(404).json({ error: 'client_not_found' });
    res.json({ statement: st });
  } catch (e) { next(e); }
});

/** Relevé imprimable (HTML) ou fichier CSV/Excel. */
r.get('/clients/:id/statement-export', requireRole(...READ), async (req, res, next) => {
  try {
    const fmt = (req.query.format || 'html').toLowerCase();
    const from = req.query.from || null, to = req.query.to || null;
    const st = await buildBceaoStatement(req.user.imf_id, req.params.id, { from, to });
    if (!st) return res.status(404).json({ error: 'client_not_found' });
    await q(`INSERT INTO statement_issue(imf_id,client_id,account_id,period_from,period_to,format,issued_by)
             VALUES ($1,$2,(SELECT id FROM account WHERE client_id=$2 LIMIT 1),$3,$4,$5,$6)`,
      [req.user.imf_id, req.params.id, from, to, fmt, req.user.id]);
    const name = 'releve_' + (st.client.code_client || 'client');
    if (fmt === 'csv' || fmt === 'excel' || fmt === 'xls') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.send(renderBceaoCsv(st));
    }
    res.type('html').send(renderBceaoHtml(st));
  } catch (e) { next(e); }
});

/* ------------------- Approbation caissière + export Excel ---------------- */

/**
 * Approbation du versement par la caissière (reception du solde de collecte).
 * Clôture le solde de caisse de la collectrice en acceptant son reversement.
 */
r.post('/collecte/cash-deposits/:id/approve', requireRole(...CASHIER), habilit('cash.approve','cash.validate'), async (req, res, next) => {
  try {
    const note = (req.body && req.body.note) || null;
    const out = await tx(async (c) => {
      const dep = (await c.query('SELECT * FROM cash_deposit WHERE id=$1 AND imf_id=$2 FOR UPDATE',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!dep) { const e = new Error('Versement introuvable.'); e.status = 404; throw e; }
      if (dep.status !== 'declare') { const e = new Error('Ce versement a déjà été traité.'); e.status = 409; e.code = 'already_handled'; throw e; }
      const upd = (await c.query(
        `UPDATE cash_deposit SET status='valide', validated_by=$2, validated_at=now(),
                approved_by=$2, approved_at=now(), approval_note=$3
          WHERE id=$1 RETURNING *`, [dep.id, req.user.id, note])).rows[0];
      return upd;
    });
    res.json({ ok: true, cash_deposit: out,
      message: 'Reversement accepté. La caisse de la collectrice est clôturée pour ce versement.' });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message }); next(e); }
});

/** Export Excel (CSV ouvrable dans Excel) des dépôts de collecte. */
r.get('/collecte/export', requireRole(...READ), async (req, res, next) => {
  try {
    const collectriceUserId = req.query.collectrice_user_id || null;
    const from = req.query.from || null, to = req.query.to || null;
    const onlyApproved = req.query.status === 'valide';
    const rows = await buildCollectionExport(req.user.imf_id, { collectriceUserId, from, to, onlyApproved });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="export_depots_collecte.csv"');
    res.send(renderCollectionExcel(rows));
  } catch (e) { next(e); }
});

export default r;
