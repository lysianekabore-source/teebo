// Contrôle des règles financières v35 (aucune base requise).
import { computeMonth } from '/nfs/110297347/temp/work/serveur/backend/src/saas_billing.js';
import { dec, toSql, sum } from '/nfs/110297347/temp/work/serveur/backend/src/money.js';

let ok = 0, ko = 0;
function t(nom, obtenu, attendu) {
  const bon = String(obtenu) === String(attendu);
  console.log((bon ? 'OK  ' : 'KO  ') + nom + ' → ' + obtenu + (bon ? '' : ' (attendu ' + attendu + ')'));
  bon ? ok++ : ko++;
}

const CAT = [
  { module_key: 'MODULE_COLLECTE_TONTINE', is_available: true, monthly_price: '75000.00' },
  { module_key: 'MODULE_DOSSIER_CREDIT', is_available: true, monthly_price: '100000.00' },
  { module_key: 'MODULE_COMPLIANCE_KYC', is_available: true, monthly_price: '25000.00' },
  { module_key: 'MODULE_COMPTABILITE_AVANCEE', is_available: true, monthly_price: '100000.00' }
];
const MOD = (k, prix, extra = {}) => ({ module_key: k, module_name: k, prix_mensuel: prix,
  is_active: true, is_trial: false, trial_end_date: null, activated_at: null,
  billing_cycle: 'MENSUEL', annual_signed_at: null, ...extra });

// A. Mois complet, 4 modules, tarif annuel déjà signé avant le mois → −15 %
const a = computeMonth({ modules: [
  MOD('MODULE_COLLECTE_TONTINE', '75000.00', { billing_cycle: 'ANNUEL', annual_signed_at: '2026-01-05' }),
  MOD('MODULE_DOSSIER_CREDIT', '100000.00', { billing_cycle: 'ANNUEL', annual_signed_at: '2026-01-05' }),
  MOD('MODULE_COMPLIANCE_KYC', '25000.00', { billing_cycle: 'ANNUEL', annual_signed_at: '2026-01-05' }),
  MOD('MODULE_COMPTABILITE_AVANCEE', '100000.00', { billing_cycle: 'ANNUEL', annual_signed_at: '2026-01-05' })],
  catalogue: CAT, licenceDu: '0.00', mois: '2026-11-30', remisePct: '5', remiseAnnuellePct: '15',
  dateFacturation: '2026-11-30' });
t('A prix annuel mensualisé (tontine)', a.modules[0].montant_fcfa, '63750.00');
// 4 modules au tarif annuel : 63750 + 85000 + 21250 + 85000 = 255000 ; −5 % = 12750
t('A total annuel 4 modules', a.total_abonnements_brut_fcfa, '255000.00');
t('A remise pack 5%', a.remise_pack_fcfa, '12750.00');
t('A total net', a.total_fcfa, '242250.00');

// B. Essaie à 14 jours sur 30, facturation au 14e jour → 0 FCFA + report
const b = computeMonth({ modules: [
  MOD('MODULE_DOSSIER_CREDIT', '100000.00', { is_trial: true, trial_end_date: '2026-11-30' })],
  catalogue: CAT, licenceDu: '0.00', mois: '2026-11-14', remisePct: '0',
  dateFacturation: '2026-11-14' });
t('B essai en cours = 0 FCFA', b.modules[0].montant_fcfa, '0.00');
t('B jours restants reportés', b.modules[0].jours_essai_restants, 16);
t('B total du mois', b.total_fcfa, '0.00');

// C. Le mois suivant : essai terminé le 30/11 → facturation du 1/12 au 31/12
const c = computeMonth({ modules: [
  MOD('MODULE_DOSSIER_CREDIT', '100000.00', { is_trial: true, trial_end_date: '2026-11-30' })],
  catalogue: CAT, licenceDu: '0.00', mois: '2026-12-01', remisePct: '0', remiseAnnuellePct: '15',
  dateFacturation: '2026-12-31' });
t('C mois suivant plein', c.modules[0].montant_fcfa, '100000.00');
t('C statut', c.modules[0].statut, 'facture');

// D. Bascule mensuel → annuel le 16/11 (mois de 30 j) : 15 j plein + 15 j à −15 %
const d = computeMonth({ modules: [
  MOD('MODULE_COLLECTE_TONTINE', '75000.00', { billing_cycle: 'ANNUEL', annual_signed_at: '2026-11-16' })],
  catalogue: CAT, licenceDu: '0.00', mois: '2026-11-16', remisePct: '0', remiseAnnuellePct: '15',
  dateFacturation: '2026-11-16' });
// 75000*15/30 = 37500 ; 63750*15/30 = 31875 → 69375
t('D bascule mixte', d.modules[0].montant_fcfa, '69375.00');
t('D jours plein tarif', d.modules[0].jours_plein_tarif, 15);
t('D jours remisés', d.modules[0].jours_remises, 15);

// E. Activation le 21/11 sur 30 jours → 10 jours facturés
const e = computeMonth({ modules: [
  MOD('MODULE_COMPLIANCE_KYC', '25000.00', { activated_at: '2026-11-21' })],
  catalogue: CAT, licenceDu: '0.00', mois: '2026-11-21', remisePct: '0', remiseAnnuellePct: '15',
  dateFacturation: '2026-11-21' });
t('E prorata 10/30 de 25000', e.modules[0].montant_fcfa, '8333.33');
t('E statut prorata', e.modules[0].statut, 'facture_prorata');

// F. Aucun flottant : 0.1 + 0.2 exactement 0.30
t('F addition décimale exacte', toSql(sum('0.10', '0.20')), '0.30');

console.log('\n' + ok + ' conformes / ' + ko + ' écarts');
process.exit(ko ? 1 : 0);
