// teebo — Rattachement de la VRAIE session (mode production : USE_SESSION=1)
// ---------------------------------------------------------------------------
// Objectif : ne plus faire confiance aux en-têtes du client (x-imf-id, etc.).
// L'identité (user_id), l'imf_id et les rôles/permissions proviennent d'un jeton
// de session VÉRIFIÉ côté serveur. Ici : JWT HS256 signé avec SESSION_JWT_SECRET,
// vérifié avec le module 'crypto' natif (aucune dépendance supplémentaire).
//
// ➤ Dans teebo, remplacez `decodeToken` par votre vérification réelle
//   (votre lib JWT, votre store de session, votre fournisseur d'identité).
//   Le contrat attendu reste le même : { sub, imf_id, roles[], permissions[] }.
// ---------------------------------------------------------------------------
import crypto from 'crypto';

const SECRET = process.env.SESSION_JWT_SECRET || '';

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Vérifie un JWT HS256 et renvoie le payload, ou null si invalide/expiré.
export function decodeToken(token) {
  if (!token || !SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest();
  const got = b64urlToBuf(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(p).toString('utf8')); } catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// Middleware : attache req.session = { userId, imfId, roles, permissions }.
// Lit le jeton depuis Authorization: Bearer <jwt> (ou le cookie 'teebo_session').
export function attachSession(req, res, next) {
  let token = '';
  const h = req.get('Authorization') || '';
  if (h.startsWith('Bearer ')) token = h.slice(7);
  if (!token && req.headers.cookie) {
    const m = /(?:^|;\s*)teebo_session=([^;]+)/.exec(req.headers.cookie);
    if (m) token = decodeURIComponent(m[1]);
  }
  const payload = decodeToken(token);
  if (!payload) return res.status(401).json({ error: 'session_invalide' });
  req.session = {
    userId: payload.sub,
    imfId: payload.imf_id || null,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    mustChangePassword: !!payload.mcp
  };
  next();
}
