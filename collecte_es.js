// ===========================================================================
// teebo — VAGUE 37 : MODULE COLLECTE & ÉPARGNE (socle métier sécurisé)
// ===========================================================================
// Ce fichier ne contient AUCUN accès HTTP : uniquement la logique, pour
// pouvoir la tester sans base de données. Les routes (routes/collecte_es.js)
// lui passent un client de transaction déjà placé sous contexte tenant.
//
// Règles appliquées partout :
//   • montants en FCFA : ENTIERS de centimes, jamais de flottant ;
//   • toute écriture est idempotente (uuid généré par le terminal) ;
//   • une opération validée ne se modifie pas : on contre-passe ;
//   • on ne sort JAMAIS de l'IMF de l'utilisateur (tenant_id).
// ===========================================================================

/** Canaux d'encaissement autorisés (ceux de la base). */
export const CANAUX = Object.freeze([
  'TERRAIN_CASH', 'GUICHET', 'ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'
]);

/** Canaux qui exigent une référence de l'opérateur (anti-fraude). */
export const CANAUX_AVEC_REF = Object.freeze([
  'ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'
]);

/** Coupures FCFA officielles (billets et pièces) — pour le billetage. */
export const COUPURES_FCFA = Object.freeze([
  { valeur: 10000, type: 'billet' },
  { valeur: 5000,  type: 'billet' },
  { valeur: 2000,  type: 'billet' },
  { valeur: 1000,  type: 'billet' },
  { valeur: 500,   type: 'piece'  },
  { valeur: 250,   type: 'piece'  },
  { valeur: 100,   type: 'piece'  }
]);

export const STATUTS_SYNC = Object.freeze([
  'EN_ATTENTE_SYNC', 'SYNCHRONISE', 'REJETE_DOUBLON', 'REJETE'
]);

export const MOTIF_CP_DEFAUT = 'contre-passation demandee';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function estUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Erreur métier porteuse d'un statut HTTP et d'un code stable pour le site. */
export class CollecteError extends Error {
  constructor(code, message, detail = null, status = 422) {
    super(message);
    this.name = 'CollecteError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Convertit un montant FCFA (chaîne « 12500 », « 12 500 », « 12500.00 »)
 * en ENTIER de centimes. Refuse tout ce qui n'est pas un entier positif net :
 * jamais d'arrondi silencieux sur de l'argent.
 */
export function montantEnCentimes(valeur, champ = 'montant') {
  if (valeur === null || valeur === undefined || valeur === '') {
    throw new CollecteError('montant_absent', 'Le ' + champ + ' est obligatoire.', { champ }, 400);
  }
  if (typeof valeur === 'number' && !Number.isInteger(valeur)) {
    throw new CollecteError('montant_decimal',
      'Le ' + champ + ' doit être un nombre entier de FCFA (pas de centimes).', { champ }, 400);
  }
  const brut = String(valeur).replace(/[\s\u00a0]/g, '').replace(/,/g, '.');
  if (!/^-?[0-9]+(\.[0-9]{1,2})?$/.test(brut)) {
    throw new CollecteError('montant_invalide',
      'Le ' + champ + ' comporte des caractères inattendus.', { champ, valeur: String(valeur) }, 400);
  }
  const [ent, dec = ''] = brut.split('.');
  const negatif = ent.startsWith('-');
  const entier = (negatif ? ent.slice(1) : ent) || '0';
  const centiemes = (dec + '00').slice(0, 2);
  let cents = BigInt(entier) * 100n + BigInt(centiemes);
  if (negatif) cents = -cents;
  if (cents > 9007199254740991n) {
    throw new CollecteError('montant_trop_grand', 'Le ' + champ + ' dépasse la limite autorisée.', { champ }, 400);
  }
  return Number(cents);
}

/** Contrôle de forme d'un envoi de synchronisation (avant toute requête). */
export function validerEvenement(ev) {
  if (!ev || typeof ev !== 'object') {
    throw new CollecteError('evenement_vide', 'Un événement de synchronisation est vide.', null, 400);
  }
  if (!estUuid(ev.uuid_local)) {
    throw new CollecteError('uuid_local_invalide',
      'Chaque opération doit porter l’identifiant unique généré par le téléphone.',
      { champ: 'uuid_local' }, 400);
  }
  const montant = montantEnCentimes(ev.montant, 'montant');
  if (montant <= 0) {
    throw new CollecteError('montant_non_positif',
      'Le montant collecté doit être supérieur à zéro.', null, 400);
  }
  const canal = ev.canal || 'TERRAIN_CASH';
  if (!CANAUX.includes(canal)) {
    throw new CollecteError('canal_inconnu',
      'Canal d’encaissement inconnu : ' + canal + '.', { canaux: CANAUX }, 400);
  }
  if (CANAUX_AVEC_REF.includes(canal)) {
    const ref = ev.reference_externe_mm ? String(ev.reference_externe_mm).trim() : '';
    if (ref.length < 4) {
      throw new CollecteError('reference_mm_manquante',
        'Pour un encaissement ' + canal + ', la référence de la transaction opérateur est obligatoire.',
        { champ: 'reference_externe_mm' }, 422);
    }
  }
  if (ev.gps_lat != null || ev.gps_lng != null) {
    const lat = Number(ev.gps_lat); const lng = Number(ev.gps_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new CollecteError('gps_invalide',
        'Position GPS illisible : la collecte ne peut pas être localisée.', null, 422);
    }
  }
  let quand = null;
  if (ev.date_operation_locale) {
    quand = new Date(ev.date_operation_locale);
    if (isNaN(quand.getTime())) {
      throw new CollecteError('date_locale_invalide',
        'La date enregistrée par le téléphone est illisible.', null, 422);
    }
    if (quand.getTime() > Date.now() + 15 * 60000) {
      throw new CollecteError('horloge_en_avance',
        'La date du téléphone est en avance sur le serveur. Réglez la date du téléphone puis relancez la synchronisation.',
        { date_telephone: quand.toISOString(), heure_serveur: new Date().toISOString() }, 409);
    }
  }
  return {
    uuid_local: ev.uuid_local,
    montant_cents: montant,
    canal,
    reference_externe_mm: ev.reference_externe_mm ? String(ev.reference_externe_mm).trim() : null,
    gps_lat: ev.gps_lat != null ? Number(ev.gps_lat) : null,
    gps_lng: ev.gps_lng != null ? Number(ev.gps_lng) : null,
    date_operation_locale: quand,
    code_client: ev.code_client || null,
    account_id: estUuid(ev.account_id) ? ev.account_id : null,
    carnet_id: estUuid(ev.carnet_id) ? ev.carnet_id : null,
    type: ev.type || 'depot'
  };
}

/**
 * Détermine ce qui doit arriver à un événement, sans rien écrire :
 *   • neuf            → à enregistrer ;
 *   • doublon         → REJETE_DOUBLON (même identifiant terminal déjà reçu) ;
 *   • doublon_mm      → REJETE_DOUBLON (référence opérateur déjà utilisée) ;
 *   • carnet_ferme    → refus métier.
 * `existant` = { par_uuid, par_ref } fournis par la couche base.
 */
export function classerEvenement(ev, existant = {}) {
  if (existant.par_uuid) {
    return { etat: 'doublon', motif: 'Identifiant du téléphone déjà synchronisé',
      cible: existant.par_uuid };
  }
  if (existant.par_ref) {
    return { etat: 'doublon_mm', motif: 'Référence opérateur déjà enregistrée',
      cible: existant.par_ref };
  }
  return { etat: 'neuf', motif: null, cible: null };
}

/** Statut de synchronisation à écrire en base selon la classification. */
export function statutPour(etat) {
  if (etat === 'neuf') return 'SYNCHRONISE';
  if (etat === 'doublon' || etat === 'doublon_mm') return 'REJETE_DOUBLON';
  return 'REJETE';
}

/* -------------------------------------------------------------------------
 *  CARNET TONTINE : cycle de 31 jours + commission IMF
 * ---------------------------------------------------------------------- */

/** Ajoute un nombre de jours à une date (sans passer par l'heure locale). */
export function ajouterJours(iso, jours) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new CollecteError('date_invalide', 'Date de départ invalide.', { iso }, 400);
  d.setUTCDate(d.getUTCDate() + Number(jours));
  return d.toISOString().slice(0, 10);
}

/**
 * Plan de cycle d'un carnet : début, fin (début + cycle_jours - 1 inclus),
 * numéro de cycle et date de clôture effective.
 */
export function planCycle({ dateDebut, cycleJours = 31, numeroPrecedent = 0 }) {
  if (!(Number(cycleJours) >= 1 && Number(cycleJours) <= 366)) {
    throw new CollecteError('cycle_invalide', 'La durée du cycle doit être comprise entre 1 et 366 jours.', null, 400);
  }
  const debut = String(dateDebut || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return {
    date_debut: debut,
    date_fin: ajouterJours(debut, Number(cycleJours) - 1),
    cycle_jours: Number(cycleJours),
    cycle_numero: Number(numeroPrecedent || 0) + 1
  };
}

/**
 * Répartition d'un montant entre commission IMF et part du client.
 * Arrondi « demi vers le haut » sur la commission ; la part client est le
 * RESTE (jamais un centime perdu ni inventé).
 */
export function repartirCommission(montantCents, commissionBp) {
  const m = BigInt(montantCents);
  const bp = BigInt(Math.max(0, Math.min(10000, Number(commissionBp || 0))));
  if (m < 0n) throw new CollecteError('montant_negatif', 'Un montant de cotisation ne peut pas être négatif.', null, 400);
  let commission = (m * bp + 5000n) / 10000n;   // +5000 = arrondi demi vers le haut
  if (commission > m) commission = m;
  return {
    montant_cents: Number(m),
    commission_imf_cents: Number(commission),
    net_client_cents: Number(m - commission)
  };
}

/** Un carnet arrive-t-il à échéance ? (date_fin incluse) */
export function carnetEchu(dateFin, aujourdhui) {
  const fin = String(dateFin).slice(0, 10);
  const jour = String(aujourdhui || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return jour > fin;
}

/* -------------------------------------------------------------------------
 *  BILLETAGE ET ARRÊTÉ DE CAISSE
 * ---------------------------------------------------------------------- */

/**
 * Calcule le billetage à partir de { "10000": 3, "500": 2 } (nombre de
 * coupures). Retourne le détail ligne par ligne et le TOTAL compté en centimes.
 */
export function calculerBilletage(nombres = {}) {
  const lignes = [];
  let totalCents = 0;
  for (const c of COUPURES_FCFA) {
    const brut = nombres[String(c.valeur)] ?? nombres[c.valeur] ?? 0;
    const n = Number(brut);
    if (!Number.isInteger(n) || n < 0) {
      throw new CollecteError('billetage_invalide',
        'Nombre de coupures invalide pour ' + c.valeur + ' FCFA.', { valeur: c.valeur }, 400);
    }
    const montant = c.valeur * n * 100;
    totalCents += montant;
    if (n > 0) lignes.push({ coupure: c.valeur, type_coupure: c.type, nombre: n, montant_cents: montant });
  }
  const inconnues = Object.keys(nombres || {})
    .filter((k) => !COUPURES_FCFA.some((c) => String(c.valeur) === String(k)))
    .filter((k) => Number(nombres[k]) > 0);
  if (inconnues.length) {
    throw new CollecteError('coupure_inconnue',
      'Coupure non reconnue : ' + inconnues.join(', ') + ' FCFA.',
      { coupures_valides: COUPURES_FCFA.map((c) => c.valeur) }, 400);
  }
  return { lignes, total_cents: totalCents };
}

/**
 * Arrêté de caisse : théorique (système) vs compté (billetage).
 * Un écart NON NUL exige une justification (règle BCEAO reprise de la v16).
 */
export function arreterCaisse({ theoriqueCents, billetage, justification }) {
  const theo = Number(theoriqueCents || 0);
  const calcul = Array.isArray(billetage)
    ? { lignes: billetage, total_cents: billetage.reduce((s, l) => s + Number(l.montant_cents || 0), 0) }
    : calculerBilletage(billetage || {});
  const ecart = calcul.total_cents - theo;
  if (ecart !== 0) {
    const j = String(justification || '').trim();
    if (j.length < 10) {
      throw new CollecteError('ecart_non_justifie',
        'Un écart de caisse de ' + (ecart / 100).toLocaleString('fr-FR') +
        ' FCFA doit être justifié (10 caractères minimum) avant la clôture.',
        { ecart_cents: ecart }, 422);
    }
  }
  return {
    theorique_cents: theo,
    compte_cents: calcul.total_cents,
    ecart_cents: ecart,
    statut: ecart === 0 ? 'equilibre' : 'ecart',
    lignes: calcul.lignes,
    ecart_libelle: (ecart / 100).toLocaleString('fr-FR') + ' FCFA'
  };
}

/* -------------------------------------------------------------------------
 *  REÇUS : référence unique et messages
 * ---------------------------------------------------------------------- */

/** Référence de reçu unique par IMF : REC-<IMF court>-<AAAA>-<n° sur 6>. */
export function referenceRecu({ codeImf, annee, numero }) {
  const court = String(codeImf || 'IMF').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase() || 'IMF';
  const n = String(Math.max(1, Number(numero) || 1)).padStart(6, '0');
  return 'REC-' + court + '-' + (annee || new Date().getFullYear()) + '-' + n;
}

/** Message du reçu (même formulation pour SMS et WhatsApp). */
export function messageRecu({ imfName, reference, montantCents, soldeCents, clientName }) {
  const f = (c) => (Number(c || 0) / 100).toLocaleString('fr-FR');
  return [
    (imfName ? imfName + ' : ' : '') + 'Reçu n° ' + reference + '.',
    clientName ? 'Client : ' + clientName + '.' : null,
    'Montant reçu : ' + f(montantCents) + ' FCFA.',
    soldeCents != null ? 'Nouveau solde : ' + f(soldeCents) + ' FCFA.' : null,
    'Merci de votre confiance.'
  ].filter(Boolean).join(' ');
}

/** Canaux de notification autorisés. */
export const CANAUX_NOTIF = Object.freeze(['SMS', 'WHATSAPP', 'IMPRESSION']);

export function preparerNotifications({ reference, montantCents, soldeCents, imfName, clientName, telephone, imprimante, canaux }) {
  const voulus = Array.isArray(canaux) && canaux.length ? canaux : ['SMS'];
  const out = [];
  for (const c of voulus) {
    if (!CANAUX_NOTIF.includes(c)) {
      throw new CollecteError('canal_notification_inconnu',
        'Canal de notification inconnu : ' + c + '.', { canaux: CANAUX_NOTIF }, 400);
    }
    if ((c === 'SMS' || c === 'WHATSAPP') && !telephone) {
      throw new CollecteError('client_sans_telephone',
        'Ce client n’a pas de numéro de téléphone : ' + c + ' impossible. Imprimez le reçu.', null, 422);
    }
    out.push({
      canal: c,
      destinataire: c === 'IMPRESSION' ? (imprimante || 'Imprimante caisse') : telephone,
      contenu: messageRecu({ imfName, reference, montantCents, soldeCents, clientName }),
      statut: 'EN_ATTENTE'
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
 *  RÉCAPITULATIF D'UNE VAGUE DE SYNCHRONISATION
 * ---------------------------------------------------------------------- */

export function resumerVague(resultats) {
  const r = Array.isArray(resultats) ? resultats : [];
  const compte = (s) => r.filter((x) => x.statut === s).length;
  return {
    total: r.length,
    synchronises: compte('SYNCHRONISE'),
    doublons: compte('REJETE_DOUBLON'),
    rejetes: compte('REJETE'),
    montant_synchronise_cents: r.filter((x) => x.statut === 'SYNCHRONISE')
      .reduce((s, x) => s + Number(x.montant_cents || 0), 0),
    resultats: r
  };
}

export default {
  CANAUX, CANAUX_AVEC_REF, CANAUX_NOTIF, COUPURES_FCFA, STATUTS_SYNC,
  CollecteError, estUuid, montantEnCentimes, validerEvenement, classerEvenement,
  statutPour, ajouterJours, planCycle, repartirCommission, carnetEchu,
  calculerBilletage, arreterCaisse, referenceRecu, messageRecu,
  preparerNotifications, resumerVague
};
