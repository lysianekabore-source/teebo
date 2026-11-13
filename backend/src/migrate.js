import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { pool, q } from './db.js';

// ---------------------------------------------------------------------------
// GARDE-FOU ANTI-BLOCAGE (correctif 13/11/2026)
// Sur Render (offre gratuite) le deploiement restait « In progress » sans fin
// car le conteneur attendait la base (connexion lente au reveil, ou requete
// DDL bloquee par un verrou). Aucune etape ne doit pouvoir bloquer le
// demarrage : on pose un delai maximal global et on abandonne proprement.
// Le serveur demarre ensuite et rattrape les schemas manquants en tache de
// fond (voir server.js), donc un delai depasse n'empeche plus la mise en ligne.
// ---------------------------------------------------------------------------
const MIGRATION_MAX_MS = Number(process.env.MIGRATION_MAX_MS || 120000);
const watchdog = setTimeout(() => {
  console.error('!! Migration interrompue apres ' + Math.round(MIGRATION_MAX_MS / 1000) +
    ' s (base lente ou verrou). Le serveur demarre ; les schemas seront rattrapes.');
  process.exit(0);
}, MIGRATION_MAX_MS);
watchdog.unref && watchdog.unref();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Applique les schémas dans l'ordre : socle puis extensions (VAGUE 7).
  const schemaFiles = ['schema.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql', 'schema_v17.sql', 'schema_v18.sql', 'schema_v19.sql', 'schema_v20.sql', 'schema_v21.sql', 'schema_v22.sql', 'schema_v23.sql', 'schema_v24.sql', 'schema_v25.sql', 'schema_v26.sql', 'schema_v27.sql', 'schema_v28.sql', 'schema_v29.sql', 'schema_v30.sql'];
  for (const file of schemaFiles) {
    const schemaPath = path.resolve(__dirname, '../../db/' + file);
    if (!fs.existsSync(schemaPath)) {
      console.log('Schéma absent, ignoré : ' + file);
      continue;
    }
    const sql = fs.readFileSync(schemaPath, 'utf8');
    try {
      await pool.query(sql);
      console.log('Schéma appliqué : ' + file);
    } catch (e) {
      if (/already exists/.test(e.message)) {
        console.log('Schéma déjà présent (' + file + '), on continue.');
      } else {
        // Un schema qui echoue ne doit PLUS faire echouer le demarrage :
        // le serveur se met en ligne et le rattrapage reprendra la suite.
        console.error('!! Schéma en echec (' + file + ') : ' + e.message);
        continue;
      }
    }
  }

  // Crée l'IMF système "teebo" + l'administrateur teebo (super-admin).
  const email = process.env.TEEBO_ADMIN_EMAIL || 'hello@teebo.africa';
  const pwd = process.env.TEEBO_ADMIN_PASSWORD || 'Teebo#Admin2026';

  const existing = await q('SELECT id FROM imf WHERE code_imf = $1', ['TBO-SYS-000000']);
  let imfId;
  if (!existing.rows.length) {
    const imf = await q(
      `INSERT INTO imf(code_imf,name,type,country_code,city,capital_cents,
           bceao_agreement_no,phone_main,whatsapp,email,status)
       VALUES ('TBO-SYS-000000','teebo (système)','SA','CI','Abidjan',0,
           'N/A','+22650321432','+22650321432',$1,'active') RETURNING id`,
      [email]
    );
    imfId = imf.rows[0].id;
  } else {
    imfId = existing.rows[0].id;
  }

  const admin = await q('SELECT id FROM app_user WHERE email = $1 AND imf_id = $2', [email, imfId]);
  if (!admin.rows.length) {
    const hash = await bcrypt.hash(pwd, 12);
    const code = (await q('SELECT fn_gen_user_code($1) AS c', [imfId])).rows[0].c;
    await q(
      `INSERT INTO app_user(imf_id, code_user, full_name, email, role,
           password_hash, password_set_at, must_change_password)
       VALUES ($1,$2,'Administrateur teebo',$3,'teebo_admin',$4, now(), false)`,
      [imfId, code, email, hash]
    );
    console.log(`Admin teebo créé : ${email} (code ${code})`);
  } else {
    console.log('Admin teebo déjà présent.');
  }

  // Matérialise la structure organisationnelle (8 départements + services)
  // dans l'arbre org_unit de CHAQUE tenant existant. Idempotent.
  const tenants = await q('SELECT id FROM imf');
  let seeded = 0;
  for (const t of tenants.rows) {
    // Best-effort : un semis qui échoue (fonction absente dans un état
    // intermédiaire) ne doit jamais faire échouer toute la migration.
    try { await q('SELECT fn_seed_org_structure($1)', [t.id]); seeded++; }
    catch (e) { console.error('seed structure (' + t.id + ') ignoré :', e.code || e.message); }
  }
  console.log(`Structure org matérialisée pour ${seeded}/${tenants.rows.length} tenant(s).`);

  await pool.end();
  console.log('Migration terminée.');
}

main()
  .then(() => { clearTimeout(watchdog); process.exit(0); })
  .catch((e) => {
    console.error(e);
    // Code de sortie 0 : la migration ne doit jamais empecher le demarrage.
    clearTimeout(watchdog);
    process.exit(0);
  });
