/* ===========================================================================
 * teebo — MOTEUR DE FRAIS & RÈGLES DE GESTION (IMF)
 *
 * Règles implémentées :
 *  1. Frais de tenue de compte : dû pour TOUT MOIS ENTAMÉ, prélevé le dernier
 *     jour du mois.
 *  2. Soldes insuffisants (rattrapage automatique) : si le solde disponible est
 *     inférieur au Solde minimum permanent, le prélèvement est tout de même
 *     ACTÉ et bascule en état « En attente ». Dès que le compte reçoit un
 *     crédit, les frais en attente sont récupérés de manière PRIORITAIRE.
 *  3. Frais de collecte mobile : mode fixe / par tranche / pourcentage du cumul
 *     mensuel des dépôts. Calculés et prélevés le dernier jour du mois.
 *  4. Retrait anticipé — ordre de priorité :
 *        (a) calcul + prélèvement immédiat des frais de collecte mobile sur les
 *            dépôts effectués au cours du mois du retrait ;
 *        (b) calcul + prélèvement de la commission de retrait anticipé
 *            (% du montant retiré) ;
 *        (c) EXONÉRATION : pas de commission si le retrait n'entame pas les
 *            nouveaux dépôts du mois en cours.
 * =========================================================================== */

/** Fin du mois (dernier jour) pour une date donnée — « mois entamé ». */
export function lastDayOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/** Premier jour du mois. */
export function firstDayOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Bornes ISO du mois contenant `d`. */
export function monthBounds(d = new Date()) {
  const start = firstDayOfMonth(d);
  const end = lastDayOfMonth(d);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Vrai si le prélèvement doit être acté aujourd'hui (dernier jour du mois). */
export function isLastDayOfMonth(d = new Date()) {
  return d.getUTCDate() === lastDayOfMonth(d).getUTCDate();
}

/** Nombre de mois entamés entre deux dates (bornes incluses). */
export function monthsStarted(from, to) {
  const a = new Date(from), b = new Date(to);
  return Math.max(1,
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1);
}

/**
 * Calcule les frais de collecte mobile du mois selon le mode du produit.
 *   - fixe        : montant forfaitaire mensuel.
 *   - pourcentage : taux appliqué au CUMUL MENSUEL DES DÉPÔTS.
 *   - par_tranche : barème progressif `[{from_cents,to_cents,fee_cents}]` sur le cumul.
 * @param {object} product ligne savings_product
 * @param {number} monthlyDepositsCents cumul des dépôts du mois (en centimes)
 * @returns {{amount_cents:number, mode:string, detail:object}}
 */
export function computeCollectionFee(product, monthlyDepositsCents) {
  const mode = product.collection_fee_mode || 'pourcentage';
  const base = Math.max(0, Math.round(Number(monthlyDepositsCents) || 0));
  if (mode === 'fixe') {
    return { amount_cents: Number(product.collection_fee_fixed_cents || 0), mode,
      detail: { base_cents: base } };
  }
  if (mode === 'par_tranche') {
    const tranches = Array.isArray(product.collection_fee_tranches) ? product.collection_fee_tranches : [];
    for (const t of tranches) {
      const from = Number(t.from_cents || 0);
      const to = t.to_cents === null || t.to_cents === undefined ? Infinity : Number(t.to_cents);
      if (base >= from && base <= to) {
        return { amount_cents: Number(t.fee_cents || 0), mode,
          detail: { base_cents: base, tranche: t } };
      }
    }
    return { amount_cents: 0, mode, detail: { base_cents: base, tranche: null } };
  }
  // pourcentage (points de base : 150 = 1,50 %)
  const bp = Number(product.collection_fee_bp || 0);
  const amount = Math.round(base * bp / 10000);
  return { amount_cents: amount, mode, detail: { base_cents: base, rate_bp: bp } };
}

/**
 * Commission de retrait anticipé.
 *   commission = taux(%) × montant retiré
 *   EXONÉRATION : si le retrait n'entame PAS les nouveaux dépôts du mois.
 * @param {object} product
 * @param {number} withdrawCents montant du retrait demandé
 * @param {number} monthDepositsCents cumul des dépôts du mois en cours
 * @returns {{amount_cents:number, exempt:boolean, reason:string, detail:object}}
 */
export function computeEarlyWithdrawalFee(product, withdrawCents, monthDepositsCents, priorBalanceCents = null) {
  const bp = Number(product.early_withdrawal_fee_bp || 0);
  const w = Math.max(0, Math.round(Number(withdrawCents) || 0));
  const deposits = Math.max(0, Math.round(Number(monthDepositsCents) || 0));
  const prior = priorBalanceCents === null || priorBalanceCents === undefined
    ? null : Math.max(0, Math.round(Number(priorBalanceCents) || 0));

  // Règle (c) — exonération : le retrait ne touche pas les nouveaux dépôts du
  //   mois dès lors qu'il est INTÉGRALEMENT couvert par le solde ANTÉRIEUR
  //   (solde du compte avant les dépôts du mois en cours).
  //   priorBalance = soldeCourant − dépôtsDuMois (borné à 0), fourni par l'appelant.
  //   Si priorBalance est inconnu (null), l'exonération ne peut être établie
  //   avec certitude ⇒ la commission reste due (choix prudent anti-fraude).
  if (product.early_withdrawal_exempt_new_deposits && prior !== null && w > 0 && w <= prior) {
    return { amount_cents: 0, exempt: true, reason: 'retrait_ne_touche_pas_les_nouveaux_depots_du_mois',
      detail: { withdraw_cents: w, month_deposits_cents: deposits, prior_balance_cents: prior, rate_bp: bp } };
  }
  const amount = Math.round(w * bp / 10000);
  return { amount_cents: amount, exempt: false, reason: 'commission_retrait_anticipe',
    detail: { withdraw_cents: w, month_deposits_cents: deposits, prior_balance_cents: prior, rate_bp: bp } };
}

/**
 * Décide du sort d'un prélèvement au regard du solde minimum permanent.
 *   - solde disponible >= frais  => prélèvement immédiat (« prélevé »)
 *   - sinon                      => acté « en attente » (rattrapage automatique)
 * @returns {'preleve'|'en_attente'}
 */
export function feeStatusForAvailable(product, availableCents, feeCents) {
  const avail = Math.round(Number(availableCents) || 0);
  const fee = Math.round(Number(feeCents) || 0);
  if (fee <= 0) return 'preleve';
  return avail >= fee ? 'preleve' : 'en_attente';
}

/**
 * Récupération PRIORITAIRE des frais en attente dès qu'un crédit arrive.
 * @param {object} c client pg en transaction
 * @param {string} imfId
 * @param {string} accountId
 * @param {number} creditCents montant crédité disponible pour le rattrapage
 * @returns {{recovered_cents:number, remaining_cents:number, settled:[], still_pending:number}}
 */
export async function recoverPendingFees(c, imfId, accountId, creditCents) {
  let available = Math.max(0, Math.round(Number(creditCents) || 0));
  const { rows } = await c.query(
    `SELECT id, kind, amount_cents FROM account_fee
      WHERE imf_id=$1 AND account_id=$2 AND status='en_attente'
      ORDER BY created_at ASC`, [imfId, accountId]);
  const settled = [];
  let recovered = 0;
  for (const f of rows) {
    if (available <= 0) break;
    if (available >= Number(f.amount_cents)) {
      await c.query(
        `UPDATE account_fee SET status='preleve', settled_at=now() WHERE id=$1`, [f.id]);
      settled.push({ id: f.id, kind: f.kind, amount_cents: Number(f.amount_cents) });
      available -= Number(f.amount_cents);
      recovered += Number(f.amount_cents);
    } else {
      // Récupération partielle : on acte le reste en attente.
      const reste = Number(f.amount_cents) - available;
      await c.query(
        `UPDATE account_fee SET amount_cents=$2, detail = detail || $3::jsonb, settled_at=now()
          WHERE id=$1`, [f.id, reste, JSON.stringify({ partial_recovery_cents: available })]);
      settled.push({ id: f.id, kind: f.kind, amount_cents: available, partial: true });
      recovered += available;
      available = 0;
    }
  }
  const left = (await c.query(
    `SELECT COUNT(*)::int AS n FROM account_fee WHERE account_id=$1 AND status='en_attente'`,
    [accountId])).rows[0].n;
  return { recovered_cents: recovered, remaining_cents: available, settled, still_pending: left };
}

/**
 * Prélève des frais sur un compte en respectant la règle de rattrapage :
 * le solde est débité si possible, sinon les frais sont actés «en attente».
 * Trace également le mouvement correspondant.
 * @returns {{status:'preleve'|'en_attente', charged_cents:number, pending_cents:number, fee:object}}
 */
export async function chargeFee(c, {
  imfId, accountId, kind, amountCents, periodStart, periodEnd, detail = {}, userId = null, label = null,
}) {
  const amt = Math.max(0, Math.round(Number(amountCents) || 0));
  if (amt === 0) return { status: 'preleve', charged_cents: 0, pending_cents: 0, fee: null };

  const acc = (await c.query(
    'SELECT id, balance_cents, currency FROM account WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
  if (!acc) { const e = new Error('compte_introuvable'); e.status = 404; throw e; }

  const available = Number(acc.balance_cents);
  const status = feeStatusForAvailable(null, available, amt);

  const fee = (await c.query(
    `INSERT INTO account_fee(imf_id,account_id,kind,amount_cents,currency,status,
          period_start,period_end,detail,created_by,settled_at)
     VALUES ($1::uuid,$2::uuid,$3::fee_kind,$4::bigint,$5::text,$6::fee_status,$7::date,$8::date,$9::jsonb,$10::uuid,
             CASE WHEN $6::fee_status='preleve' THEN now() ELSE NULL END)
     RETURNING *`,
    [imfId, accountId, kind, amt, acc.currency, status,
     periodStart || null, periodEnd || null, JSON.stringify(detail), userId])).rows[0];

  let charged = 0;
  if (status === 'preleve') {
    const upd = (await c.query(
      'UPDATE account SET balance_cents = balance_cents - $1 WHERE id=$2 RETURNING balance_cents',
      [amt, accountId])).rows[0];
    await c.query(
      `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,source_id,label,user_id)
       VALUES ($1,$2,-1,$3,$4,'fee',$5,$6,$7)`,
      [imfId, accountId, amt, upd.balance_cents, fee.id, label || ('Frais ' + kind), userId]);
    charged = amt;
  } else {
    // Rattrapage automatique : le prélèvement est ACTÉ (en attente).
    await c.query(
      `INSERT INTO account_movement(imf_id,account_id,direction,amount_cents,balance_after_cents,source,source_id,label,user_id)
       VALUES ($1,$2,0,$3,$4,'fee',$5,$6,$7)`,
      [imfId, accountId, amt, available, fee.id, label || ('Frais ' + kind) + ' (en attente)', userId]);
  }
  return { status, charged_cents: charged, pending_cents: status === 'en_attente' ? amt : 0, fee };
}

/** Cumul des dépôts du mois pour un compte (base des frais de collecte mobile). */
export async function monthDeposits(c, accountId, startISO, endISO) {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS total
       FROM account_movement
      WHERE account_id=$1 AND direction=1 AND source='operation'
        AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')`,
    [accountId, startISO, endISO]);
  return Number(rows[0].total || 0);
}

/** Solde minimum permanent du produit du compte (0 si inconnu). */
export async function minPermanentOf(c, accountId) {
  const { rows } = await c.query(
    `SELECT COALESCE(sp.min_permanent_cents,0)::bigint AS min_perm
       FROM account a LEFT JOIN savings_product sp ON sp.code = a.product_code
      WHERE a.id=$1`, [accountId]);
  return Number(rows[0] ? rows[0].min_perm : 0);
}
