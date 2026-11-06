#!/usr/bin/env node
/* ============================================================================
 * teebo — Validation des migrations sur BASE DE DONNÉES RÉELLE (PostgreSQL)
 * ----------------------------------------------------------------------------
 * Contrairement au test en mémoire (pg-mem), ce script se connecte à un vrai
 * serveur PostgreSQL via DATABASE_URL, applique les schémas de façon idempotente
 * puis vérifie que TOUS les objets de la VAGUE 8 (logo + mentions légales +
 * facturation/TVA) sont correctement créés et se comportent comme attendu :
 *   - tables imf_branding / imf_document_settings / invoice / invoice_counter ;
 *   - déclencheurs d'audit (trg_audit_*) réellement installés ;
 *   - fonction fn_gen_invoice_no() : numéro FAC-AAAA-XXXXXX séquentiel, sans trou ;
 *   - TVA configurable par tenant (aucun taux figé) + contrainte 0..10000 bp ;
 *   - facture définitive : total = HT + TVA, devise XOF/FCFA.
 *
 * SÉCURITÉ D'EXÉCUTION : toutes les écritures de test se font dans UNE transaction
 * qui se termine par ROLLBACK. La base n'est donc jamais modifiée par ce test
 * (y compris le compteur de factures). On peut le lancer sans risque, même sur
 * une base déjà peuplée.
 *
 * USAGE :
 *   export DATABASE_URL="postgres://user:pass@host:5432/teebo"
 *   node tools/test-migrations.mjs
 *   # ou, depuis backend/ :  npm run test:migrations
 * ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../db');
const SCHEMA_FILES = ['schema.sql', 'schema_v3.sql', 'schema_v4.sql'];

// ----- 0. Vérification de l'environnement AVANT tout import lourd -----
// On valide DATABASE_URL d'abord pour toujours afficher un message clair,
// même si le paquet « pg » n'est pas encore installé.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('\n❌  DATABASE_URL non défini.');
  console.error('    Exemple : export DATABASE_URL="postgres://teebo:motdepasse@localhost:5432/teebo"');
  console.error('    Puis relancez : node tools/test-migrations.mjs\n');
  process.exit(2);
}

// Import dynamique de la passerelle PostgreSQL : si le paquet manque,
// on fournit un message d'installation clair au lieu d'une erreur brute.
let Client;
try {
  const pg = await import('pg');
  Client = (pg.default || pg).Client;
} catch (_) {
  console.error('\n❌  Le paquet « pg » n’est pas installé.');
  console.error('    Installez-le puis relancez le test :');
  console.error('        npm install            # à la racine ou dans backend/');
  console.error('    Puis : node tools/test-migrations.mjs\n');
  process.exit(2);
}

// SSL : activé automatiquement pour les hébergeurs type Render/Neon/Supabase.
const needSsl = /\brender\.com|neon\.tech|supabase\.co|amazonaws\.com|sslmode=require/i.test(DATABASE_URL);
const client = new Client({
  connectionString: DATABASE_URL,
  ssl: needSsl ? { rejectUnauthorized: false } : undefined
});

let pass = 0, fail = 0;
const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[90m', rst: '\x1b[0m' };
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ' + C.ok + '✓' + C.rst + '  ' + name); }
  else { fail++; console.log('  ' + C.bad + '✗' + C.rst + '  ' + name + (detail ? C.dim + '  (' + detail + ')' + C.rst : '')); }
}
function section(t) { console.log('\n' + C.dim + '— ' + t + ' —' + C.rst); }

async function tableExists(name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
  return r.rowCount > 0;
}
async function columnType(table, col) {
  const r = await client.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
  return r.rows[0] ? r.rows[0].data_type : null;
}
async function triggerExists(name) {
  const r = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal`, [name]);
  return r.rowCount > 0;
}
async function functionExists(name) {
  const r = await client.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1`, [name]);
  return r.rowCount > 0;
}

async function main() {
  console.log('\n======================================================');
  console.log(' teebo — Validation des migrations (PostgreSQL réel)');
  console.log('======================================================');
  await client.connect();

  const ver = (await client.query('SELECT version() AS v')).rows[0].v;
  const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
  console.log(C.dim + ' Connecté à : ' + db + '\n ' + ver.split(',')[0] + C.rst);

  // ----- 1. Application idempotente des schémas -----
  section('Application des schémas (idempotente)');
  for (const file of SCHEMA_FILES) {
    const p = path.join(DB_DIR, file);
    if (!fs.existsSync(p)) { ok('schéma présent : ' + file, false, 'fichier absent'); continue; }
    try {
      await client.query(fs.readFileSync(p, 'utf8'));
      ok('schéma appliqué : ' + file, true);
    } catch (e) {
      if (/already exists/i.test(e.message)) ok('schéma déjà présent : ' + file + ' (OK)', true);
      else ok('schéma appliqué : ' + file, false, e.message.split('\n')[0]);
    }
  }

  // ----- 2. Objets créés par la VAGUE 8 -----
  section('Objets de la VAGUE 8 (logo + mentions + facturation)');
  ok('table imf_branding', await tableExists('imf_branding'));
  ok('table imf_document_settings', await tableExists('imf_document_settings'));
  ok('table invoice', await tableExists('invoice'));
  ok('table invoice_counter', await tableExists('invoice_counter'));
  ok('colonne imf_branding.logo_data_url (text)', (await columnType('imf_branding', 'logo_data_url')) === 'text');
  ok('colonne imf_document_settings.vat_rate_bp (integer)', (await columnType('imf_document_settings', 'vat_rate_bp')) === 'integer');
  ok('colonne invoice.invoice_no présente', !!(await columnType('invoice', 'invoice_no')));
  ok('fonction fn_gen_invoice_no()', await functionExists('fn_gen_invoice_no'));
  ok('déclencheur trg_audit_imf_branding', await triggerExists('trg_audit_imf_branding'));
  ok('déclencheur trg_audit_imf_doc_settings', await triggerExists('trg_audit_imf_doc_settings'));
  ok('déclencheur trg_audit_invoice', await triggerExists('trg_audit_invoice'));

  // ----- 3. Comportement métier (DANS UNE TRANSACTION → ROLLBACK) -----
  section('Comportement métier (transaction annulée — base intacte)');
  await client.query('BEGIN');
  try {
    // IMF de test (code unique horodaté pour éviter toute collision).
    const code = 'TBO-TST-' + String(Date.now()).slice(-6);
    const imf = await client.query(
      `INSERT INTO imf(code_imf,name,type,country_code,city,capital_cents,
           bceao_agreement_no,phone_main,whatsapp,email,status)
       VALUES ($1,'IMF de test','SA','BF','Ouagadougou',2500000000,
           '2024-BF-IM-TST','+22650000000','+22650000000','test@imf.local','pending')
       RETURNING id`, [code]);
    const imfId = imf.rows[0].id;
    ok('insertion IMF de test', !!imfId);

    // Identité visuelle + mentions légales
    await client.query(
      `INSERT INTO imf_branding(imf_id, legal_name, legal_form, trade_register_no, tax_id,
           bceao_agreement_no, share_capital_cents, legal_address)
       VALUES ($1,'IMF de test SA','SA','BF-OUA-2024-B-9999','9999999999','2024-BF-IM-TST',
           2500000000,'Siège de test, Ouaga 2000')`, [imfId]);
    const b = (await client.query('SELECT * FROM imf_branding WHERE imf_id=$1', [imfId])).rows[0];
    ok('mentions légales enregistrées (raison sociale + forme)', b && b.legal_name === 'IMF de test SA' && b.legal_form === 'SA');

    // Logo base64 + retrait
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await client.query('UPDATE imf_branding SET logo_data_url=$2, logo_mime=$3, logo_bytes=$4 WHERE imf_id=$1',
      [imfId, png, 'image/png', 70]);
    const bl = (await client.query('SELECT logo_data_url, logo_mime FROM imf_branding WHERE imf_id=$1', [imfId])).rows[0];
    ok('logo stocké en base64 (data URL)', bl && bl.logo_data_url.startsWith('data:image/png;base64,') && bl.logo_mime === 'image/png');
    await client.query('UPDATE imf_branding SET logo_data_url=NULL, logo_mime=NULL, logo_bytes=NULL WHERE imf_id=$1', [imfId]);
    ok('logo retirable (NULL)', (await client.query('SELECT logo_data_url FROM imf_branding WHERE imf_id=$1', [imfId])).rows[0].logo_data_url === null);

    // TVA : aucun taux par défaut, configurable, puis retirable
    let vat = (await client.query('SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [imfId])).rows[0];
    ok('TVA non renseignée => aucune ligne (non applicable)', !vat);
    await client.query(
      `INSERT INTO imf_document_settings(imf_id, vat_rate_bp) VALUES ($1,1800)
       ON CONFLICT (imf_id) DO UPDATE SET vat_rate_bp=EXCLUDED.vat_rate_bp`, [imfId]);
    vat = (await client.query('SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [imfId])).rows[0];
    ok('TVA configurable = 1800 points de base (18 %)', vat && vat.vat_rate_bp === 1800);
    await client.query('UPDATE imf_document_settings SET vat_rate_bp=NULL WHERE imf_id=$1', [imfId]);
    ok('TVA retirée => redevenue non applicable (aucun taux figé)', (await client.query('SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [imfId])).rows[0].vat_rate_bp === null);

    // Contrainte de bornes (0..10000 bp)
    let rejected = false;
    await client.query('SAVEPOINT sp_vat');
    try { await client.query('UPDATE imf_document_settings SET vat_rate_bp=20000 WHERE imf_id=$1', [imfId]); }
    catch (e) { rejected = true; await client.query('ROLLBACK TO SAVEPOINT sp_vat'); }
    ok('contrainte TVA : taux hors bornes (200 %) rejeté', rejected);

    // Numérotation séquentielle FAC-AAAA-XXXXXX via la VRAIE fonction plpgsql
    const n1 = (await client.query('SELECT fn_gen_invoice_no() AS n')).rows[0].n;
    const n2 = (await client.query('SELECT fn_gen_invoice_no() AS n')).rows[0].n;
    const year = new Date().getFullYear();
    const seq1 = parseInt(n1.split('-')[2], 10);
    const seq2 = parseInt(n2.split('-')[2], 10);
    ok('format FAC-AAAA-XXXXXX (reçu : ' + n1 + ')', new RegExp('^FAC-' + year + '-\\d{6}$').test(n1));
    ok('numérotation séquentielle sans trou (' + n1 + ' → ' + n2 + ')', seq2 === seq1 + 1);

    // Facture définitive : total = HT + TVA 18 %
    const subtotal = 12000000, vatBp = 1800;
    const vatCents = Math.round(subtotal * vatBp / 10000);
    const total = subtotal + vatCents;
    const invNo = (await client.query('SELECT fn_gen_invoice_no() AS n')).rows[0].n;
    await client.query(
      `INSERT INTO invoice(imf_id, invoice_no, kind, plan_code, plan_label, subtotal_cents,
           vat_rate_bp, vat_cents, total_cents, currency, status, issued_at)
       VALUES ($1,$2,'definitive','business','Abonnement teebo — Business',$3,$4,$5,$6,'XOF','emise',now())`,
      [imfId, invNo, subtotal, vatBp, vatCents, total]);
    const inv = (await client.query('SELECT * FROM invoice WHERE invoice_no=$1', [invNo])).rows[0];
    ok('facture définitive émise (' + invNo + ')', inv && inv.status === 'emise');
    ok('TVA 18 % = 21 600 FCFA (2 160 000 centimes)', Number(inv.vat_cents) === 2160000);
    ok('total = HT + TVA = 141 600 FCFA', Number(inv.total_cents) === total);
    ok('devise XOF / FCFA', inv && inv.currency.trim() === 'XOF');

    // Unicité du numéro de facture
    let dup = false;
    await client.query('SAVEPOINT sp_dup');
    try {
      await client.query(
        `INSERT INTO invoice(imf_id, invoice_no, subtotal_cents, total_cents) VALUES ($1,$2,0,0)`, [imfId, invNo]);
    } catch (e) { dup = true; await client.query('ROLLBACK TO SAVEPOINT sp_dup'); }
    ok('numéro de facture unique (doublon rejeté)', dup);

    // Trace d'audit écrite par le déclencheur (si la table d'audit existe)
    if (await tableExists('audit_log')) {
      const a = await client.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity='invoice'`);
      ok('déclencheur d’audit : écriture sur invoice', a.rows[0].n >= 1, 'audit_log entity=invoice');
    } else {
      ok('table audit_log présente (audit append-only)', false, 'introuvable — vérifier le socle');
    }
  } finally {
    // La base reste STRICTEMENT inchangée : rien n'est validé.
    await client.query('ROLLBACK');
    console.log(C.dim + '  (transaction de test annulée — aucune donnée écrite dans la base)' + C.rst);
  }

  await client.end();
  console.log('\n======================================================');
  console.log(' RÉSULTAT : ' + pass + ' réussis / ' + fail + ' échec(s)');
  console.log('======================================================\n');
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n❌  Échec du test : ' + (e && e.message ? e.message.split('\n')[0] : e));
  try { await client.query('ROLLBACK'); } catch (_) {}
  try { await client.end(); } catch (_) {}
  process.exit(1);
});
