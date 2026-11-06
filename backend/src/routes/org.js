import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail } from '../notify.js';
import { msgUserAccessCode, msgUserResendCode } from '../messages.js';

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
      return r;
    });
    // Envoi du code d'accès par e-mail et WhatsApp
    const msg = msgUserAccessCode({ code: out.code_user, fullName: full_name });
    if (phone) await notifyWhatsApp(phone, msg);
    await notifyEmail(email, 'Votre accès teebo', msg);
    res.json({ ok: true, code_user: out.code_user });
  } catch (e) { next(e); }
});

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

// --- Renvoyer le code d'accès d'un utilisateur (sans le régénérer) ----------
// L'admin IMF peut renvoyer à l'un de SES utilisateurs son code d'accès par
// WhatsApp et/ou e-mail. Cloisonnement : uniquement les users de la même IMF.
router.post('/users/:id/resend-code', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const u = (await q(
      'SELECT id, imf_id, code_user, full_name, email, phone FROM app_user WHERE id=$1',
      [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    if (!u.code_user) return res.status(409).json({ error: 'no_code' });
    const msg = msgUserResendCode({ code: u.code_user, fullName: u.full_name });
    if (u.phone) await notifyWhatsApp(u.phone, msg);
    await notifyEmail(u.email, 'Rappel : votre code d\'accès teebo', msg);
    res.json({ ok: true, code_user: u.code_user, sent_to: u.email });
  } catch (e) { next(e); }
});

// --- Régénérer le code d'accès d'un utilisateur ------------------------------
// Nouveau code + réinitialisation du mot de passe (création après 1re connexion).
router.post('/users/:id/regenerate-code', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const u = (await c.query(
        'SELECT id, imf_id, full_name, email, phone FROM app_user WHERE id=$1 FOR UPDATE',
        [req.params.id])).rows[0];
      if (!u) { const e = new Error('not_found'); e.status = 404; throw e; }
      if (u.imf_id !== req.user.imf_id) { const e = new Error('forbidden'); e.status = 403; throw e; }
      const code = (await c.query('SELECT fn_gen_user_code($1) AS c', [u.imf_id])).rows[0].c;
      await c.query(
        'UPDATE app_user SET code_user=$1, password_hash=NULL, must_change_password=true WHERE id=$2',
        [code, u.id]);
      return { code, fullName: u.full_name, email: u.email, phone: u.phone };
    });
    const msg = msgUserResendCode({ code: out.code, fullName: out.fullName });
    if (out.phone) await notifyWhatsApp(out.phone, msg);
    await notifyEmail(out.email, 'Votre nouveau code d\'accès teebo', msg);
    res.json({ ok: true, code_user: out.code, sent_to: out.email });
  } catch (e) { next(e); }
});

export default router;
