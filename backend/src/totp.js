import crypto from 'crypto';

/**
 * Implémentation TOTP (RFC 6238) autonome, sans dépendance externe.
 * Compatible avec les applications « authenticator » (Google Authenticator,
 * Authy, Microsoft Authenticator…) : HMAC-SHA1, 6 chiffres, période 30 s.
 *
 * Le module fournit AUSSI un générateur de QR code 100 % local (aucun appel
 * réseau) : l'image est produite en SVG puis encodée en data URL. Cela évite
 * toute dépendance à un service externe (indisponible hors-ligne et bloqué par
 * la politique de sécurité CSP stricte de teebo).
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
 * (dérive d'horloge). Renvoie { ok, offset, counter }.
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

/** URI otpauth://… pour l'application d'authentification. */
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

/* ==========================================================================
 * Générateur de QR code LOCAL (aucune dépendance réseau)
 * --------------------------------------------------------------------------
 * Implémentation QR « byte mode », version auto (1 à 10), niveau de correction
 * d'erreur M. Le rendu est un SVG minimal encodé en data URL :
 *   data:image/svg+xml;base64,…
 * Compatible CSP « img-src 'self' data: ».
 * ========================================================================== */

const EC_LEVEL_M = 0;
// Capacité en octets (mode byte, niveau M) par version : index 1..10.
const CAPACITY_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
// Nombre total de codewords (data + correction) par version : index 1..10.
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// Codewords de correction d'erreur (niveau M) par version : index 1..10.
const EC_CODEWORDS_M = [0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130];
// Nombre de blocs (niveau M) par version : index 1..10.
const EC_BLOCKS_M = [0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4];
// Position des centres de motifs d'alignement par version.
const ALIGN_POS = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

// ---- Galois field GF(256) pour la correction Reed-Solomon ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Polynôme générateur de Reed-Solomon de degré `degree`. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Calcule les `ecCount` codewords de correction pour un bloc de données. */
function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

/** Bit buffer d'écriture. */
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  toBytes() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      bytes.push(b);
    }
    return bytes;
  }
}

/** Construit la matrice de modules pour une chaîne donnée. Renvoie {size, get}. */
function buildMatrix(text) {
  const data = Array.from(Buffer.from(text, 'utf8'));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (data.length <= CAPACITY_M[v]) { version = v; break; }
  }
  if (!version) version = 10;

  const size = version * 4 + 17;
  const totalCw = TOTAL_CODEWORDS[version];
  const ecCw = EC_CODEWORDS_M[version];
  const blocks = EC_BLOCKS_M[version];
  const dataCw = totalCw - ecCw;

  // --- Flux de données : mode + longueur + charge utile + terminateur ---
  const bb = new BitBuffer();
  bb.put(0b0100, 4);                     // mode « byte »
  const lenBits = version <= 9 ? 8 : 16;
  bb.put(data.length, lenBits);
  for (const b of data) bb.put(b, 8);
  const maxBits = dataCw * 8;
  if (bb.bits.length > maxBits) bb.bits.length = maxBits;
  while (bb.bits.length < maxBits && (bb.bits.length % 8) !== 0) bb.bits.push(0);
  const padBytes = [0xEC, 0x11];
  let k = 0;
  while (bb.bits.length < maxBits) { bb.put(padBytes[k++ % 2], 8); }

  const dataBytes = bb.toBytes().slice(0, dataCw);

  // --- Répartition en blocs + correction ---
  const shortLen = Math.floor(dataCw / blocks);
  const numShort = blocks - (dataCw % blocks);
  const dataBlocks = [];
  const ecBlocks = [];
  let pos = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b < numShort ? 0 : 1);
    const blk = dataBytes.slice(pos, pos + len);
    pos += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecCw / blocks));
  }
  // Entrelacement final
  const finalCw = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) finalCw.push(b[i]);
  const maxEc = Math.max(...ecBlocks.map((b) => b.length));
  for (let i = 0; i < maxEc; i++) for (const b of ecBlocks) if (i < b.length) finalCw.push(b[i]);

  // --- Matrice des modules ---
  const mod = Array.from({ length: size }, () => new Array(size).fill(null));
  const setF = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) mod[r][c] = v; };

  // Motifs de repérage (3 coins) + séparateurs
  function finder(row, col) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setF(row + r, col + c, (inRing || inCore) ? 1 : 0);
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // Motifs d'alignement
  const aligns = ALIGN_POS[version];
  for (const r of aligns) for (const c of aligns) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      setF(r + dr, c + dc, ring === 2 || ring === 0 ? 1 : 0);
    }
  }

  // Motifs de synchronisation (timing)
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (mod[6][i] === null) setF(6, i, v);
    if (mod[i][6] === null) setF(i, 6, v);
  }

  // Réserve les zones de format/version + le module « dark »
  setF(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (mod[8][i] === null) setF(8, i, 0);
    if (mod[i][8] === null) setF(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (mod[8][size - 1 - i] === null) setF(8, size - 1 - i, 0);
    if (mod[size - 1 - i][8] === null) setF(size - 1 - i, 8, 0);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      if (mod[size - 11 + j][i] === null) setF(size - 11 + j, i, 0);
      if (mod[i][size - 11 + j] === null) setF(i, size - 11 + j, 0);
    }
  }

  // --- Placement des données (zigzag) ---
  const bits = [];
  for (const b of finalCw) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  let bi = 0, upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (mod[row][c] === null) {
          mod[row][c] = bits[bi++] !== undefined ? bits[bi - 1] : 0;
        }
      }
    }
    upward = !upward;
  }

  // --- Masquage (masque 0 : (r+c) % 2 === 0) + choix du meilleur masque ---
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];
  const isFunction = (r, c) => {
    if (mod[r][c] === null) return false;
    // Repère les modules de fonction par reconstruction rapide
    return functionMask(r, c, size, version, aligns);
  };

  let best = null;
  for (let m = 0; m < 8; m++) {
    const trial = mod.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!functionMask(r, c, size, version, aligns)) trial[r][c] ^= maskFns[m](r, c) ? 1 : 0;
    }
    writeFormat(trial, size, m, EC_LEVEL_M);
    if (version >= 7) writeVersion(trial, size, version);
    const score = penalty(trial, size);
    if (!best || score < best.score) best = { score, mod: trial };
  }
  void isFunction;
  return { size, mod: best.mod };
}

/** Vrai si (r,c) est un module de fonction (non masquable, non écrasable). */
function functionMask(r, c, size, version, aligns) {
  if (r === 6 || c === 6) return true;                       // timing
  if (r < 9 && c < 9) return true;                           // repère haut-gauche + format
  if (r < 9 && c >= size - 8) return true;                   // repère haut-droit + format
  if (r >= size - 8 && c < 9) return true;                   // repère bas-gauche + format
  if (r === size - 8 && c === 8) return true;                // module dark
  for (const ar of aligns) for (const ac of aligns) {
    if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  if (version >= 7) {
    if (r >= size - 11 && r <= size - 9 && c < 6) return true;
    if (c >= size - 11 && c <= size - 9 && r < 6) return true;
  }
  return false;
}

/** Écrit les 15 bits d'information de format (niveau + masque) + bits fixes. */
function writeFormat(mod, size, mask, ec) {
  const EC_BITS = { 0: 0b00, 1: 0b01, 2: 0b10, 3: 0b11 }; // L, M, Q, H
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const get = (i) => (bits >>> i) & 1;
  const set = (r, c, v) => { mod[r][c] = v; };
  // Copie 1 (autour du repère haut-gauche)
  for (let i = 0; i <= 5; i++) set(8, i, get(i));
  set(8, 7, get(6)); set(8, 8, get(7)); set(7, 8, get(8));
  for (let i = 9; i <= 14; i++) set(14 - i, 8, get(i));
  // Copie 2
  for (let i = 0; i <= 7; i++) set(size - 1 - i, 8, get(i));
  for (let i = 8; i <= 14; i++) set(8, size - 15 + i, get(i));
  set(size - 8, 8, 1);
}

/** Écrit les 18 bits d'information de version (versions ≥ 7). */
function writeVersion(mod, size, version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const b = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    mod[r][size - 11 + c] = b;
    mod[size - 11 + c][r] = b;
  }
}

/** Calcul des 4 pénalités standard pour choisir le meilleur masque. */
function penalty(mod, size) {
  let p = 0;
  // Règle 1 : séries de 5+ modules identiques
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (mod[r][c] === mod[r][c - 1]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (mod[r][c] === mod[r - 1][c]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  // Règle 2 : blocs 2x2 de même couleur
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = mod[r][c];
    if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) p += 3;
  }
  // Règle 4 : équilibre noir/blanc
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mod[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

/**
 * Renvoie une data URL SVG contenant le QR code de `text`.
 * Aucun appel réseau : l'image peut être affichée hors-ligne.
 */
export function qrDataUrl(text) {
  const { size, mod } = buildMatrix(String(text));
  const quiet = 3;
  const dim = size + quiet * 2;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (mod[r][c]) rects += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
    '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
    '<path d="' + rects + '" fill="#000000"/></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
