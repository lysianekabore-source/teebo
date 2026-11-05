import crypto from 'crypto';

/**
 * Implémentation TOTP (RFC 6238) autonome, sans dépendance externe.
 * Compatible avec les applications « authenticator » (Google Authenticator,
 * Authy, Microsoft Authenticator…) : HMAC-SHA1, 6 chiffres, période 30 s.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Génère un secret aléatoire encodé en base32 (160 bits). */
export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  return base32Encode(buf);
}

/** Encodage base32 (RFC 4648, sans remplissage) utilisé par les authenticators. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Calcule le code TOTP pour un compteur (période) donné. */
function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
               (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/** Code courant (utile pour les tests et l'horloge serveur). */
export function totpNow(secretBase32, atMs = Date.now()) {
  return hotp(secretBase32, Math.floor(atMs / 1000 / 30));
}

/**
 * Vérifie un code saisi par l'utilisateur, avec une tolérance de ±1 période
 * (dérive d'horloge). Renvoie { ok, offset }.
 */
export function verifyTotp(secretBase32, code, atMs = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, offset: null, counter: null };
  const counter = Math.floor(atMs / 1000 / 30);
  for (const off of [0, -1, 1]) {
    if (hotp(secretBase32, counter + off) === c) return { ok: true, offset: off, counter: counter + off };
  }
  return { ok: false, offset: null, counter: null };
}

/** URI otpauth://… et lien QR (services publics) pour l'application authenticator. */
export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent((issuer ? issuer + ':' : '') + account);
  const params = new URLSearchParams({
    secret, issuer: issuer || 'teebo', algorithm: 'SHA1', digits: '6', period: '30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Codes de secours à usage unique (affichés une seule fois, stockés hachés). */
export function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5, 10));
  }
  return codes;
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}
