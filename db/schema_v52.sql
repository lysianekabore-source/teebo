-- ============================================================================
-- teeBo — VAGUE 52 : réparation idempotente des objets utilisés par la console
-- éditeur et par le formulaire public « Demander un accès ».
-- ----------------------------------------------------------------------------
-- POURQUOI CE FICHIER
--   La base de production a reçu les migrations par vagues successives. Quand
--   une vague n'a pas été jouée (ou l'a été partiellement), certaines colonnes
--   ou certaines valeurs de type manquent. Résultat : l'API renvoie une erreur
--   500 que le site traduisait par « Une erreur est survenue ».
--
--   Ce fichier ne DÉTRUIT RIEN et peut être exécuté plusieurs fois de suite :
--   il ajoute uniquement ce qui manque (IF NOT EXISTS). Aucune donnée n'est
--   supprimée, aucun type n'est recréé.
--
-- COMMENT L'EXÉCUTER
--   Supabase → SQL Editor → New query → coller TOUT ce fichier → Run.
--   Le résultat attendu est « Success. No rows returned ».
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Statut d'IMF : la console utilise aussi le statut « deleted » (archivage).
--    Si la valeur n'existe pas dans le type, tout UPDATE échoue en 22P02.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'imf_status' AND e.enumlabel = 'deleted'
  ) THEN
    ALTER TYPE imf_status ADD VALUE IF NOT EXISTS 'deleted';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Table des demandes d'accès : colonnes du parcours prospect
--    (formulaire → proforma → décision). Toutes facultatives ou avec défaut,
--    donc l'ajout ne bloque aucune ligne existante.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_request (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_lastname    TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_firstname   TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_position    TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS admin_name            TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS billing_cycle         TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS licence_cents         BIGINT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS subscription_cents    BIGINT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS discount_cents        BIGINT DEFAULT 0;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decision              TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS plan_code             TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_no           TEXT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_amount_cents BIGINT;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_validated    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS proforma_validated_at TIMESTAMPTZ;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decided_by            UUID;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decided_at            TIMESTAMPTZ;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_codes          TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS full_pack             BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS pack_discount_cents   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS annual_discount_cents BIGINT NOT NULL DEFAULT 0;

-- Les colonnes ajoutées plus haut l'ont été sans NOT NULL : on aligne les
-- valeurs par défaut sans jamais rejeter une ligne déjà présente.
UPDATE access_request SET discount_cents        = 0 WHERE discount_cents        IS NULL;
UPDATE access_request SET pack_discount_cents   = 0 WHERE pack_discount_cents   IS NULL;
UPDATE access_request SET annual_discount_cents = 0 WHERE annual_discount_cents IS NULL;
UPDATE access_request SET module_codes          = '{}'::text[] WHERE module_codes IS NULL;
UPDATE access_request SET module_count          = 0 WHERE module_count          IS NULL;
UPDATE access_request SET full_pack             = false WHERE full_pack            IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Mentions légales de facturation (identité visuelle de l'IMF)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imf_branding (
  imf_id        UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_name          TEXT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_form          TEXT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS trade_register_no   TEXT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS tax_id              TEXT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS bceao_agreement_no  TEXT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS share_capital_cents BIGINT;
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_address       TEXT;

-- ---------------------------------------------------------------------------
-- 4. Index utiles à la console éditeur (facultatifs, sans effet de bord)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_access_request_imf      ON access_request (imf_id);
CREATE INDEX IF NOT EXISTS idx_access_request_created  ON access_request (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imf_status              ON imf (status);

-- ---------------------------------------------------------------------------
-- 4 bis. TARIFS DES MODULES, REGLAGES, ABONNEMENTS, LICENCE ET FACTURES SaaS
--    (vague 33 jamais jouee en production). Sans ces tables, l'API renvoyait
--    « relation saas_modules_pricing does not exist » : grille tarifaire,
--    proforma et console editeur tombaient en erreur.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_modules_pricing (
  module_key VARCHAR(50) PRIMARY KEY,
  module_name VARCHAR(100) NOT NULL,
  monthly_subscription_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_subscription_price >= 0),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO saas_modules_pricing (module_key, module_name, monthly_subscription_price, position) VALUES
  ('MODULE_COLLECTE_TONTINE',     'Collecte et tontines',        75000.00, 10),
  ('MODULE_DOSSIER_CREDIT',       'Dossiers de credit',        100000.00, 20),
  ('MODULE_COMPLIANCE_KYC',       'Conformite et KYC (LCB-FT)',  25000.00, 30),
  ('MODULE_COMPTABILITE_AVANCEE', 'Comptabilite avancee',      100000.00, 40)
ON CONFLICT (module_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_global_settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value NUMERIC(12,2) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
  ('UNIQUE_LICENSE_PRICE', 250000.00),
  ('ANNUAL_DISCOUNT_PERCENT', 15.00)
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS institution_module_subscriptions (
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
  UNIQUE (institution_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_ims_institution
  ON institution_module_subscriptions (institution_id, is_active);

CREATE TABLE IF NOT EXISTS institution_license_status (
  institution_id UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
  license_paid BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  invoice_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_invoices (
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_invoices_imf_period
  ON saas_invoices (institution_id, billing_period_start);

CREATE TABLE IF NOT EXISTS saas_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  module_key VARCHAR(50),
  line_type TEXT NOT NULL,
  label TEXT NOT NULL,
  statut_ligne TEXT NOT NULL DEFAULT 'facture',
  trial_end_date DATE,
  amount_fcfa NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_invoice_lines_invoice
  ON saas_invoice_lines (invoice_id);

-- ---------------------------------------------------------------------------
-- 5. Contrôle final : combien de colonnes manquent encore ? (doit renvoyer 0)
-- ---------------------------------------------------------------------------
SELECT count(*) AS colonnes_manquantes
  FROM (VALUES
    ('plan_code'), ('proforma_no'), ('proforma_amount_cents'),
    ('proforma_validated'), ('decided_at'), ('decided_by'),
    ('module_codes'), ('module_count'), ('full_pack'),
    ('pack_discount_cents'), ('annual_discount_cents')
  ) AS c(nom)
 WHERE NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'access_request'
      AND column_name  = c.nom
 );
