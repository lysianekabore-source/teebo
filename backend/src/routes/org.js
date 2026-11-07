import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, waLink, mailtoLink, PUBLIC_SITE_URL } from '../notify.js';
import { getBranding } from '../documents.js';
import { defaultPermissionKeysForRole, buildProfilesMatrix } from '../permissions.js';

const router = express.Router();
router.use(authenticate, requireFreshPassword);

// Les routes métier IMF ne sont accessibles qu'aux rôles rattachés à une IMF.
// teebo_admin n'a pas de hiérarchie IMF : il est redirigé vers sa propre console.
router.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

// ---------------------------------------------------------------------------
// CLOISONNEMENT : toute requête est filtrée par imf_id de l'utilisateur.
// Aucune donnée d'une autre IMF n'est accessible, sauf teebo_admin.
// ---------------------------------------------------------------------------
const KIND_ORDER = { direction: 1, department: 2, service: 3, agency: 4 };

// --- Arborescence des unités ------------------------------------------------
router.get('/units', async (req, res, next) => {
  try {
    const { rows } = await q(
      'SELECT * FROM org_unit WHERE imf_id=$1 ORDER BY kind, name', [req.user.imf_id]);
    res.json({ units: rows });
  } catch (e) { next(e); }
});

router.post('/units', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { kind, name, city, parent_id } = req.body || {};
    if (!KIND_ORDER[kind]) return res.status(422).json({ error: 'invalid_kind' });
    if (!name) return res.status(422).json({ error: 'missing_name' });
    const out = await tx(async (c) => {
      // Contrainte hiérarchique : department > direction, etc.
      if (parent_id) {
        const p = (await c.query('SELECT kind, imf_id FROM org_unit WHERE id=$1', [parent_id])).rows[0];
        if (!p || p.imf_id !== req.user.imf_id) { const e=new Error('bad_parent'); e.status=403; throw e; }
        if (KIND_ORDER[kind] !== KIND_ORDER[p.kind] + 1) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
      }
      const code = (await c.query('SELECT fn_gen_unit_code($1,$2) AS c', [req.user.imf_id, kind])).rows[0].c;
      const r = (await c.query(
        `INSERT INTO org_unit(imf_id,parent_id,kind,code_unit,name,city)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.user.imf_id, parent_id || null, kind, code, name, city || null])).rows[0];
      return r;
    });
    res.json({ ok: true, unit: out });
  } catch (e) { next(e); }
});

// --- Suppression d'une unité (cascade sur les sous-unités) ------------------
router.delete('/units/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { rows } = await q('SELECT id, imf_id FROM org_unit WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    // Cloisonnement : on ne supprime que dans sa propre IMF.
    if (rows[0].imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    await q('DELETE FROM org_unit WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Personnel (utilisateurs rattachés à une unité) ------------------------
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT u.id,u.code_user,u.full_name,u.email,u.phone,u.role,u.position,
              u.org_unit_id,u.must_change_password,u.is_active,o.name AS unit_name
         FROM app_user u LEFT JOIN org_unit o ON o.id=u.org_unit_id
        WHERE u.imf_id=$1 AND u.role <> 'teebo_admin' ORDER BY u.created_at`,
      [req.user.imf_id]);
    res.json({ users: rows });
  } catch (e) { next(e); }
});

router.post('/users', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { full_name, position, email, phone, role, org_unit_id } = req.body || {};
    if (!full_name || !email || !role) return res.status(422).json({ error: 'missing_fields' });
    if (role === 'teebo_admin') return res.status(422).json({ error: 'invalid_role' });
    const out = await tx(async (c) => {
      if (org_unit_id) {
        const u = (await c.query('SELECT imf_id FROM org_unit WHERE id=$1', [org_unit_id])).rows[0];
        if (!u || u.imf_id !== req.user.imf_id) { const e=new Error('bad_unit'); e.status=403; throw e; }
      }
      const code = (await c.query('SELECT fn_gen_user_code($1) AS c', [req.user.imf_id])).rows[0].c;
      const r = (await c.query(
        `INSERT INTO app_user(imf_id,org_unit_id,code_user,full_name,position,email,phone,role,
             password_hash,must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,true) RETURNING id, code_user`,
        [req.user.imf_id, org_unit_id || null, code, full_name, position || null, email, phone || null, role]
      )).rows[0];
      // Habilitations par défaut attachées au profil (matrice profils → droits).
      const perms = defaultPermissionKeysForRole(role);
      for (const key of perms) {
        await c.query(
          `INSERT INTO user_permission(imf_id, user_id, permission_key, allowed, source)
           VALUES ($1,$2,$3,true,'default')
           ON CONFLICT (user_id, permission_key) DO NOTHING`,
          [req.user.imf_id, r.id, key]);
      }
      return r;
    });
    // Diffusion du code d'accès à l'utilisateur, via les canaux de l'IMF.
    const send = await buildAccessCodeSend(req.user.imf_id, {
      id: out.id, full_name, email, phone, code_user: out.code_user
    }, { channel: 'creation', dispatchedBy: req.user.id });
    res.json({ ok: true, code_user: out.code_user, send });
  } catch (e) { next(e); }
});

// --- Renvoyer le code d'accès à un utilisateur existant ---------------------
router.post('/users/:id/resend-code', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const u = (await q(
      `SELECT id, imf_id, full_name, email, phone, code_user
         FROM app_user WHERE id=$1`, [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    const send = await buildAccessCodeSend(req.user.imf_id, {
      id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, code_user: u.code_user
    }, { channel: 'resend', dispatchedBy: req.user.id });
    res.json({ ok: true, code_user: u.code_user, send });
  } catch (e) { next(e); }
});

/**
 * Construit le message du code d'accès et les liens d'envoi « prêts à cliquer ».
 * ---------------------------------------------------------------------------
 * - Signe le message avec les coordonnées expéditrices de l'IMF (numéro
 *   WhatsApp + e-mail paramétrés dans « Paramètres IMF », avec repli sur la
 *   fiche imf).
 * - Tente l'envoi automatique (WhatsApp Cloud API / SMTP si configurés).
 * - Renvoie TOUJOURS des liens wa.me / mailto (pré-remplis) pour permettre un
 *   envoi manuel immédiat depuis le compte de l'administrateur, même sans
 *   passerelle configurée.
 */
async function buildAccessCodeSend(imfId, user, ctx = {}) {
  const br = await getBranding(imfId);
  const imfName = br.legal_name || (br.imf && br.imf.name) || 'votre institution';
  const senderWa = br.notify_whatsapp || '';
  const senderEmail = br.notify_email || '';
  const greeting = user.full_name ? `Bonjour ${user.full_name},` : 'Bonjour,';
  const subject = `Votre accès ${imfName} — code ${user.code_user}`;
  const lines = [
    greeting,
    '',
    `Votre accès à l'application ${imfName} (via teebo) est créé.`,
    `Code d'accès : ${user.code_user}`,
    `Connexion : https://teebo-imf.netlify.app/login`,
    `Dès votre première connexion, créez immédiatement votre mot de passe.`,
    '',
    `-- ${imfName}`,
    senderWa ? `WhatsApp : ${senderWa}` : null,
    senderEmail ? `E-mail : ${senderEmail}` : null
  ].filter((l) => l !== null);
  const message = lines.join('\n');

  // Envoi automatique best-effort (ne bloque jamais la création).
  let wa_auto = null, mail_auto = null;
  try { if (user.phone) wa_auto = await notifyWhatsApp(user.phone, message); } catch (e) { wa_auto = { ok: false, error: e.message }; }
  try { mail_auto = await notifyEmail(user.email, subject, message); } catch (e) { mail_auto = { ok: false, error: e.message }; }

  const whatsappMode = wa_auto ? (wa_auto.mode || (wa_auto.ok ? 'sent' : 'failed')) : 'skipped';
  const emailMode = mail_auto ? (mail_auto.mode || (mail_auto.ok ? 'sent' : 'failed')) : 'skipped';

  // Journalisation de l'envoi (best-effort : ne bloque jamais la diffusion).
  try {
    await q(
      `INSERT INTO code_dispatch_log(imf_id, user_id, recipient_name, code_user,
           to_phone, to_email, channel, whatsapp_mode, email_mode, dispatched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [imfId, user.id || null, user.full_name || null, user.code_user || null,
       user.phone || null, user.email || null, ctx.channel || 'creation',
       whatsappMode, emailMode, ctx.dispatchedBy || null]);
  } catch (e) { /* le journal est secondaire : on n'interrompt pas l'envoi */ }

  return {
    message,
    subject,
    imf_name: imfName,
    sender_whatsapp: senderWa || null,
    sender_email: senderEmail || null,
    // Liens prêts à cliquer vers le DESTINATAIRE (l'utilisateur).
    wa_link: user.phone ? waLink(user.phone, message) : null,
    mailto_link: user.email ? mailtoLink(user.email, subject, message) : null,
    to_phone: user.phone || null,
    to_email: user.email || null,
    // Mode d'envoi réel (dev = journalisé + lien manuel ; prod = passerelle).
    whatsapp_mode: whatsappMode,
    email_mode: emailMode
  };
}

// --- Rattachement hiérarchique (module Objectifs) ---------------------------
// Définit le responsable direct (parent_id) d'un agent : une collectrice
// dépend d'un superviseur, un superviseur d'un DG. Anti-cycle garanti.
router.patch('/users/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { parent_id, position, full_name, phone } = req.body || {};
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    // Cloisonnement : on ne modifie que dans sa propre IMF.
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });

    if (parent_id !== undefined && parent_id !== null) {
      if (parent_id === req.params.id) return res.status(422).json({ error: 'self_parent' });
      const p = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [parent_id])).rows[0];
      if (!p || p.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'bad_parent' });
      // Anti-cycle : le parent ne doit pas se trouver dans la descendance de u.
      const cyc = (await q(`
        WITH RECURSIVE sub AS (
            SELECT id FROM app_user WHERE parent_id=$1
            UNION ALL
            SELECT a.id FROM app_user a JOIN sub s ON a.parent_id=s.id
        ) SELECT 1 FROM sub WHERE id=$2 LIMIT 1`, [req.params.id, parent_id])).rows.length;
      if (cyc) return res.status(422).json({ error: 'cycle_detected' });
    }

    const out = await tx(async (c) => {
      const r = (await c.query(
        `UPDATE app_user
            SET parent_id = CASE WHEN $1::boolean THEN $2::uuid ELSE parent_id END,
                position  = COALESCE($3, position),
                full_name = COALESCE($4, full_name),
                phone     = COALESCE($5, phone)
          WHERE id=$6 AND imf_id=$7
          RETURNING id, code_user, full_name, role, parent_id, position, phone`,
        [parent_id !== undefined, parent_id ?? null, position ?? null, full_name ?? null, phone ?? null,
         req.params.id, req.user.imf_id])).rows[0];
      return r;
    });
    res.json({ ok: true, user: out });
  } catch (e) { next(e); }
});

// --- Suppression d'un utilisateur ------------------------------------------
router.delete('/users/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    await q('DELETE FROM app_user WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Suivi des envois de codes d'accès --------------------------------------
// Tableau de bord : journal + statistiques des codes envoyés au personnel.
router.get('/code-dispatches', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT d.id, d.recipient_name, d.code_user, d.to_phone, d.to_email,
              d.channel, d.whatsapp_mode, d.email_mode, d.created_at,
              a.full_name AS dispatched_by_name
         FROM code_dispatch_log d
         LEFT JOIN app_user a ON a.id = d.dispatched_by
        WHERE d.imf_id=$1
        ORDER BY d.created_at DESC
        LIMIT 200`, [req.user.imf_id]);
    const sent = (m) => m === 'sent';
    const stats = {
      total: rows.length,
      creation: rows.filter((r) => r.channel === 'creation').length,
      resend: rows.filter((r) => r.channel === 'resend').length,
      whatsapp_sent: rows.filter((r) => sent(r.whatsapp_mode)).length,
      email_sent: rows.filter((r) => sent(r.email_mode)).length
    };
    res.json({ dispatches: rows, stats });
  } catch (e) { next(e); }
});

// --- Matrice des profils & habilitations par défaut (référentiel) ------------
// Consultable par l'administrateur IMF et la direction. (La console teebo
// expose la même matrice via /api/v1/teebo/profiles-matrix.)
router.get('/profiles-matrix', requireRole('admin_imf', 'direction'), (req, res) => {
  res.json(buildProfilesMatrix());
});

export default router;
