-- =========================================================================
-- teebo — TARIFS 2026 + PACK COMPLET (−5 %) + PRORATA (vague 34)
-- =========================================================================
-- Ce script NE CHANGE AUCUNE STRUCTURE existante. Il :
--   1. met à jour les TARIFS du catalogue (licence 250 000 FCFA ; tontine
--      75 000 ; crédit 100 000 ; conformité 25 000 ; comptabilité 100 000) ;
--   2. ajoute le réglage « remise pack complet » (5 % par défaut) ;
--   3. recalcule les modules souscrits en PACK COMPLET (tous les modules
--      actifs et facturables) pour que la remise soit immédiate ;
--   4. remplace la fonction de facturation par une version qui applique :
--        • le prorata aux activations en cours de mois,
--        • le prorata à un essai qui se termine en cours de mois,
--        • la remise pack complet de 5 % sur les abonnements mensuels
--          (ligne de remise négative, visible et vérifiable sur la facture),
--        • la règle « une seule facture par mois » (rejeu sans danger).
--
-- ADDITIF et RÉEXÉCUTABLE : peut être relancé sans risque.
-- =========================================================================
BEGIN;

-- -------------------------------------------------------------------------
-- 1. TARIFS OFFICIELS (les autres tarifs personnalisés ne sont pas touchés)
-- -------------------------------------------------------------------------
INSERT INTO saas_modules_pricing (module_key, module_name, monthly_subscription_price, position) VALUES
  ('MODULE_COLLECTE_TONTINE',      'Gestion de la Tontine & Collecte',   75000.00, 10),
  ('MODULE_DOSSIER_CREDIT',        'Octroi & Suivi des Crédits',        100000.00, 20),
  ('MODULE_COMPLIANCE_KYC',        'Gouvernance & LCB-FT',               25000.00, 30),
  ('MODULE_COMPTABILITE_AVANCEE',  'Grand Livre & Écritures Auto',      100000.00, 40)
ON CONFLICT (module_key) DO UPDATE SET
  monthly_subscription_price = EXCLUDED.monthly_subscription_price,
  module_name                = EXCLUDED.module_name,
  position                   = EXCLUDED.position,
  updated_at                 = now();

-- -------------------------------------------------------------------------
-- 2. LICENCE UNIQUE : 250 000 FCFA
-- -------------------------------------------------------------------------
INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
  ('UNIQUE_LICENSE_PRICE', 250000.00),
  ('FULL_PACK_DISCOUNT_PERCENT', 5.00)
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  updated_at    = now();

-- -------------------------------------------------------------------------
-- 3. MODULES : marqueur « pack complet »
-- -------------------------------------------------------------------------
ALTER TABLE institution_module_subscriptions
  ADD COLUMN IF NOT EXISTS is_full_pack BOOLEAN NOT NULL DEFAULT FALSE;

-- Une IMF qui a TOUS les modules facturables souscrits est en « pack complet ».
DO $$
DECLARE
    v_nb_dispo  INTEGER;
    v_imf       RECORD;
    v_nb_actifs INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_nb_dispo FROM saas_modules_pricing WHERE is_available;
    FOR v_imf IN SELECT DISTINCT institution_id FROM institution_module_subscriptions LOOP
        SELECT COUNT(*) INTO v_nb_actifs
          FROM institution_module_subscriptions s
          JOIN saas_modules_pricing p ON p.module_key = s.module_key
         WHERE s.institution_id = v_imf.institution_id AND s.is_active AND p.is_available;
        UPDATE institution_module_subscriptions
           SET is_full_pack = (v_nb_dispo > 0 AND v_nb_actifs = v_nb_dispo)
         WHERE institution_id = v_imf.institution_id
           AND is_full_pack IS DISTINCT FROM (v_nb_dispo > 0 AND v_nb_actifs = v_nb_dispo);
    END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- 4. FACTURATION MENSUELLE — version 3 (prorata + remise pack complet)
-- -------------------------------------------------------------------------
DROP FUNCTION IF EXISTS generate_imf_monthly_invoice_v2(UUID, DATE);
DROP FUNCTION IF EXISTS generate_imf_monthly_invoice_v3(UUID, DATE);

CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v3(
    p_institution_id UUID,
    p_billing_date   DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC AS $$
DECLARE
    v_license_due        NUMERIC(12, 2) := 0;
    v_license_paid       BOOLEAN;
    v_license_price      NUMERIC(12, 2) := 0;
    v_subscription_gross NUMERIC(12, 2) := 0;
    v_subscription_net   NUMERIC(12, 2) := 0;
    v_discount           NUMERIC(12, 2) := 0;
    v_discount_pct       NUMERIC(6, 2)  := 0;
    v_grand_total        NUMERIC(12, 2) := 0;
    v_month_start        DATE := date_trunc('month', p_billing_date)::DATE;
    v_month_end          DATE := (date_trunc('month', p_billing_date) + interval '1 month' - interval '1 day')::DATE;
    v_days_in_month      INTEGER := extract(day FROM (date_trunc('month', p_billing_date) + interval '1 month' - interval '1 day'))::INTEGER;
    v_invoice_id         UUID;
    v_invoice_number     TEXT;
    v_imf_code           TEXT;
    v_rec                RECORD;
    v_first_day          DATE;
    v_days_billable      INTEGER;
    v_amount             NUMERIC(12, 2);
    v_essai              BOOLEAN;
    v_nb_modules         INTEGER := 0;
    v_nb_actifs          INTEGER := 0;
    v_pack_complet       BOOLEAN := FALSE;
BEGIN
    -- GARDE-FOU : une IMF inconnue ne peut pas être facturée.
    IF NOT EXISTS (SELECT 1 FROM imf WHERE id = p_institution_id) THEN
        RAISE EXCEPTION 'IMF inconnue : %', p_institution_id;
    END IF;

    -- 0. Facture DÉJÀ générée pour ce mois ? On la renvoie telle quelle.
    SELECT id INTO v_invoice_id
      FROM saas_invoices
     WHERE institution_id = p_institution_id
       AND billing_period_start = v_month_start
       AND status <> 'CANCELLED';
    IF v_invoice_id IS NOT NULL THEN
        SELECT grand_total INTO v_grand_total FROM saas_invoices WHERE id = v_invoice_id;
        RETURN v_grand_total;
    END IF;

    -- 1. LICENCE UNIQUE — facturée au plus une fois dans la vie de l'IMF.
    INSERT INTO institution_license_status (institution_id, license_paid)
    VALUES (p_institution_id, FALSE)
    ON CONFLICT (institution_id) DO NOTHING;

    SELECT license_paid INTO v_license_paid
      FROM institution_license_status WHERE institution_id = p_institution_id;

    SELECT setting_value INTO v_license_price
      FROM saas_global_settings WHERE setting_key = 'UNIQUE_LICENSE_PRICE';
    v_license_price := COALESCE(v_license_price, 0);
    v_license_due := CASE WHEN v_license_paid IS TRUE THEN 0 ELSE v_license_price END;

    SELECT setting_value INTO v_discount_pct
      FROM saas_global_settings WHERE setting_key = 'FULL_PACK_DISCOUNT_PERCENT';
    v_discount_pct := COALESCE(v_discount_pct, 0);

    -- 2. NUMÉRO DE FACTURE
    SELECT COALESCE(imf.code_imf, 'IMF') INTO v_imf_code FROM imf WHERE id = p_institution_id;
    v_invoice_number := 'FACT-' || to_char(p_billing_date, 'YYYY') || '-' || v_imf_code
                        || '-' || to_char(p_billing_date, 'MM');
    IF EXISTS (SELECT 1 FROM saas_invoices WHERE invoice_number = v_invoice_number) THEN
        v_invoice_number := v_invoice_number || '-' || substr(p_institution_id::text, 1, 4);
    END IF;

    INSERT INTO saas_invoices (
        institution_id, invoice_number, billing_period_start, billing_period_end,
        fixed_cost_total, variable_cost_total, grand_total, status
    ) VALUES (
        p_institution_id, v_invoice_number, v_month_start, v_month_end, 0, 0, 0, 'UNPAID'
    ) RETURNING id INTO v_invoice_id;

    -- Ligne de licence (toujours traçable, même à 0 car déjà réglée).
    INSERT INTO saas_invoice_lines
        (invoice_id, institution_id, module_key, line_type, label, statut_ligne, amount_fcfa)
    VALUES (
        v_invoice_id, p_institution_id, NULL, 'licence',
        'Licence unique teebo (à vie)',
        CASE WHEN v_license_due > 0 THEN 'facture' ELSE 'deja_payee' END,
        v_license_due
    );

    -- 3. PACK COMPLET ? (tous les modules disponibles souscrits et actifs)
    SELECT COUNT(*) INTO v_nb_modules FROM saas_modules_pricing WHERE is_available;
    SELECT COUNT(*) INTO v_nb_actifs
      FROM institution_module_subscriptions s
      JOIN saas_modules_pricing p ON p.module_key = s.module_key
     WHERE s.institution_id = p_institution_id AND s.is_active AND p.is_available
       -- un module encore en essai gratuit ce mois-ci ne compte pas
       AND NOT (s.is_trial AND s.trial_end_date IS NOT NULL AND s.trial_end_date >= v_month_end);
    v_pack_complet := (v_nb_modules > 0 AND v_nb_actifs = v_nb_modules);

    -- 4. ABONNEMENTS MENSUELS DES MODULES ACTIFS
    FOR v_rec IN
        SELECT s.module_key, s.is_trial, s.trial_end_date, s.activated_at,
               p.module_name, p.monthly_subscription_price
          FROM institution_module_subscriptions s
          JOIN saas_modules_pricing p ON p.module_key = s.module_key
         WHERE s.institution_id = p_institution_id
           AND s.is_active = TRUE
         ORDER BY p.position
    LOOP
        -- Essai couvrant tout le mois : 0 FCFA, mention explicite.
        v_essai := (v_rec.is_trial = TRUE AND v_rec.trial_end_date IS NOT NULL
                    AND v_rec.trial_end_date >= v_month_end);
        IF v_essai THEN
            INSERT INTO saas_invoice_lines
                (invoice_id, institution_id, module_key, line_type, label,
                 statut_ligne, trial_end_date, amount_fcfa)
            VALUES (v_invoice_id, p_institution_id, v_rec.module_key, 'abonnement',
                    v_rec.module_name, 'essai_gratuit', v_rec.trial_end_date, 0);
            CONTINUE;
        END IF;

        -- PREMIER JOUR FACTURABLE : activation OU fin d'essai, le plus tardif.
        v_first_day := v_month_start;
        IF v_rec.activated_at IS NOT NULL AND v_rec.activated_at > v_first_day THEN
            v_first_day := v_rec.activated_at;   -- activation en cours de mois
        END IF;
        -- Essai qui se TERMINE en cours de mois : facturation à partir du
        -- lendemain de la fin de l'essai (prorata). Un essai encore en cours
        -- à la fin du mois a déjà été traité ci-dessus (0 FCFA).
        IF v_rec.is_trial = TRUE AND v_rec.trial_end_date IS NOT NULL
           AND (v_rec.trial_end_date + 1) > v_first_day THEN
            v_first_day := v_rec.trial_end_date + 1;
        END IF;

        -- PRORATA : jours facturables dans le mois (0 si déjà terminé avant).
        IF v_first_day > v_month_end THEN
            v_days_billable := 0;
        ELSE
            v_days_billable := (v_month_end - v_first_day) + 1;
        END IF;

        v_amount := ROUND(v_rec.monthly_subscription_price * v_days_billable / v_days_in_month, 2);
        v_subscription_gross := v_subscription_gross + v_amount;

        INSERT INTO saas_invoice_lines
            (invoice_id, institution_id, module_key, line_type, label,
             statut_ligne, trial_end_date, amount_fcfa)
        VALUES (v_invoice_id, p_institution_id, v_rec.module_key, 'abonnement',
                v_rec.module_name,
                CASE WHEN v_days_billable < v_days_in_month THEN 'facture_prorata' ELSE 'facture' END,
                v_rec.trial_end_date, v_amount);

        UPDATE institution_module_subscriptions
           SET last_billed_month = v_month_start,
               is_full_pack = v_pack_complet,
               updated_at = now()
         WHERE institution_id = p_institution_id AND module_key = v_rec.module_key;
    END LOOP;

    -- 5. REMISE PACK COMPLET (−5 % des abonnements du mois)
    IF v_pack_complet AND v_discount_pct > 0 THEN
        v_discount := ROUND(v_subscription_gross * v_discount_pct / 100, 2);
        INSERT INTO saas_invoice_lines
            (invoice_id, institution_id, module_key, line_type, label,
             statut_ligne, amount_fcfa)
        VALUES (v_invoice_id, p_institution_id, NULL, 'remise',
                'Remise pack complet (' || trim(to_char(v_discount_pct, 'FM999990.99')) || ' %)',
                'remise_pack', -v_discount);
    END IF;
    v_subscription_net := v_subscription_gross - v_discount;

    -- 6. TOTAL
    v_grand_total := ROUND(v_license_due + v_subscription_net, 2);

    UPDATE saas_invoices
       SET fixed_cost_total = v_license_due,
           variable_cost_total = v_subscription_net,
           grand_total = v_grand_total,
           status = CASE WHEN v_grand_total = 0 THEN 'PAID' ELSE 'UNPAID' END,
           paid_at = CASE WHEN v_grand_total = 0 THEN now() ELSE NULL END
     WHERE id = v_invoice_id;

    RETURN v_grand_total;
END;
$$ LANGUAGE plpgsql;

-- Compatibilité : d'anciens appels peuvent viser la « v2 ».
CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v2(
    p_institution_id UUID,
    p_billing_date   DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC AS $$
    SELECT generate_imf_monthly_invoice_v3($1, $2);
$$ LANGUAGE sql;

-- -------------------------------------------------------------------------
-- 5. LIGNES DE FACTURE : la remise doit être acceptée
--    (amount_fcfa reste obligatoire ; la remise est stockée en NÉGATIF, ce
--    qui distingue une remise d'un abonnement et permet de recouper le total)
-- -------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='saas_invoice_lines'
                  AND column_name='amount_fcfa')
    THEN
        ALTER TABLE saas_invoice_lines ALTER COLUMN amount_fcfa DROP NOT NULL;
    END IF;
END $$;

COMMIT;
