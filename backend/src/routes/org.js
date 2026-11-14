import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, waLink, mailtoLink, loginUrlFor, emailGatewayReady } from '../notify.js';
import { getBranding } from '../documents.js';
import { defaultPermissionKeysForRole, buildProfilesMatrix } from '../permissions.js';
import { positionInfo, POSITIONS as POSITIONS_IN_SOCLE } from '../org_structure.js';

const router = express.Router();
router.use(authenticate, requireFreshPassword);

// Les routes métier IMF ne sont accessibles qu'aux rôles rattachés à une IMF.
// teebo_admin n'a pas de hiérarchie IMF : il est redirigé vers sa propre console.
router.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

// ---------------------------------------------------------------------------
// CLOISONNEMENT : toute requête est filtrée par imf_id de l'utilisateur.
// Aucune donnée d'une autre IMF n'est accessible, sauf teebo_admin.
// ---------------------------------------------------------------------------
const KIND_ORDER = { direction: 1, department: 2, service: 3, agency: 4 };

// ---------------------------------------------------------------------------
// AUTO-RÉPARATION : si la base d'une IMF ne contient pas (ou plus) la table
// org_unit, le type unit_kind ou la fonction de génération de code (migration
// incomplète, base réinitialisée, etc.), l'ouverture de l'onglet Organisation
// renvoyait une « server_error » traduite par « Une erreur est survenue ».
// On recrée ici ces objets de façon idempotente pour que la lecture de l'arbre
// réussisse TOUJOURS, sans dépendre d'une re-migration manuelle.
let _orgSchemaEnsured = false;
async function ensureOrgSchema() {
  await q(`
    DO $do$ BEGIN
      CREATE TYPE unit_kind AS ENUM ('direction','department','service','agency');
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
                              WHEN 'service' THEN '-SRV-' WHEN 'agency' THEN '-AGC-' END;
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

router.post('/units', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { kind, name, city, parent_id } = req.body || {};
    if (!KIND_ORDER[kind]) return res.status(422).json({ error: 'invalid_kind' });
    if (!name) return res.status(422).json({ error: 'missing_name' });
    if (!_orgSchemaEnsured) { try { await ensureOrgSchema(); } catch (_) {} }
    const out = await tx(async (c) => {
      // Contrainte hiérarchique : department > direction, etc.
      if (parent_id) {
        const p = (await c.query('SELECT kind, imf_id FROM org_unit WHERE id=$1', [parent_id])).rows[0];
        if (!p || p.imf_id !== req.user.imf_id) { const e=new Error('bad_parent'); e.status=403; throw e; }
        if (KIND_ORDER[kind] !== KIND_ORDER[p.kind] + 1) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
      }
      const code = (await c.query('SELECT fn_gen_unit_code($1,$2) AS c', [req.user.imf_id, kind])).rows[0].c;
      const r = (await c.query(
        `INSERT INTO org_unit(imf_id,parent_id,kind,code_unit,name,city)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.user.imf_id, parent_id || null, kind, code, name, city || null])).rows[0];
      return r;
    });
    res.json({ ok: true, unit: out });
  } catch (e) { next(e); }
});

// --- Modification d'une unité (type / nom / ville) --------------------------
// L'admin IMF peut renommer une unité, changer sa ville, ou changer son TYPE
// (direction/département/service/agence) à condition de préserver la cohérence
// hiérarchique : le type doit rester égal à (type du parent + 1) et être
// égal à (type de chaque enfant − 1). Le code d'unité est régénéré si le type
// change, pour refléter la nouvelle nature (DIR/DEP/SRV/AGC).
router.patch('/units/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
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
          if (!p || KIND_ORDER[kind] !== KIND_ORDER[p.kind] + 1) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
        } else if (kind !== 'direction' && KIND_ORDER[kind] !== 1) {
          // Une unité racine sans parent ne peut être qu'une direction.
          const e=new Error('bad_hierarchy'); e.status=422; throw e;
        }
        // Cohérence avec les enfants existants.
        const kids = (await c.query('SELECT kind FROM org_unit WHERE parent_id=$1', [u.id])).rows;
        for (const k of kids) {
          if (KIND_ORDER[k.kind] !== KIND_ORDER[kind] + 1) { const e=new Error('bad_hierarchy'); e.status=422; throw e; }
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
  } catch (e) { next(e); }
});

// --- Suppression d'une unité (cascade sur les sous-unités) ------------------
router.delete('/units/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
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
              u.org_unit_id,u.must_change_password,u.is_active,o.name AS unit_name
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

router.post('/users', requireRole('admin_imf','direction'), async (req, res, next) => {
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
    }, { channel: 'creation', dispatchedBy: req.user.id, req });
    res.json({ ok: true, id: out.id, code_user: out.code_user, send });
  } catch (e) { next(e); }
});

// --- Renvoyer le code d'accès à un utilisateur existant ---------------------
// Corps facultatif : { channel: 'both' | 'email' | 'whatsapp', email, phone }.
// L'administrateur peut donc corriger l'adresse du destinataire et déclencher
// un envoi immédiat depuis le serveur (expéditeur = e-mail de l'IMF).
router.post('/users/:id/resend-code', requireRole('admin_imf','direction'), async (req, res, next) => {
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
    }, { channel: ch, dispatchedBy: req.user.id, req });
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
  // Lien de connexion : celui du site réellement utilisé par l'administrateur
  // (req), jamais une adresse générique. Repli : PUBLIC_SITE_URL / défaut.
  const loginUrl = loginUrlFor(ctx.req);
  const br = await getBranding(imfId);
  const imfName = br.legal_name || (br.imf && br.imf.name) || 'votre institution';
  const senderWa = br.notify_whatsapp || (br.imf && br.imf.whatsapp) || '';
  const senderEmail = br.notify_email || (br.imf && br.imf.email) || '';
  const greeting = user.full_name ? `Bonjour ${user.full_name},` : 'Bonjour,';
  const subject = `Votre accès ${imfName} — code ${user.code_user}`;
  const lines = [
    greeting,
    '',
    `Votre accès à l'application ${imfName} (via teebo) est créé.`,
    `Code d'accès : ${user.code_user}`,
    `Connexion : ${loginUrl}`,
    `Dès votre première connexion, créez immédiatement votre mot de passe.`,
    '',
    `-- ${imfName}`,
    senderWa ? `WhatsApp : ${senderWa}` : null,
    senderEmail ? `E-mail : ${senderEmail}` : null
  ].filter((l) => l !== null);
  const message = lines.join('\n');

  // Canaux demandés : par défaut les deux ; l'admin peut cibler un seul canal
  // (ex. « renvoyer par e-mail uniquement »).
  const wantWa = ctx.channel !== 'email' && Boolean(user.phone);
  const wantMail = ctx.channel !== 'whatsapp' && Boolean(user.email);

  // Envoi automatique (ne bloque jamais la création / l'enregistrement).
  let wa_auto = null, mail_auto = null;
  if (wantWa) {
    try { wa_auto = await notifyWhatsApp(user.phone, message); }
    catch (e) { wa_auto = { ok: false, error: e.message }; }
  }
  if (wantMail) {
    try {
      mail_auto = await notifyEmail(user.email, subject, message, {
        fromName: imfName, fromEmail: senderEmail
      });
    } catch (e) { mail_auto = { ok: false, error: e.message }; }
  }

  const modeOf = (r) => {
    if (!r) return 'skipped';
    if (r.mode) return r.mode;
    return r.ok ? 'sent' : 'failed';
  };
  const whatsappMode = modeOf(wa_auto);
  let emailMode = modeOf(mail_auto);

  // Journalisation de l'envoi (best-effort : ne bloque jamais la diffusion).
  try {
    await q(
      `INSERT INTO code_dispatch_log(imf_id, user_id, recipient_name, code_user,
           to_phone, to_email, channel, whatsapp_mode, email_mode, dispatched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [imfId, user.id || null, user.full_name || null, user.code_user || null,
       user.phone || null, user.email || null,
       ctx.channel === 'email' || ctx.channel === 'whatsapp' ? 'resend' : (ctx.channel || 'creation'),
       whatsappMode, emailMode, ctx.dispatchedBy || null]);
  } catch (e) { /* le journal est secondaire : on n'interrompt pas l'envoi */ }

  // Motifs lisibles, à afficher tels quels à l'administrateur.
  const emailReason = emailMode === 'sent' ? null
    : (mail_auto && mail_auto.error) || (wantMail ? 'Envoi impossible.' : 'Aucune adresse e-mail pour ce destinataire.');
  const waReason = whatsappMode === 'sent' ? null
    : (wa_auto && wa_auto.error) || (wantWa ? 'Envoi impossible.' : 'Aucun numéro WhatsApp pour ce destinataire.');

  return {
    message,
    subject,
    imf_name: imfName,
    sender_whatsapp: senderWa || null,
    sender_email: senderEmail || null,
    receiver_resolved: Boolean(senderEmail),
    // Liens prêts à cliquer vers le DESTINATAIRE (l'utilisateur).
    wa_link: user.phone ? waLink(user.phone, message) : null,
    mailto_link: user.email ? mailtoLink(user.email, subject, message) : null,
    to_phone: user.phone || null,
    to_email: user.email || null,
    whatsapp_mode: whatsappMode,
    email_mode: emailMode,
    email_reason: emailReason,
    whatsapp_reason: waReason,
    email_id: mail_auto && mail_auto.id ? mail_auto.id : null,
    email_from: mail_auto && mail_auto.from ? mail_auto.from : null,
    email_gateway: emailGatewayReady(),
    // Verdict immédiat, déjà rédigé en français pour l'écran d'envoi.
    email_status: emailMode === 'sent'
      ? { ok: true, text: `E-mail envoyé à ${user.email} (expéditeur : ${senderEmail || 'adresse technique'}).` }
      : { ok: false, text: emailReason || 'E-mail non envoyé.' }
  };
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
        text: 'La passerelle d’envoi n’est pas configurée sur le serveur. Les variables SMTP (serveur, port, identifiant, mot de passe) doivent être ajoutées sur Render, puis le service redéployé.' });
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
router.patch('/users/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const { parent_id, position, full_name, phone, email, org_unit_id } = req.body || {};
    const u = (await q(
      'SELECT id, imf_id, position_code FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    // Cloisonnement : on ne modifie que dans sa propre IMF.
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });

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
          RETURNING id, code_user, full_name, role, parent_id, position, phone, email`,
        [parent_id !== undefined, parent_id ?? null, position ?? null, full_name ?? null, phone ?? null,
         req.params.id, req.user.imf_id, email ?? null,
         org_unit_id !== undefined, org_unit_id || null])).rows[0];
      return r;
    });
    res.json({ ok: true, user: out });
  } catch (e) { next(e); }
});

// --- Suppression d'un utilisateur ------------------------------------------
router.delete('/users/:id', requireRole('admin_imf','direction'), async (req, res, next) => {
  try {
    const u = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.imf_id !== req.user.imf_id) return res.status(403).json({ error: 'forbidden' });
    await q('DELETE FROM app_user WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
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
