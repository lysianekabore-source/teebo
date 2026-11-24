-- =========================================================================
-- teebo — RÈGLES FINANCIÈRES STRICTES (vague 35)
-- =========================================================================
-- Ce script est ADDITIF et RÉEXÉCUTABLE (on peut le relancer sans risque).
--
--  1. MONTANTS : tout est NUMERIC(12,2) en base. Aucun flottant n'est
--     utilisé pour un montant en FCFA. Le calcul officiel est fait par
--     PostgreSQL, jamais par JavaScript.
--  2. ESSAI UNIQUE PAR MODULE : un module déjà passé en essai gratuit ne
--     peut PLUS jamais repasser en essai pour la même IMF (trigger) : il est
--     immédiatement payant.
--  3. CYCLE MENSUEL / ANNUEL : une IMF peut basculer en cours de mois. Le
--     prorata est calculé AU JOUR PRÈS, et la réduction annuelle de 15 % ne
--     s'applique QU'À PARTIR de la date de signature du forfait annuel
--     (jamais rétroactivement).
--  4. ESSAI EN COURS : si un module est encore en essai à la date de
--     facturation, la ligne du mois vaut STRICTEMENT 0 FCFA. Les jours
--     d'essai restants sont REPORTÉS et la première facturation se fait au
--     prorata au mois suivant.
--  5. FACTURES IMMUABLES : une facture générée est verrouillée en base
--     (trigger) : ni les lignes, ni les totaux, ni la période ne peuvent
--     changer. Seul l'encaissement (PAID) et l'annulation (CANCELLED)
--     restent possibles, et une annulation ne se défait pas.
--  6. VUE COMPTABLE : le coût théorique d'un module est calculé par une vue
--     sécurisée, selon le cycle (mensuel / annuel −15 %).
-- =========================================================================
BEGIN;

-- -------------------------------------------------------------------------
-- 0. RÉGLAGES
-- -------------------------------------------------------------------------
INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
  ('UNIQUE_LICENSE_PRICE', 250000.00),
  ('FULL_PACK_DISCOUNT_PERCENT', 5.00),
  ('ANNUAL_DISCOUNT_PERCENT', 15.00)
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  updated_at    = now();

-- -------------------------------------------------------------------------
-- 1. COLONNES DE CYCLE DE FACTURATION
--    billing_cycle : MENSUEL (par défaut) ou ANNUEL.
--    annual_signed_at : date EXACTE de signature du forfait annuel. La
--    réduction de 15 % ne court qu'à partir de cette date.
-- -------------------------------------------------------------------------
ALTER TABLE institution_module_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle    TEXT NOT NULL DEFAULT 'MENSUEL',
  ADD COLUMN IF NOT EXISTS annual_signed_at DATE,
  ADD COLUMN IF NOT EXISTS trial_started_at DATE,
  ADD COLUMN IF NOT EXISTS trial_used       BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'institution_module_subscriptions_cycle_chk') THEN
        ALTER TABLE institution_module_subscriptions
          ADD CONSTRAINT institution_module_subscriptions_cycle_chk
          CHECK (billing_cycle IN ('MENSUEL', 'ANNUEL'));
    END IF;
END $$;

-- Reprise de l'existant : un module déjà en essai a consommé son essai.
UPDATE institution_module_subscriptions
   SET trial_used = TRUE
 WHERE is_trial = TRUE AND trial_used = FALSE;

-- Lignes de facture : traçabilité du prorata et du cycle appliqué.
ALTER TABLE saas_invoice_lines
  ADD COLUMN IF NOT EXISTS days_billed     INTEGER,
  ADD COLUMN IF NOT EXISTS days_in_month   INTEGER,
  ADD COLUMN IF NOT EXISTS billing_cycle   TEXT,
  ADD COLUMN IF NOT EXISTS discount_pct    NUMERIC(6, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_before   NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS period_from     DATE,
  ADD COLUMN IF NOT EXISTS period_to       DATE;

-- Factures : marqueur d'immuabilité + période annualisée éventuelle.
ALTER TABLE saas_invoices
  ADD COLUMN IF NOT EXISTS is_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes      TEXT;

-- -------------------------------------------------------------------------
-- 2. VUE COMPTABLE SÉCURISÉE — coût théorique d'un module selon le cycle
--    75000 mensuel ; annuel = 75000 × 0,85 = 63750 FCFA.
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_saas_module_cost AS
SELECT
    p.module_key,
    p.module_name,
    p.monthly_subscription_price                                   AS prix_mensuel_fcfa,
    CASE
        WHEN COALESCE(g.setting_value, 15) = 15 THEN
            ROUND(p.monthly_subscription_price * 0.85, 2)          -- 63 750,00
        ELSE
            ROUND(p.monthly_subscription_price
                  * (100 - COALESCE(g.setting_value, 0)) / 100, 2)
    END                                                            AS prix_annuel_mensualise_fcfa,
    COALESCE(g.setting_value, 15)                                  AS remise_annuelle_pct,
    p.is_available
  FROM saas_modules_pricing p
  LEFT JOIN saas_global_settings g ON g.setting_key = 'ANNUAL_DISCOUNT_PERCENT';

-- Coût théorique PAR IMF ET PAR MODULE (cycle réellement souscrit).
CREATE OR REPLACE VIEW v_saas_imf_module_cost AS
SELECT
    s.institution_id,
    s.module_key,
    p.module_name,
    s.is_active,
    s.is_trial,
    s.trial_end_date,
    s.billing_cycle,
    s.annual_signed_at,
    CASE
        WHEN s.billing_cycle = 'ANNUEL'
         AND s.annual_signed_at IS NOT NULL THEN
            ROUND(p.monthly_subscription_price
                  * (100 - COALESCE(g.setting_value, 15)) / 100, 2)   -- 63 750,00
        ELSE
            p.monthly_subscription_price
    END                                                            AS cout_mensuel_fcfa,
    p.monthly_subscription_price                                   AS prix_plein_fcfa
  FROM institution_module_subscriptions s
  JOIN saas_modules_pricing p ON p.module_key = s.module_key
  LEFT JOIN saas_global_settings g ON g.setting_key = 'ANNUAL_DISCOUNT_PERCENT';

-- -------------------------------------------------------------------------
-- 3. TRIGGER — ESSAI GRATUIT UNE SEULE FOIS PAR MODULE
--    Si le module a DÉJÀ été en essai pour cette IMF (trial_used = TRUE, ou
--    présent dans l'historique des lignes de facture), toute nouvelle
--    demande d'essai est REFUSÉE et le module est forcé en PAYANT.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_module_trial_once()
RETURNS TRIGGER AS $$
DECLARE
    v_deja BOOLEAN := FALSE;
BEGIN
    -- 1. Essai déjà consommé sur la ligne renvoyée par la mise à jour ?
    v_deja := COALESCE(OLD.trial_used, FALSE)
           OR (OLD.is_trial = TRUE AND OLD.trial_end_date IS NOT NULL);

    -- 2. Historique : une ligne de facture « essai gratuit » existe déjà ?
    IF NOT v_deja THEN
        SELECT EXISTS (
            SELECT 1
              FROM saas_invoice_lines l
             WHERE l.institution_id = NEW.institution_id
               AND l.module_key      = NEW.module_key
               AND (l.statut_ligne = 'essai_gratuit' OR l.trial_end_date IS NOT NULL)
        ) INTO v_deja;
    END IF;

    IF v_deja AND NEW.is_trial = TRUE THEN
        -- Forçage immédiat en payant : la demande d'essai est ignorée.
        NEW.is_trial        := FALSE;
        NEW.trial_end_date  := NULL;
        NEW.trial_used      := TRUE;
        NEW.trial_started_at := COALESCE(OLD.trial_started_at, NEW.trial_started_at);
        RAISE WARNING
          'Module % : essai gratuit déjà utilisé par cette IMF — passage en PAYANT.',
          NEW.module_key;
    END IF;

    -- Mémorisation de l'essai réellement accordé.
    IF NEW.is_trial = TRUE THEN
        NEW.trial_used       := TRUE;
        NEW.trial_started_at := COALESCE(NEW.trial_started_at, CURRENT_DATE);
    END IF;

    -- Un forfait annuel sans date de signature prend la date du jour.
    IF NEW.billing_cycle = 'ANNUEL' AND NEW.annual_signed_at IS NULL THEN
        NEW.annual_signed_at := CURRENT_DATE;
    END IF;
    IF NEW.billing_cycle = 'MENSUEL' THEN
        NEW.annual_signed_at := NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_module_trial_once ON institution_module_subscriptions;
CREATE TRIGGER trg_module_trial_once
  BEFORE INSERT OR UPDATE ON institution_module_subscriptions
  FOR EACH ROW EXECUTE FUNCTION fn_module_trial_once();

-- -------------------------------------------------------------------------
-- 4. TRIGGERS — FACTURES IMMUABLES
--    a) une facture verrouillée n'accepte plus aucune modification de
--       montants, période, numéro ; seuls status et paid_at peuvent bouger
--       (UNPAID -> PAID, UNPAID -> CANCELLED, PAID -> CANCELLED).
--    b) les lignes d'une facture verrouillée sont définitives.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_saas_invoice_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_locked THEN
        IF NEW.invoice_number       IS DISTINCT FROM OLD.invoice_number
        OR NEW.billing_period_start IS DISTINCT FROM OLD.billing_period_start
        OR NEW.billing_period_end   IS DISTINCT FROM OLD.billing_period_end
        OR NEW.fixed_cost_total     IS DISTINCT FROM OLD.fixed_cost_total
        OR NEW.variable_cost_total  IS DISTINCT FROM OLD.variable_cost_total
        OR NEW.grand_total          IS DISTINCT FROM OLD.grand_total
        OR NEW.institution_id       IS DISTINCT FROM OLD.institution_id THEN
            RAISE EXCEPTION
              'Facture % verrouillée : montants et période définitifs (aucune modification possible).',
              OLD.invoice_number
              USING ERRCODE = 'check_violation';
        END IF;
        -- Le statut ne peut qu'avancer : UNPAID -> PAID / CANCELLED, PAID -> CANCELLED.
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            IF OLD.status = 'CANCELLED'
               OR (OLD.status = 'PAID' AND NEW.status = 'UNPAID') THEN
                RAISE EXCEPTION 'Facture % : retour en arrière de statut interdit.',
                  OLD.invoice_number USING ERRCODE = 'check_violation';
            END IF;
            NEW.is_locked := TRUE;   -- reste verrouillée
        END IF;
    END IF;

    IF TG_OP = 'DELETE' AND OLD.is_locked THEN
        RAISE EXCEPTION 'Facture % verrouillée : suppression interdite (utilisez l''annulation).',
          OLD.invoice_number USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saas_invoice_immutable ON saas_invoices;
CREATE TRIGGER trg_saas_invoice_immutable
  BEFORE UPDATE OR DELETE ON saas_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_saas_invoice_immutable();

CREATE OR REPLACE FUNCTION fn_saas_invoice_line_immutable()
RETURNS TRIGGER AS $$
DECLARE
    v_locked BOOLEAN;
    v_num    TEXT;
BEGIN
    SELECT i.is_locked, i.invoice_number INTO v_locked, v_num
      FROM saas_invoices i
     WHERE i.id = COALESCE(NEW.invoice_id, OLD.invoice_id);
    IF v_locked THEN
        RAISE EXCEPTION 'Lignes de la facture % verrouillées : aucune modification possible.',
          v_num USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saas_invoice_line_immutable ON saas_invoice_lines;
CREATE TRIGGER trg_saas_invoice_line_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON saas_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_saas_invoice_line_immutable();

COMMIT;
