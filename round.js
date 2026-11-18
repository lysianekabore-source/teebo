import { Router } from 'express';
import { habilit } from '../rbac_strict.js';
import { q, tx } from '../db.js';
import { requireRole, canViewTeamData } from '../auth.js';
import { runFreezeSweep, unfreezeClient, getSchedule, scheduleCoversDay, isFrozen, FREEZE_AFTER_DAYS } from '../freeze.js';

const r = Router();

/* ===========================================================================
 * teebo — TOURNÉE DU JOUR DE LA COLLECTRICE
 *
 *  1. À la connexion d’une collectrice, l’application affiche PAR DÉFAUT la
 *     tournée du jour : les clients rattachés à la collectrice (chaîne de
 *     collecte) + ceux dont le PROGRAMME DE COLLECTE prévoit un passage
 *     aujourd’hui, ordonnés par ordre de passage.
 *  2. Chaque client affiché indique la DISTANCE (km) qui le sépare de la
 *     position courante de la collectrice (GPS du terminal).
 *  3. La collectrice VALIDE LA VISITE (bouton « Valider la visite ») avec
 *     capture GPS : le client quitte alors immédiatement la liste du jour.
 *  4. Un client NON VISITÉ reste dans la liste et REMONTE EN PREMIÈRE POSITION
 *     à chaque affichage.
 *  5. Un client sans visite pendant 1 mois est GELÉ automatiquement ; il est
 *     dégelé par le superviseur après explication de la collectrice.
 * ========================================================================= */

const FIELD = ['staff'];
const ALL = ['admin_imf','direction','department','service','agency','staff'];
const SUP = ['admin_imf','direction','department','service'];

function readPos(b, req) {
  const src = b || {};
  const lat = src.gps_lat !== undefined && src.gps_lat !== null && src.gps_lat !== ''
    ? Number(src.gps_lat) : (req.headers['x-device-lat'] ? Number(req.headers['x-device-lat']) : null);
  const lng = src.gps_lng !== undefined && src.gps_lng !== null && src.gps_lng !== ''
    ? Number(src.gps_lng) : (req.headers['x-device-lng'] ? Number(req.headers['x-device-lng']) : null);
  const acc = src.gps_accuracy_m !== undefined && src.gps_accuracy_m !== null && src.gps_accuracy_m !== ''
    ? Number(src.gps_accuracy_m) : null;
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return { lat: ok ? lat : null, lng: ok ? lng : null, accuracy_m: Number.isFinite(acc) ? acc : null, ok };
}

/** Arrondit une distance en mètres vers un libellé lisible. */
function distanceLabel(meters) {
  if (meters === null || meters === undefined) return null;
  const m = Number(meters);
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
}

/** Formule de Haversine (mètres) entre la position et le point d’un client. */
function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Ajoute la distance (m + libellé) entre la position et le point du client. */
function withDistance(rows, pos) {
  return rows.map((x) => {
    const meters = (pos.ok && x.gps_lat != null && x.gps_lng != null)
      ? metersBetween(pos.lat, pos.lng, Number(x.gps_lat), Number(x.gps_lng))
      : null;
    return {
      ...x,
      distance_m: meters === null ? null : Math.round(meters),
      distance_km: meters === null ? null : Number((meters / 1000).toFixed(3)),
      distance_label: distanceLabel(meters),
      frozen: !!x.frozen_at || x.is_frozen === true
    };
  });
}

/** Récupère ou crée la tournée du jour de la collectrice. */
async function ensureRound(c, imfId, userId) {
  const existing = (await c.query(
    `SELECT * FROM collection_round WHERE imf_id=$1 AND collectrice_user_id=$2 AND round_date=CURRENT_DATE`,
    [imfId, userId])).rows[0];
  if (existing) return existing;
  return (await c.query(
    `INSERT INTO collection_round(imf_id,collectrice_user_id,round_date,status)
     VALUES ($1,$2,CURRENT_DATE,'planned') RETURNING *`, [imfId, userId])).rows[0];
}

/* ------------------------------------------------------------------ */
/*  Tournée du jour (vue par défaut à la connexion de la collectrice)   */
/*                                                                      */
/*  Règles d’affichage :                                                */
/*   - un client DÉJÀ VISITÉ aujourd’hui est RETIRÉ de la liste ;       */
/*   - un client NON VISITÉ reste et REMONTE EN PREMIÈRE POSITION ;     */
/*   - les clients du PROGRAMME prévus aujourd’hui sont inclus ;        */
/*   - les clients gelés restent visibles mais marqués « gelé ».        */
/* ------------------------------------------------------------------ */
r.get('/round/today', habilit('round.view','round.manage','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  try {
    // Le compteur « sans visite » est recalculé à chaque affichage (gel auto 1 mois).
    if (!canViewTeamData(req.user.role)) { try { await runFreezeSweep(req.user.imf_id); } catch (e) { /* tolérant */ } }

    const pos = readPos(null, req);
    const targetId = canViewTeamData(req.user.role) ? (req.query.collectrice_user_id || req.user.id) : req.user.id;

    const round = (await q(
      `SELECT * FROM collection_round WHERE imf_id=$1 AND collectrice_user_id=$2 AND round_date=CURRENT_DATE`,
      [req.user.imf_id, targetId])).rows[0] || null;

    // 1) Clients du programme prévus aujourd’hui + clients rattachés à la collectrice.
    const dow = new Date().getDay();
    const pool = (await q(
      `SELECT c.id AS client_id, c.code_client, c.full_name, c.phone,
              c.frozen_at, c.is_frozen,
              a.code_account, a.balance_cents, a.status AS account_status,
              COALESCE(a.gps_lat, c.gps_lat) AS gps_lat,
              COALESCE(a.gps_lng, c.gps_lng) AS gps_lng,
              s.id AS schedule_id, s.weekdays, s.frequency, s.day_of_month,
              (SELECT MAX(v.visited_at)
                 FROM collection_round_visit v
                 JOIN collection_round rr ON rr.id=v.round_id
                WHERE v.client_id=c.id AND v.status='visited') AS last_visit_at
         FROM client c
         LEFT JOIN account a ON a.client_id=c.id
         LEFT JOIN client_schedule s ON s.client_id=c.id AND s.is_active=true
        WHERE c.imf_id=$1 AND c.collectrice_user_id=$2`, [req.user.imf_id, targetId])).rows;

    // 2) Décider qui est « du jour » : programme couvrant aujourd’hui, sinon client rattaché.
    const scheduledToday = pool.filter((x) => x.schedule_id && scheduleCoversDay(
      { weekdays: x.weekdays, frequency: x.frequency, day_of_month: x.day_of_month }, dow));
    const others = pool.filter((x) => !scheduledToday.includes(x));

    // 3) Qui a déjà été visité aujourd’hui ?
    const visitedToday = new Set();
    if (round) {
      const vis = (await q(
        `SELECT client_id FROM collection_round_visit
          WHERE round_id=$1 AND status='visited' AND visited_at::date = CURRENT_DATE`, [round.id])).rows;
      vis.forEach((v) => visitedToday.add(v.client_id));
      const logs = (await q(
        `SELECT DISTINCT client_id FROM client_visit_log
          WHERE imf_id=$1 AND collectrice_user_id=$2 AND visit_date=CURRENT_DATE`,
        [req.user.imf_id, targetId])).rows;
      logs.forEach((v) => visitedToday.add(v.client_id));
    }

    const manual = new Set();
    if (round) {
      const mv = (await q('SELECT client_id FROM collection_round_visit WHERE round_id=$1', [round.id])).rows;
      mv.forEach((v) => manual.add(v.client_id));
    }

    // 4) Suite du jour = programme du jour + ajouts manuels + clients rattachés,
    //    MOINS ceux déjà visités aujourd’hui.
    const seen = new Set();
    const dayList = [];
    const push = (x, source) => { if (!seen.has(x.client_id)) { seen.add(x.client_id); dayList.push({ ...x, visit_source: source }); } };
    scheduledToday.forEach((x) => push(x, 'programme'));
    others.forEach((x) => { if (manual.has(x.client_id)) push(x, 'manuel'); });
    others.forEach((x) => push(x, 'collectrice'));

    const pending = dayList.filter((x) => !visitedToday.has(x.client_id));
    // Unité de gel à jour pour l’affichage.
    const rows = await Promise.all(pending.map(async (x) => {
      const s = x.schedule_id ? { weekdays: x.weekdays, frequency: x.frequency, day_of_month: x.day_of_month } : null;
      return { ...x, schedule: s };
    }));

    // Tri : NON VISITÉS d’abord ; puis les clients « en retard » (sans visite depuis
    // longtemps) remontent en PREMIÈRE POSITION à chaque affichage.
    rows.sort((a, b) => {
      const ta = a.last_visit_at ? new Date(a.last_visit_at).getTime() : 0;
      const tb = b.last_visit_at ? new Date(b.last_visit_at).getTime() : 0;
      if (ta !== tb) return ta - tb;              // jamais visité / plus ancien = premier
      const da = a.distance_m == null ? Infinity : a.distance_m;
      const db = b.distance_m == null ? Infinity : b.distance_m;
      return da - db;                             // à défaut, le plus proche d’abord
    });

    res.json({
      round, collectrice_user_id: targetId,
      visits: withDistance(rows, pos),
      suggested: withDistance(rows, pos),
      position: pos.ok ? { lat: pos.lat, lng: pos.lng } : null,
      count: rows.length,
      visited_today_count: visitedToday.size,
      freeze_after_days: FREEZE_AFTER_DAYS,
      note: 'Les clients déjà visités aujourd’hui ont été retirés. Les non-visités remontent en tête de liste.'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Recherche de client (ajout à la tournée, régularisation, demande)   */
/* ------------------------------------------------------------------ */
r.get('/round/search', habilit('clients.read','round.view','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  try {
    const pos = readPos(null, req);
    const Q = String(req.query.q || '').trim();
    const params = [req.user.imf_id];
    let where = 'c.imf_id=$1';
    // Une collectrice ne voit que ses clients ; la supervision voit l’IMF.
    if (FIELD.includes(req.user.role)) { params.push(req.user.id); where += ` AND c.collectrice_user_id=$${params.length}`; }
    if (Q) {
      params.push('%' + Q + '%');
      const i = params.length;
      where += ` AND (c.full_name ILIKE $${i} OR c.code_client ILIKE $${i} OR a.code_account ILIKE $${i}` +
               ` OR c.phone ILIKE $${i} OR e.sig_account_no ILIKE $${i})`;
    }
    const { rows } = await q(
      `SELECT c.id AS client_id, c.code_client, c.full_name, c.phone,
              c.frozen_at, c.is_frozen,
              a.code_account, a.balance_cents, a.status AS account_status,
              COALESCE(a.gps_lat, c.gps_lat) AS gps_lat,
              COALESCE(a.gps_lng, c.gps_lng) AS gps_lng,
              e.sig_account_no, e.status AS enrollment_status,
              s.id AS schedule_id, s.weekdays, s.frequency, s.day_of_month
         FROM client c
         LEFT JOIN account a ON a.client_id = c.id
         LEFT JOIN client_enrollment e ON e.client_id = c.id
         LEFT JOIN client_schedule s ON s.client_id = c.id AND s.is_active=true
        WHERE ${where}
        ORDER BY c.full_name LIMIT 30`, params);
    const out = rows.map((x) => ({ ...x,
      schedule: x.schedule_id ? { weekdays: x.weekdays, frequency: x.frequency, day_of_month: x.day_of_month } : null }));
    res.json({ clients: withDistance(out, pos), count: rows.length,
      position: pos.ok ? { lat: pos.lat, lng: pos.lng } : null });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Constituer / mettre à jour la tournée du jour                       */
/* ------------------------------------------------------------------ */
r.post('/round/today/add', habilit('round.manage','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.client_ids) ? b.client_ids : (b.client_id ? [b.client_id] : []);
    if (!ids.length) return res.status(400).json({ error: 'au moins un client est requis' });
    const targetId = canViewTeamData(req.user.role) ? (b.collectrice_user_id || req.user.id) : req.user.id;

    const out = await tx(async (c) => {
      const round = await ensureRound(c, req.user.imf_id, targetId);
      let pos = (await c.query(
        'SELECT COALESCE(MAX(position),-1)+1 AS next FROM collection_round_visit WHERE round_id=$1',
        [round.id])).rows[0].next;
      const added = [];
      for (const cid of ids) {
        const cl = (await c.query('SELECT id, full_name FROM client WHERE id=$1 AND imf_id=$2',
          [cid, req.user.imf_id])).rows[0];
        if (!cl) continue;
        const v = (await c.query(
          `INSERT INTO collection_round_visit(round_id,client_id,position,visit_source)
           VALUES ($1,$2,$3,'recherche')
           ON CONFLICT (round_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id
           RETURNING *`, [round.id, cl.id, pos])).rows[0];
        pos++;
        added.push({ visit_id: v.id, client_id: cl.id, full_name: cl.full_name });
      }
      return { round, added };
    });
    res.status(201).json({ round: out.round, added: out.added, count: out.added.length,
      note: 'La position GPS du point de passage est enregistrée à la validation de la visite.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  VALIDER LA VISITE (bouton terrain) + CAPTURE GPS                    */
/*                                                                      */
/*  - enregistre le statut « visited » sur la tournée du jour           */
/*  - journalise une visite dans client_visit_log (compteur 1 mois)      */
/*  - met à jour client.last_visit_at (réarme le gel automatique)        */
/*  - renvoie le client retiré de la liste du jour                       */
/* ------------------------------------------------------------------ */
const checkIn = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ error: 'client_id requis' });
    const pos = readPos(b, req);
    const targetId = canViewTeamData(req.user.role) ? (b.collectrice_user_id || req.user.id) : req.user.id;

    // Le client doit appartenir à l’IMF (cloisonnement).
    const cl = (await q('SELECT id, full_name, code_client, is_frozen, frozen_at, frozen_reason FROM client WHERE id=$1 AND imf_id=$2',
      [b.client_id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });

    // Un client gelé ne peut pas être visité : il doit d’abord être dégelé
    // par le superviseur (après explication de la collectrice).
    if (isFrozen(cl) || cl.is_frozen === true)
      return res.status(409).json({ error: 'client_frozen',
        message: 'Client gelé : la visite est bloquée jusqu’au dégel par le superviseur.',
        detail: { frozen_reason: cl.frozen_reason, frozen_at: cl.frozen_at } });

    const out = await tx(async (c) => {
      const round = await ensureRound(c, req.user.imf_id, targetId);
      // 1) Marquer la visite dans la tournée du jour (ou la créer).
      const pos0 = (await c.query(
        'SELECT COALESCE(MAX(position),-1)+1 AS next FROM collection_round_visit WHERE round_id=$1',
        [round.id])).rows[0].next;
      const v = (await c.query(
        `INSERT INTO collection_round_visit(round_id,client_id,position,status,visited_at,
                note,visited_gps_lat,visited_gps_lng,visited_accuracy_m,visited_by,visit_source)
         VALUES ($1,$2,$3,'visited',now(),$4,$5,$6,$7,$8,'programme')
         ON CONFLICT (round_id,client_id) DO UPDATE SET
                status='visited', visited_at=now(), note=COALESCE(EXCLUDED.note, collection_round_visit.note),
                visited_gps_lat=EXCLUDED.visited_gps_lat, visited_gps_lng=EXCLUDED.visited_gps_lng,
                visited_accuracy_m=EXCLUDED.visited_accuracy_m, visited_by=EXCLUDED.visited_by
         RETURNING *`,
        [round.id, cl.id, pos0, b.note || null, pos.lat, pos.lng, pos.accuracy_m, req.user.id])).rows[0];

      // 2) Journal de visite (compteur « sans visite depuis X jours »).
      await c.query(
        `INSERT INTO client_visit_log(imf_id,client_id,collectrice_user_id,visit_date,gps_lat,gps_lng,accuracy_m,note)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7)`,
        [req.user.imf_id, cl.id, targetId, pos.lat, pos.lng, pos.accuracy_m, b.note || null]);

      // 3) Réarmer le gel automatique.
      await c.query('UPDATE client SET last_visit_at=now() WHERE id=$1', [cl.id]);
      return { visit: v, round };
    });

    res.json({
      ok: true,
      client: { client_id: cl.id, full_name: cl.full_name, code_client: cl.code_client },
      visit: out.visit,
      gps: pos.ok ? { lat: pos.lat, lng: pos.lng, accuracy_m: pos.accuracy_m } : null,
      gps_missing: !pos.ok,
      removed_from_round: true,
      note: pos.ok ? 'Visite validée avec position GPS.' : 'Visite validée (position GPS indisponible).'
    });
  } catch (e) { next(e); }
};

// Deux points d’entrée équivalents : /round/visits/:id/check-in (par visite) et
// /round/visits/check-in (par client) — le bouton « Valider la visite » utilise le second.
r.post('/round/visits/check-in', habilit('cash.declare','round.view','collecte.assign'), requireRole(...ALL), checkIn);
r.post('/round/visits/:id/check-in', habilit('cash.declare','round.view','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  // Compatibilité : si :id correspond à une visite, on récupère son client puis on délègue.
  try {
    const b = req.body || {};
    if (!b.client_id) {
      const v = (await q(
        `SELECT client_id FROM collection_round_visit WHERE id=$1 AND round_id IN
          (SELECT id FROM collection_round WHERE imf_id=$2)`, [req.params.id, req.user.imf_id])).rows[0];
      if (!v) return res.status(404).json({ error: 'visite_introuvable' });
      b.client_id = v.client_id;
    }
    req.body = b;
    return checkIn(req, res, next);
  } catch (e) { next(e); }
});

/** Retire un client de la tournée du jour. */
r.post('/round/today/remove', habilit('round.manage','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ error: 'client_id requis' });
    const n = (await q(
      `DELETE FROM collection_round_visit v
        USING collection_round r
        WHERE v.round_id=r.id AND r.imf_id=$1 AND r.round_date=CURRENT_DATE AND v.client_id=$2`,
      [req.user.imf_id, b.client_id])).rowCount;
    res.json({ ok: true, removed: n });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  PROGRAMME DE COLLECTE PAR CLIENT (jours fixés par la collectrice)   */
/* ------------------------------------------------------------------ */

/** Lire le programme d’un client. */
r.get('/clients/:id/schedule', habilit('clients.read','round.view','collecte.assign'), requireRole(...ALL), async (req, res, next) => {
  try {
    const cl = (await q('SELECT id, full_name FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const schedule = await getSchedule(cl.id);
    res.json({ client: cl, schedule });
  } catch (e) { next(e); }
});

/**
 * Fixer / modifier les jours de collecte d’un client.
 * Body : { weekdays:[0..6], frequency, day_of_month, note, client_id }
 */
r.post('/clients/:id/schedule', habilit('collecte.assign','round.manage'), requireRole(...ALL), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cl = (await q('SELECT id, full_name, collectrice_user_id FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });

    const weekdays = Array.isArray(b.weekdays)
      ? [...new Set(b.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
      : [];
    const frequency = ['hebdomadaire','bimensuel','mensuel','libre'].includes(b.frequency)
      ? b.frequency : 'hebdomadaire';
    const dom = b.day_of_month != null ? Number(b.day_of_month) : null;

    // Validation stricte : au moins un jour OU une fréquence « libre »/« mensuel ».
    if (weekdays.length === 0 && !['libre','mensuel'].includes(frequency)) {
      return res.status(400).json({ error: 'missing_fields', missing: ['jours de collecte'],
        message: 'Sélectionnez au moins un jour de passage.' });
    }
    if (frequency === 'mensuel' && !(dom >= 1 && dom <= 31)) {
      return res.status(400).json({ error: 'missing_fields', missing: ['jour du mois'],
        message: 'Pour une fréquence mensuelle, précisez le jour du mois (1 à 31).' });
    }

    const out = await tx(async (c) => {
      // Un seul programme actif à la fois : on désactive les précédents.
      await c.query('UPDATE client_schedule SET is_active=false, updated_at=now() WHERE client_id=$1', [cl.id]);
      const s = (await c.query(
        `INSERT INTO client_schedule(imf_id,client_id,collectrice_user_id,weekdays,frequency,
                day_of_month,note,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.imf_id, cl.id, cl.collectrice_user_id, weekdays, frequency, dom, b.note || null, req.user.id])).rows[0];
      return s;
    });
    res.status(201).json({ client: cl, schedule: out,
      note: 'Programme de collecte enregistré.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  GEL / DÉGEL DES CLIENTS                                             */
/* ------------------------------------------------------------------ */

/** Liste des clients gelés (supervision) ou des demandes d’explication en cours. */
r.get('/clients/frozen', habilit('clients.read','credit.read','credit.recovery'), requireRole(...ALL), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT c.id, c.code_client, c.full_name, c.phone, c.frozen_at, c.frozen_reason,
              c.frozen_auto, c.frozen_since_days, c.collectrice_user_id,
              u.full_name AS collectrice_name,
              (SELECT e.id FROM client_freeze_event e
                WHERE e.client_id=c.id AND e.kind='explanation_request' AND e.status='ouvert'
                ORDER BY e.created_at DESC LIMIT 1) AS open_explanation_id
         FROM client c
         LEFT JOIN app_user u ON u.id=c.collectrice_user_id
        WHERE c.imf_id=$1 AND (c.frozen_at IS NOT NULL OR c.is_frozen=true)
        ORDER BY c.frozen_at DESC NULLS LAST`, [req.user.imf_id]);
    res.json({ frozen: rows, count: rows.length });
  } catch (e) { next(e); }
});

/**
 * Le SUPERVISEUR demande à la collectrice d’expliquer le gel, CLIENT PAR CLIENT.
 * Body : { client_ids:[...], reason? }  (obligatoire : au moins un client)
 */
r.post('/clients/freeze-requests', habilit('clients.freeze','credit.recovery','clients.manage'), requireRole(...SUP), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.client_ids) ? b.client_ids : (b.client_id ? [b.client_id] : []);
    if (!ids.length) return res.status(400).json({ error: 'missing_fields', missing: ['clients'],
      message: 'Sélectionnez au moins un client gelé.' });
    const created = [];
    for (const cid of ids) {
      const cl = (await q('SELECT id, full_name, collectrice_user_id FROM client WHERE id=$1 AND imf_id=$2',
        [cid, req.user.imf_id])).rows[0];
      if (!cl) continue;
      const ev = (await q(
        `INSERT INTO client_freeze_event(imf_id,client_id,kind,status,requested_by,reason)
         VALUES ($1,$2,'explanation_request','ouvert',$3,$4) RETURNING *`,
        [req.user.imf_id, cl.id, req.user.id,
         b.reason || 'Merci d’expliquer les raisons du non-passage et du gel de ce client.'])).rows[0];
      created.push({ client_id: cl.id, full_name: cl.full_name, event_id: ev.id });
    }
    res.status(201).json({ requests: created, count: created.length,
      note: 'Demande d’explication transmise à la collectrice, client par client.' });
  } catch (e) { next(e); }
});

/** La collectrice répond (explication par client) ou demande un dégel motivé. */
r.post('/clients/:id/freeze-explanation', habilit('clients.freeze','credit.recovery','clients.manage'), requireRole(...ALL), async (req, res, next) => {
  try {
    const b = req.body || {};
    const explanation = String(b.explanation || '').trim();
    if (!explanation) return res.status(400).json({ error: 'missing_fields', missing: ['explication'],
      message: 'L’explication est obligatoire.' });
    const cl = (await q('SELECT id, full_name FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });

    const out = await tx(async (c) => {
      // On répond à la demande ouverte si elle existe, sinon on crée un événement
      // de demande de dégel motivée par la collectrice.
      const open = (await c.query(
        `SELECT id FROM client_freeze_event
          WHERE client_id=$1 AND status='ouvert' AND kind='explanation_request'
          ORDER BY created_at DESC LIMIT 1`, [cl.id])).rows[0];
      if (open) {
        return (await c.query(
          `UPDATE client_freeze_event SET kind='collection_explanation', status='repondu',
                  answered_by=$2, explanation=$3, answered_at=now()
            WHERE id=$1 RETURNING *`, [open.id, req.user.id, explanation])).rows[0];
      }
      return (await c.query(
        `INSERT INTO client_freeze_event(imf_id,client_id,kind,status,answered_by,explanation,
                requested_by,reason,answered_at)
         VALUES ($1,$2,$3,'repondu',$4,$5,$4,$6,now()) RETURNING *`,
        [req.user.imf_id, cl.id, b.request_unfreeze ? 'unfreeze_request' : 'collection_explanation',
         req.user.id, explanation,
         b.request_unfreeze ? 'Demande de dégel motivée par la collectrice.' : null])).rows[0];
    });
    res.status(201).json({ ok: true, event: out, client: cl });
  } catch (e) { next(e); }
});

/**
 * Le SUPERVISEUR dégèle un client (après explication et/ou demande motivée).
 * Body : { reason (obligatoire), explanation? }
 */
r.post('/clients/:id/unfreeze', habilit('clients.freeze','clients.manage'), requireRole(...SUP), async (req, res, next) => {
  try {
    const b = req.body || {};
    const reason = String(b.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'missing_fields', missing: ['motif'],
      message: 'Le motif du dégel est obligatoire.' });
    const cl = (await q('SELECT id, collectrice_user_id, frozen_at FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    if (!isFrozen(cl)) return res.status(409).json({ error: 'client_non_gele' });

    const out = await unfreezeClient({ imfId: req.user.imf_id, clientId: cl.id, actorId: req.user.id,
      actorRole: req.user.role, reason, explanation: b.explanation || null,
      collectriceId: cl.collectrice_user_id });
    res.json({ ok: true, ...out, note: 'Client dégelé par le superviseur.' });
  } catch (e) { next(e); }
});

/** Le SUPERVISEUR (ou l’administrateur) peut aussi GELER manuellement. */
r.post('/clients/:id/freeze', habilit('clients.freeze','clients.manage'), requireRole(...SUP), async (req, res, next) => {
  try {
    const b = req.body || {};
    const reason = String(b.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'missing_fields', missing: ['motif'],
      message: 'Le motif du gel est obligatoire.' });
    const cl = (await q('SELECT id FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    await q(`UPDATE client SET frozen_at=now(), frozen_reason=$2, frozen_by=$3,
                    frozen_auto=false, is_frozen=true WHERE id=$1`, [cl.id, reason, req.user.id]);
    await q(`INSERT INTO client_freeze_event(imf_id,client_id,kind,status,acted_by,reason)
             VALUES ($1,$2,'refreeze','clos',$3,$4)`, [req.user.imf_id, cl.id, req.user.id, reason]);
    res.status(201).json({ ok: true, client_id: cl.id, note: 'Client gelé.' });
  } catch (e) { next(e); }
});

/** Exécution manuelle de la tâche de gel automatique (1 mois sans visite). */
r.post('/clients/run-freeze-sweep', habilit('clients.freeze','clients.manage'), requireRole(...SUP), async (req, res, next) => {
  try {
    const frozen = await runFreezeSweep(req.user.imf_id);
    res.json({ ok: true, frozen, count: frozen.length,
      freeze_after_days: FREEZE_AFTER_DAYS,
      note: 'Clients sans visite depuis 1 mois gelés automatiquement.' });
  } catch (e) { next(e); }
});

/** Historique des événements de gel/dégel d’un client. */
r.get('/clients/:id/freeze-events', habilit('clients.read','clients.freeze','credit.recovery'), requireRole(...ALL), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT e.*, rq.full_name AS requested_by_name, an.full_name AS answered_by_name,
              ac.full_name AS acted_by_name
         FROM client_freeze_event e
         LEFT JOIN app_user rq ON rq.id=e.requested_by
         LEFT JOIN app_user an ON an.id=e.answered_by
         LEFT JOIN app_user ac ON ac.id=e.acted_by
        WHERE e.client_id=$1 AND e.imf_id=$2 ORDER BY e.created_at DESC`,
      [req.params.id, req.user.imf_id]);
    res.json({ events: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  Tableau de bord collectrice : visites, retards, gels                */
/* ------------------------------------------------------------------ */
r.get('/round/dashboard', habilit('round.view','objectives.dashboard','reports.read'), requireRole(...ALL), async (req, res, next) => {
  try {
    const targetId = canViewTeamData(req.user.role) ? (req.query.collectrice_user_id || req.user.id) : req.user.id;
    const today = (await q(
      `SELECT COUNT(*)::int AS n FROM client_visit_log
        WHERE imf_id=$1 AND collectrice_user_id=$2 AND visit_date=CURRENT_DATE`,
      [req.user.imf_id, targetId])).rows[0].n;
    const frozen = (await q(
      `SELECT COUNT(*)::int AS n FROM client
        WHERE imf_id=$1 AND collectrice_user_id=$2 AND (frozen_at IS NOT NULL OR is_frozen=true)`,
      [req.user.imf_id, targetId])).rows[0].n;
    const overdue = (await q(
      `SELECT COUNT(*)::int AS n FROM client c
        WHERE c.imf_id=$1 AND c.collectrice_user_id=$2
          AND COALESCE(c.last_visit_at, c.created_at) < now() - interval '15 days'`,
      [req.user.imf_id, targetId])).rows[0].n;
    const openExpl = (await q(
      `SELECT COUNT(*)::int AS n FROM client_freeze_event e
         JOIN client c ON c.id=e.client_id
        WHERE e.imf_id=$1 AND c.collectrice_user_id=$2
          AND e.status='ouvert' AND e.kind='explanation_request'`,
      [req.user.imf_id, targetId])).rows[0].n;
    res.json({ visits_today: today, frozen_clients: frozen, overdue_clients: overdue,
      pending_explanations: openExpl, freeze_after_days: FREEZE_AFTER_DAYS });
  } catch (e) { next(e); }
});

export default r;
