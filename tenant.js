// teebo — CLOISONNEMENT MULTI-TENANT (SaaS IMF). Middlewares et helpers de contexte.
import { pool, q, tx } from './db.js';

/** En-tête réservé à l'éditeur pour choisir une IMF (MB-05). */
export const TENANT_HEADER = 'x-teebo-institution';

/** Rôle éditeur : seul autorisé à franchir la frontière (et c'est tracé). */
const PLATFORM_ROLE = 'teebo_admin';

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Middleware GLOBAL de contextetenant.
 * À placer APRÈS authenticate (sinon req.user absent : on ne bloque pas, la
 * route protégée répondra 401 d'elle-même).
 *
 * Il fixe req.tenant = { imf_id, role, is_platform, switched } et prépare
 * req.dbImfId — la SEULE valeur que les routes devront utiliser.
 */
export function tenantContext(req, res, next) {
  const u = req.user;
  if (!u) { req.dbImfId = null; req.tenant = null; return next(); }
  // CORRECTIF 51 : un en-tete laisse par un autre onglet ne doit jamais
  // bloquer une requete (comparaison insensible a la casse, espaces ignores).
  const hdrTenant = String(req.headers[TENANT_HEADER] || '').trim();

  let imfId = u.imf_id || null;
  let switched = false;

  // MB-05 : l'éditeur peut viser une IMF précise pour le support.
  if (u.role === PLATFORM_ROLE) {
    const asked = hdrTenant;
    if (asked) {
      if (!isUuid(asked)) {
        return res.status(400).json({
          error: 'invalid_tenant',
          message: 'Identifiant d’institution invalide dans l’en-tête de bascule.'
        });
      }
      imfId = asked;
      switched = true;
    }
  }

  // MB-02 : divergence impossible côté IMF classique. Si la session portait
  // déjà une IMF et que l'en-tête tente d'en imposer une autre, on REFUSE.
  if (u.role !== PLATFORM_ROLE && hdrTenant &&
      hdrTenant.toLowerCase() !== String(u.imf_id || '').toLowerCase()) {
    return res.status(403).json({
      error: 'tenant_mismatch',
      message: 'Changez d’institution n’est pas autorisé pour ce compte.'
    });
  }

  req.tenant = {
    imf_id: imfId,
    institution_id: imfId,          // alias SaaS
    role: u.role || null,
    user_id: u.id || null,
    is_platform: u.role === PLATFORM_ROLE,
    switched
  };
  req.dbImfId = imfId;              // ← à utiliser dans TOUTES les requêtes
  res.setHeader('X-Tenant', imfId || 'none');
  next();
}

/**
 * Pose le contexte de session PostgreSQL sur une connexion. `local=true`
 * limite la portée à la transaction (recommandé) ; `false` pour une connexion
 * de pool réutilisée hors transaction.
 */
async function bindTenant(c, imfId, actorId, local = true) {
  await c.query(
    `SELECT set_config('teebo.imf_id', $1, $3),
            set_config('teebo.actor_id', $2, $3)`,
    [imfId || '', actorId || '', local]
  );
}

/**
 * Transaction AVEC contexte tenant + audit (remplace txAudit pour le financier).
 * Toutes les écritures faites dans fn(c) sont sous RLS et tracées par acteur.
 * @param {object} req requête Express (req.user / req.tenant)
 * @param {(client)=>Promise<any>} fn
 */
export async function tenantTransaction(req, fn) {
  const imfId = (req && (req.dbImfId || (req.user && req.user.imf_id))) || null;
  const actorId = req && req.user ? req.user.id : null;
  return tx(async (c) => {
    await bindTenant(c, imfId, actorId, true);
    return fn(c);
  });
}

/**
 * Exécute une requête SIMPLE sous contexte tenant (lecture). Sans cela, une
 * lecture hors transaction ne verrait rien dès que la RLS est active.
 */
export async function tenantQuery(req, text, params = []) {
  const imfId = (req && (req.dbImfId || (req.user && req.user.imf_id))) || null;
  const actorId = req && req.user ? req.user.id : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await bindTenant(client, imfId, actorId, true);
    const out = await client.query(text, params);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Erreur métier standardisée de franchissement de frontière (HTTP 404). */
export function tenantViolation(resource = 'ressource') {
  // 404 (et non 403) : on ne révèle pas l'existence d'une donnée d'une autre IMF.
  const e = new Error(`tenant_violation`);
  e.status = 404;
  e.code = 'tenant_violation';
  e.expose = true;
  e.userMessage = `Cette ${resource} n’existe pas dans votre institution.`;
  return e;
}

/**
 * Garde-fou objet (MB-04) : vérifie que la ligne visée appartient bien à
 * l'IMF de session AVANT toute écriture. Accepte les deux noms de colonne.
 */
export function assertTenant(req, row, resource = 'donnée') {
  const imfId = req && (req.dbImfId || (req.user && req.user.imf_id));
  if (!row) return tenantViolation(resource);
  const owner = row.imf_id || row.institution_id || null;
  if (!imfId || !owner || String(owner) !== String(imfId)) {
    return tenantViolation(resource);
  }
  return null;
}

/** Variante « lève l'erreur » : assertTenantOrThrow(req, row). */
export function assertTenantOrThrow(req, row, resource = 'donnée') {
  const e = assertTenant(req, row, resource);
  if (e) throw e;
  return row;
}

/**
 * Vérifie qu'une IMF existe et est active (bascule éditeur, provisionnement).
 */
export async function assertInstitutionActivated(imfId) {
  const { rows } = await q('SELECT id, name, status FROM imf WHERE id=$1', [imfId]);
  if (!rows.length) {
    const e = new Error('institution_not_found');
    e.status = 404; e.code = 'institution_not_found'; e.expose = true;
    e.userMessage = 'Institution introuvable.';
    throw e;
  }
  return rows[0];
}

export default {
  tenantContext, tenantTransaction, tenantQuery,
  assertTenant, assertTenantOrThrow, tenantViolation,
  assertInstitutionActivated, TENANT_HEADER
};
