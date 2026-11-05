import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { deviceFromReq } from './devices.js';

const r = Router();

/* ===========================================================================
 * teebo — Clients, enrôlement SIG, ouverture de compte, chaîne de collecte
 *
 * RÈGLES MÉTIER IMPLÉMENTÉES ICI
 *  1. Chaque client est rattaché à une collectrice, elle-même rattachée à un
 *     superviseur (chaîne de collecte obligatoire).
 *  2. Une collectrice peut créer un nouveau client ET enrôler un client existant.
 *  3. L'enrôlement d'un client existant exige OBLIGATOIREMENT : nom et prénom,
 *     n° de compte actuel dans le SIG de l'IMF, solde du client, date du solde.
 *  4. Les informations d'un client enrôlé doivent être complétées sous 1 mois,
 *     sinon le compte est BLOQUÉ en attente de régularisation.
 *  5. Un client doit être créé AVANT l'ouverture de son compte.
 *  6. L'ouverture d'un compte passe par le choix d'un TYPE DE COMPTE D'ÉPARGNE.
 *  7. Une collectrice ne peut créer un compte QUE chez le client : l'application
 *     enregistre automatiquement le GPS du lieu de collecte des dépôts.
 * =========================================================================== */

const FIELD_ROLES = ['staff','agency'];
const SUP_ROLES = ['admin_imf','direction','department','service', 'direction', 'agency'];

/** Champs KYC qui doivent être renseignés pour compléter un enrôlement. */
const KYC_FIELDS = ['birth_date', 'id_number', 'address'];

function todayISO() { return new Date().toISOString().slice(0, 10); }

/** Vrai si la date fournie est une date ISO valide (YYYY-MM-DD). */
function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Récupère la collectrice + son superviseur (remontée hiérarchique). */
async function resolveChain(c, imfId, collectriceUserId) {
  const col = (await c.query(
    `SELECT id, code_user, full_name, role, org_unit_id FROM app_user
      WHERE id=$1 AND imf_id=$2 AND is_active=true`, [collectriceUserId, imfId])).rows[0];
  if (!col) { const e = new Error('collectrice_introuvable'); e.status = 404; throw e; }
  const allowed = FIELD_ROLES.concat(SUP_ROLES);
  if (!allowed.includes(col.role)) {
    const e = new Error('role_non_habilité_pour_la_collecte'); e.status = 422; throw e;
  }

  // Remontée de l'arborescence org_unit pour trouver le superviseur.
  let sup = null;
  let unitId = col.org_unit_id;
  let guard = 0;
  while (unitId && guard < 8 && !sup) {
    guard++;
    const s = (await c.query(
      `SELECT u.id, u.code_user, u.full_name, u.role, u.org_unit_id
         FROM app_user u
         JOIN org_unit o ON o.id = u.org_unit_id
        WHERE u.imf_id=$1 AND u.is_active=true
          AND u.role = ANY($2::user_role[])
          AND (u.org_unit_id = $3 OR u.org_unit_id = o.parent_id)
        ORDER BY (u.org_unit_id = $3) DESC
        LIMIT 1`, [imfId, SUP_ROLES, unitId])).rows[0];
    if (s) { sup = s; break; }
    const parent = (await c.query('SELECT parent_id FROM org_unit WHERE id=$1', [unitId])).rows[0];
    unitId = parent ? parent.parent_id : null;
  }
  // Repli : superviseur désigné au niveau IMF (admin).
  if (!sup) {
    sup = (await c.query(
      `SELECT id, code_user, full_name, role, org_unit_id FROM app_user
        WHERE imf_id=$1 AND is_active=true AND role='admin_imf' LIMIT 1`, [imfId])).rows[0] || null;
  }
  return { collectrice: col, superviseur: sup };
}

/** Extrait et normalise le GPS transmis par le terminal mobile. */
function readGps(b) {
  const lat = b.gps_lat !== undefined && b.gps_lat !== null && b.gps_lat !== '' ? Number(b.gps_lat) : null;
  const lng = b.gps_lng !== undefined && b.gps_lng !== null && b.gps_lng !== '' ? Number(b.gps_lng) : null;
  const acc = b.gps_accuracy_m !== undefined && b.gps_accuracy_m !== null ? Number(b.gps_accuracy_m) : null;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    acc: Number.isFinite(acc) ? acc : null,
    ok: Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  };
}

/** Terminal actif de la collectrice qui effectue l'action (couplage strict). */
async function activeDevice(c, imfId, userId, req) {
  const { imei, mac } = deviceFromReq(req);
  const d = (await c.query(
    `SELECT id, status, user_id FROM device WHERE imf_id=$1 AND imei=$2 AND mac_address=$3`,
    [imfId, imei, mac])).rows[0];
  return d && d.status === 'active' && d.user_id === userId ? d : null;
}

/* ------------------------------------------------------------------ */
/*  Catalogue des types de compte d'épargne : servi par routes/products.js*/
/*  (catalogue enrichi : nature, intérêts, frais de tenue, commissions).  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  1. CRÉATION d'un NOUVEAU client (par la collectrice, chez le client)*/
/*     Le client est créé AVANT l'ouverture du compte.                  */
/* ------------------------------------------------------------------ */
r.post('/clients/new', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const gps = readGps(b);
    const lastname = (b.lastname || '').trim();
    const firstname = (b.firstname || '').trim();
    const fullName = (b.full_name || '').trim() || [firstname, lastname].filter(Boolean).join(' ');
    if (!fullName) return res.status(400).json({ error: 'missing_field', field: 'nom et prénom' });
    if (!isISODate(b.birth_date)) return res.status(400).json({ error: 'missing_field', field: 'date de naissance' });
    if (!b.id_number) return res.status(400).json({ error: 'missing_field', field: 'pièce d\'identité' });
    if (!gps.ok) return res.status(400).json({ error: 'gps_required',
      message: 'Le GPS du lieu de collecte est obligatoire : la création doit se faire chez le client.' });

    const out = await tx(async (c) => {
      const dev = await activeDevice(c, req.user.imf_id, req.user.id, req);
      const chain = await resolveChain(c, req.user.imf_id, req.user.id);
      const code = (await c.query('SELECT fn_gen_client_code($1) AS code', [req.user.imf_id])).rows[0].code;
      const cl = (await c.query(
        `INSERT INTO client(imf_id,code_client,full_name,birth_date,phone,id_number,address,
              collectrice_user_id,superviseur_user_id,agency_unit_id,origin,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',$11) RETURNING *`,
        [req.user.imf_id, code, fullName, b.birth_date || null, b.phone || null, b.id_number || null,
         b.address || null, chain.collectrice.id, chain.superviseur ? chain.superviseur.id : null,
         chain.collectrice.org_unit_id, req.user.id])).rows[0];
      return { client: cl, chain, device: dev ? dev.id : null };
    });
    res.status(201).json({
      client: out.client,
      collectrice: { id: out.chain.collectrice.id, full_name: out.chain.collectrice.full_name },
      superviseur: out.chain.superviseur ? { id: out.chain.superviseur.id, full_name: out.chain.superviseur.full_name } : null,
      gps: { lat: gps.lat, lng: gps.lng, accuracy_m: gps.acc },
      note: 'Client créé. Ouvrez maintenant son compte d\'épargne (choix du type obligatoire).'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  2. ENRÔLEMENT d'un client EXISTANT (migration depuis le SIG)        */
/*     Obligatoire : nom+prénom, n° de compte SIG, solde, date du solde.*/
/* ------------------------------------------------------------------ */
r.post('/clients/enroll', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const gps = readGps(b);
    const fullName = (b.full_name || '').trim() ||
      [ (b.firstname || '').trim(), (b.lastname || '').trim() ].filter(Boolean).join(' ');

    // --- Contrôles des informations OBLIGATOIRES de l'enrôlement ---
    const missing = [];
    if (!fullName) missing.push('nom et prénom');
    if (!b.sig_account_no || !String(b.sig_account_no).trim()) missing.push('numéro de compte actuel dans le SIG');
    const bal = b.initial_balance_cents !== undefined ? Number(b.initial_balance_cents)
      : (b.sig_balance_cents !== undefined ? Number(b.sig_balance_cents) : null);
    if (bal === null || !Number.isFinite(bal)) missing.push('solde du client');
    const asOf = b.balance_as_of || b.sig_balance_as_of;
    if (!isISODate(asOf)) missing.push('date du solde');
    if (missing.length) return res.status(400).json({ error: 'missing_enrollment_fields',
      missing, message: 'Informations obligatoires d\'enrôlement manquantes.' });
    if (!gps.ok) return res.status(400).json({ error: 'gps_required',
      message: 'Le GPS du lieu de collecte est obligatoire pour enrôler le client.' });

    const out = await tx(async (c) => {
      const dup = (await c.query(
        'SELECT id FROM client_enrollment WHERE imf_id=$1 AND sig_account_no=$2',
        [req.user.imf_id, String(b.sig_account_no).trim()])).rows[0];
      if (dup) { const e = new Error('sig_account_already_enrolled'); e.status = 409; throw e; }

      const dev = await activeDevice(c, req.user.imf_id, req.user.id, req);
      const chain = await resolveChain(c, req.user.imf_id, req.user.id);
      const code = (await c.query('SELECT fn_gen_client_code($1) AS code', [req.user.imf_id])).rows[0].code;
      const cl = (await c.query(
        `INSERT INTO client(imf_id,code_client,full_name,birth_date,phone,id_number,address,
              collectrice_user_id,superviseur_user_id,agency_unit_id,origin,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'enrolled',$11) RETURNING *`,
        [req.user.imf_id, code, fullName, b.birth_date || null, b.phone || null, b.id_number || null,
         b.address || null, chain.collectrice.id, chain.superviseur ? chain.superviseur.id : null,
         chain.collectrice.org_unit_id, req.user.id])).rows[0];

      // Compte repris du SIG : créé dès l'enrôlement, alimenté avec le solde déclaré.
      const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
      const acc = (await c.query(
        `INSERT INTO account(imf_id,client_id,code_account,balance_cents,currency,status,product_code,
              opened_by_user_id,opened_at_device_id,opened_at_agency_unit_id,
              gps_lat,gps_lng,gps_accuracy_m,gps_captured_at)
         VALUES ($1,$2,$3,$4,'XOF','active',NULL,$5,$6,$7,$8,$9,$10,now()) RETURNING *`,
        [req.user.imf_id, cl.id, acode, Math.round(bal), req.user.id, dev ? dev.id : null,
         chain.collectrice.org_unit_id, gps.lat, gps.lng, gps.acc])).rows[0];

      const en = (await c.query(
        `INSERT INTO client_enrollment(imf_id,client_id,account_id,collectrice_user_id,
              sig_account_no,sig_balance_cents,sig_balance_as_of,sig_system,
              birth_date,id_number,address,next_of_kin,deadline_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + interval '1 month','pending')
         RETURNING *`,
        [req.user.imf_id, cl.id, acc.id, chain.collectrice.id,
         String(b.sig_account_no).trim(), Math.round(bal), asOf, b.sig_system || null,
         b.birth_date || null, b.id_number || null, b.address || null, b.next_of_kin || null])).rows[0];

      return { client: cl, account: acc, enrollment: en, chain };
    });

    res.status(201).json({
      client: out.client,
      account: out.account,
      enrollment: {
        id: out.enrollment.id,
        sig_account_no: out.enrollment.sig_account_no,
        sig_balance_cents: out.enrollment.sig_balance_cents,
        sig_balance_as_of: out.enrollment.sig_balance_as_of,
        deadline_at: out.enrollment.deadline_at,
        status: out.enrollment.status
      },
      collectrice: { id: out.chain.collectrice.id, full_name: out.chain.collectrice.full_name },
      superviseur: out.chain.superviseur ? { id: out.chain.superviseur.id, full_name: out.chain.superviseur.full_name } : null,
      note: 'Client existant enrôlé. Les informations doivent être complétées avant le ' +
            new Date(out.enrollment.deadline_at).toLocaleDateString('fr-FR') +
            ', sinon le compte sera bloqué en attente de régularisation.'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  3. COMPLÉTION des informations d'un client enrôlé (< 1 mois)        */
/* ------------------------------------------------------------------ */
r.post('/clients/:id/complete-enrollment', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const en = (await q('SELECT * FROM client_enrollment WHERE client_id=$1', [cl.id])).rows[0];
    if (!en) return res.status(409).json({ error: 'client_non_enrole' });
    if (en.status === 'completed') return res.status(409).json({ error: 'deja_complete' });

    const merged = {
      birth_date: b.birth_date || en.birth_date,
      id_number: b.id_number || en.id_number,
      address: b.address || en.address
    };
    const stillMissing = KYC_FIELDS.filter((f) => !merged[f]);
    if (stillMissing.length) return res.status(400).json({ error: 'kyc_incomplet', missing: stillMissing });

    const out = await tx(async (c) => {
      await c.query(
        `UPDATE client SET birth_date=$1, id_number=$2, address=$3, phone=COALESCE($4, phone) WHERE id=$5`,
        [merged.birth_date, merged.id_number, merged.address, b.phone || null, cl.id]);
      const e2 = (await c.query(
        `UPDATE client_enrollment SET birth_date=$1, id_number=$2, address=$3, id_document_url=$4,
              next_of_kin=$5, status='completed', completed_at=now()
          WHERE client_id=$6 RETURNING *`,
        [merged.birth_date, merged.id_number, merged.address, b.id_document_url || en.id_document_url,
         b.next_of_kin || en.next_of_kin, cl.id])).rows[0];
      // Le compte éventuellement bloqué pour défaut de complétion est réactivé.
      const acc = (await c.query(
        `UPDATE account SET status='active', blocked_at=NULL, blocked_reason=NULL
          WHERE client_id=$1 AND status='blocked' AND blocked_reason='enrollment_incomplete'
          RETURNING id, code_account, status`, [cl.id])).rows[0] || null;
      return { enrollment: e2, reactivated_account: acc };
    });
    res.json({ ok: true, enrollment_status: out.enrollment.status,
      reactivated_account: out.reactivated_account });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  4. SUIVI : état de complétion des enrôlements (J-15 / J-25)        */
/* ------------------------------------------------------------------ */
r.get('/clients/completeness', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT e.id, e.status, e.deadline_at, e.sig_account_no, e.sig_balance_cents,
            e.sig_balance_as_of, cl.code_client, cl.full_name AS client_name,
            a.code_account, a.status AS account_status,
            u.full_name AS collectrice_name,
            CEIL(EXTRACT(EPOCH FROM (e.deadline_at - now()))/86400)::int AS days_left
       FROM client_enrollment e
       JOIN client cl ON cl.id = e.client_id
       LEFT JOIN account a ON a.id = e.account_id
       LEFT JOIN app_user u ON u.id = e.collectrice_user_id
      WHERE e.imf_id=$1 AND e.status <> 'completed'
      ORDER BY e.deadline_at ASC`, [req.user.imf_id]);
  res.json({ enrollments: rows, count: rows.length });
});

/** Relances J-15 et J-25 aux collectrices (et à leur superviseur). */
r.get('/clients/reminders', requireRole('admin_imf','direction','department','service'), async (req, res) => {
  const { rows } = await q(
    `SELECT e.id, cl.full_name AS client_name, e.sig_account_no, e.deadline_at,
            CEIL(EXTRACT(EPOCH FROM (e.deadline_at - now()))/86400)::int AS days_left,
            u.id AS collectrice_id, u.full_name AS collectrice_name, u.phone AS collectrice_phone,u.email AS collectrice_email,
            s.full_name AS superviseur_name
       FROM client_enrollment e
       JOIN client cl ON cl.id = e.client_id
       LEFT JOIN app_user u ON u.id = e.collectrice_user_id
       LEFT JOIN app_user s ON s.id = cl.superviseur_user_id
      WHERE e.imf_id=$1 AND e.status='pending'
        AND e.deadline_at <= now() + interval '15 days'
      ORDER BY e.deadline_at`, [req.user.imf_id]);
  res.json({
    reminders: rows.map((x) => ({
      ...x,
      level: x.days_left <= 5 ? 'J-5' : x.days_left <= 15 ? 'J-15' : 'J-25',
      message: `teebo: le dossier du client ${x.client_name} (compte SIG ${x.sig_account_no}) ` +
        `doit être complété sous ${x.days_left} jour(s), sinon le compte sera bloqué.`
    })),
    count: rows.length
  });
});

/**
 * Balayage quotidien : tout enrôlement non complété dont le délai d'un mois est
 * échu => le compte est BLOQUÉ en attente de régularisation.
 */
r.post('/clients/run-inactivity-sweep', requireRole('admin_imf','direction','department','service'), async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const overdue = (await c.query(
        `SELECT e.id, e.client_id, e.account_id, cl.full_name AS client_name
           FROM client_enrollment e JOIN client cl ON cl.id = e.client_id
          WHERE e.imf_id=$1 AND e.status='pending' AND e.deadline_at < now()
          FOR UPDATE`, [req.user.imf_id])).rows;
      const blocked = [];
      for (const e of overdue) {
        if (e.account_id) {
          const a = (await c.query(
            `UPDATE account SET status='blocked', blocked_at=now(),
                  blocked_reason='enrollment_incomplete'
              WHERE id=$1 AND status='active' RETURNING code_account`,
            [e.account_id])).rows[0];
          if (a) blocked.push({ client_name: e.client_name, code_account: a.code_account });
        }
        await c.query(
          `UPDATE client_enrollment SET status='blocked', blocked_at=now() WHERE id=$1`, [e.id]);
      }
      return { overdue: overdue.length, blocked };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  5. OUVERTURE DE COMPTE : type d'épargne obligatoire + GPS capture   */
/*     Une collectrice ne peut créer un compte QUE chez le client.      */
/* ------------------------------------------------------------------ */
r.post('/accounts/open', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const gps = readGps(b);
    const clientId = b.client_id;
    const productCode = (b.product_code || '').trim();

    if (!clientId) return res.status(400).json({ error: 'client_required',
      message: 'Un client doit être créé AVANT l\'ouverture de son compte.' });
    if (!productCode) return res.status(400).json({ error: 'savings_product_required',
      message: 'L\'ouverture d\'un compte passe par le choix d\'un type de compte d\'épargne.' });
    if (!gps.ok) return res.status(400).json({ error: 'gps_required',
      message: 'Le compte doit être ouvert chez le client : le GPS du lieu de collecte est obligatoire.' });

    const out = await tx(async (c) => {
      const prod = (await c.query(
        'SELECT * FROM savings_product WHERE code=$1 AND is_active=true', [productCode])).rows[0];
      if (!prod) { const e = new Error('savings_product_inconnu'); e.status = 400; throw e; }

      const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
        [clientId, req.user.imf_id])).rows[0];
      if (!cl) { const e = new Error('client_introuvable'); e.status = 404; throw e; }

      // Un client doit exister avant l'ouverture de son compte — et n'en a qu'un ici.
      const existing = (await c.query(
        'SELECT id, code_account FROM account WHERE client_id=$1 LIMIT 1', [cl.id])).rows[0];
      if (existing) { const e = new Error('compte_deja_ouvert'); e.status = 409; throw e; }

      // KYC requis par le produit : un enrôlement non complété ne suffit pas.
      if (prod.requires_kyc_complete) {
        const en = (await c.query('SELECT status FROM client_enrollment WHERE client_id=$1', [cl.id])).rows[0];
        if (en && en.status !== 'completed')
          { const e = new Error('kyc_incomplet_pour_ce_produit'); e.status = 409; throw e; }
        const kycOk = cl.birth_date && cl.id_number && cl.address;
        if (!en && !kycOk) { const e = new Error('kyc_incomplet_pour_ce_produit'); e.status = 409; throw e; }
      }

      const dev = await activeDevice(c, req.user.imf_id, req.user.id, req);
      const chain = await resolveChain(c, req.user.imf_id, req.user.id);
      const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
      const acc = (await c.query(
        `INSERT INTO account(imf_id,client_id,code_account,currency,status,product_code,
              opened_by_user_id,opened_at_device_id,opened_at_agency_unit_id,
              gps_lat,gps_lng,gps_accuracy_m,gps_captured_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,now()) RETURNING *`,
        [req.user.imf_id, cl.id, acode, b.currency || 'XOF', prod.code, req.user.id,
         dev ? dev.id : null, chain.collectrice.org_unit_id, gps.lat, gps.lng, gps.acc])).rows[0];

      // Le compte du client est rattaché à sa collectrice / superviseur.
      if (!cl.collectrice_user_id) {
        await c.query('UPDATE client SET collectrice_user_id=$1, superviseur_user_id=$2, agency_unit_id=COALESCE(agency_unit_id,$3) WHERE id=$4',
          [chain.collectrice.id, chain.superviseur ? chain.superviseur.id : null,
           chain.collectrice.org_unit_id, cl.id]);
      }
      return { account: acc, product: prod, chain };
    });

    res.status(201).json({
      account: out.account,
      savings_product: { code: out.product.code, label: out.product.label,
        interest_rate_bp: out.product.interest_rate_bp, min_balance_cents: out.product.min_balance_cents },
      gps: { lat: gps.lat, lng: gps.lng, accuracy_m: gps.acc },
      collectrice: { id: out.chain.collectrice.id, full_name: out.chain.collectrice.full_name },
      superviseur: out.chain.superviseur ? { id: out.chain.superviseur.id, full_name: out.chain.superviseur.full_name } : null,
      note: 'Compte ouvert. Le GPS du lieu de collecte a été enregistré automatiquement.'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  6. Chaîne de collecte : rattachement et consultation               */
/* ------------------------------------------------------------------ */
r.post('/clients/:id/assign', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await tx(async (c) => {
      const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
        [req.params.id, req.user.imf_id])).rows[0];
      if (!cl) { const e = new Error('client_introuvable'); e.status = 404; throw e; }
      const colId = b.collectrice_user_id || req.user.id;
      const chain = await resolveChain(c, req.user.imf_id, colId);
      const cl2 = (await c.query(
        `UPDATE client SET collectrice_user_id=$1, superviseur_user_id=$2, agency_unit_id=$3
          WHERE id=$4 RETURNING *`,
        [chain.collectrice.id, chain.superviseur ? chain.superviseur.id : null,
         chain.collectrice.org_unit_id, cl.id])).rows[0];
      return { client: cl2, chain };
    });
    res.json({
      client: { id: out.client.id, code_client: out.client.code_client, full_name: out.client.full_name },
      collectrice: { id: out.chain.collectrice.id, full_name: out.chain.collectrice.full_name },
      superviseur: out.chain.superviseur ? { id: out.chain.superviseur.id, full_name: out.chain.superviseur.full_name } : null
    });
  } catch (e) { next(e); }
});

r.get('/clients/:id/hierarchy', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const col = cl.collectrice_user_id ? (await q(
      'SELECT id, full_name, code_user, role FROM app_user WHERE id=$1', [cl.collectrice_user_id])).rows[0] : null;
    const sup = cl.superviseur_user_id ? (await q(
      'SELECT id, full_name, code_user, role FROM app_user WHERE id=$1', [cl.superviseur_user_id])).rows[0] : null;
    const ag = cl.agency_unit_id ? (await q(
      'SELECT id, name, code_unit, city FROM org_unit WHERE id=$1', [cl.agency_unit_id])).rows[0] : null;
    res.json({ client: { id: cl.id, code_client: cl.code_client, full_name: cl.full_name, origin: cl.origin },
      collectrice: col, superviseur: sup, agence: ag });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  7. Liste des clients (chaîne de collecte + GPS + enrôlement)       */
r.get('/clients', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT c.id, c.code_client, c.full_name, c.phone, c.origin, c.created_at,
            a.code_account, a.balance_cents, a.currency, a.status,
            a.product_code, sp.label AS product_label,
            a.gps_lat, a.gps_lng, a.opened_at,
            col.id AS collectrice_id, col.full_name AS collectrice_name, col.code_user AS collectrice_code,
            sup.full_name AS superviseur_name,
            e.id AS enrollment_id, e.status AS enrollment_status, e.deadline_at,
            CEIL(EXTRACT(EPOCH FROM (e.deadline_at - now()))/86400)::int AS enrollment_days_left,
            cp.login_mode, cp.statement_format, cp.is_active AS portal_active
       FROM client c
       LEFT JOIN account a ON a.client_id = c.id
       LEFT JOIN savings_product sp ON sp.code = a.product_code
       LEFT JOIN app_user col ON col.id = c.collectrice_user_id
       LEFT JOIN app_user sup ON sup.id = c.superviseur_user_id
       LEFT JOIN client_enrollment e ON e.client_id = c.id
       LEFT JOIN client_portal cp ON cp.client_id = c.id
      WHERE c.imf_id=$1 ORDER BY c.created_at DESC LIMIT 300`, [req.user.imf_id]);
  res.json({ clients: rows });
});

/* ------------------------------------------------------------------ */
/*  8. Dépôt de collecte chez le client (GPS horodaté)                 */
/*     Refusé si le compte est bloqué (régularisation en attente).      */
r.post('/operations/collect-deposit', requireRole('staff','agency'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const gps = readGps(b);
    const amount = Math.round(Number(b.amount_cents || 0));
    if (!(amount > 0)) return res.status(400).json({ error: 'montant_invalide' });
    if (!gps.ok) return res.status(400).json({ error: 'gps_required',
      message: 'Le dépôt doit être encaissé chez le client : GPS obligatoire.' });

    const acc = (await q('SELECT * FROM account WHERE code_account=$1 AND imf_id=$2',
      [b.account_code, req.user.imf_id])).rows[0];
    if (!acc) return res.status(404).json({ error: 'compte_introuvable' });
    if (acc.status === 'blocked') return res.status(409).json({ error: 'compte_bloque',
      blocked_reason: acc.blocked_reason,
      message: 'Compte bloqué dans l\'attente de la régularisation des informations du client.' });

    const out = await tx(async (c) => {
      const dev = await activeDevice(c, req.user.imf_id, req.user.id, req);
      const op = (await c.query(
        `INSERT INTO operation(imf_id,account_id,device_id,user_id,kind,amount_cents,status,
              impacts_agent_cash,reference,note,gps_lat,gps_lng,gps_accuracy_m)
         VALUES ($1,$2,$3,$4,'depot',$5,'valide',true,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.imf_id, acc.id, dev ? dev.id : null, req.user.id, amount,
         b.reference || null, b.note || null, gps.lat, gps.lng, gps.acc])).rows[0];
      await c.query('UPDATE account SET balance_cents = balance_cents + $1 WHERE id=$2', [amount, acc.id]);
      return op;
    });
    res.status(201).json({ operation: out, gps: { lat: gps.lat, lng: gps.lng, accuracy_m: gps.acc } });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  9. Création d'un espace client en ligne (rattaché à la collectrice) */
r.post('/clients/:id/portal', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const exist = (await q('SELECT id FROM client_portal WHERE client_id=$1', [cl.id])).rows[0];
    if (exist) return res.status(409).json({ error: 'espace_deja_cree' });
    const loginMode = ['mot_de_passe', 'sms_otp', 'pin'].includes(b.login_mode) ? b.login_mode : 'mot_de_passe';
    const fmt = ['pdf', 'csv', 'les_deux'].includes(b.statement_format) ? b.statement_format : 'pdf';
    const pwd = b.password || ('Tb' + crypto.randomInt(100000, 999999));
    const hash = await bcrypt.hash(pwd, 10);
    const p = (await q(
      `INSERT INTO client_portal(imf_id,client_id,login_mode,password_hash,statement_format,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING login_mode, statement_format, is_active`,
      [req.user.imf_id, cl.id, loginMode, hash, fmt, req.user.id])).rows[0];
    res.status(201).json({ portal: p, client: { id: cl.id, code_client: cl.code_client, full_name: cl.full_name },
      credentials: { temporary_password: pwd } });
  } catch (e) { next(e); }
});

export default r;
