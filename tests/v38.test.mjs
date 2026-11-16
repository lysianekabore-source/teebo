// =========================================================================
// teebo — TESTS VAGUE 38 : MOTEUR DE CRÉDIT (logique pure, sans base)
// -------------------------------------------------------------------------
// Couvre : échéanciers (3 méthodes + différé), intégrité du capital, TEG,
// frais/assurance/épargne, imputation BCEAO, classes et provisions, PAR 30/90,
// transitions d'états, 4 yeux, validation hors-ligne, références.
// Lancer :  node tests/v38.test.mjs
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

const M = await import(pathToFileURL(path.join(SRC, 'credit_engine.js')).href);
const somme = (l, k) => l.reduce((s, x) => s + Number(x[k] || 0), 0);

// ----------------------------------------------------------------------
console.log('\n— 1. Échéancier DÉGRESSIF (annuités constantes) —');
const ec1 = lance('échéancier 1 000 000 / 12 mois à 12 %', () => M.construireEcheancier({
  montant_cents: 1000000, taux_nominal_bp: 1200, duree_mois: 12,
  periodicite: 'MENSUELLE', methode: 'DEGRESSIF', date_debut: '2026-11-15',
  differe_mois: 0, differe_type: 'AUCUN', assurance_cents: 0
}));
ok('12 échéances', ec1.nombre_echeances === 12, String(ec1.nombre_echeances));
ok('somme du capital = montant financé', somme(ec1.lignes, 'capital_cents') === 1000000,
  String(somme(ec1.lignes, 'capital_cents')));
ok('capital au dernier solde = 0', ec1.lignes[11].solde_capital_cents === 0);
ok('intérêts ~ 66 186 FCFA', Math.abs(ec1.total_interets_cents - 66186) <= 2,
  String(ec1.total_interets_cents));
ok('intérêts décroissants', ec1.lignes[0].interet_cents > ec1.lignes[5].interet_cents
  && ec1.lignes[5].interet_cents > ec1.lignes[11].interet_cents);
ok('capital croissant', ec1.lignes[0].capital_cents < ec1.lignes[11].capital_cents);
ok('1re échéance au 15/12/2026', ec1.lignes[0].date_echeance === '2026-12-15', ec1.lignes[0].date_echeance);

// ----------------------------------------------------------------------
console.log('\n— 2. Échéancier LINÉAIRE (capital constant) —');
const ec2 = lance('échéancier linéaire 12 mois', () => M.construireEcheancier({
  montant_cents: 1000000, taux_nominal_bp: 1200, duree_mois: 12,
  periodicite: 'MENSUELLE', methode: 'LINEAIRE', date_debut: '2026-11-15'
}));
ok('capital identique à chaque échéance', ec2.lignes.slice(0, 11).every((l) => l.capital_cents === 83333));
ok('somme du capital = montant', somme(ec2.lignes, 'capital_cents') === 1000000);
ok('intérêts = 65 000 FCFA', ec2.total_interets_cents === 65000, String(ec2.total_interets_cents));
ok('moins cher que le dégressif', ec2.total_interets_cents < ec1.total_interets_cents);

// ----------------------------------------------------------------------
console.log('\n— 3. Échéancier IN FINE —');
const ec3 = lance('in fine 6 mois', () => M.construireEcheancier({
  montant_cents: 1000000, taux_nominal_bp: 1200, duree_mois: 6,
  periodicite: 'MENSUELLE', methode: 'IN_FINE', date_debut: '2026-11-15'
}));
ok('capital remboursé seulement à la fin', ec3.lignes.slice(0, 5).every((l) => l.capital_cents === 0)
  && ec3.lignes[5].capital_cents === 1000000);
ok('somme du capital = montant', somme(ec3.lignes, 'capital_cents') === 1000000);
ok('intérêts = 60 000 FCFA', ec3.total_interets_cents === 60000, String(ec3.total_interets_cents));

// ----------------------------------------------------------------------
console.log('\n— 4. Différé (grâce) —');
const ec4 = lance('différé de 3 mois en intérêts', () => M.construireEcheancier({
  montant_cents: 1000000, taux_nominal_bp: 1200, duree_mois: 12,
  periodicite: 'MENSUELLE', methode: 'DEGRESSIF', date_debut: '2026-11-15',
  differe_mois: 3, differe_type: 'INTERETS'
}));
ok('3 lignes en différé marquées', ec4.lignes.filter((l) => l.en_differe).length === 3);
ok('aucun capital sur les 3 premières', ec4.lignes.slice(0, 3).every((l) => l.capital_cents === 0));
ok('intérêts payés pendant le différé', ec4.lignes[0].interet_cents > 0);
ok('somme du capital = montant', somme(ec4.lignes, 'capital_cents') === 1000000);
ok('coût plus élevé qu’un dégressif simple', ec4.total_interets_cents > ec1.total_interets_cents);
rejette('différé >= durée refusé', () => M.construireEcheancier({
  montant_cents: 1000000, taux_nominal_bp: 1200, duree_mois: 6,
  periodicite: 'MENSUELLE', methode: 'DEGRESSIF', date_debut: '2026-11-15',
  differe_mois: 6, differe_type: 'INTERETS'
}), 'differe_trop_long');

// ----------------------------------------------------------------------
console.log('\n— 5. Périodicités (hebdomadaire / mensuelle / trimestrielle) —');
ok('6 mois en hebdo = 26 échéances', M.nombreEcheances(6, 'HEBDOMADAIRE') === 26);
ok('12 mois en mensuel = 12 échéances', M.nombreEcheances(12, 'MENSUELLE') === 12);
ok('12 mois en trimestriel = 4 échéances', M.nombreEcheances(12, 'TRIMESTRIELLE') === 4);
ok('12 mois en bimensuel = 24 échéances', M.nombreEcheances(12, 'BIMENSUELLE') === 24);
rejette('périodicité inconnue refusée', () => M.nombreEcheances(12, 'JOURNALIERE'), 'periodicite_inconnue');
const ecH = lance('échéancier hebdomadaire', () => M.construireEcheancier({
  montant_cents: 300000, taux_nominal_bp: 2400, duree_mois: 6,
  periodicite: 'HEBDOMADAIRE', methode: 'LINEAIRE', date_debut: '2026-11-15'
}));
ok('1re échéance à 7 jours', ecH.lignes[0].date_echeance === '2026-11-22', ecH.lignes[0].date_echeance);
ok('somme du capital = montant (hebdo)', somme(ecH.lignes, 'capital_cents') === 300000);

// ----------------------------------------------------------------------
console.log('\n— 6. TEG (coût réel annuel) —');
const flux = (montant, n, annuite) => [...Array(n)].map(() => ({ montant_echeance_cents: annuite }));
ok('12 %/an mensuel -> TEG 12,00 %', M.calculerTeg({
  montant_net_cents: 1000000, lignes: flux(0, 12, 88849), periodicite: 'MENSUELLE'
}) === 1200);
ok('~1 %/semaine -> TEG ~19 %/an', Math.abs(M.calculerTeg({
  montant_net_cents: 1000000, lignes: flux(0, 52, 21166), periodicite: 'HEBDOMADAIRE'
}) - 1915) <= 60, String(M.calculerTeg({ montant_net_cents: 1000000, lignes: flux(0, 52, 21166), periodicite: 'HEBDOMADAIRE' })));
ok('sans coût -> TEG 0', M.calculerTeg({
  montant_net_cents: 1000000, lignes: flux(0, 12, 83334), periodicite: 'MENSUELLE'
}) === 0);
// 90 000 nets, 108 000 remboursés en 1 mois => 20 %/mois => 240 %/an.
ok('un seul versement avec 20 % de frais -> 240 %', Math.abs(M.calculerTeg({
  montant_net_cents: 90000, lignes: [{ montant_echeance_cents: 108000 }], periodicite: 'MENSUELLE'
}) - 24000) <= 30);
const sim1 = lance('simulation sans frais', () => M.simulerDossierCredit({
  montant_cents: 1000000, duree_mois: 12, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15', produit: {}
}));
ok('sans frais : TEG = taux nominal (12 %)', sim1.taux_teg_bp === 1200, String(sim1.taux_teg_bp));
const sim2 = lance('simulation avec frais', () => M.simulerDossierCredit({
  montant_cents: 1000000, duree_mois: 12, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15',
  produit: { frais_dossier_bp: 100, assurance_bp: 50 }
}));
ok('frais 1 % retenus = 10 000 FCFA', sim2.frais_dossier_cents === 10000, String(sim2.frais_dossier_cents));
ok('assurance 0,5 % = 5 000 FCFA', sim2.assurance_cents === 5000, String(sim2.assurance_cents));
ok('net versé 985 000 FCFA', sim2.net_verse_cents === 985000, String(sim2.net_verse_cents));
ok('TEG supérieur au taux nominal affiché', sim2.taux_teg_bp > 1200, String(sim2.taux_teg_bp));
ok('TEG cohérent (~15,7 %)', Math.abs(sim2.taux_teg_bp - 1578) <= 5, String(sim2.taux_teg_bp));
ok('le TEG ne dépasse jamais 100 % sur nos produits', sim2.taux_teg_bp < 10000);

// ----------------------------------------------------------------------
console.log('\n— 7. Contrôles du produit —');
rejette('montant au-dessus du plafond refusé', () => M.simulerDossierCredit({
  montant_cents: 5000000, duree_mois: 12, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15',
  produit: { montant_max_cents: 2000000 }
}), 'montant_au_dessus_plafond');
rejette('montant sous le plancher refusé', () => M.simulerDossierCredit({
  montant_cents: 20000, duree_mois: 12, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15',
  produit: { montant_min_cents: 50000 }
}), 'montant_sous_plancher');
rejette('durée au-dessus du maximum refusée', () => M.simulerDossierCredit({
  montant_cents: 500000, duree_mois: 36, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15',
  produit: { duree_max_mois: 24 }
}), 'duree_au_dessus_plafond');
rejette('frais qui absorbent tout le montant refusés', () => M.simulerDossierCredit({
  montant_cents: 100000, duree_mois: 6, periodicite: 'MENSUELLE', methode: 'DEGRESSIF',
  taux_nominal_bp: 1200, date_debut: '2026-11-15',
  produit: { frais_dossier_bp: 5000, assurance_bp: 5000 }
}), 'retenues_excessives');
ok('épargne obligatoire 10 % = 100 000 FCFA', M.epargneGarantie(1000000, { epargne_obligatoire_bp: 1000 }) === 100000);

// ----------------------------------------------------------------------
console.log('\n— 8. Imputation BCEAO (pénalités -> intérêts -> capital) —');
const imp = M.imputerRemboursement({
  montant_cents: 50000, penalites_dues_cents: 5000, interets_echus_cents: 20000, capital_du_cents: 400000
});
ok('pénalités d’abord', imp.penalite_cents === 5000, String(imp.penalite_cents));
ok('puis intérêts', imp.interet_cents === 20000);
ok('puis capital', imp.capital_cents === 25000);
ok('reste dû cohérent', imp.reste_capital_cents === 375000);
ok('somme imputée = montant reçu', imp.penalite_cents + imp.interet_cents + imp.capital_cents === 50000);
const trop = M.imputerRemboursement({
  montant_cents: 100000, penalites_dues_cents: 0, interets_echus_cents: 0, capital_du_cents: 40000
});
ok('trop-perçu isolé, jamais perdu', trop.trop_percu_cents === 60000, String(trop.trop_percu_cents));
rejette('montant nul refusé', () => M.imputerRemboursement({
  montant_cents: 0, penalites_dues_cents: 0, interets_echus_cents: 0, capital_du_cents: 1
}), 'montant_invalide');

// ----------------------------------------------------------------------
console.log('\n— 9. Classes BCEAO, provisions et PAR —');
ok('1 jour de retard = SAIN', M.classeBceao(1) === 'SAIN');
ok('60 jours = IMMOBILISE', M.classeBceao(60) === 'IMMOBILISE');
ok('100 jours = DOUTEUX', M.classeBceao(100) === 'DOUTEUX');
ok('200 jours = LITIGIEUX', M.classeBceao(200) === 'LITIGIEUX');
ok('provision DOUTEUX = 100 % (prudentiel)', M.tauxProvisionBp('DOUTEUX') === 10000, String(M.tauxProvisionBp('DOUTEUX')));
ok('provision IMMOBILISE = 50 %', M.tauxProvisionBp('IMMOBILISE') === 5000, String(M.tauxProvisionBp('IMMOBILISE')));
ok('provision LITIGIEUX = 100 %', M.tauxProvisionBp('LITIGIEUX') === 10000);
ok('provision SAIN = 0', M.calculerProvision(1000000, 'SAIN') === 0);
ok('provision DOUTEUX sur 1 000 000 = 1 000 000', M.calculerProvision(1000000, 'DOUTEUX') === 1000000, String(M.calculerProvision(1000000, 'DOUTEUX')));
ok('provision IMMOBILISE sur 1 000 000 = 500 000', M.calculerProvision(1000000, 'IMMOBILISE') === 500000);
const par = M.calculerPar([
    { encours_cents: 100000, jours_retard: 0 },
    { encours_cents: 100000, jours_retard: 45 },
    { encours_cents: 100000, jours_retard: 95 },
    { encours_cents: 100000, jours_retard: 200 }
]);
ok('PAR 30 = 75 %', par.par30_pourcent === 75, String(par.par30_pourcent));
ok('PAR 90 = 50 %', par.par90_pourcent === 50, String(par.par90_pourcent));
ok('classes réparties', par.par_classe.IMMOBILISE === 100000 && par.par_classe.DOUTEUX === 100000
  && par.par_classe.LITIGIEUX === 100000, JSON.stringify(par.par_classe));
ok('portefeuille à risque en montant PAR90 = 200 000', par.par90_cents === 200000, String(par.par90_cents));

// ----------------------------------------------------------------------
console.log('\n— 10. Circuit du dossier et principe des 4 yeux —');
ok('BROUILLON -> EN_ANALYSE autorisé', M.transitionAutorisee('BROUILLON', 'EN_ANALYSE') === true);
ok('EN_ANALYSE -> EN_COMITE autorisé', M.transitionAutorisee('EN_ANALYSE', 'EN_COMITE') === true);
ok('EN_COMITE -> APPROUVE autorisé', M.transitionAutorisee('EN_COMITE', 'APPROUVE') === true);
ok('APPROUVE -> DECAISSE autorisé', M.transitionAutorisee('APPROUVE', 'DECAISSE') === true);
ok('DECAISSE -> CLOTURE_SOLDE autorisé', M.transitionAutorisee('DECAISSE', 'CLOTURE_SOLDE') === true);
rejette('BROUILLON -> DECAISSE interdit (saut d’étapes)', () => M.transitionAutorisee('BROUILLON', 'DECAISSE'), 'transition_interdite');
rejette('DECAISSE -> BROUILLON interdit (retour arrière)', () => M.transitionAutorisee('DECAISSE', 'BROUILLON'), 'transition_interdite');
rejette('même personne : 4 yeux violés', () => M.verifierQuatreYeux({
  agent_credit_id: 'u-1', validateur_id: 'u-1', montant_cents: 500000, plafond_cents: 1000000
}), 'quatre_yeux_viole');
rejette('plafond dépassé refusé', () => M.verifierQuatreYeux({
  agent_credit_id: 'u-1', validateur_id: 'u-2', montant_cents: 5000000, plafond_cents: 1000000
}), 'plafond_depasse');
ok('deux personnes différentes + sous plafond : OK', M.verifierQuatreYeux({
  agent_credit_id: 'u-1', validateur_id: 'u-2', montant_cents: 500000, plafond_cents: 1000000
}) === true);

// ----------------------------------------------------------------------
console.log('\n— 11. Saisie hors-ligne (terrain) —');
const U1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const remOk = lance('remboursement terrain valide', () => M.validerRemboursementHorsLigne({
  uuid_local: U1, montant: '15000', canal: 'TERRAIN_CASH',
  gps_lat: 5.3599, gps_lng: -4.0083, date_operation_locale: '2026-11-15T08:30:00Z'
}));
ok('montant converti en centimes', remOk.montant_cents === 1500000, String(remOk.montant_cents));
rejette('remboursement sans identifiant unique refusé', () => M.validerRemboursementHorsLigne({
  montant: '15000', canal: 'TERRAIN_CASH'
}), 'uuid_local_invalide');
rejette('mobile money sans référence refusé', () => M.validerRemboursementHorsLigne({
  uuid_local: U1, montant: '15000', canal: 'ORANGE_MONEY'
}), 'reference_mm_manquante');
rejette('GPS illisible refusé', () => M.validerRemboursementHorsLigne({
  uuid_local: U1, montant: '15000', canal: 'TERRAIN_CASH', gps_lat: 999, gps_lng: 0
}), 'gps_invalide');
rejette('téléphone en avance refusé', () => M.validerRemboursementHorsLigne({
  uuid_local: U1, montant: '15000', canal: 'TERRAIN_CASH',
  date_operation_locale: new Date(Date.now() + 3600 * 1000).toISOString()
}), 'horloge_en_avance');
const actOk = lance('action de recouvrement valide', () => M.validerActionHorsLigne({
  uuid_local: U1, type_action: 'visite', resultat: 'client absent', gps_lat: 5.36, gps_lng: -4.0
}));
ok('type d’action normalisé', actOk.type_action === 'VISITE');
rejette('type d’action inconnu refusé', () => M.validerActionHorsLigne({ uuid_local: U1, type_action: 'DANSE' }), 'type_action_inconnu');

// ----------------------------------------------------------------------
console.log('\n— 12. Références lisibles —');
ok('référence dossier', M.referenceDossier({ codeImf: 'NONMA', annee: 2026, numero: 42 }) === 'CRD-NONMA-2026-000042',
  M.referenceDossier({ codeImf: 'NONMA', annee: 2026, numero: 42 }));
ok('référence reçu', M.referenceRecuRemboursement({ annee: 2026, numero: 7 }) === 'REM-2026-000007');

// ----------------------------------------------------------------------
// TEG : le taux effectif global doit TOUJOURS être calculé sur le net versé
// et tenir compte des frais, de l'assurance et de l'épargne de garantie.
// (Régression : un produit dont frais/assurance venaient du corps de requête
//  pouvait afficher un TEG égal au taux nominal, donc sous-estimé.)
// ----------------------------------------------------------------------
console.log('\nTEG sur net versé :');
{
  const brut = lance('simulation sans frais', () => M.simulerDossierCredit({
    montant_cents: 120000000, duree_mois: 12,
    produit: { taux_nominal_bp: 1200, methode: 'DEGRESSIF' }, date_debut: '2026-12-01'
  }));
  const charge = lance('simulation avec frais et assurance', () => M.simulerDossierCredit({
    montant_cents: 120000000, duree_mois: 12, date_debut: '2026-12-01',
    produit: { taux_nominal_bp: 1200, methode: 'DEGRESSIF', frais_dossier_bp: 200, assurance_bp: 100 }
  }));
  if (brut) ok('sans frais, TEG = taux nominal', brut.taux_teg_bp >= 1195 && brut.taux_teg_bp <= 1205, String(brut.taux_teg_bp));
  if (charge) {
    ok('avec frais+assurance, TEG > taux nominal', charge.taux_teg_bp > 1500, String(charge.taux_teg_bp));
    ok('net versé = montant - frais - assurance', charge.net_verse_cents === 120000000 - 2400000 - 1200000,
      String(charge.net_verse_cents));
    ok('coût du crédit inclut les frais', charge.cout_credit_cents > charge.total_interets_cents, '');
    // Contrôle indépendant : la VAN des échéances au TEG doit être nulle
    // (c'est la définition même du TEG, au centime près).
    const r = (charge.taux_teg_bp / 10000) / 12;
    let van = -charge.net_verse_cents;
    for (const l of charge.lignes) van += l.montant_echeance_cents / Math.pow(1 + r, l.numero);
    ok('VAN au TEG ≈ 0 (écart < 0,01 % du montant)', Math.abs(van) < charge.montant_cents * 0.0001, String(Math.round(van)));
  }
  const zero = lance('crédit à taux zéro', () => M.simulerDossierCredit({
    montant_cents: 50000000, duree_mois: 10,
    produit: { taux_nominal_bp: 0, methode: 'DEGRESSIF' }, date_debut: '2026-12-01'
  }));
  if (zero) ok('taux zéro respecté (0 % non remplacé par le défaut)', zero.taux_teg_bp === 0, String(zero.taux_teg_bp));
}

// ----------------------------------------------------------------------
console.log('\n=========================================');
console.log(passes + ' test(s) réussi(s), ' + fails + ' échec(s)');
console.log('=========================================');
if (fails > 0) process.exit(1);
