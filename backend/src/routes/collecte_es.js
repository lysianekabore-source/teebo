// ===========================================================================
// teebo — VAGUE 37 : ROUTES DU MODULE COLLECTE & ÉPARGNE
// ===========================================================================
// Toutes les routes sont préfixées /api/v1/collecte-es/...
//   • cloisonnement : imf_id = req.dbImfId (jamais fourni par le client) ;
//   • habilitations : agent de collecte / caissier / chef d'agence ;
//   • idempotence : POST /sync peut être renvoyé 100 fois sans double débit ;
//   • une opération validée ne se modifie pas : POST /transactions/:id/contre-passer.
// =========================================================================
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import {
  CANAUX, COUPURES_FCFA, CANAUX_NOTIF, STATUTS_SYNC, CollecteError,
  estUuid, validerEvenement, classerEvenement, statutPour, planCycle,
  repartirCommission, carnetEchu, calculerBilletage, arreterCaisse,
  referenceRecu, preparerNotifications, resumerVague
} from '../collecte_es.js';

const r = Router();

/* Profils autorisés (les rôles-postes sont résolus par requireRole). */
const TERRAIN = ['agency', 'staff', 'service', 'department', 'caissier', 'admin_imf', 'direction'];
const CAISSE  = ['caissier', 'admin_imf', 'direction'];
const CHEF    = ['agency', 'department', 'service', 'admin_imf', 'direction'];
const ADMIN   = ['admin_imf', 'direction'];

/** Réponse d'erreur homogène pour le site. */
function echec(res, e) {
  if (e instanceof CollecteError) {
    return res.status(e.status || 422).json({ error: e.code, message: e.message, detail: e.detail || null });
  }
  throw e;
}

/** Le code d'erreur PostgreSQL 23505 = doublon (contrainte unique). */
function estDoublon(e) {
  return e && (e.code === '23505' || /duplicate key|uq_|unique/i.test(String(e.message || '')));
}

/* ========================================================================
 *  0. RÉFÉRENTIELS (aucune donnée sensible : listes figées)
 * ===================================================================== */
r.get('/collecte-es/referentiels', requireRole(...TERRAIN), (_req, res) => {
  res.json({
    canaux: CANAUX.map((c) => ({
      code: c,
      libelle: {
        TERRAIN_CASH: 'Espèces (collecte terrain)',
        GUICHET: 'Guichet / caisse agence',
        ORANGE_MONEY: 'Orange Money',
        MOOV_MONEY: 'Moov Money',
        WAVE: 'Wave',
        INTEROP_BCEAO: 'Interopérabilité BCEAO'
      }[c],
      reference_obligatoire: ['ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'].includes(c)
    })),
    coupures_fcfa: COUPURES_FCFA,
    statuts_sync: STATUTS_SYNC,
    canaux_notification: CANAUX_NOTIF,
    devises: ['XOF']
  });
});

/* ========================================================================
 *  1. SYNCHRONISATION HORS-LIGNE (idempotente)
 * ===================================================================== */
/**
 * POST /collecte-es/sync
 * Corps : { evenements: [ { uuid_local, code_client|account_id, montant,
 *           canal, reference_externe_mm, gps_lat, gps_lng,
 *           date_operation_locale, seq_local, device_timestamp } ] }
 *
 * Réponse 200 : { total, synchronises, doublons, rejetes,
 *                 montant_synchronise_cents, resultats: [...] }
 * Chaque résultat porte un statut définitif : SYNCHRONISE, REJETE_DOUBLON
 * (l'événement avait déjà été reçu : on renvoie l'opération existante) ou
 * REJETE (donnée invalide, motif dans `message`).
 */
r.post('/collecte-es/sync', requireRole(...TERRAIN), habilit('collecte.sync', 'operations.write'), async (req, res, next) => {
  try {
    const corps = req.body || {};
    const liste = Array.isArray(corps) ? corps
      : (Array.isArray(corps.evenements) ? corps.evenements : [corps]);
    if (!liste.length) {
      return res.status(400).json({ error: 'aucun_evenement',
        message: 'Aucune opération à synchroniser.' });
    }
    if (liste.length > 500) {
      return res.status(413).json({ error: 'trop_devenements',
        message: 'Envoyez au maximum 500 opérations à la fois.' });
    }
    const resultats = [];

    for (const brut of liste) {
      let ev;
      try {
        ev = validerEvenement(brut);
      } catch (e) {
        if (e instanceof CollecteError) {
          resultats.push({ uuid_local: brut && brut.uuid_local || null,
            statut: 'REJETE', code: e.code, message: e.message, detail: e.detail || null,
            montant_cents: 0 });
          continue;
        }
        throw e;
      }

      try {
        // Relecture sous contexte tenant : on ne peut jamais atteindre l'IMF d'à côté.
        const out = await tenantTransaction(req, async (c) => {
          // 1) Doublon par identifiant du téléphone ?
          const deja = (await c.query(
            `SELECT id, statut_sync, amount_cents FROM operation
              WHERE imf_id=$1 AND uuid_local=$2`, [req.dbImfId, ev.uuid_local])).rows[0];
          // 2) Doublon par référence opérateur (Orange/Moov/Wave/BCEAO) ?
          const ref = ev.reference_externe_mm
            ? (await c.query(
              `SELECT id, statut_sync, amount_cents FROM operation
                WHERE imf_id=$1 AND reference_externe_mm=$2`,
              [req.dbImfId, ev.reference_externe_mm])).rows[0]
            : null;

          const classe = classerEvenement(ev, { par_uuid: deja, par_ref: ref });
          if (classe.etat !== 'neuf') {
            return { statut: 'REJETE_DOUBLON', operation_id: classe.cible.id,
              montant_cents: Number(classe.cible.amount_cents || 0),
              message: classe.motif };
          }

          // 3) Compte cible : par identifiant, sinon par code client.
          let compte = null;
          if (ev.account_id) {
            compte = (await c.query(
              `SELECT id, client_id, balance_cents, product_code FROM account
                WHERE id=$1 AND imf_id=$2`, [ev.account_id, req.dbImfId])).rows[0];
          } else if (ev.code_client) {
            compte = (await c.query(
              `SELECT a.id, a.client_id, a.balance_cents, a.product_code
                 FROM account a JOIN client cl ON cl.id = a.client_id
                WHERE cl.code_client=$1 AND cl.imf_id=$2 AND a.status='active'
                ORDER BY a.opened_at ASC LIMIT 1`,
              [ev.code_client, req.dbImfId])).rows[0];
          }
          if (!compte) {
            return { statut: 'REJETE', code: 'compte_introuvable',
              message: 'Ce client n’a aucun compte d’épargne ouvert dans votre institution.',
              montant_cents: ev.montant_cents };
          }

          // 4) Écriture de l'opération (statut SYNCHRONISE d'emblée).
          const op = (await c.query(
            `INSERT INTO operation
               (imf_id, tenant_id, account_id, client_id, user_id, kind,
                amount_cents, status, impacts_agent_cash, direction,
                canal, reference_externe_mm, gps_lat, gps_lng,
                date_operation_locale, uuid_local, statut_sync, note)
             VALUES ($1,$1,$2,$3,$4,'depot',$5,'valide',$6,1,
                     $7,$8,$9,$10,$11,$12,'SYNCHRONISE',$13)
             RETURNING id, amount_cents, created_at`,
            [req.dbImfId, compte.id, compte.client_id, req.user.id,
              ev.montant_cents, ev.canal === 'TERRAIN_CASH',
              ev.canal, ev.reference_externe_mm, ev.gps_lat, ev.gps_lng,
              ev.date_operation_locale, ev.uuid_local,
              'Collecte hors-ligne (' + ev.canal + ')'])).rows[0];

          // 5) Solde du compte (crédit).
          await c.query(
            'UPDATE account SET balance_cents = balance_cents + ($1::bigint * 1) WHERE id=$2',
            [ev.montant_cents, compte.id]);

          // 6) Référence de reçu unique.
          const annee = new Date().getFullYear();
          const n = (await c.query(
            `SELECT COUNT(*)::int + 1 AS n FROM receipt WHERE imf_id=$1
                AND extract(year FROM created_at) = $2`, [req.dbImfId, annee])).rows[0].n;
          const codeImf = (await c.query('SELECT code_imf FROM imf WHERE id=$1',
            [req.dbImfId])).rows[0];
          const refRecu = referenceRecu({ codeImf: codeImf && codeImf.code_imf, annee, numero: n });
          const nouveauSolde = (await c.query(
            'SELECT balance_cents FROM account WHERE id=$1', [compte.id])).rows[0].balance_cents;
          await c.query(
            `INSERT INTO receipt(imf_id, tenant_id, operation_id, client_id, account_id,
                                 collectrice_user_id, code_receipt, reference_recu, uuid_local,
                                 amount_cents, balance_after_cents, canal)
             VALUES ($1,$1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)`,
            [req.dbImfId, op.id, compte.client_id, compte.id, req.user.id,
              refRecu, ev.uuid_local, ev.montant_cents, nouveauSolde, ev.canal]);

          // 7) Carnet tontine éventuel : cotisation + commission IMF.
          let carnet = null;
          if (ev.carnet_id) {
            const car = (await c.query(
              `SELECT * FROM carnets_tontine
                WHERE id=$1 AND imf_id=$2 AND statut='EN_COURS'`,
              [ev.carnet_id, req.dbImfId])).rows[0];
            if (!car) {
              return { statut: 'REJETE', code: 'carnet_introuvable',
                message: 'Carnet de tontine introuvable ou déjà clôturé.',
                montant_cents: ev.montant_cents };
            }
            if (carnetEchu(car.date_fin)) {
              return { statut: 'REJETE', code: 'carnet_echu',
                message: 'Le cycle de ce carnet est terminé : ouvrez le carnet suivant avant de cotiser.',
                montant_cents: ev.montant_cents, carnet_id: car.id };
            }
            const part = repartirCommission(ev.montant_cents, car.commission_imf_bp);
            await c.query(
              `INSERT INTO carnet_cotisations(imf_id, tenant_id, carnet_id, operation_id,
                     montant_cents, commission_imf_cents, net_cents, date_cotisation)
               VALUES ($1,$1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE))`,
              [req.dbImfId, car.id, op.id, part.montant_cents,
                part.commission_imf_cents, part.net_client_cents,
                ev.date_operation_locale]);
            await c.query(
              `UPDATE carnets_tontine
                  SET total_cotise_cents = total_cotise_cents + $2,
                      commission_imf_cents = commission_imf_cents + $3,
                      net_client_cents = net_client_cents + $4
                WHERE id=$1`,
              [car.id, part.montant_cents, part.commission_imf_cents, part.net_client_cents]);
            carnet = { id: car.id, numero_carnet: car.numero_carnet, commission_imf_cents: part.commission_imf_cents };
          }

          return { statut: 'SYNCHRONISE', operation_id: op.id, reference_recu: refRecu,
            montant_cents: ev.montant_cents, solde_cents: Number(nouveauSolde),
            canal: ev.canal, carnet, message: 'Opération enregistrée.' };
        });
        resultats.push({ uuid_local: ev.uuid_local, ...out });
      } catch (e) {
        if (estDoublon(e)) {
          resultats.push({ uuid_local: ev.uuid_local, statut: 'REJETE_DOUBLON',
            montant_cents: ev.montant_cents,
            message: 'Cette opération a déjà été enregistrée (envoi simultané).' });
        } else if (e instanceof CollecteError) {
          resultats.push({ uuid_local: ev.uuid_local, statut: 'REJETE', code: e.code,
            message: e.message, detail: e.detail || null, montant_cents: ev.montant_cents });
        } else {
          resultats.push({ uuid_local: ev.uuid_local, statut: 'REJETE', code: 'erreur_serveur',
            message: 'Enregistrement impossible pour le moment : réessayez plus tard.',
            montant_cents: ev.montant_cents });
        }
      }
    }

    const resume = resumerVague(resultats);
    res.status(resume.rejetes ? 207 : 200).json(resume);
  } catch (e) { next(e); }
});

/** État de la file de synchronisation de l'IMF (supervision). */
r.get('/collecte-es/sync/etat', requireRole(...CAISSE, ...CHEF), habilit('collecte.sync', 'collecte.supervise'), async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT statut_sync, COUNT(*)::int AS nb, COALESCE(SUM(amount_cents),0)::bigint AS montant_cents
         FROM operation WHERE imf_id=$1 GROUP BY statut_sync ORDER BY statut_sync`,
      [req.dbImfId])).rows);
    res.json({ statuts: out });
  } catch (e) { next(e); }
});

/* ========================================================================
 *  2. CONTRE-PASSATION (jamais de modification d'un montant validé)
 * ===================================================================== */
/**
 * POST /collecte-es/transactions/:id/contre-passer
 * Corps : { motif: 'au moins 10 caractères' }
 * Crée une opération NÉGATIVE liée à l'originale, crédite/débite le compte
 * en sens inverse et marque l'originale comme contre-passée. Irréversible.
 */
r.post('/collecte-es/transactions/:id/contre-passer', requireRole(...CAISSE, ...CHEF), habilit('collecte.contrepasser', 'operations.validate'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const motif = String((req.body && req.body.motif) || '').trim();
    if (!estUuid(id)) return res.status(400).json({ error: 'identifiant_invalide', message: 'Identifiant d’opération invalide.' });
    if (motif.length < 10) {
      return res.status(422).json({ error: 'motif_trop_court',
        message: 'Indiquez le motif de la contre-passation (10 caractères minimum).' });
    }

    const out = await tenantTransaction(req, async (c) => {
      const orig = (await c.query(
        `SELECT * FROM operation WHERE id=$1 AND imf_id=$2 FOR UPDATE`,
        [id, req.dbImfId])).rows[0];
      if (!orig) throw new CollecteError('operation_introuvable', 'Opération introuvable.', null, 404);
      if (orig.contre_passation_de) {
        throw new CollecteError('deja_contrepassation',
          'Cette ligne est déjà une contre-passation : elle ne peut pas être annulée.', null, 409);
      }
      const deja = (await c.query(
        'SELECT id FROM operation WHERE contre_passation_de=$1', [id])).rows[0];
      if (deja) {
        throw new CollecteError('deja_contrepasse',
          'Cette opération a déjà été contre-passée.', { contre_passation_id: deja.id }, 409);
      }
      if (orig.status !== 'valide') {
        throw new CollecteError('operation_non_validee',
          'Seule une opération validée peut être contre-passée.', null, 409);
      }

      // Ligne négative liée à l'originale (jamais de suppression).
      const cp = (await c.query(
        `INSERT INTO operation
           (imf_id, tenant_id, account_id, client_id, user_id, kind,
            amount_cents, status, impacts_agent_cash, direction, canal,
            statut_sync, contre_passation_de, motif_contre_passation, note)
         VALUES ($1,$1,$2,$3,$4,$5,$6,'valide',$7,$8,$9,'SYNCHRONISE',$10,$11,$12)
         RETURNING id, amount_cents, created_at`,
        [req.dbImfId, orig.account_id, orig.client_id, req.user.id, orig.kind,
          -Math.abs(Number(orig.amount_cents)), orig.impacts_agent_cash,
          orig.direction != null ? -orig.direction : null, orig.canal,
          orig.id, motif, 'Contre-passation de l’opération ' + orig.id])).rows[0];

      // Mouvement de compte en sens inverse (traçable).
      await c.query('UPDATE account SET balance_cents = balance_cents + $2 WHERE id=$1',
        [orig.account_id, cp.amount_cents]);
      const solde = (await c.query('SELECT balance_cents FROM account WHERE id=$1',
        [orig.account_id])).rows[0].balance_cents;

      // Le reçu d'origine est marqué annulé (il n'est jamais supprimé).
      if (orig.receipt_id) {
        await c.query(
          `UPDATE receipt SET annule=true, annule_le=now(), annule_motif=$2 WHERE id=$1`,
          [orig.receipt_id, motif]);
      }

      return { contre_passation_id: cp.id, operation_origine_id: orig.id,
        montant_cents: Number(cp.amount_cents), solde_cents: Number(solde),
        motif, message: 'Contre-passation enregistrée.' };
    });
    res.status(201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/** Liste des opérations de l'IMF (filtres canal / statut / période). */
r.get('/collecte-es/transactions', requireRole(...TERRAIN), habilit('operations.read', 'collecte.supervise'), async (req, res, next) => {
  try {
    const { canal, statut_sync, du, au, limite } = req.query || {};
    const cond = ['o.imf_id = $1'];
    const p = [req.dbImfId];
    if (canal) { p.push(canal); cond.push('o.canal = $' + p.length); }
    if (statut_sync) { p.push(statut_sync); cond.push('o.statut_sync = $' + p.length); }
    if (du) { p.push(du); cond.push('o.created_at >= $' + p.length + '::date'); }
    if (au) { p.push(au); cond.push('o.created_at < ($' + p.length + '::date + 1)'); }
    const lim = Math.min(500, Math.max(1, Number(limite) || 100));
    p.push(lim);
    const rows = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT o.id, o.amount_cents, o.canal, o.statut_sync, o.status,
              o.reference_externe_mm, o.date_operation_locale, o.created_at,
              o.contre_passation_de, o.motif_contre_passation,
              cl.code_client, cl.full_name
         FROM operation o LEFT JOIN client cl ON cl.id = o.client_id
        WHERE ${cond.join(' AND ')}
        ORDER BY o.created_at DESC LIMIT $${p.length}`, p)).rows);
    res.json({ transactions: rows, total: rows.length, plafond: lim });
  } catch (e) { next(e); }
});

/* ========================================================================
 *  3. SESSIONS DE CAISSE AGENT
 * ===================================================================== */
r.post('/collecte-es/caisse/ouvrir', requireRole(...TERRAIN), habilit('collecte.cash.ouvrir', 'operations.write'), async (req, res, next) => {
  try {
    const fond = Number((req.body && req.body.fond_caisse_cents) || 0);
    if (!Number.isInteger(fond) || fond < 0) {
      return res.status(400).json({ error: 'fond_invalide',
        message: 'Le fond de caisse doit être un entier de FCFA (zéro ou plus).' });
    }
    const out = await tenantTransaction(req, async (c) => {
      const ouverte = (await c.query(
        `SELECT id, ouverte_le FROM sessions_caisse_agent
          WHERE agent_id=$1 AND statut='OUVERTE'`, [req.user.id])).rows[0];
      if (ouverte) {
        throw new CollecteError('session_deja_ouverte',
          'Votre caisse est déjà ouverte depuis le ' +
          new Date(ouverte.ouverte_le).toLocaleString('fr-FR') + '.',
          { session_id: ouverte.id }, 409);
      }
      const zone = req.body && req.body.zone_collecte_id && estUuid(req.body.zone_collecte_id)
        ? req.body.zone_collecte_id : null;
      return (await c.query(
        `INSERT INTO sessions_caisse_agent
           (imf_id, tenant_id, agent_id, zone_collecte_id, fond_caisse_ouverture_cents)
         VALUES ($1,$1,$2,$3,$4) RETURNING *`,
        [req.dbImfId, req.user.id, zone, fond])).rows[0];
    });
    res.status(201).json({ session: out });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

r.get('/collecte-es/caisse/session', requireRole(...TERRAIN), async (req, res, next) => {
  try {
    const s = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT s.*, (SELECT COALESCE(SUM(o.amount_cents),0)::bigint FROM operation o
                      WHERE o.user_id=s.agent_id AND o.imf_id=s.imf_id
                        AND o.created_at >= s.ouverte_le AND o.impacts_agent_cash)
                AS encaisse_operation_cents
         FROM sessions_caisse_agent s
        WHERE s.agent_id=$1 AND s.imf_id=$2 AND s.statut='OUVERTE'`,
      [req.user.id, req.dbImfId])).rows[0]);
    res.json({ session: s || null });
  } catch (e) { next(e); }
});

/**
 * POST /collecte-es/caisse/cloturer
 * Corps : { billetage: { "10000": 3, "1000": 12, ... }, justification }
 * Le théorique est calculé par le serveur (fond + encaissements - décaissements).
 */
r.post('/collecte-es/caisse/cloturer', requireRole(...TERRAIN), habilit('collecte.cash.cloturer', 'cash.declare'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await tenantTransaction(req, async (c) => {
      const s = (await c.query(
        `SELECT * FROM sessions_caisse_agent
          WHERE agent_id=$1 AND imf_id=$2 AND statut='OUVERTE' FOR UPDATE`,
        [req.user.id, req.dbImfId])).rows[0];
      if (!s) throw new CollecteError('aucune_session',
        'Aucune caisse ouverte à clôturer.', null, 409);

      const encaisse = (await c.query(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS m FROM operation
          WHERE user_id=$1 AND imf_id=$2 AND created_at >= $3 AND impacts_agent_cash`,
        [req.user.id, req.dbImfId, s.ouverte_le])).rows[0].m;
      const theorique = Number(s.fond_caisse_ouverture_cents) + Number(encaisse);
      const arrete = arreterCaisse({
        theoriqueCents: theorique, billetage: b.billetage || {}, justification: b.justification
      });

      const cb = (await c.query(
        `INSERT INTO cash_closing
           (imf_id, tenant_id, user_id, closing_date, theoretical_cents, counted_cents,
            gap_cents, status, note, denominations, gap_justification,
            gap_due_at, gap_resolved)
         VALUES ($1,$1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
         RETURNING *`,
        [req.dbImfId, req.user.id, theorique, arrete.compte_cents, arrete.ecart_cents,
          arrete.statut, b.note || null, JSON.stringify(b.billetage || {}),
          arrete.ecart_cents !== 0 ? String(b.justification).trim() : null,
          arrete.ecart_cents !== 0 ? new Date(Date.now() + 86400000) : null,
          arrete.ecart_cents === 0])).rows[0];

      for (const l of arrete.lignes) {
        await c.query(
          `INSERT INTO billetage_arrete
             (imf_id, tenant_id, cash_closing_id, session_id, coupure, type_coupure, nombre, montant_cents)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (cash_closing_id, coupure) DO UPDATE
             SET nombre = EXCLUDED.nombre, montant_cents = EXCLUDED.montant_cents`,
          [req.dbImfId, cb.id, s.id, l.coupure, l.type_coupure, l.nombre, l.montant_cents]);
      }

      const maj = (await c.query(
        `UPDATE sessions_caisse_agent
            SET statut='FERMEE', fermee_le=now(),
                fond_caisse_fermeture_cents=$2, encaisse_cents=$3,
                ecart_cents=$4, cash_closing_id=$5
          WHERE id=$1 RETURNING *`,
        [s.id, arrete.compte_cents, Number(encaisse), arrete.ecart_cents, cb.id])).rows[0];

      return { session: maj, arrete };
    });
    res.status(201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/** Simulation de billetage (contrôle avant clôture, n'écrit rien). */
r.post('/collecte-es/caisse/billetage', requireRole(...TERRAIN), (req, res) => {
  try {
    const calc = calculerBilletage((req.body && req.body.billetage) || {});
    const theo = Number((req.body && req.body.theorique_cents) || 0);
    res.json({ ...calc, ecart_cents: calc.total_cents - theo });
  } catch (e) { try { echec(res, e); } catch (err) { res.status(500).json({ error: 'erreur' }); } }
});

/* ========================================================================
 *  4. CARNETS TONTINE (cycle 31 jours, commission IMF)
 * ===================================================================== */
r.post('/collecte-es/tontine/carnets', requireRole(...TERRAIN), habilit('collecte.tontine.gerer', 'operations.write'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !estUuid(b.client_id)) {
      return res.status(400).json({ error: 'client_requis', message: 'Sélectionnez le client titulaire du carnet.' });
    }
    const cotisation = Number(b.cotisation_attendue_cents || 0);
    if (!Number.isInteger(cotisation) || cotisation < 0) {
      return res.status(400).json({ error: 'cotisation_invalide',
        message: 'La cotisation attendue doit être un entier de FCFA.' });
    }
    const out = await tenantTransaction(req, async (c) => {
      const cli = (await c.query('SELECT id, code_client, full_name FROM client WHERE id=$1 AND imf_id=$2',
        [b.client_id, req.dbImfId])).rows[0];
      if (!cli) throw new CollecteError('client_introuvable', 'Client introuvable dans votre institution.', null, 404);

      const enCours = (await c.query(
        `SELECT id, numero_carnet, cycle_numero FROM carnets_tontine
          WHERE client_id=$1 AND imf_id=$2 AND statut='EN_COURS'`,
        [cli.id, req.dbImfId])).rows[0];
      if (enCours) {
        throw new CollecteError('carnet_deja_ouvert',
          'Ce client possède déjà un carnet en cours (' + enCours.numero_carnet + ').',
          { carnet_id: enCours.id }, 409);
      }

      const produit = (await c.query(
        `SELECT * FROM savings_product
          WHERE imf_id IS NULL AND code = COALESCE($1,'carnet_tontine_31j')`,
        [b.produit_code || null])).rows[0];
      const cycleJours = Number((produit && produit.cycle_jours) || 31);
      const commissionBp = Number((produit && produit.commission_imf_bp) || 500);
      const plan = planCycle({ dateDebut: b.date_debut, cycleJours, numeroPrecedent: 0 });

      const dernier = (await c.query(
        `SELECT COUNT(*)::int AS n FROM carnets_tontine WHERE imf_id=$1`,
        [req.dbImfId])).rows[0].n;
      const numero = 'CARNET-' + new Date().getFullYear() + '-' + String(dernier + 1).padStart(5, '0');

      const car = (await c.query(
        `INSERT INTO carnets_tontine
           (imf_id, tenant_id, numero_carnet, client_id, account_id, produit_code,
            collecteur_id, zone_collecte_id, date_debut, date_fin, cycle_numero,
            cotisation_attendue_cents, commission_imf_bp, created_by)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [req.dbImfId, numero, cli.id,
          b.account_id && estUuid(b.account_id) ? b.account_id : null,
          produit ? produit.code : 'carnet_tontine_31j', req.user.id,
          b.zone_collecte_id && estUuid(b.zone_collecte_id) ? b.zone_collecte_id : null,
          plan.date_debut, plan.date_fin, plan.cycle_numero,
          cotisation, commissionBp, req.user.id])).rows[0];
      return { carnet: car, plan };
    });
    res.status(201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

r.get('/collecte-es/tontine/carnets', requireRole(...TERRAIN), habilit('operations.read', 'collecte.supervise'), async (req, res, next) => {
  try {
    const statut = req.query.statut || 'EN_COURS';
    const rows = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT ca.*, cl.code_client, cl.full_name,
              (ca.date_fin - CURRENT_DATE) AS jours_restants
         FROM carnets_tontine ca JOIN client cl ON cl.id = ca.client_id
        WHERE ca.imf_id=$1 AND ($2='' OR ca.statut=$2)
        ORDER BY ca.date_fin ASC LIMIT 500`,
      [req.dbImfId, statut])).rows);
    res.json({ carnets: rows, total: rows.length });
  } catch (e) { next(e); }
});

/** Clôture d'un carnet (cycle terminé) + réouverture d'un cycle suivant. */
r.post('/collecte-es/tontine/carnets/:id/cloturer', requireRole(...CAISSE, ...CHEF), habilit('collecte.tontine.gerer', 'operations.validate'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'identifiant_invalide', message: 'Identifiant de carnet invalide.' });
    const renouveler = !!(req.body && req.body.renouveler);
    const out = await tenantTransaction(req, async (c) => {
      const car = (await c.query(
        `SELECT * FROM carnets_tontine WHERE id=$1 AND imf_id=$2 FOR UPDATE`,
        [id, req.dbImfId])).rows[0];
      if (!car) throw new CollecteError('carnet_introuvable', 'Carnet introuvable.', null, 404);
      if (car.statut !== 'EN_COURS') {
        throw new CollecteError('carnet_non_ouvert', 'Ce carnet n’est plus en cours.', null, 409);
      }
      const ferme = (await c.query(
        `UPDATE carnets_tontine SET statut='CLOTURE', date_cloture=now()
          WHERE id=$1 RETURNING *`, [id])).rows[0];
      let suivant = null;
      if (renouveler) {
        const plan = planCycle({ dateDebut: new Date().toISOString().slice(0, 10),
          cycleJours: 31, numeroPrecedent: car.cycle_numero });
        const n = (await c.query(
          `SELECT COUNT(*)::int + 1 AS n FROM carnets_tontine WHERE imf_id=$1`,
          [req.dbImfId])).rows[0].n;
        suivant = (await c.query(
          `INSERT INTO carnets_tontine
             (imf_id, tenant_id, numero_carnet, client_id, account_id, produit_code,
              collecteur_id, zone_collecte_id, date_debut, date_fin, cycle_numero,
              cotisation_attendue_cents, commission_imf_bp, created_by)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [req.dbImfId, 'CARNET-' + new Date().getFullYear() + '-' + String(n).padStart(5, '0'),
            car.client_id, car.account_id, car.produit_code, req.user.id,
            car.zone_collecte_id, plan.date_debut, plan.date_fin, plan.cycle_numero,
            car.cotisation_attendue_cents, car.commission_imf_bp, req.user.id])).rows[0];
        await c.query('UPDATE carnets_tontine SET statut=$2, carnet_suivant_id=$3 WHERE id=$1',
          [id, 'RENOUVELE', suivant.id]);
      }
      return { carnet: ferme, suivant };
    });
    res.json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  5. REÇUS ET NOTIFICATIONS
 * ===================================================================== */
r.get('/collecte-es/recus/:id', requireRole(...TERRAIN), habilit('operations.read', 'collecte.recu.imprimer'), async (req, res, next) => {
  try {
    const rec = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT rc.*, cl.full_name, cl.phone, i.name AS imf_name
         FROM receipt rc
         LEFT JOIN client cl ON cl.id = rc.client_id
         LEFT JOIN imf i ON i.id = rc.imf_id
        WHERE rc.id=$1 AND rc.imf_id=$2`,
      [req.params.id, req.dbImfId])).rows[0]);
    if (!rec) return res.status(404).json({ error: 'recu_introuvable', message: 'Reçu introuvable.' });
    res.json({ recu: rec });
  } catch (e) { next(e); }
});

/** Programme les envois du reçu (SMS / WhatsApp / impression). */
r.post('/collecte-es/recus/:id/notifier', requireRole(...TERRAIN), habilit('collecte.recu.imprimer', 'operations.write'), async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => {
      const rec = (await c.query(
        `SELECT rc.*, cl.full_name, cl.phone, i.name AS imf_name
           FROM receipt rc
           LEFT JOIN client cl ON cl.id = rc.client_id
           LEFT JOIN imf i ON i.id = rc.imf_id
          WHERE rc.id=$1 AND rc.imf_id=$2`, [req.params.id, req.dbImfId])).rows[0];
      if (!rec) throw new CollecteError('recu_introuvable', 'Reçu introuvable.', null, 404);
      if (rec.annule) throw new CollecteError('recu_annule', 'Ce reçu a été annulé (contre-passation).', null, 409);

      const notifs = preparerNotifications({
        reference: rec.reference_recu || rec.code_receipt,
        montantCents: rec.amount_cents,
        soldeCents: rec.balance_after_cents,
        imfName: rec.imf_name, clientName: rec.full_name, telephone: rec.phone,
        imprimante: req.body && req.body.imprimante,
        canaux: (req.body && req.body.canaux) || ['SMS']
      });
      const creees = [];
      for (const n of notifs) {
        creees.push((await c.query(
          `INSERT INTO recus_notifications
             (imf_id, tenant_id, receipt_id, client_id, canal, destinataire, contenu, statut)
           VALUES ($1,$1,$2,$3,$4,$5,$6,'EN_ATTENTE') RETURNING *`,
          [req.dbImfId, rec.id, rec.client_id, n.canal, n.destinataire, n.contenu])).rows[0]);
      }
      return { notifications: creees };
    });
    res.status(201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  6. PRODUITS D'ÉPARGNE (DAT / tontine) — paramétrage
 * ===================================================================== */
r.get('/collecte-es/produits', requireRole(...TERRAIN), habilit('savings.read', 'operations.read'), async (req, res, next) => {
  try {
    const rows = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT code, label, nature, taux_interet, duree_blocage_mois,
              carnet_tontine, cycle_jours, commission_imf_bp,
              min_opening_deposit_cents, requires_kyc_complete
         FROM savings_product ORDER BY sort_order ASC`)).rows);
    res.json({ produits: rows });
  } catch (e) { next(e); }
});

/** Ouverture d'un DAT : bloque le capital sur la durée du produit. */
r.post('/collecte-es/produits/:code/dat', requireRole(...CAISSE, ...CHEF), habilit('savings.manage', 'operations.write'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const montant = Number(b.montant_cents || 0);
    if (!Number.isInteger(montant) || montant <= 0) {
      return res.status(400).json({ error: 'montant_invalide',
        message: 'Le montant du dépôt à terme doit être un entier de FCFA supérieur à zéro.' });
    }
    const out = await tenantTransaction(req, async (c) => {
      const prod = (await c.query(
        'SELECT * FROM savings_product WHERE code=$1', [req.params.code])).rows[0];
      if (!prod) throw new CollecteError('produit_introuvable', 'Produit d’épargne introuvable.', null, 404);
      if (prod.nature !== 'bloquee') {
        throw new CollecteError('produit_non_bloque',
          'Ce produit n’est pas une épargne bloquée (DAT).', null, 422);
      }
      if (montant < Number(prod.min_opening_deposit_cents || 0)) {
        throw new CollecteError('montant_sous_minimum',
          'Le dépôt minimum de ce produit est de ' +
          (Number(prod.min_opening_deposit_cents) / 100).toLocaleString('fr-FR') + ' FCFA.', null, 422);
      }
      const acc = (await c.query(
        `SELECT * FROM account WHERE id=$1 AND imf_id=$2 AND status='active' FOR UPDATE`,
        [b.account_id, req.dbImfId])).rows[0];
      if (!acc) throw new CollecteError('compte_introuvable', 'Compte introuvable ou inactif.', null, 404);
      if (Number(acc.balance_cents) < montant) {
        throw new CollecteError('solde_insuffisant',
          'Solde insuffisant pour bloquer ' + (montant / 100).toLocaleString('fr-FR') + ' FCFA.', null, 409);
      }
      const duree = Number(prod.duree_blocage_mois || 12);
      const echeance = new Date();
      echeance.setMonth(echeance.getMonth() + duree);
      const maj = (await c.query(
        `UPDATE account SET solde_bloque_cents = solde_bloque_cents + $2,
                date_echeance=$3, product_code=COALESCE(product_code,$4)
          WHERE id=$1 RETURNING *`,
        [acc.id, montant, echeance.toISOString().slice(0, 10), prod.code])).rows[0];
      return { compte: maj, produit: { code: prod.code, label: prod.label,
        duree_blocage_mois: duree, taux_interet: prod.taux_interet },
        date_echeance: maj.date_echeance };
    });
    res.status(201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

export default r;
