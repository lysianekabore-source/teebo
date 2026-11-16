// =========================================================================
// teebo — CONSOLE ADMINISTRATEUR : restrictions d'accès (vague 36)
// =========================================================================
//  GET  /admin/institutions                              liste des IMF
//  GET  /admin/institutions/:id/access-state             état module par module
//  POST /admin/institutions/:id/restrict-to-collecte     tout sauf la collecte
//  POST /admin/institutions/:id/lift-restriction         rétablir l'accès
//
// TOUT est réservé au rôle teebo_admin (administration de la plateforme).
// L'identifiant accepté est soit l'UUID interne, soit le code court (IMF-0038).
// =========================================================================
import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { q } from '../db.js';
import {
  restreindreCollecteSeule, leverRestriction, lireEtatModules,
  estRestreinteCollecteSeule, estUuid
} from '../saas_restriction.js';
import { buildInstitutionConfig, MODULES } from '../modules.js';

const r = Router();
const gardien = [authenticate, requireRole('teebo_admin')];

/** Traduit un code court (IMF-0038, imf001…) en UUID ; null si introuvable. */
async function resoudreImf(brut) {
  const v = String(brut || '').trim();
  if (!v) return null;
  if (estUuid(v)) return v;
  const { rows } = await q(
    'SELECT id FROM imf WHERE lower(code_imf) = lower($1) LIMIT 1', [v]);
  return rows.length ? rows[0].id : null;
}

/** Message d'erreur métier, jamais une trace technique. */
function echec(res, e) {
  if (e && e.expose) {
    return res.status(e.status || 400).json({ error: e.code, message: e.message });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  LISTE DES IMF (écran de la console)                                */
/* ------------------------------------------------------------------ */
r.get('/admin/institutions', ...gardien, async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT i.id, i.code_imf, i.name, i.type, i.city, i.country_code,
              i.status::text AS status, i.trial_ends_at,
              COALESCE((SELECT COUNT(*)::int FROM app_user u WHERE u.imf_id = i.id), 0) AS utilisateurs,
              EXISTS (SELECT 1 FROM imf_access_restrictions x
                       WHERE x.institution_id = i.id AND x.is_active = TRUE) AS restreinte
         FROM imf i
        ORDER BY i.name`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      total: rows.length,
      institutions: rows.map((x) => ({
        id: x.id, code_imf: x.code_imf, name: x.name, type: x.type,
        ville: x.city, pays: x.country_code, statut: x.status,
        fin_essai: x.trial_ends_at ? String(x.trial_ends_at).slice(0, 10) : null,
        utilisateurs: x.utilisateurs,
        restreinte_collecte_seule: x.restreinte === true
      }))
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  ETAT D'ACCES D'UNE IMF (lecture)                                   */
/* ------------------------------------------------------------------ */
r.get('/admin/institutions/:id/access-state', ...gardien, async (req, res, next) => {
  try {
    const id = await resoudreImf(req.params.id);
    if (!id) {
      return res.status(404).json({ error: 'imf_introuvable',
        message: 'Aucune institution ne porte ce code ou cet identifiant.' });
    }
    const [etat, restreinte, cfg] = await Promise.all([
      lireEtatModules(id), estRestreinteCollecteSeule(id), buildInstitutionConfig(id)]);

    // Deux vues du même état : la fiche lisible (label/active) pour l'écran,
    // et le détail technique (module_key/actif/essai/fin).
    const modules = {};
    for (const key of Object.keys(MODULES)) {
      const ligne = etat.find((x) => x.module_key === key);
      modules[key] = {
        label: MODULES[key].label,
        active: ligne ? ligne.utilisable === true : false,
        desactive_raison: ligne ? ligne.motif_coupure : 'non souscrit',
        fin_essai: ligne ? ligne.fin_essai : null
      };
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      institution_id: id,
      restreinte_collecte_seule: restreinte,
      modules,
      detail: etat,
      menus: cfg.menus,
      features: cfg.features
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  RESTREINDRE : collecte seule                                       */
/* ------------------------------------------------------------------ */
r.post('/admin/institutions/:id/restrict-to-collecte', ...gardien,
  async (req, res, next) => {
    try {
      const id = await resoudreImf(req.params.id);
      if (!id) {
        return res.status(404).json({ error: 'imf_introuvable',
          message: 'Aucune institution ne porte ce code ou cet identifiant.' });
      }
      const b = req.body || {};
      const out = await restreindreCollecteSeule(id,
        { id: req.user.id, role: req.user.role }, b.reason || b.raison || null);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...out, action: 'IMF_RESTRICTION_COLLECTE_ONLY',
        invalider_configuration: true });
    } catch (e) { if (echec(res, e)) return; next(e); }
  });

/* ------------------------------------------------------------------ */
/*  LEVER LA RESTRICTION                                               */
/* ------------------------------------------------------------------ */
r.post('/admin/institutions/:id/lift-restriction', ...gardien,
  async (req, res, next) => {
    try {
      const id = await resoudreImf(req.params.id);
      if (!id) {
        return res.status(404).json({ error: 'imf_introuvable',
          message: 'Aucune institution ne porte ce code ou cet identifiant.' });
      }
      const b = req.body || {};
      const out = await leverRestriction(id,
        { id: req.user.id, role: req.user.role }, b.reason || b.raison || null);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...out, action: 'IMF_RESTRICTION_LIFTED',
        invalider_configuration: true });
    } catch (e) { if (echec(res, e)) return; next(e); }
  });

export default r;
