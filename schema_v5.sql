-- ===========================================================================
-- teebo — Schéma VAGUE 8
-- ---------------------------------------------------------------------------
-- Tarification de l'abonnement : une LICENCE teeBo (frais unique d'activation)
-- s'ajoute à l'abonnement. L'IMF choisit un cycle mensuel OU annuel ; le cycle
-- annuel bénéficie d'une remise. On conserve le détail du devis proforma sur
-- la demande d'accès pour pouvoir reconstituer les lignes de la facture.
-- Toutes les instructions sont idempotentes (ADD COLUMN IF NOT EXISTS).
-- ===========================================================================

ALTER TABLE access_request ADD COLUMN IF NOT EXISTS billing_cycle      TEXT;    -- mensuel | annuel
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS licence_cents      BIGINT;  -- frais unique de licence
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS subscription_cents BIGINT;  -- abonnement brut (avant remise)
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS discount_cents     BIGINT NOT NULL DEFAULT 0; -- remise (cycle annuel)

COMMIT;
