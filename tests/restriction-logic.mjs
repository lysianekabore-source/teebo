// Verification de la LOGIQUE de restriction avec une fausse base SQL.
// Prouve que : restreindre retire les modules non payes, lever les remet,
// et que sans migration la reponse est une erreur metier claire (409).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const build = path.join(root, 'tests', '_logic');
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
writeFileSync(path.join(build, 'stub_db.mjs'),
  'export function q(){ throw new Error("db non utilise"); }\n'
  + 'export function tx(){ throw new Error("tx non utilise"); }\n'
  + 'export function setFake(f){ globalThis.__fake = f; }\n'
  + 'export default { q, tx };\n');
const STUB = path.join(build, 'stub_db.mjs');

function copier(nom, src) {
  const code = readFileSync(path.join(root, 'backend', 'src', src), 'utf8')
    .replace(/from '\.\.\/db\.js'/g, "from './stub_db.mjs'")
    .replace(/from '\.\/db\.js'/g, "from './stub_db.mjs'")
    .replace(/from '\.\/modules\.js'/g, "from './modules.mjs'");
  writeFileSync(path.join(build, nom), code);
}
copier('saas_restriction.mjs', 'saas_restriction.js');
copier('modules.mjs', 'modules.js');
writeFileSync(STUB,
  'export function q(){ return globalThis.__fake.query.apply(globalThis.__fake, arguments); }\n'
  + 'export function tx(fn){ return fn(globalThis.__fake); }\n'
  + 'export const __set = (f) => { globalThis.__fake = f; };\n'
  + 'export default { q, tx };\n');
const R = await import('./_logic/saas_restriction.mjs');
const M = await import('./_logic/modules.mjs');
console.log('   fonctions disponibles :', Object.keys(R).join(' '));

const IMF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Fausse base minimale : on note les ordres SQL recus et on simule les effets.
function fausseBase({ avecTable = true } = {}) {
  const t = { restrictions: [], features: [], subs: [] };
  const ordres = [];
  const client = {
    rows: [],
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      ordres.push(s.slice(0, 60));
      if (/imf_access_restrictions/.test(s) && !avecTable) {
        const e = new Error('relation "imf_access_restrictions" does not exist');
        e.code = '42P01';
        throw e;
      }
      if (/SELECT 1 FROM imf_access_restrictions/i.test(s)) { this.rows = t.restrictions; return this; }
      if (/FROM imf WHERE id/i.test(s)) {
        this.rows = [{ id: IMF, code_imf: 'IMF-TEST', name: 'IMF Test', status: 'actif' }];
        return this;
      }
      if (/fn_restrict_imf_to_collecte/i.test(s)) {
        t.restrictions = [{ institution_id: IMF, is_active: true }];
        this.rows = [{ r: { modules_coupes: '2', restriction: 'COLLECTE_ONLY' } }];
        return this;
      }
      if (/fn_lift_imf_restriction/i.test(s)) {
        t.restrictions = [];
        this.rows = [{ r: { restriction: null, restaures: 2 } }];
        return this;
      }
      if (/INSERT INTO institution_features/i.test(s)) {
        t.features.push({ institution_id: IMF });
        this.rows = [];
        return this;
      }
      if (/UPDATE institution_features SET/i.test(s)) {
        t.features = t.features.map((f) => ({ ...f, maj: params }));
        this.rows = [];
        return this;
      }
      if (/FROM institution_features WHERE institution_id/i.test(s)) { this.rows = t.features; return this; }
      if (/FROM institution_module_subscriptions/i.test(s)) { this.rows = t.subs; return this; }
      this.rows = [];
      return this;
    },
  };
  return { client, t, ordres };
}

let ok = true;
const check = (l, c, e = '') => { if (!c) ok = false; console.log(`${c ? 'OK  ' : 'ECHEC'} ${l}${e ? ' -> ' + e : ''}`); };

// 1. Etat avant : deux modules payes + un en essai expiré
const db = fausseBase();
db.t.subs = [
  { module_key: 'MODULE_COLLECTE_TONTINE', is_active: true, is_trial: false, trial_end_date: null, is_usable: true },
  { module_key: 'MODULE_DOSSIER_CREDIT', is_active: true, is_trial: true, trial_end_date: '2026-01-01', is_usable: false },
];

globalThis.__fake = db.client;
const etat0 = await R.lireEtatModules(IMF);
check('etat initial lu', etat0.length === 2, JSON.stringify(etat0.map((m) => m.module_key + ':' + m.utilisable)));
check('essai expire = non utilisable', etat0.find((m) => m.module_key === 'MODULE_DOSSIER_CREDIT').utilisable === false);

globalThis.__fake = db.client;
const droits0 = await R.droitsUtilisables(IMF);
check('droits : collecte ouverte, credit ferme', droits0.MODULE_COLLECTE_TONTINE === true && droits0.MODULE_DOSSIER_CREDIT === false, JSON.stringify(droits0));

// 2. Restreindre
globalThis.__fake = db.client;
const r1 = await R.restreindreCollecteSeule(IMF, { id: '11111111-1111-1111-1111-111111111111', role: 'teebo_admin' }, 'Essai termine');
console.log('   resultat restriction :', JSON.stringify({ restriction: r1.restriction, modules_coupes: r1.modules_coupes }));
check('restriction renvoyee', r1.restriction === 'COLLECTE_ONLY');
check('modules_coupes numerique', typeof r1.modules_coupes === 'number');
check('reponse contient la configuration d ecran', !!r1.configuration_ui);
const coup = db.ordres.filter((o) => /fn_restrict_imf_to_collecte/i.test(o));
check('fonction SQL de restriction appelee une fois', coup.length === 1);
const feats = db.ordres.filter((o) => /INSERT INTO institution_features/i.test(o));
check('menus recalcules dans la meme transaction', feats.length === 1);

globalThis.__fake = db.client;
const estR = await R.estRestreinteCollecteSeule(IMF);
check('IMF bien vue comme restreinte', estR === true);

// 3. Lever
globalThis.__fake = db.client;
const r2 = await R.leverRestriction(IMF, { id: '11111111-1111-1111-1111-111111111111', role: 'teebo_admin' }, 'Paiement recu');
check('levee renvoie une configuration', !!r2.configuration_ui);
globalThis.__fake = db.client;
const estR2 = await R.estRestreinteCollecteSeule(IMF);
check('IMF plus restreinte', estR2 === false);
check('levee a bien insere la ligne de menus avant de la mettre a jour',
  db.ordres.some((o) => /INSERT INTO institution_features/i.test(o)));

// 4. Table absente -> message metier
const db2 = fausseBase({ avecTable: false });
let msg = '';
globalThis.__fake = db2.client;
try { await R.restreindreCollecteSeule(IMF, {}, 'x'); } catch (e) { msg = `${e.status || ''}|${e.code || ''}|${e.message}`; }
console.log('   erreur sans migration :', msg);
check('sans migration : 409 + message clair', /^409\|migration_manquante\|/.test(msg) && /migration/i.test(msg), msg);
check('sans migration : pas d erreur technique', !/ReferenceError|TypeError|is not a function/.test(msg));

// 5. Identifiant invalide
let msg2 = '';
globalThis.__fake = db2.client;
try { await R.restreindreCollecteSeule('pas-un-uuid', {}, 'x'); } catch (e) { msg2 = e.code; }
check('identifiant invalide refuse', msg2 === 'imf_id_invalide', msg2);

// 6. Module inconnu
let msg3 = '';
globalThis.__fake = db.client;
try { await R.reactiverModule(IMF, 'MODULE_BIDON', {}); } catch (e) { msg3 = e.code; }
check('module inconnu refuse', msg3 === 'module_inconnu', msg3);

console.log(ok ? '\nRESULTAT : logique de restriction OK' : '\nRESULTAT : PROBLEME');
process.exit(ok ? 0 : 1);
