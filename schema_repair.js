// ===========================================================================
// teeBo — VAGUE 52 : réparation ciblée du schéma au démarrage
// ---------------------------------------------------------------------------
// PROBLÈME RÉSOLU
//   migrate.js s'arrête dès que la base est reconnue « déjà à jour » (v33). Sur
//   une base de production existante, les correctifs des vagues suivantes ne
//   sont donc JAMAIS rejoués. Quand une colonne ou une valeur de type manque,
//   les écrans de la console éditeur et le formulaire « Demander un accès »
//   renvoient une erreur 500 que le site traduisait par
//   « Une erreur est survenue. Réessayez. »
//
// CE QUE FAIT CE MODULE
//   Il exécute, à CHAQUE démarrage du serveur, une liste d'instructions
//   idempotentes (IF NOT EXISTS) qui répare uniquement ce qui manque :
//     * la valeur « deleted » du type imf_status (archivage d'une IMF) ;
//     * les colonnes de access_request utilisées par la console et la proforma ;
//     * la table imf_branding et ses mentions légales de facturation.
//
//   Aucune donnée n'est supprimée, aucune table n'est recréée, aucun type
//   n'est remplacé. Chaque instruction est isolée : si l'une échoue, les
//   autres s'appliquent quand même et le journal Render indique laquelle.
// ===========================================================================
import { q } from './db.js';

const ENONCES = [
  // --- 1. Statut « deleted » dans le type imf_status ----------------------
  [`DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'imf_status' AND e.enumlabel = 'deleted'
  ) THEN
    ALTER TYPE imf_status ADD VALUE IF NOT EXISTS 'deleted';
  END IF;
END $$;`, 'imf_status.deleted'],

  // --- 2. Table des demandes d'accès --------------------------------------
  [`CREATE TABLE IF NOT EXISTS access_request (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     imf_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'access_request.table'],

  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_lastname TEXT', 'access_request.requester_lastname'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_firstname TEXT', 'access_request.requester_firstname'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_position TEXT', 'access_request.requester_position'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS admin_name TEXT', 'access_request.admin_name'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS billing_cycle TEXT', 'access_request.billing_cycle'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS licence_cents BIGINT', 'access_request.licence_cents'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS subscription_cents BIGINT', 'access_request.subscription_cents'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS discount_cents BIGINT DEFAULT 0', 'access_request.discount_cents'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decision TEXT', 'access_request.decision'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS plan_code TEXT', 'access_request.plan_code'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_no TEXT', 'access_request.proforma_no'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_amount_cents BIGINT', 'access_request.proforma_amount_cents'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_validated BOOLEAN NOT NULL DEFAULT false', 'access_request.proforma_validated'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_validated_at TIMESTAMPTZ', 'access_request.proforma_validated_at'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decided_by UUID', 'access_request.decided_by'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ', 'access_request.decided_at'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_codes TEXT[] NOT NULL DEFAULT \'{}\'::text[]', 'access_request.module_codes'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_count INTEGER NOT NULL DEFAULT 0', 'access_request.module_count'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS full_pack BOOLEAN NOT NULL DEFAULT false', 'access_request.full_pack'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS pack_discount_cents BIGINT NOT NULL DEFAULT 0', 'access_request.pack_discount_cents'],
  ['ALTER TABLE access_request ADD COLUMN IF NOT EXISTS annual_discount_cents BIGINT NOT NULL DEFAULT 0', 'access_request.annual_discount_cents'],

  // --- 3. Identité visuelle / mentions légales ---------------------------
  [`CREATE TABLE IF NOT EXISTS imf_branding (
     imf_id UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'imf_branding.table'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_name TEXT', 'imf_branding.legal_name'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_form TEXT', 'imf_branding.legal_form'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS trade_register_no TEXT', 'imf_branding.trade_register_no'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS tax_id TEXT', 'imf_branding.tax_id'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS bceao_agreement_no TEXT', 'imf_branding.bceao_agreement_no'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS share_capital_cents BIGINT', 'imf_branding.share_capital_cents'],
  ['ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_address TEXT', 'imf_branding.legal_address'],

  // --- 4. Index (facultatifs) --------------------------------------------
  ['CREATE INDEX IF NOT EXISTS idx_access_request_imf ON access_request (imf_id)', 'index.access_request_imf'],
  ['CREATE INDEX IF NOT EXISTS idx_imf_status ON imf (status)', 'index.imf_status']
];

let dejaRepare = false;

/**
 * Applique la réparation. Idempotent : un 2e appel ne fait rien.
 * @returns {Promise<{ok:boolean, appliquees:number, echecs:string[]}>}
 */
export async function reparerSchemaConsole(force = false) {
  if (dejaRepare && !force) return { ok: true, appliquees: 0, echecs: [] };
  const echecs = [];
  let appliquees = 0;
  for (const [sql, nom] of ENONCES) {
    try {
      await q(sql);
      appliquees++;
    } catch (e) {
      // On continue : une instruction isolée en échec (droits, verrou) ne doit
      // pas empêcher les autres réparations de s'appliquer.
      echecs.push(nom + ' (' + ((e && e.code) || '?') + ')');
    }
  }
  if (!echecs.length) dejaRepare = true;
  if (appliquees) console.log('[schema] reparation vague 52 : ' + appliquees + ' objet(s) verifie(s)/cree(s)');
  if (echecs.length) console.error('[schema] objets non repares : ' + echecs.join(' | '));
  return { ok: echecs.length === 0, appliquees, echecs };
}
