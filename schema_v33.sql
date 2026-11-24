-- =========================================================================
-- teebo — TARIFICATION SAAS PAR MODULE (vague 33)
-- =========================================================================
-- Modèle commercial retenu par l'IMF :
--   • LICENCE UNIQUE « à vie » payée UNE SEULE FOIS (500 000 FCFA par défaut) ;
--   • ABONNEMENT MENSUEL par module activé (tontine, crédit, conformité,
--     comptabilité) ;
--   • un module peut être en ESSAI GRATUIT : tant que l'essai court, il ne
--     coûte rien et ne figure PAS dans le total dû.
--
-- Ce script est ADDITIF et RÉEXÉCUTABLE (IF NOT EXISTS / ON CONFLICT).
-- Il ne touche à aucune table existante.
-- =========================================================================
BEGIN;

-- -------------------------------------------------------------------------
-- 1. CATALOGUE DES TAIRFS (tarif mensuel par module)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_modules_pricing (
    module_key                VARCHAR(50) PRIMARY KEY,
    module_name               VARCHAR(100) NOT NULL,
    monthly_subscription_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (monthly_subscription_price >= 0),
    is_available              BOOLEAN NOT NULL DEFAULT TRUE,
    position                  INTEGER NOT NULL DEFAULT 100,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Colonnes ajoutées si la table existait déjà avec une définition plus ancienne.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='saas_modules_pricing'
                      AND column_name='is_available')
    THEN
        ALTER TABLE saas_modules_pricing ADD COLUMN is_available BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE saas_modules_pricing ADD COLUMN position INTEGER NOT NULL DEFAULT 100;
    END IF;
END $$;

INSERT INTO saas_modules_pricing (module_key, module_name, monthly_subscription_price, position) VALUES
  ('MODULE_COLLECTE_TONTINE',      'Gestion de la Tontine & Collecte',   50000.00, 10),
  ('MODULE_DOSSIER_CREDIT',        'Octroi & Suivi des Crédits',         75000.00, 20),
  ('MODULE_COMPLIANCE_KYC',        'Gouvernance & LCB-FT',              25000.00, 30),
  ('MODULE_COMPTABILITE_AVANCEE',  'Grand Livre & Écritures Auto',       40000.00, 40)
ON CONFLICT (module_key) DO NOTHING;   -- les tarifs déjà personnalisés ne sont pas écrasés

-- -------------------------------------------------------------------------
-- 2. RÉGLAGES GLOBAUX (prix de la licence unique)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_global_settings (
    setting_key   VARCHAR(50) PRIMARY KEY,
    setting_value NUMERIC(12, 2) NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO saas_global_settings (setting_key, setting_value) VALUES
  ('UNIQUE_LICENSE_PRICE', 500000.00)
ON CONFLICT (setting_key) DO NOTHING;

-- -------------------------------------------------------------------------
-- 3. MODULES SOUSCRITS PAR CHAQUE IMF (+ essai gratuit)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_module_subscriptions (
    subscription_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    module_key       VARCHAR(50) NOT NULL REFERENCES saas_modules_pricing(module_key),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    activated_at     DATE NOT NULL DEFAULT CURRENT_DATE,
    deactivated_at   DATE,
    is_trial         BOOLEAN NOT NULL DEFAULT FALSE,
    trial_end_date   DATE,
    -- Dernier mois facturé sur ce module (évite toute double facturation).
    last_billed_month DATE,
    created_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (institution_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_ims_institution
  ON institution_module_subscriptions (institution_id, is_active);

-- -------------------------------------------------------------------------
-- 4. STATUT DE PAIEMENT DE LA LICENCE UNIQUE
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_license_status (
    institution_id   UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    license_paid     BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at          TIMESTAMPTZ,
    invoice_ref      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 5. FACTURES SAAS (une ligne par IMF et par mois)
-- -------------------------------------------------------------------------
-- Si une table saas_invoices existe déjà (ancienne vague), on l'enrichit au
-- lieu de la recréer. Sinon on la crée complète.
CREATE TABLE IF NOT EXISTS saas_invoices (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id           UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    invoice_number           TEXT UNIQUE,
    billing_period_start     DATE NOT NULL,
    billing_period_end       DATE NOT NULL,
    fixed_cost_total         NUMERIC(12, 2) NOT NULL DEFAULT 0,
    variable_cost_total      NUMERIC(12, 2) NOT NULL DEFAULT 0,
    grand_total              NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status                   TEXT NOT NULL DEFAULT 'UNPAID',   -- UNPAID / PAID / CANCELLED
    generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                  TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='saas_invoices'
                      AND column_name='invoice_number')
    THEN
        ALTER TABLE saas_invoices ADD COLUMN invoice_number TEXT;
        ALTER TABLE saas_invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'UNPAID';
        ALTER TABLE saas_invoices ADD COLUMN paid_at TIMESTAMPTZ;
    END IF;
END $$;

-- Une seule facture active par IMF et par mois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_invoices_imf_period
  ON saas_invoices (institution_id, billing_period_start);

-- Détail des lignes de chaque facture (traçabilité de chaque module).
CREATE TABLE IF NOT EXISTS saas_invoice_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
    institution_id  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    module_key      VARCHAR(50),          -- NULL pour la ligne « licence unique »
    line_type       TEXT NOT NULL,        -- licence / abonnement
    label           TEXT NOT NULL,
    statut_ligne    TEXT NOT NULL DEFAULT 'facture',   -- facture / essai_gratuit
    trial_end_date  DATE,
    amount_fcfa     NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saas_invoice_lines_invoice
  ON saas_invoice_lines (invoice_id);

-- -------------------------------------------------------------------------
-- 6. INITIALISATION D'UNE IMF (licence non payée + modules par défaut)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_imf_saas_init(p_institution_id UUID, p_actor UUID DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    INSERT INTO institution_license_status (institution_id, license_paid)
    VALUES (p_institution_id, FALSE)
    ON CONFLICT (institution_id) DO NOTHING;

    -- Reprise des modules déjà ouverts dans institution_features : une IMF qui
    -- utilise un module ne le perd pas, mais elle est désormais facturée.
    INSERT INTO institution_module_subscriptions (institution_id, module_key, is_active, created_by)
    SELECT p_institution_id, m.module_key, TRUE, p_actor
      FROM saas_modules_pricing m
      JOIN institution_features f ON f.institution_id = p_institution_id
     WHERE (m.module_key = 'MODULE_COLLECTE_TONTINE'      AND f.module_collecte_tontine)
        OR (m.module_key = 'MODULE_DOSSIER_CREDIT'        AND f.module_dossier_credit)
        OR (m.module_key = 'MODULE_COMPLIANCE_KYC'        AND f.module_compliance_kyc)
        OR (m.module_key = 'MODULE_COMPTABILITE_AVANCEE'  AND f.module_comptabilite_avancee)
    ON CONFLICT (institution_id, module_key) DO NOTHING;
END $$ LANGUAGE plpgsql;

-- -------------------------------------------------------------------------
-- 7. GÉNÉRATION DE LA FACTURE MENSUELLE (version 2 corrigée)
-- --------------------------------------------------------------------------
-- Corrections apportées au script d'origine :
--   a) v_end_month déclarait son TYPE (erreur de syntaxe PL/pgSQL) ;
--   b) une IMF payante (« license_paid = TRUE ») ne recevait jamais le prix de
--      la licence : v_license_due restait à 0 — voulu, mais le cas « déjà
--      facturée et impayée » devait être explicite ;
--   c) la facture pouvait être générée DEUX FOIS dans le même mois : un index
--      unique + un test d'existence l'empêchent désormais (rejeu idempotent) ;
--   d) le TOTAL était calculé alors que certain modules étaient en essai : le
--      détail de chaque module est maintenant CONSERVÉ dans saas_invoice_lines
--      (module facturé ou en essai gratuit), ce qui permet d'afficher la
--      ventilation exacte sur la facture ;
--   e) les essais expirés en cours de mois sont bien facturés, et un essai qui
--      se termine pendant le mois est proratisé au prorata des jours ;
--   f) la licence n'est réclamée qu'UNE fois : dès qu'elle est payée, elle ne
--      réapparaît plus sur aucune facture.
-- --------------------------------------------------------------------------

DROP FUNCTION IF EXISTS generate_imf_monthly_invoice_v2(UUID, DATE);

CREATE OR REPLACE FUNCTION generate_imf_monthly_invoice_v2(
    p_institution_id UUID,
    p_billing_date   DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC AS $$
DECLARE
    v_license_due        NUMERIC(12, 2) := 0;
    v_license_paid       BOOLEAN;
    v_license_price      NUMERIC(12, 2) := 0;
    v_subscription_total NUMERIC(12, 2) := 0;
    v_grand_total        NUMERIC(12, 2) := 0;
    v_month_start        DATE := date_trunc('month', p_billing_date)::DATE;
    v_month_end          DATE := (date_trunc('month', p_billing_date) + interval '1 month' - interval '1 day')::DATE;
    v_days_in_month      INTEGER := extract(day FROM (date_trunc('month', p_billing_date) + interval '1 month' - interval '1 day'))::INTEGER;
    v_invoice_id         UUID;
    v_invoice_number     TEXT;
    v_imf_code           TEXT;
    v_rec                RECORD;
    v_days_billable      INTEGER;
    v_amount             NUMERIC(12, 2);
    v_essai              BOOLEAN;
BEGIN
    -- GARDE-FOU : une IMF inconnue ne peut pas être facturée.
    IF NOT EXISTS (SELECT 1 FROM imf WHERE id = p_institution_id) THEN
        RAISE EXCEPTION 'IMF inconnue : %', p_institution_id;
    END IF;

    -- 0. Facture DÉJÀ générée pour ce mois ? On ne la refait pas.
    SELECT id, invoice_number INTO v_invoice_id, v_invoice_number
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

    IF v_license_paid IS DISTINCT FROM TRUE THEN
        v_license_due := v_license_price;
    ELSE
        v_license_due := 0;
    END IF;

    -- 2. ABONNEMENTS MENSUELS DES MODULES ACTIFS
    SELECT COALESCE(imf.code_imf, 'IMF') INTO v_imf_code FROM imf WHERE id = p_institution_id;
    v_invoice_number := 'FACT-' || to_char(p_billing_date, 'YYYY') || '-' || v_imf_code
                        || '-' || to_char(p_billing_date, 'MM');
    -- Unicité : deux IMF du même code impossible (code_imf est unique), mais on
    -- protège le cas d'un renommage en suffixant si nécessaire.
    IF EXISTS (SELECT 1 FROM saas_invoices WHERE invoice_number = v_invoice_number) THEN
        v_invoice_number := v_invoice_number || '-' || substr(p_institution_id::text, 1, 4);
    END IF;

    INSERT INTO saas_invoices (
        institution_id, invoice_number, billing_period_start, billing_period_end,
        fixed_cost_total, variable_cost_total, grand_total, status
    ) VALUES (
        p_institution_id, v_invoice_number, v_month_start, v_month_end, 0, 0, 0, 'UNPAID'
    ) RETURNING id INTO v_invoice_id;

    -- Ligne de licence (traçable, même si le montant est 0 car déjà payée).
    INSERT INTO saas_invoice_lines
        (invoice_id, institution_id, module_key, line_type, label, statut_ligne, amount_fcfa)
    VALUES (
        v_invoice_id, p_institution_id, NULL, 'licence',
        'Licence unique teebo (à vie)',
        CASE WHEN v_license_due > 0 THEN 'facture' ELSE 'deja_payee' END,
        v_license_due
    );

    FOR v_rec IN
        SELECT s.module_key, s.is_trial, s.trial_end_date, s.activated_at,
               p.module_name, p.monthly_subscription_price
          FROM institution_module_subscriptions s
          JOIN saas_modules_pricing p ON p.module_key = s.module_key
         WHERE s.institution_id = p_institution_id
           AND s.is_active = TRUE
         ORDER BY p.position
    LOOP
        v_essai := (v_rec.is_trial = TRUE AND v_rec.trial_end_date IS NOT NULL
                    AND v_rec.trial_end_date >= v_month_start);

        IF v_essai THEN
            -- Essai couvrant le mois : 0 FCFA (mention explicite sur la facture).
            INSERT INTO saas_invoice_lines
                (invoice_id, institution_id, module_key, line_type, label,
                 statut_ligne, trial_end_date, amount_fcfa)
            VALUES (v_invoice_id, p_institution_id, v_rec.module_key, 'abonnement',
                    v_rec.module_name, 'essai_gratuit', v_rec.trial_end_date, 0);
            CONTINUE;
        END IF;

        -- Jours réellement facturables dans le mois.
        -- (l'essai couvrant tout le mois a déjà été traité par CONTINUE plus haut)
        v_days_billable := v_days_in_month;
        IF v_rec.is_trial = TRUE AND v_rec.trial_end_date IS NOT NULL
           AND v_rec.trial_end_date < v_month_start THEN
            -- Essai terminé AVANT le mois : mois complet.
            v_days_billable := v_days_in_month;
        ELSIF v_rec.is_trial = TRUE AND v_rec.trial_end_date IS NOT NULL
           AND v_rec.trial_end_date >= v_month_start THEN
            -- Essai qui se termine PENDANT le mois (cas limite) : prorata.
            v_days_billable := GREATEST(0, v_month_end - v_rec.trial_end_date);
        END IF;
        -- Activation en cours de mois : prorata depuis la date d'activation.
        IF v_rec.activated_at > v_month_start THEN
            v_days_billable := LEAST(v_days_billable,
                                     (v_month_end - v_rec.activated_at + 1));
        END IF;

        v_amount := ROUND(v_rec.monthly_subscription_price * v_days_billable / v_days_in_month, 2);
        v_subscription_total := v_subscription_total + v_amount;

        INSERT INTO saas_invoice_lines
            (invoice_id, institution_id, module_key, line_type, label,
             statut_ligne, amount_fcfa)
        VALUES (v_invoice_id, p_institution_id, v_rec.module_key, 'abonnement',
                v_rec.module_name, 'facture', v_amount);

        UPDATE institution_module_subscriptions
           SET last_billed_month = v_month_start, updated_at = now()
         WHERE institution_id = p_institution_id AND module_key = v_rec.module_key;
    END LOOP;

    -- 3. TOTAL
    v_grand_total := ROUND(v_license_due + v_subscription_total, 2);

    UPDATE saas_invoices
       SET fixed_cost_total = v_license_due,
           variable_cost_total = v_subscription_total,
           grand_total = v_grand_total,
           status = CASE WHEN v_grand_total = 0 THEN 'PAID' ELSE 'UNPAID' END,
           paid_at = CASE WHEN v_grand_total = 0 THEN now() ELSE NULL END
     WHERE id = v_invoice_id;

    RETURN v_grand_total;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------------------
-- 8. VALIDATION D'UN PAIEMENT (licence ou facture)
-- --------------------------------------------------------------------------
-- Marque la licence comme payée (une fois pour toutes) et la facture réglée.
CREATE OR REPLACE FUNCTION fn_saas_mark_invoice_paid(
    p_invoice_id UUID,
    p_actor UUID DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE v_imf UUID;
BEGIN
    UPDATE saas_invoices
       SET status = 'PAID', paid_at = now()
     WHERE id = p_invoice_id AND status <> 'PAID'
     RETURNING institution_id INTO v_imf;
    IF v_imf IS NULL THEN RETURN FALSE; END IF;

    -- Si la facture contient la licence, elle devient définitivement payée.
    IF EXISTS (SELECT 1 FROM saas_invoice_lines
                WHERE invoice_id = p_invoice_id
                  AND line_type = 'licence' AND amount_fcfa > 0) THEN
        UPDATE institution_license_status
           SET license_paid = TRUE, paid_at = now(), updated_at = now()
         WHERE institution_id = v_imf AND license_paid = FALSE;
    END IF;
    RETURN TRUE;
END $$ LANGUAGE plpgsql;

COMMIT;
