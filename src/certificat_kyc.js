// ===========================================================================
// teebo — CERTIFICAT DE DILIGENCE KYC/KYB & DE VISITE TERRAIN
// ---------------------------------------------------------------------------
// Document officiel A4 remis au client (ou au régulateur) : il réunit en une
// seule pièce ce que l'IMF a RÉELLEMENT vérifié, et le rend vérifiable :
//
//   1. En-tête officiel : identité + mentions légales de l'IMF (logo, RCCM,
//      IFU, agrément BCEAO) et référence unique CERT-AAAA-NNNN.
//   2. Identification KYC : état civil, pièce d'identité et validité,
//      criblage PPE / sanctions, score et niveau de risque LBC-FT.
//   3. Volet KYB (personnes morales uniquement) : RCCM, bénéficiaires
//      effectifs, mandataires signataires.
//   4. Preuve de terrain : position GPS certifiée, précision, écart avec le
//      domicile, repères visuels, observations et rapport de l'agent.
//   5. Photos horodatées, double signature, QR code de vérification et
//      empreinte SHA-256 en pied de page.
//
// PRINCIPE DE VÉRITÉ : aucune donnée n'est inventée ni arrondie en faveur du
// dossier. Tout provient de la base (client, kyc_evaluations, kyb_*,
// visites_terrain_kyc, imf, imf_branding). Un champ absent s'affiche « — ».
//
// EMPREINTE : SHA-256 de « clientId|lat|lng|visiteId|horodatage de
// validation ». Elle est inscrite en pied de document ET encodée dans le QR
// code : re-calculer l'empreinte à partir du dossier doit redonner la même
// valeur, sinon le document a été modifié.
//
// Le PDF est produit comme les autres documents officiels teebo : page HTML
// autonome (styles en ligne, imprimable en A4), le navigateur assure
// l'impression / l'enregistrement en PDF. Aucun moteur PDF lourd n'est requis
// sur Render (offre gratuite).
// ===========================================================================
import crypto from 'crypto';
import QRCode from 'qrcode';

/* -------------------------------------------------------------------------
 * 1. OUTILS PURS (testables sans base de données)
 * ---------------------------------------------------------------------- */

/** Échappement HTML systématique : aucune donnée client ne sort brute. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Valeur affichée : jamais de « null » ni « undefined » sur un document officiel. */
export function aff(v) {
  if (v == null) return '—';
  const s = String(v).trim();
  return s ? esc(s) : '—';
}

/**
 * Horodatage ISO normalisé à la seconde : deux générations du même certificat
 * à la même seconde produisent la même empreinte (utile pour la vérification),
 * et les millisecondes ne polluent pas l'empreinte.
 */
export function horodatage(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Coordonnée GPS à 6 décimales (précision ~11 cm), format stable pour l'empreinte. */
export function coord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(6);
}

/**
 * Chaîne canonique de l'empreinte. L'ordre des champs est FIXE : le changer
 * invaliderait tous les certificats déjà émis.
 */
export function chaineEmpreinte({ client_id, lat, lng, visite_id, valide_le }) {
  return [String(client_id || ''), coord(lat), coord(lng), String(visite_id || ''),
    horodatage(valide_le)].join('|');
}

/** SHA-256 en hexadécimal minuscule. */
export function sha256(texte) {
  return crypto.createHash('sha256').update(String(texte), 'utf8').digest('hex');
}

/** Empreinte du certificat (64 caractères hexadécimaux). */
export function empreinteCertificat(d) {
  return sha256(chaineEmpreinte(d));
}

/** Forme abrégée lisible : 4 groupes de 4 caractères (affichage seulement). */
export function empreinteCourt(h) {
  const s = String(h || '').toUpperCase();
  // 4 groupes de 4 caracteres, lisibles a voix haute au telephone.
  const groupes = [];
  for (let i = 0; i < 16 && i < s.length; i += 4) groupes.push(s.slice(i, i + 4));
  return groupes.join('-');
}

/**
 * Référence officielle « CERT-AAAA-NNNN ». Le numéro de séquence est fourni
 * par la base (compteur par IMF et par année) ; on ne l'invente jamais.
 */
export function formaterReference(annee, sequence) {
  const n = Math.max(0, Math.floor(Number(sequence) || 0));
  return 'CERT-' + String(annee) + '-' + String(n).padStart(4, '0');
}

/** Valide une référence au format attendu (utilisé au contrôle de cohérence). */
export function referenceValide(ref) {
  return /^CERT-\d{4}-\d{4,6}$/.test(String(ref || ''));
}

/**
 * Règle de disponibilité du certificat — reproduite à l'identique côté site.
 * Le certificat n'a de valeur que s'il s'appuie sur une visite de terrain
 * GÉOLOCALISÉE et SYNCHRONISÉE (statut conforme). Sinon, on explique pourquoi.
 */
export function disponibilite({ visite, parametres } = {}) {
  const p = parametres || {};
  const validiteJours = Number(p.validite_visite_jours || 365);
  if (!visite) {
    return {
      disponible: false, motif: 'AUCUNE_VISITE',
      message: "Aucune visite de terrain géolocalisée n'est synchronisée pour ce client. "
        + "Le certificat de diligence ne peut pas être établi sans preuve de terrain."
    };
  }
  if (String(visite.statut || '') !== 'ACTIF_CONFORME') {
    return {
      disponible: false, motif: 'VISITE_NON_CONFORME',
      message: "La dernière visite de terrain n'est pas conforme : le certificat ne peut pas être établi. "
        + 'Programmez une contre-visite.'
    };
  }
  if (visite.synchronise_le == null) {
    return {
      disponible: false, motif: 'VISITE_NON_SYNCHRONISEE',
      message: "La visite de terrain est encore sur le téléphone de l'agent : synchronisez-la "
        + 'avant de générer le certificat.'
    };
  }
  if (visite.gps_lat == null || visite.gps_lng == null) {
    return {
      disponible: false, motif: 'GPS_MANQUANT',
      message: 'La visite ne comporte aucune position GPS certifiée : le certificat ne peut pas être établi.'
    };
  }
  const jours = joursDepuis(visite.visite_le);
  if (jours != null && jours > validiteJours) {
    return {
      disponible: false, motif: 'VISITE_PERIMEE',
      message: 'La visite de terrain date de ' + jours + ' jours (validité : ' + validiteJours
        + ' jours). Une nouvelle visite est nécessaire.'
    };
  }
  return { disponible: true, motif: null, message: '', jours };
}

/** Nombre de jours entiers écoulés depuis une date (null si date absente). */
export function joursDepuis(d) {
  if (!d) return null;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/** Couleur d'état des badges (le vert n'est jamais décoratif). */
function classeEtat(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'ACTIF_CONFORME' || u === 'CONFORME' || u === 'CLAIR' || u === 'AUCUN') return 'ok';
  if (u === 'EXPIRE' || u === 'NON_CONFORME' || u === 'CONFIRME' || u === 'SUSPECT') return 'err';
  return 'warn';
}

function dateFr(d) {
  if (!d) return '—';
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  if (isNaN(t)) return '—';
  return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function dateHeureFr(d) {
  if (!d) return '—';
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  if (isNaN(t)) return '—';
  return new Date(t).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Lecture défensive de photos_json (JSONB ou chaîne). On ne garde que les
 * entrées réellement image (data-URL ou http), jamais une URL exotique.
 */
export function photosDe(v) {
  let liste = v;
  if (typeof liste === 'string') {
    try { liste = JSON.parse(liste); } catch (e) { liste = []; }
  }
  if (!Array.isArray(liste)) return [];
  return liste.map((p) => p || {}).filter((p) => {
    const u = String(p.url || '');
    return /^data:image\/(png|jpe?g|webp);base64,/i.test(u) || /^https?:\/\//i.test(u);
  }).slice(0, 6);
}

/** Projection Web Mercator -> tuile OpenStreetMap (sans dépendance). */
export function tuileOSM(lat, lng, zoom = 15) {
  // Sans coordonnee valide il n'y a pas de tuile : on renvoie null (le document
  // affichera alors le seul releve GPS, jamais un fond de plan trompeur).
  const LAT = Number(lat);
  const LNG = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(LAT) || !Number.isFinite(LNG)) return null;
  if (LAT < -85 || LAT > 85 || LNG < -180 || LNG > 180) return null;
  const z = Math.max(0, Math.min(19, Math.round(zoom)));
  const n = Math.pow(2, z);
  const latR = Number(lat) * Math.PI / 180;
  const x = Math.floor((Number(lng) + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Adresse de la tuile de fond de plan. Le serveur la TÉLÉCHARGE et l'embarque
 * (data-URL) : le document reste imprimable hors ligne et aucune position du
 * client n'est transmise au navigateur du destinataire.
 */
export function urlTuile(lat, lng, zoom = 15) {
  const t = tuileOSM(lat, lng, zoom);
  if (!t) return '';
  return 'https://tile.openstreetmap.org/' + t.z + '/' + t.x + '/' + t.y + '.png';
}

/**
 * Récupère la tuile de plan et la renvoie en data-URL (null en cas d'échec :
 * le document s'affiche alors avec le seul schéma GPS, sans image cassée).
 */
export async function tuileDataUrl(lat, lng, zoom = 15, timeoutMs = 4500) {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  try {
    const ctrl = new AbortController();
    const minuterie = setTimeout(() => ctrl.abort(), timeoutMs);
    const rep = await fetch(urlTuile(lat, lng, zoom), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'teebo-certificat/1.0 (documents officiels IMF)' }
    });
    clearTimeout(minuterie);
    if (!rep.ok) return null;
    const buf = Buffer.from(await rep.arrayBuffer());
    if (!buf.length || buf.length > 400000) return null;
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * 2. QR CODE (image PNG embarquée, jamais un service externe)
 * ---------------------------------------------------------------------- */

/** Génère le QR code d'une adresse de vérification, en PNG data-URL. */
export async function qrDataUrl(contenu, { taille = 360 } = {}) {
  const png = await QRCode.toBuffer(String(contenu || 'teebo'), {
    type: 'png', width: taille, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#0b0c26ff', light: '#ffffffff' }
  });
  return 'data:image/png;base64,' + png.toString('base64');
}

/* -------------------------------------------------------------------------
 * 3. RENDU DU DOCUMENT (A4, autonome, imprimable)
 * ---------------------------------------------------------------------- */

function css() {
  return `
  :root{--navy:#0b0c26;--neon:#d8f500;--muted:#61647c;--line:#e3e5ee;--soft:#f6f7fb;--ok:#3d5c00;--warn:#8a6d00;--err:#a11b1b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:var(--navy);background:#eef0f6;padding:20px;-webkit-font-smoothing:antialiased}
  .sheet{max-width:210mm;margin:0 auto;background:#fff;box-shadow:0 12px 40px rgba(11,12,38,.12)}
  .doc{padding:14mm 14mm 10mm;display:flex;flex-direction:column;min-height:297mm;background:#fff}
  .corps{flex:1 1 auto}
  .pied-page{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);break-inside:avoid}
  .barre{display:flex;justify-content:flex-end;gap:10px;max-width:210mm;margin:0 auto 12px}
  .barre button{font-family:inherit;font-size:13px;font-weight:700;border-radius:9px;padding:10px 16px;border:1px solid #d4d6e2;background:#fff;color:var(--navy);cursor:pointer}
  .barre button.p{background:var(--navy);color:#fff;border-color:var(--navy)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:12px;border-bottom:3px solid var(--navy)}
  .org{display:flex;gap:12px;align-items:center;min-width:0}
  .logo{width:62px;height:62px;object-fit:contain;border-radius:8px;flex:none}
  .logo-ph{width:62px;height:62px;border-radius:8px;background:var(--navy);color:var(--neon);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;flex:none}
  .org h1{font-size:16px;letter-spacing:-.3px;line-height:1.25}
  .org .meta{font-size:10.5px;color:var(--muted);line-height:1.5;margin-top:3px}
  .ref{text-align:right;font-size:10.5px;color:var(--muted);line-height:1.6;flex:none}
  .ref b{display:block;font-size:14px;color:var(--navy);letter-spacing:.5px}
  .ref .stamp{display:inline-block;margin-top:4px;font-size:9.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;background:#eef7d6;color:var(--ok);border:1px solid #d5e9a8;border-radius:999px;padding:3px 9px}
  h2.titre{margin:16px 0 3px;font-size:15px;text-transform:uppercase;letter-spacing:.4px}
  h2.titre small{display:block;font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);margin-top:3px}
  h3.sec{font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--navy);margin:16px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--line)}
  h3.sec span{float:right;font-size:9.5px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--muted)}
  .grille{display:grid;grid-template-columns:1fr 1fr;gap:0 22px;font-size:11.5px}
  .grille div{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px dotted var(--line)}
  .grille span{color:var(--muted);flex:none}
  .head,h2.titre,h3.sec,.terrain,.sign,.pied,.obs,.photo,.cadre{break-inside:avoid}
  .grille div{break-inside:avoid}
  table{break-inside:auto}
  tr{break-inside:avoid}
  .grille b{text-align:right;font-weight:600;word-break:break-word}
  table{width:100%;border-collapse:collapse;margin-top:4px;font-size:10.5px}
  th{background:var(--navy);color:#fff;text-align:left;padding:6px 8px;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px}
  td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:nth-child(even) td{background:var(--soft)}
  .r{text-align:right}
  .badge{display:inline-block;border-radius:999px;font-size:9.5px;font-weight:700;padding:2px 8px;border:1px solid}
  .badge.ok{background:#eef7d6;color:var(--ok);border-color:#d5e9a8}
  .badge.warn{background:#fff7d6;color:var(--warn);border-color:#f0e2a0}
  .badge.err{background:#fdeaea;color:var(--err);border-color:#f5c2c2}
  .terrain{display:grid;grid-template-columns:88mm 1fr;gap:10px;align-items:start}
  .carte{border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--soft)}
  .carte img{display:block;width:100%;height:auto}
  .carte .vide{padding:26px 10px;text-align:center;font-size:10px;color:var(--muted);line-height:1.5}
  .carte .leg{padding:4px 7px;font-size:8.5px;color:var(--muted);border-top:1px solid var(--line);background:#fff}
  .obs{margin-top:8px;padding:8px 10px;background:var(--soft);border:1px solid var(--line);border-radius:6px;font-size:10.5px;line-height:1.6;color:#2a2d45}
  .obs b{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:3px}
  .photos{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:6px}
  .photo{border:1px solid var(--line);border-radius:5px;overflow:hidden;background:#fff}
  .photo img{display:block;width:100%;height:30mm;object-fit:cover}
  .photo figcaption{font-size:8px;color:var(--muted);padding:3px 4px;line-height:1.35;border-top:1px solid var(--line)}
  .sign{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px;page-break-inside:avoid}
  .sign .cadre{border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-height:26mm;font-size:9.5px;color:var(--muted);line-height:1.5}
  .sign .cadre b{display:block;color:var(--navy);font-size:10px;margin-bottom:2px}
  .sign .cadre .trait{margin-top:14mm;border-top:1px dotted #9aa0b8;padding-top:3px;font-size:8.5px}
  .qr-cadre{text-align:center}
  .qr-cadre img{width:24mm;height:24mm;display:block;margin:0 auto 3px}
  .pied{margin-top:14px;padding-top:8px;border-top:1px solid var(--line);font-size:8.5px;color:var(--muted);line-height:1.55;word-break:break-all}
  .pied .hash{font-family:'Courier New',monospace;font-size:9px;color:var(--navy);letter-spacing:.4px}
  .mentions{margin-top:8px;font-size:8.5px;color:var(--muted);line-height:1.5;text-align:justify}
  @media print{body{background:#fff;padding:0}.barre{display:none}.sheet{box-shadow:none;max-width:none}
  /* le document occupe la hauteur exacte de la feuille : le pied de page reste en bas */
  .doc{padding:0;min-height:calc(297mm - 24mm)}
  @page{size:A4;margin:12mm}}
  `;
}

/** Bloc « en-tête officiel » : IMF + référence + estampille. */
function entete(imf, reference, genereLe) {
  const logo = imf.logo_data_url
    ? '<img class="logo" src="' + esc(imf.logo_data_url) + '" alt="Logo de l’institution">'
    : '<div class="logo-ph">' + esc(String(imf.sigle || imf.legal_name || 'IMF').slice(0, 3).toUpperCase()) + '</div>';
  const mentions = [
    imf.legal_form ? 'Forme juridique : ' + esc(imf.legal_form) : '',
    imf.trade_register_no ? 'RCCM : ' + esc(imf.trade_register_no) : '',
    imf.tax_id ? 'IFU / NIF : ' + esc(imf.tax_id) : '',
    imf.bceao_agreement_no ? 'Agrément BCEAO n° ' + esc(imf.bceao_agreement_no) : ''
  ].filter(Boolean).join(' · ');
  return `
  <div class="head">
    <div class="org">${logo}
      <div>
        <h1>${aff(imf.legal_name || imf.name)}</h1>
        <div class="meta">${mentions || '&nbsp;'}<br>
        ${aff(imf.legal_address)}${imf.phone_main ? ' · Tél. ' + esc(imf.phone_main) : ''}${imf.email ? ' · ' + esc(imf.email) : ''}</div>
      </div>
    </div>
    <div class="ref">
      <b>${esc(reference)}</b>
      Émis le ${esc(dateHeureFr(genereLe))}
      <div><span class="stamp">Document officiel</span></div>
      <div style="margin-top:6px;font-size:9px">Certificat n° 1/1 · page 1</div>
    </div>
  </div>`;
}

/** Bloc 2 : identification KYC + criblage. */
function blocKyc(d) {
  const c = d.client || {};
  const ev = d.evaluation || {};
  const criblage = d.criblage || {};
  const expire = c.piece_expire_le ? new Date(c.piece_expire_le) : null;
  const joursValidite = expire ? Math.round((expire.getTime() - Date.now()) / 86400000) : null;
  const pieceEtat = joursValidite == null ? 'Validity non renseignée'
    : joursValidite < 0 ? '<span class="badge err">Échue depuis ' + Math.abs(joursValidite) + ' j</span>'
      : joursValidite <= 30 ? '<span class="badge warn">Expire dans ' + joursValidite + ' j</span>'
        : '<span class="badge ok">Valide jusqu’au ' + dateFr(expire) + '</span>';

  const ppe = c.ppe === true
    ? '<span class="badge err">PPE' + (c.ppe_fonction ? ' — ' + esc(c.ppe_fonction) : '') + '</span>'
    : '<span class="badge ok">Non PPE</span>';
  const verdict = String(criblage.verdict || 'AUCUN').toUpperCase();
  const sanctions = verdict === 'CONFIRME'
    ? '<span class="badge err">Correspondance confirmée</span>'
    : verdict === 'SUSPECT' || verdict === 'A_VERIFIER'
      ? '<span class="badge warn">À vérifier (' + (criblage.meilleur_score != null ? Math.round(Number(criblage.meilleur_score)) + ' %' : '—') + ')</span>'
      : criblage.date
        ? '<span class="badge ok">Aucune correspondance</span>'
        : '<span class="badge warn">Criblage non tracé</span>';

  return `
  <h3 class="sec">2. Identification et vérification KYC (personne physique)<span>Instruction BCEAO n°003-03-2025</span></h3>
  <div class="grille">
    <div><span>Nom et prénoms</span><b>${aff(c.full_name)}</b></div>
    <div><span>Code client</span><b>${aff(c.code_client)}</b></div>
    <div><span>Date de naissance</span><b>${c.birth_date ? esc(dateFr(c.birth_date)) : '—'}</b></div>
    <div><span>Lieu de naissance</span><b>${aff(c.lieu_naissance)}</b></div>
    <div><span>Nationalité</span><b>${aff(c.nationalite)}</b></div>
    <div><span>Profession / activité</span><b>${aff(c.profession || c.secteur_activite)}</b></div>
    <div><span>Type de pièce</span><b>${aff(c.type_piece)}</b></div>
    <div><span>Numéro de pièce</span><b>${aff(c.id_doc_number || c.id_number)}</b></div>
    <div><span>Validité de la pièce</span><b>${pieceEtat}</b></div>
    <div><span>Statut KYC</span><b><span class="badge ${classeEtat(c.statut_kyc)}">${aff(c.statut_kyc || 'NON ÉVALUÉ')}</span></b></div>
    <div><span>Score KYC</span><b>${c.kyc_score == null ? '—' : esc(String(c.kyc_score)) + ' / 100'}</b></div>
    <div><span>Niveau de risque LBC-FT</span><b><span class="badge ${classeEtat(c.niveau_risque_lbc === 'ELEVE' ? 'SUSPECT' : c.niveau_risque_lbc)}">${aff(c.niveau_risque_lbc)}</span></b></div>
    <div><span>Dernière validation</span><b>${c.kyc_valide_le ? esc(dateHeureFr(c.kyc_valide_le)) : '—'}</b></div>
    <div><span>Prochaine revue</span><b>${c.kyc_prochaine_revue_le ? esc(dateFr(c.kyc_prochaine_revue_le)) : '—'}</b></div>
    <div><span>Criblage PPE</span><b>${ppe}</b></div>
    <div><span>Criblage sanctions / gel</span><b>${sanctions}</b></div>
  </div>
  ${ev.statut ? '<p class="mentions">Dernière évaluation enregistrée le ' + esc(dateHeureFr(ev.cree_le))
    + ' — décision : <b>' + esc(ev.statut) + '</b>, risque <b>' + esc(ev.niveau_risque_lbc || '—') + '</b>'
    + (ev.decide_par ? ', agent : ' + esc(ev.decide_par) : '') + '.</p>' : ''}`;
}

/** Bloc 3 : volet KYB (personnes morales uniquement). */
function blocKyb(d) {
  const e = d.entite;
  if (!e) return '';
  const be = d.beneficiaires || [];
  const mand = d.mandataires || [];
  const capital = e.capital_social_cents == null ? '—'
    : (Number(e.capital_social_cents) / 100).toLocaleString('fr-FR') + ' FCFA';
  return `
  <h3 class="sec">3. Volet KYB — personne morale<span>Bénéficiaires effectifs et mandataires</span></h3>
  <div class="grille">
    <div><span>Raison sociale</span><b>${aff(e.raison_sociale)}</b></div>
    <div><span>Forme juridique</span><b>${aff(e.forme_juridique)}</b></div>
    <div><span>RCCM</span><b>${aff(e.rccm)}</b></div>
    <div><span>Compte contribuable</span><b>${aff(e.compte_contribuable)}</b></div>
    <div><span>Siège social</span><b>${aff(e.siege_adresse)}</b></div>
    <div><span>Capital social</span><b>${esc(capital)}</b></div>
    <div><span>Activité principale</span><b>${aff(e.activite_principale)}</b></div>
    <div><span>Statut KYB</span><b><span class="badge ${classeEtat(e.statut_kyb)}">${aff(e.statut_kyb)}</span></b></div>
    <div><span>Score KYB</span><b>${e.score_kyb == null ? '—' : esc(String(e.score_kyb)) + ' / 100'}</b></div>
    <div><span>Niveau de risque</span><b><span class="badge ${classeEtat(e.niveau_risque_lbc === 'ELEVE' ? 'SUSPECT' : e.niveau_risque_lbc)}">${aff(e.niveau_risque_lbc)}</span></b></div>
  </div>
  <table>
    <thead><tr><th>Bénéficiaire effectif</th><th class="r">Détention</th><th>PPE</th><th>Criblage</th></tr></thead>
    <tbody>${be.length ? be.map((b) => '<tr><td>' + aff(b.nom_complet) + (b.nationalite ? ' <small>(' + esc(b.nationalite) + ')</small>' : '') + '</td>'
      + '<td class="r">' + (b.detention_pct == null ? '—' : esc(String(b.detention_pct).replace('.', ',')) + ' %') + '</td>'
      + '<td>' + (b.est_ppe ? '<span class="badge err">Oui</span>' : 'Non') + '</td>'
      + '<td><span class="badge ' + classeEtat(b.criblage_statut === 'A_FAIRE' ? 'A_VERIFIER' : b.criblage_statut) + '">' + aff(b.criblage_statut) + '</span></td></tr>').join('')
      : '<tr><td colspan="4">Aucun bénéficiaire effectif déclaré à ce jour.</td></tr>'}</tbody>
  </table>
  <table>
    <thead><tr><th>Mandataire signataire</th><th>Fonction</th><th>Pouvoir</th><th>Criblage</th></tr></thead>
    <tbody>${mand.length ? mand.map((m) => '<tr><td>' + aff(m.nom_complet) + '</td><td>' + aff(m.fonction) + '</td><td>' + aff(m.pouvoir_ref) + '</td>'
      + '<td><span class="badge ' + classeEtat(m.criblage_statut === 'A_FAIRE' ? 'A_VERIFIER' : m.criblage_statut) + '">' + aff(m.criblage_statut) + '</span></td></tr>').join('')
      : '<tr><td colspan="4">Aucun mandataire enregistré.</td></tr>'}</tbody>
  </table>`;
}

/** Bloc 4 : preuve de terrain (GPS + fond de plan + rapport de l'agent). */
function blocTerrain(d) {
  const v = d.visite || {};
  const mois = v.photos ? v.photos : [];
  const precision = v.gps_precision_m == null ? '—' : Math.round(Number(v.gps_precision_m)) + ' m';
  const distance = v.distance_m == null ? '—' : Math.round(Number(v.distance_m)) + ' m';
  const alertes = [
    v.gps_alerte_precision ? '<span class="badge warn">Précision GPS insuffisante</span>' : '',
    v.distance_alerte ? '<span class="badge warn">Écart important avec le domicile déclaré</span>' : ''
  ].filter(Boolean).join(' ');

  const carte = d.tuile
    ? '<img src="' + esc(d.tuile) + '" alt="Fond de plan OpenStreetMap centré sur la position relevée">'
    : '<div class="vide">Fond de plan indisponible hors connexion.<br>La position certifiée ci-contre fait foi.</div>';

  return `
  <h3 class="sec">4. Preuve de visite de terrain<span>Position relevée par le capteur GPS de l’appareil de l’agent</span></h3>
  <div class="terrain">
    <div>
      <div class="grille" style="grid-template-columns:1fr">
        <div><span>Date et heure de la visite</span><b>${esc(dateHeureFr(v.visite_le))}</b></div>
        <div><span>Latitude</span><b>${v.gps_lat == null ? '—' : esc(coord(v.gps_lat))}</b></div>
        <div><span>Longitude</span><b>${v.gps_lng == null ? '—' : esc(coord(v.gps_lng))}</b></div>
        <div><span>Précision du relevé</span><b>${esc(precision)}</b></div>
        <div><span>Écart domicile déclaré</span><b>${esc(distance)}</b></div>
        <div><span>Source du relevé</span><b>${aff(v.gps_source)}</b></div>
        <div><span>Statut de la visite</span><b><span class="badge ${classeEtat(v.statut)}">${aff(v.statut)}</span></b></div>
        <div><span>Synchronisée le</span><b>${v.synchronise_le ? esc(dateHeureFr(v.synchronise_le)) : '—'}</b></div>
        <div><span>Agent visiteur</span><b>${aff(d.agent)}</b></div>
        <div><span>Référence de la visite</span><b>${aff(String(v.id || '').slice(0, 8).toUpperCase())}</b></div>
      </div>
      ${alertes ? '<p class="mentions">' + alertes + '</p>' : ''}
    </div>
    <div class="carte">${carte}<div class="leg">Fond de plan © OpenStreetMap — position relevée au point central du repère.</div></div>
  </div>
  <div class="obs"><b>Repères visuels constatés</b>${aff(v.reperes_visuels)}</div>
  <div class="obs"><b>Activité constatée sur place</b>${aff(v.activite_constatee)}${v.present === false ? ' — <b>Client absent lors de la visite</b>' : ''}</div>
  <div class="obs"><b>Rapport et observations de l’agent</b>${aff(v.observations)}</div>
  ${mois.length ? '<h3 class="sec" style="margin-top:12px">5. Photographies horodatées et géolocalisées<span>' + mois.length + ' pièce(s) jointe(s)</span></h3><div class="photos">'
    + mois.map((p, i) => '<figure class="photo"><img src="' + esc(p.url) + '" alt="Photo ' + (i + 1) + ' de la visite">'
      + '<figcaption>Photo ' + (i + 1)
      + (p.prise_le ? ' — ' + esc(dateHeureFr(p.prise_le)) : '')
      + (p.lat != null && p.lng != null ? '<br>' + esc(coord(p.lat)) + ', ' + esc(coord(p.lng)) : '')
      + (p.legende ? '<br>' + aff(p.legende) : '') + '</figcaption></figure>').join('') + '</div>'
    : '<h3 class="sec" style="margin-top:12px">5. Photographies horodatées<span>Aucune photo jointe</span></h3><p class="mentions">Aucune photographie n’a été jointe à cette visite.</p>'}`;
}

/** Mentions légales de pied de document (toujours sur la dernière page). */
function mentionsLegales(d) {
  return `<p class="mentions" style="margin-top:0">
    Ce certificat atteste des vérifications effectivement réalisées par l’institution dans son dossier de
    connaissance du client (KYC/KYB) et lors de sa visite de terrain, à la date indiquée. Il ne constitue ni une
    garantie de solvabilité, ni une autorisation d’opération : toute décision de crédit reste soumise aux
    procédures internes et à la réglementation en vigueur. Toute modification du document invalide l’empreinte
    SHA-256 ci-dessus ; l’authenticité se vérifie par le QR code ou en recalculant cette empreinte.
  </p>${d.footer_note ? '<p class="mentions">' + esc(d.footer_note) + '</p>' : ''}`;
}

/** Bloc 6 : signatures, QR de vérification, empreinte et mentions. */
function blocSignature(d) {
  const v = d.visite || {};
  return `
  <h3 class="sec">6. Signatures et vérification</h3>
  <div class="sign">
    <div class="cadre">
      <b>Agent de terrain</b>
      ${aff(d.agent)}
      <div class="trait">Signature et date</div>
    </div>
    <div class="cadre">
      <b>Responsable Conformité</b>
      ${aff(d.validateur || 'Fonction à désigner par l’institution')}
      <div class="trait">Nom, signature et cachet</div>
    </div>
    <div class="cadre qr-cadre">
      <b>Vérification du certificat</b>
      ${d.qr ? '<img src="' + esc(d.qr) + '" alt="QR code de vérification du certificat">' : ''}
      <span style="font-size:8px;line-height:1.3;display:block">Scannez pour vérifier<br>l’authenticité en ligne</span>
    </div>
  </div>
  <div class="pied">
    <b>Empreinte d’intégrité SHA-256</b> (client | latitude | longitude | visite | horodatage de validation)<br>
    <span class="hash">${esc(empreinteCourt(d.empreinte))} · ${esc(d.empreinte)}</span><br>
    Contrôle : <span class="hash">${esc(d.urlVerification)}</span>
  </div>
`;
}

/**
 * Assemble le document complet.
 * @param {object} d données préparées par le chargeur (voir chargerDossier).
 */
export function rendreCertificat(d) {
  const c = d.client || {};
  return page(esc(d.reference) + ' — Certificat de diligence KYC/KYB et de visite terrain', css(),
    '<div class="barre"><button type="button" class="p" id="btn-imprimer">Imprimer / Enregistrer en PDF</button>'
    + '<button type="button" id="btn-fermer">Fermer</button></div>'
    + '<div class="sheet"><div class="doc">'
    + '<div class="corps">'
    + entete(d.imf || {}, d.reference, d.genere_le)
    + '<h2 class="titre">Certificat de diligence KYC/KYB et de visite de terrain'
    + '<small>Délivré à ' + aff(c.full_name) + ' — pièce établie à partir du dossier de conformité de l’institution</small></h2>'
    + blocKyc(d)
    + blocKyb(d)
    + blocTerrain(d)
    + blocSignature(d)
    + '</div>'
    + '<footer class="pied-page">' + mentionsLegales(d) + '</footer>'
    + '</div></div>');
}

/**
 * Page PUBLIQUE de vérification d'un certificat (aucune donnée personnelle).
 * Elle dit seulement : authentique ou inconnu, la référence, la date d'émission
 * et la date de la visite — jamais un nom, un montant ou une position.
 */
export function rendrePageVerification({ trouve, certificat, imfNom, empreinte, annule, indisponible }) {
  const ok = !!trouve;
  const titre = ok ? 'Certificat authentique'
    : annule ? 'Certificat annulé'
    : indisponible ? 'Vérification momentanément indisponible' : 'Certificat inconnu';
  return page('Vérification d’un certificat teebo',
    css() + 'body{display:flex;align-items:center;justify-content:center;min-height:100vh}'
    + '.v{max-width:520px;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 14px 44px rgba(11,12,38,.12);text-align:center}'
    + '.v .ico{width:64px;height:64px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800}'
    + '.v .ico.ok{background:#eef7d6;color:#3d5c00}.v .ico.err{background:#fdeaea;color:#a11b1b}'
    + '.v h1{font-size:19px;margin-bottom:8px}.v p{font-size:13px;line-height:1.7;color:#3c3f57;margin-bottom:10px}'
    + '.v dl{text-align:left;font-size:12.5px;margin:16px 0;border-top:1px solid #e3e5ee}'
    + '.v dl div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e3e5ee}'
    + '.v dt{color:#61647c}.v dd{font-weight:600;text-align:right}'
    + '.v .mono{font-family:"Courier New",monospace;font-size:10px;word-break:break-all;color:#61647c}',
    '<div class="v">'
    + '<div class="ico ' + (ok ? 'ok' : 'err') + '">' + (ok ? '✓' : '?') + '</div>'
    + '<h1>' + titre + '</h1>'
    + (ok
      ? '<p>Ce certificat a bien été émis par l’institution ci-dessous et n’a pas été modifié depuis son émission.</p>'
        + '<dl>'
        + '<div><dt>Référence</dt><dd>' + esc(certificat.reference) + '</dd></div>'
        + '<div><dt>Institution émettrice</dt><dd>' + esc(imfNom || '—') + '</dd></div>'
        + '<div><dt>Date d’émission</dt><dd>' + esc(dateHeureFr(certificat.genere_le)) + '</dd></div>'
        + '<div><dt>Visite de terrain vérifiée</dt><dd>' + esc(dateFr(certificat.visite_le)) + '</dd></div>'
        + '<div><dt>Périmètre</dt><dd>KYC/KYB et visite de terrain</dd></div>'
        + '</dl>'
        + '<p style="font-size:11.5px">Par confidentialité, cette page ne divulgue aucune donnée personnelle. Seule l’institution émettrice peut fournir le document complet.</p>'
      : annule
        ? '<p>Ce certificat a été <b>annulé par l’institution émettrice</b>'
          + (imfNom ? ' (' + esc(imfNom) + ')' : '') + '. Le document papier ne doit plus être présenté comme valable : '
          + 'demandez la version en cours à l’institution.</p>'
        : indisponible
          ? '<p>La vérification ne peut pas aboutir pour le moment (service momentanément indisponible). '
            + 'Réessayez dans quelques minutes.</p>'
          : '<p>Aucun certificat ne correspond à ce lien. Vérifiez que le QR code a bien été scanné, '
            + 'ou demandez une copie à l’institution qui vous a remis le document.</p>')
    + '<p class="mono">' + esc(empreinte || '') + '</p>'
    + '<div class="barre" style="background:transparent;box-shadow:none;justify-content:center;margin-top:14px">'
    + '<button type="button" class="p" id="btn-imprimer">Imprimer cette vérification</button></div>'
    + '</div>');
}

/* -------------------------------------------------------------------------
 * 3 bis. PAGE AUTONOME — le script de la barre d'outils est embarqué dans le
 * document (le certificat s'imprime même si le serveur ne sert pas le .js, et
 * le fichier public reste la copie de référence).
 * ---------------------------------------------------------------------- */
const SCRIPT_PAGE = "/* ===========================================================================\n * teebo — VAGUE 42 : script de la page publique de vérification du certificat\n * de diligence KYC/KYB et de visite terrain.\n *\n * Rôle unique : deux boutons (Imprimer / Enregistrer en PDF, Fermer).\n * Aucune donnée n'est lue, envoyée ni stockée ici ; le document est rendu par\n * le serveur et n'appelle aucune API. Script EXTERNE (pas de code en ligne)\n * pour respecter la politique de sécurité du serveur.\n * =========================================================================== */\n(function () {\n  'use strict';\n\n  function imprimer() {\n    try { window.print(); }\n    catch (e) { /* rien à faire : l'utilisateur peut utiliser Ctrl+P */ }\n  }\n\n  function fermer() {\n    // Si l'onglet a été ouvert par le site teebo, on revient à la page\n    // précédente ; sinon on tente de fermer l'onglet.\n    if (window.history.length > 1) { window.history.back(); return; }\n    window.close();\n  }\n\n  function brancher() {\n    var b1 = document.getElementById('btn-imprimer');\n    var b2 = document.getElementById('btn-fermer');\n    if (b1) b1.addEventListener('click', imprimer);\n    if (b2) b2.addEventListener('click', fermer);\n    // Raccourci discret : la touche « p » du clavier imprime le certificat.\n    document.addEventListener('keydown', function (ev) {\n      if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'p') return; // laissé au navigateur\n    });\n  }\n\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', brancher);\n  } else {\n    brancher();\n  }\n})();\n";

/** Enveloppe HTML commune (certificat et page de vérification). */
function page(titre, styles, corps) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + titre + '</title><style>' + styles + '</style></head><body>'
    + corps + '<script>' + SCRIPT_PAGE + '</script></body></html>';
}

/* -------------------------------------------------------------------------
 * 4. MISSIVENESS
 * ---------------------------------------------------------------------- */
export default {
  esc, aff, horodatage, coord, chaineEmpreinte, sha256, empreinteCertificat,
  empreinteCourt, formaterReference, referenceValide, disponibilite, joursDepuis,
  photosDe, tuileOSM, urlTuile, tuileDataUrl, qrDataUrl, rendreCertificat,
  rendrePageVerification
};
