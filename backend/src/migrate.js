import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { pool, q } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Applique les schémas dans l'ordre : socle puis extensions (VAGUE 7).
  const schemaFiles = ['schema.sql', 'schema_v3.sql', 'schema_v4.sql'];
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
        throw e;
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

  await pool.end();
  console.log('Migration terminée.');
}

main().catch((e) => { console.error(e); process.exit(1); });
