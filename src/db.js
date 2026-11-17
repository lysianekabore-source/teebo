import pg from 'pg';

const { Pool } = pg;

// La base PostgreSQL geree par Render exige une connexion chiffree (SSL)
// des qu'on n'est PAS en local. On active donc SSL automatiquement,
// sauf pour localhost/127.0.0.1 (developpement). Ceci permet d'utiliser
// aussi bien l'URL interne que l'URL externe (.render.com) de la base.
function needSSL(url) {
  if (!url) return false;
  if (/@(localhost|127\.0\.0\.1|\[?::1\]?)[:/]/.test(url)) return false;
  return true;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needSSL(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000
});

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
