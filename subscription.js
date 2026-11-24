// =========================================================================
// teebo — CONFIGURATION D'INSTITUTION & ACTIVATION DE MODULES (vague 36)
// =========================================================================
//  GET  /institution/config            ce que l'écran a le DROIT d'afficher
//  POST /institution/modules/activate  activer / upgrader un module
//
// Deux règles:
//   1. la configuration est recalculée à CHAQUE appel, sans aucun cache :
//      Une restriction ou un upgrade se voit à l'écran immédiatement ;
//   2. un module peut TOUJOURS être activé, même quand l'IMF est restreinte
//      à la collecte (c'est ce qu'on appelle « upgrade »). Si ce module n'a
//      jamais été testé, 30 jours d'essai sont accordés automatiquement ;
//      sinon l'activation est payante (règle vague 35 : un seul essai).
// =========================================================================
import { Router } from 'express';
import { authenticate, requireRole } from '../auth.js';
import { buildInstitutionConfig, verifierModule, MODULE_KEYS, MODULES } from '../modules.js';
import { reactiverModule, estRestreinteCollecteSeule } from '../saas_restriction.js';

const r = Router();
const ADMIN = ['admin_imf', 'direction'];

/** Aucun cache : l'écran doit refléter une restriction immédiatement. */
function sansCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/* ------------------------------------------------------------------ */
/*  CONFIGURATION VISIBLE POUR L'UTILISATEUR CONNECTÉ                  */
/* ------------------------------------------------------------------ */
r.get('/institution/config', authenticate, async (req, res, next) => {
  try {
    const imfId = req.dbImfId || (req.user && req.user.imf_id);
    if (!imfId) {
      return res.status(400).json({ error: 'institution_manquante',
        message: 'Aucune institution rattachée à ce compte.' });
    }
    sansCache(res);
    const config = await buildInstitutionConfig(imfId, req.user);
    const restreinte = await estRestreinteCollecteSeule(imfId);
    res.json({
      ...config,
      restreinte_collecte_seule: restreinte,
      // Le client sait quoi proposer : il ne DOIT afficher que ces menus.
      catalogue: Object.entries(MODULES).map(([key, d]) => ({
        key, label: d.label, description: d.description,
        actif: config.features[key] === true
      })),
      revision: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  ACTIVATION / UPGRADE D'UN MODULE                                   */
/* ------------------------------------------------------------------ */
r.post('/institution/modules/activate', authenticate, requireRole(...ADMIN, 'teebo_admin'),
  async (req, res, next) => {
    try {
      const imfId = req.params.id || req.dbImfId || (req.user && req.user.imf_id);
      const b = req.body || {};
      const moduleKey = b.module_key || b.module || b.key;
      if (!moduleKey || !MODULE_KEYS.includes(moduleKey)) {
        return res.status(400).json({ error: 'module_inconnu',
          message: 'Module inconnu. Valeurs possibles : ' + MODULE_KEYS.join(', '),
          modules: MODULE_KEYS });
      }

      // Un admin d'IMF n'agit que sur SA structure ; teebo_admin sur toutes.
      if (req.user.role !== 'teebo_admin' && b.institution_id
          && b.institution_id !== imfId) {
        return res.status(403).json({ error: 'hors_perimetre',
          message: 'Vous ne pouvez activer un module que pour votre institution.' });
      }

      const out = await reactiverModule(imfId, moduleKey,
        { demander_essai: b.demander_essai !== false }, req.user);

      // La d\u00e9cision du middleware est relue APR\u00c8S l'\u00e9criture : l'\u00e9cran
      // n'a pas \u00e0 deviner si le module est d\u00e9sormais accessible.
      const verdict = await verifierModule(imfId, moduleKey);

      sansCache(res);
      res.json({
        ok: true,
        ...out,
        // Upgrade après restriction : on renvoie tout de suite la nouvelle carte
        // des droits pour que l'écran n'attende pas un rechargement.
        desormais_accessible: verdict.utilisable === true,
        motif_refus: verdict.motif || null,
        restreinte_collecte_seule: await estRestreinteCollecteSeule(imfId),
        configuration_ui: await buildInstitutionConfig(imfId, req.user),
        invalider_configuration: true
      });
    } catch (e) {
      if (e && e.expose) {
        return res.status(e.status || 400).json({ error: e.code, message: e.message });
      }
      next(e);
    }
  });

/* ------------------------------------------------------------------ */
/*  LISTE DES MODULES RÉELLEMENT UTILISABLES (raccourci pour le front) */
/* ------------------------------------------------------------------ */
r.get('/institution/modules', authenticate, async (req, res, next) => {
  try {
    const imfId = req.dbImfId || (req.user && req.user.imf_id);
    if (!imfId) return res.status(400).json({ error: 'institution_manquante' });
    sansCache(res);
    const { lireEtatModules, droitsUtilisables } = await import('../saas_restriction.js');
    res.json({
      modules: await lireEtatModules(imfId),
      droits: await droitsUtilisables(imfId),
      revision: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

export default r;
