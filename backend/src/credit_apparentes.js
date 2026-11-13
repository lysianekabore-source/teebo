// teebo — crédit : détection automatique des personnes apparentées (VAGUE 29)
// ---------------------------------------------------------------------------
// Appelé au moment de l'octroi d'un crédit. Un dossier est « apparenté » si :
//   - le client est lui-même une personne apparentée recensée ;
//   - ou le client est un client de l'institution dont le nom correspond à
//     une personne apparentée (rapprochement sur le nom normalisé).
// Le dossier est alors marqué, une convention réglementée est ouverte en
// statut « en attente d'autorisation » et le ratio individuel d'encours sur
// les fonds propres effectifs (FPE) est calculé.
// ---------------------------------------------------------------------------
import { q } from './db.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function detecterApparente(imfId, clientId, montantCents) {
  const out = { apparente: false, apparentes: [], alerte: null, convention_id: null, convention_reference: null };
  if (!clientId) return out;
  try {
    const { rows: cli } = await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2', [clientId, imfId]);
    const cl = cli[0];
    if (!cl) return out;
    // 1. rattachement explicite (personne apparentée liée à ce client)
    const { rows: direct } = await q(
      `SELECT id, nom_complet, type_lien FROM personnes_apparentees
        WHERE imf_id=$1 AND actif=true AND client_id=$2`, [imfId, clientId]);
    let found = direct;
    // 2. rapprochement par le nom (personnes physiques recensées sans client lié)
    if (!found.length) {
      const { rows: all } = await q(
        `SELECT id, nom_complet, type_lien FROM personnes_apparentees
          WHERE imf_id=$1 AND actif=true AND nature_personne='PHYSIQUE' AND client_id IS NULL`, [imfId]);
      const cible = norm(cl.full_name);
      found = all.filter((a) => { const n = norm(a.nom_complet); return n && n === cible; });
    }
    if (!found.length) return out;
    out.apparente = true;
    out.apparentes = found.map((x) => ({ id: x.id, nom_complet: x.nom_complet, type_lien: x.type_lien }));
    const pa = found[0];

    // 3. situation des encours apparentés et plafonds
    const { rows: prm } = await q('SELECT * FROM parametres_prudentiels WHERE imf_id=$1', [imfId]);
    const p = prm[0] || {};
    let fpe = p.fpe_cents != null ? Number(p.fpe_cents) : 0;
    if (!fpe) {
      const { rows: im } = await q('SELECT capital_cents FROM imf WHERE id=$1', [imfId]);
      fpe = im[0] && im[0].capital_cents != null ? Number(im[0].capital_cents) : 0;
    }
    const { rows: enc } = await q(
      `SELECT COALESCE(SUM(CASE WHEN status='decaisse' THEN COALESCE(approved_amount_cents, amount_cents) ELSE 0 END),0)::bigint AS s
         FROM credit_file cf JOIN client c ON c.id=cf.client_id
        WHERE cf.imf_id=$1 AND cf.apparente=true AND c.id=$2`, [imfId, clientId]);
    const encours = Number(enc[0] ? enc[0].s : 0) + Math.abs(Number(montantCents || 0));
    const plaf = p.plafond_apparente_individuel_pct != null ? Number(p.plafond_apparente_individuel_pct) : null;
    out.ratio_individuel_pct = fpe > 0 ? Number(((encours / fpe) * 100).toFixed(2)) : null;
    out.situation = { fpe_cents: fpe, plafond_individuel_pct: plaf, encours_cents: encours };
    if (plaf !== null && out.ratio_individuel_pct !== null && out.ratio_individuel_pct > plaf) {
      out.alerte = 'plafond_apparente_depasse';
    }

    // 4. ouverture d'une convention réglementée à autoriser
    const ref = 'CR-' + new Date().getFullYear() + '-' + Date.now().toString(36).toUpperCase().slice(-6);
    const { rows: cv } = await q(
      `INSERT INTO conventions_reglementees (imf_id, reference, personne_apparentee_id, membre_gouvernance_id,
          client_id, type_convention, objet, date_convention, montant_cents, statut, autorisation_requise,
          vote_exclu, depassement_plafond, commentaire_conformite)
       VALUES ($1,$2,$3,(SELECT membre_gouvernance_id FROM personnes_apparentees WHERE id=$3),
          $4,'CREDIT',$5,CURRENT_DATE,$6,'EN_ATTENTE_AUTORISATION',true,true,$7,$8) RETURNING id, reference`,
      [imfId, ref, pa.id, clientId, 'Crédit ' + (cl.full_name || '') + ' — ' + pa.type_lien,
       Math.abs(Number(montantCents || 0)), out.alerte !== null, out.alerte]);
    if (cv[0]) {
      out.convention_id = cv[0].id;
      out.convention_reference = cv[0].reference;
      await q('UPDATE conventions_reglementees SET credit_file_id=NULL WHERE id=$1', [cv[0].id]).catch(() => {});
    }
    return out;
  } catch (e) {
    // la détection ne doit JAMAIS empêcher l'enregistrement d'un dossier
    return out;
  }
}
