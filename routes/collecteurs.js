// =========================================================================
// teebo — ROUTES COLLECTEURS
// Plafond de caisse, clôture, commissions, zoning, hors-ligne, reçus signés.
// =========================================================================
import { Router } from 'express';
import { q } from '../db.js';
import { requireRole, rolesOf } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import {
  assertCeilingAllows, addToEncours, clotureCaisse, caisseResume
} from '../cash_ceiling.js';
import { commissionSummary, computeCommission } from '../commissions.js';
import {
  LedgerError, signReceipt, verifyReceiptSignature,
  receiptQrPayload, pushOfflineEvent, verifyChain
} from '../ledger.js';

const r = Router();

const ADMIN = ['admin_imf', 'direction'];
const SUP = ['admin_imf', 'direction', 'department', 'service', 'agency'];
const STAFF = ['staff', 'agency', 'caissier', 'admin_imf', 'direction', 'department', 'service'];

/** L'appelant peut-il agir sur ce collecteur (lui-même ou son encadrement) ? */
function isSupervisor(req) {
  return rolesOf(req.user.role).some((p) => SUP.includes(p));
}

/* ------------------------------------------------------------------ */
/*  ÉTAT DE CAISSE                                                      */
/* ------------------------------------------------------------------ */
r.get('/collecteurs/caisse', requireRole(...STAFF), async (req, res, next) => {
  try {
    const cible = req.query.collecteur_id || req.user.id;
    if (String(cible) !== String(req.user.id) && !isSupervisor(req)) {
      return res.status(403).json({ error: 'permission_denied',
        message: 'Vous ne pouvez consulter que votre propre caisse.' });
    }
    const out = await tenantTransaction(req, (c) => caisseResume(c, req.dbImfId, cible));
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  CLÔTURE DE CAISSE + RAPPROCHEMENT                                   */
/* ------------------------------------------------------------------ */
r.post('/collecteurs/cloture', requireRole(...STAFF), habilit('cash.declare', 'cash.validate'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const cible = b.collecteur_user_id || req.user.id;
      if (String(cible) !== String(req.user.id) && !isSupervisor(req)) {
        return res.status(403).json({ error: 'permission_denied',
          message: 'Vous ne pouvez clôturer que votre propre caisse.' });
      }
      const out = await tenantTransaction(req, (c) => clotureCaisse(c, {
        institutionId: req.dbImfId,
        collecteurId: cible,
        jour: b.jour || null,
        montantDeclareCents: b.montant_declare_cents,
        commentaire: b.commentaire || null,
        actorId: req.user.id,
        deviceId: b.device_id || null
      }));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

/* ------------------------------------------------------------------ */
/*  COMMISSIONS                                                         */
/* ------------------------------------------------------------------ */
r.get('/collecteurs/commissions/summary', requireRole(...STAFF), async (req, res, next) => {
  try {
    const cible = req.query.collecteur_id || req.user.id;
    if (String(cible) !== String(req.user.id) && !isSupervisor(req)) {
      return res.status(403).json({ error: 'permission_denied',
        message: 'Vous ne pouvez consulter que vos propres commissions.' });
    }
    const out = await commissionSummary({ query: q }, req.dbImfId, cible,
      { from: req.query.from, to: req.query.to });
    res.json({ collecteur_id: cible, ...out });
  } catch (e) { next(e); }
});

r.get('/collecteurs/commissions/rules', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { rows } = await q(
      'SELECT * FROM commission_rules WHERE institution_id=$1 ORDER BY priorite, created_at',
      [req.dbImfId]);
    res.json({ rules: rows, modeles_disponibles: ['mise', 'pourcentage', 'fixe'] });
  } catch (e) { next(e); }
});

r.put('/collecteurs/commissions/rules', requireRole(...ADMIN), habilit('settings.manage'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const modele = ['mise', 'pourcentage', 'fixe'].includes(b.modele) ? b.modele : null;
      if (!modele) {
        return res.status(400).json({ error: 'modele_invalide',
          message: 'Choisissez un modèle de commission : mise, pourcentage ou fixe.' });
      }
      const pctImf = b.repartition_pct_imf == null ? 100 : Number(b.repartition_pct_imf);
      const pctCol = b.repartition_pct_collecteur == null ? 0 : Number(b.repartition_pct_collecteur);
      if (!(pctImf >= 0) || !(pctCol >= 0) || pctImf + pctCol > 100) {
        return res.status(400).json({ error: 'repartition_invalide',
          message: 'La somme des parts IMF et collecteur ne peut pas dépasser 100 %.' });
      }
      const codeRule = String(b.code_rule || 'DEFAUT').toUpperCase().slice(0, 40);
      const out = await tenantTransaction(req, async (c) => {
        const row = (await c.query(
          `INSERT INTO commission_rules
             (institution_id, code_rule, libelle, modele, taux_pct_bp, montant_fixe_cents,
              jours_cycle, montant_mise_cents, repartition_pct_imf, repartition_pct_collecteur,
              savings_product_code, priorite, actif, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (institution_id, code_rule) DO UPDATE SET
             libelle=EXCLUDED.libelle, modele=EXCLUDED.modele,
             taux_pct_bp=EXCLUDED.taux_pct_bp, montant_fixe_cents=EXCLUDED.montant_fixe_cents,
             jours_cycle=EXCLUDED.jours_cycle, montant_mise_cents=EXCLUDED.montant_mise_cents,
             repartition_pct_imf=EXCLUDED.repartition_pct_imf,
             repartition_pct_collecteur=EXCLUDED.repartition_pct_collecteur,
             savings_product_code=EXCLUDED.savings_product_code,
             priorite=EXCLUDED.priorite, actif=EXCLUDED.actif, updated_at=now()
           RETURNING *`,
          [req.dbImfId, codeRule, b.libelle || codeRule, modele,
           Math.max(0, Math.min(10000, Math.round(Number(b.taux_pct_bp || 0)))),
           Math.max(0, Math.round(Number(b.montant_fixe_cents || 0))),
           Math.max(1, Math.round(Number(b.jours_cycle || 31))),
           Math.max(0, Math.round(Number(b.montant_mise_cents || 0))),
           pctImf, pctCol, b.savings_product_code || null,
           b.priorite == null ? 100 : Number(b.priorite),
           b.actif !== false, req.user.id])).rows[0];
        await c.query(
          `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
           VALUES ($1,$2,'commission.rule.update','commission_rules',$3,$4::jsonb)`,
          [req.dbImfId, req.user.id, row.id, JSON.stringify(row)]);
        return row;
      });
      res.status(201).json({ rule: out });
    } catch (e) { next(e); }
  });

r.post('/collecteurs/commissions/simulate', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const b = req.body || {};
    const rule = {
      modele: b.modele || 'pourcentage',
      taux_pct_bp: b.taux_pct_bp || 0,
      montant_fixe_cents: b.montant_fixe_cents || 0,
      jours_cycle: b.jours_cycle || 31,
      montant_mise_cents: b.montant_mise_cents || 0,
      repartition_pct_imf: b.repartition_pct_imf == null ? 100 : b.repartition_pct_imf,
      repartition_pct_collecteur: b.repartition_pct_collecteur || 0
    };
    const montant = Number(b.montant_collecte_cents || 100000);
    const cycle = Math.max(1, Number(b.jours_cycle || 31));
    const simulation = computeCommission(rule, {
      montantCollecteCents: montant,
      nbCotisationsCycle: cycle,
      cotisationsPayees: Number(b.cotisations_payees || 0)
    });
    let cumul = 0;
    for (let i = 0; i < cycle; i++) {
      cumul += computeCommission(rule, {
        montantCollecteCents: montant, nbCotisationsCycle: cycle, cotisationsPayees: i
      }).commission;
    }
    res.json({ simulation, cumul_sur_cycle_cents: cumul,
      mise_cents: Number(b.montant_mise_cents || 0),
      conforme: rule.modele !== 'mise' || cumul === Number(b.montant_mise_cents || 0) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  PLAFOND DE CAISSE                                                   */
/* ------------------------------------------------------------------ */
r.put('/collecteurs/:id/plafond', requireRole(...ADMIN), habilit('settings.manage'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const plafond = Math.max(0, Math.round(Number(b.plafond_caisse_journalier_cents || 0)));
      const out = await tenantTransaction(req, async (c) => {
        const u = (await c.query('SELECT id FROM app_user WHERE id=$1 AND imf_id=$2',
          [req.params.id, req.dbImfId])).rows[0];
        if (!u) {
          throw new LedgerError('collecteur_introuvable',
            'Collecteur introuvable dans votre institution.', null, 404);
        }
        const row = (await c.query(
          `UPDATE collecteur_caisse SET plafond_caisse_journalier=$2, updated_at=now()
            WHERE collecteur_id=$1 RETURNING *`, [req.params.id, plafond])).rows[0];
        await c.query(
          `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
           VALUES ($1,$2,'collecteur.plafond.update','app_user',$3,$4::jsonb)`,
          [req.dbImfId, req.user.id, req.params.id,
           JSON.stringify({ plafond_caisse_journalier_cents: plafond })]);
        return row;
      });
      res.json({ caisse: out });
    } catch (e) { next(e); }
  });

/* ------------------------------------------------------------------ */
/*  ZONING STRICT                                                       */
/* ------------------------------------------------------------------ */
r.get('/collecteurs/:id/portefeuille', requireRole(...STAFF), async (req, res, next) => {
  try {
    const cible = req.params.id;
    if (String(cible) !== String(req.user.id) && !isSupervisor(req)) {
      return res.status(403).json({ error: 'permission_denied',
        message: 'Vous ne pouvez consulter que votre propre portefeuille.' });
    }
    const zones = (await q(
      `SELECT z.id, z.code_zone, z.nom FROM collecteur_zone cz
         JOIN zone_collecte z ON z.id = cz.zone_id
        WHERE cz.collecteur_id=$1 AND cz.imf_id=$2 AND cz.is_active=true AND z.actif=true`,
      [cible, req.dbImfId])).rows;
    const { rows } = await q(
      `SELECT c.id, c.code_client, c.full_name, c.phone, c.zone_collecte_id,
              c.is_frozen, a.id AS account_id, a.code_account, a.balance_cents
         FROM client c
         LEFT JOIN account a ON a.client_id = c.id
        WHERE c.imf_id=$1 AND c.collectrice_user_id=$2
          AND ($3::uuid[] IS NULL OR c.zone_collecte_id = ANY($3::uuid[]))
        ORDER BY c.full_name`,
      [req.dbImfId, cible, zones.length ? zones.map((z) => z.id) : null]);
    res.json({ collecteur_id: cible, zones, portefeuille: rows, taille: rows.length,
      zoning_actif: zones.length > 0 });
  } catch (e) { next(e); }
});

r.get('/collecteurs/peut-collecter/:clientId', requireRole(...STAFF), async (req, res, next) => {
  try {
    const cl = (await q(
      `SELECT id, code_client, full_name, collectrice_user_id, zone_collecte_id, is_frozen
         FROM client WHERE id=$1 AND imf_id=$2`, [req.params.clientId, req.dbImfId])).rows[0];
    if (!cl) return res.status(404).json({ autorise: false, raison: 'client_introuvable' });
    if (String(cl.collectrice_user_id) !== String(req.user.id)) {
      return res.status(403).json({ autorise: false, raison: 'hors_portefeuille',
        message: 'Ce client n’est pas dans votre portefeuille : collecte refusée.' });
    }
    if (cl.is_frozen) {
      return res.status(409).json({ autorise: false, raison: 'client_gele',
        message: 'Client gelé : collecte refusée.' });
    }
    if (cl.zone_collecte_id) {
      const z = (await q(
        `SELECT 1 FROM collecteur_zone WHERE collecteur_id=$1 AND zone_id=$2 AND is_active=true`,
        [req.user.id, cl.zone_collecte_id])).rows;
      if (!z.length) {
        return res.status(403).json({ autorise: false, raison: 'hors_zone',
          message: 'Ce client appartient à une zone qui ne vous est pas affectée : collecte refusée.' });
      }
    }
    res.json({ autorise: true,
      client: { id: cl.id, code_client: cl.code_client, full_name: cl.full_name } });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  SYNCHRONISATION HORS-LIGNE                                          */
/* ------------------------------------------------------------------ */
r.post('/collecteurs/sync/offline', requireRole(...STAFF), async (req, res, next) => {
  try {
    const b = req.body || {};
    const events = Array.isArray(b.events) ? b.events : [b];
    if (!events.length || (!events[0].event_uuid && !events[0].payload)) {
      return res.status(400).json({ error: 'no_event',
        message: 'Aucun événement à synchroniser.' });
    }
    const resultats = [];
    for (const ev of events) {
      try {
        const out = await tenantTransaction(req, (c) => pushOfflineEvent(c, {
          institutionId: req.dbImfId,
          eventUuid: ev.event_uuid,
          deviceId: ev.device_id || null,
          collecteurId: ev.collecteur_id || req.user.id,
          payload: ev.payload || {},
          seqLocal: ev.seq_local,
          deviceTimestamp: ev.device_timestamp
        }));
        resultats.push({ event_uuid: ev.event_uuid, ok: true,
          statut: out.duplicate ? 'doublon' : 'recu',
          seq_server: out.seq_server != null ? out.seq_server : null });
      } catch (e) {
        if (e instanceof LedgerError) {
          resultats.push({ event_uuid: ev.event_uuid, ok: false, code: e.code,
            message: e.message, detail: e.detail || null });
        } else { throw e; }
      }
    }
    const refus = resultats.filter((x) => !x.ok).length;
    res.status(refus ? 207 : 201).json({
      traites: resultats.length, acceptes: resultats.length - refus, refuses: refus, resultats });
  } catch (e) { next(e); }
});

r.get('/collecteurs/sync/status', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT status, COUNT(*)::int AS nb, MIN(server_timestamp) AS depuis
         FROM offline_sync_queue WHERE institution_id=$1
        GROUP BY status ORDER BY status`, [req.dbImfId]);
    res.json({ statuts: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  REÇUS SIGNÉS (QR hors-ligne) + VÉRIFICATION                         */
/* ------------------------------------------------------------------ */
r.post('/collecteurs/receipts/:receiptId/sign', requireRole(...STAFF), async (req, res, next) => {
  try {
    const rec = (await q(
      `SELECT r.*, o.user_id AS op_user_id, o.id AS op_id
         FROM receipt r LEFT JOIN operation o ON o.id = r.operation_id
        WHERE r.id=$1 AND r.imf_id=$2`, [req.params.receiptId, req.dbImfId])).rows[0];
    if (!rec) {
      return res.status(404).json({ error: 'receipt_introuvable',
        message: 'Reçu introuvable dans votre institution.' });
    }
    const pay = {
      transactionId: rec.op_id || rec.id,
      collecteurId: rec.op_user_id || rec.collectrice_user_id,
      amountCents: rec.amount_cents,
      timestamp: rec.created_at
    };
    const signed = signReceipt(pay);
    await q(
      `UPDATE receipt SET signature_hmac=$2, signature_algo=$3,
              signed_payload=$4, signed_at=now()
        WHERE id=$1 AND imf_id=$5`,
      [rec.id, signed.signature, signed.algo, signed.payload, req.dbImfId]);
    res.json({
      receipt_id: rec.id, code_receipt: rec.code_receipt,
      signature: signed.signature, algo: signed.algo, payload: signed.payload,
      qr: receiptQrPayload({ ...pay, signature: signed.signature }),
      affichage_seconds: rec.display_seconds || 60
    });
  } catch (e) { next(e); }
});

r.post('/collecteurs/receipts/verify', async (req, res, next) => {
  try {
    const b = req.body || {};
    let data = b;
    if (typeof b.qr === 'string' && b.qr.trim().startsWith('{')) {
      try { data = JSON.parse(b.qr); } catch (_e) { data = b; }
    }
    const pay = {
      transactionId: data.tx || b.transaction_id,
      collecteurId: data.col || b.collecteur_id,
      amountCents: data.amt != null ? data.amt : b.amount_cents,
      timestamp: data.ts || b.timestamp,
      signature: data.sig || b.signature
    };
    const verdict = verifyReceiptSignature(pay);
    res.json({ valide: verdict.valide, raison: verdict.raison || null,
      transaction_id: pay.transactionId || null,
      montant_cents: pay.amountCents != null ? Number(pay.amountCents) : null });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  INTÉGRITÉ DU GRAND LIVRE                                            */
/* ------------------------------------------------------------------ */
r.get('/collecteurs/ledger/verify', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const limite = Math.min(20000, Math.max(10, Number(req.query.limit || 5000)));
    const out = await tenantTransaction(req, (c) => verifyChain(c, req.dbImfId, limite));
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  CONTRÔLE DE PLAFOND AVANT COLLECTE (appelé par le terminal)         */
/* ------------------------------------------------------------------ */
r.post('/collecteurs/caisse/verifier', requireRole(...STAFF), async (req, res, next) => {
  try {
    const montant = Math.round(Number((req.body || {}).montant_cents || 0));
    if (!(montant > 0)) {
      return res.status(400).json({ error: 'montant_invalide',
        message: 'Indiquez le montant que vous voulez encaisser.' });
    }
    const out = await tenantTransaction(req, (c) =>
      assertCeilingAllows(c, req.dbImfId, req.user.id, montant));
    res.json({ autorise: true, ...out });
  } catch (e) { next(e); }
});

/* Apurement : versement remis au guichet (réduit l'encours de caisse). */
r.post('/collecteurs/caisse/apurement', requireRole(...STAFF), habilit('cash.declare'),
  async (req, res, next) => {
    try {
      const montant = Math.round(Number((req.body || {}).montant_cents || 0));
      if (!(montant > 0)) return res.status(400).json({ error: 'montant_invalide' });
      const out = await tenantTransaction(req, async (c) => {
        await addToEncours(c, req.dbImfId, req.user.id, -montant);
        return caisseResume(c, req.dbImfId, req.user.id);
      });
      res.json({ apurement_cents: montant, caisse: out });
    } catch (e) { next(e); }
  });

export default r;
