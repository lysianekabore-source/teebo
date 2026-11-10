// teebo — Journalisation d'audit immuable (pour l'IA anti-fraude)
// ---------------------------------------------------------------------------
// La table audit_log est APPEND-ONLY (trigger trg_audit_immutable : toute
// UPDATE/DELETE est rejetée). Deux chemins complémentaires l'alimentent :
//
//  1. Automatique : le trigger fn_audit() journalise chaque INSERT/UPDATE/
//     DELETE des tables sensibles (imf, app_user, org_unit, ...). Il lit
//     l'acteur et son périmètre dans des variables de session posées par
//     bindActor() -> renseigne user_id, rôle, département, service.
//
//  2. Explicite : auditEvent() enregistre les actions métier non couvertes
//     par un trigger de table (ex. VALIDATE d'un dossier, connexion,
//     validation de versement), avec le même contexte.
//
// Chaque entrée porte : user_id, timestamp (created_at), action, département,
// service, rôle, entité + données (payload JSONB). Cloisonné par imf_id.
// ---------------------------------------------------------------------------
import { q, tx } from './db.js';
import { deptOfRole, serviceOfRole } from './org_structure.js';

function ctxOf(user) {
  return {
    actorId: user?.id || null,
    role: user?.role || null,
    dept: user?.dept_code || deptOfRole(user?.role) || null,
    service: user?.service_code || serviceOfRole(user?.role) || null
  };
}

/**
 * Pose les variables de session (SET LOCAL) pour que fn_audit() capte
 * l'acteur. À appeler au début d'une transaction, AVANT les écritures.
 * @param {import('pg').PoolClient} client client de transaction
 * @param {object} user req.user
 */
export async function bindActor(client, user) {
  const c = ctxOf(user);
  await client.query(
    `SELECT set_config('teebo.actor_id', $1, true),
            set_config('teebo.actor_role', $2, true),
            set_config('teebo.department', $3, true),
            set_config('teebo.service', $4, true)`,
    [c.actorId || '', c.role || '', c.dept || '', c.service || '']
  );
}

/**
 * Transaction instrumentée : ouvre une tx, pose le contexte d'audit puis
 * exécute fn(client). Les triggers journaliseront avec l'acteur renseigné.
 * @param {object} user req.user
 * @param {(client)=>Promise<any>} fn
 */
export async function txAudit(user, fn) {
  return tx(async (client) => {
    await bindActor(client, user);
    return fn(client);
  });
}

/**
 * Journalise une action métier explicite (append-only).
 * @param {object} user req.user
 * @param {{action:string, entity?:string, entityId?:string, payload?:object}} ev
 */
export async function auditEvent(user, ev) {
  const c = ctxOf(user);
  await q(
    `INSERT INTO audit_log(imf_id, actor_id, actor_role, department, service,
                           action, entity, entity_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user?.imf_id || null, c.actorId, c.role, c.dept, c.service,
     ev.action, ev.entity || null, ev.entityId || null,
     ev.payload ? JSON.stringify(ev.payload) : null]
  );
}

/**
 * Middleware Express : journalise automatiquement la requête aboutie
 * (code < 400) comme événement métier. À placer après authenticate.
 * @param {string} action libellé de l'action (ex. 'credit.validate')
 * @param {string} [entity]
 */
export function auditRequest(action, entity) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.user) {
        auditEvent(req.user, {
          action, entity,
          entityId: req.params?.id,
          payload: { method: req.method, path: req.originalUrl }
        }).catch(() => {});
      }
    });
    next();
  };
}
