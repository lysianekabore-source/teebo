/* ===================================================================
 * teebo — NOTIFICATIONS AUTOMATIQUES D'OBJECTIF (VAGUE 7 extension)
 *
 * Objectif : informer automatiquement les acteurs concernés lorsque
 * leurs cibles franchissent des paliers clés :
 *
 *   half      -> 50 % de l'objectif atteint
 *   near      -> 80 % de l'objectif atteint
 *   achieved  -> 100 % de l'objectif atteint (ACHIEVED)
 *   failed    -> échéance dépassée sans atteinte (FAILED)
 *
 * Canaux : WhatsApp + e-mail (via ./notify.js) + journal interne
 * (table objective_notification) pour affichage dans l'application.
 *
 * Idempotence : la contrainte uq_objective_notification_event garantit
 * qu'un palier n'est émis qu'une seule fois par cible, même si plusieurs
 * opérations franchissent le seuil simultanément.
 *
 * En l'absence de configuration (variables d'environnement SMTP /
 * WhatsApp), le message est journalisé en mode dégradé — le test local
 * reste donc entièrement fonctionnel.
 * =================================================================== */
import { notifyWhatsApp, notifyEmail } from './notify.js';

// Paliers surveillés (dans l'ordre croissant).
export const THRESHOLDS = [
  { event: 'half', pct: 50, label: '50 % atteint' },
  { event: 'near', pct: 80, label: '80 % atteint' },
  { event: 'achieved', pct: 100, label: 'objectif atteint' }
];

/** Formate un nombre de façon lisible (séparateur d'espace). */
function fmt(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));
}

/**
 * Construit le message métier selon l'événement et le KPI.
 * @returns {{subject: string, body: string}}
 */
function buildMessage(ev, obj, user) {
  const pct = Number(obj.target_value) > 0
    ? Math.round((Number(obj.current_realized_value) / Number(obj.target_value)) * 100)
    : 0;
  const unit = obj.unit || '';
  const who = user.full_name || 'agent';
  const kpi = obj.kpi_type;
  const head = `teebo — Objectif ${kpi} de ${who}`;
  const progress = `Réalisé : ${fmt(obj.current_realized_value)} ${unit} / ${fmt(obj.target_value)} ${unit} (${pct} %)`;

  if (ev.event === 'achieved') {
    return {
      subject: `[teebo] Objectif ATTEINT — ${who} (${kpi})`,
      body: [head, '🎉 Objectif atteint à 100 % !', progress,
        `Période : ${obj.start_date} → ${obj.end_date}`].join('\n')
    };
  }
  if (ev.event === 'near') {
    return {
      subject: `[teebo] Objectif à 80 % — ${who} (${kpi})`,
      body: [head, '⚠️ Plus que 20 % pour atteindre la cible.', progress,
        `Manque : ${fmt(Number(obj.target_value) - Number(obj.current_realized_value))} ${unit}`].join('\n')
    };
  }
  if (ev.event === 'failed') {
    return {
      subject: `[teebo] Objectif NON ATTEINT — ${who} (${kpi})`,
      body: [head, '❌ Échéance dépassée sans atteinte de la cible.', progress,
        `Période close le : ${obj.end_date}`].join('\n')
    };
  }
  return {
    subject: `[teebo] Objectif à 50 % — ${who} (${kpi})`,
    body: [head, 'ℹ️ Mi-parcours : 50 % de l’objectif réalisé.', progress].join('\n')
  };
}

/**
 * Détermine quels paliers viennent d'être franchis par rapport à l'état
 * précédent (avantPct) et l'état courant (apresPct).
 */
export function crossingEvents(beforePct, afterPct, currentStatus) {
  const out = [];
  for (const t of THRESHOLDS) {
    if (beforePct < t.pct && afterPct >= t.pct) out.push(t);
  }
  // Statut ACHIEVED : on garantit l'émission du palier 100 % même si le
  // calcul de pourcentage avait déjà dépassé (cas de cible dépassée).
  if (currentStatus === 'ACHIEVED' && !out.some((e) => e.event === 'achieved')) {
    out.push(THRESHOLDS.find((t) => t.event === 'achieved'));
  }
  return out.filter(Boolean);
}

/**
 * Émet les notifications pour une cible donnée.
 *
 * @param {object} client  client SQL (dans la transaction courante)
 * @param {object} args
 *   @param {string} imfId
 *   @param {object} objective  ligne objective APRÈS mise à jour
 *   @param {number} beforeValue  réalisé avant l'incrément
 *   @param {boolean} dryRun  si vrai : journalise seulement (pas d'envoi réseau)
 * @returns {Promise<Array>} liste des notifications émises
 */
export async function notifyObjectiveMilestones(client, { imfId, objective, beforeValue, dryRun = false }) {
  const obj = objective;
  const target = Number(obj.target_value) || 0;
  if (target <= 0) return [];

  const beforePct = Math.round((Number(beforeValue) / target) * 100);
  const afterPct = Math.round((Number(obj.current_realized_value) / target) * 100);

  const events = crossingEvents(beforePct, afterPct, obj.status);
  if (!events.length) return [];

  // Récupère l'agent concerné (nom + coordonnées) une seule fois.
  const ures = await client.query(
    `SELECT id, full_name, email, phone FROM app_user WHERE id = $1`, [obj.assigned_to_user_id]
  );
  const user = ures.rows[0] || { full_name: 'agent' };

  const emitted = [];
  for (const ev of events) {
    const { subject, body } = buildMessage(ev, obj, user);
    const payload = { event: ev.event, threshold: ev.pct, kpi_type: obj.kpi_type,
      target_value: target, realized: Number(obj.current_realized_value),
      pct: afterPct, message: body };

    // 1) Journalisation préalable (idempotence). Si le palier a déjà été
    //    émis, ON CONFLICT DO NOTHING -> aucune ligne -> on n'envoie rien.
    const ins = await client.query(
      `INSERT INTO objective_notification
         (imf_id, objective_id, user_id, event, threshold, channel, status, payload)
       VALUES ($1,$2,$3,$4,$5,'inapp',$6,$7)
       ON CONFLICT (objective_id, event) DO NOTHING
       RETURNING id`,
      [imfId, obj.id, obj.assigned_to_user_id, ev.event, ev.pct,
       dryRun ? 'dev' : 'queued', JSON.stringify(payload)]
    );
    if (!ins.rowCount) continue; // palier déjà notifié

    // 2) Envoi effectif (WhatsApp + e-mail) — hors mode test.
    if (!dryRun) {
      try {
        if (user.phone) await notifyWhatsApp(user.phone, body);
        if (user.email) await notifyEmail(user.email, subject, body);
        await client.query(
          `UPDATE objective_notification SET status='sent' WHERE id=$1`, [ins.rows[0].id]
        );
      } catch (e) {
        await client.query(
          `UPDATE objective_notification SET status='failed', payload = payload || $2::jsonb WHERE id=$1`,
          [ins.rows[0].id, JSON.stringify({ error: String(e.message || e) })]
        );
      }
    }
    emitted.push({ event: ev.event, threshold: ev.pct, message: body });
  }
  return emitted;
}

/**
 * Balaye les cibles échues non atteintes et émet la notification 'failed'.
 * Utilisé par le recalcul de branche (pas de déclencheur d'événement pour
 * le passage au statut FAILED, qui dépend du calendrier).
 */
export async function notifyExpiredFailures(client, imfId) {
  const { rows } = await client.query(
    `SELECT o.* FROM objective o
      WHERE o.imf_id = $1 AND o.status = 'FAILED'
        AND o.target_value > 0
        AND NOT EXISTS (SELECT 1 FROM objective_notification n
                         WHERE n.objective_id = o.id AND n.event = 'failed')`,
    [imfId]
  );
  const out = [];
  for (const obj of rows) {
    const ures = await client.query(
      `SELECT id, full_name, email, phone FROM app_user WHERE id=$1`, [obj.assigned_to_user_id]
    );
    const user = ures.rows[0] || { full_name: 'agent' };
    const { subject, body } = buildMessage({ event: 'failed' }, obj, user);
    const ins = await client.query(
      `INSERT INTO objective_notification
         (imf_id, objective_id, user_id, event, threshold, channel, status, payload)
       VALUES ($1,$2,$3,'failed',100,'inapp','queued',$4)
       ON CONFLICT (objective_id, event) DO NOTHING RETURNING id`,
      [imfId, obj.id, obj.assigned_to_user_id, JSON.stringify({ event: 'failed', message: body })]
    );
    if (!ins.rowCount) continue;
    try {
      if (user.phone) await notifyWhatsApp(user.phone, body);
      if (user.email) await notifyEmail(user.email, subject, body);
      await client.query(`UPDATE objective_notification SET status='sent' WHERE id=$1`, [ins.rows[0].id]);
    } catch (e) {
      await client.query(`UPDATE objective_notification SET status='failed' WHERE id=$1`, [ins.rows[0].id]);
    }
    out.push({ objective_id: obj.id, event: 'failed' });
  }
  return out;
}
