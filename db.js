// teebo — Connexion PostgreSQL (pool pg) pour l'API Habilitations
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

export const q = (text, params) => pool.query(text, params);
