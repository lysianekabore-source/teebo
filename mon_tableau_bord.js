// =========================================================================
// teebo — MON TABLEAU DE BORD (agent de collecte, caissier, personnel)
//
// UN SEUL appel réseau qui agrège, pour l'utilisateur CONNECTÉ :
//   1. sa caisse du jour (encours vs plafond autorisé) + alerte de versement ;
//   2. ses versements DÉCLARÉS (en attente) vs VALIDÉS (du mois) ;
//   3. sa tournée du jour (visites, retards, clients gelés, explications) ;
//   4. ses objectifs individuels (% de réalisation) ;
//   5. ses commissions (mois en cours + en attente) ;
//   6. ses clients en retard d'échéance de crédit ;
//   7. ses 10 dernières opérations.
//
// PRINCIPE DE ROBUSTESSE : chaque bloc est isolé dans son propre try/catch.
// Si une table optionnelle n'existe pas encore en production, le bloc est
// simplement absent du JSON — le reste du tableau de bord s'affiche quand
// même. Aucun bloc ne peut faire échouer l'ensemble (plus de page blanche).
// =========================================================================
import { Router } from 'express';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { caisseResume } from '../cash_ceiling.js';
import { commissionSummary } from '../commissions.js';
import { listMyObjectives } from '../objectives_service.js';

const r = Router();

// Tout le personnel opérationnel : chacun ne voit QUE ses propres chiffres
// (l'identifiant utilisé est toujours celui du porteur du jeton).
const ALL = ['admin_imf', 'direction', 'department', 'service', 'agency', 'staff', 'caissier'];

/** Exécute un bloc sans jamais faire tomber la réponse complète. */
async function bloc(nom, fn, secours) {
  try {
    return await fn();
  } catch (e) {
    if (process.env.MON_TDB_DEBUG === '1') {
      console.warn('[mon-tableau-bord] bloc « ' + nom + ' » ignoré :', e && e.message);
    }
    return secours;
  }
}

/** Phrase d'action affichée sous la jauge de caisse. */
function messageCaisse(c) {
  if (!c || c.plafond_caisse_journalier_cents == null || c.plafond_caisse_journalier_cents <= 0) {
    return 'Aucun plafond de caisse paramétré par votre institution.';
  }
  if (c.bloque) return 'Caisse bloquée : ' + (c.motif_blocage || 'régularisation au guichet nécessaire.') +
    ' Aucune nouvelle collecte n’est possible avant le versement.';
  if (c.encours_caisse_actuel_cents >= c.plafond_caisse_journalier_cents) {
    return 'Plafond atteint : rentrez verser les espèces au guichet avant toute nouvelle collecte.';
  }
  if (c.alerte) {
    return 'Vous approchez du plafond : prévoyez de rentrer verser au guichet.';
  }
  return 'Vous restez sous votre plafond : la collecte peut continuer.';
}

r.get('/mon-tableau-bord', requireRole(...ALL), async (req, res) => {
  const imfId = req.dbImfId || req.user.imf_id;
  const uid = req.user.id;
  const aujourdhui = new Date().toISOString().slice(0, 10);

  /* ---------------- 1. Caisse : encours vs plafond ---------------- */
  const caisse = await bloc('caisse', async () => {
    const c = await tx((client) => caisseResume(client, imfId, uid));
    return { ...c, message: messageCaisse(c) };
  }, null);

  /* ---------------- 2. Versements déclarés / validés ---------------- */
  const versements = await bloc('versements', async () => {
    const tot = (await q(
      `SELECT COUNT(*) FILTER (WHERE status='declare')::int AS declares_nb,
              COALESCE(SUM(amount_cents) FILTER (WHERE status='declare'),0) AS declares_cents,
              COUNT(*) FILTER (WHERE status='valide'
                                 AND created_at >= date_trunc('month', now()))::int AS valides_nb,
              COALESCE(SUM(amount_cents) FILTER (WHERE status='valide'
                                 AND created_at >= date_trunc('month', now())),0) AS valides_cents,
              MAX(created_at) AS dernier_at
         FROM cash_deposit
        WHERE imf_id=$1 AND collectrice_user_id=$2`, [imfId, uid])).rows[0] || {};
    const derniers = (await q(
      `SELECT id, amount_cents, status, channel, created_at, validated_at
         FROM cash_deposit
        WHERE imf_id=$1 AND collectrice_user_id=$2
        ORDER BY created_at DESC LIMIT 5`, [imfId, uid])).rows;
    return {
      declares_nb: Number(tot.declares_nb || 0),
      declares_cents: Number(tot.declares_cents || 0),
      valides_nb: Number(tot.valides_nb || 0),
      valides_cents: Number(tot.valides_cents || 0),
      dernier_at: tot.dernier_at || null,
      derniers: derniers.map((d) => ({
        id: d.id, amount_cents: Number(d.amount_cents || 0), status: d.status,
        channel: d.channel, created_at: d.created_at, validated_at: d.validated_at
      }))
    };
  }, null);

  /* ---------------- 3. Tournée du jour ---------------- */
  const tournee = await bloc('tournee', async () => {
    const t = (await q(
      `SELECT
         (SELECT COUNT(*)::int FROM client_visit_log
           WHERE imf_id=$1 AND collectrice_user_id=$2 AND visit_date=CURRENT_DATE) AS visites,
         (SELECT COUNT(*)::int FROM client
           WHERE imf_id=$1 AND collectrice_user_id=$2
             AND (frozen_at IS NOT NULL OR is_frozen=true)) AS geles,
         (SELECT COUNT(*)::int FROM client c
           WHERE c.imf_id=$1 AND c.collectrice_user_id=$2
             AND COALESCE(c.last_visit_at, c.created_at) < now() - interval '15 days') AS en_retard,
         (SELECT COUNT(*)::int FROM client_freeze_event e
            JOIN client c ON c.id=e.client_id
           WHERE e.imf_id=$1 AND c.collectrice_user_id=$2
             AND e.status='ouvert' AND e.kind='explanation_request') AS explications,
         (SELECT COUNT(*)::int FROM client
           WHERE imf_id=$1 AND collectrice_user_id=$2) AS portefeuille`,
      [imfId, uid])).rows[0] || {};
    return {
      visites_today: Number(t.visites || 0),
      clients_geles: Number(t.geles || 0),
      clients_en_retard: Number(t.en_retard || 0),
      explications_ouvertes: Number(t.explications || 0),
      portefeuille: Number(t.portefeuille || 0)
    };
  }, null);

  /* ---------------- 4. Objectifs individuels ---------------- */
  const objectifs = await bloc('objectifs', async () => {
    const rows = await listMyObjectives(imfId, uid);
    const ordre = { MONTHLY: 0, DAILY: 1, QUARTERLY: 2, YEARLY: 3 };
    return (rows || [])
      .filter((o) => o && o.status !== 'FAILED')
      .sort((a, b) => {
        const pa = ordre[a.period] == null ? 9 : ordre[a.period];
        const pb = ordre[b.period] == null ? 9 : ordre[b.period];
        if (pa !== pb) return pa - pb;
        return Number(b.progress_pct || 0) - Number(a.progress_pct || 0);
      })
      .slice(0, 4)
      .map((o) => ({
        id: o.id,
        titre: o.title || (o.kpi_type === 'COLLECTION_VOLUME' ? 'Volume de collecte'
          : o.kpi_type === 'NEW_ACCOUNTS' ? 'Nouveaux comptes ouverts' : 'Taux de rétention'),
        kpi_type: o.kpi_type,
        periode: o.period,
        unite: o.unit || (o.kpi_type === 'COLLECTION_VOLUME' ? 'FCFA'
          : o.kpi_type === 'RETENTION_RATE' ? '%' : 'comptes'),
        cible: Number(o.target_value || 0),
        realise: Number(o.current_realized_value || 0),
        pct: Math.round(Number(o.progress_pct || 0)),
        statut: o.status,
        fin: o.end_date
      }));
  }, []);

  /* ---------------- 5. Commissions ---------------- */
  const commissions = await bloc('commissions', async () => {
    const s = await commissionSummary({ query: q }, imfId, uid, { from: aujourdhui, to: aujourdhui });
    const moisCourant = aujourdhui.slice(0, 7);
    const mois = (s.historique_mensuel || []).find((m) => m.mois === moisCourant) || null;
    return {
      mois_cents: mois ? Number(mois.total_cents || 0) : 0,
      part_collecteur_mois_cents: mois ? Number(mois.part_collecteur_cents || 0) : 0,
      part_collecteur_cumul_cents: Number(s.part_collecteur_cents || 0),
      en_attente_cents: Number(s.en_attente_cents || 0),
      nb_operations: Number(s.nb_operations || 0),
      nb_en_attente: Number(s.nb_en_attente || 0)
    };
  }, null);

  /* ---------------- 6. Clients en retard d'échéance de crédit ---------------- */
  const credit = await bloc('credit', async () => {
    const rows = (await q(
      `SELECT c.id AS client_id, c.full_name, c.code_client, c.phone,
              COUNT(*)::int AS nb_echeances,
              COALESCE(SUM(GREATEST(e.montant_echeance_cents
                                    - COALESCE(e.capital_paye_cents,0)
                                    - COALESCE(e.interet_paye_cents,0), 0)),0) AS du_cents,
              MAX(GREATEST(CURRENT_DATE - e.date_echeance, 0))::int AS jours_max
         FROM echeanciers_credit e
         JOIN dossiers_credit d ON d.id = e.dossier_id
         JOIN client c ON c.id = d.client_id
        WHERE e.imf_id=$1 AND c.collectrice_user_id=$2
          AND e.statut IN ('A_PAYER','PARTIEL','EN_RETARD')
          AND e.date_echeance < CURRENT_DATE
        GROUP BY c.id, c.full_name, c.code_client, c.phone
        ORDER BY jours_max DESC
        LIMIT 20`, [imfId, uid])).rows;
    const liste = rows.map((x) => ({
      client_id: x.client_id, nom: x.full_name, code_client: x.code_client,
      telephone: x.phone, nb_echeances: Number(x.nb_echeances || 0),
      du_cents: Number(x.du_cents || 0), jours_retard: Number(x.jours_max || 0)
    }));
    return {
      nb_clients: liste.length,
      montant_du_cents: liste.reduce((s, x) => s + x.du_cents, 0),
      jours_max: liste.length ? Math.max(...liste.map((x) => x.jours_retard)) : 0,
      liste: liste.slice(0, 5)
    };
  }, null);

  /* ---------------- 7. Dix dernières opérations ---------------- */
  const operations = await bloc('operations', async () => {
    const rows = (await q(
      `SELECT o.id, o.kind, o.status, o.amount_cents, o.created_at,
              o.impacts_agent_cash, c.full_name AS client_name, a.code_account
         FROM operation o
         JOIN account a ON a.id = o.account_id
         JOIN client c ON c.id = a.client_id
        WHERE o.imf_id=$1 AND o.user_id=$2
        ORDER BY o.created_at DESC
        LIMIT 10`, [imfId, uid])).rows;
    return rows.map((o) => ({
      id: o.id, kind: o.kind, status: o.status,
      montant_cents: Number(o.amount_cents || 0),
      date: o.created_at,
      impacts_agent_cash: o.impacts_agent_cash !== false,
      client: o.client_name, compte: o.code_account
    }));
  }, []);

  res.json({
    date: aujourdhui,
    utilisateur: {
      id: uid,
      nom: req.user.full_name || null,
      role: req.user.role || null,
      code_user: req.user.code_user || null
    },
    caisse, versements, tournee, objectifs, commissions, credit, operations
  });
});

export default r;
