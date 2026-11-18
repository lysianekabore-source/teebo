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
