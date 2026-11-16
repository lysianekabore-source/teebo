// =========================================================================
// teebo — TESTS VAGUE 36 : restriction immédiate + droits de module (37 cas)
// -------------------------------------------------------------------------
// Node 16 n'a pas de hooks de chargement : on copie les deux modules testés
// dans un dossier de travail en remplaçant leurs appels SQL par le simulateur
// (tests/sim.mjs). On valide donc la LOGIQUE métier, pas PostgreSQL lui-même.
// =========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const SRC = path.resolve(process.cwd(), 'backend/src');
const OUT = path.resolve(process.cwd(), 'tests', '_build');
const IMF = '11111111-1111-1111-1111-111111111111';

let passes = 0; let fails = 0;
function ok(nom, cond, detail) {
  if (cond) { passes += 1; console.log('  OK   ' + nom); }
  else { fails += 1; console.log('  FAIL ' + nom + (detail ? '  -> ' + detail : '')); }
}
function eq(nom, a, b) {
  ok(nom, JSON.stringify(a) === JSON.stringify(b),
    JSON.stringify(a) + ' au lieu de ' + JSON.stringify(b));
}

/* --- préparation du bac à sable ---------------------------------------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.resolve(process.cwd(), 'tests', 'sim.mjs'), path.join(OUT, 'sim.mjs'));
fs.writeFileSync(path.join(OUT, 'db.mjs'),
  'import { query } from \'./sim.mjs\';\n'
  + 'export const q = (t, p) => query(t, p);\n'
  + 'export const tx = async (fn) => fn({ query: (t, p) => query(t, p) });\n'
  + 'export const pool = { query: (t, p) => query(t, p) };\n'
  + 'export default { q, tx, pool };\n');

for (const f of ['modules.js', 'saas_restriction.js']) {
  let src = fs.readFileSync(path.join(SRC, f), 'utf8');
  src = src.split("'./db.js'").join("'./db.mjs'");
  src = src.split("'./modules.js'").join("'./modules.mjs'");
  fs.writeFileSync(path.join(OUT, f.replace(/\.js$/, '.mjs')), src);
}

const sim = await import(pathToFileURL(path.join(OUT, 'sim.mjs')).href);
const M = await import(pathToFileURL(path.join(OUT, 'modules.mjs')).href);
const R = await import(pathToFileURL(path.join(OUT, 'saas_restriction.mjs')).href);
// Les modules importés lisent le MÊME objet que `sim` : on repart d'une base
// neuve APRÈS leur chargement pour que l'état soit bien celui du test.
const decale = sim.decale;
sim.reinit(IMF);

console.log('\n=== Vague 36 — restriction immediate et droits de module ===\n');

/* --------------------------------------------------------------------- */
/*  1. État de départ : IMF sans aucun module                           */
/* --------------------------------------------------------------------- */
eq('1. etat initial : collecte utilisable',
  sim.base.institution_features[0].module_collecte_tontine, true);
eq('2. etat initial : credit non utilisable',
  (await R.droitsUtilisables(IMF)).MODULE_DOSSIER_CREDIT, false);
eq('3. etat initial : pas de restriction', await R.estRestreinteCollecteSeule(IMF), false);

/* --------------------------------------------------------------------- */
/*  2. IMF avec les 4 modules actifs, puis restriction                  */
/* --------------------------------------------------------------------- */
for (const k of M.MODULE_KEYS) {
  sim.base.institution_module_subscriptions.push({ institution_id: IMF, module_key: k,
    is_active: true, is_trial: true, trial_end_date: decale(20), trial_used: false,
    deactivated_reason: null, restriction_code: null });
}
eq('4. quatre modules actifs avant restriction',
  Object.values(await R.droitsUtilisables(IMF)).filter(Boolean).length, 4);

const comp = await R.restreindreCollecteSeule(IMF, { id: null, role: 'teebo_admin' }, 'Test');
eq('5. restriction : code COLLECTE_ONLY', comp.restriction, 'COLLECTE_ONLY');
eq('6. restriction : trois modules coupes', comp.modules_coupes, 3);
eq('7. restriction : module autorise = collecte', comp.module_autorise, 'MODULE_COLLECTE_TONTINE');
eq('8. restriction : configuration renvoyee a l ecran',
  !!(comp.configuration_ui && comp.configuration_ui.features), true);

const droits = await R.droitsUtilisables(IMF);
eq('9. apres restriction : collecte toujours utilisable', droits.MODULE_COLLECTE_TONTINE, true);
eq('10. apres restriction : credit coupe', droits.MODULE_DOSSIER_CREDIT, false);
eq('11. apres restriction : conformite coupee', droits.MODULE_COMPLIANCE_KYC, false);
eq('12. apres restriction : comptabilite coupee', droits.MODULE_COMPTABILITE_AVANCEE, false);
eq('13. restriction enregistree comme active', await R.estRestreinteCollecteSeule(IMF), true);

/* --------------------------------------------------------------------- */
/*  3. Les menus : seule la collecte reste à l'écran                    */
/* --------------------------------------------------------------------- */
const cfg = await M.buildInstitutionConfig(IMF);
eq('14. menus : une seule entree', cfg.menus.length, 1);
eq('15. menus : c est la collecte', cfg.menus[0].module, 'MODULE_COLLECTE_TONTINE');

/* --------------------------------------------------------------------- */
/*  4. Le garde-fou : 403 immédiat, avec le bon motif                    */
/* --------------------------------------------------------------------- */
const vCredit = await M.verifierModule(IMF, 'MODULE_DOSSIER_CREDIT');
eq('16. middleware : credit refuse', vCredit.utilisable, false);
eq('17. middleware : motif RESTRICTION_COLLECTE_ONLY', vCredit.motif, 'RESTRICTION_COLLECTE_ONLY');
eq('18. middleware : collecte autorisee',
  (await M.verifierModule(IMF, 'MODULE_COLLECTE_TONTINE')).utilisable, true);

/* --------------------------------------------------------------------- */
/*  5. Upgrade après restriction, essai déjà utilisé -> payant           */
/* --------------------------------------------------------------------- */
// Essai réellement consommé : la souscription garde la trace du premier essai.
const cr0 = sim.base.institution_module_subscriptions.find((x) => x.module_key === 'MODULE_DOSSIER_CREDIT');
cr0.trial_used = true; cr0.trial_started_at = decale(-40);
const up1 = await R.reactiverModule(IMF, 'MODULE_DOSSIER_CREDIT', {}, { id: null, role: 'admin_imf' });
eq('19. upgrade : module reactive', up1.actif, true);
eq('20. upgrade : pas de deuxieme essai', up1.essai, false);
eq('21. upgrade : aucun essai accorde', up1.essai_accorde, false);
eq('22. upgrade : credit de nouveau utilisable',
  (await R.droitsUtilisables(IMF)).MODULE_DOSSIER_CREDIT, true);
eq('23. upgrade : collecte toujours la',
  (await R.droitsUtilisables(IMF)).MODULE_COLLECTE_TONTINE, true);
eq('24. upgrade : restriction toujours en place', await R.estRestreinteCollecteSeule(IMF), true);

/* --------------------------------------------------------------------- */
/*  6. Module jamais testé -> 30 jours d'essai automatiques              */
/* --------------------------------------------------------------------- */
sim.base.institution_module_subscriptions =
  sim.base.institution_module_subscriptions.filter((x) => x.module_key !== 'MODULE_COMPLIANCE_KYC');
const up2 = await R.reactiverModule(IMF, 'MODULE_COMPLIANCE_KYC', {}, { id: null, role: 'admin_imf' });
eq('25. module jamais teste : essai accorde', up2.essai_accorde, true);
eq('26. module jamais teste : en essai', up2.essai, true);
eq('27. module jamais teste : fin dans 30 jours', up2.fin_essai, decale(30));
eq('28. module jamais teste : utilisable',
  (await R.droitsUtilisables(IMF)).MODULE_COMPLIANCE_KYC, true);

/* --------------------------------------------------------------------- */
/*  7. Essai terminé -> accès refusé                                    */
/* --------------------------------------------------------------------- */
const lc = sim.base.institution_module_subscriptions
  .find((x) => x.module_key === 'MODULE_DOSSIER_CREDIT');
lc.is_trial = true; lc.trial_end_date = decale(-1);
const vExp = await M.verifierModule(IMF, 'MODULE_DOSSIER_CREDIT');
eq('29. essai expire : acces refuse', vExp.utilisable, false);
eq('30. essai expire : motif ESSAI_EXPIRE', vExp.motif, 'ESSAI_EXPIRE');

/* --------------------------------------------------------------------- */
/*  8. Levée de la restriction                                          */
/* --------------------------------------------------------------------- */
await R.leverRestriction(IMF, { id: null, role: 'teebo_admin' }, 'Fin de test');
eq('31. levee : restriction inactive', await R.estRestreinteCollecteSeule(IMF), false);
eq('32. levee : menus recalcules', (await M.buildInstitutionConfig(IMF)).menus.length, 3);
eq('33. levee : comptabilite rendue disponible',
  sim.base.institution_features[0].module_comptabilite_avancee, false);

/* --------------------------------------------------------------------- */
/*  9. Périmètre des URL protégées                                      */
/* --------------------------------------------------------------------- */
eq('34. /credit protege par le module credit',
  M.REQUIRED_MODULE_FOR_PATH('/credit/dossiers'), 'MODULE_DOSSIER_CREDIT');
eq('35. /collecte protege par la collecte',
  M.REQUIRED_MODULE_FOR_PATH('/collecte/tournees'), 'MODULE_COLLECTE_TONTINE');
eq('36. /institution/config reste libre', M.REQUIRED_MODULE_FOR_PATH('/institution/config'), null);
eq('37. /saas reste libre (reactivation possible)',
  M.REQUIRED_MODULE_FOR_PATH('/saas/modules/x'), null);
eq('38. /auth reste libre', M.REQUIRED_MODULE_FOR_PATH('/auth/login'), null);

/* --------------------------------------------------------------------- */
/*  10. Trace d'audit                                                   */
/* --------------------------------------------------------------------- */
ok('39. audit ecrit (restriction et reactivations)', sim.base.audit_log.length >= 1,
  String(sim.base.audit_log.length));

console.log('\n--- ' + passes + '/' + (passes + fails) + ' tests OK ---\n');
process.exit(fails ? 1 : 0);
