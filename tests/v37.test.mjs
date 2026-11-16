// =========================================================================
// teebo — TESTS VAGUE 37 : module Collecte & Épargne (logique pure)
// -------------------------------------------------------------------------
// Aucune base de données requise : on teste les fonctions de collecte_es.js
// (montants, synchronisation, tontine 31 jours, billetage, reçus).
// =========================================================================
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve(process.cwd(), 'backend/src');
let passes = 0; let fails = 0;
function ok(nom, cond, detail) {
  if (cond) { passes += 1; console.log('  OK   ' + nom); }
  else { fails += 1; console.log('  FAIL ' + nom + (detail ? '  -> ' + detail : '')); }
}
function lance(nom, fn) {
  try { return fn(); } catch (e) { ok(nom + ' (ne doit pas lever)', false, e.code + ' ' + e.message); return null; }
}
function rejette(nom, fn, code) {
  try { fn(); ok(nom, false, 'aucune erreur alors que ' + code + ' attendu'); }
  catch (e) { ok(nom + ' -> ' + code, e.code === code, 'code reçu : ' + e.code); }
}

const M = await import(pathToFileURL(path.join(SRC, 'collecte_es.js')).href);

console.log('\n— 1. Montants FCFA (jamais de flottant) —');
ok('12 500 FCFA -> 1250000 centimes', M.montantEnCentimes('12 500') === 1250000);
ok('« 12500.50 » accepté', M.montantEnCentimes('12500.50') === 1250050);
ok('12500 entier accepté', M.montantEnCentimes(12500) === 1250000);
rejette('un flottant est refusé', () => M.montantEnCentimes(12.5), 'montant_decimal');
rejette('texte refusé', () => M.montantEnCentimes('douze mille'), 'montant_invalide');
rejette('montant vide refusé', () => M.montantEnCentimes(''), 'montant_absent');
ok('gros montant exact (pas d’arrondi)', M.montantEnCentimes('90000000') === 9000000000);

console.log('\n— 2. Validation d’un événement hors-ligne —');
const U1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const evOk = lance('événement complet valide', () => M.validerEvenement({
  uuid_local: U1, montant: '5000', canal: 'TERRAIN_CASH',
  gps_lat: 5.3599, gps_lng: -4.0083, date_operation_locale: '2026-11-15T08:30:00Z'
}));
ok('montant converti en centimes', evOk && evOk.montant_cents === 500000);
ok('GPS conservé', evOk && evOk.gps_lat === 5.3599);
rejette('sans uuid terminal -> refus', () => M.validerEvenement({ montant: '100', canal: 'TERRAIN_CASH' }), 'uuid_local_invalide');
rejette('montant nul -> refus', () => M.validerEvenement({ uuid_local: U1, montant: '0' }), 'montant_non_positif');
rejette('canal inconnu -> refus', () => M.validerEvenement({ uuid_local: U1, montant: '100', canal: 'BITCOIN' }), 'canal_inconnu');
rejette('Wave sans référence opérateur -> refus',
  () => M.validerEvenement({ uuid_local: U1, montant: '100', canal: 'WAVE' }), 'reference_mm_manquante');
ok('Wave AVEC référence accepté', !!lance('wave ok', () => M.validerEvenement({
  uuid_local: U1, montant: '100', canal: 'WAVE', reference_externe_mm: 'WV778812' })));
rejette('GPS hors bornes -> refus',
  () => M.validerEvenement({ uuid_local: U1, montant: '100', gps_lat: 120, gps_lng: 0 }), 'gps_invalide');
rejette('horloge du téléphone en avance -> refus',
  () => M.validerEvenement({ uuid_local: U1, montant: '100',
    date_operation_locale: new Date(Date.now() + 3600000).toISOString() }), 'horloge_en_avance');

console.log('\n— 3. Idempotence : doubles envois —');
ok('événement neuf -> à enregistrer', M.classerEvenement({}, {}).etat === 'neuf');
ok('même uuid déjà reçu -> doublon', M.classerEvenement({}, { par_uuid: { id: 'op1' } }).etat === 'doublon');
ok('même référence Wave -> doublon',
  M.classerEvenement({}, { par_ref: { id: 'op2' } }).etat === 'doublon_mm');
ok('statut neuf = SYNCHRONISE', M.statutPour('neuf') === 'SYNCHRONISE');
ok('statut doublon = REJETE_DOUBLON', M.statutPour('doublon') === 'REJETE_DOUBLON');
ok('statut doublon MM = REJETE_DOUBLON', M.statutPour('doublon_mm') === 'REJETE_DOUBLON');
const vague = M.resumerVague([
  { statut: 'SYNCHRONISE', montant_cents: 500000 },
  { statut: 'SYNCHRONISE', montant_cents: 250000 },
  { statut: 'REJETE_DOUBLON', montant_cents: 500000 },
  { statut: 'REJETE', montant_cents: 0 }
]);
ok('récapitulatif : 2 synchronisés', vague.synchronises === 2);
ok('récapitulatif : 1 doublon', vague.doublons === 1);
ok('récapitulatif : 1 rejeté', vague.rejetes === 1);
ok('montant synchronisé = 750 000 centimes', vague.montant_synchronise_cents === 750000);

console.log('\n— 4. Carnet tontine : cycle de 31 jours —');
const plan = M.planCycle({ dateDebut: '2026-11-01', cycleJours: 31, numeroPrecedent: 0 });
ok('début = 01/11/2026', plan.date_debut === '2026-11-01');
ok('fin = 01/12/2026 (31 jours inclus)', plan.date_fin === '2026-12-01', plan.date_fin);
ok('cycle n°1', plan.cycle_numero === 1);
const plan2 = M.planCycle({ dateDebut: '2026-11-01', cycleJours: 31, numeroPrecedent: 1 });
ok('cycle suivant n°2', plan2.cycle_numero === 2);
ok('31 jours : 30/11 non échu', M.carnetEchu('2026-11-30', '2026-11-30') === false);
ok('31 jours : 01/12 échu le 02/12', M.carnetEchu('2026-12-01', '2026-12-02') === true);
const c5 = M.repartirCommission(500000, 500);
ok('5 % de 5 000 FCFA = 250 FCFA IMF', c5.commission_imf_cents === 25000, JSON.stringify(c5));
ok('part client = 4 750 FCFA', c5.net_client_cents === 475000);
ok('commission + part = montant (jamais de perte)',
  c5.commission_imf_cents + c5.net_client_cents === c5.montant_cents);
const c3 = M.repartirCommission(3333, 500);
ok('arrondi demi vers le haut (166,65 -> 167)', c3.commission_imf_cents === 167, JSON.stringify(c3));
ok('reste exact au client', c3.net_client_cents === 3166 &&
  c3.commission_imf_cents + c3.net_client_cents === 3333);
ok('commission 0 % = tout au client', M.repartirCommission(100000, 0).net_client_cents === 100000);

console.log('\n— 5. Billetage FCFA et arrêté de caisse —');
const bil = M.calculerBilletage({ 10000: 3, 5000: 2, 500: 4, 250: 2, 100: 5 });
ok('total billetage = 43 000 FCFA', bil.total_cents === 4300000, String(bil.total_cents));
ok('5 lignes non vides', bil.lignes.length === 5, JSON.stringify(bil.lignes));
ok('coupure 10 000 = billet', bil.lignes[0].type_coupure === 'billet');
ok('coupure 500 = pièce', bil.lignes.find((l) => l.coupure === 500).type_coupure === 'piece');
rejette('coupure inexistante (3000) refusée',
  () => M.calculerBilletage({ 3000: 1 }), 'coupure_inconnue');
rejette('nombre de coupures non entier refusé',
  () => M.calculerBilletage({ 1000: 1.5 }), 'billetage_invalide');
const eq0 = M.arreterCaisse({ theoriqueCents: 4300000, billetage: { 10000: 3, 5000: 2, 500: 4, 250: 2, 100: 5 } });
ok('caisse équilibrée -> statut equilibre', eq0.statut === 'equilibre');
ok('écart nul', eq0.ecart_cents === 0);
rejette('écart sans justification refusé',
  () => M.arreterCaisse({ theoriqueCents: 4170000, billetage: { 10000: 3, 5000: 2, 500: 4, 250: 2, 100: 5 } }),
  'ecart_non_justifie');
const av = M.arreterCaisse({ theoriqueCents: 4170000,
  billetage: { 10000: 3, 5000: 2, 500: 4, 250: 2, 100: 5 },
  justification: 'Billet de 10 000 FCFA remis au coffre avant comptage' });
ok('écart justifié -> statut ecart', av.statut === 'ecart');
ok('écart = 13 000 FCFA (1 300 000 centimes)', av.ecart_cents === 130000, String(av.ecart_cents));

console.log('\n— 6. Reçus et notifications —');
const ref = M.referenceRecu({ codeImf: 'TBO-CI-000123', annee: 2026, numero: 7 });
ok('référence lisible et unique', ref === 'REC-000123-2026-000007', ref);
const msg = M.messageRecu({ imfName: 'IMF Test', reference: ref, montantCents: 500000,
  soldeCents: 1250000, clientName: 'Awa Traoré' });
ok('message contient la référence', msg.includes(ref));
ok('message contient 5 000 FCFA', msg.includes('5' + String.fromCharCode(8239) + '000'), msg);
ok('message contient le nouveau solde', msg.includes('12' + String.fromCharCode(8239) + '500'));
const notifs = M.preparerNotifications({ reference: ref, montantCents: 500000,
  soldeCents: 1250000, imfName: 'IMF Test', clientName: 'Awa', telephone: '+2250700000000',
  canaux: ['SMS', 'WHATSAPP', 'IMPRESSION'] });
ok('3 notifications préparées', notifs.length === 3);
ok('toutes en attente d’envoi', notifs.every((n) => n.statut === 'EN_ATTENTE'));
ok('impression sans numéro de téléphone',
  notifs.find((n) => n.canal === 'IMPRESSION').destinataire === 'Imprimante caisse');
rejette('SMS sans téléphone refusé', () => M.preparerNotifications({ reference: ref,
  montantCents: 100, telephone: null, canaux: ['SMS'] }), 'client_sans_telephone');
rejette('canal inconnu refusé', () => M.preparerNotifications({ reference: ref,
  montantCents: 100, telephone: '0700', canaux: ['PIGEON'] }), 'canal_notification_inconnu');

console.log('\n— 7. Référentiels conformes —');
ok('6 canaux d’encaissement', M.CANAUX.length === 6);
ok('4 canaux Mobile Money / BCEAO à référence obligatoire', M.CANAUX_AVEC_REF.length === 4);
ok('7 coupures FCFA officielles', M.COUPURES_FCFA.length === 7);
ok('coupures = 10000…100', M.COUPURES_FCFA.map((c) => c.valeur).join(',') === '10000,5000,2000,1000,500,250,100');
ok('4 statuts de synchronisation', M.STATUTS_SYNC.length === 4);

console.log('\n=========================================');
console.log('  RESULTAT V37 : ' + passes + ' OK / ' + fails + ' FAIL');
console.log('=========================================');
process.exit(fails ? 1 : 0);
