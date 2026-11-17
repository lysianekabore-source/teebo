// teebo — Contrôle d'accès STRICT fondé sur les habilitations affectées
// ---------------------------------------------------------------------------
// Problème corrigé (cause racine) : 129 routes ne vérifiaient que le RÔLE
// (requireRole('admin_imf','direction','staff'...)). Un agent dont on avait
// décoché l'habilitation continuait donc à utiliser le module :
//   - il ne VOYAIT plus l'entrée de menu (côté site),
//   - mais l'API restait ouverte : l'écran restait utilisable par URL directe.
// De plus, certaines habilitations du catalogue n'avaient AUCUNE route pour
// les faire respecter (ex. clients.freeze, savings.manage, credit.process).
//
// Ce module fournit :
//   1. habilit(): exige une ou plusieurs clés d'habilitation (OU logique).
//      Appliqué APRÈS authenticate, il s'appuie sur userHasPermission() qui
//      combine surcharge utilisateur (user_permission) + défauts du POSTE.
//   2. tenantScope(): garde-fou de cloisonnement (imf_id) réutilisable.
//   3. canAny(): test synchrone d'affichage (le user porte ses clés).
// ---------------------------------------------------------------------------
import { userHasPermission } from './auth.js';
import { q } from './db.js';

/**
 * Middleware : exige AU MOINS UNE des habilitations fournies.
 * @param {...string} keys clés d'habilitation (ex. 'clients.manage')
 */
export function habilit(...keys) {
  const list = keys.flat().filter(Boolean);
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
      for (const k of list) {
        if (await userHasPermission(req.user, k)) {
          req.grantedPermission = k;
          return next();
        }
      }
      // Refus explicite : on nomme l'habilitation attendue pour que le site
      // puisse afficher « habilitation manquante » au lieu d'un écran muet.
      return res.status(403).json({
        error: 'permission_denied',
        permission: list[0],
        required: list,
        message: 'Vous ne disposez pas de cette habilitation. Contactez l’administrateur de votre IMF.'
      });
    } catch (e) { next(e); }
  };
}

/**
 * Garde-fou de cloisonnement : vérifie que la ressource ciblée appartient bien
 * à l'IMF de l'utilisateur. À utiliser avant toute écriture par identifiant.
 * @param {string} table table contenant la colonne imf_id
 * @param {string} id    identifiant de la ligne visée
 * @returns {Promise<bool>}
 */
export async function belongsToUserImf(req, table, id, column = 'id') {
  if (!req.user || !id) return false;
  const safe = String(table).replace(/[^a-z_]/g, '');
  const col = String(column).replace(/[^a-z_]/g, '');
  const r = await q(
    `SELECT 1 FROM ${safe} WHERE ${col} = $1 AND imf_id = $2 LIMIT 1`,
    [id, req.user.imf_id]);
  return r.rows.length > 0;
}

/**
 * Test d'affichage : l'utilisateur porte-t-il au moins une des clés ?
 * Utilisable côté console (pas de requête).
 */
export function canAny(user, keys) {
  if (!user) return false;
  const owned = new Set(user.permissions || []);
  return (keys || []).some((k) => owned.has(k));
}

export default { habilit, belongsToUserImf, canAny };
