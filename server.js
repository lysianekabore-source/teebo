// teebo — API Matrice des habilitations — déployable Render
// =========================================================================
// Deux niveaux (modèle à deux étages) :
//
//  1) CÔTÉ teebo (super-admin plateforme)
//     → définit, POUR CHAQUE IMF, les habilitations AUTORISÉES (entitlements).
//       C'est le périmètre souscrit : on coche/décoche ce que l'IMF a le droit
//       d'utiliser. Protégé par TEEBO_ADMIN_TOKEN.
//
//  2) CÔTÉ admin IMF
//     → répartit ces habilitations ENTRE SES UTILISATEURS (on coche/décoche
//       par utilisateur). Un admin IMF ne peut JAMAIS accorder une habilitation
//       que teebo n'a pas activée pour son IMF. Scope strict par imf_id.
//
// Garde-fou réglementaire : l'habilitation 'credit.auto_disburse' (décaissement
// IA automatique) est INTERDITE — verrouillée des deux côtés, 403 côté serveur.
//
// Modes : DEMO=1 (état en mémoire, aucune base) | sinon PostgreSQL (DATABASE_URL).
// Audit append-only de chaque changement (table habilitation_audit en mode réel).
// =========================================================================

import express from 'express';
import cors from 'cors';
import { CATALOG, BY_CODE, isForbidden, exists } from './catalog.js';
import { ROLE_TEMPLATES, roleList } from './roles.js';
import { attachSession } from './session.js';
import { requireTeeboRole, requirePermission } from './rbac.js';
import { makeLoginHandler, signToken } from './auth.js';
import { verifyPassword, hashPassword } from './password.js';
import { sendInvitationEmail } from './mailer.js';
import crypto from 'crypto';

// Charge les habilitations d'un rôle : EN BASE (role_template) en prod,
// depuis roles.js en mode DEMO. Renvoie un tableau de codes (ou null si rôle inconnu).
async function templatePerms(role) {
  if (DEMO) { const t = ROLE_TEMPLATES[role]; return t ? t.perms.slice() : null; }
  const { q } = await import('./db.js');
  const r = await q('SELECT permission_code FROM role_template WHERE role_key = $1', [role]);
  return r.rows.length ? r.rows.map((x) => x.permission_code) : null;
}

const DEMO = process.env.DEMO === '1';
const USE_SESSION = process.env.USE_SESSION === '1'; // prod : vraie session (JWT vérifié)
const API_TOKEN = process.env.API_TOKEN || '';              // côté admin IMF (mode jeton)
const TEEBO_ADMIN_TOKEN = process.env.TEEBO_ADMIN_TOKEN || ''; // côté teebo (mode jeton)
const NETLIFY_ORIGIN = process.env.NETLIFY_ORIGIN || '';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors({ origin: NETLIFY_ORIGIN || true }));
app.use(express.json());

// ------------------------------------------------------------------ Auth
// Deux régimes selon USE_SESSION :
//  • USE_SESSION=1  -> VRAIE SESSION : imf_id et rôles/permissions viennent du
//                      jeton de session VÉRIFIÉ (jamais des en-têtes client).
//                      Côté teebo = rôle plateforme ; côté IMF = permission rbac.manage.
//  • sinon          -> mode jeton pragmatique (déploiement rapide / démo).

// Chaîne côté teebo (super-admin plateforme).
const teeboGuard = USE_SESSION ? [attachSession, requireTeeboRole] : [authTeeboToken];
// Chaîne côté admin IMF : imf_id dérivé de la session + permission rbac.manage.
const adminGuard = USE_SESSION
  ? [attachSession, requirePermission('rbac.manage'), deriveImfFromSession]
  : [authAdminToken];
// Chaîne gestion des utilisateurs : exige la permission user.manage.
const userMgmtGuard = USE_SESSION
  ? [attachSession, requirePermission('user.manage'), deriveImfFromSession]
  : [authAdminToken];

// --- Mode jeton (USE_SESSION=0) ---
function authTeeboToken(req, res, next) {
  if (TEEBO_ADMIN_TOKEN) {
    if ((req.get('Authorization') || '') !== `Bearer ${TEEBO_ADMIN_TOKEN}`) {
      return res.status(401).json({ error: 'token_teebo_invalide' });
    }
  }
  next();
}
function authAdminToken(req, res, next) {
  if (API_TOKEN) {
    if ((req.get('Authorization') || '') !== `Bearer ${API_TOKEN}`) {
      return res.status(401).json({ error: 'token_invalide' });
    }
  }
  req.imfId = req.get('x-imf-id') || null;
  if (!DEMO && !req.imfId) return res.status(400).json({ error: 'imf_id_absent' });
  next();
}
// --- Mode session (USE_SESSION=1) : imf_id depuis la session, jamais l'en-tête ---
function deriveImfFromSession(req, _res, next) { req.imfId = req.session.imfId; next(); }
// Acteur (pour l'audit) : session en prod, en-tête x-actor-id sinon.
const actorOf = (req, fallback) => (USE_SESSION && req.session ? req.session.userId : (req.get('x-actor-id') || fallback));

app.get('/health', (_req, res) => res.json({ ok: true, demo: DEMO, session: USE_SESSION }));

// Catalogue des habilitations (public pour alimenter l'interface).
app.get('/api/v1/catalog', (_req, res) => res.json({ catalog: CATALOG }));

// Modèles d'habilitations par rôle (pour le préremplissage en un clic).
// En prod : lus EN BASE (role_template). En DEMO : depuis roles.js.
app.get('/api/v1/role-templates', async (_req, res) => {
  if (DEMO) return res.json({ roles: roleList() });
  try {
    const { q } = await import('./db.js');
    const r = await q('SELECT role_key, label, permission_code FROM role_template ORDER BY role_key', []);
    const map = new Map();
    for (const row of r.rows) {
      if (!map.has(row.role_key)) map.set(row.role_key, { key: row.role_key, label: row.label, perms: [] });
      map.get(row.role_key).perms.push(row.permission_code);
    }
    res.json({ roles: Array.from(map.values()) });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Connexion réelle : émet un jeton de session à partir des identifiants en base.
app.post('/api/v1/auth/login', makeLoginHandler({ DEMO, demoLogin }));

// -------------------------------------------------------------------
// Changement de mot de passe par l'utilisateur lui-même (self-service).
// Obligatoire à la première connexion (must_change_password = true).
// Nécessite une session valide (le compte prouve son identité par le jeton).
// body : { current_password, new_password }
// -------------------------------------------------------------------
const selfSessionGuard = USE_SESSION ? [attachSession] : [(req, _res, next) => { req.session = req.session || null; next(); }];
app.post('/api/v1/auth/change-password', ...selfSessionGuard, async (req, res) => {
  const b = req.body || {};
  const current = (b.current_password || '').toString();
  const next = (b.new_password || '').toString();
  if (next.length < 8) return res.status(400).json({ error: 'mot_de_passe_trop_court', min: 8 });
  if (next === current) return res.status(400).json({ error: 'mot_de_passe_identique' });
  if (!USE_SESSION) return res.status(400).json({ error: 'session_requise' });
  const s = req.session;
  if (!s || !s.userId) return res.status(401).json({ error: 'session_invalide' });

  // Re-signe un jeton frais sans l'obligation de changement (mcp:false).
  const freshToken = () => signToken({ sub: s.userId, imf_id: s.imfId, roles: s.roles, permissions: s.permissions, mcp: false });

  if (DEMO) {
    // Mode démo : pas de base ; on lève simplement l'obligation en mémoire.
    for (const list of Object.values(demo.users)) {
      const u = list.find((x) => x.id === s.userId);
      if (u) u.must_change_password = false;
    }
    return res.json({ ok: true, token: freshToken() });
  }
  try {
    const { q } = await import('./db.js');
    const r = await q('SELECT password_hash, imf_id FROM app_user WHERE id=$1 AND active=true', [s.userId]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'utilisateur_inconnu' });
    if (!verifyPassword(current, row.password_hash)) return res.status(401).json({ error: 'mot_de_passe_actuel_invalide' });
    const hash = hashPassword(next);
    await q('UPDATE app_user SET password_hash=$2, must_change_password=false WHERE id=$1', [s.userId, hash]);
    // Traçabilité (uniquement si rattaché à une IMF).
    if (row.imf_id) {
      await q(
        `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
         VALUES ($1,$2,'imf',$2,'gestion.compte','USER_PWD_CHANGE',now())`, [row.imf_id, s.userId]);
    }
    res.json({ ok: true, token: freshToken() });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// =====================================================================
// ÉTAT EN MÉMOIRE (mode DEMO uniquement)
// =====================================================================
const demo = {
  imfs: [
    { id: 'imf-001', name: 'IMF Faso Djigui' },
    { id: 'imf-002', name: 'IMF Nianan Finance' }
  ],
  users: {
    'imf-001': [
      { id: 'u1', full_name: 'Aïssata Ouédraogo', email: 'aissata@imf001.bf', role: 'collectrice', active: true },
      { id: 'u2', full_name: 'Fatou Sanogo', email: 'fatou@imf001.bf', role: 'collectrice', active: true },
      { id: 'u3', full_name: 'Ibrahim Touré', email: 'ibrahim@imf001.bf', role: 'superviseur', active: true },
      { id: 'u4', full_name: 'Mariam Koné', email: 'mariam@imf001.bf', role: 'guichet', active: true }
    ],
    'imf-002': [
      { id: 'v1', full_name: 'Salif Diarra', email: 'salif@imf002.bf', role: 'superviseur', active: true },
      { id: 'v2', full_name: 'Awa Cissé', email: 'awa@imf002.bf', role: 'collectrice', active: true }
    ]
  },
  // Habilitations autorisées par teebo pour chaque IMF (Set de codes).
  entitlements: {
    'imf-001': new Set(Object.keys(BY_CODE).filter((c) => !isForbidden(c))),
    'imf-002': new Set(['cash.view', 'tour.collect', 'tour.close', 'momo.collect',
      'momo.view', 'report.view', 'client.view', 'client.create'])
  },
  // Habilitations accordées par l'admin IMF à chaque utilisateur.
  grants: {
    'imf-001': {
      u1: new Set(['tour.collect', 'momo.collect', 'client.view']),
      u2: new Set(['tour.collect', 'momo.collect']),
      u3: new Set(['supervisor.validate', 'report.view', 'report.export', 'tour.close']),
      u4: new Set(['cash.view', 'cash.deposit', 'cash.withdraw', 'client.view'])
    },
    'imf-002': {
      v1: new Set(['supervisor.validate', 'report.view', 'tour.close']),
      v2: new Set(['tour.collect', 'momo.collect'])
    }
  },
  // Journal des changements (append-only) en mode démo.
  audit: []
};

const setToArr = (s) => Array.from(s || []);

// --- Connexion en mode DEMO (sans base) : comptes fixes en mémoire ---
// Mêmes identifiants que le seed, pour tester le flux de connexion complet.
const DEMO_ACCOUNTS = {
  'admin@teebo.io': { pass: 'Teebo!2026', sub: 'teebo-admin', imf_id: null, role: 'admin_imf', teebo: true },
  'admin@imf001.bf': { pass: 'AdminImf!2026', sub: 'a1', imf_id: 'imf-001', role: 'admin_imf', teebo: false },
  'admin@imf002.bf': { pass: 'AdminImf!2026', sub: 'a2', imf_id: 'imf-002', role: 'admin_imf', teebo: false }
};
function demoLogin(email, password) {
  const acc = DEMO_ACCOUNTS[email];
  if (!acc || acc.pass !== password) return null;
  const roles = [acc.role];
  if (acc.teebo) roles.push(process.env.TEEBO_ROLE || 'TEEBO_ADMIN');
  if (acc.role === 'admin_imf') roles.push('IMF_ADMIN');
  const tpl = ROLE_TEMPLATES[acc.role];
  const permissions = tpl ? tpl.perms.slice() : [];
  return { sub: acc.sub, imf_id: acc.imf_id, roles, permissions };
}

// Nom lisible d'une cible (IMF ou utilisateur) pour l'affichage de l'historique.
function demoTargetName(imfId, scope, targetId) {
  if (scope === 'teebo') { const i = demo.imfs.find((x) => x.id === targetId); return i ? i.name : targetId; }
  const u = (demo.users[imfId] || []).find((x) => x.id === targetId); return u ? u.full_name : targetId;
}
// Ajoute une entrée d'audit en mémoire (mode démo).
function logDemo(imfId, actor, scope, targetId, code, action) {
  demo.audit.unshift({
    id: demo.audit.length + 1, imf_id: imfId, actor_id: actor, scope,
    target_id: targetId, target_name: demoTargetName(imfId, scope, targetId),
    permission_code: code, permission_label: (BY_CODE[code] && BY_CODE[code].label) || code,
    action, created_at: new Date().toISOString()
  });
}

// =====================================================================
// CÔTÉ teebo — habilitations autorisées par IMF (entitlements)
// =====================================================================

// Liste des IMF (pour le sélecteur).
app.get('/api/v1/teebo/imf', teeboGuard, async (_req, res) => {
  if (DEMO) return res.json({ items: demo.imfs });
  try {
    const { q } = await import('./db.js');
    const r = await q('SELECT id, name FROM imf ORDER BY name', []);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Matrice des entitlements d'une IMF : { enabled: [codes] }.
app.get('/api/v1/teebo/entitlements', teeboGuard, async (req, res) => {
  const imfId = (req.query.imfId || '').toString();
  if (!imfId) return res.status(400).json({ error: 'imfId_absent' });
  if (DEMO) {
    return res.json({ imfId, enabled: setToArr(demo.entitlements[imfId]) });
  }
  try {
    const { q } = await import('./db.js');
    const r = await q(
      'SELECT permission_code FROM imf_entitlement WHERE imf_id = $1 AND enabled = true',
      [imfId]);
    res.json({ imfId, enabled: r.rows.map((x) => x.permission_code) });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Enregistre un lot de changements d'entitlements pour une IMF.
// body : { imfId, changes: [{ permissionCode, enabled }] }
app.post('/api/v1/teebo/entitlements', teeboGuard, async (req, res) => {
  const { imfId, changes } = req.body || {};
  if (!imfId || !Array.isArray(changes)) return res.status(400).json({ error: 'requete_invalide' });
  const rejected = [];
  const applied = [];
  for (const ch of changes) {
    const code = ch && ch.permissionCode;
    const on = !!(ch && ch.enabled);
    if (!exists(code)) { rejected.push({ code, raison: 'habilitation_inconnue' }); continue; }
    if (on && isForbidden(code)) { rejected.push({ code, raison: 'habilitation_interdite' }); continue; }
    applied.push({ code, on });
  }
  if (DEMO) {
    const set = demo.entitlements[imfId] || (demo.entitlements[imfId] = new Set());
    const actor = actorOf(req, 'teebo-admin');
    for (const a of applied) {
      if (a.on) set.add(a.code); else { set.delete(a.code); demoRevokeFromUsers(imfId, a.code); }
      logDemo(imfId, actor, 'teebo', imfId, a.code, a.on ? 'ENABLE' : 'DISABLE');
    }
    return res.json({ imfId, enabled: setToArr(set), applied: applied.length, rejected });
  }
  try {
    const { q } = await import('./db.js');
    const actor = actorOf(req, 'teebo-admin');
    for (const a of applied) {
      await q(
        `INSERT INTO imf_entitlement (imf_id, permission_code, enabled, updated_at, updated_by)
         VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (imf_id, permission_code)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [imfId, a.code, a.on, actor]);
      // Si on retire l'entitlement, on retire aussi les grants utilisateurs correspondants.
      if (!a.on) await q('DELETE FROM user_permission WHERE imf_id = $1 AND permission_code = $2', [imfId, a.code]);
      await q(
        `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
         VALUES ($1,$2,'teebo',$1,$3,$4,now())`,
        [imfId, actor, a.code, a.on ? 'ENABLE' : 'DISABLE']);
    }
    const r = await q('SELECT permission_code FROM imf_entitlement WHERE imf_id=$1 AND enabled=true', [imfId]);
    res.json({ imfId, enabled: r.rows.map((x) => x.permission_code), applied: applied.length, rejected });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// En démo : quand teebo retire un entitlement, on nettoie les grants des users.
function demoRevokeFromUsers(imfId, code) {
  const g = demo.grants[imfId] || {};
  for (const uid of Object.keys(g)) g[uid].delete(code);
}

// =====================================================================
// CÔTÉ admin IMF — habilitations par utilisateur (grants)
// Un grant n'est possible que si l'IMF est ENTITLED pour cette habilitation.
// =====================================================================

// Utilisateurs de l'IMF courante.
app.get('/api/v1/admin/users', adminGuard, async (req, res) => {
  if (DEMO) return res.json({ items: demo.users[req.imfId] || demo.users['imf-001'] });
  try {
    const { q } = await import('./db.js');
    const r = await q('SELECT id, full_name, role FROM app_user WHERE imf_id = $1 ORDER BY full_name', [req.imfId]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Matrice utilisateurs × habilitations pour l'IMF courante.
// Renvoie : entitled (codes autorisés par teebo) + grants { userId: [codes] }.
app.get('/api/v1/admin/matrix', adminGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  if (DEMO) {
    const entitled = setToArr(demo.entitlements[imfId]);
    const grants = {};
    const g = demo.grants[imfId] || {};
    for (const uid of Object.keys(g)) grants[uid] = setToArr(g[uid]);
    return res.json({ imfId, entitled, grants, users: demo.users[imfId] || [] });
  }
  try {
    const { q } = await import('./db.js');
    const ent = await q('SELECT permission_code FROM imf_entitlement WHERE imf_id=$1 AND enabled=true', [imfId]);
    const gr = await q('SELECT user_id, permission_code FROM user_permission WHERE imf_id=$1', [imfId]);
    const us = await q('SELECT id, full_name, role FROM app_user WHERE imf_id=$1 ORDER BY full_name', [imfId]);
    const grants = {};
    for (const row of gr.rows) (grants[row.user_id] = grants[row.user_id] || []).push(row.permission_code);
    res.json({ imfId, entitled: ent.rows.map((x) => x.permission_code), grants, users: us.rows });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Enregistre un lot de changements de grants.
// body : { changes: [{ userId, permissionCode, granted }] } ; imf_id vient de l'en-tête.
app.post('/api/v1/admin/grants', adminGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const { changes } = req.body || {};
  if (!Array.isArray(changes)) return res.status(400).json({ error: 'requete_invalide' });

  // Ensemble des habilitations autorisées par teebo pour cette IMF.
  let entitled;
  if (DEMO) {
    entitled = demo.entitlements[imfId] || new Set();
  } else {
    try {
      const { q } = await import('./db.js');
      const r = await q('SELECT permission_code FROM imf_entitlement WHERE imf_id=$1 AND enabled=true', [imfId]);
      entitled = new Set(r.rows.map((x) => x.permission_code));
    } catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  }

  const rejected = [];
  const applied = [];
  for (const ch of changes) {
    const userId = ch && ch.userId;
    const code = ch && ch.permissionCode;
    const on = !!(ch && ch.granted);
    if (!userId || !exists(code)) { rejected.push({ userId, code, raison: 'parametre_invalide' }); continue; }
    if (on && isForbidden(code)) { rejected.push({ userId, code, raison: 'habilitation_interdite' }); continue; }
    // Règle clé : impossible d'accorder hors du périmètre autorisé par teebo.
    if (on && !entitled.has(code)) { rejected.push({ userId, code, raison: 'non_autorisee_par_teebo' }); continue; }
    applied.push({ userId, code, on });
  }

  if (DEMO) {
    const g = demo.grants[imfId] || (demo.grants[imfId] = {});
    const actor = actorOf(req, 'imf-admin');
    for (const a of applied) {
      const set = g[a.userId] || (g[a.userId] = new Set());
      if (a.on) set.add(a.code); else set.delete(a.code);
      logDemo(imfId, actor, 'imf', a.userId, a.code, a.on ? 'GRANT' : 'REVOKE');
    }
    const grants = {};
    for (const uid of Object.keys(g)) grants[uid] = setToArr(g[uid]);
    return res.json({ imfId, grants, applied: applied.length, rejected });
  }
  try {
    const { q } = await import('./db.js');
    const actor = actorOf(req, 'imf-admin');
    for (const a of applied) {
      if (a.on) {
        await q(
          `INSERT INTO user_permission (imf_id, user_id, permission_code, updated_at, updated_by)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (imf_id, user_id, permission_code) DO NOTHING`,
          [imfId, a.userId, a.code, actor]);
      } else {
        await q('DELETE FROM user_permission WHERE imf_id=$1 AND user_id=$2 AND permission_code=$3',
          [imfId, a.userId, a.code]);
      }
      await q(
        `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
         VALUES ($1,$2,'imf',$3,$4,$5,now())`,
        [imfId, actor, a.userId, a.code, a.on ? 'GRANT' : 'REVOKE']);
    }
    const gr = await q('SELECT user_id, permission_code FROM user_permission WHERE imf_id=$1', [imfId]);
    const grants = {};
    for (const row of gr.rows) (grants[row.user_id] = grants[row.user_id] || []).push(row.permission_code);
    res.json({ imfId, grants, applied: applied.length, rejected });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});


// =====================================================================
// Préremplissage par rôle : applique un modèle à un utilisateur.
// body : { userId, role, mode } ; mode = 'replace' (défaut) ou 'add'.
// Toujours intersecté avec le périmètre autorisé par teebo ; exclut les interdites.
// =====================================================================
app.post('/api/v1/admin/apply-template', adminGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const { userId, role } = req.body || {};
  const mode = (req.body && req.body.mode) === 'add' ? 'add' : 'replace';
  if (!userId || !role) return res.status(400).json({ error: 'parametre_invalide' });
  // Habilitations du rôle : lues EN BASE (role_template) en prod, roles.js en DEMO.
  let tplPerms;
  try { tplPerms = await templatePerms(role); }
  catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  if (!tplPerms) return res.status(400).json({ error: 'role_inconnu' });

  // Périmètre autorisé par teebo.
  let entitled;
  if (DEMO) { entitled = demo.entitlements[imfId] || new Set(); }
  else {
    try {
      const { q } = await import('./db.js');
      const r = await q('SELECT permission_code FROM imf_entitlement WHERE imf_id=$1 AND enabled=true', [imfId]);
      entitled = new Set(r.rows.map((x) => x.permission_code));
    } catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  }
  // Habilitations cibles = modèle ∩ autorisées, sans les interdites.
  const target = tplPerms.filter((c) => entitled.has(c) && !isForbidden(c));

  if (DEMO) {
    const g = demo.grants[imfId] || (demo.grants[imfId] = {});
    const actor = actorOf(req, 'imf-admin');
    const before = g[userId] ? new Set(g[userId]) : new Set();
    const next = mode === 'add' ? new Set([...before, ...target]) : new Set(target);
    // journaliser les différences
    for (const c of next) if (!before.has(c)) logDemo(imfId, actor, 'imf', userId, c, 'GRANT');
    if (mode === 'replace') for (const c of before) if (!next.has(c)) logDemo(imfId, actor, 'imf', userId, c, 'REVOKE');
    g[userId] = next;
    const grants = {};
    for (const uid of Object.keys(g)) grants[uid] = setToArr(g[uid]);
    return res.json({ imfId, grants, role, applied: target.length });
  }
  try {
    const { q } = await import('./db.js');
    const actor = actorOf(req, 'imf-admin');
    if (mode === 'replace') {
      await q('DELETE FROM user_permission WHERE imf_id=$1 AND user_id=$2', [imfId, userId]);
    }
    for (const c of target) {
      await q(
        `INSERT INTO user_permission (imf_id, user_id, permission_code, updated_at, updated_by)
         VALUES ($1,$2,$3,now(),$4) ON CONFLICT (imf_id, user_id, permission_code) DO NOTHING`,
        [imfId, userId, c, actor]);
      await q(
        `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
         VALUES ($1,$2,'imf',$3,$4,'GRANT',now())`, [imfId, actor, userId, c]);
    }
    const gr = await q('SELECT user_id, permission_code FROM user_permission WHERE imf_id=$1', [imfId]);
    const grants = {};
    for (const row of gr.rows) (grants[row.user_id] = grants[row.user_id] || []).push(row.permission_code);
    res.json({ imfId, grants, role, applied: target.length });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// =====================================================================
// GESTION DES UTILISATEURS (depuis l'interface) — permission user.manage.
// Toujours scopé par imf_id (session en prod) : un admin ne voit et ne modifie
// QUE les comptes de SON IMF. Les mots de passe sont hachés (scrypt).
// Journalisé dans habilitation_audit (code 'gestion.compte').
// =====================================================================
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ACTIONS = { CREATE: 'USER_CREATE', DISABLE: 'USER_DISABLE', ENABLE: 'USER_ENABLE', ROLE: 'USER_ROLE', PWD: 'USER_PWD_RESET' };

// Liste des comptes de l'IMF (avec e-mail, rôle, statut actif).
app.get('/api/v1/admin/accounts', userMgmtGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  if (DEMO) {
    const items = (demo.users[imfId] || []).map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, active: u.active !== false }));
    return res.json({ items });
  }
  try {
    const { q } = await import('./db.js');
    const r = await q('SELECT id, full_name, email, role, active FROM app_user WHERE imf_id=$1 AND is_teebo_admin=false ORDER BY full_name', [imfId]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Crée un utilisateur dans l'IMF courante.
// body : { full_name, email, role, password }
app.post('/api/v1/admin/accounts', userMgmtGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const b = req.body || {};
  const full_name = (b.full_name || '').toString().trim();
  const email = (b.email || '').toString().trim().toLowerCase();
  const role = (b.role || '').toString().trim();
  const password = (b.password || '').toString();
  if (!full_name || !EMAIL_RE.test(email) || !role) return res.status(400).json({ error: 'champs_invalides' });
  if (password.length < 8) return res.status(400).json({ error: 'mot_de_passe_trop_court', min: 8 });
  let perms;
  try { perms = await templatePerms(role); } catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  if (!perms) return res.status(400).json({ error: 'role_inconnu' });
  const actor = actorOf(req, 'imf-admin');
  const id = 'u-' + crypto.randomUUID().slice(0, 8);

  if (DEMO) {
    const list = demo.users[imfId] || (demo.users[imfId] = []);
    if (list.some((u) => (u.email || '').toLowerCase() === email)) return res.status(409).json({ error: 'email_deja_utilise' });
    list.push({ id, full_name, email, role, active: true, must_change_password: true });
    logDemo(imfId, actor, 'imf', id, 'gestion.compte', USER_ACTIONS.CREATE);
    const imfName = (demo.imfs.find((x) => x.id === imfId) || {}).name || '';
    const mail = await sendInvitationEmail({ to: email, full_name, imfName, email, password });
    return res.json({ id, full_name, email, role, active: true, must_change_password: true, email_sent: !!mail.sent, email_mock: !!mail.mock });
  }
  try {
    const { q } = await import('./db.js');
    const dup = await q('SELECT 1 FROM app_user WHERE imf_id=$1 AND lower(email)=$2', [imfId, email]);
    if (dup.rows.length) return res.status(409).json({ error: 'email_deja_utilise' });
    const hash = hashPassword(password);
    await q(
      `INSERT INTO app_user (id, imf_id, full_name, email, password_hash, role, is_teebo_admin, active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,false,true,true)`,
      [id, imfId, full_name, email, hash, role]);
    await q(
      `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
       VALUES ($1,$2,'imf',$3,'gestion.compte',$4,now())`, [imfId, actor, id, USER_ACTIONS.CREATE]);
    // E-mail d'invitation (lien + mot de passe initial). N'interrompt pas la création.
    let imfName = '';
    try { const ir = await q('SELECT name FROM imf WHERE id=$1', [imfId]); imfName = ir.rows[0] ? ir.rows[0].name : ''; } catch (_e) { /* non bloquant */ }
    const mail = await sendInvitationEmail({ to: email, full_name, imfName, email, password });
    res.json({ id, full_name, email, role, active: true, must_change_password: true, email_sent: !!mail.sent, email_mock: !!mail.mock });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Active / désactive un compte. body : { active:boolean }
app.post('/api/v1/admin/accounts/:id/status', userMgmtGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const id = req.params.id;
  const active = !!(req.body && req.body.active);
  const actor = actorOf(req, 'imf-admin');
  // Un admin ne peut pas se désactiver lui-même (évite le verrouillage).
  if (!active && USE_SESSION && req.session && req.session.userId === id) {
    return res.status(400).json({ error: 'auto_desactivation_interdite' });
  }
  if (DEMO) {
    const u = (demo.users[imfId] || []).find((x) => x.id === id);
    if (!u) return res.status(404).json({ error: 'utilisateur_inconnu' });
    u.active = active;
    logDemo(imfId, actor, 'imf', id, 'gestion.compte', active ? USER_ACTIONS.ENABLE : USER_ACTIONS.DISABLE);
    return res.json({ id, active });
  }
  try {
    const { q } = await import('./db.js');
    const r = await q('UPDATE app_user SET active=$3 WHERE imf_id=$1 AND id=$2 AND is_teebo_admin=false RETURNING id', [imfId, id, active]);
    if (!r.rows.length) return res.status(404).json({ error: 'utilisateur_inconnu' });
    await q(
      `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
       VALUES ($1,$2,'imf',$3,'gestion.compte',$4,now())`, [imfId, actor, id, active ? USER_ACTIONS.ENABLE : USER_ACTIONS.DISABLE]);
    res.json({ id, active });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Change le rôle d'un utilisateur. body : { role }
app.post('/api/v1/admin/accounts/:id/role', userMgmtGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const id = req.params.id;
  const role = (req.body && req.body.role || '').toString().trim();
  const actor = actorOf(req, 'imf-admin');
  let perms;
  try { perms = await templatePerms(role); } catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  if (!perms) return res.status(400).json({ error: 'role_inconnu' });
  if (DEMO) {
    const u = (demo.users[imfId] || []).find((x) => x.id === id);
    if (!u) return res.status(404).json({ error: 'utilisateur_inconnu' });
    u.role = role;
    logDemo(imfId, actor, 'imf', id, 'gestion.compte', USER_ACTIONS.ROLE);
    return res.json({ id, role });
  }
  try {
    const { q } = await import('./db.js');
    const r = await q('UPDATE app_user SET role=$3 WHERE imf_id=$1 AND id=$2 AND is_teebo_admin=false RETURNING id', [imfId, id, role]);
    if (!r.rows.length) return res.status(404).json({ error: 'utilisateur_inconnu' });
    await q(
      `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
       VALUES ($1,$2,'imf',$3,'gestion.compte',$4,now())`, [imfId, actor, id, USER_ACTIONS.ROLE]);
    res.json({ id, role });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// Réinitialise le mot de passe d'un utilisateur. body : { password }
app.post('/api/v1/admin/accounts/:id/password', userMgmtGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const id = req.params.id;
  const password = (req.body && req.body.password || '').toString();
  const actor = actorOf(req, 'imf-admin');
  if (password.length < 8) return res.status(400).json({ error: 'mot_de_passe_trop_court', min: 8 });
  if (DEMO) {
    const u = (demo.users[imfId] || []).find((x) => x.id === id);
    if (!u) return res.status(404).json({ error: 'utilisateur_inconnu' });
    u.must_change_password = true;
    logDemo(imfId, actor, 'imf', id, 'gestion.compte', USER_ACTIONS.PWD);
    return res.json({ id, ok: true });
  }
  try {
    const { q } = await import('./db.js');
    const hash = hashPassword(password);
    const r = await q('UPDATE app_user SET password_hash=$3, must_change_password=true WHERE imf_id=$1 AND id=$2 AND is_teebo_admin=false RETURNING id', [imfId, id, hash]);
    if (!r.rows.length) return res.status(404).json({ error: 'utilisateur_inconnu' });
    await q(
      `INSERT INTO habilitation_audit (imf_id, actor_id, scope, target_id, permission_code, action, created_at)
       VALUES ($1,$2,'imf',$3,'gestion.compte',$4,now())`, [imfId, actor, id, USER_ACTIONS.PWD]);
    res.json({ id, ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

// =====================================================================
// Historique des changements d'habilitations (audit append-only).
// Filtres : scope (teebo/imf), action, limit/offset. Scopeé par imf_id.
// =====================================================================
app.get('/api/v1/audit', adminGuard, async (req, res) => {
  const imfId = req.imfId || (DEMO ? 'imf-001' : null);
  const scope = (req.query.scope || '').toString();
  const action = (req.query.action || '').toString();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  if (DEMO) {
    let rows = demo.audit.filter((r) => r.imf_id === imfId);
    if (scope) rows = rows.filter((r) => r.scope === scope);
    if (action) rows = rows.filter((r) => r.action === action);
    return res.json({ total: rows.length, items: rows.slice(offset, offset + limit) });
  }
  try {
    const { q } = await import('./db.js');
    const where = ['a.imf_id = $1']; const params = [imfId];
    if (scope) { params.push(scope); where.push(`a.scope = $${params.length}`); }
    if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
    const whereSql = where.join(' AND ');
    const total = await q(`SELECT COUNT(*)::int AS n FROM habilitation_audit a WHERE ${whereSql}`, params);
    params.push(limit); const li = params.length; params.push(offset); const oi = params.length;
    const rows = await q(
      `SELECT a.id, a.imf_id, a.actor_id, a.scope, a.target_id, a.permission_code, a.action, a.created_at,
              u.full_name AS target_name
         FROM habilitation_audit a
         LEFT JOIN app_user u ON (a.scope = 'imf' AND u.id = a.target_id)
        WHERE ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${li} OFFSET $${oi}`, params);
    const items = rows.rows.map((r) => ({ ...r, permission_label: (BY_CODE[r.permission_code] && BY_CODE[r.permission_code].label) || r.permission_code }));
    res.json({ total: total.rows[0].n, items });
  } catch (e) { res.status(500).json({ error: 'erreur_base', detail: e.message }); }
});

app.listen(PORT, () => console.log(`teebo habilitations API sur le port ${PORT} (demo=${DEMO}, session=${USE_SESSION})`));
