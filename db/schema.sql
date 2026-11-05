-- ============================================================================
-- teebo — Plateforme SaaS multi-IMF (zone UEMOA)
-- Schéma PostgreSQL 16 : multi-tenant strict, codes d'identification,
-- hiérarchie organisationnelle, sécurité (expiration mdp, sessions).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. IMF (tenant racine) — chaque IMF est un espace totalement cloisonné.
-- ---------------------------------------------------------------------------
CREATE TYPE imf_type   AS ENUM ('SA','SCOOP');
CREATE TYPE imf_status AS ENUM ('pending','approved','trial','active','suspended','rejected');

CREATE TABLE imf (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_imf            TEXT NOT NULL UNIQUE,      -- code auto (ex: TBO-CI-000123)
    name                TEXT NOT NULL,
    type                imf_type NOT NULL,
    country_code        CHAR(2) NOT NULL,          -- CI, BF, SN, ML, BJ, TG, NE, GW
    city                TEXT NOT NULL,
    capital_cents       BIGINT NOT NULL DEFAULT 0,
    bceao_agreement_no  TEXT NOT NULL,
    phone_main          TEXT NOT NULL,             -- numéro d'appel IMF
    whatsapp            TEXT NOT NULL,             -- WhatsApp IMF
    email               TEXT NOT NULL,
    status              imf_status NOT NULL DEFAULT 'pending',
    trial_started_at    TIMESTAMPTZ,
    trial_ends_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Demande d'accès (parcours prospect -> facture proforma -> approbation)
-- ---------------------------------------------------------------------------
CREATE TABLE access_request (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id            UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    requester_lastname TEXT NOT NULL,
    requester_firstname TEXT NOT NULL,
    requester_position TEXT NOT NULL,
    admin_name        TEXT NOT NULL,
    plan_code         TEXT,                        -- formule choisie
    proforma_no       TEXT,                        -- n° facture proforma
    proforma_amount_cents BIGINT,
    proforma_validated BOOLEAN NOT NULL DEFAULT false,
    proforma_validated_at TIMESTAMPTZ,
    decided_by        UUID,                        -- admin teebo
    decided_at        TIMESTAMPTZ,
    decision          TEXT,                        -- approved / rejected
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Utilisateurs (tous rattachés à une seule IMF -> cloisonnement)
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin_imf','direction','department','service','agency','staff','teebo_admin');

CREATE TABLE app_user (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id            UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    org_unit_id       UUID,                        -- rattachement hiérarchique
    code_user         TEXT NOT NULL UNIQUE,        -- code d'accès auto
    full_name         TEXT NOT NULL,
    position          TEXT,
    email             TEXT NOT NULL,
    phone             TEXT,
    role              user_role NOT NULL,
    password_hash     TEXT,                        -- NULL tant que mdp non créé
    password_set_at   TIMESTAMPTZ,                 -- date création/changement mdp
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, email)
);

-- Code d'accès par IMF + email (un email unique par IMF)

-- ---------------------------------------------------------------------------
-- 4. Hiérarchie organisationnelle : direction > département > service > agence
-- ---------------------------------------------------------------------------
CREATE TYPE unit_kind AS ENUM ('direction','department','service','agency');

CREATE TABLE org_unit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id       UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    parent_id    UUID REFERENCES org_unit(id) ON DELETE CASCADE,
    kind         unit_kind NOT NULL,
    code_unit    TEXT NOT NULL UNIQUE,             -- code auto (ex: TBO-CI-000123-DEP-001)
    name         TEXT NOT NULL,
    city         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_user
    ADD CONSTRAINT fk_user_unit FOREIGN KEY (org_unit_id) REFERENCES org_unit(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5. Sessions : expiration 60j mdp, inactivité 30 min
-- ---------------------------------------------------------------------------
CREATE TABLE session (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_session_user ON session(user_id);

-- Piste d'audit inviolable
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    imf_id      UUID,
    actor_id    UUID,
    action      TEXT NOT NULL,
    entity      TEXT,
    entity_id   TEXT,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_imf ON audit_log(imf_id);

-- ---------------------------------------------------------------------------
-- 6. Formules (offre financière) — montants manuels/config
-- ---------------------------------------------------------------------------
CREATE TABLE plan (
    code            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    price_cents     BIGINT NOT NULL,
    billing_cycle   TEXT NOT NULL DEFAULT 'mensuel',
    max_agencies    INTEGER,
    max_users       INTEGER,
    features        JSONB,
    sort_order      INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 7. Fonctions : génération de codes + audit append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_next_seq(p_prefix TEXT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v BIGINT;
BEGIN
    -- compteur simple basé sur max existant + 1
    EXECUTE format('SELECT COALESCE(MAX(NULLIF(regexp_replace(%I, %L, %L), %L)::bigint),0)+1 FROM %I',
        p_prefix, '^.*-', '', '', 'dummy') INTO v;
    RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN 1; END;
$$;

CREATE OR REPLACE FUNCTION fn_gen_imf_code(p_country CHAR(2)) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_seq INT; v_code TEXT;
BEGIN
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM imf WHERE country_code = p_country;
    v_code := 'TBO-' || p_country || '-' || lpad(v_seq::text, 6, '0');
    -- collision improbable mais on sécurise
    WHILE EXISTS (SELECT 1 FROM imf WHERE code_imf = v_code) LOOP
        v_seq := v_seq + 1;
        v_code := 'TBO-' || p_country || '-' || lpad(v_seq::text, 6, '0');
    END LOOP;
    RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION fn_gen_unit_code(p_imf UUID, p_kind unit_kind) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_imf TEXT; v_seq INT; v_prefix TEXT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM org_unit WHERE imf_id = p_imf AND kind = p_kind;
    v_prefix := CASE p_kind
        WHEN 'direction'  THEN '-DIR-'
        WHEN 'department' THEN '-DEP-'
        WHEN 'service'    THEN '-SRV-'
        WHEN 'agency'     THEN '-AGC-'
    END;
    RETURN v_imf || v_prefix || lpad(v_seq::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION fn_gen_user_code(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_imf TEXT; v_seq INT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM app_user WHERE imf_id = p_imf;
    RETURN v_imf || '-U' || lpad(v_seq::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_row   JSONB;
    v_imf   UUID;
    v_id    TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
    ELSE
        v_row := to_jsonb(NEW);
    END IF;

    -- La table racine `imf` ne possède pas de colonne imf_id : son propre id fait office.
    IF v_row ? 'imf_id' THEN
        v_imf := NULLIF(v_row->>'imf_id', '')::uuid;
    ELSIF TG_TABLE_NAME = 'imf' THEN
        v_imf := NULLIF(v_row->>'id', '')::uuid;
    ELSE
        v_imf := NULL;
    END IF;

    v_id := COALESCE(v_row->>'id', '');

    INSERT INTO audit_log(imf_id, action, entity, entity_id, payload)
    VALUES (v_imf, TG_OP, TG_TABLE_NAME, v_id, v_row);

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_imf   AFTER INSERT OR UPDATE OR DELETE ON imf           FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_user  AFTER INSERT OR UPDATE OR DELETE ON app_user      FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_unit  AFTER INSERT OR UPDATE OR DELETE ON org_unit      FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_req   AFTER INSERT OR UPDATE OR DELETE ON access_request FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- Append-only sur l'audit
CREATE OR REPLACE FUNCTION fn_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append_only_table_%', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- 8. Formules par défaut (montants indicatifs, modifiables par teebo)
-- ---------------------------------------------------------------------------
INSERT INTO plan(code,label,price_cents,billing_cycle,max_agencies,max_users,features,sort_order) VALUES
 ('starter','Starter', 4500000,'mensuel', 3,  15, '["3 agences","15 utilisateurs","Collecte mobile","Support e-mail"]',1),
 ('business','Business',12000000,'mensuel', 10, 60, '["10 agences","60 utilisateurs","Collecte mobile","Reporting BCEAO","Support prioritaire"]',2),
 ('enterprise','Enterprise',35000000,'mensuel', NULL, NULL, '["Agences illimitées","Utilisateurs illimités","Collecte mobile","Reporting BCEAO","Sécurité renforcée","Support dédié"]',3);

COMMIT;

-- ============================================================================
-- VAGUE 2 — Collecte mobile, matériel, autorisations, essai & échéances
-- ============================================================================
BEGIN;

-- TEEBO-PREDECL : déclarations anticipées (les ALTER plus bas référencent
-- ces tables ; PostgreSQL exige leur existence au moment de la contrainte).
CREATE TABLE IF NOT EXISTS savings_product (
    code            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    description     TEXT,
    min_balance_cents BIGINT NOT NULL DEFAULT 0,
    interest_rate_bp  INTEGER NOT NULL DEFAULT 0,
    withdrawal_notice_days INTEGER NOT NULL DEFAULT 0,
    requires_kyc_complete  BOOLEAN NOT NULL DEFAULT false,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true
);
-- device_status : déclaré ici (les ALTER plus bas référencent la table device).
CREATE TYPE device_status AS ENUM ('active','revoked');
CREATE TABLE IF NOT EXISTS device (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    holder_name     TEXT NOT NULL,
    holder_birth    DATE NOT NULL,
    pin_hash        TEXT NOT NULL,
    pin_set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    imei            CHAR(15) NOT NULL UNIQUE,
    mac_address     TEXT NOT NULL DEFAULT '',
    phone_number    TEXT,
    device_model    TEXT,
    status          device_status NOT NULL DEFAULT 'active',
    enrolled_by     UUID REFERENCES app_user(id),
    revoked_by      UUID REFERENCES app_user(id),
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- TEEBO-PREDECL-END

-- ---------------------------------------------------------------------------
-- 9. Client (adhérent) et son compte
-- ---------------------------------------------------------------------------
CREATE TABLE client (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_client     TEXT NOT NULL UNIQUE,     -- code auto
    full_name       TEXT NOT NULL,
    birth_date      DATE,
    phone           TEXT,
    id_number       TEXT,                     -- pièce d'identité
    address         TEXT,
    -- Rattachement obligatoire dans la chaîne de collecte :
    -- client -> collectrice -> superviseur
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    superviseur_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    agency_unit_id  UUID REFERENCES org_unit(id) ON DELETE SET NULL,
    -- Origine de la fiche client (création ou enrôlement)
    origin          TEXT NOT NULL DEFAULT 'new',   -- new / enrolled
    created_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Localisation du domicile / lieu habituel de collecte du client (GPS).
ALTER TABLE client ADD COLUMN gps_lat NUMERIC(9,6);
ALTER TABLE client ADD COLUMN gps_lng NUMERIC(9,6);
ALTER TABLE client ADD COLUMN gps_accuracy_m NUMERIC(7,2);
ALTER TABLE client ADD COLUMN gps_captured_at TIMESTAMPTZ;

CREATE INDEX idx_client_collectrice ON client(collectrice_user_id);
CREATE INDEX idx_client_superviseur ON client(superviseur_user_id);

CREATE TABLE account (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    code_account    TEXT NOT NULL UNIQUE,     -- code auto
    balance_cents   BIGINT NOT NULL DEFAULT 0,
    currency        CHAR(3) NOT NULL DEFAULT 'XOF',
    status          TEXT NOT NULL DEFAULT 'active',  -- active / blocked
    blocked_at      TIMESTAMPTZ,
    blocked_reason  TEXT,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_account_client ON account(client_id);

-- ---------------------------------------------------------------------------
-- 9bis. ENRÔLEMENT DE CLIENT EXISTANT (migration depuis le SIG de l'IMF)
--   Obligatoire : nom et prénom, n° de compte actuel dans le SIG,
--   solde du client et date de ce solde.
--   Les informations doivent être complétées sous 1 mois, sinon le compte est
--   BLOQUÉ dans l'attente de la régularisation.
-- ---------------------------------------------------------------------------
CREATE TABLE client_enrollment (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    account_id          UUID REFERENCES account(id) ON DELETE SET NULL,
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    -- Informations SIG obligatoires
    sig_account_no      TEXT NOT NULL,     -- n° de compte actuel dans le SIG de l'IMF
    sig_balance_cents   BIGINT NOT NULL,   -- solde du client
    sig_balance_as_of   DATE NOT NULL,     -- date du solde
    sig_system          TEXT,              -- nom du SIG source
    -- Informations à compléter sous 1 mois
    birth_date          DATE,
    id_number           TEXT,
    address             TEXT,
    id_document_url     TEXT,
    next_of_kin         TEXT,
    -- Délai de régularisation (1 mois)
    deadline_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 month'),
    completed_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'pending',  -- pending / completed / blocked
    blocked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_enroll_sig ON client_enrollment(imf_id, sig_account_no);
CREATE INDEX idx_enroll_client ON client_enrollment(client_id);
CREATE INDEX idx_enroll_status ON client_enrollment(imf_id, status, deadline_at);

-- ---------------------------------------------------------------------------
-- 9ter. TYPES DE COMPTE D'ÉPARGNE
--   L'ouverture d'un compte passe par le choix d'un type de compte d'épargne.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_product (
    code            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    description     TEXT,
    min_balance_cents BIGINT NOT NULL DEFAULT 0,
    interest_rate_bp  INTEGER NOT NULL DEFAULT 0,   -- taux annuel (points de base)
    withdrawal_notice_days INTEGER NOT NULL DEFAULT 0,
    requires_kyc_complete  BOOLEAN NOT NULL DEFAULT false,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO savings_product(code,label,description,min_balance_cents,interest_rate_bp,withdrawal_notice_days,requires_kyc_complete,sort_order) VALUES
 ('epargne_classique','Épargne classique','Compte d''épargne libre, retraits à vue.', 0, 250, 0, false, 1),
 ('epargne_dat','Épargne à terme','Dépôt bloqué sur une durée convenue, mieux rémunéré.', 2500000, 450, 0, true, 2),
 ('epargne_jeune','Épargne jeune','Compte dédié aux 12-25 ans, plafond de dépôt.', 0, 300, 0, false, 3),
 ('epargne_femme','Épargne femme entrepreneure','Compte dédié à l''entrepreneuriat féminin.', 0, 320, 0, true, 4),
 ('compte_courant_ordinaire','Compte courant ordinaire','Compte à vue pour les opérations courantes.', 0, 0, 0, true, 5);

ALTER TABLE account ADD COLUMN product_code TEXT REFERENCES savings_product(code);

-- ---------------------------------------------------------------------------
-- 9quater. GPS DU LIEU DE COLLECTE
--   Une collectrice ne peut créer un compte QUE chez le client : l'application
--   enregistre automatiquement le GPS du lieu de collecte des dépôts.
-- ---------------------------------------------------------------------------
ALTER TABLE account ADD COLUMN opened_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE account ADD COLUMN opened_at_device_id UUID REFERENCES device(id) ON DELETE SET NULL;
ALTER TABLE account ADD COLUMN opened_at_agency_unit_id UUID REFERENCES org_unit(id) ON DELETE SET NULL;
ALTER TABLE account ADD COLUMN gps_lat NUMERIC(9,6);
ALTER TABLE account ADD COLUMN gps_lng NUMERIC(9,6);
ALTER TABLE account ADD COLUMN gps_accuracy_m NUMERIC(7,2);
ALTER TABLE account ADD COLUMN gps_captured_at TIMESTAMPTZ;

-- Date réelle de l'opération (obligatoire pour les régularisations guichet).

-- ---------------------------------------------------------------------------
-- 9quinquies. TOURNÉE DU JOUR DE LA COLLECTRICE
--   À la connexion, la collectrice voit par défaut sa tournée du jour ; la
--   distance (km) séparant chaque client de sa position y est affichée.
-- ---------------------------------------------------------------------------
CREATE TABLE collection_round (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    collectrice_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    round_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    label           TEXT,
    status          TEXT NOT NULL DEFAULT 'planned',   -- planned / in_progress / done
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (collectrice_user_id, round_date)
);

CREATE TABLE collection_round_visit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id        UUID NOT NULL REFERENCES collection_round(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL DEFAULT 0,        -- ordre de passage
    status          TEXT NOT NULL DEFAULT 'todo',      -- todo / visited / skipped
    visited_at      TIMESTAMPTZ,
    note            TEXT,
    UNIQUE (round_id, client_id)
);
CREATE INDEX idx_round_visit_round ON collection_round_visit(round_id);

-- Distance (mètres) entre deux points GPS (formule de haversine).

-- ---------------------------------------------------------------------------
-- 10. Enrôlement matériel : couplage obligatoire téléphone <-> collectrice
-- ---------------------------------------------------------------------------
-- device_status : déjà déclaré dans le bloc TEEBO-PREDECL ci-dessus.

CREATE TABLE IF NOT EXISTS device (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    holder_name     TEXT NOT NULL,            -- nom de la collectrice
    holder_birth    DATE NOT NULL,            -- date de naissance de la collectrice
    pin_hash        TEXT NOT NULL,            -- code PIN numérique (bcrypt)
    pin_set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    imei            CHAR(15) NOT NULL UNIQUE, -- IMEI 15 chiffres
    mac_address     TEXT NOT NULL UNIQUE,     -- adresse MAC
    phone_number    TEXT,
    device_model    TEXT,
    status          device_status NOT NULL DEFAULT 'active',
    enrolled_by     UUID REFERENCES app_user(id),
    revoked_by      UUID REFERENCES app_user(id),
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_device_user ON device(user_id);

-- Alerte sécurité (tentative non reconnue, appareil perdu/volé, etc.)
CREATE TYPE alert_level AS ENUM ('info','warning','critical');

CREATE TABLE security_alert (
    id              BIGSERIAL PRIMARY KEY,
    imf_id          UUID REFERENCES imf(id) ON DELETE CASCADE,
    level           alert_level NOT NULL DEFAULT 'warning',
    kind            TEXT NOT NULL,            -- unknown_device / device_revoked / device_use
    attempted_identifier TEXT,                -- identifiant saisi
    imei            TEXT,
    mac_address     TEXT,
    device_model    TEXT,
    ip              TEXT,
    message         TEXT,
    acknowledged    BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_imf ON security_alert(imf_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 11. Opérations de collecte (dépôts, régularisations, demandes de crédit)
-- ---------------------------------------------------------------------------
CREATE TYPE op_kind   AS ENUM ('depot','retrait_regul','credit_request');
CREATE TYPE op_status AS ENUM ('valide','en_attente','annule','rejete');

CREATE TABLE operation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    device_id       UUID REFERENCES device(id) ON DELETE SET NULL,
    user_id         UUID REFERENCES app_user(id) ON DELETE SET NULL,  -- collectrice
    kind            op_kind NOT NULL,
    amount_cents    BIGINT NOT NULL DEFAULT 0,
    status          op_status NOT NULL DEFAULT 'valide',
    -- impact caisse physique de la collectrice (faux pour la régularisation guichet)
    impacts_agent_cash BOOLEAN NOT NULL DEFAULT true,
    -- régularisation guichet : dépôt (+) ou retrait (-)
    direction       SMALLINT,
    reference       TEXT,
    note            TEXT,
    -- workflow annulation
    cancel_requested_at TIMESTAMPTZ,
    cancel_reason   TEXT,
    validated_by    UUID REFERENCES app_user(id),
    validated_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_operation_imf ON operation(imf_id, created_at DESC);
CREATE INDEX idx_operation_account ON operation(account_id);
-- TEEBO-OPFIX : colonnes GPS + date réelle ajoutées après création de la table
ALTER TABLE operation ADD COLUMN gps_lat NUMERIC(9,6);
ALTER TABLE operation ADD COLUMN operation_date DATE;
ALTER TABLE operation ADD COLUMN gps_lng NUMERIC(9,6);
ALTER TABLE operation ADD COLUMN gps_accuracy_m NUMERIC(7,2);

-- ---------------------------------------------------------------------------
-- 12. Autorisations de visibilité inter-entités (pilotées par l'admin)
--     Par défaut : aucune visibilité croisée. L'admin accorde explicitement.
-- ---------------------------------------------------------------------------
CREATE TABLE visibility_grant (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    grantor_unit_id UUID NOT NULL REFERENCES org_unit(id) ON DELETE CASCADE,
    grantee_unit_id UUID NOT NULL REFERENCES org_unit(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL DEFAULT 'read_operations',  -- read_operations / read_balances
    granted_by      UUID REFERENCES app_user(id),
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (grantor_unit_id, grantee_unit_id, scope)
);

-- ---------------------------------------------------------------------------
-- 13. Espace client en ligne : mode de connexion + format de relevé
-- ---------------------------------------------------------------------------
CREATE TYPE client_login_mode AS ENUM ('mot_de_passe','sms_otp','pin');
CREATE TYPE statement_format  AS ENUM ('pdf','csv','les_deux');

CREATE TABLE client_portal (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    login_mode      client_login_mode NOT NULL DEFAULT 'mot_de_passe',
    password_hash   TEXT,
    statement_format statement_format NOT NULL DEFAULT 'pdf',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES app_user(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id)
);

-- ---------------------------------------------------------------------------
-- 14. Essai & échéances : cycle de vie de l'abonnement IMF
-- ---------------------------------------------------------------------------
CREATE TYPE subscription_status AS ENUM ('trial','grace','active','disabled');

CREATE TABLE subscription (
    imf_id          UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    status          subscription_status NOT NULL DEFAULT 'trial',
    plan_code       TEXT,
    trial_started_at TIMESTAMPTZ,
    trial_ends_at   TIMESTAMPTZ,
    activated_at    TIMESTAMPTZ,
    disabled_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 15. Fonctions complémentaires : codes auto (client/compte) + expiration PIN
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gen_client_code(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_imf TEXT; v_seq INT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM client WHERE imf_id = p_imf;
    RETURN v_imf || '-C' || lpad(v_seq::text, 6, '0');
END;
$$;

CREATE OR REPLACE FUNCTION fn_gen_account_code(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_imf TEXT; v_seq INT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM account WHERE imf_id = p_imf;
    RETURN v_imf || '-A' || lpad(v_seq::text, 6, '0');
END;
$$;

-- Distance en mètres entre deux coordonnées GPS (formule de haversine).
CREATE OR REPLACE FUNCTION fn_haversine_m(p_lat1 NUMERIC, p_lng1 NUMERIC, p_lat2 NUMERIC, p_lng2 NUMERIC)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN p_lat1 IS NULL OR p_lng1 IS NULL OR p_lat2 IS NULL OR p_lng2 IS NULL THEN NULL
      ELSE 2 * 6371000 * asin(sqrt(
             power(sin(radians(p_lat2 - p_lat1) / 2), 2) +
             cos(radians(p_lat1)) * cos(radians(p_lat2)) *
             power(sin(radians(p_lng2 - p_lng1) / 2), 2)))
    END;
$$;

-- Code PIN matériel : expiration par défaut 90 jours (optionnel).
CREATE OR REPLACE FUNCTION fn_pin_expired(p_pin_set_at TIMESTAMPTZ, p_days INT DEFAULT 90) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    IF p_pin_set_at IS NULL THEN RETURN true; END IF;
    RETURN (now() - p_pin_set_at) > (p_days || ' days')::interval;
END;
$$;

-- Audit des nouvelles tables
CREATE TRIGGER trg_audit_device    AFTER INSERT OR UPDATE OR DELETE ON device         FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_operation AFTER INSERT OR UPDATE OR DELETE ON operation      FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_grant     AFTER INSERT OR UPDATE OR DELETE ON visibility_grant FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_subscr    AFTER INSERT OR UPDATE OR DELETE ON subscription   FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_client    AFTER INSERT OR UPDATE OR DELETE ON client         FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_account   AFTER INSERT OR UPDATE OR DELETE ON account        FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_enroll    AFTER INSERT OR UPDATE OR DELETE ON client_enrollment FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_round     AFTER INSERT OR UPDATE OR DELETE ON collection_round FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_visit     AFTER INSERT OR UPDATE OR DELETE ON collection_round_visit FOR EACH ROW EXECUTE FUNCTION fn_audit();

COMMIT;
