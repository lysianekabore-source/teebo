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
 * Vérifie un code saisi par l'utilisateur, avec une tolérance de ±2 périodes
 * (±60 s) pour absorber la dérive d'horloge courante entre le téléphone de
 * l'utilisateur et le serveur. Renvoie { ok, offset, counter }.
 */
export function verifyTotp(secretBase32, code, atMs = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, offset: null, counter: null };
  const counter = Math.floor(atMs / 1000 / 30);
  for (const off of [0, -1, 1, -2, 2]) {
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
 * Port autonome et vérifié de « QR Code generator » de Nayuki (domaine public).
 * Mode octet, versions 1 à 40, niveau de correction d'erreur M, sélection
 * automatique du masque. Rendu SVG encodé en data URL :
 *   data:image/svg+xml;base64,…
 * Compatible CSP « img-src 'self' data: ».
 * ========================================================================== */

// Niveau de correction d'erreur M -> bits de format = 0b00.
const ECL_FORMAT_BITS = 0;
const QR_MIN_VERSION = 1;
const QR_MAX_VERSION = 40;
const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

// Codewords de correction d'erreur par bloc (niveau M), index = version 1..40.
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
  26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28
];
// Nombre de blocs de correction d'erreur (niveau M), index = version 1..40.
const NUM_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
  18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49
];

function qrGetBit(x, i) { return ((x >>> i) & 1) !== 0; }

// ---- Reed-Solomon sur GF(256), polynôme primitif 0x11D ----
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsComputeDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
  }
  return result;
}

// ---- Dimensionnement ----
function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver) {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver];
}

function getAlignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = (ver === 32) ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Matrice QR ----
class QrMatrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (let i = 0; i < this.size; i++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawVersionInfo() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = qrGetBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  }

  drawFormatBits(mask) {
    const data = (ECL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, qrGetBit(bits, i));
    this.setFunctionModule(8, 7, qrGetBit(bits, 6));
    this.setFunctionModule(8, 8, qrGetBit(bits, 7));
    this.setFunctionModule(7, 8, qrGetBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, qrGetBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, qrGetBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, qrGetBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);
  }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const alignPos = getAlignmentPatternPositions(this.version);
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersionInfo();
  }

  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = qrGetBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: invert = false;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 &&
      runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
           (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  finderPenaltyAddHistory(currentRunLength, runHistory) {
    if (runHistory[0] === 0) currentRunLength += this.size;
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }

  finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  getPenaltyScore() {
    let result = 0;
    const size = this.size;
    const m = this.modules;
    for (let y = 0; y < size; y++) {
      let runColor = false, runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (m[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = m[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false, runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (m[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = m[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = m[y][x];
        if (color === m[y][x + 1] && color === m[y + 1][x] && color === m[y + 1][x + 1])
          result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }
}

// ---- Construction + rendu ----
function buildQrMatrix(text) {
  const data = Array.from(Buffer.from(String(text), 'utf8'));
  let version = QR_MIN_VERSION;
  for (;; version++) {
    const capacity = getNumDataCodewords(version) * 8;
    const ccBits = version <= 9 ? 8 : 16;
    const usedBits = 4 + ccBits + 8 * data.length;
    if (usedBits <= capacity) break;
    if (version >= QR_MAX_VERSION) throw new Error('Données trop longues pour un QR code');
  }

  const bb = [];
  const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
  const ccBits = version <= 9 ? 8 : 16;
  append(0x4, 4);
  append(data.length, ccBits);
  for (const b of data) append(b, 8);

  const capacityBits = getNumDataCodewords(version) * 8;
  append(0, Math.min(4, capacityBits - bb.length));
  while (bb.length % 8 !== 0) bb.push(0);
  for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const dataCodewords = [];
  for (let i = 0; i < bb.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bb[i + j];
    dataCodewords.push(b);
  }

  // Correction d'erreur Reed-Solomon + entrelacement des blocs
  const numBlocks = NUM_BLOCKS_M[version];
  const blockEccLen = ECC_PER_BLOCK_M[version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const rsDiv = rsComputeDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCodewords.slice(k, k + datLen);
    k += datLen;
    const ecc = rsComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const allCodewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks)
        allCodewords.push(blocks[j][i]);
    }
  }

  const qr = new QrMatrix(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(allCodewords);

  let bestMask = 0, minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.getPenaltyScore();
    if (penalty < minPenalty) { minPenalty = penalty; bestMask = mask; }
    qr.applyMask(mask);
  }
  qr.applyMask(bestMask);
  qr.drawFormatBits(bestMask);
  return qr;
}

/**
 * Renvoie une data URL SVG contenant le QR code de `text`.
 * Aucun appel réseau : l'image peut être affichée hors-ligne.
 */
export function qrDataUrl(text) {
  const qr = buildQrMatrix(String(text));
  const size = qr.size;
  const quiet = 4;
  const dim = size + quiet * 2;
  let rects = '';
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (qr.modules[y][x]) rects += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
    '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
    '<path d="' + rects + '" fill="#000000"/></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
