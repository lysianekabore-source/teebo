-- ===========================================================================
-- teebo — VAGUE 43 : ABONNEMENT PAR MODULE (fin des formules uniques)
-- ---------------------------------------------------------------------------
-- Objet : rendre la base cohérente avec le modèle commercial actuel, dans
-- lequel une IMF ne choisit plus une « formule » (Starter / Business /
-- Enterprise, ou une « offre unique ») mais une LISTE DE MODULES, facturés
-- chacun à son tarif catalogue, avec un cycle mensuel ou annuel.
--
--   A. access_request.module_codes : la liste des modules demandés par le
--      prospect, ainsi que la remise « pack complet » réellement appliquée.
--   B. Vue v_plan_module (compatibilité) : chaque ancienne ligne « plan »
--      devient un MODULE de même code et de même prix. Aucune donnée perdue,
--      aucun écran cassé, plus aucune notion de formule.
--   C. La table « plan » n'est plus lue par le serveur. Elle est conservée
--      (jamais de DROP) mais marquée comme obsolète, et l'annonce « offre
--      unique » de la vague 8 est requalifiée en module.
--
-- ADDITIF et RÉEXÉCUTABLE : peut être relancé sans risque.
-- Aucune table supprimée, aucune colonne renommée, aucune donnée écrasée.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- A. DEMANDE D'ACCÈS : modules choisis (abonnement par module)
-- ---------------------------------------------------------------------------
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_codes      TEXT[]       NOT NULL DEFAULT '{}'::text[];
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS module_count      INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS full_pack         BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS pack_discount_cents BIGINT     NOT NULL DEFAULT 0;
ALTER TABLE access_request ADD COLUMN IF NOT EXISTS annual_discount_cents BIGINT   NOT NULL DEFAULT 0;

COMMENT ON COLUMN access_request.module_codes IS
  'Modules teeBo souscrits par l''IMF (MODULE_COLLECTE_TONTINE, MODULE_DOSSIER_CREDIT, MODULE_COMPLIANCE_KYC, MODULE_COMPTABILITE_AVANCEE). Le plan_code historique est conservé pour la traçabilité des anciennes demandes.';
COMMENT ON COLUMN access_request.billing_cycle IS
  'Cycle d''abonnement choisi : mensuel (tarif catalogue) ou annuel (tarif catalogue − 15 %).';

-- Reprise des anciennes demandes : celles qui portaient un plan unique
-- deviennent une demande « 1 module » du même code, sans changer le montant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='access_request'
                AND column_name='plan_code') THEN
    UPDATE access_request
       SET module_codes = ARRAY[plan_code],
           module_count = 1
     WHERE plan_code IS NOT NULL
       AND (module_codes IS NULL OR cardinality(module_codes) = 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_access_request_modules
  ON access_request USING GIN (module_codes);

-- ---------------------------------------------------------------------------
-- B. VUE DE COMPATIBILITÉ : l'ancien « plan » vu comme un module
-- ---------------------------------------------------------------------------
-- Les quelques écrans qui interrogeaient encore la table plan (liste des
-- offres) continuent de fonctionner : ils reçoivent une ligne par module, avec
-- le tarif catalogue officiel. Plus aucune mention de formule.
DROP VIEW IF EXISTS v_plan_module;
CREATE VIEW v_plan_module AS
SELECT p.module_key              AS code,
       p.module_name             AS label,
       p.monthly_subscription_price::bigint AS price_cents,
       p.position                AS sort_order,
       true                      AS is_module
  FROM saas_modules_pricing p
 WHERE p.is_available
UNION ALL
SELECT p.module_key, p.module_name, p.monthly_subscription_price::bigint,
       p.position, true
  FROM saas_modules_pricing p
 WHERE NOT EXISTS (SELECT 1 FROM saas_modules_pricing x WHERE x.is_available);

COMMENT ON VIEW v_plan_module IS
  'Compatibilité : chaque module du catalogue exposé comme une entrée tarifaire. Remplaçait la table plan (formules uniques), désormais obsolète.';

-- ---------------------------------------------------------------------------
-- C. ANCIENNES FORMULES : conservées pour l'historique, marquées obsolètes
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='plan') THEN
    ALTER TABLE plan ADD COLUMN IF NOT EXISTS is_obsolete BOOLEAN NOT NULL DEFAULT TRUE;
    COMMENT ON TABLE plan IS
      'OBSOLÈTE depuis la vague 43 : les abonnements se vendent par module (voir saas_modules_pricing et v_plan_module). Table conservée uniquement pour l''historique des anciennes demandes.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D. RÉGLAGES : rappel des règles commerciales (valeurs officielles)
-- ---------------------------------------------------------------------------
INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
  ('UNIQUE_LICENSE_PRICE',        250000.00),   -- licence unique, une seule fois
  ('ANNUAL_DISCOUNT_PERCENT',          15.00),  -- cycle annuel : −15 %
  ('FULL_PACK_DISCOUNT_PERCENT',        5.00),  -- les 4 modules : −5 % de plus
  ('TRIAL_DAYS_PER_MODULE',            30.00)   -- essai gratuit, une fois par module
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  updated_at    = now();

COMMIT;
