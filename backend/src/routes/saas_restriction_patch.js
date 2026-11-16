// =========================================================================
// teebo — RESTRICTION IMM\u00c9DIATE \u00c0 LA COLLECTE (vague 36)
// =========================================================================
//  POST /api/v1/admin/institutions/:id/restrict-to-collecte   (teebo_admin)
//  POST /api/v1/institution/:id/restrict-to-collecte          (admin IMF)
//  POST /api/v1/admin/institutions/:id/lift-restriction        (teebo_admin)
//  GET  /api/v1/admin/institutions/:id/access-state            (teebo_admin)
//
// Une seule logique pour les deux portes d'entr\u00e9e. La lecture qui suit
// l'\u00e9criture se fait HORS transaction (connexion du pool), pour que le
// compte rendu refl\u00e8te exactement ce que verront les IMF.
// =========================================================================
import { Router } from 'express';
import { requireRole } from '../auth.js';
import {
  MODULE_COLLECTE, estUuid, restreindreCollecteSeule, leverRestriction
} from '../saas_restriction.js';
import { verifierModule, buildInstitutionConfig } from '../modules.js';

const r = Router();
const ADMIN = ['admin_imf', 'direction'];

/** Erreur m\u00e9tier -> r\u00e9ponse JSON lisible (jamais de d\u00e9tail technique). */
function echec(e, res, next) {
  if (e && e.expose) {
    return res.status(e.status || 400).json({ error: e.code || 'refus', message: e.message });
  }
  return next(e);
}

async function restreindre(req, res, next) {
  try {
    const imfId = req.params.id;
    if (!estUuid(imfId)) {
      return res.status(400).json({ error: 'imf_id_invalide',
        message: 'Identifiant d\u2019institution invalide.' });
    }
    const b = req.body || {};
    const out = await restreindreCollecteSeule(imfId,
      { id: (req.user && req.user.id) || null, role: (req.user && req.user.role) || null },
      b.reason || b.raison || null);

    // V\u00e9rification \u00e0 froid : le middleware refuserait-il vraiment le cr\u00e9dit ?
    const credit = await verifierModule(imfId, 'MODULE_DOSSIER_CREDIT');
    res.json({
      ok: true,
      action: 'IMF_RESTRICTION_COLLECTE_ONLY',
      ...out,
      controle_middleware: {
        module_test: 'MODULE_DOSSIER_CREDIT',
        refuserait: credit.utilisable === false,
        motif: credit.motif || null
      },
      invalider_configuration: true
    });
  } catch (e) { echec(e, res, next); }
}

async function lever(req, res, next) {
  try {
    const imfId = req.params.id;
    if (!estUuid(imfId)) {
      return res.status(400).json({ error: 'imf_id_invalide',
        message: 'Identifiant d\u2019institution invalide.' });
    }
    const b = req.body || {};
    const out = await leverRestriction(imfId,
      { id: (req.user && req.user.id) || null, role: (req.user && req.user.role) || null },
      b.reason || b.raison || null);
    res.json({ ok: true, action: 'IMF_RESTRICTION_LIFTED', ...out,
      invalider_configuration: true });
  } catch (e) { echec(e, res, next); }
}

r.post('/admin/institutions/:id/restrict-to-collecte', requireRole('teebo_admin'), restreindre);
r.post('/institution/:id/restrict-to-collecte', requireRole('teebo_admin', ...ADMIN), restreindre);
r.post('/admin/institutions/:id/lift-restriction', requireRole('teebo_admin'), lever);

/** \u00c9tat d'acc\u00e8s : ce que la console affiche avant d'agir. */
r.get('/admin/institutions/:id/access-state', requireRole('teebo_admin'), async (req, res, next) => {
  try {
    const imfId = req.params.id;
    if (!estUuid(imfId)) {
      return res.status(400).json({ error: 'imf_id_invalide',
        message: 'Identifiant d\u2019institution invalide.' });
    }
    const config = await buildInstitutionConfig(imfId);
    const credit = await verifierModule(imfId, 'MODULE_DOSSIER_CREDIT');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      institution_id: imfId,
      institution: config.institution,
      restreinte_collecte_seule: !credit.utilisable || config.menus.length <= 1,
      modules: config.modules,
      menus: config.menus
    });
  } catch (e) { echec(e, res, next); }
});

export default r;
