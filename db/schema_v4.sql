-- ============================================================================
-- teebo — VAGUE 8 : Identité visuelle de l'IMF (logo) + documents PDF
-- ----------------------------------------------------------------------------
-- Cette vague n'altère AUCUNE table existante : elle ajoute uniquement des
-- objets nouveaux, appliqués de façon idempotente (IF NOT EXISTS).
--
--   * imf_branding        : logo de l'IMF (téléversé par l'admin depuis
--                           « Paramètres »), stocké en BASE64 (data URL) pour
--                           ne dépendre d'aucun système de fichiers.
--   * imf_document_settings : mentions légales obligatoires imprimées sur les
--                           documents PDF de l'IMF (relevé de compte, factures).
--
-- Le logo et ces mentions sont repris automatiquement sur :
--   - le relevé de compte du client (PDF) ;
--   - la facture proforma du parcours prospect ;
--   - la facture définitive (dès qu'elle est émise) ;
--   - tout autre document PDF généré pour l'IMF.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Identité visuelle de l'IMF
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imf_branding (
    imf_id              UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    logo_data_url       TEXT,               -- data:image/png;base64,....
    logo_mime           TEXT,               -- image/png | image/jpeg | image/webp | image/svg+xml
    logo_bytes          INTEGER,            -- taille du fichier (octets)
    logo_updated_at     TIMESTAMPTZ,
    logo_updated_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    -- Mentions légales obligatoires (factures & documents officiels)
    legal_name          TEXT,               -- raison sociale exacte
    legal_form          TEXT,               -- SA / SCOOP
    trade_register_no   TEXT,               -- RCCM / registre du commerce
    tax_id              TEXT,               -- IFU / NIF / identifiant fiscal
    bceao_agreement_no  TEXT,               -- n° d'agrément BCEAO (repris de imf si vide)
    vat_number          TEXT,               -- n° contribuable / TVA (optionnel)
    share_capital_cents BIGINT,             -- capital social (repris de imf si vide)
    legal_address       TEXT,               -- adresse du siège
    bank_details        TEXT,               -- coordonnées bancaires de règlement
    footer_note         TEXT,               -- note de pied de document
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT imf_branding_logo_size CHECK (logo_data_url IS NULL OR length(logo_data_url) <= 1500000)
);

-- Journalisation de l'identité visuelle (append-only, cohérent avec le socle).
DROP TRIGGER IF EXISTS trg_audit_imf_branding ON imf_branding;
CREATE TRIGGER trg_audit_imf_branding
    AFTER INSERT OR UPDATE OR DELETE ON imf_branding
    FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- ---------------------------------------------------------------------------
-- 1 bis. Paramètres documentaires de l'IMF (TVA configurable PAR TENANT)
-- ---------------------------------------------------------------------------
-- Aucun taux de TVA n'est imposé par défaut : tant que l'IMF ne l'a pas
-- renseigné (vat_rate_bp NULL), les factures portent « TVA : Non applicable ».
-- Le taux est exprimé en points de base (1800 = 18,00 %).
CREATE TABLE IF NOT EXISTS imf_document_settings (
    imf_id       UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    vat_rate_bp  INTEGER,            -- NULL = non renseigné => TVA non appliquée
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT imf_document_settings_vat_range CHECK (vat_rate_bp IS NULL OR (vat_rate_bp >= 0 AND vat_rate_bp <= 10000))
);

DROP TRIGGER IF EXISTS trg_audit_imf_doc_settings ON imf_document_settings;
CREATE TRIGGER trg_audit_imf_doc_settings
    AFTER INSERT OR UPDATE OR DELETE ON imf_document_settings
    FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- ---------------------------------------------------------------------------
-- 2. Numérotation des factures définitives (séquence par année)
-- ---------------------------------------------------------------------------
-- La facture proforma existe déjà (access_request.proforma_no). Une fois la
-- demande approuvée puis réglée, teebo émet la FACTURE DÉFINITIVE : numéro
-- séquentiel FAC-AAAA-XXXXXX, sans trou, réutilisable pour la comptabilité.
CREATE TABLE IF NOT EXISTS invoice (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id               UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    request_id           UUID REFERENCES access_request(id) ON DELETE SET NULL,
    kind                 TEXT NOT NULL DEFAULT 'definitive', -- proforma | definitive
    invoice_no           TEXT NOT NULL UNIQUE,
    issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at               TIMESTAMPTZ,
    period_label         TEXT,                 -- ex : « Novembre 2026 »
    period_start         DATE,
    period_end           DATE,
    currency             CHAR(3) NOT NULL DEFAULT 'XOF',
    plan_code            TEXT,
    plan_label           TEXT,
    subtotal_cents       BIGINT NOT NULL DEFAULT 0,
    discount_cents       BIGINT NOT NULL DEFAULT 0,
    vat_rate_bp          INTEGER NOT NULL DEFAULT 0,   -- TVA en points de base
    vat_cents            BIGINT NOT NULL DEFAULT 0,
    total_cents          BIGINT NOT NULL DEFAULT 0,
    amount_paid_cents    BIGINT NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'emise', -- emise | payee | annulee
    payment_method       TEXT,
    payment_reference    TEXT,
    paid_at              TIMESTAMPTZ,
    proforma_no          TEXT,
    notes                TEXT,
    created_by           UUID REFERENCES app_user(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_imf ON invoice(imf_id, issued_at DESC);

DROP TRIGGER IF EXISTS trg_audit_invoice ON invoice;
CREATE TRIGGER trg_audit_invoice
    AFTER INSERT OR UPDATE OR DELETE ON invoice
    FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- Séquence de numérotation des factures définitives (une par exercice).
CREATE TABLE IF NOT EXISTS invoice_counter (
    fiscal_year INTEGER PRIMARY KEY,
    last_seq    INTEGER NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION fn_gen_invoice_no() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_year INTEGER := EXTRACT(YEAR FROM now())::int;
    v_seq  INTEGER;
BEGIN
    INSERT INTO invoice_counter(fiscal_year, last_seq) VALUES (v_year, 1)
    ON CONFLICT (fiscal_year) DO UPDATE SET last_seq = invoice_counter.last_seq + 1
    RETURNING last_seq INTO v_seq;
    RETURN 'FAC-' || v_year || '-' || lpad(v_seq::text, 6, '0');
END;
$$;

COMMIT;
