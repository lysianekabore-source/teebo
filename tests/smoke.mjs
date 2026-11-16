// Verification REELLE : demarre le serveur dans ce processus, interroge, arrete.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const backend = path.resolve(new URL('.', import.meta.url).pathname, '../backend');
const env = { ...process.env, PORT: '3999', HOST: '127.0.0.1', MIGRATION_MAX_MS: '1' };
delete env.DATABASE_URL;

const child = spawn(process.execPath, ['src/server.js'], { cwd: backend, env, stdio: 'pipe' });
let log = '';
child.on('error', (e) => (log += '\nSPAWN:' + e.message));
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const get = (p, method = 'GET', forceHost = false) =>
  new Promise((res) => {
    const port = forceHost ? 3999 : (globalThis.PORT || 3999);
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (resp) => {
      let body = '';
      resp.on('data', (c) => (body += c));
      resp.on('end', () => res({ code: resp.statusCode, body, type: resp.headers['content-type'] || '' }));
    });
    r.on('error', () => res({ code: 'ERREUR', body: '', type: '' }));
    r.end();
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = true;
const check = (label, cond, extra = '') => {
  if (!cond) ok = false;
  console.log(`${cond ? 'OK  ' : 'ECHEC'} ${label}${extra ? ' -> ' + extra : ''}`);
};

try {
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await wait(500);
    const h = await get('/healthz');
    up = h.code === 200;
  }
  check('/healthz repond 200', up);
  if (!up) { console.log(log.slice(0, 1200)); child.kill('SIGKILL'); process.exit(1); }

  const h = await get('/healthz');
  console.log('     contenu healthz :', h.body.slice(0, 120));

  const page = await get('/console-admin');
  check('/console-admin sert la page HTML', page.code === 200 && /<html/i.test(page.body), String(page.code));

  const js = await get('/console-admin.js');
  check('/console-admin.js sert le script', js.code === 200 && /javascript/i.test(js.type), `${js.code} ${js.type}`);

  const cfg = await get('/api/v1/institution/config');
  check('/institution/config exige un jeton (401/403)', cfg.code === 401 || cfg.code === 403, String(cfg.code));

  const id = '11111111-1111-1111-1111-111111111111';
  const r1 = await get(`/api/v1/admin/institutions/${id}/restrict-to-collecte`, 'POST');
  check('restreindre sans jeton = refuse', r1.code === 401 || r1.code === 403, String(r1.code));

  const r2 = await get(`/api/v1/admin/institutions/${id}/lift-restriction`, 'POST');
  check('lever sans jeton = refuse', r2.code === 401 || r2.code === 403, String(r2.code));

  const r3 = await get(`/api/v1/admin/institutions/${id}/access-state`);
  check('etat d acces sans jeton = refuse', r3.code === 401 || r3.code === 403, String(r3.code));

  const inconnu = await get('/route-qui-nexiste-pas');
  check('route inconnue = 404', inconnu.code === 404, String(inconnu.code));

  const crash = /ReferenceError|TypeError|is not a function|Cannot read/.test(log);
  check('aucune erreur fatale dans le journal', !crash);
  if (crash) console.log(log.slice(-1500));
} finally {
  child.kill('SIGTERM');
}

console.log(ok ? '\nRESULTAT : serveur OK' : '\nRESULTAT : PROBLEME');
process.exit(ok ? 0 : 1);
