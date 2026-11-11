import express from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requirePermission } from '../auth.js';
import { auditEvent } from '../audit.js';
import { isCashierPosition } from '../org_structure.js';
import { validateTypology } from '../client_typology.js';
import { validateParticulierDocs } from '../client_documents.js';

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

/* Coupures XOF (FCFA) de la BCEAO : billets puis pièces (valeur faciale). */
const XOF_DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 250, 200, 100, 50, 25, 10, 5];

/* Billetage : à partir d'un objet { "10000": 3, ... } on ne garde que les
 * coupures BCEAO valides, on normalise les quantités (>=0) et on calcule le
 * total en "cents" (= valeur faciale FCFA × 100 × quantité). */
function normalizeDenominations(raw) {
  const clean = {};
  let totalCents = 0;
  if (raw && typeof raw === 'object') {
    for (const face of XOF_DENOMINATIONS) {
      const qty = Math.max(0, int(raw[face] != null ? raw[face] : raw[String(face)]));
      if (qty > 0) { clean[String(face)] = qty; totalCents += face * 100 * qty; }
    }
  }
  return { denominations: clean, countedCents: totalCents };
}

/* Solde théorique de caisse d'un utilisateur (caissier OU agent de collecte).
 *
 * MODÈLE : à CHAQUE arrêté, la caisse est VIDÉE (le caissier délesté tout le
 * compté vers le coffre-fort ; l'agent de collecte reverse tout au caissier).
 * La caisse repart donc de ZÉRO après un arrêté : carry = 0.
 *
 * Le théorique depuis le dernier arrêté =
 *   - les DÉPÔTS encaissés qui impactent la caisse de l'agent (impacts_agent_cash) ;
 *   - PLUS, pour le CAISSIER uniquement, les APPROVISIONNEMENTS de sa caisse
 *     reçus du coffre (vault_movement delestage, counterpart « caisse »).
 *
 * Les RÉGULARISATIONS GUICHET (retrait_regul) n'impactent JAMAIS la caisse
 * physique (impacts_agent_cash = false) : elles sont EXCLUES pour les 2 rôles.
 * L'agent de collecte ne peut pas approvisionner sa sacoche : il n'a que des dépôts.
 */
async function computeTheoretical(imfId, userId, isCashier = false) {
  // Dernier arrêté : la caisse a été vidée, on repart de zéro depuis cette date.
  const last = (await q(
    `SELECT created_at FROM cash_closing
       WHERE imf_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [imfId, userId])).rows[0];
  const since = last ? last.created_at : null;
  // Dépôts encaissés (impactant la caisse de l'agent) depuis l'arrêté.
  const dep = (await q(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s, COUNT(*)::int AS n
       FROM operation
      WHERE imf_id=$1 AND user_id=$2 AND status='valide'
        AND kind='depot' AND impacts_agent_cash=true
        AND ($3::timestamptz IS NULL OR created_at > $3)`,
    [imfId, userId, since])).rows[0];
  const deposits = Number(dep.s);
  let provisions = 0, provCount = 0;
  if (isCashier) {
    // Approvisionnements de la caisse (coffre → caisse) reçus depuis l'arrêté.
    const pr = (await q(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s, COUNT(*)::int AS n
         FROM vault_movement
        WHERE imf_id=$1 AND user_id=$2 AND direction='delestage' AND counterpart='caisse'
          AND ($3::timestamptz IS NULL OR created_at > $3)`,
      [imfId, userId, since])).rows[0];
    provisions = Number(pr.s); provCount = Number(pr.n);
  }
  return {
    theoretical_cents: deposits + provisions,
    carry_cents: 0,
    deposits_cents: deposits,
    provisions_cents: provisions,
    movements_cents: deposits + provisions,
    movements_count: Number(dep.n) + provCount,
    previous_closing_at: since,
    is_cashier: isCashier,
  };
}

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
    // Typologie + qualité de membre : mises à jour seulement si le formulaire
    // de classification a été soumis (présence de client_category).
    let typoSql = '', typoArgs = [];
    if (b.client_category !== undefined && b.client_category !== null && b.client_category !== '') {
      const typo = validateTypology(b);
      if (!typo.ok) return res.status(422).json({ error: typo.error, field: typo.field,
        message: 'Typologie incomplète ou invalide (champ « ' + (typo.field || '') + ' »).' });
      const tv = typo.values;
      const imfRow = (await q('SELECT type FROM imf WHERE id=$1', [req.user.imf_id])).rows[0];
      const isScoop = imfRow && imfRow.type === 'SCOOP';
      let membershipType = null, sharesCount = 0, sharesPaidCents = 0;
      if (isScoop) {
        const dsRow = (await q('SELECT part_sociale_nominal_cents FROM imf_document_settings WHERE imf_id=$1',
          [req.user.imf_id])).rows[0];
        const nominal = dsRow && dsRow.part_sociale_nominal_cents != null ? Number(dsRow.part_sociale_nominal_cents) : null;
        if (b.membership_type === 'membre') {
          if (!nominal || nominal <= 0) return res.status(422).json({ error: 'part_sociale_non_parametree',
            message: 'La valeur nominale de la part sociale n\u2019est pas fixée dans les paramètres de l\u2019IMF.' });
          sharesCount = Math.max(1, Math.trunc(Number(b.shares_count) || 1));
          membershipType = 'membre'; sharesPaidCents = sharesCount * nominal;
        } else { membershipType = 'usager'; }
      }
      typoArgs = [membershipType, sharesCount, sharesPaidCents, tv.client_category, tv.gender,
        tv.profession, tv.profession_detail, tv.group_type, tv.enterprise_segment, tv.legal_form];
      typoSql = `, membership_type=$8, shares_count=$9, shares_paid_cents=$10,
        client_category=$11, gender=$12, profession=$13, profession_detail=$14,
        group_type=$15, enterprise_segment=$16, legal_form=$17`;

      // Pièces requises (PARTICULIER) : persistées si le dossier complet est soumis.
      if (tv.client_category === 'particulier') {
        const dsDoc = (await q('SELECT id_doc_validity_months FROM imf_document_settings WHERE imf_id=$1',
          [req.user.imf_id])).rows[0];
        const validity = dsDoc && dsDoc.id_doc_validity_months ? dsDoc.id_doc_validity_months : {};
        const docBody = { ...b, phone, birth_date };
        const docs = validateParticulierDocs(docBody, { profession: tv.profession, validityMonths: validity });
        if (!docs.ok) return res.status(422).json({ error: docs.error, field: docs.field,
          message: docs.message || 'Pièces requises incomplètes.' });
        const dv = docs.values;
        // Colonnes $18..$36 dans l'ordre de DOC_FIELDS.
        typoArgs.push(dv.first_name, dv.last_name, dv.birth_place,
          dv.id_doc_type, dv.id_doc_received, dv.id_doc_number, dv.id_doc_issue_date, dv.id_doc_expiry_date,
          dv.birth_cert_status, dv.home_location_desc, dv.home_proof_status, dv.home_proof_type,
          dv.activity_location_desc, dv.activity_proof_status, dv.activity_proof_type,
          dv.activity_description, dv.school_name, dv.income_proof_status, dv.income_proof_type,
          dv.beneficiary_last_name, dv.beneficiary_first_name, dv.beneficiary_relation, dv.salary_domiciliation);
        typoSql += `, first_name=$18, last_name=$19, birth_place=$20,
          id_doc_type=$21, id_doc_received=$22, id_doc_number=$23, id_doc_issue_date=$24, id_doc_expiry_date=$25,
          birth_cert_status=$26, home_location_desc=$27, home_proof_status=$28, home_proof_type=$29,
          activity_location_desc=$30, activity_proof_status=$31, activity_proof_type=$32,
          activity_description=$33, school_name=$34, income_proof_status=$35, income_proof_type=$36,
          beneficiary_last_name=$37, beneficiary_first_name=$38, beneficiary_relation=$39, salary_domiciliation=$40`;
      }
    }
    const row = (await q(
      `UPDATE client SET full_name=$3, phone=$4, id_number=$5, address=$6, birth_date=$7` + typoSql + `
        WHERE id=$1 AND imf_id=$2 RETURNING *`,
      [req.params.id, req.user.imf_id, full_name, phone, id_number, address, birth_date, ...typoArgs])).rows[0];
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
 * Habilitation cash.declare : le caissier ET l'agent de collecte arrêtent
 * leur propre caisse (la validation/approbation d'un écart relève du supérieur).
 * ------------------------------------------------------------------------ */

// Solde théorique auto-calculé de la caisse de l'utilisateur courant.
// Sert à pré-remplir (lecture seule) le champ « Solde théorique » du modal.
router.get('/cash/theoretical', requirePermission('cash.declare'), async (req, res, next) => {
  try {
    const t = await computeTheoretical(req.user.imf_id, req.user.id, isCashierPosition(req.user.position_code));
    res.json({ ok: true, ...t, denominations: XOF_DENOMINATIONS });
  } catch (e) { next(e); }
});

router.post('/cash/closings', requirePermission('cash.declare'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // 1) Solde théorique : TOUJOURS recalculé côté serveur (jamais saisi).
    const t = await computeTheoretical(req.user.imf_id, req.user.id, isCashierPosition(req.user.position_code));
    const theoretical = t.theoretical_cents;
    // 2) Espèces comptées : issues du billetage par coupure XOF si fourni,
    //    sinon repli sur counted_cents (compat).
    const hasBilletage = b.denominations && typeof b.denominations === 'object'
      && Object.keys(b.denominations).length > 0;
    const { denominations, countedCents } = normalizeDenominations(b.denominations);
    const counted = hasBilletage ? countedCents : int(b.counted_cents);
    const gap = counted - theoretical;
    const status = gap === 0 ? 'equilibre' : 'ecart';
    // 3) Tout écart doit être justifié AVANT la clôture…
    const justification = (b.gap_justification || '').toString().trim();
    if (gap !== 0 && !justification)
      return res.status(422).json({ error: 'justification_ecart_requise',
        message: 'Un écart de ' + fcfa(gap) + ' FCFA est constaté : il doit être justifié avant la clôture.',
        gap_cents: gap });
    // …et réglé définitivement sous 24h (échéance tracée).
    const isCashier = isCashierPosition(req.user.position_code);
    const out = await tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO cash_closing(imf_id, user_id, closing_date, theoretical_cents, counted_cents,
                gap_cents, status, note, denominations, gap_justification, gap_due_at, created_by)
         VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9::jsonb,$10,
                CASE WHEN $6 <> 0 THEN now() + interval '24 hours' ELSE NULL END,$2) RETURNING *`,
        [req.user.imf_id, req.user.id, b.closing_date || null, theoretical, counted, gap, status,
         (b.note || '').toString().slice(0, 500) || null, JSON.stringify(denominations),
         gap !== 0 ? justification.slice(0, 1000) : null])).rows[0];
      let sideEffect = null;
      if (counted > 0) {
        if (isCashier) {
          // ARRÊTÉ CAISSIER : délestage de TOUT le compté vers le coffre-fort.
          // (vault_movement « approvisionnement » : le coffre encaisse la caisse.)
          const lastv = (await c.query(
            `SELECT balance_after_cents FROM vault_movement WHERE imf_id=$1
               ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [req.user.imf_id])).rows[0];
          const curv = lastv ? Number(lastv.balance_after_cents) : 0;
          const nextv = curv + counted;
          const vm = (await c.query(
            `INSERT INTO vault_movement(imf_id, direction, amount_cents, counterpart, reason,
                    balance_after_cents, created_by, user_id)
             VALUES ($1,'approvisionnement',$2,'caisse',$3,$4,$5,$5) RETURNING *`,
            [req.user.imf_id, counted,
             'Arr\u00eat\u00e9 caissier \u2014 d\u00e9lestage de la caisse vers le coffre-fort',
             nextv, req.user.id])).rows[0];
          sideEffect = { type: 'delestage_coffre', vault_movement: vm, vault_balance_cents: nextv };
        } else {
          // ARRÊTÉ SACOCHE (agent de collecte) : reversement de TOUT le compté au
          // caissier (versement à valider par la caissière).
          const dep = (await c.query(
            `INSERT INTO cash_deposit(imf_id, collectrice_user_id, channel, amount_cents, status, proof_note)
             VALUES ($1,$2,'caisse_caissiere',$3,'declare',$4) RETURNING *`,
            [req.user.imf_id, req.user.id, counted,
             'Reversement issu de l\u2019arr\u00eat\u00e9 de sacoche'])).rows[0];
          sideEffect = { type: 'reversement_caissier', cash_deposit: dep };
        }
      }
      return { row, sideEffect };
    });
    const row = out.row;
    await auditEvent(req.user, { action: 'cash.closing', entity: 'cash_closing', entityId: row.id,
      payload: { gap_cents: gap, status, side_effect: out.sideEffect ? out.sideEffect.type : null } });
    const flow = isCashier
      ? ' Le compt\u00e9 a \u00e9t\u00e9 d\u00e9lest\u00e9 vers le coffre-fort.'
      : ' Le compt\u00e9 a \u00e9t\u00e9 revers\u00e9 au caissier (\u00e0 valider).';
    res.status(201).json({ ok: true, closing: row, side_effect: out.sideEffect,
      note: (status === 'equilibre' ? 'Caisse \u00e9quilibr\u00e9e \u2014 arr\u00eat\u00e9 enregistr\u00e9.'
        : '\u00c9cart de ' + fcfa(gap) + ' FCFA constat\u00e9 \u2014 \u00e0 r\u00e9gler d\u00e9finitivement avant le '
          + new Date(row.gap_due_at).toLocaleString('fr-FR') + '.') + flow });
  } catch (e) { next(e); }
});

// Règlement définitif d'un écart (sous 24h) : trace la résolution.
router.post('/cash/closings/:id/resolve', requirePermission('cash.declare'), async (req, res, next) => {
  try {
    const note = (req.body && req.body.resolution_note || '').toString().trim();
    if (!note) return res.status(422).json({ error: 'note_reglement_requise',
      message: 'Précisez comment l\u2019écart a été réglé.' });
    const row = (await q(
      `UPDATE cash_closing
          SET gap_resolved=true, gap_resolved_at=now(), gap_resolution_note=$3
        WHERE id=$1 AND imf_id=$2 AND status='ecart' AND gap_resolved=false RETURNING *`,
      [req.params.id, req.user.imf_id, note.slice(0, 1000)])).rows[0];
    if (!row) return res.status(409).json({ error: 'ecart_introuvable_ou_deja_regle' });
    await auditEvent(req.user, { action: 'cash.closing.resolve', entity: 'cash_closing', entityId: row.id,
      payload: { gap_cents: Number(row.gap_cents) } });
    res.json({ ok: true, closing: row, note: 'Écart réglé — rapprochement clôturé.' });
  } catch (e) { next(e); }
});

router.get('/cash/closings', requirePermission('operations.read'), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT cc.*, u.full_name AS user_name,
              (cc.status='ecart' AND cc.gap_resolved=false AND cc.gap_due_at < now()) AS gap_overdue
         FROM cash_closing cc
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
 * CAISSE — Approvisionnement de la caisse (coffre → caisse)
 * RÉSERVÉ AU CAISSIER : seul le caissier peut demander un approvisionnement de
 * sa caisse. L'agent de collecte NE PEUT PAS approvisionner sa sacoche.
 * Le mouvement est tracé côté coffre (vault_movement « delestage », le coffre
 * se vide au profit de la caisse) et alimente le solde théorique du caissier.
 * ------------------------------------------------------------------------ */
router.post('/cash/provision', requirePermission('cash.declare'), async (req, res, next) => {
  try {
    if (!isCashierPosition(req.user.position_code))
      return res.status(403).json({ error: 'reserve_caissier',
        message: 'Seul le caissier peut approvisionner sa caisse. '
          + 'L\u2019agent de collecte ne peut pas approvisionner sa sacoche.' });
    const amount = int((req.body || {}).amount_cents);
    if (!(amount > 0)) return res.status(422).json({ error: 'montant_invalide' });
    const out = await tx(async (c) => {
      const last = (await c.query(
        `SELECT balance_after_cents FROM vault_movement WHERE imf_id=$1
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [req.user.imf_id])).rows[0];
      const current = last ? Number(last.balance_after_cents) : 0;
      const next = current - amount;
      if (next < 0) { const e = new Error('coffre_insuffisant'); e.status = 409; throw e; }
      return (await c.query(
        `INSERT INTO vault_movement(imf_id, direction, amount_cents, counterpart, reason,
                balance_after_cents, created_by, user_id)
         VALUES ($1,'delestage',$2,'caisse',$3,$4,$5,$5) RETURNING *`,
        [req.user.imf_id, amount,
         (req.body.reason || '').toString().slice(0, 500) || 'Approvisionnement de la caisse (coffre \u2192 caisse)',
         next, req.user.id])).rows[0];
    });
    await auditEvent(req.user, { action: 'cash.provision', entity: 'vault_movement', entityId: out.id,
      payload: { amount_cents: amount, balance_after_cents: Number(out.balance_after_cents) } });
    res.status(201).json({ ok: true, movement: out, vault_balance_cents: Number(out.balance_after_cents),
      note: 'Caisse approvisionnée de ' + fcfa(amount) + ' FCFA depuis le coffre-fort — '
        + 'solde du coffre : ' + fcfa(out.balance_after_cents) + ' FCFA.' });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: 'coffre_insuffisant',
      message: 'Solde du coffre-fort insuffisant pour cet approvisionnement.' });
    next(e);
  }
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
