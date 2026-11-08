#!/usr/bin/env node
// teebo — Applique les migrations SQL dans l'ordre (001 -> 002 -> 003 -> 004).
// Usage : DATABASE_URL=postgres://... node scripts/migrate.mjs
// Les fichiers sont idempotents (CREATE IF NOT EXISTS / ON CONFLICT).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', 'sql');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant. Exemple : DATABASE_URL=postgres://... node scripts/migrate.mjs');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
console.log('Migrations à appliquer :', files.join(', '));

try {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
    process.stdout.write('  → ' + f + ' ... ');
    await pool.query(sql);
    console.log('OK');
  }
  console.log('Toutes les migrations ont été appliquées.');
} catch (e) {
  console.error('\nÉchec sur une migration :', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
