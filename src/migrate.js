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
    ' s (base lente ou verrou). Les schemas restants seront rattrapes au prochain demarrage.');
  // CORRECTIF 52 : on ne tue le processus QUE si la migration tourne seule
  // (ligne de commande). Quand elle tourne dans le serveur, couper le processus
  // rendait l'API injoignable (502) : on se contente d'abandonner la migration.
  if (process.env.TEEBO_MIGRATE_STANDALONE === '1') process.exit(0);
}, MIGRATION_MAX_MS);
watchdog.unref && watchdog.unref();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // CORRECTIF 13/11/2026-B : on VÉRIFIE d'abord que la base répond. Sinon on
  // s'arrête en quelques secondes au lieu de tenter 32 fichiers et d'attendre
  // le délai global : le serveur prend la main tout de suite et la migration
  // sera rejouée au démarrage suivant (ou à la main) quand la base sera prête.
  if (!process.env.DATABASE_URL) {
    console.error('!! DATABASE_URL absente : aucune migration possible.');
    return;
  }
  // CORRECTIF 13/11/2026-D : trois essais rapides seulement (3 x 4 s).
  // Auparavant, une base encore endormie pouvait retarder le demarrage de
  // 20 s a 2 min ; desormais, au pire 12 s, alors que le serveur doit ouvrir
  // le port tout de suite (sante Render).
  let up = false;
  for (let i = 1; i <= 3 && !up; i++) {
    try {
      await Promise.race([
        q('SELECT 1'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('délai de connexion dépassé (4 s)')), 4000))
      ]);
      up = true;
    } catch (e) {
      console.error('!! Base injoignable (essai ' + i + '/3) : ' + (e && e.message));
    }
  }
  if (!up) {
    console.error('!! Migration reportée : le serveur démarre et réessaiera tout seul ' +
      '(voir /healthz et /ready).');
    return false;
  }

  // CORRECTIF 52 — CAUSE RACINE DU BUG « relation saas_modules_pricing does
  // not exist » : l'ancien test « la base est deja a jour ? » se contentait de
  // regarder deux tables du socle. Comme elles existaient, la migration
  // s'arretait la « pour toujours » : les vagues 33 et suivantes (tarifs des
  // modules, abonnements, vues et fonctions SaaS) n'ont JAMAIS été appliquées
  // en production. On remplace ce test par un VRAI marqueur : la table
  // schema_migrations retient, fichier par fichier, ce qui a été appliqué.
  let dejaAppliques = new Set();
  try {
    await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
               filename TEXT PRIMARY KEY,
               applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
               note TEXT)`);
    const base = await q("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_user'");
    const nb = await q('SELECT count(*)::int AS n FROM schema_migrations');
    if (base.rows.length && (nb.rows[0].n || 0) === 0) {
      // Base historique : le socle (jusqu'a la vague 32) est forcement passe.
      // On le marque pour ne pas le rejouer, et on laisse la main aux vagues
      // 33+ : ce sont exactement celles qui manquaient.
      await q(`INSERT INTO schema_migrations (filename, note)
                 SELECT f, 'socle historique (vague <= 32)'
                   FROM unnest($1::text[]) AS f
               ON CONFLICT DO NOTHING`,
        [['schema.sql','schema_v3.sql','schema_v4.sql','schema_v5.sql','schema_v6.sql',
          'schema_v7.sql','schema_v8.sql','schema_v9.sql','schema_v10.sql','schema_v11.sql',
          'schema_v12.sql','schema_v13.sql','schema_v14.sql','schema_v15.sql','schema_v16.sql',
          'schema_v17.sql','schema_v18.sql','schema_v19.sql','schema_v20.sql','schema_v21.sql',
          'schema_v22.sql','schema_v23.sql','schema_v24.sql','schema_v25.sql','schema_v26.sql',
          'schema_v27.sql','schema_v28.sql','schema_v29.sql','schema_v30.sql','schema_v31.sql',
          'schema_v32.sql']]);
      console.log('[migration] Marqueur initialise : socle (<= v32) considere comme applique. ' +
        'Les vagues 33+ vont etre appliquees.');
    } else if (base.rows.length) {
      console.log('[migration] Marqueur present : ' + nb.rows[0].n + ' schema(s) deja applique(s).');
    }
  } catch (e) {
    console.error('[migration] Marqueur indisponible (' + (e && (e.code || e.message)) +
      ') : tous les schemas seront rejoues, sans danger (scripts idempotents).');
  }

  // Applique les schémas dans l'ordre : socle puis extensions (VAGUE 7).
  // CORRECTIF VAGUE 34 : la liste etait ecrite a la main et s'arretait a
  // schema_v30. Les tables de l'actionnariat/societariat (detenteurs_capital,
  // mouvements_titres, parametres_capital, ag_quorum…) n'etaient donc JAMAIS
  // creees, et les routes renvoyaient une erreur 500. On lit desormais le
  // dossier db/ : toute nouvelle version de schema est appliquee
  // automatiquement, dans l'ordre numerique.
  // Emplacements possibles du dossier db/ :
  //   1) /app/db            (image Docker : db/ copie a la racine de l'image)
  //   2) ../db              (paquet arborescent backend/ + db/)
  //   3) ../../db           (ancienne arborescence backend/src + db/)
  // Le premier dossier contenant des fichiers schema*.sql est retenu.
  // CORRECTIF 13/11/2026-B : « Dossier db/ illisible : ENOENT ... '/db' ».
  // Le chemin '/db' venait d'un path.resolve sur un dossier de travail mal
  // résolu : on n'utilise plus que des chemins ABSOLUS fiables, et on affiche
  // en clair le dossier retenu pour que le journal Render soit parlant.
  const here = __dirname;                       // .../src
  const candidates = [
    process.env.TEEBO_DB_DIR,                   // /app/db (Dockerfile)
    path.resolve(here, '..', 'db'),             // backend/db
    path.resolve(here, '..', '..', 'db'),       // db/ à côté de backend/ (paquet livré)
    path.resolve(here, '..', '..', '..', 'db'), // db/ deux niveaux au-dessus
    '/app/db',
    path.resolve(process.cwd(), 'db'),
    path.resolve(process.cwd(), '..', 'db')
  ].filter(Boolean);
  const withSchemas = candidates.filter((d) => {
    try { return fs.readdirSync(d).some((f) => /^schema.*\.sql$/i.test(f)); } catch (e) { return false; }
  });
  const dbDir = withSchemas[0] || path.resolve(here, '..', 'db');
  if (withSchemas.length) {
    console.log('Dossier des migrations : ' + dbDir);
  } else {
    console.error('!! Aucun dossier db/ contenant schema*.sql. Emplacements essayés : ' + candidates.join(' | '));
  }
  const numOf = (f) => {
    const m = /^schema(?:_v(\d+))?([a-z]*)\.sql$/i.exec(f);
    return m ? Number(m[1] || 1) + (m[2] ? m[2].charCodeAt(0) / 1000 : 0) : null;
  };
  let schemaFiles = [];
  try {
    schemaFiles = fs.readdirSync(dbDir)
      .filter((f) => numOf(f) != null)
      .sort((a, b) => numOf(a) - numOf(b));
  } catch (e) {
    console.error('!! Dossier db/ illisible : ' + (e && e.message));
  }
  if (!schemaFiles.length) {
    schemaFiles = ['schema.sql', 'schema_v30.sql', 'schema_v31.sql', 'schema_v32.sql', 'schema_v33.sql'];
  }
  // Relit le marqueur pour ne rejouer que les schemas jamais appliques.
  try {
    const r = await q('SELECT filename FROM schema_migrations');
    r.rows.forEach((x) => dejaAppliques.add(x.filename));
  } catch (e) { /* table absente : on rejoue tout */ }
  const aFaire = schemaFiles.filter((f) => !dejaAppliques.has(f));
  if (!aFaire.length) {
    console.log('Tous les schemas sont deja appliques (' + schemaFiles.length + ' fichiers).');
  } else {
    console.log('Schemas a appliquer (' + aFaire.length + '/' + schemaFiles.length + ') : ' + aFaire.join(', '));
  }

  const marquer = async (file, note) => {
    try { await q('INSERT INTO schema_migrations (filename, note) VALUES ($1,$2) ON CONFLICT DO NOTHING', [file, note || null]); }
    catch (e) { /* marqueur facultatif */ }
  };

  for (const file of aFaire) {
    const schemaPath = path.resolve(dbDir, file);
    if (!fs.existsSync(schemaPath)) {
      console.log('Schéma absent, ignoré : ' + file);
      continue;
    }
    const sql = fs.readFileSync(schemaPath, 'utf8');
    // CORRECTIF 13/11/2026-E bis : chaque fichier tourne dans SA PROPRE
    // transaction. Avant, un script sans BEGIN/COMMIT pouvait laisser une
    // requete en erreur dans la session : toutes les instructions suivantes
    // echouaient alors en cascade (« current transaction is aborted »), et
    // des tables valides n'etaient jamais creees. Desormais un echec isole
    // reste isole. Un script venu d'ailleurs sans BEGIN reste couvert :
    // le savepoint de debut de transaction suffit.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Schéma appliqué : ' + file);
      await marquer(file, 'applique');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* session déjà fermée */ }
      if (/already exists/.test(e.message)) {
        console.log('Schéma déjà présent (' + file + '), on continue.');
        await marquer(file, 'deja present');
      } else {
        // Un schema qui echoue ne doit PAS faire echouer le demarrage :
        // le serveur se met en ligne, l'etat reste visible dans /ready,
        // et les scripts suivants sont quand meme appliques.
        console.error('!! Schéma en échec (' + file + ') : ' + e.message);
      }
    } finally {
      client.release();
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
    // VAGUE 46 : meme si code_user est fourni, le trigger BEFORE INSERT
    // (trg_app_user_code_acces) verifie l'unicite et attribue un code si besoin.
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

  // CORRECTIF VAGUE 48 — « le serveur s'arrête ~2 min après le démarrage ».
  // pool.end() fermait le pool PARTAGÉ avec l'API : toutes les routes
  // tombaient alors en « Cannot use a pool after calling end ». On ne ferme
  // plus le pool quand la migration tourne dans le serveur (usage par défaut).
  if (process.env.TEEBO_MIGRATE_STANDALONE === '1') {
    await pool.end();
  }
  console.log('Migration terminée.');
  return true;
}

export default main;

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  process.env.TEEBO_MIGRATE_STANDALONE = '1';
  main()
    .then(() => { clearTimeout(watchdog); process.exit(0); })
    .catch((e) => { console.error('Migration :', e && (e.message || e)); clearTimeout(watchdog); process.exit(0); });
}

