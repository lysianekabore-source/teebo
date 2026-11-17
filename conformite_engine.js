// ===========================================================================
// teebo — VAGUE 41 : MOTEUR DE CONFORMITE (LBC/FT/FP) — logique PURE
// ---------------------------------------------------------------------------
// Aucune base de données, aucun accès réseau : tout est calculé à partir des
// données qu'on lui donne. Un test peut donc vérifier chaque règle sans
// simuler PostgreSQL, et le serveur reste la seule source de vérité.
//
// Instructions couvertes :
//   • BCEAO — Instruction n°003-03-2025 du 18/03/2025 (connaissance du client,
//     révision périodique, personnes politiquement exposées) ;
//   • Loi uniforme LBC/FT/FP de l'UEMOA (bénéficiaires effectifs, criblage
//     des listes de sanctions, vigilance renforcée).
//
// Contenu :
//   1. Normalisation des noms (accents, casse, particules) et similarité
//      floue utilisée pour le criblage des listes sanctions / PPE.
//   2. Contrôle de complétude d'un dossier KYC (personne physique).
//   3. Contrôle de complétude d'un dossier KYB (personne morale) : blocage
//      s'il manque un bénéficiaire effectif > 25 % avec pièce valide criblée.
//   4. Règles de risque : PPE => ÉLEVÉ + double approbation ; échéances de
//      révision 1 an / 3 ans / 5 ans.
//   5. Visites de terrain : GPS certifié obligatoire, précision > 30 m
//      signalée, distance au point d'enrôlement, validité 30 jours.
//   6. Seuil de décaissement : au-dessus, visite récente exigée.
//   7. Calculs d'ancienneté (pièces expirées, revues échues).
// ===========================================================================

/** Erreur métier du module conformité (code stable + message français). */
export class ConformiteError extends Error {
  constructor(code, message, status = 422, detail = null) {
    super(message);
    this.name = 'ConformiteError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const NIVEAUX_RISQUE = Object.freeze(['FAIBLE', 'MOYEN', 'ELEVE']);
export const STATUTS_KYC = Object.freeze(['A_COMPLETER', 'ACTIF_CONFORME', 'A_REVOIR', 'EXPIRE']);
export const CODES_RESTRICTION = Object.freeze({
  KYC_EXPIRE: 'ALERTE_KYC_EXPIRE',
  PPE_A_VALIDER: 'ALERTE_PPE_A_VALIDER',
  SANCTIONS: 'ALERTE_SANCTIONS',
  VISITE: 'ALERTE_VISITE'
});

/** Paramètres par défaut (ceux du référentiel livré en base). */
export const PARAMS_DEFAUT = Object.freeze({
  seuil_decaissement_visite_cents: 50000000, // 500 000 FCFA
  validite_visite_jours: 30,
  precision_gps_max_m: 30,
  distance_max_enrolement_m: 100,
  seuil_criblage: 82,
  seuil_detention_be_pct: 25,
  revue_risque_eleve_mois: 12,
  revue_risque_moyen_mois: 36,
  revue_risque_faible_mois: 60
});

const nombre = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const texte = (v) => (v == null ? '' : String(v)).trim();
const dateVal = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Nombre de jours entiers entre deux dates (b - a), arrondi vers le bas. */
export function joursEntre(a, b) {
  const da = dateVal(a);
  const db = dateVal(b);
  if (!da || !db) return null;
  return Math.floor((db.getTime() - da.getTime()) / 86400000);
}

/** Date à laquelle tombe l'échéance (jour + N mois), au format AAAA-MM-JJ. */
export function ajouterMois(base, mois) {
  const d = dateVal(base) || new Date();
  const out = new Date(d.getTime());
  const jour = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + Math.round(nombre(mois, 0)));
  const dernierJour = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(jour, dernierJour));
  return out.toISOString().slice(0, 10);
}

/* ========================================================================
 * 1. NORMALISATION ET SIMILARITE (criblage flou)
 * ===================================================================== */

const PARTICULES = ['BEN', 'BIN', 'EL', 'AL', 'DE', 'DA', 'DI', 'DU', 'LA', 'LE', 'VAN', 'VON', 'MOHAMED', 'MOHAMMED'];

/**
 * Normalise un nom pour le rapprochement : majuscules, sans accents, sans
 * ponctuation, espaces simples. On garde les lettres et les chiffres
 * (utile pour « ALPHA 2 » ou « SARL »).
 */
export function normaliserNom(v) {
  return texte(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Jetons significatifs : on retire les particules trop courantes. */
export function jetonsNom(v) {
  return normaliserNom(v).split(' ').filter((t) => t && !(PARTICULES.includes(t) && t.length <= 3));
}

/** Distance de Levenshtein (nombre de modifications élémentaires). */
export function levenshtein(a, b) {
  const s = texte(a);
  const t = texte(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cout = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cout);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[t.length];
}

/** Similarité 0-100 entre deux libellés (1 = identiques). */
export function similarite(a, b) {
  const s = normaliserNom(a);
  const t = normaliserNom(b);
  if (!s || !t) return 0;
  if (s === t) return 100;
  const d = levenshtein(s, t);
  const base = Math.max(s.length, t.length);
  return Math.round(((base - d) / base) * 10000) / 100;
}

/**
 * Similarité « à l'africaine » : l'ordre des prénoms et noms varie d'un
 * document à l'autre (DOSSOU Koffi / Koffi DOSSOU) et les particules sautent.
 * On combine la similarité de la chaîne entière et celle des jetons remis
 * dans l'ordre alphabétique, et on retient la meilleure des deux.
 */
export function similariteNom(a, b) {
  const directe = similarite(a, b);
  const ja = jetonsNom(a).sort().join(' ');
  const jb = jetonsNom(b).sort().join(' ');
  const parJetons = ja && jb ? similarite(ja, jb) : 0;
  // Un jeton contenu intégralement dans l'autre nom (nom composé tronqué)
  const inconus = jetonsNom(a).filter((t) => t.length >= 4 && jetonsNom(b).includes(t));
  const bonus = inconus.length ? Math.min(6, inconus.length * 3) : 0;
  return Math.min(100, Math.round((Math.max(directe, parJetons) + bonus) * 100) / 100);
}

/**
 * Criblage d'un nom contre une liste (sanctions / PPE).
 * Renvoie les correspondances au-dessus du seuil, triées par score.
 * Une correspondance PPE est détectée séparément d'une correspondance de
 * sanctions : les conséquences ne sont pas les mêmes.
 */
export function criblerNom(nom, liste, options = {}) {
  const seuil = nombre(options.seuil, PARAMS_DEFAUT.seuil_criblage);
  const items = Array.isArray(liste) ? liste : [];
  const out = [];
  for (const item of items) {
    if (!item || item.actif === false) continue;
    const libelles = [item.nom_complet].concat(Array.isArray(item.alias_json) ? item.alias_json : [])
      .concat(item.alias ? [item.alias] : [])
      .filter(Boolean);
    let meilleur = 0;
    let meilleurLibelle = null;
    for (const lib of libelles) {
      const s = similariteNom(nom, lib);
      if (s > meilleur) { meilleur = s; meilleurLibelle = lib; }
    }
    // Une date de naissance identique renforce le rapprochement ; une date
    // franchement différente le modère (mais ne l'annule jamais).
    let score = meilleur;
    if (dateVal(item.date_naissance) && dateVal(options.date_naissance)) {
      const ecart = Math.abs(joursEntre(item.date_naissance, options.date_naissance) || 0);
      if (ecart === 0) score = Math.min(100, score + 5);
      else if (ecart > 365) score = Math.max(0, score - 10);
    }
    if (score >= seuil) {
      out.push({
        liste_id: item.id || null,
        source: item.source || null,
        type_liste: item.type_liste || 'SANCTIONS',
        libelle: meilleurLibelle,
        score: Math.round(score * 100) / 100,
        verdict: score >= 95 ? 'CONFIRME' : (score >= 88 ? 'SUSPECT' : 'A_VERIFIER')
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Synthèse d'un criblage : plus grave verdict + séparation PPE / sanctions. */
export function syntheseCriblage(correspondances) {
  const list = Array.isArray(correspondances) ? correspondances : [];
  const sanctions = list.filter((c) => (c.type_liste || 'SANCTIONS') !== 'PPE');
  const ppe = list.filter((c) => c.type_liste === 'PPE');
  const grave = (arr) => arr.reduce((m, c) => {
    const rang = { CONFIRME: 3, SUSPECT: 2, A_VERIFIER: 1 }[c.verdict] || 0;
    return rang > m ? rang : m;
  }, 0);
  return {
    nb: list.length,
    sanctions: sanctions.length,
    ppe: ppe.length,
    verdict: grave(list) >= 3 ? 'CONFIRME' : (grave(list) >= 2 ? 'SUSPECT' : (list.length ? 'A_VERIFIER' : 'CLAIR')),
    sanctions_confirmees: sanctions.some((c) => c.verdict === 'CONFIRME'),
    ppe_potentielle: ppe.length > 0,
    meilleur_score: list.reduce((m, c) => Math.max(m, nombre(c.score)), 0)
  };
}

/* ========================================================================
 * 2. NIVEAU DE RISQUE ET ECHEANCES DE REVUE
 * ===================================================================== */

/** Intervalle de révision (mois) selon le niveau de risque et le statut PPE. */
export function intervalleRevueMois(niveau, estPpe, params = PARAMS_DEFAUT) {
  const p = { ...PARAMS_DEFAUT, ...(params || {}) };
  if (estPpe === true || niveau === 'ELEVE') return nombre(p.revue_risque_eleve_mois, 12);
  if (niveau === 'FAIBLE') return nombre(p.revue_risque_faible_mois, 60);
  return nombre(p.revue_risque_moyen_mois, 36);
}

/**
 * Niveau de risque retenu : une PPE est TOUJOURS de risque élevé
 * (Instruction BCEAO : vigilance renforcée). Une sanction confirmée aussi.
 */
export function niveauRisqueEffectif(declaré, contexte = {}) {
  const base = NIVEAUX_RISQUE.includes(declaré) ? déclaré : 'MOYEN';
  if (contexte.ppe === true || contexte.sanction_confirmee === true) return 'ELEVE';
  if (base === 'FAIBLE' && nombre(contexte.montant_mensuel_cents) >= 500000000) return 'MOYEN';
  return base;
}

/* ========================================================================
 * 3. CONTROLE DE COMPLETUDE KYC (PERSONNE PHYSIQUE)
 * ===================================================================== */

const EXPIRATION_ALERTE_JOURS = 30;

/**
 * Contrôle un dossier KYC. Renvoie la liste des points bloquants et des
 * simples alertes, un score de 0 à 100 et le niveau de risque à retenir.
 *
 * Bloquants : identité de base, pièce non expirée, domicile justifié (papier
 * OU visite GPS), selfie, criblage effectué.
 * Alerte : pièce qui expire dans moins de 30 jours, précision GPS faible.
 */
export function controlerKyc(dossier, options = {}) {
  const d = dossier || {};
  const params = { ...PARAMS_DEFAUT, ...(options.params || {}) };
  const aujourdhui = dateVal(options.aujourdhui) || new Date();
  const bloquants = [];
  const alertes = [];
  const points = [];
  const fautif = (champ, message) => bloquants.push({ champ, message });
  const alerte = (champ, message) => alertes.push({ champ, message });

  if (!texte(d.full_name) || texte(d.full_name).split(/\s+/).length < 2) {
    fautif('full_name', 'Nom et prénom(s) obligatoires.');
  }
  const naissance = dateVal(d.birth_date);
  if (!naissance) fautif('birth_date', 'Date de naissance obligatoire.');
  else {
    const age = Math.floor((joursEntre(naissance, aujourdhui) || 0) / 365.25);
    if (age < 16) fautif('birth_date', 'Client mineur : la représentation légale est requise.');
    if (age > 110) fautif('birth_date', 'Date de naissance invraisemblable.');
  }
  if (!texte(d.lieu_naissance)) fautif('lieu_naissance', 'Lieu de naissance obligatoire.');
  if (!texte(d.nationalite)) fautif('nationalite', 'Nationalité obligatoire.');

  if (!texte(d.id_number) || !texte(d.type_piece)) {
    fautif('id_number', 'Pièce d’identité (type et numéro) obligatoire.');
  }
  const expire = dateVal(d.piece_expire_le);
  if (!expire) fautif('piece_expire_le', 'Date d’expiration de la pièce obligatoire.');
  else {
    const jours = joursEntre(aujourdhui, expire);
    if (jours < 0) fautif('piece_expire_le', 'La pièce d’identité est expirée depuis ' + Math.abs(jours) + ' jour(s).');
    else if (jours <= EXPIRATION_ALERTE_JOURS) alerte('piece_expire_le', 'La pièce expire dans ' + jours + ' jour(s).');
  }

  if (!texte(d.profession)) fautif('profession', 'Profession obligatoire.');
  if (!texte(d.source_revenus)) fautif('source_revenus', 'Source de revenus obligatoire.');

  // Domicile : un justificatif papier OU une visite GPS au statut conforme.
  const justificatif = texte(d.justificatif_domicile_type);
  const visiteOk = d.visite_gps_conforme === true;
  if (!justificatif && !visiteOk) {
    fautif('justificatif_domicile_type', 'Justificatif de domicile ou visite GPS certifiée obligatoire.');
  }
  if (texte(d.justificatif_domicile_type) === 'VISITE_GPS' && !visiteOk) {
    fautif('justificatif_domicile_type', 'Le justificatif retenu est la visite GPS, mais aucune visite conforme n’est enregistrée.');
  }

  if (!texte(d.selfie_data_url)) fautif('selfie_data_url', 'Selfie de vérification obligatoire.');
  else if (!dateVal(d.selfie_captured_at)) alerte('selfie_captured_at', 'Date de prise du selfie manquante.');

  // GPS d'enrôlement
  if (d.gps_lat == null || d.gps_lng == null) {
    fautif('gps_lat', 'Position GPS de l’enrôlement obligatoire.');
  } else if (nombre(d.gps_accuracy_m, 999) > params.precision_gps_max_m) {
    alerte('gps_accuracy_m', 'Précision GPS insuffisante (' + nombre(d.gps_accuracy_m) +
      ' m > ' + params.precision_gps_max_m + ' m) : relever une nouvelle position à découvert.');
  }

  const crib = syntheseCriblage(options.criblage || d.criblage || []);
  if (!options.criblage_effectue) {
    fautif('criblage', 'Criblage des listes de sanctions et PPE non effectué.');
  }
  if (crib.sanctions_confirmees) fautif('criblage', 'Correspondance confirmée sur une liste de sanctions : opérations interdites, déclaration obligatoire.');
  else if (crib.verdict === 'SUSPECT') alerte('criblage', 'Correspondance à vérifier sur une liste (score ' + crib.meilleur_score + ' %).');
  if (crib.ppe_potentielle) alerte('ppe', 'Correspondance PPE détectée : la qualité de PPE doit être établie ou écartée.');
  if (texte(d.ppe_fonction) || d.ppe === true) {
    if (d.double_approbation === false) {
      alerte('ppe', 'Client PPE : double approbation Rés. Conformité + Direction Générale requise avant mise en service.');
    }
  }

  const total = 10 + 4 + 4; // points maximaux (identité, pièce, autres)
  let acquis = 0;
  const coche = (ok, pts) => { if (ok) acquis += pts; };
  coche(texte(d.full_name) !== '', 3);
  coche(!!naissance, 2);
  coche(texte(d.lieu_naissance) !== '', 2);
  coche(texte(d.nationalite) !== '', 1);
  coche(texte(d.id_number) !== '' && !!expire && (joursEntre(aujourdhui, expire) || 0) >= 0, 4);
  coche(texte(d.profession) !== '' && texte(d.source_revenus) !== '', 2);
  coche(!!justificatif || visiteOk, 3);
  coche(texte(d.selfie_data_url) !== '', 2);
  coche(d.gps_lat != null && d.gps_lng != null, 2);
  coche(crib.verdict === 'CLAIR', 2);
  // Les points non prévus (au-dessus de 22) sont ramenés sur 100.
  const score = Math.max(0, Math.min(100, Math.round((acquis / total) * 100) - bloquants.length * 5));

  points.push(...bloquants.map((b) => ({ ...b, gravite: 'BLOQUANT' })));
  points.push(...alertes.map((a) => ({ ...a, gravite: 'ALERTE' })));

  const ppe = d.ppe === true || !!texte(d.ppe_fonction) || crib.ppe_potentielle;
  const niveau = niveauRisqueEffectif(d.niveau_risque_lbc, {
    ppe, sanction_confirmee: crib.sanctions_confirmees,
    montant_mensuel_cents: d.revenu_mensuel_cents
  });
  const statut = bloquants.length ? 'A_COMPLETER' : (alertes.length ? 'A_REVOIR' : 'ACTIF_CONFORME');
  const intervalle = intervalleRevueMois(niveau, ppe, params);

  return {
    score_kyc: score,
    niveau_risque_lbc: niveau,
    ppe,
    statut,
    complet: bloquants.length === 0,
    bloquants,
    alertes,
    points,
    criblage: crib,
    revue_intervalle_mois: intervalle,
    prochaine_revue_le: ajouterMois(aujourdhui, intervalle),
    double_approbation_requise: ppe === true
  };
}

/* ========================================================================
 * 4. CONTROLE DE COMPLETUDE KYB (PERSONNE MORALE)
 * ===================================================================== */

/** Vrai si la pièce d'une personne (BE ou mandataire) est valide à la date d. */
export function pieceValide(personne, aujourdhui = new Date()) {
  const p = personne || {};
  if (!texte(p.numero_piece) || !texte(p.type_piece)) return false;
  const exp = dateVal(p.piece_expire_le);
  if (!exp) return false;
  return (joursEntre(aujourdhui, exp) || 0) >= 0;
}

/** Détention en pourcentage (accepte 30 ou 0.30 : on normalise sur 100). */
export function detentionPct(v) {
  const n = nombre(v, 0);
  if (n > 0 && n <= 1) return Math.round(n * 10000) / 100;
  return Math.round(n * 100) / 100;
}

/**
 * Contrôle un dossier KYB.
 * RÈGLE BCEAO : aucun compte ne s'ouvre sans connaître les bénéficiaires
 * effectifs détenant plus de 25 % — chacun avec une pièce valide et un
 * criblage effectué. Les mandataires signataires sont contrôlés de la même
 * façon (pièce + criblage).
 */
export function controlerKyb(entite, beneficiaires = [], mandataires = [], options = {}) {
  const e = entite || {};
  const params = { ...PARAMS_DEFAUT, ...(options.params || {}) };
  const aujourdhui = dateVal(options.aujourdhui) || new Date();
  const bloquants = [];
  const alertes = [];
  const fautif = (champ, message) => bloquants.push({ champ, message });

  if (!texte(e.raison_sociale)) fautif('raison_sociale', 'Raison sociale obligatoire.');
  if (!texte(e.rccm)) fautif('rccm', 'Numéro RCCM obligatoire.');
  if (!texte(e.forme_juridique)) fautif('forme_juridique', 'Forme juridique obligatoire.');
  if (!texte(e.siege_adresse)) fautif('siege_adresse', 'Adresse du siège obligatoire.');
  if (e.siege_gps_lat == null || e.siege_gps_lng == null) {
    fautif('siege_gps_lat', 'Coordonnées GPS du siège obligatoires (relevé sur place).');
  }

  const bes = Array.isArray(beneficiaires) ? beneficiaires : [];
  const mands = Array.isArray(mandataires) ? mandataires : [];
  const seuil = nombre(params.seuil_detention_be_pct, 25);

  const significatifs = bes.filter((b) => detentionPct(b && b.detention_pct) > seuil);
  if (!significatifs.length) {
    fautif('beneficiaires_effectifs', 'Aucun bénéficiaire effectif détenant plus de ' + seuil +
      ' % : la relation d’affaires ne peut pas être établie.');
  }
  let totalDetention = 0;
  for (const b of significatifs) {
    totalDetention += detentionPct(b.detention_pct);
    const nom = texte(b.nom_complet) || 'bénéficiaire sans nom';
    if (!pieceValide(b, aujourdhui)) {
      fautif('beneficiaires_effectifs', 'Pièce d’identité absente ou expirée pour le bénéficiaire effectif ' + nom + '.');
    }
    const crib = syntheseCriblage(b.criblage || []);
    if (!b.criblage_effectue && texte(b.criblage_statut) === 'A_FAIRE') {
      fautif('beneficiaires_effectifs', 'Criblage des listes non effectué pour le bénéficiaire effectif ' + nom + '.');
    }
    if (crib.sanctions_confirmees) {
      fautif('beneficiaires_effectifs', 'Correspondance sanction confirmée pour le bénéficiaire effectif ' + nom + '.');
    }
    if (b.est_ppe === true || crib.ppe_potentielle) {
      alertes.push({ champ: 'beneficiaires_effectifs', gravite: 'ALERTE',
        message: 'Bénéficiaire effectif PPE (' + nom + ') : vigilance renforcée et double approbation.' });
    }
  }
  if (significatifs.length && totalDetention > 100.01) {
    fautif('beneficiaires_effectifs', 'La somme des détentions dépasse 100 % (' + Math.round(totalDetention * 100) / 100 + ' %).');
  }

  if (!mands.length) {
    fautif('mandataires_signataires', 'Au moins un mandataire signataire doit être identifié.');
  }
  for (const m of mands) {
    if (m && m.actif === false) continue;
    const nom = texte(m && m.nom_complet) || 'mandataire sans nom';
    if (!texte(m && m.pouvoir_ref)) {
      alertes.push({ champ: 'mandataires_signataires', gravite: 'ALERTE',
        message: 'Référence du pouvoir de signature manquante pour ' + nom + '.' });
    }
    if (!pieceValide(m, aujourdhui)) {
      fautif('mandataires_signataires', 'Pièce d’identité absente ou expirée pour le mandataire ' + nom + '.');
    }
    const crib = syntheseCriblage(m && m.criblage || []);
    if (m && !m.criblage_effectue && texte(m.criblage_statut) === 'A_FAIRE') {
      fautif('mandataires_signataires', 'Criblage des listes non effectué pour le mandataire ' + nom + '.');
    }
    if (crib.sanctions_confirmees) {
      fautif('mandataires_signataires', 'Correspondance sanction confirmée pour le mandataire ' + nom + '.');
    }
  }

  const ppeEntite = bes.some((b) => b && b.est_ppe === true) || mands.some((m) => m && m.est_ppe === true);
  const niveau = niveauRisqueEffectif(e.niveau_risque_lbc, {
    ppe: ppeEntite, montant_mensuel_cents: e.chiffre_affaires_cents
  });
  const intervalle = intervalleRevueMois(niveau, ppeEntite, params);
  const statut = bloquants.length ? 'A_COMPLETER' : (alertes.length ? 'A_REVOIR' : 'ACTIF_CONFORME');

  // Score : part des contrôles satisfaits (contrôles de base + BE + mandataires)
  const totalControles = 5 + Math.max(1, significatifs.length) * 3 + Math.max(1, mands.length) * 2;
  const echecs = bloquants.length + alertes.length * 0.5;
  const score = Math.max(0, Math.min(100, Math.round(((totalControles - echecs) / totalControles) * 100)));

  return {
    score_kyb: score,
    niveau_risque_lbc: niveau,
    statut,
    complet: bloquants.length === 0,
    bloquants,
    alertes,
    beneficiaires_significatifs: significatifs.length,
    detention_totale_pct: Math.round(totalDetention * 100) / 100,
    ppe: ppeEntite,
    revue_intervalle_mois: intervalle,
    prochaine_revue_le: ajouterMois(aujourdhui, intervalle),
    double_approbation_requise: ppeEntite
  };
}

/* ========================================================================
 * 5. VISITES DE TERRAIN
 * ===================================================================== */

/** Distance en mètres entre deux points (haversine, WGS-84). */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const a = [lat1, lng1, lat2, lng2].map((v) => Number(v));
  if (a.some((v) => !Number.isFinite(v))) return null;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(a[2] - a[0]);
  const dLng = rad(a[3] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(a[2])) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 100) / 100;
}

/**
 * Valide une visite transmise par le téléphone.
 * Règles : coordonnées fournies par le capteur (jamais saisies à la main),
 * précision renseignée, photos horodatées, UUID fourni par l'appareil.
 * Renvoie les alertes et la distance au point de référence.
 */
export function controlerVisite(visite, options = {}) {
  const v = visite || {};
  const params = { ...PARAMS_DEFAUT, ...(options.params || {}) };
  const bloquants = [];
  const alertes = [];
  const exiger = (cond, champ, message) => { if (!cond) bloquants.push({ champ, message }); };

  exiger(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(texte(v.id)), 'id',
    'Identifiant de visite (UUID) obligatoire : il garantit qu’une même visite n’est jamais comptée deux fois.');
  exiger(v.client_id || v.entite_id, 'client_id', 'La visite doit viser un client ou une entreprise.');
  exiger(texte(v.gps_source) === 'CAPTEUR', 'gps_source',
    'La position doit venir du capteur GPS de l’appareil : la saisie manuelle est interdite.');
  const lat = Number(v.gps_lat);
  const lng = Number(v.gps_lng);
  exiger(Number.isFinite(lat) && lat >= -90 && lat <= 90, 'gps_lat', 'Latitude GPS manquante ou invalide.');
  exiger(Number.isFinite(lng) && lng >= -180 && lng <= 180, 'gps_lng', 'Longitude GPS manquante ou invalide.');
  exiger(Number.isFinite(Number(v.gps_precision_m)), 'gps_precision_m', 'Précision GPS obligatoire.');
  exiger(!!dateVal(v.gps_capture_le), 'gps_capture_le', 'Date de capture GPS obligatoire.');
  exiger(texte(v.reperes_visuels).length >= 5, 'reperes_visuels', 'Décrivez les repères visuels du lieu (au moins 5 caractères).');

  const photos = Array.isArray(v.photos_json) ? v.photos_json : (Array.isArray(v.photos) ? v.photos : []);
  exiger(photos.length >= 1, 'photos_json', 'Au moins une photo du lieu est obligatoire.');
  photos.forEach((p, i) => {
    if (!p || !dateVal(p.prise_le)) {
      alertes.push({ champ: 'photos_json', gravite: 'ALERTE', message: 'Photo ' + (i + 1) + ' sans horodatage.' });
    }
  });

  const precision = nombre(v.gps_precision_m, 0);
  const alertePrecision = precision > nombre(params.precision_gps_max_m, 30);
  if (alertePrecision) {
    alertes.push({ champ: 'gps_precision_m', gravite: 'ALERTE',
      message: 'Précision GPS de ' + Math.round(precision) + ' m (> ' + params.precision_gps_max_m +
        ' m) : la visite est enregistrée mais signalée au contrôle.' });
  }

  const refLat = options.point_reference_lat != null ? options.point_reference_lat : v.point_reference_lat;
  const refLng = options.point_reference_lng != null ? options.point_reference_lng : v.point_reference_lng;
  const dist = distanceM(lat, lng, refLat, refLng);
  const distanceAlerte = dist != null && dist > nombre(params.distance_max_enrolement_m, 100);
  if (distanceAlerte) {
    alertes.push({ champ: 'distance_m', gravite: 'ALERTE',
      message: 'La visite a été faite à ' + Math.round(dist) + ' m du point d’enrôlement (max ' +
        params.distance_max_enrolement_m + ' m) : vérifier qu’il s’agit bien du même lieu.' });
  }

  return {
    valide: bloquants.length === 0,
    bloquants,
    alertes,
    distance_m: dist,
    distance_alerte: distanceAlerte,
    gps_alerte_precision: alertePrecision,
    statut: bloquants.length ? 'INCOMPLET'
      : (v.statut === 'NON_CONFORME' ? 'NON_CONFORME' : 'ACTIF_CONFORME')
  };
}

/** Vrai si la date de visite tient encore dans la fenêtre de validité. */
export function visiteValide(dateVisite, options = {}) {
  const params = { ...PARAMS_DEFAUT, ...(options.params || {}) };
  const jours = joursEntre(dateVisite, dateVal(options.aujourdhui) || new Date());
  if (jours == null) return false;
  return jours >= 0 && jours <= nombre(params.validite_visite_jours, 30);
}

/**
 * Filtre les visites réellement exploitables pour un décaissement :
 * statut ACTIF_CONFORME, dans la fenêtre de validité, et non signalées par
 * une alerte de distance. Renvoie la plus récente.
 */
export function derniereVisiteExploitable(visites, options = {}) {
  const list = (Array.isArray(visites) ? visites : [])
    .filter((v) => v && v.statut === 'ACTIF_CONFORME' && !v.distance_alerte)
    .filter((v) => visiteValide(v.visite_le, options))
    .sort((a, b) => new Date(b.visite_le).getTime() - new Date(a.visite_le).getTime());
  return list[0] || null;
}

/* ========================================================================
 * 6. DECAISSEMENT : SEUIL ET VISITE RECENTE
 * ===================================================================== */

/**
 * Décide si un décaissement peut passer au regard de la conformité.
 * Au-dessus du seuil paramétré, il faut : une visite de moins de 30 jours au
 * statut ACTIF_CONFORME, un KYC au statut ACTIF_CONFORME et aucune
 * restriction bloquante active.
 */
export function controlerDecaissement(contexte, options = {}) {
  const c = contexte || {};
  const params = { ...PARAMS_DEFAUT, ...(options.params || {}) };
  const montant = nombre(c.montant_cents, 0);
  const seuil = nombre(params.seuil_decaissement_visite_cents, PARAMS_DEFAUT.seuil_decaissement_visite_cents);
  const auDessus = montant >= seuil;
  const restrictions = (Array.isArray(c.restrictions) ? c.restrictions : [])
    .filter((r) => r && !r.levee_le && (r.gravite === 'BLOQUANT' || r.gravite === 'ALERTE'));
  const bloquantes = restrictions.filter((r) => r.gravite === 'BLOQUANT');
  const motifs = [];

  if (bloquantes.length) {
    for (const r of bloquantes) motifs.push((r.libelle || r.code) + (r.motif ? ' — ' + r.motif : ''));
  }
  if (auDessus) {
    const visite = derniereVisiteExploitable(c.visites, { ...options, params });
    if (!visite) {
      motifs.push('Décaissement de ' + (montant / 100).toLocaleString('fr-FR') + ' FCFA : une visite de terrain de moins de ' +
        params.validite_visite_jours + ' jours au statut « ACTIF_CONFORME » est exigée (seuil ' +
        (seuil / 100).toLocaleString('fr-FR') + ' FCFA).');
    }
    if (c.statut_kyc && c.statut_kyc !== 'ACTIF_CONFORME') {
      motifs.push('Le dossier KYC du client n’est pas à jour (statut ' + c.statut_kyc + ').');
    }
  }
  return {
    autorise: motifs.length === 0,
    au_dessus_du_seuil: auDessus,
    seuil_cents: seuil,
    montant_cents: montant,
    motifs,
    visite_exigee: auDessus
  };
}

/* ========================================================================
 * 7. TACHE QUOTIDIENNE : PIECES EXPIREES ET REVUES ECHEUES
 * ===================================================================== */

/**
 * Liste les dossiers à restreindre (pièce expirée ou revue échue).
 * Renvoie, pour chacun, la restriction à poser : ALERTE_KYC_EXPIRE.
 */
export function dossiersAEcheance(dossiers, options = {}) {
  const aujourdhui = dateVal(options.aujourdhui) || new Date();
  const out = [];
  for (const d of Array.isArray(dossiers) ? dossiers : []) {
    if (!d || !d.id) continue;
    const motifs = [];
    const expire = dateVal(d.piece_expire_le);
    if (expire && joursEntre(aujourdhui, expire) < 0) {
      motifs.push('Pièce d’identité expirée le ' + expire.toISOString().slice(0, 10) + '.');
    }
    const revue = dateVal(d.kyc_prochaine_revue_le || d.prochaine_revue_le);
    if (revue && joursEntre(aujourdhui, revue) < 0) {
      motifs.push('Révision périodique échue depuis le ' + revue.toISOString().slice(0, 10) + '.');
    }
    if (motifs.length) {
      out.push({
        id: d.id,
        client_id: d.client_id || d.id,
        entite_id: d.entite_id || null,
        code: CODES_RESTRICTION.KYC_EXPIRE,
        gravite: 'BLOQUANT',
        nouveau_statut: 'EXPIRE',
        motif: motifs.join(' ')
      });
    }
  }
  return out;
}

/**
 * Construit le tableau de bord de conformité d'une IMF à partir de
 * compteurs simples (aucune requête ici : le serveur fournit les chiffres).
 */
export function syntheseConformite(compteurs) {
  const c = compteurs || {};
  const total = nombre(c.total_clients);
  const conformes = nombre(c.clients_conformes);
  const pct = (n) => (total > 0 ? Math.round((nombre(n) / total) * 1000) / 10 : 0);
  return {
    total_clients: total,
    conformes,
    a_completer: nombre(c.clients_a_completer),
    a_revoir: nombre(c.clients_a_revoir),
    expires: nombre(c.clients_expires),
    ppe: nombre(c.clients_ppe),
    taux_conformite_pct: pct(conformes),
    taux_ppe_pct: pct(c.clients_ppe),
    entites_kyb: nombre(c.entites_kyb),
    entites_kyb_conformes: nombre(c.entites_kyb_conformes),
    visites_30j: nombre(c.visites_30j),
    visites_non_synchronisees: nombre(c.visites_non_synchronisees),
    restrictions_actives: nombre(c.restrictions_actives)
  };
}
