// teebo — Authentification réelle : connexion contre la base + émission du jeton.
// ---------------------------------------------------------------------------
// POST /api/v1/auth/login { email, password } ->
//   1) retrouve l'utilisateur en base (app_user) par e-mail,
//   2) vérifie le mot de passe (scrypt, password.js),
//   3) calcule ses rôles + permissions à partir de role_template (RÔLES EN BASE),
//   4) signe un JWT HS256 (SESSION_JWT_SECRET) consommé ensuite par attachSession.
// Aucune confiance aux en-têtes : imf_id et identité sortent de la base.
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import { verifyPassword } from './password.js';

const SECRET = process.env.SESSION_JWT_SECRET || '';
const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 8); // 8 h

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Signe un JWT HS256 { sub, imf_id, roles, permissions, iat, exp }.
export function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + TTL_SECONDS }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

// Calcule roles[] + permissions[] d'un utilisateur à partir de la base.
async function buildClaims(q, user) {
  const roles = [user.role];
  if (user.is_teebo_admin) roles.push(process.env.TEEBO_ROLE || 'TEEBO_ADMIN');
  if (user.role === 'admin_imf') roles.push('IMF_ADMIN');
  // Permissions du rôle, lues EN BASE (role_template).
  const r = await q('SELECT permission_code FROM role_template WHERE role_key = $1', [user.role]);
  const permissions = r.rows.map((x) => x.permission_code);
  return { roles, permissions };
}

// Handler Express de connexion. `demoLogin` sert au mode DEMO (sans base).
export function makeLoginHandler({ DEMO, demoLogin }) {
  return async (req, res) => {
    if (!SECRET) return res.status(500).json({ error: 'secret_session_absent' });
    const email = (req.body && req.body.email || '').toString().trim().toLowerCase();
    const password = (req.body && req.body.password || '').toString();
    if (!email || !password) return res.status(400).json({ error: 'identifiants_requis' });

    if (DEMO) {
      const claims = demoLogin(email, password);
      if (!claims) return res.status(401).json({ error: 'identifiants_invalides' });
      return res.json({ token: signToken(claims), user: { ...claims, must_change_password: !!claims.mcp } });
    }
    try {
      const { q } = await import('./db.js');
      const r = await q(
        'SELECT id, imf_id, full_name, email, password_hash, role, is_teebo_admin, active, must_change_password FROM app_user WHERE lower(email) = $1',
        [email]);
      const user = r.rows[0];
      if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'identifiants_invalides' });
      }
      const { roles, permissions } = await buildClaims(q, user);
      const mcp = !!user.must_change_password;
      const claims = { sub: user.id, imf_id: user.imf_id, roles, permissions, mcp };
      return res.json({
        token: signToken(claims),
        user: { id: user.id, full_name: user.full_name, imf_id: user.imf_id, roles, permissions, must_change_password: mcp }
      });
    } catch (e) { return res.status(500).json({ error: 'erreur_base', detail: e.message }); }
  };
}
