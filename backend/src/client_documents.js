// teebo — Pièces requises du dossier PARTICULIER (source unique côté serveur).
// -----------------------------------------------------------------------------
// Même principe que client_typology.js : ce module décrit les listes de pièces
// et sert à la fois à alimenter le front (GET /client-meta) et à VALIDER la
// saisie côté serveur. Il ne concerne pour l'instant que les PARTICULIERS ;
// pour un groupe ou une entreprise, aucune pièce n'est encore imposée.

// Types de document officiel d'identité valides.
export const ID_DOC_TYPES = [
  { code: 'cni',               label: 'Carte Nationale d\u2019Identit\u00e9 (CNI)' },
  { code: 'passeport',         label: 'Passeport' },
  { code: 'cedeao',            label: 'Carte d\u2019Identit\u00e9 Biom\u00e9trique CEDEAO' },
  { code: 'consulaire_sejour', label: 'Carte consulaire ou carte de s\u00e9jour (\u00e9tranger)' },
];

// Acte de naissance : reçu ou à compléter.
export const BIRTH_CERT_STATUSES = [
  { code: 'recu',        label: 'Document re\u00e7u' },
  { code: 'a_completer', label: '\u00c0 compl\u00e9ter' },
];

// Justificatif de localisation : reçu / non reçu.
export const PROOF_STATUSES = [
  { code: 'recu',     label: 'Justificatif re\u00e7u' },
  { code: 'non_recu', label: 'Justificatif non re\u00e7u' },
];

// Justificatifs de domicile acceptables.
export const HOME_PROOF_TYPES = [
  { code: 'certificat_residence_client', label: 'Certificat de r\u00e9sidence au nom du client' },
  { code: 'facture_eau_client',          label: 'Facture d\u2019eau du domicile au nom du client (\u2264 3 mois)' },
  { code: 'facture_elec_client',         label: 'Facture d\u2019\u00e9lectricit\u00e9 du domicile au nom du client (\u2264 3 mois)' },
  { code: 'facture_elec_tiers',          label: 'Facture d\u2019\u00e9lectricit\u00e9 du domicile au nom d\u2019un tiers (\u2264 3 mois)' },
  { code: 'facture_eau_tiers',           label: 'Facture d\u2019eau du domicile au nom d\u2019un tiers (\u2264 3 mois)' },
  { code: 'bail_client',                 label: 'Contrat de bail du domicile au nom du client' },
  { code: 'bail_tiers',                  label: 'Contrat de bail du domicile au nom d\u2019un tiers' },
];

// Justificatifs de lieu d'activité acceptables.
export const ACTIVITY_PROOF_TYPES = [
  { code: 'facture_eau_client',  label: 'Facture d\u2019eau du lieu d\u2019activit\u00e9 au nom du client (\u2264 3 mois)' },
  { code: 'facture_elec_client', label: 'Facture d\u2019\u00e9lectricit\u00e9 du lieu d\u2019activit\u00e9 au nom du client (\u2264 3 mois)' },
  { code: 'facture_elec_tiers',  label: 'Facture d\u2019\u00e9lectricit\u00e9 du lieu d\u2019activit\u00e9 au nom d\u2019un tiers (\u2264 3 mois)' },
  { code: 'facture_eau_tiers',   label: 'Facture d\u2019eau du lieu d\u2019activit\u00e9 au nom d\u2019un tiers (\u2264 3 mois)' },
  { code: 'bail_client',         label: 'Contrat de bail du lieu d\u2019activit\u00e9 au nom du client' },
  { code: 'bail_tiers',          label: 'Contrat de bail du lieu d\u2019activit\u00e9 au nom d\u2019un tiers' },
];

// Justificatif d'activité & de revenu, par profession du particulier.
// kind = nature du revenu ; description/school = champ texte obligatoire ;
// proof_required = la case « reçu » est obligatoire ; proof_optional = elle peut
// être « non reçu ».
export const INCOME_BY_PROFESSION = {
  salarie: {
    kind: 'salaire', kind_label: 'Salaire', proof_required: true,
    proof_label: 'Justification de revenu re\u00e7u',
    types: [
      { code: 'bulletin_salaire',   label: 'Bulletin de salaire' },
      { code: 'attestation_travail', label: 'Attestation de travail' },
      { code: 'contrat_travail',    label: 'Contrat de travail' },
    ],
  },
  retraite: {
    kind: 'pension', kind_label: 'Pension', proof_required: true,
    proof_label: 'Justification de revenu re\u00e7u',
    types: [
      { code: 'bulletin_pension',           label: 'Bulletin de pension' },
      { code: 'attestation_depart_retraite', label: 'Attestation de d\u00e9part \u00e0 la retraite' },
      { code: 'carte_pension',              label: 'Carte de pension' },
    ],
  },
  informel: {
    kind: 'informel', kind_label: 'Activit\u00e9 informelle', description_required: true,
    description_label: 'Description de l\u2019activit\u00e9',
  },
  etudiant: {
    kind: 'etudiant', kind_label: '\u00c9tudiant', school_required: true,
    school_label: 'Nom de l\u2019universit\u00e9 ou de l\u2019\u00e9cole',
    proof_optional: true, proof_label: 'Justificatif d\u2019activit\u00e9 re\u00e7u',
    types: [
      { code: 'carte_etudiant',       label: 'Carte d\u2019\u00e9tudiant' },
      { code: 'certificat_scolarite', label: 'Certificat de scolarit\u00e9 de l\u2019ann\u00e9e en cours' },
    ],
  },
};

// Lien de l'ayant droit (bénéficiaire désigné par le particulier).
export const BENEFICIARY_RELATIONS = [
  { code: 'pere',     label: 'Père' },
  { code: 'mere',     label: 'Mère' },
  { code: 'frere',    label: 'Frère' },
  { code: 'soeur',    label: 'Sœur' },
  { code: 'enfant',   label: 'Enfant' },
  { code: 'ami',      label: 'Ami(e)' },
  { code: 'epouse',   label: 'Épouse' },
  { code: 'epoux',    label: 'Époux' },
  { code: 'conjoint', label: 'Conjoint(e)' },
];

export const PARTICULIER_DOCS = {
  id_doc_types: ID_DOC_TYPES,
  birth_cert_statuses: BIRTH_CERT_STATUSES,
  proof_statuses: PROOF_STATUSES,
  home_proof_types: HOME_PROOF_TYPES,
  activity_proof_types: ACTIVITY_PROOF_TYPES,
  income_by_profession: INCOME_BY_PROFESSION,
  beneficiary_relations: BENEFICIARY_RELATIONS,
  // Professions pour lesquelles la domiciliation du salaire / de la pension
  // est proposée (case « oui »).
  salary_domiciliation_professions: ['salarie', 'retraite'],
};

// Tous les champs de pièces gérés (pour nettoyage/persistance).
export const DOC_FIELDS = [
  'first_name', 'last_name', 'birth_place',
  'id_doc_type', 'id_doc_received', 'id_doc_number', 'id_doc_issue_date', 'id_doc_expiry_date',
  'birth_cert_status',
  'home_location_desc', 'home_proof_status', 'home_proof_type',
  'activity_location_desc', 'activity_proof_status', 'activity_proof_type',
  'activity_description', 'school_name', 'income_proof_status', 'income_proof_type',
  'beneficiary_last_name', 'beneficiary_first_name', 'beneficiary_relation', 'salary_domiciliation',
];

const codes = (list) => list.map((o) => o.code);

// Calcule une date d'expiration = date d'établissement + N mois.
// Retourne une chaîne ISO 'YYYY-MM-DD' ou null si entrées insuffisantes.
export function computeExpiry(issueDateStr, months) {
  if (!issueDateStr || months == null) return null;
  const m = Math.trunc(Number(months));
  if (!Number.isFinite(m) || m <= 0) return null;
  const d = new Date(issueDateStr + (issueDateStr.length <= 10 ? 'T00:00:00Z' : ''));
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1));
  // Gestion des mois plus courts (ex : 31 janv. + 1 mois -> 28/29 fév.).
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function reqText(body, field) {
  const v = body[field];
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

// Valide le dossier PIÈCES d'un PARTICULIER. opts = { profession, validityMonths }.
// Retourne { ok, values, error?, field?, message? }. validityMonths = objet
// { type_de_piece: nb_mois } fourni par les paramètres de l'IMF.
export function validateParticulierDocs(body, opts) {
  opts = opts || {};
  const profession = opts.profession || null;
  const validity = opts.validityMonths || {};
  const values = {};
  for (const f of DOC_FIELDS) values[f] = null;
  values.id_doc_received = false;
  values.salary_domiciliation = false;

  const err = (error, field, message) => ({ ok: false, error, field, message });

  // 1) Pièce officielle d'identité + case « reçu ».
  const idType = reqText(body, 'id_doc_type');
  if (!idType) return err('piece_identite_requise', 'id_doc_type',
    'Choisissez le document officiel d\u2019identit\u00e9 valide.');
  if (!codes(ID_DOC_TYPES).includes(idType)) return err('piece_identite_invalide', 'id_doc_type',
    'Type de pi\u00e8ce d\u2019identit\u00e9 invalide.');
  values.id_doc_type = idType;
  const received = body.id_doc_received === true || body.id_doc_received === 'true' || body.id_doc_received === 1;
  if (!received) return err('piece_identite_non_recue', 'id_doc_received',
    'Cochez \u00ab document physique re\u00e7u \u00bb pour la pi\u00e8ce d\u2019identit\u00e9.');
  values.id_doc_received = true;

  // Acte de naissance : reçu ou à compléter.
  const bc = reqText(body, 'birth_cert_status');
  if (!bc) return err('acte_naissance_requis', 'birth_cert_status',
    'Indiquez si l\u2019acte de naissance est re\u00e7u ou \u00e0 compl\u00e9ter.');
  if (!codes(BIRTH_CERT_STATUSES).includes(bc)) return err('acte_naissance_invalide', 'birth_cert_status',
    'Statut d\u2019acte de naissance invalide.');
  values.birth_cert_status = bc;

  // 2) Identité détaillée.
  const first = reqText(body, 'first_name');
  const last = reqText(body, 'last_name');
  if (!last) return err('nom_requis', 'last_name', 'Le nom est obligatoire.');
  if (!first) return err('prenom_requis', 'first_name', 'Le pr\u00e9nom est obligatoire.');
  values.first_name = first; values.last_name = last;
  if (!reqText(body, 'phone')) return err('telephone_requis', 'phone', 'Le num\u00e9ro de t\u00e9l\u00e9phone est obligatoire.');
  if (!reqText(body, 'birth_date')) return err('date_naissance_requise', 'birth_date', 'La date de naissance est obligatoire.');
  const bp = reqText(body, 'birth_place');
  if (!bp) return err('lieu_naissance_requis', 'birth_place', 'Le lieu de naissance est obligatoire.');
  values.birth_place = bp;
  const idNum = reqText(body, 'id_doc_number');
  if (!idNum) return err('numero_piece_requis', 'id_doc_number', 'Le num\u00e9ro de la pi\u00e8ce d\u2019identit\u00e9 est obligatoire.');
  values.id_doc_number = idNum;
  const issue = reqText(body, 'id_doc_issue_date');
  if (!issue) return err('date_etablissement_requise', 'id_doc_issue_date', 'La date d\u2019\u00e9tablissement de la pi\u00e8ce est obligatoire.');
  values.id_doc_issue_date = issue;
  // Expiration CALCULÉE à partir de la durée de validité paramétrée par l'IMF.
  const months = validity && validity[idType] != null ? Number(validity[idType]) : null;
  values.id_doc_expiry_date = computeExpiry(issue, months);

  // 2 bis) Ayant droit : nom, prénom et lien (obligatoires pour un particulier).
  const bLast = reqText(body, 'beneficiary_last_name');
  if (!bLast) return err('ayant_droit_nom_requis', 'beneficiary_last_name', 'Le nom de l’ayant droit est obligatoire.');
  const bFirst = reqText(body, 'beneficiary_first_name');
  if (!bFirst) return err('ayant_droit_prenom_requis', 'beneficiary_first_name', 'Le prénom de l’ayant droit est obligatoire.');
  const bRel = reqText(body, 'beneficiary_relation');
  if (!bRel) return err('ayant_droit_lien_requis', 'beneficiary_relation', 'Choisissez le lien de l’ayant droit.');
  if (!codes(BENEFICIARY_RELATIONS).includes(bRel)) return err('ayant_droit_lien_invalide', 'beneficiary_relation', 'Lien de l’ayant droit invalide.');
  values.beneficiary_last_name = bLast;
  values.beneficiary_first_name = bFirst;
  values.beneficiary_relation = bRel;

  // 3) Localisation domicile + activité.
  const homeLoc = reqText(body, 'home_location_desc');
  if (!homeLoc) return err('plan_domicile_requis', 'home_location_desc',
    'D\u00e9crivez l\u2019itin\u00e9raire et les rep\u00e8res du domicile (plan de localisation du domicile).');
  values.home_location_desc = homeLoc;
  const actLoc = reqText(body, 'activity_location_desc');
  if (!actLoc) return err('plan_activite_requis', 'activity_location_desc',
    'D\u00e9crivez l\u2019itin\u00e9raire et les rep\u00e8res du lieu d\u2019activit\u00e9 (plan de localisation d\u2019activit\u00e9).');
  values.activity_location_desc = actLoc;

  const hps = reqText(body, 'home_proof_status');
  if (!hps || !codes(PROOF_STATUSES).includes(hps)) return err('justif_domicile_requis', 'home_proof_status',
    'Indiquez si le justificatif de domicile est re\u00e7u ou non re\u00e7u.');
  values.home_proof_status = hps;
  if (hps === 'recu') {
    const hpt = reqText(body, 'home_proof_type');
    if (!hpt || !codes(HOME_PROOF_TYPES).includes(hpt)) return err('justif_domicile_type_requis', 'home_proof_type',
      'Choisissez le justificatif de domicile re\u00e7u.');
    values.home_proof_type = hpt;
  }

  const aps = reqText(body, 'activity_proof_status');
  if (!aps || !codes(PROOF_STATUSES).includes(aps)) return err('justif_activite_requis', 'activity_proof_status',
    'Indiquez si le justificatif de lieu d\u2019activit\u00e9 est re\u00e7u ou non re\u00e7u.');
  values.activity_proof_status = aps;
  if (aps === 'recu') {
    const apt = reqText(body, 'activity_proof_type');
    if (!apt || !codes(ACTIVITY_PROOF_TYPES).includes(apt)) return err('justif_activite_type_requis', 'activity_proof_type',
      'Choisissez le justificatif de lieu d\u2019activit\u00e9 re\u00e7u.');
    values.activity_proof_type = apt;
  }

  // 4) Activité & revenu selon la profession.
  const spec = profession ? INCOME_BY_PROFESSION[profession] : null;
  // Domiciliation du salaire / de la pension (salarié / retraité) : case « oui ».
  if (profession === 'salarie' || profession === 'retraite') {
    const dom = body.salary_domiciliation;
    values.salary_domiciliation = dom === true || dom === 'true' || dom === 1 || dom === 'on';
  }
  if (spec) {
    if (spec.description_required) {
      const desc = reqText(body, 'activity_description');
      if (!desc) return err('description_activite_requise', 'activity_description',
        'D\u00e9crivez l\u2019activit\u00e9 du client (description de l\u2019activit\u00e9).');
      values.activity_description = desc;
    }
    if (spec.school_required) {
      const sc = reqText(body, 'school_name');
      if (!sc) return err('ecole_requise', 'school_name',
        'Indiquez le nom de l\u2019universit\u00e9 ou de l\u2019\u00e9cole.');
      values.school_name = sc;
    }
    if (spec.types && spec.types.length) {
      const ips = reqText(body, 'income_proof_status');
      if (spec.proof_required) {
        if (ips !== 'recu') return err('justif_revenu_requis', 'income_proof_status',
          'Cochez \u00ab ' + spec.proof_label + ' \u00bb.');
      } else if (spec.proof_optional) {
        if (!ips || !codes(PROOF_STATUSES).includes(ips)) return err('justif_activite_etudiant_requis', 'income_proof_status',
          'Indiquez si le justificatif d\u2019activit\u00e9 est re\u00e7u ou non re\u00e7u.');
      }
      values.income_proof_status = ips || null;
      if (ips === 'recu') {
        const ipt = reqText(body, 'income_proof_type');
        const allowed = codes(spec.types);
        if (!ipt || !allowed.includes(ipt)) return err('justif_revenu_type_requis', 'income_proof_type',
          'Choisissez le justificatif (' + spec.types.map((t) => t.label).join(', ') + ').');
        values.income_proof_type = ipt;
      }
    }
  }

  return { ok: true, values };
}

// ---------------------------------------------------------------------------
// CONFRONTATION DES PIÈCES : le scan reçu est confronté aux informations
// saisies. Le serveur recalcule lui-même la conformité (source de vérité) :
// l'agent ne peut pas forcer un champ non conforme à « conforme ».
// ---------------------------------------------------------------------------

// Champs clés confrontés au document scanné (clé = colonne du client).
export const CONFORMITY_FIELDS = [
  { key: 'last_name',         label: 'Nom', kind: 'text' },
  { key: 'first_name',        label: 'Prénom', kind: 'text' },
  { key: 'birth_date',        label: 'Date de naissance', kind: 'date' },
  { key: 'birth_place',       label: 'Lieu de naissance', kind: 'text' },
  { key: 'id_doc_number',     label: 'N° de la pièce', kind: 'idnum' },
  { key: 'id_doc_issue_date', label: 'Date d’établissement', kind: 'date' },
];

const normTxt = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const normId = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
const normDate = (s) => {
  if (!s) return '';
  const d = (s instanceof Date) ? s : new Date(String(s).length <= 10 ? String(s) + 'T00:00:00Z' : s);
  return isNaN(d.getTime()) ? normTxt(s) : d.toISOString().slice(0, 10);
};
function sameValue(kind, expected, scanned) {
  if (kind === 'idnum') return normId(expected) === normId(scanned);
  if (kind === 'date') return normDate(expected) === normDate(scanned);
  return normTxt(expected) === normTxt(scanned);
}

// client = ligne du client ; scanned = map { field_key: valeur lue sur le scan }.
// Retourne { checks:[{field_key,field_label,expected,scanned,is_conform}],
//            non_conform:[...], all_conform, reviewed_count }.
export function buildConformityChecks(client, scanned) {
  scanned = scanned || {};
  const checks = [];
  for (const f of CONFORMITY_FIELDS) {
    if (!(f.key in scanned)) continue; // champ non confronté (scan illisible)
    const expectedRaw = client ? client[f.key] : null;
    const scannedRaw = scanned[f.key];
    const expected = f.kind === 'date' ? normDate(expectedRaw) : String(expectedRaw == null ? '' : expectedRaw).trim();
    const scannedVal = f.kind === 'date' ? normDate(scannedRaw) : String(scannedRaw == null ? '' : scannedRaw).trim();
    const is_conform = sameValue(f.kind, expectedRaw, scannedRaw);
    checks.push({ field_key: f.key, field_label: f.label, expected, scanned: scannedVal, is_conform });
  }
  const non_conform = checks.filter((c) => !c.is_conform);
  return {
    checks,
    non_conform,
    reviewed_count: checks.length,
    all_conform: checks.length > 0 && non_conform.length === 0,
  };
}
