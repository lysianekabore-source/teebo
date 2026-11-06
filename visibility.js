import { Router } from 'express';
import { q } from '../db.js';
import { requireRole } from '../auth.js';

const r = Router();

/**
 * Autorisations fines de visibilité inter-entités.
 * Par défaut, AUCUNE visibilité croisée : une unité ne voit que ses propres
 * données. L'admin IMF accorde explicitement chaque droit (grantor -> grantee).
 */
r.get('/visibility-grants', requireRole('admin_imf','direction','department','service'), async (req, res) => {
  const { rows } = await q(
    `SELECT v.*, gu.name AS grantor_name, ge.name AS grantee_name
       FROM visibility_grant v
       JOIN org_unit gu ON gu.id = v.grantor_unit_id
       JOIN org_unit ge ON ge.id = v.grantee_unit_id
      WHERE v.imf_id=$1 ORDER BY v.created_at DESC`, [req.user.imf_id]);
  const units = (await q('SELECT id, name, kind FROM org_unit WHERE imf_id=$1 ORDER BY kind, name',
    [req.user.imf_id])).rows;
  res.json({ grants: rows, units, default_policy: 'aucune visibilité croisée' });
});

/** Accorde un droit de lecture inter-entités. */
r.post('/visibility-grants', requireRole('admin_imf'), async (req, res) => {
  const { grantor_unit_id, grantee_unit_id, scope } = req.body || {};
  if (!grantor_unit_id || !grantee_unit_id)
    return res.status(400).json({ error: 'Unité source et unité destinataire requises' });
  if (grantor_unit_id === grantee_unit_id)
    return res.status(400).json({ error: 'Les deux unités doivent être différentes' });
  const sc = ['read_operations', 'read_balances'].includes(scope) ? scope : 'read_operations';
  // Vérifie que les unités appartiennent bien à l'IMF.
  const owns = (await q('SELECT COUNT(*)::int AS n FROM org_unit WHERE imf_id=$1 AND id = ANY($2::uuid[])',
    [req.user.imf_id, [grantor_unit_id, grantee_unit_id]])).rows[0].n;
  if (owns !== 2) return res.status(400).json({ error: 'Unité hors de votre institution' });
  const { rows } = await q(
    `INSERT INTO visibility_grant(imf_id,grantor_unit_id,grantee_unit_id,scope,granted_by,active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (grantor_unit_id, grantee_unit_id, scope)
     DO UPDATE SET active=true, granted_by=EXCLUDED.granted_by RETURNING *`,
    [req.user.imf_id, grantor_unit_id, grantee_unit_id, sc, req.user.id]);
  res.status(201).json({ grant: rows[0] });
});

/** Révoque un droit (retour à l'état par défaut : pas de visibilité). */
r.delete('/visibility-grants/:id', requireRole('admin_imf'), async (req, res) => {
  const { rows } = await q(
    `UPDATE visibility_grant SET active=false WHERE id=$1 AND imf_id=$2 RETURNING *`,
    [req.params.id, req.user.imf_id]);
  if (!rows.length) return res.status(404).json({ error: 'Autorisation introuvable' });
  res.json({ grant: rows[0] });
});

/** Vérifie si une unité peut lire une autre unité (utilisé par les rapports). */
r.get('/visibility-check', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { grantor, grantee, scope } = req.query;
  const { rows } = await q(
    `SELECT 1 FROM visibility_grant
      WHERE imf_id=$1 AND grantor_unit_id=$2 AND grantee_unit_id=$3 AND scope=$4 AND active=true`,
    [req.user.imf_id, grantor, grantee, scope || 'read_operations']);
  res.json({ allowed: rows.length > 0 });
});

export default r;
