// teebo — Typologie client (source unique côté serveur).
// -----------------------------------------------------------------------------
// Arbre en cascade servi tel quel au front (GET /api/v1/client-meta), qui en
// déduit les listes déroulantes successives. Le même arbre sert à VALIDER la
// cohérence de la saisie côté serveur (impossible de forcer une combinaison
// invalide via l'API).
//
// Modèle de nœud :
//   { field, label, required, options:[ { code, label, children?:[ nœud... ] } ] }
// Les enfants d'une OPTION sont les sous-champs qui apparaissent quand cette
// option est choisie (plusieurs champs parallèles possibles).

export const CLIENT_TYPOLOGY = {
  field: 'client_category', label: 'Type de client', required: true,
  options: [
    {
      code: 'particulier', label: 'Particulier',
      children: [
        { field: 'gender', label: 'Genre', required: true, options: [
          { code: 'feminin', label: 'F\u00e9minin' },
          { code: 'masculin', label: 'Masculin' },
        ] },
        { field: 'profession', label: 'Profession', required: true, options: [
          { code: 'salarie', label: 'Salari\u00e9', children: [
            { field: 'profession_detail', label: 'Secteur', required: true, options: [
              { code: 'secteur_public', label: 'Secteur public' },
              { code: 'secteur_prive', label: 'Secteur priv\u00e9' },
            ] },
          ] },
          { code: 'informel', label: 'Travailleur informel', children: [
            { field: 'profession_detail', label: 'Type d\u2019activit\u00e9', required: true, options: [
              { code: 'commercant', label: 'Commer\u00e7ant' },
              { code: 'artisan', label: 'Artisan' },
              { code: 'agriculteur', label: 'Agriculteur' },
            ] },
          ] },
          { code: 'retraite', label: 'Retrait\u00e9', children: [
            { field: 'profession_detail', label: 'Statut', required: true, options: [
              { code: 'retraite', label: 'Retrait\u00e9' },
            ] },
          ] },
          { code: 'etudiant', label: '\u00c9tudiant', children: [
            { field: 'profession_detail', label: 'Statut', required: true, options: [
              { code: 'etudiant', label: '\u00c9tudiant' },
            ] },
          ] },
        ] },
      ],
    },
    {
      code: 'groupe', label: 'Groupe',
      children: [
        { field: 'group_type', label: 'Type de groupe', required: true, options: [
          { code: 'informel', label: 'Groupe informel' },
          { code: 'cooperative', label: 'Coop\u00e9rative' },
          { code: 'association', label: 'Association' },
          { code: 'ong', label: 'ONG' },
        ] },
      ],
    },
    {
      code: 'entreprise', label: 'Entreprise',
      children: [
        { field: 'enterprise_segment', label: 'Cat\u00e9gorie d\u2019entreprise', required: true, options: [
          { code: 'tpme_pme', label: 'Tr\u00e8s Petite et Moyenne Entreprise (TPME/PME)', children: [
            { field: 'legal_form', label: 'Forme juridique', required: true, options: [
              { code: 'sarl', label: 'SARL' },
              { code: 'sa', label: 'SA' },
              { code: 'sas', label: 'SAS' },
              { code: 'entreprise_individuelle', label: 'Entreprise individuelle' },
            ] },
          ] },
          { code: 'grande_multinationale', label: 'Grande Entreprise et Multinationale', children: [
            { field: 'legal_form', label: 'Forme juridique', required: true, options: [
              { code: 'sa', label: 'SA' },
              { code: 'sas', label: 'SAS' },
            ] },
          ] },
          { code: 'institution_publique', label: 'Institution et organisme public', children: [
            { field: 'legal_form', label: 'Forme juridique', required: true, options: [
              { code: 'collectivite_locale', label: 'Collectivit\u00e9 locale' },
              { code: 'etablissement_public', label: '\u00c9tablissement public' },
              { code: 'projet_developpement', label: 'Projet de d\u00e9veloppement' },
            ] },
          ] },
        ] },
      ],
    },
  ],
};

// Tous les champs typologiques gérés (pour nettoyage/persistance).
export const TYPOLOGY_FIELDS = [
  'client_category', 'gender', 'profession', 'profession_detail',
  'group_type', 'enterprise_segment', 'legal_form',
];

// Valide une saisie contre l'arbre. Retourne { ok, values, error? }.
// values ne contient QUE les champs effectivement attendus par la cascade
// choisie (les autres sont forcés à null pour éviter les résidus incohérents).
export function validateTypology(body) {
  const values = {};
  for (const f of TYPOLOGY_FIELDS) values[f] = null;

  function walkNode(node) {
    const raw = body[node.field];
    const val = raw === undefined || raw === null || raw === '' ? null : String(raw);
    if (val === null) {
      if (node.required) return { ok: false, error: 'typologie_incomplete', field: node.field };
      return { ok: true };
    }
    const opt = node.options.find((o) => o.code === val);
    if (!opt) return { ok: false, error: 'typologie_valeur_invalide', field: node.field, value: val };
    values[node.field] = val;
    if (opt.children && opt.children.length) {
      for (const child of opt.children) {
        const r = walkNode(child);
        if (!r.ok) return r;
      }
    }
    return { ok: true };
  }

  const r = walkNode(CLIENT_TYPOLOGY);
  if (!r.ok) return r;
  return { ok: true, values };
}
