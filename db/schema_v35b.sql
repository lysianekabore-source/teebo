-- =========================================================================
-- teebo — CALCUL DE FACTURATION STRICT AU JOUR PRÈS (vague 35)
-- =========================================================================
-- ADDITIF et RÉEXÉCUTABLE.
--
-- evaluate_imf_month(p_institution_id, p_mois) renvoie le DÉTAIL COMPLET
-- d'un mois, sans rien écrire : c'est la SEULE vérité de calcul.
-- generate_imf_monthly_invoice_v4() écrit ensuite ce détail en facture.
--
-- Règles appliquées, dans cet ordre :
--   A. Licence unique 250 000 FCFA, une seule fois à vie.
--   B. ESSAI EN COURS À LA DATE DE FACTURATION -> ligne à 0,00 FCFA, et
--      les jours d'essai restants sont reportés (la première facturation
--      se fera au prorata au mois suivant).
--   C. PRORATA AU JOUR PRÈS : la période facturée commence au plus tard
--      des trois dates : début du mois, activation, lendemain de fin
--      d'essai (ou date de bascule de cycle).
--   D. CYCLE ANNUEL : la réduction de 15 % ne court QU'À PARTIR de
--      annual_signed_at. Le mois de la signature est découpé en deux :
--      jours « mensuel plein tarif » puis jours « annuel −15 % ».
--   E. Remise pack complet (−5 %) sur les abonnements du mois.
--   F. Total = licence + abonnements − remises.
-- Tous les montants sont NUMERIC(12,2), arrondis ligne par ligne.
-- =========================================================================
BEGIN;

CREATE OR REPLACE FUNCTION evaluate_imf_month(
    p_institution_id UUID,
    p_mois           DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    line_type      TEXT,
    module_key     VARCHAR(50),
    label          TEXT,
    statut_ligne   TEXT,
    billing_cycle  TEXT,
    days_billed    INTEGER,
    days_in_month  INTEGER,
    period_from    DATE,
    period_to      DATE,
    discount_pct   NUMERIC(6, 2),
    amount_before  NUMERIC(12, 2),
    amount_fcfa    NUMERIC(12, 2),
    ordre          INTEGER
) AS $$
DECLARE
    v_debut         DATE := date_trunc('month', p_mois)::DATE;
    v_fin           DATE := (date_trunc('month', p_mois) + interval '1 month' - interval '1 day')::DATE;
    v_jours         INTEGER := EXTRACT(day FROM (date_trunc('month', p_mois) + interval '1 month' - interval '1 day'))::INTEGER;
    v_jour_facture  DATE := LEAST(GREATEST(p_mois, v_debut), v_fin);

    v_licence_payee BOOLEAN;
    v_licence_prix  NUMERIC(12, 2) := 0;
    v_remise_pack   NUMERIC(6, 2)  := 0;
    v_remise_annuel NUMERIC(6, 2)  := 15;

    v_nb_dispo      INTEGER := 0;
    v_nb_factures   INTEGER := 0;
    v_pack          BOOLEAN := FALSE;
    v_brut          NUMERIC(12, 2) := 0;
    v_remise        NUMERIC(12, 2) := 0;
    v_i             INTEGER := 0;
    v_r             RECORD;

    v_essai_encours BOOLEAN;
    v_debut_fact    DATE;
    v_jours_plein   INTEGER;
    v_jours_reduit  INTEGER;
    v_mt_plein      NUMERIC(12, 2);
    v_mt_reduit     NUMERIC(12, 2);
    v_mt_ligne      NUMERIC(12, 2);
    v_pct_ligne     NUMERIC(6, 2);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM imf WHERE id = p_institution_id) THEN
        RAISE EXCEPTION 'IMF inconnue : %', p_institution_id;
    END IF;

    -- Réglages (NUMERIC en base, jamais de flottant).
    SELECT setting_value INTO v_licence_prix
      FROM saas_global_settings WHERE setting_key = 'UNIQUE_LICENSE_PRICE';
    v_licence_prix := COALESCE(v_licence_prix, 0);
    SELECT setting_value INTO v_remise_pack
      FROM saas_global_settings WHERE setting_key = 'FULL_PACK_DISCOUNT_PERCENT';
    v_remise_pack := COALESCE(v_remise_pack, 0);
    SELECT setting_value INTO v_remise_annuel
      FROM saas_global_settings WHERE setting_key = 'ANNUAL_DISCOUNT_PERCENT';
    v_remise_annuel := COALESCE(v_remise_annuel, 15);

    INSERT INTO institution_license_status (institution_id, license_paid)
    VALUES (p_institution_id, FALSE)
    ON CONFLICT (institution_id) DO NOTHING;
    SELECT license_paid INTO v_licence_payee
      FROM institution_license_status WHERE institution_id = p_institution_id;

    -- ======================= A. LICENCE UNIQUE =========================
    line_type := 'licence'; module_key := NULL;
    label := 'Licence unique teebo (a vie)';
    statut_ligne := CASE WHEN v_licence_payee THEN 'deja_payee' ELSE 'facture' END;
    billing_cycle := NULL; days_billed := NULL; days_in_month := NULL;
    period_from := v_debut; period_to := v_fin; discount_pct := 0;
    amount_before := CASE WHEN v_licence_payee THEN 0 ELSE v_licence_prix END;
    amount_fcfa := amount_before; ordre := 0;
    RETURN NEXT;

    -- ======================= B/C/D. ABONNEMENTS ========================
    FOR v_r IN
        SELECT s.module_key, s.is_trial, s.trial_end_date, s.activated_at,
               s.billing_cycle, s.annual_signed_at, s.created_at,
               p.module_name, p.monthly_subscription_price, p.position
          FROM institution_module_subscriptions s
          JOIN saas_modules_pricing p ON p.module_key = s.module_key
         WHERE s.institution_id = p_institution_id
           AND s.is_active = TRUE
         ORDER BY p.position, s.module_key
    LOOP
        v_i := v_i + 10;
        v_essai_encours := (v_r.is_trial = TRUE
                            AND v_r.trial_end_date IS NOT NULL
                            AND v_r.trial_end_date >= v_jour_facture);

        -- B. Essai encore en cours à la date de facturation : 0 FCFA.
        IF v_essai_encours THEN
            line_type := 'abonnement'; module_key := v_r.module_key;
            label := v_r.module_name; statut_ligne := 'essai_gratuit';
            billing_cycle := v_r.billing_cycle;
            days_billed := 0; days_in_month := v_jours;
            period_from := v_jour_facture; period_to := v_r.trial_end_date;
            discount_pct := 0;
            amount_before := v_r.monthly_subscription_price;
            amount_fcfa := 0; ordre := v_i;
            RETURN NEXT;
            CONTINUE;
        END IF;

        -- C. Premier jour facturable du mois.
        v_debut_fact := v_debut;
        IF v_r.activated_at IS NOT NULL AND v_r.activated_at > v_debut_fact THEN
            v_debut_fact := v_r.activated_at;
        END IF;
        IF v_r.is_trial = TRUE AND v_r.trial_end_date IS NOT NULL
           AND (v_r.trial_end_date + 1) > v_debut_fact THEN
            v_debut_fact := v_r.trial_end_date + 1;   -- lendemain de l'essai
        END IF;

        IF v_debut_fact > v_fin THEN
            -- Rien à facturer ce mois-ci (essai couvrant tout le mois).
            line_type := 'abonnement'; module_key := v_r.module_key;
            label := v_r.module_name; statut_ligne := 'essai_gratuit';
            billing_cycle := v_r.billing_cycle;
            days_billed := 0; days_in_month := v_jours;
            period_from := v_r.trial_end_date; period_to := v_r.trial_end_date;
            discount_pct := 0;
            amount_before := v_r.monthly_subscription_price;
            amount_fcfa := 0; ordre := v_i;
            RETURN NEXT;
            CONTINUE;
        END IF;

        -- D. Découpage mensuel / annuel au jour près.
        IF v_r.billing_cycle = 'ANNUEL' AND v_r.annual_signed_at IS NOT NULL
           AND v_r.annual_signed_at >= v_debut_fact
           AND v_r.annual_signed_at <= v_fin THEN
            -- Le forfait annuel est signé CE mois-ci : jours avant la
            -- signature au plein tarif, jours à partir de la signature à −15 %.
            -- Convention INCLUSIVE : le jour de signature compte dans les
            -- jours remisés (16/11 -> 15 jours au plein tarif du 1 au 15,
            -- puis 15 jours à −15 % du 16 au 30).
            v_jours_plein  := (v_r.annual_signed_at - v_debut_fact);
            v_jours_reduit := (v_fin - v_r.annual_signed_at) + 1;
        ELSE
            v_jours_plein  := 0;
            v_jours_reduit := (v_fin - v_debut_fact) + 1;   -- bornes incluses
        END IF;
        IF v_jours_plein < 0 THEN v_jours_plein := 0; END IF;
        IF v_jours_reduit < 0 THEN v_jours_reduit := 0; END IF;

        v_mt_plein := ROUND(v_r.monthly_subscription_price * v_jours_plein / v_jours, 2);
        -- La remise annuelle ne s'applique qu'aux jours réellement ANNUELS.
        v_mt_reduit := ROUND(v_r.monthly_subscription_price
                             * (CASE WHEN v_r.billing_cycle = 'ANNUEL'
                                      AND v_r.annual_signed_at IS NOT NULL
                                     THEN (100 - v_remise_annuel) / 100 ELSE 1 END)
                             * v_jours_reduit / v_jours, 2);
        v_mt_ligne := v_mt_plein + v_mt_reduit;
        v_pct_ligne := CASE WHEN v_jours_reduit > 0 AND v_r.billing_cycle = 'ANNUEL'
                                  AND v_r.annual_signed_at IS NOT NULL
                            THEN v_remise_annuel ELSE 0 END;

        line_type := 'abonnement'; module_key := v_r.module_key;
        label := v_r.module_name;
        statut_ligne := CASE
            WHEN v_jours_plein > 0 AND v_jours_reduit > 0 THEN 'facture_cycle_mixte'
            WHEN (v_jours_plein + v_jours_reduit) < v_jours
              OR v_debut_fact > v_debut                  THEN 'facture_prorata'
            ELSE 'facture' END;
        billing_cycle := COALESCE(v_r.billing_cycle, 'MENSUEL');
        days_billed := v_jours_plein + v_jours_reduit;
        days_in_month := v_jours;
        period_from := v_debut_fact; period_to := v_fin;
        discount_pct := v_pct_ligne;
        -- Brut avant remise annuelle : le prix plein au prorata des jours.
        amount_before := ROUND(v_r.monthly_subscription_price
                               * (v_jours_plein + v_jours_reduit) / v_jours, 2);
        amount_fcfa := v_mt_ligne; ordre := v_i;
        v_brut := v_brut + v_mt_ligne;
        RETURN NEXT;
    END LOOP;

    -- ======================= E. REMISE PACK COMPLET ====================
    SELECT COUNT(*) INTO v_nb_dispo FROM saas_modules_pricing WHERE is_available;
    SELECT COUNT(*) INTO v_nb_factures
      FROM (SELECT 1 FROM institution_module_subscriptions s
              JOIN saas_modules_pricing p ON p.module_key = s.module_key
             WHERE s.institution_id = p_institution_id
               AND s.is_active AND p.is_available
               AND NOT (s.is_trial AND s.trial_end_date IS NOT NULL
                        AND s.trial_end_date >= v_jour_facture)
               AND NOT (s.activated_at IS NOT NULL AND s.activated_at > v_fin)) x;
    v_pack := (v_nb_dispo > 0 AND v_nb_factures = v_nb_dispo);

    IF v_pack AND v_remise_pack > 0 AND v_brut > 0 THEN
        v_remise := ROUND(v_brut * v_remise_pack / 100, 2);
        line_type := 'remise'; module_key := NULL;
        label := 'Remise pack complet ('
                 || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM v_remise_pack::TEXT))
                 || ' %)';
        statut_ligne := 'remise_pack'; billing_cycle := NULL;
        days_billed := NULL; days_in_month := NULL;
        period_from := v_debut; period_to := v_fin;
        discount_pct := v_remise_pack;
        amount_before := v_brut;
        amount_fcfa := -v_remise; ordre := 1000;
        RETURN NEXT;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

-- -------------------------------------------------------------------------
-- GÉNÉRATION DE LA FACTURE DU MOIS (v4) — écrit le détail, puis VERROUILLE.
-- Rejouable : si la facture du mois existe déjà, elle est renvoyée telle
-- quelle (immuable).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v4(
    p_institution_id UUID,
    p_billing_date   DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC AS $$
DECLARE
    v_debut        DATE := date_trunc('month', p_billing_date)::DATE;
    v_fin          DATE := (date_trunc('month', p_billing_date) + interval '1 month' - interval '1 day')::DATE;
    v_invoice_id   UUID;
    v_grand        NUMERIC(12, 2) := 0;
    v_fixe         NUMERIC(12, 2) := 0;
    v_variable     NUMERIC(12, 2) := 0;
    v_numero       TEXT;
    v_code         TEXT;
    v_l            RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM imf WHERE id = p_institution_id) THEN
        RAISE EXCEPTION 'IMF inconnue : %', p_institution_id;
    END IF;

    -- Une seule facture par mois : si elle existe, on n'y touche plus.
    SELECT id, grand_total INTO v_invoice_id, v_grand
      FROM saas_invoices
     WHERE institution_id = p_institution_id
       AND billing_period_start = v_debut
       AND status <> 'CANCELLED';
    IF v_invoice_id IS NOT NULL THEN
        RETURN v_grand;
    END IF;

    SELECT COALESCE(code_imf, 'IMF') INTO v_code FROM imf WHERE id = p_institution_id;
    v_numero := 'FACT-' || to_char(p_billing_date, 'YYYY') || '-' || v_code
                || '-' || to_char(p_billing_date, 'MM');
    IF EXISTS (SELECT 1 FROM saas_invoices WHERE invoice_number = v_numero) THEN
        v_numero := v_numero || '-' || substr(p_institution_id::text, 1, 4);
    END IF;

    INSERT INTO saas_invoices (institution_id, invoice_number,
                               billing_period_start, billing_period_end,
                               fixed_cost_total, variable_cost_total,
                               grand_total, status, is_locked)
    VALUES (p_institution_id, v_numero, v_debut, v_fin, 0, 0, 0, 'UNPAID', FALSE)
    RETURNING id INTO v_invoice_id;

    FOR v_l IN SELECT * FROM evaluate_imf_month(p_institution_id, p_billing_date)
               ORDER BY ordre LOOP
        INSERT INTO saas_invoice_lines (
            invoice_id, institution_id, module_key, line_type, label,
            statut_ligne, amount_fcfa, days_billed, days_in_month,
            billing_cycle, discount_pct, amount_before, period_from, period_to
        ) VALUES (
            v_invoice_id, p_institution_id, v_l.module_key, v_l.line_type, v_l.label,
            v_l.statut_ligne, v_l.amount_fcfa, v_l.days_billed, v_l.days_in_month,
            v_l.billing_cycle, v_l.discount_pct, v_l.amount_before,
            v_l.period_from, v_l.period_to
        );
        IF v_l.line_type = 'licence' THEN
            v_fixe := v_fixe + v_l.amount_fcfa;
        ELSE
            v_variable := v_variable + v_l.amount_fcfa;
        END IF;
    END LOOP;

    v_grand := v_fixe + v_variable;

    UPDATE saas_invoices
       SET fixed_cost_total = v_fixe,
           variable_cost_total = v_variable,
           grand_total = v_grand,
           status = CASE WHEN v_grand = 0 THEN 'PAID' ELSE 'UNPAID' END,
           paid_at = CASE WHEN v_grand = 0 THEN now() ELSE NULL END,
           is_locked = TRUE,
           locked_at = now()
     WHERE id = v_invoice_id;

    RETURN v_grand;
END;
$$ LANGUAGE plpgsql;

-- Compatibilité : les anciens appels « v2 / v3 » utilisent désormais v4.
CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v3(
    p_institution_id UUID, p_billing_date DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC AS $$
    SELECT generate_imf_monthly_invoice_v4($1, $2);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v2(
    p_institution_id UUID, p_billing_date DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC AS $$
    SELECT generate_imf_monthly_invoice_v4($1, $2);
$$ LANGUAGE sql;

COMMIT;
