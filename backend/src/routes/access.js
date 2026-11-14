import express from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';

/* ===========================================================================
 * teebo — GESTION DES HABILITATIONS ÉDITABLES (schema_v13)
 * ---------------------------------------------------------------------------
 *  - Habilitations par défaut par poste/profil, cochables/décochables par
 *    l'administrateur IMF (surcharge par imf_id).
 *  - Création de postes/profils CUSTOM + affectation d'habilitations.
 *  - Création d'habilitations supplémentaires (custom par IMF).
 *  - Réglage fin des habilitations d'un utilisateur.
 *  Cloisonnement strict : chaque IMF ne voit que le socle GLOBAL + ses propres
 *  éléments custom, et ne modifie que dans son périmètre.
 * ========================================================================= */
const router = express.Router();
router.use(authenticate, requireFreshPassword);
router.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

const ADMIN = requireRole('admin_imf', 'direction');
const VALID_KEY = /^[a-z0-9]+(?:[._][a-z0-9]+)+$/; // ex. 'module.action'

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// --- Catalogue complet : habilitations + postes + habilitations par poste ----
router.get('/access/catalog', habilit('access.manage','users.read','users.manage'), ADMIN, async (req, res, next) => {
  try {
    const imf = req.user.imf_id;
    const perms = (await q(
      `SELECT permission_key, label, category, access_kind, is_system, (imf_id IS NOT NULL) AS custom
         FROM permission_catalog
        WHERE imf_id IS NULL OR imf_id=$1
        ORDER BY sort_order, label`, [imf])).rows;
    const positions = (await q(
      `SELECT code, label, dept_code, service_code, role_key, hierarchy_level,
              validation_level, is_manager, can_supervise_collectors, needs_supervisor,
              (imf_id IS NOT NULL) AS custom
         FROM position_catalog
        WHERE imf_id IS NULL OR imf_id=$1
        ORDER BY is_custom, dept_code, sort_order, label`, [imf])).rows;
    // Habilitations par défaut effectives (surcharge IMF prioritaire).
    const eff = (await q(
      `SELECT DISTINCT ON (position_code, permission_key)
              position_code, permission_key, allowed
         FROM position_default_permission
        WHERE imf_id=$1 OR imf_id IS NULL
        ORDER BY position_code, permission_key, (imf_id IS NOT NULL) DESC`, [imf])).rows;
    const byPos = {};
    for (const row of eff) {
      (byPos[row.position_code] || (byPos[row.position_code] = {}))[row.permission_key] = row.allowed;
    }
    res.json({ permissions: perms, positions, position_permissions: byPos,
      final_validator_key: 'credit.validate_final' });
  } catch (e) { next(e); }
});

// --- Créer une habilitation supplémentaire (custom IMF) ----------------------
router.post('/access/permissions', habilit('access.manage'), ADMIN, async (req, res, next) => {
  try {
    const b = req.body || {};
    const label = String(b.label || '').trim();
    if (!label) return res.status(422).json({ error: 'missing_label' });
    let key = String(b.permission_key || '').trim().toLowerCase();
    if (!key) key = 'custom.' + slugify(label);
    if (!VALID_KEY.test(key)) return res.status(422).json({ error: 'invalid_key',
      message: 'La clé doit être de la forme module.action (lettres minuscules, points).' });
    const category = String(b.category || 'Habilitations supplémentaires').trim();
    const KINDS = ['lecture', 'ecriture', 'validation'];
    const accessKind = KINDS.indexOf(String(b.access_kind || '').trim()) >= 0 ? String(b.access_kind).trim() : 'ecriture';
    try {
      const row = (await q(
        `INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, created_by)
         VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING permission_key, label, category, access_kind`,
        [req.user.imf_id, key, label, category, accessKind, req.user.id])).rows[0];
      res.status(201).json({ ok: true, permission: row });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'duplicate_permission' });
      throw e;
    }
  } catch (e) { next(e); }
});

// --- Supprimer une habilitation custom (jamais le socle) ---------------------
router.delete('/access/permissions/:key', habilit('access.manage'), ADMIN, async (req, res, next) => {
  try {
    const key = req.params.key;
    const row = (await q(
      `SELECT id, is_system FROM permission_catalog WHERE permission_key=$1 AND imf_id=$2`,
      [key, req.user.imf_id])).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.is_system) return res.status(422).json({ error: 'system_permission' });
    await tx(async (c) => {
      await c.query('DELETE FROM position_default_permission WHERE permission_key=$1 AND (imf_id=$2 OR imf_id IS NULL)', [key, req.user.imf_id]);
      await c.query('DELETE FROM user_permission WHERE permission_key=$1 AND imf_id=$2', [key, req.user.imf_id]);
      await c.query('DELETE FROM permission_catalog WHERE id=$1', [row.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Créer un poste/profil CUSTOM + affecter ses habilitations par défaut ----
router.post('/access/positions', habilit('access.manage'), ADMIN, async (req, res, next) => {
  try {
    const b = req.body || {};
    const label = String(b.label || '').trim();
    if (!label) return res.status(422).json({ error: 'missing_label' });
    const dept = String(b.dept_code || '').trim();
    const roleKey = String(b.role_key || 'office_staff').trim();
    if (!dept) return res.status(422).json({ error: 'missing_dept' });
    // Le département doit exister (socle org).
    const d = (await q('SELECT 1 FROM department_catalog WHERE code=$1', [dept])).rows[0];
    if (!d) return res.status(422).json({ error: 'invalid_dept' });
    const rk = (await q('SELECT 1 FROM role_catalog WHERE role_key=$1', [roleKey])).rows[0];
    if (!rk) return res.status(422).json({ error: 'invalid_role_key' });
    const service = b.service_code ? String(b.service_code).trim() : null;
    const code = 'CUSTOM_' + slugify(req.user.imf_id).slice(0, 6).toUpperCase() + '_' +
      slugify(label).toUpperCase() + '_' + Math.floor(1000 + Math.random() * 9000);
    const keys = Array.isArray(b.permission_keys) ? b.permission_keys.filter((k) => typeof k === 'string') : [];
    const out = await tx(async (c) => {
      const pos = (await c.query(
        `INSERT INTO position_catalog
           (code,label,dept_code,service_code,role_key,hierarchy_level,validation_level,
            is_manager,can_supervise_collectors,needs_supervisor,sort_order,imf_id,created_by,is_custom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING code,label`,
        [code, label, dept, service, roleKey,
         Number(b.hierarchy_level) || 0, Number(b.validation_level) || 0,
         !!b.is_manager, !!b.can_supervise_collectors, !!b.needs_supervisor,
         Number(b.sort_order) || 500, req.user.imf_id, req.user.id])).rows[0];
      // Habilitations par défaut du nouveau poste (surcharge IMF).
      for (const key of keys) {
        const ok = (await c.query(
          'SELECT 1 FROM permission_catalog WHERE permission_key=$1 AND (imf_id IS NULL OR imf_id=$2)',
          [key, req.user.imf_id])).rows[0];
        if (!ok) continue;
        await c.query(
          `INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed,updated_by)
           VALUES ($1,$2,$3,true,$4)
           ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key)
           DO UPDATE SET allowed=true, updated_by=$4, updated_at=now()`,
          [req.user.imf_id, code, key, req.user.id]);
      }
      return pos;
    });
    res.status(201).json({ ok: true, position: out });
  } catch (e) { next(e); }
});

// --- Cocher / décocher une habilitation par défaut d'un poste ----------------
// Surcharge au niveau de l'IMF (le socle global reste intact). C'est aussi
// le mécanisme de RÉAFFECTATION de l'écran de validation finale du crédit
// (permission 'credit.validate_final') à d'autres postes.
router.patch('/access/positions/:code/permission', habilit('access.manage'), ADMIN, async (req, res, next) => {
  try {
    const code = req.params.code;
    const key = String((req.body || {}).permission_key || '').trim();
    const allowed = !!(req.body || {}).allowed;
    if (!key) return res.status(422).json({ error: 'missing_permission' });
    const pos = (await q(
      'SELECT 1 FROM position_catalog WHERE code=$1 AND (imf_id IS NULL OR imf_id=$2)',
      [code, req.user.imf_id])).rows[0];
    if (!pos) return res.status(404).json({ error: 'position_not_found' });
    const perm = (await q(
      'SELECT 1 FROM permission_catalog WHERE permission_key=$1 AND (imf_id IS NULL OR imf_id=$2)',
      [key, req.user.imf_id])).rows[0];
    if (!perm) return res.status(404).json({ error: 'permission_not_found' });
    await q(
      `INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed,updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key)
       DO UPDATE SET allowed=$4, updated_by=$5, updated_at=now()`,
      [req.user.imf_id, code, key, allowed, req.user.id]);
    res.json({ ok: true, position_code: code, permission_key: key, allowed });
  } catch (e) { next(e); }
});

// --- Habilitations effectives d'un utilisateur -------------------------------
router.get('/access/users/:id/permissions', habilit('access.manage','users.read','users.manage'), ADMIN, async (req, res, next) => {
  try {
    const u = (await q('SELECT id, imf_id, position_code, role FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    const granted = (await q(
      'SELECT permission_key, allowed, source FROM user_permission WHERE user_id=$1 AND imf_id=$2',
      [u.id, req.user.imf_id])).rows;
    const map = {};
    for (const g of granted) map[g.permission_key] = { allowed: g.allowed, source: g.source };
    res.json({ user_id: u.id, position_code: u.position_code, role: u.role, permissions: map });
  } catch (e) { next(e); }
});

// --- Cocher / décocher une habilitation d'un utilisateur ---------------------
router.patch('/access/users/:id/permission', habilit('access.manage'), ADMIN, async (req, res, next) => {
  try {
    const key = String((req.body || {}).permission_key || '').trim();
    const allowed = !!(req.body || {}).allowed;
    if (!key) return res.status(422).json({ error: 'missing_permission' });
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    const perm = (await q(
      'SELECT 1 FROM permission_catalog WHERE permission_key=$1 AND (imf_id IS NULL OR imf_id=$2)',
      [key, req.user.imf_id])).rows[0];
    if (!perm) return res.status(404).json({ error: 'permission_not_found' });
    await q(
      `INSERT INTO user_permission(imf_id, user_id, permission_key, allowed, source)
       VALUES ($1,$2,$3,$4,'custom')
       ON CONFLICT (user_id, permission_key)
       DO UPDATE SET allowed=$4, source='custom'`,
      [req.user.imf_id, u.id, key, allowed]);
    res.json({ ok: true, user_id: u.id, permission_key: key, allowed });
  } catch (e) { next(e); }
});

export default router;
