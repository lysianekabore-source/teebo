import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { findClientDuplicate, logDuplicate, normalizeClientFields, clientHasActiveAccount } from '../collecte_extra.js';

const r = Router();

/**
 * ÉTAPE 2 DU PARCOURS — Ouverture du compte bancaire d'un client existant.
 * Un client ne peut avoir qu'UN seul compte actif (anti-doublon strict).
 */
r.post('/clients/:id/open-account', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_not_found' });
    const existing = await clientHasActiveAccount(cl.id);
    if (existing) return res.status(409).json({ error: 'account_exists',
      message: 'Ce client possède déjà un compte actif (' + existing.code_account + ').',
      account: existing });
    const b = req.body || {};
    const acc = await tx(async (c) => {
      const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
      return (await c.query(
        `INSERT INTO account(imf_id,client_id,code_account,currency,journey_step)
         VALUES ($1,$2,$3,$4,'compte_ouvert') RETURNING *`,
        [req.user.imf_id, cl.id, acode, b.currency || 'XOF'])).rows[0];
    });
    res.status(201).json({ ok: true, account: acc,
      message: 'Compte ouvert (' + acc.code_account + '). Étape suivante : enregistrer le premier dépôt.' });
  } catch (e) { next(e); }
});

/** Liste des clients de l'IMF. */
r.get('/clients', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT c.*, a.code_account, a.balance_cents, a.currency, a.journey_step,
            cp.login_mode, cp.statement_format, cp.is_active AS portal_active
       FROM client c
       LEFT JOIN account a ON a.client_id = c.id AND a.status='active'
       LEFT JOIN client_portal cp ON cp.client_id = c.id
      WHERE c.imf_id=$1 ORDER BY c.created_at DESC LIMIT 200`, [req.user.imf_id]);
  res.json({ clients: rows });
});

/**
 * Création d'un espace client en ligne (relevé consultable).
 * L'IMF choisit le mode de connexion (mot de passe / SMS / PIN) et le format
 * de relevé (PDF / CSV / les deux). Sans ces choix, défauts : mot_de_passe + pdf.
 */
r.post('/clients', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const b = req.body || {};
  if (!b.full_name) return res.status(400).json({ error: 'Nom complet du client requis' });
  const loginMode = ['mot_de_passe', 'sms_otp', 'pin'].includes(b.login_mode) ? b.login_mode : 'mot_de_passe';
  const fmt = ['pdf', 'csv', 'les_deux'].includes(b.statement_format) ? b.statement_format : 'pdf';
  const pwd = b.password || ('Tb' + crypto.randomInt(100000, 999999));
  const pwdHash = await bcrypt.hash(pwd, 10);

  // --- CONTRÔLE ANTI-DOUBLONS STRICT --------------------------------
  // Refus par défaut si un client identique existe déjà (n° pièce OU nom+tél.).
  // L'administrateur peut forcer la création en cochant explicitement
  // « doublon confirmé » — la décision est journalisée.
  const dup = await findClientDuplicate(req.user.imf_id, b);
  if (dup.duplicate && !b.force_duplicate) {
    await logDuplicate({ imfId: req.user.imf_id, entity: 'client',
      matchedId: dup.matches[0].id, reason: dup.matches[0].reason, payload: b, actorId: req.user.id });
    return res.status(409).json({ error: 'duplicate_client',
      message: 'Un client identique existe déjà (' + dup.matches[0].full_name + ' · ' + dup.matches[0].code_client + '). Création bloquée.',
      matches: dup.matches });
  }

  const nf = normalizeClientFields(b);

  const out = await tx(async (c) => {
    const code = (await c.query('SELECT fn_gen_client_code($1) AS code', [req.user.imf_id])).rows[0].code;
    const cl = (await c.query(
      `INSERT INTO client(imf_id,code_client,full_name,birth_date,phone,id_number,address,
                          name_norm,phone_norm,id_number_norm,collectrice_user_id,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.imf_id, code, nf.full_name, b.birth_date || null, nf.phone,
       nf.id_number, b.address || null, nf.name_norm, nf.phone_norm, nf.id_number_norm,
       b.collectrice_user_id || null, req.user.id])).rows[0];
    const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
    const acc = (await c.query(
      `INSERT INTO account(imf_id,client_id,code_account,currency,journey_step) VALUES ($1,$2,$3,$4,'compte_ouvert') RETURNING *`,
      [req.user.imf_id, cl.id, acode, b.currency || 'XOF'])).rows[0];
    const portal = (await c.query(
      `INSERT INTO client_portal(imf_id,client_id,login_mode,password_hash,statement_format,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING login_mode, statement_format, is_active, must_change_password`,
      [req.user.imf_id, cl.id, loginMode, pwdHash, fmt, req.user.id])).rows[0];
    return { client: cl, account: acc, portal };
  });
  res.status(201).json({ ...out, credentials: { code_client: out.client.code_client,
    code_account: out.account.code_account, temporary_password: pwd } });
});

/** Relevé de compte du client (format PDF renvoyé en HTML imprimable, ou CSV). */
r.get('/clients/:id/statement', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const fmt = (req.query.format || 'pdf').toLowerCase();
  const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
    [req.params.id, req.user.imf_id])).rows[0];
  if (!cl) return res.status(404).json({ error: 'Client introuvable' });
  const acc = (await q('SELECT * FROM account WHERE client_id=$1', [cl.id])).rows[0];
  const ops = (await q(
    `SELECT created_at, kind, amount_cents, status, direction, impacts_agent_cash
       FROM operation WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [acc ? acc.id : null])).rows;

  if (fmt === 'csv') {
    const lines = ['date;type;montant_xof;statut'];
    for (const o of ops) lines.push(`${o.created_at.toISOString()};${o.kind};${(o.amount_cents / 100).toFixed(2)};${o.status}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="releve_${cl.code_client}.csv"`);
    return res.send(lines.join('\n'));
  }
  // PDF : renvoyé en HTML prêt à imprimer (le client imprime en PDF).
  const rowsHtml = ops.map(o => `<tr><td>${o.created_at.toISOString().slice(0, 10)}</td><td>${o.kind}</td>
    <td style="text-align:right">${(o.amount_cents / 100).toLocaleString('fr-FR')} ${acc.currency}</td><td>${o.status}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
    <title>Relevé ${cl.code_client}</title><style>body{font-family:system-ui,Arial;color:#0b0c26;padding:32px}
    table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #e6e6ef;padding:8px;font-size:14px}
    h1{font-size:20px}.m{color:#6b7280}</style></head><body>
    <h1>Relevé de compte — ${cl.full_name}</h1>
    <div class="m">Client ${cl.code_client} · Compte ${acc ? acc.code_account : 'n/a'}</div>
    <div class="m">Solde : <strong>${acc ? (acc.balance_cents / 100).toLocaleString('fr-FR') : 0} ${acc ? acc.currency : 'XOF'}</strong></div>
    <table><thead><tr><th>Date</th><th>Type</th><th>Montant</th><th>Statut</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan=4>Aucune opération</td></tr>'}</tbody></table>
    <p class="m">Édité par teebo le ${new Date().toLocaleDateString('fr-FR')}</p></body></html>`);
});

/**
 * Historique des DERNIÈRES OPÉRATIONS d’un client (par défaut les 5 dernières).
 * Sert à la fois au terrain (la collectrice montre au client la trace du dépôt)
 * et à l’espace client. Les reçus récents sont joints pour référence.
 */
r.get('/clients/:id/operations', requireRole('admin_imf','direction','department','service','agency','staff','caissier'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 50);
  const cl = (await q('SELECT id, full_name, code_client, phone FROM client WHERE id=$1 AND imf_id=$2',
    [req.params.id, req.user.imf_id])).rows[0];
  if (!cl) return res.status(404).json({ error: 'Client introuvable' });
  const acc = (await q('SELECT id, code_account, balance_cents, currency FROM account WHERE client_id=$1', [cl.id])).rows[0];
  const ops = (await q(
    `SELECT o.id, o.created_at, o.kind, o.amount_cents, o.status, o.reference, o.note,
            o.receipt_id, r.code_receipt
       FROM operation o LEFT JOIN receipt r ON r.id = o.receipt_id
      WHERE o.account_id = $1
      ORDER BY o.created_at DESC LIMIT $2`,
    [acc ? acc.id : null, limit])).rows;
  res.json({
    client: { id: cl.id, full_name: cl.full_name, code_client: cl.code_client },
    account: acc ? { code_account: acc.code_account, balance_cents: acc.balance_cents, currency: acc.currency } : null,
    operations: ops.map((o) => ({
      id: o.id,
      date: o.created_at,
      kind: o.kind,
      label: o.kind === 'depot' ? 'Dépôt' : (o.kind === 'retrait_regul' ? 'Retrait (régularisation)' : o.kind),
      amount_cents: o.amount_cents,
      amount_fcfa: Number(o.amount_cents) / 100,
      status: o.status,
      receipt_code: o.code_receipt || null,
      reference: o.reference || null,
      note: o.note || null
    }))
  });
});

/** Liste des modes de connexion client disponibles (documentation in-app). */
r.get('/client-login-modes', (_req, res) => res.json({ modes: [
  { code: 'mot_de_passe', label: 'Mot de passe', description: 'Le client accède avec son code client + mot de passe.' },
  { code: 'sms_otp', label: 'Validation SMS', description: 'Un code à usage unique est envoyé par SMS à chaque connexion.' },
  { code: 'pin', label: 'Code PIN', description: 'Code numérique court, pratique sur téléphone simple.' }
], statement_formats: ['pdf', 'csv', 'les_deux'] }));

export default r;
