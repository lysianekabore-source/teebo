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


  // --- 4. Table des TARIFS DES MODULES (cause du 500 sur /plans) ----------
  // Sans elle : « relation saas_modules_pricing does not exist » et la grille
  // tarifaire, la proforma et la console renvoyaient une erreur 500.
  [`CREATE TABLE IF NOT EXISTS saas_modules_pricing (
     module_key VARCHAR(50) PRIMARY KEY,
     module_name VARCHAR(100) NOT NULL,
     monthly_subscription_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_subscription_price >= 0),
     is_available BOOLEAN NOT NULL DEFAULT TRUE,
     position INTEGER NOT NULL DEFAULT 100,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'saas_modules_pricing.table'],

  ['ALTER TABLE saas_modules_pricing ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE', 'saas_modules_pricing.is_available'],
  ['ALTER TABLE saas_modules_pricing ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 100', 'saas_modules_pricing.position'],

  // Tarifs officiels (ceux du code). ON CONFLICT DO NOTHING : un tarif deja
  // personnalise par l editeur n est JAMAIS ecrase.
  [`INSERT INTO saas_modules_pricing (module_key, module_name, monthly_subscription_price, position) VALUES
      ('MODULE_COLLECTE_TONTINE',     'Collecte et tontines',        75000.00, 10),
      ('MODULE_DOSSIER_CREDIT',       'Dossiers de credit',        100000.00, 20),
      ('MODULE_COMPLIANCE_KYC',       'Conformite et KYC (LCB-FT)',  25000.00, 30),
      ('MODULE_COMPTABILITE_AVANCEE', 'Comptabilite avancee',      100000.00, 40)
    ON CONFLICT (module_key) DO NOTHING`, 'saas_modules_pricing.tarifs'],

  // --- 5. Reglages globaux (licence unique, remise annuelle) ---------------
  [`CREATE TABLE IF NOT EXISTS saas_global_settings (
     setting_key VARCHAR(50) PRIMARY KEY,
     setting_value NUMERIC(12,2) NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'saas_global_settings.table'],
  [`INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
      ('UNIQUE_LICENSE_PRICE', 250000.00),
      ('ANNUAL_DISCOUNT_PERCENT', 15.00)
    ON CONFLICT (setting_key) DO NOTHING`, 'saas_global_settings.valeurs'],

  // --- 6. Modules souscrits par chaque IMF (console editeur) --------------
  [`CREATE TABLE IF NOT EXISTS institution_module_subscriptions (
     subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     institution_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
     module_key VARCHAR(50) NOT NULL REFERENCES saas_modules_pricing(module_key),
     is_active BOOLEAN NOT NULL DEFAULT TRUE,
     activated_at DATE NOT NULL DEFAULT CURRENT_DATE,
     deactivated_at DATE,
     is_trial BOOLEAN NOT NULL DEFAULT FALSE,
     trial_end_date DATE,
     last_billed_month DATE,
     created_by UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (institution_id, module_key))`, 'institution_module_subscriptions.table'],
  ['CREATE INDEX IF NOT EXISTS idx_ims_institution ON institution_module_subscriptions (institution_id, is_active)', 'index.ims'],


  // --- 6 bis. Licence, factures SaaS (console editeur : factures, revenus) --
  [`CREATE TABLE IF NOT EXISTS institution_license_status (
     institution_id UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
     license_paid BOOLEAN NOT NULL DEFAULT FALSE,
     paid_at TIMESTAMPTZ,
     invoice_ref TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'institution_license_status.table'],
  [`CREATE TABLE IF NOT EXISTS saas_invoices (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     institution_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
     invoice_number TEXT,
     billing_period_start DATE NOT NULL,
     billing_period_end DATE NOT NULL,
     fixed_cost_total NUMERIC(12,2) NOT NULL DEFAULT 0,
     variable_cost_total NUMERIC(12,2) NOT NULL DEFAULT 0,
     grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'UNPAID',
     generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     paid_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'saas_invoices.table'],
  ['CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_invoices_imf_period ON saas_invoices (institution_id, billing_period_start)', 'index.saas_invoices'],
  [`CREATE TABLE IF NOT EXISTS saas_invoice_lines (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     invoice_id UUID NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
     institution_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
     module_key VARCHAR(50),
     line_type TEXT NOT NULL,
     label TEXT NOT NULL,
     statut_ligne TEXT NOT NULL DEFAULT 'facture',
     trial_end_date DATE,
     amount_fcfa NUMERIC(12,2) NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'saas_invoice_lines.table'],
  ['CREATE INDEX IF NOT EXISTS idx_saas_invoice_lines_invoice ON saas_invoice_lines (invoice_id)', 'index.saas_invoice_lines'],

  // --- 7. Index (facultatifs) --------------------------------------------
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
