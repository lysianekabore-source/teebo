import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole, requirePermission, filtrerHabilitations } from '../auth.js';
import { notifyWhatsApp, notifyEmail, waLink, mailtoLink, loginUrlFor, emailGatewayReady } from '../notify.js';
import { getBranding } from '../documents.js';
import { defaultPermissionKeysForRole, buildProfilesMatrix } from '../permissions.js';
import { positionInfo, POSITIONS as POSITIONS_IN_SOCLE } from '../org_structure.js';
import { envoyerCodeAcces, regenererCodeAcces, verifierEtCompleterCode,
         etatAcces } from '../codes_acces.js';

const router = express.Router();
router.use(['/units', '/users', '/notify-test', '/code-dispatches', '/profiles-matrix'], authenticate, requireFreshPassword);

// Les routes métier IMF ne sont accessibles qu'aux rôles rattachés à une IMF.
// teebo_admin n'a pas de hiérarchie IMF : il est redirigé vers sa propre console.
// NOTE : ce filtre peut désormais être traversé par une requête NON authentifiée
// (chemin inconnu sous /api/v1) ; sans la garde « !req.user » il levait
// « Cannot read properties of undefined (reading 'role') ».
router.use((req, res, next) => {
  if (!req.user) return next();          // laissé au routeur suivant / au 404
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

// ---------------------------------------------------------------------------
// CLOISONNEMENT : toute requête est filtrée par imf_id de l'utilisateur.
// Aucune donnée d'une autre IMF n'est accessible, sauf teebo_admin.
// ---------------------------------------------------------------------------
const KIND_ORDER = { direction: 1, department: 2, service: 3, agency: 4, point_service: 5 };

// ---------------------------------------------------------------------------
// RATTACHEMENTS AUTORISÉS (vague 68).
// La règle historique imposait « type du parent + 1 » : une agence ne pouvait
// donc exister QUE sous un service. En pratique, une IMF rattache ses agences
// à sa Direction Générale (réseau) ou à une direction/département, et un
// service peut dépendre directement de la DG sans département intermédiaire.
// On autorise donc ces raccourcis, tout en gardant la cohérence :
//   département -> direction
//   service     -> direction | département
//   agence      -> direction | département | service
//   point de service -> agence uniquement
// Aucune donnée existante n'est invalidée : les anciennes chaînes restent
// valides, on ajoute seulement des rattachements possibles.
const PARENTS_OK = {
  direction: [],
  department: ['direction'],
  service: ['direction', 'department'],
  agency: ['direction', 'department', 'service'],
  point_service: ['agency']
};
function hierarchyOk(kind, parentKind) {
  if (!parentKind) return kind === 'direction';
  const allowed = PARENTS_OK[kind] || [];
  return allowed.indexOf(parentKind) >= 0;
}

// VAGUE 70 — Les libellés français (« agence », « point de service »,
// « département ») sont acceptés comme les valeurs techniques : un formulaire
// qui envoie le mot affiché à l'écran ne doit jamais échouer sur un nom de type.
const KIND_ALIASES = {
  direction: 'direction', directions: 'direction',
  departement: 'department', department: 'department',
  service: 'service', services: 'service',
  agence: 'agency', agency: 'agency',
  point_service: 'point_service', points_service: 'point_service'
};
function normKind(k) {
  const t = String(k == null ? '' : k).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  return KIND_ALIASES[t] || t;
}
const KIND_FR = { direction: 'la Direction Générale', department: 'un département',
  service: 'un service', agency: 'une agence', point_service: 'un point de service' };
const WHAT_FR = { direction: 'Une direction', department: 'Un département',
  service: 'Un service', agency: 'Une agence', point_service: 'Un point de service' };
// Accord du participe : « une agence ... rattachée », « un service ... rattaché ».
const FEMININ = { direction: true, agency: true };
function accord(kind) { return FEMININ[kind] ? 'e' : ''; }
// Message ACTIONNABLE : il dit ce qui est possible, pas seulement que c'est
// refusé. L'administrateur d'IMF comprend quoi choisir dans la liste.
function hierarchyMessage(kind, parentKind) {
  const allowed = PARENTS_OK[kind] || [];
  const quoi = WHAT_FR[kind] || 'Cette unité';
  const recu = parentKind ? (KIND_FR[parentKind] || parentKind) : 'cette unité';
  if (!allowed.length) return quoi + ' ne peut pas avoir d’unité parente.';
  const liste = allowed.map((k) => KIND_FR[k]).join(', ');
  return quoi + ' ne peut pas être rattaché' + accord(kind) + ' à ' + recu +
    '. Rattachement possible : ' + liste + '.';
}

// ---------------------------------------------------------------------------
// AUTO-RÉPARATION : si la base d'une IMF ne contient pas (ou plus) la table
// org_unit, le type unit_kind ou la fonction de génération de code (migration
// incomplète, base réinitialisée, etc.), l'ouverture de l'onglet Organisation
// renvoyait une « server_error » traduite par « Une erreur est survenue ».
// On recrée ici ces objets de façon idempotente pour que la lecture de l'arbre
// réussisse TOUJOURS, sans dépendre d'une re-migration manuelle.
let _orgSchemaEnsured = false;
async function ensureOrgSchema() {
  // Une agence peut ouvrir des POINTS DE SERVICE (guichet, caisse, marché…) :
  // la valeur est ajoutée aux bases déjà créées (idempotent). Exécutée seule,
  // donc en dehors de toute transaction : PostgreSQL l'exige pour un type.
  try { await q("ALTER TYPE unit_kind ADD VALUE IF NOT EXISTS 'point_service'"); }
  catch (e) { /* valeur déjà présente */ }
  // Base où le type était un texte contraint : on retire la contrainte pour
  // que les points de service puissent exister (aucune donnée modifiée).
  try { await q('ALTER TABLE org_unit DROP CONSTRAINT IF EXISTS org_unit_kind_check'); }
  catch (e) { /* table absente : créée juste après */ }
  await q(`
    DO $do$ BEGIN
      CREATE TYPE unit_kind AS ENUM ('direction','department','service','agency','point_service');
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

    CREATE TABLE IF NOT EXISTS org_unit (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      imf_id     UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
      parent_id  UUID REFERENCES org_unit(id) ON DELETE CASCADE,
      kind       unit_kind NOT NULL,
      code_unit  TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      city       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION fn_gen_unit_code(p_imf UUID, p_kind unit_kind) RETURNS TEXT
    LANGUAGE plpgsql AS $fn$
    DECLARE v_imf TEXT; v_seq INT; v_prefix TEXT; v_code TEXT;
    BEGIN
      SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
      v_prefix := CASE p_kind WHEN 'direction' THEN '-DIR-' WHEN 'department' THEN '-DEP-'
                              WHEN 'service' THEN '-SRV-' WHEN 'agency' THEN '-AGC-'
                              WHEN 'point_service' THEN '-PDS-' END;
      SELECT COALESCE(MAX(NULLIF(regexp_replace(code_unit, '^.*' || v_prefix, ''), '')::int), 0)
        INTO v_seq FROM org_unit
       WHERE imf_id = p_imf AND kind = p_kind AND code_unit ~ (v_prefix || '[0-9]+$');
      LOOP
        v_seq := v_seq + 1;
        v_code := v_imf || v_prefix || lpad(v_seq::text, 3, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM org_unit WHERE code_unit = v_code);
      END LOOP;
      RETURN v_code;
    END; $fn$;
  `);
  _orgSchemaEnsured = true;
}

// --- Arborescence des unités ------------------------------------------------
// Si l'IMF n'a encore AUCUNE unité (tenant créé après la dernière migration),
// on matérialise automatiquement la structure par défaut (Direction Générale +
// départements + services, cohérente kind=parent+1) via fn_seed_org_structure.
// Le semis est idempotent et best-effort : un échec ne doit jamais casser la
// simple lecture de l'arbre.
router.get('/units', async (req, res) => {
  const imf = req.user.imf_id;
  const fetchUnits = () => q(
    'SELECT * FROM org_unit WHERE imf_id=$1 ORDER BY kind, name', [imf]).then((r) => r.rows);
  let rows = [];
  let degraded = false;
  // 1) Lecture normale. En cas d'échec (objets absents dans cette base),
  //    on auto-répare le schéma puis on relit. On ne renvoie JAMAIS d'erreur
  //    500 : au pire une liste vide, pour que l'onglet reste fonctionnel.
  try {
    rows = await fetchUnits();
  } catch (e1) {
    console.error('units select échoué, auto-réparation:', e1.code || e1.message);
    try {
      await ensureOrgSchema();
      rows = await fetchUnits();
    } catch (e2) {
      console.error('units auto-réparation échouée:', e2.code || e2.message);
      degraded = true;
      rows = [];
    }
  }
  // 2) Tenant sans aucune unité : on matérialise la structure par défaut
  //    (Direction Générale + départements + services). Best-effort.
  if (!rows.length && !degraded) {
    try {
      await q('SELECT fn_seed_org_structure($1)', [imf]);
      rows = await fetchUnits();
    } catch (seedErr) {
      console.error('seed org_unit:', seedErr.code || seedErr.message);
    }
  }
  res.json({ units: rows, degraded: degraded || undefined });
});

router.post('/units', requirePermission('org.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const kind = normKind(body.kind);
    const name = body.name, city = body.city, parent_id = body.parent_id;
    if (!KIND_ORDER[kind]) return res.status(422).json({ error: 'invalid_kind' });
    if (!name) return res.status(422).json({ error: 'missing_name' });
    // Une unité sans parent ne peut être qu'une direction ; un point de service
    // n'existe jamais seul, il est toujours rattaché à une agence.
    if (!parent_id && kind !== 'direction') return res.status(422).json({ error: 'bad_hierarchy' });
    if (!_orgSchemaEnsured) { try { await ensureOrgSchema(); } catch (_) {} }
    const creer = () => tx(async (c) => {
      // Contrainte hiérarchique (voir PARENTS_OK) : direction > département >
      // service > agence > point de service, avec les raccourcis autorisés.
      if (parent_id) {
        const p = (await c.query('SELECT kind, imf_id FROM org_unit WHERE id=$1', [parent_id])).rows[0];
        if (!p || p.imf_id !== req.user.imf_id) { const e=new Error('bad_parent'); e.status=403; throw e; }
        if (!hierarchyOk(kind, p.kind)) {
          const e = new Error('bad_hierarchy'); e.status = 422; e.parentKind = p.kind; throw e;
        }
      }
      const code = (await c.query('SELECT fn_gen_unit_code($1,$2) AS c', [req.user.imf_id, kind])).rows[0].c;
      const r = (await c.query(
        `INSERT INTO org_unit(imf_id,parent_id,kind,code_unit,name,city)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.user.imf_id, parent_id || null, kind, code, name, city || null])).rows[0];
      return r;
    });
    let out;
    try {
      out = await creer();
    } catch (e1) {
      // Base HISTORIQUE : soit une contrainte CHECK limitait les valeurs de
      // « kind » (elle bloquait les points de service), soit le type enum n'a
      // pas encore sa valeur. On répare une fois, puis on réessaie : l'admin
      // n'a jamais à voir une erreur de base de données.
      let repare = false;
      if (e1 && e1.code === '23514') {
        try { await q('ALTER TABLE org_unit DROP CONSTRAINT IF EXISTS org_unit_kind_check'); repare = true; } catch (_) {}
      } else if (e1 && e1.code === '22P02') {
        try { await ensureOrgSchema(); repare = true; } catch (_) {}
      }
      if (!repare) throw e1;
      out = await creer();
    }
    res.json({ ok: true, unit: out });
  } catch (e) {
    // Base encore dépourvue du type « point de service » (migration non
    // passée) : on répond un message ACTIONNABLE au lieu d'une erreur 500.
    if (e && e.status === 422 && e.message === 'bad_hierarchy') {
      const k = normKind((req.body || {}).kind);
      return res.status(422).json({ error: 'bad_hierarchy',
        message: hierarchyMessage(k, e.parentKind || null),
        parents_acceptes: PARENTS_OK[k] || [] });
    }
    if (e && e.code === '22P02' && /point_service/.test(String(e.message || ''))) {
      return res.status(503).json({ error: 'server_outdated',
        message: "Les points de service ne sont pas encore ouverts sur cet espace. Réessayez dans un moment ; si le message revient, signalez-le à votre administrateur." });
    }
    next(e);
  }
});

// --- Modification d'une unité (type / nom / ville) --------------------------
// L'admin IMF peut renommer une unité, changer sa ville, ou changer son TYPE
// (direction/département/service/agence) à condition de préserver la cohérence
// hiérarchique : le type doit rester égal à (type du parent + 1) et être
// égal à (type de chaque enfant − 1). Le code d'unité est régénéré si le type
// change, pour refléter la nouvelle nature (DIR/DEP/SRV/AGC).
router.patch('/units/:id', requirePermission('org.manage'), async (req, res, next) => {
  try {
    const { kind, name, city } = req.body || {};
    if (kind !== undefined && !KIND_ORDER[kind]) return res.status(422).json({ error: 'invalid_kind' });
    if (name !== undefined && !String(name).trim()) return res.status(422).json({ error: 'missing_name' });
    if (!_orgSchemaEnsured) { try { await ensureOrgSchema(); } catch (_) {} }
    const out = await tx(async (c) => {
      const u = (await c.query('SELECT * FROM org_unit WHERE id=$1', [req.params.id])).rows[0];
      if (!u) { const e=new Error('not_found'); e.status=404; throw e; }
      if (u.imf_id !== req.user.imf_id) { const e=new Error('forbidden'); e.status=403; throw e; }
      let newKind = u.kind, newCode = u.code_unit;
      if (kind !== undefined && kind !== u.kind) {
        // Cohérence avec le parent.
        if (u.parent_id) {
          const p = (await c.query('SELECT kind FROM org_unit WHERE id=$1', [u.parent_id])).rows[0];
          if (!p || !hierarchyOk(kind, p.kind)) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
        } else if (kind !== 'direction') {
          // Une unité racine sans parent ne peut être qu'une direction.
          const e=new Error('bad_hierarchy'); e.status=422; throw e;
        }
        // Cohérence avec les enfants existants.
        const kids = (await c.query('SELECT kind FROM org_unit WHERE parent_id=$1', [u.id])).rows;
        for (const k of kids) {
          if (!hierarchyOk(k.kind, kind)) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
        }
        newKind = kind;
        newCode = (await c.query('SELECT fn_gen_unit_code($1,$2) AS c', [req.user.imf_id, kind])).rows[0].c;
      }
      const r = (await c.query(
        `UPDATE org_unit
            SET kind=$1, code_unit=$2,
                name = COALESCE($3, name),
                city = CASE WHEN $4::boolean THEN $5 ELSE city END
          WHERE id=$6 AND imf_id=$7 RETURNING *`,
        [newKind, newCode, (name !== undefined ? String(name).trim() : null),
         city !== undefined, (city !== undefined ? (String(city).trim() || null) : null),
         u.id, req.user.imf_id])).rows[0];
      return r;
    });
    res.json({ ok: true, unit: out });
  } catch (e) {
    // Base encore dépourvue du type « point de service » (migration non
    // passée) : on répond un message ACTIONNABLE au lieu d'une erreur 500.
    if (e && e.code === '22P02' && /point_service/.test(String(e.message || ''))) {
      return res.status(503).json({ error: 'server_outdated',
        message: "Les points de service ne sont pas encore ouverts sur cet espace. Réessayez dans un moment ; si le message revient, signalez-le à votre administrateur." });
    }
    next(e);
  }
});

// --- Suppression d'une unité (cascade sur les sous-unités) ------------------
router.delete('/units/:id', requirePermission('org.manage'), async (req, res, next) => {
  try {
    const { rows } = await q('SELECT id, imf_id FROM org_unit WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    // Cloisonnement : on ne supprime que dans sa propre IMF.
    if (rows[0].imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    await q('DELETE FROM org_unit WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Personnel (utilisateurs rattachés à une unité) ------------------------
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT u.id,u.code_user,u.full_name,u.email,u.phone,u.role,u.position,u.position_code,
              u.parent_id,u.dept_code,u.service_code,
              u.org_unit_id,u.must_change_password,u.is_active,o.name AS unit_name,
              o.kind AS unit_kind, o.code_unit AS unit_code, o.city AS unit_city
         FROM app_user u LEFT JOIN org_unit o ON o.id=u.org_unit_id
        WHERE u.imf_id=$1 AND u.role <> 'teebo_admin' ORDER BY u.created_at`,
      [req.user.imf_id]);
    res.json({ users: rows });
  } catch (e) { next(e); }
});

/** Le poste indiqué peut-il superviser un agent de collecte ?
 *  Deux sources de postes coexistent (socle teebo + postes personnalisés de
 *  l'IMF, table position_catalog) : on interroge les deux, sinon un Chef
 *  d'agence personnalisé serait refusé à tort (ou l'inverse). */
async function maySuperviseCollectors(c, positionCode, imfId) {
  if (!positionCode) return false;
  const known = positionInfo(positionCode);
  if (known) return Boolean(known.supervisesCollectors);
  const row = (await c.query(
    `SELECT can_supervise_collectors FROM position_catalog
      WHERE code=$1 AND (imf_id=$2 OR imf_id IS NULL) LIMIT 1`, [positionCode, imfId])).rows[0];
  if (row) return Boolean(row.can_supervise_collectors);
  return false;
}

router.post('/users', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const bodyIn = req.body || {};
    const full_name = typeof bodyIn.full_name === 'string' ? bodyIn.full_name.trim() : bodyIn.full_name;
    const email = typeof bodyIn.email === 'string' ? bodyIn.email.trim().toLowerCase() : bodyIn.email;
    const phone = typeof bodyIn.phone === 'string' ? bodyIn.phone.trim() : bodyIn.phone;
    const org_unit_id = bodyIn.org_unit_id || null;
    const position = bodyIn.position || null;
    let role = bodyIn.role || null;
    let position_code = bodyIn.position_code || null;
    let traceLabelNote = null;
    // Filet de securite : si l'interface n'a transmis que le LIBELLE du poste
    // (« Pilotage strategique - President du Conseil d'Administration (PCA) »),
    // on retrouve le code exact dans le socle puis dans le catalogue de l'IMF.
    // On ne refuse plus jamais une creation pour un simple libelle.
    if (!position_code && (bodyIn.position_label || position)) {
      const raw = String(bodyIn.position_label || position || '');
      const norm = (v) => String(v || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const target = norm(raw);
      const stripShort = (v) => norm(String(v || '').replace(/\s*[/(].*$/, ''));
      // CORRECTIF 13/11/2026-H — resolution SURE (jamais approximative).
      // « Directeur Général (DG) » est contenu dans « Directeur Général
      // Adjoint (DGA) » : une simple recherche de sous-chaîne pouvait donc
      // attribuer le MAUVAIS poste. Ordre retenu : egalite exacte, puis
      // libelle court, puis morceaux du texte affiche (de droite a gauche),
      // puis inclusion uniquement si elle est unique ou nettement plus longue.
      let hit = POSITIONS_IN_SOCLE.find((p) => norm(p.label) === target);
      if (!hit) hit = POSITIONS_IN_SOCLE.find((p) => stripShort(p.label) === target);
      if (!hit) {
        const parts = String(raw).split(/\u2014|\u2013|\s-\s/).map((x) => norm(x)).filter(Boolean);
        for (let i = parts.length - 1; i >= 0 && !hit; i--) {
          hit = POSITIONS_IN_SOCLE.find((p) => norm(p.label) === parts[i]);
        }
      }
      if (!hit && target) {
        const hits = POSITIONS_IN_SOCLE.filter((p) => {
          const np = norm(p.label);
          return np && (np.indexOf(target) >= 0 || target.indexOf(np) >= 0);
        }).sort((a, b) => norm(b.label).length - norm(a.label).length);
        if (hits.length === 1) hit = hits[0];
        else if (hits.length > 1 && norm(hits[0].label).length > norm(hits[1].label).length) hit = hits[0];
      }
      if (hit) position_code = hit.code;
      else {
        const row = (await q(
          `SELECT code FROM position_catalog WHERE imf_id=$1 ORDER BY label`, [req.user.imf_id]))
          .rows.find((x) => norm(x.code) === target || norm(x.code) === norm(String(raw).split(' — ').pop()));
        if (row) position_code = row.code;
      }
      if (position_code) traceLabelNote = String(raw);
    }
    let supervisor_id = bodyIn.supervisor_id || null;
    // DIAGNOSTIC : la création d'un utilisateur échouait « sans rien afficher ».
    // Le compte qui crée et le contenu reçu sont désormais tracés côté serveur
    // (sans mot de passe) pour permettre de retrouver la cause exacte.
    const trace = { who: { id: req.user.id, role: req.user.role, imf_id: req.user.imf_id },
      body: { full_name: !!full_name, email: !!email, phone: !!phone, position_code,
        position: position, position_label: traceLabelNote, org_unit_id, supervisor_id, role } };
    // Validation explicite : message clair en français, jamais un 422 muet.
    if (!full_name || !email) {
      return res.status(422).json({ error: 'missing_fields', field: !full_name ? 'full_name' : 'email',
        message: !full_name ? 'Le nom complet est obligatoire.' : 'L’adresse e-mail est obligatoire.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email))) {
      return res.status(422).json({ error: 'invalid_email', field: 'email', message: 'Adresse e-mail invalide.' });
    }

    // --- Dérivation à partir du POSTE (source de vérité si fourni) -----------
    // Le poste impose son rôle-archetype, son département et son service ;
    // on ne réécrit jamais ces valeurs à la main quand un poste est choisi.
    let posDept = null, posService = null, posLabel = position || null, pos = null;
    if (position_code) {
      pos = positionInfo(position_code);
      if (!pos) {
        // Poste CUSTOM créé par l'IMF (position_catalog, schema_v13).
        const row = (await q(
          `SELECT code,label,role_key,dept_code,service_code,
                  can_supervise_collectors,needs_supervisor
             FROM position_catalog
            WHERE code=$1 AND (imf_id=$2 OR imf_id IS NULL)`,
          [position_code, req.user.imf_id])).rows[0];
        if (!row) {
          try {
            await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, payload)
                     VALUES ($1,$2,$3,$4,$5)`,
              [req.user.imf_id, req.user.id, 'user.create.refused', 'app_user',
               JSON.stringify({ ...trace, reason: 'invalid_position' })]);
          } catch (_) { /* le journal ne doit jamais bloquer la réponse */ }
          return res.status(422).json({ error: 'invalid_position',
            message: 'Ce poste n’existe pas dans le catalogue de votre institution. Choisissez un autre poste.' });
        }
        pos = { code: row.code, label: row.label, role: row.role_key, dept: row.dept_code,
          service: row.service_code, supervisesCollectors: row.can_supervise_collectors,
          needsSupervisor: row.needs_supervisor };
      }
      role = pos.role;
      posDept = pos.dept;
      posService = pos.service;
      posLabel = pos.label;
    }
    // RÈGLE DE BLOCAGE — auto-assignation : un créateur ne peut pas désigner
    // son propre compte comme responsable hiérarchique du compte créé.
    if (supervisor_id && String(supervisor_id) === String(req.user.id)) {
      return res.status(422).json({ error: 'self_supervisor' });
    }
    if (!role) return res.status(422).json({ error: 'missing_fields', field: 'position_code',
      message: 'Choisissez un poste : c’est lui qui détermine le rôle et les permissions du compte.' });
    if (role === 'teebo_admin') return res.status(422).json({ error: 'invalid_role' });
    // Poste « Président du Conseil d'Administration » : le socle lui attribue le
    // rôle-archetype superadmin, réservé au compte de l'éditeur. Créé DEPUIS
    // l'espace d'une IMF il devient donc « pca_admin » (l'administrateur de
    // l'institution), exactement comme le fait la connexion (auth.js).
    if (position_code === 'POS_PCA' && (role === 'superadmin' || role === 'office_staff')) role = 'pca_admin';

    const out = await tx(async (c) => {
      if (org_unit_id) {
        const u = (await c.query('SELECT imf_id FROM org_unit WHERE id=$1', [org_unit_id])).rows[0];
        if (!u || u.imf_id !== req.user.imf_id) { const e=new Error('bad_unit'); e.status=403; throw e; }
      }
      // --- Règle de supervision de la collecte -------------------------------
      // Un agent de collecte DOIT être rattaché à un superviseur dont le poste
      // peut superviser la collecte : Chef d'agence OU Agent de crédit.
      if (pos && pos.needsSupervisor) {
        if (!supervisor_id) { const e=new Error('supervisor_required'); e.status=422; throw e; }
        const sup = (await c.query(
          'SELECT imf_id, position_code, is_active FROM app_user WHERE id=$1', [supervisor_id])).rows[0];
        if (!sup || sup.imf_id !== req.user.imf_id) { const e=new Error('bad_supervisor'); e.status=403; throw e; }
        if (!(await maySuperviseCollectors(c, sup.position_code, req.user.imf_id))) {
          const e=new Error('invalid_supervisor'); e.status=422; throw e; }
      } else {
        // Autres postes : le responsable hiérarchique est facultatif. S'il est
        // fourni (pré-rempli d'après le poste côté interface), on le valide
        // (même IMF) et on le conserve comme parent_id ; sinon aucun parent.
        if (supervisor_id) {
          const sup = (await c.query(
            'SELECT imf_id FROM app_user WHERE id=$1', [supervisor_id])).rows[0];
          if (!sup || sup.imf_id !== req.user.imf_id) { const e=new Error('bad_supervisor'); e.status=403; throw e; }
          if (String(supervisor_id) === String(req.user.id)) { const e=new Error('self_supervisor'); e.status=422; throw e; }
        } else {
          supervisor_id = null;
        }
      }
      // VAGUE 46 : code attribue ICI ; si ce code venait a manquer ou a entrer en
      // collision, le trigger trg_app_user_code_acces (BEFORE INSERT) prend le
      // relais et attribue automatiquement un code unique. Un compte ne peut
      // donc jamais exister sans code d'acces.
      const code = (await c.query('SELECT fn_gen_user_code($1) AS c', [req.user.imf_id])).rows[0].c;
      const r = (await c.query(
        `INSERT INTO app_user(imf_id,org_unit_id,parent_id,code_user,full_name,position,position_code,
             dept_code,service_code,email,phone,role,password_hash,must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,true) RETURNING id, code_user`,
        [req.user.imf_id, org_unit_id || null, supervisor_id || null, code, full_name, posLabel,
         position_code || null, posDept, posService, email, phone || null, role]
      )).rows[0];
      // Habilitations par défaut attachées au PROFIL/POSTE.
      // Priorité : habilitations par défaut du poste (position_default_permission,
      // surcharge IMF prioritaire) ; à défaut (poste sans réglage), la matrice
      // profils → droits du rôle-archetype. L'admin IMF peut ensuite cocher /
      // décocher chaque habilitation par poste ou par utilisateur.
      let perms = [];
      let source = 'position';
      if (position_code) {
        perms = (await c.query(
          'SELECT permission_key FROM fn_position_default_perms($1,$2)',
          [req.user.imf_id, position_code])).rows.map((x) => x.permission_key);
      }
      if (!perms.length) { perms = defaultPermissionKeysForRole(role); source = 'default'; }
      // VAGUE 47 — BUG DES DROITS IDENTIQUES : le compte créé ne doit JAMAIS
      // recevoir d'office l'accès complet de l'administrateur de l'IMF.
      // - les profils de surveillance (direction, PCA) sont plafonnés ;
      // - un compte de rôle ordinaire ne reçoit aucun droit de gestion du
      //   personnel, de la structure, des paramètres ni de la matrice.
      perms = filtrerHabilitations({ role, position_code }, perms);
      for (const key of perms) {
        await c.query(
          `INSERT INTO user_permission(imf_id, user_id, permission_key, allowed, source)
           VALUES ($1,$2,$3,true,$4)
           ON CONFLICT (user_id, permission_key) DO NOTHING`,
          [req.user.imf_id, r.id, key, source]);
      }
      return r;
    });
    // Diffusion du code d'accès à l'utilisateur, via les canaux de l'IMF.
    const send = await buildAccessCodeSend(req.user.imf_id, {
      id: out.id, full_name, email, phone, code_user: out.code_user
    }, { channel: 'creation', dispatchedBy: req.user.id, req,
         origin: originOf(req), dispatchedRole: req.user.role });
    res.json({ ok: true, id: out.id, code_user: out.code_user, send });
  } catch (e) { next(e); }
});

// --- Renvoyer le code d'accès à un utilisateur existant ---------------------
// Corps facultatif : { channel: 'both' | 'email' | 'whatsapp', email, phone }.
// L'administrateur peut donc corriger l'adresse du destinataire et déclencher
// un envoi immédiat depuis le serveur (expéditeur = e-mail de l'IMF).
router.post('/users/:id/resend-code', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const u = (await q(
      `SELECT id, imf_id, full_name, email, phone, code_user
         FROM app_user WHERE id=$1`, [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });

    const b = req.body || {};
    const ch = ['email', 'whatsapp', 'both'].includes(b.channel) ? b.channel : 'both';
    const newEmail = typeof b.email === 'string' && b.email.trim() ? b.email.trim() : null;
    const newPhone = typeof b.phone === 'string' && b.phone.trim() ? b.phone.trim() : null;
    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(422).json({ error: 'invalid_email',
        message: 'Adresse e-mail invalide.' });
    }
    // Le contact corrigé est enregistré pour les envois suivants.
    if (newEmail || newPhone) {
      try {
        await q(`UPDATE app_user SET email = COALESCE($2, email), phone = COALESCE($3, phone),
                        updated_at = now() WHERE id=$1 AND imf_id=$4`,
          [u.id, newEmail, newPhone, req.user.imf_id]);
      } catch (e) { /* enregistrement secondaire */ }
    }

    const send = await buildAccessCodeSend(req.user.imf_id, {
      id: u.id, full_name: u.full_name, email: newEmail || u.email,
      phone: newPhone || u.phone, code_user: u.code_user
    }, { channel: ch, dispatchedBy: req.user.id, req,
         notes: (b.note || b.notes || null), origin: originOf(req),
         dispatchedRole: req.user.role });
    res.json({ ok: true, id: u.id, code_user: u.code_user, send });
  } catch (e) { next(e); }
});

/**
 * Construit le message du code d'accès et les liens d'envoi « prêts à cliquer ».
 * ---------------------------------------------------------------------------
 * - Signe le message avec les coordonnées expéditrices de l'IMF (numéro
 *   WhatsApp + e-mail paramétrés dans « Paramètres IMF », avec repli sur la
 *   fiche imf).
 * - Tente l'envoi automatique (WhatsApp Cloud API / SMTP si configurés).
 * - Renvoie TOUJOURS des liens wa.me / mailto (pré-remplis) pour permettre un
 *   envoi manuel immédiat depuis le compte de l'administrateur, même sans
 *   passerelle configurée.
 */
async function buildAccessCodeSend(imfId, user, ctx = {}) {
  // VAGUE 46 : la construction du message, l'envoi automatique, le journal et
  // les liens manuels sont dans backend/src/codes_acces.js — une seule source
  // pour l'espace IMF ET pour la console de l'administrateur teebo.
  return envoyerCodeAcces(imfId, user, ctx);
}

/** Origine de la demande : espace IMF (interface) ou API (integration). */
function originOf(req) {
  const h = String(req.headers['x-teebo-origin'] || '').toLowerCase();
  if (h === 'console_teebo' || h === 'api' || h === 'systeme') return h;
  return 'espace_imf';
}

// --- Test d'envoi d'e-mail (bouton « Envoyer un e-mail de test ») ----------
// Vérifie la chaîne complète : passerelle serveur + adresse expéditrice de
// l'IMF. Renvoie un verdict en français, sans jargon.
router.post('/notify-test', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = (b.to || (req.user && req.user.email) || '').trim();
    const br = await getBranding(req.user.imf_id);
    const senderEmail = (b.email || br.notify_email || (br.imf && br.imf.email) || '').trim();
    const imfName = br.legal_name || (br.imf && br.imf.name) || 'votre institution';
    if (!to) return res.status(422).json({ ok: false, text: 'Aucune adresse de destination : renseignez votre e-mail dans « Mon accès ».' });
    if (!emailGatewayReady()) {
      return res.json({ ok: false, mode: 'not_configured',
        text: 'L’envoi automatique des messages n’est pas encore activé sur cet espace. Signalez-le à votre administrateur : les codes restent consultables dans la fiche de l’utilisateur.' });
    }
    const subject = `[Test] Envoi d’e-mails ${imfName} via teebo`;
    const body = [
      'Ceci est un message de test.', '',
      `Institution : ${imfName}`,
      `Adresse expéditrice configurée : ${senderEmail || '(non définie — repli sur l’adresse technique)'}`,
      `Destinataire : ${to}`, '',
      'Si vous lisez ce message, l’envoi automatique des codes d’accès fonctionne.',
      '(-- teebo)'
    ].join('\n');
    const r = await notifyEmail(to, subject, body, { fromName: imfName, fromEmail: senderEmail });
    if (r.ok) {
      return res.json({ ok: true, mode: 'sent', from: r.from || null, to,
        text: `E-mail de test envoyé à ${to}. Expéditeur affiché chez le destinataire : ${senderEmail || 'adresse technique'}.` });
    }
    return res.json({ ok: false, mode: r.mode || 'failed', error: r.error || null,
      text: `Envoi impossible : ${r.error || 'erreur inconnue'}. Vérifiez l’adresse expéditrice (elle doit être autorisée par votre fournisseur d’e-mail) et les réglages du serveur d’envoi.` });
  } catch (e) { next(e); }
});

// --- Rattachement hiérarchique (module Objectifs) ---------------------------
// Définit le responsable direct (parent_id) d'un agent : une collectrice
// dépend d'un superviseur, un superviseur d'un DG. Anti-cycle garanti.
router.patch('/users/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { parent_id, position, full_name, phone, email, org_unit_id } = req.body || {};
    const u = (await q(
      'SELECT id, imf_id, position_code FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    // Cloisonnement : on ne modifie que dans sa propre IMF.
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });

    // Cloisonnement de l'unité : impossible de rattacher un agent à l'agence
    // d'une autre institution, même par un appel direct de l'API.
    if (org_unit_id) {
      const ou = (await q('SELECT id, imf_id FROM org_unit WHERE id=$1', [org_unit_id])).rows[0];
      if (!ou || ou.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'bad_unit' });
    }

    // Un agent de collecte doit garder un responsable habilité (Chef d'agence
    // ou Agent de crédit) : on refuse un retrait ou un supérieur non habilité.
    const loserSel = positionInfo(u.position_code);
    let needsSup = Boolean(loserSel && loserSel.needsSupervisor);
    if (!needsSup && u.position_code) {
      const pr = (await q(
        `SELECT needs_supervisor FROM position_catalog
          WHERE code=$1 AND (imf_id=$2 OR imf_id IS NULL) LIMIT 1`,
        [u.position_code, req.user.imf_id])).rows[0];
      needsSup = Boolean(pr && pr.needs_supervisor);
    }
    if (needsSup && parent_id !== undefined) {
      if (!parent_id) return res.status(422).json({ error: 'supervisor_required' });
      const sup = (await q('SELECT id, imf_id, position_code FROM app_user WHERE id=$1', [parent_id])).rows[0];
      if (!sup || sup.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'bad_supervisor' });
      if (!(await maySuperviseCollectors({ query: q }, sup.position_code, req.user.imf_id))) {
        return res.status(422).json({ error: 'invalid_supervisor' });
      }
    }

    if (parent_id !== undefined && parent_id !== null) {
      // RÈGLE DE BLOCAGE — auto-assignation : impossible d'être son propre
      // responsable hiérarchique, y compris via un appel direct de l'API.
      if (String(parent_id) === String(req.params.id)) return res.status(422).json({ error: 'self_parent' });
      const p = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [parent_id])).rows[0];
      if (!p || p.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'bad_parent' });
      // Anti-cycle : le parent ne doit pas se trouver dans la descendance de u.
      const cyc = (await q(`
        WITH RECURSIVE sub AS (
            SELECT id FROM app_user WHERE parent_id=$1
            UNION ALL
            SELECT a.id FROM app_user a JOIN sub s ON a.parent_id=s.id
        ) SELECT 1 FROM sub WHERE id=$2 LIMIT 1`, [req.params.id, parent_id])).rows.length;
      if (cyc) return res.status(422).json({ error: 'cycle_detected' });
    }

    const out = await tx(async (c) => {
      const r = (await c.query(
        `UPDATE app_user
            SET parent_id = CASE WHEN $1::boolean THEN $2::uuid ELSE parent_id END,
                position  = COALESCE($3, position),
                full_name = COALESCE($4, full_name),
                phone     = COALESCE($5, phone),
                email     = COALESCE($8, email),
                org_unit_id = CASE WHEN $9::boolean THEN $10::uuid ELSE org_unit_id END
          WHERE id=$6 AND imf_id=$7
          RETURNING id, code_user, full_name, role, parent_id, position, phone, email, org_unit_id`,
        [parent_id !== undefined, parent_id ?? null, position ?? null, full_name ?? null, phone ?? null,
         req.params.id, req.user.imf_id, email ?? null,
         org_unit_id !== undefined, org_unit_id || null])).rows[0];
      return r;
    });
    res.json({ ok: true, user: out });
  } catch (e) { next(e); }
});

// --- Suppression d'un utilisateur ------------------------------------------
router.delete('/users/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    await q('DELETE FROM app_user WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- REGENERER le code d'acces d'un utilisateur (vague 46) ------------------
// Un code perdu, mal diffuse ou communique a la mauvaise personne ne bloque
// plus l'institution : l'administrateur IMF regenere, puis renvoie.
// Corps : { motif, channel, email, phone, envoyer }
router.post('/users/:id/regenerate-code', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    let nouveau;
    try {
      nouveau = await regenererCodeAcces(u.id, (req.body || {}).motif || 'Regeneration par l administrateur',
        req.user.id);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const etat = await etatAcces(u.id);
    let envoi = null;
    const b = req.body || {};
    if (b.envoyer !== false) {
      const ch = ['email', 'whatsapp', 'both'].includes(b.channel) ? b.channel : 'both';
      envoi = await buildAccessCodeSend(req.user.imf_id, {
        id: u.id, full_name: nouveau.full_name, email: b.email || etat.email,
        phone: b.phone || etat.phone, code_user: nouveau.nouveau_code
      }, { channel: ch, dispatchedBy: req.user.id, req, notes: b.motif || null,
           previousCode: nouveau.ancien_code, origin: originOf(req),
           dispatchedRole: req.user.role });
    }
    res.json({ ok: true, id: u.id, ancien_code: nouveau.ancien_code,
      code_user: nouveau.nouveau_code, mot_de_passe_a_creer: true, envoi });
  } catch (e) { next(e); }
});

// --- Suivi des envois de codes d'accès --------------------------------------
// Tableau de bord : journal + statistiques des codes envoyés au personnel.
router.get('/code-dispatches', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT d.id, d.recipient_name, d.code_user, d.to_phone, d.to_email,
              d.channel, d.whatsapp_mode, d.email_mode, d.created_at,
              a.full_name AS dispatched_by_name
         FROM code_dispatch_log d
         LEFT JOIN app_user a ON a.id = d.dispatched_by
        WHERE d.imf_id=$1
        ORDER BY d.created_at DESC
        LIMIT 200`, [req.user.imf_id]);
    const sent = (m) => m === 'sent';
    const stats = {
      total: rows.length,
      creation: rows.filter((r) => r.channel === 'creation').length,
      resend: rows.filter((r) => r.channel === 'resend').length,
      whatsapp_sent: rows.filter((r) => sent(r.whatsapp_mode)).length,
      email_sent: rows.filter((r) => sent(r.email_mode)).length
    };
    res.json({ dispatches: rows, stats });
  } catch (e) { next(e); }
});

// --- Matrice des profils & habilitations par défaut (référentiel) ------------
// Consultable par l'administrateur IMF et la direction. (La console teebo
// expose la même matrice via /api/v1/teebo/profiles-matrix.)
router.get('/profiles-matrix', requireRole('admin_imf', 'direction'), (req, res) => {
  res.json(buildProfilesMatrix());
});

export default router;
