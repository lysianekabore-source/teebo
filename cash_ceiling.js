// =========================================================================
// teebo — PLAFOND DE CAISSE & CLÔTURE DE CAISSE DE LA COLLECTRICE
// =========================================================================
// La collectrice détient de l'argent liquide de l'IMF entre deux versements.
// Le plafond journalier (plafond_caisse_journalier) plafonne CETTE DÉTENTION :
// dès qu'il est atteint, toute nouvelle collecte est REFUSÉE jusqu'à
// l'apurement (versement à la caisse ou transfert Mobile Money), ou jusqu'à
// la clôture de caisse de fin de journée.
//
// Sources de vérité :
//   - encours_caisse_actuel  (table collecteur_caisse, mis à jour en tx)
//   - recalcul à partir des opérations (fn_recalc_encours) = contrôle croisé
//   - écritures de caisse au grand livre (ledge_kind = 'caisse)
//
// La CLÔTURE (/api/v1/collecteurs/cloture) produit :
//   - un état de rapprochement (théorique vs déclaré vs écart) ;
//   - un blocage en cas d'écart (la collectrice doit s'expliquer) ;
//   - une écriture immuable au grand livre (cloture_caisse / ecart_caisse) ;
//   - une ligne d'audit avec l'écart (jamais effaçable).
// =========================================================================
import { LedgerError, postJournalEntry } from './ledger.js';
import { settleRoundCommissions } from './commissions.js';

/** Ligne de caisse de la collectrice, créée au besoin (FOR UPDATE). */
export async function lockCaisse(c, institutionId, collecteurId) {
  let row = (await c.query(
    'SELECT * FROM collecteur_caisse WHERE collecteur_id=$1 FOR UPDATE', [collecteurId])).rows[0];
  if (!row) {
    row = (await c.query(
      `INSERT INTO collecteur_caisse (collecteur_id, institution_id)
       VALUES ($1,$2) ON CONFLICT (collecteur_id) DO UPDATE SET updated_at=now()
       RETURNING *`, [collecteurId, institutionId])).rows[0];
  }
  return row;
}

/**
 * Encours théorique recalculé = dépôts encaissés (impactant la caisse)
 * − versements déclarés/validés − apurements de clôture.
 * Sert de contrôle croisé du champ encours_caisse_actuel.
 */
export async function theoriqueEncours(c, institutionId, collecteurId, jour = null) {
  const d = (await c.query(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM operation
      WHERE imf_id=$1 AND user_id=$2 AND kind='depot' AND status='valide'
        AND impacts_agent_cash=true
        AND ($3::date IS NULL OR created_at::date=$3::date)`, [institutionId, collecteurId, jour])).rows[0];
  const v = (await c.query(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM cash_deposit
      WHERE imf_id=$1 AND collectrice_user_id=$2 AND status IN ('declare','valide')
        AND ($3::date IS NULL OR created_at::date=$3::date)`, [institutionId, collecteurId, jour])).rows[0];
  return { depots_cents: Number(d.s), versements_cents: Number(v.s),
    encours_cents: Number(d.s) - Number(v.s) };
}

/**
 * CONTRÔLE AVANT COLLECTE : refuse si le plafond serait dépassé.
 * @throws {LedgerError} code CASH_CEILING_EXCEEDED
 */
export async function assertCeilingAllows(c, institutionId, collecteurId, montantCents) {
  const row = await lockCaisse(c, institutionId, collecteurId);
  if (row.bloque) {
    throw new LedgerError('CASH_BLOCKED',
      'Votre caisse est bloquée : une clôture avec écart doit être régularisée au guichet.',
      { motif: row.motif_blocage }, 409);
  }
  const plafond = Number(row.plafond_caisse_journalier || 0);
  const encours = Number(row.encours_caisse_actuel || 0);
  if (plafond > 0 && encours + Number(montantCents) > plafond) {
    throw new LedgerError('CASH_CEILING_EXCEEDED',
      'Plafond de caisse atteint : encours ' + (encours / 100).toLocaleString('fr-FR') +
      ' FCFA, plafond ' + (plafond / 100).toLocaleString('fr-FR') +
      ' FCFA. Apurez votre caisse (versement au guichet ou transfert Mobile Money) ' +
      'ou faites votre clôture avant de collecter.',
      {
        encours_cents: encours, plafond_cents: plafond,
        disponible_cents: Math.max(0, plafond - encours),
        demande_cents: Number(montantCents), apurement_requis: true
      }, 409);
  }
  return { encours_cents: encours, plafond_cents: plafond };
}

/** Ajoute un encaissement à l'encours (dans la transaction de la collecte). */
export async function addToEncours(c, institutionId, collecteurId, montantCents) {
  await lockCaisse(c, institutionId, collecteurId);
  await c.query(
    `UPDATE collecteur_caisse
        SET encours_caisse_actuel = encours_caisse_actuel + $2, updated_at=now()
      WHERE collecteur_id=$1`, [collecteurId, Number(montantCents)]);
}

/** Diminue l'encours après un versement (apurement). */
export async function reduceEncours(c, institutionId, collecteurId, montantCents) {
  await lockCaisse(c, institutionId, collecteurId);
  await c.query(
    `UPDATE collecteur_caisse
        SET encours_caisse_actuel = GREATEST(0, encours_caisse_actuel - $2),
            dernier_apurement_at = now(), updated_at = now()
      WHERE collecteur_id=$1`, [collecteurId, Number(montantCents)]);
}

/**
 * CLÔTURE DE CAISSE : état de rapprochement complet.
 *
 * @param {import('pg').PoolClient} c connexion de transaction
 * @param {object} p
 *   p.institutionId, p.collecteurId, p.jour (date ISO), p.montantDeclareCents,
 *   p.commentaire, p.actorId, p.deviceId, p.duplicateUri
 */
export async function clotureCaisse(c, p) {
  const jour = p.jour || new Date().toISOString().slice(0, 10);
  const row = await lockCaisse(c, p.institutionId, p.collecteurId);
  const theo = await theoriqueEncours(c, p.institutionId, p.collecteurId, jour);

  // Ce que la collectrice avait SUR ELLE au début (reliquat des jours passés)
  // = encours comptable − collecté du jour + versements du jour.
  const encoursComptable = Number(row.encours_caisse_actuel || 0);
  const attendu = theo.encours_cents;               // depuis le dernier apurement
  const declare = p.montantDeclareCents == null ? attendu : Math.round(Number(p.montantDeclareCents));
  const ecart = declare - attendu;                  // >0 : excédent, <0 : manquant

  if (!Number.isFinite(declare) || declare < 0) {
    throw new LedgerError('CLOTURE_INVALID_AMOUNT',
      'Clôture refusée : le montant déclaré est invalide.');
  }
  if (ecart !== 0 && !String(p.commentaire || '').trim()) {
    throw new LedgerError('CLOTURE_VARIANCE_COMMENT_REQUIRED',
      'Clôture refusée : un écart de ' + (Math.abs(ecart) / 100).toLocaleString('fr-FR') +
      ' FCFA a été constaté. Un commentaire explicatif est obligatoire.',
      { ecart_cents: ecart }, 422);
  }

  // --- Écriture comptable immuable --------------------------------------
  // On ne touche PAS aux écritures de collecte : on constate la sortie de
  // caisse (remise au coffre) et, s'il y a lieu, l'écart (produit ou charge).
  const lines = [];
  if (attendu > 0) {
    lines.push({ ledgeKind: 'caisse', collecteurId: p.collecteurId, sens: -1,
      montantCents: attendu, libelle: 'Clôture de caisse — remise au coffre' });
    lines.push({ ledgeKind: 'coffre', ledgerCode: 'COFFRE-AGENCE', sens: 1,
      montantCents: attendu, libelle: 'Entrée en coffre — clôture collectrice' });
  }
  if (ecart > 0) {
    // Excédent : produit exceptionnel (à justifier).
    lines.push({ ledgeKind: 'caisse', collecteurId: p.collecteurId, sens: -1,
      montantCents: ecart, libelle: 'Écart de caisse — excédent constaté' });
    lines.push({ ledgeKind: 'imf_income', ledgerCode: '7588', sens: 1,
      montantCents: ecart, libelle: 'Produit exceptionnel — excédent de caisse' });
  }
  if (ecart < 0) {
    // Manquant : charge exceptionnelle à la charge de la collectrice/IMF.
    lines.push({ ledgeKind: 'imf_income', ledgerCode: '6588', sens: -1,
      montantCents: Math.abs(ecart), libelle: 'Charge exceptionnelle — manquant de caisse' });
    lines.push({ ledgeKind: 'caisse', collecteurId: p.collecteurId, sens: 1,
      montantCents: Math.abs(ecart), libelle: 'Écart de caisse — manquant constaté' });
  }

  let entry = null;
  if (lines.length >= 2) {
    const r = await postJournalEntry(c, {
      institutionId: p.institutionId,
      eventType: ecart === 0 ? 'cloture_caisse' : 'ecart_caisse',
      eventRef: 'CLOTURE-' + p.collecteurId + '-' + jour,
      actorId: p.actorId, deviceId: p.deviceId || null,
      payload: { jour, attendu_cents: attendu, declare_cents: declare, ecart_cents: ecart,
        depots_cents: theo.depots_cents, versements_cents: theo.versements_cents,
        commentaire: p.commentaire || null },
      lines
    });
    entry = r.entry;
  }

  // --- Remise à zéro de l'encours ----------------------------------------
  // La collectrice repart avec 0 (tout est remis) SAUF si l'écart est
  // défavorable et non régularisé : dans ce cas le manquant reste dû.
  const nouvelEncours = ecart < 0 ? Math.abs(ecart) : 0;
  const bloque = ecart < 0;
  await c.query(
    `UPDATE collecteur_caisse
        SET encours_caisse_actuel=$2,
            derniere_cloture_at=now(),
            dernier_apurement_at=now(),
            bloque=$3,
            motif_blocage=$4,
            updated_at=now()
      WHERE collecteur_id=$1`,
    [p.collecteurId, nouvelEncours, bloque,
     bloque ? 'Manquant de caisse de ' + (Math.abs(ecart) / 100).toLocaleString('fr-FR') +
       ' FCFA constaté le ' + jour + ' — à régulariser au guichet.' : null]);

  // --- Réconciliation des tournées du jour (commissions acquises) --------
  const rounds = (await c.query(
    `SELECT DISTINCT round_id FROM commission_accrual
      WHERE institution_id=$1 AND collecteur_id=$2 AND statut='en_attente'
        AND round_id IS NOT NULL`, [p.institutionId, p.collecteurId])).rows;
  let commissionsReglees = 0;
  for (const r of rounds) {
    commissionsReglees += await settleRoundCommissions(c, p.institutionId, r.round_id);
  }

  // --- Reçu de clôture + audit ------------------------------------------
  const recu = (await c.query(
    `INSERT INTO cash_closing(imf_id, user_id, closing_date, theoretical_cents,
            counted_cents, gap_cents, status, note, created_by)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
      WHERE NOT EXISTS (SELECT 1 FROM cash_closing
                         WHERE imf_id=$1 AND user_id=$2 AND closing_date=$3)
     RETURNING *`,
    [p.institutionId, p.collecteurId, jour, attendu, declare, ecart,
     ecart === 0 ? 'equilibre' : 'ecart',
     p.commentaire || null, p.actorId || null])).rows[0] || null;

  await c.query(
    `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
     VALUES ($1,$2,'collecteur.cloture_caisse','app_user',$3,$4::jsonb)`,
    [p.institutionId, p.actorId || null, p.collecteurId, JSON.stringify({
      jour, attendu_cents: attendu, declare_cents: declare, ecart_cents: ecart,
      ecart_fcfa: ecart / 100, bloque, ledger_entry_id: entry ? entry.id : null,
      commentaire: p.commentaire || null, duplicates_detectes: p.duplicates || null
    })]);

  return {
    jour,
    collecteur_id: p.collecteurId,
    etat_rapprochement: {
      collecte_du_jour_cents: theo.depots_cents,
      versements_du_jour_cents: theo.versements_cents,
      encours_comptable_cents: encoursComptable,
      montant_attendu_cents: attendu,
      montant_declare_cents: declare,
      ecart_cents: ecart,
      ecart_fcfa: ecart / 100,
      conforme: ecart === 0
    },
    apurement: {
      nouvel_encours_cents: nouvelEncours,
      bloque,
      message: bloque
        ? 'Manquant de caisse : la collectrice reste bloquée jusqu’à régularisation au guichet.'
        : 'Caisse apurée : la collectrice peut reprendre la collecte.'
    },
    commissions_reglees: commissionsReglees,
    ecriture_grand_livre: entry ? { id: entry.id, hash: entry.hash, event_type: entry.event_type } : null,
    recu_cloture: recu
  };
}

/** Résumé de caisse d'une collectrice (affichage temps réel). */
export async function caisseResume(c, institutionId, collecteurId) {
  const row = await lockCaisse(c, institutionId, collecteurId);
  const theo = await theoriqueEncours(c, institutionId, collecteurId);
  const plafond = Number(row.plafond_caisse_journalier || 0);
  const encours = Number(row.encours_caisse_actuel || 0);
  return {
    collecteur_id: collecteurId,
    plafond_caisse_journalier_cents: plafond,
    encours_caisse_actuel_cents: encours,
    encours_theorique_cents: theo.encours_cents,
    disponible_cents: plafond > 0 ? Math.max(0, plafond - encours) : null,
    taux_utilisation_pct: plafond > 0 ? Math.round((encours / plafond) * 100) : null,
    bloque: !!row.bloque,
    motif_blocage: row.motif_blocage || null,
    dernier_apurement_at: row.dernier_apurement_at,
    derniere_cloture_at: row.derniere_cloture_at,
    alerte: plafond > 0 && encours >= plafond * 0.9
  };
}

export default {
  lockCaisse, theoriqueEncours, assertCeilingAllows, addToEncours,
  reduceEncours, clotureCaisse, caisseResume
};
