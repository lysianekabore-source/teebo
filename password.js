// teebo — Hachage de mot de passe avec scrypt (module 'crypto' natif).
// Aucune dépendance supplémentaire (ni bcrypt ni argon2).
// Format stocké en base : scrypt$<selHex>$<hashHex>
// ---------------------------------------------------------------------------
import crypto from 'crypto';

const N = 16384; // coût CPU/mémoire (2^14) — bon compromis serveur
const KEYLEN = 64;

// Produit la chaîne à stocker en base pour un mot de passe en clair.
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, { N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Vérifie un mot de passe en clair contre la chaîne stockée.
// Comparaison à temps constant pour éviter les attaques temporelles.
export function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let got;
  try { got = crypto.scryptSync(String(plain), salt, expected.length, { N }); }
  catch (e) { return false; }
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}
