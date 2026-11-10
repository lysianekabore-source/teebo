-- ============================================================================
-- teebo — VAGUE 3 : Produits d'épargne IMF complets, frais, rattrapage,
--           retrait anticipé, demandes personnalisées, dossiers de crédit
-- ============================================================================
-- Ce fichier s'applique APRÈS db/schema.sql (vagues 1 + 2).
-- Il est IDEMPOTENT : sans danger à relancer.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 16. TYPES DE DEMANDE PERSONNALISÉS (admin)
--     L'administrateur peut créer une infinité de types de demandes et y
--     adosser un montant de frais fixe, débité à la source sur le compte du
--     client demandeur (ex. protège-carnet, renouvellement de carnet).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_type (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code            TEXT NOT NULL,
    label           TEXT NOT NULL,
    description     TEXT,
    fee_cents       BIGINT NOT NULL DEFAULT 0,   -- frais fixe débité à la source
    requires_doc    BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, code)
);
CREATE INDEX IF NOT EXISTS idx_request_type_imf ON request_type(imf_id, is_active);

-- ---------------------------------------------------------------------------
-- 17. PRODUIT D'ÉPARGNE — SPÉCIFICATIONS FONCTIONNELLES & RÈGLES DE GESTION
-- ---------------------------------------------------------------------------

-- Nature du produit : à vue / bloquée / contractuelle.
DO $$ BEGIN
    CREATE TYPE savings_nature AS ENUM ('a_vue','bloquee','contractuelle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cible commerciale (plusieurs valeurs possibles par produit).
DO $$ BEGIN
    CREATE TYPE savings_target AS ENUM ('particuliers','commercants','groupements_feminins','jeunes','agriculteurs');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Mode de calcul des intérêts.
DO $$ BEGIN
    CREATE TYPE interest_method AS ENUM ('solde_moyen','quinzaine','capitalise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Périodicité de capitalisation / versement des intérêts.
DO $$ BEGIN
    CREATE TYPE interest_period AS ENUM ('mensuelle','trimestrielle','semestrielle','annuelle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Périodicité de retrait autorisée.
DO $$ BEGIN
    CREATE TYPE withdrawal_period AS ENUM ('a_vue','mensuelle','quinzaine','terme');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Mode de calcul des frais de collecte mobile.
DO $$ BEGIN
    CREATE TYPE collection_fee_mode AS ENUM ('fixe','par_tranche','pourcentage');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- On enrichit la table savings_product de la vague 2 (colonnes additives).
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS nature            savings_nature      NOT NULL DEFAULT 'a_vue';
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS targets           savings_target[]    NOT NULL DEFAULT ARRAY['particuliers']::savings_target[];
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS opening_fee_cents BIGINT NOT NULL DEFAULT 0;      -- frais d'ouverture
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS subscription_fee_cents BIGINT NOT NULL DEFAULT 0; -- frais de souscription
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS min_permanent_cents BIGINT NOT NULL DEFAULT 0;    -- solde minimum permanent
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS min_opening_deposit_cents BIGINT NOT NULL DEFAULT 0; -- dépôt minimum à l'ouverture
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS min_deposit_cents BIGINT NOT NULL DEFAULT 0;      -- dépôt minimum (hors ouverture)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS interest_method   interest_method     NOT NULL DEFAULT 'solde_moyen';
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS interest_period   interest_period     NOT NULL DEFAULT 'annuelle';
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS withdrawal_period withdrawal_period   NOT NULL DEFAULT 'a_vue';
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS closing_fee_cents BIGINT NOT NULL DEFAULT 0;      -- frais de clôture
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS account_keeping_fee_cents BIGINT NOT NULL DEFAULT 0; -- frais de tenue de compte (par mois entamé)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS early_withdrawal_fee_bp INTEGER NOT NULL DEFAULT 0;  -- commission retrait anticipé (points de base)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS early_withdrawal_exempt_new_deposits BOOLEAN NOT NULL DEFAULT true; -- exonération si les nouveaux dépôts du mois ne sont pas entamés
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS collection_fee_mode collection_fee_mode NOT NULL DEFAULT 'pourcentage';
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS collection_fee_fixed_cents BIGINT NOT NULL DEFAULT 0;   -- mode « fixe »
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS collection_fee_bp INTEGER NOT NULL DEFAULT 0;          -- mode « pourcentage » (du cumul mensuel des dépôts)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS collection_fee_tranches JSONB NOT NULL DEFAULT '[]'::jsonb; -- mode « par tranche »
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS requires_kyc_complete BOOLEAN NOT NULL DEFAULT false;

-- Catalogue enrichi : 5 types de compte d'épargne conformes aux règles IMF.
INSERT INTO savings_product(
  code,label,description,min_balance_cents,interest_rate_bp,withdrawal_notice_days,requires_kyc_complete,sort_order,
  nature,targets,opening_fee_cents,subscription_fee_cents,min_permanent_cents,min_opening_deposit_cents,min_deposit_cents,
  interest_method,interest_period,withdrawal_period,closing_fee_cents,account_keeping_fee_cents,
  early_withdrawal_fee_bp,early_withdrawal_exempt_new_deposits,
  collection_fee_mode,collection_fee_fixed_cents,collection_fee_bp,collection_fee_tranches)
VALUES
 ('epargne_classique','Épargne classique',
  'Compte d''épargne libre, retraits à vue. Produit d''entrée de gamme pour les particuliers et commerçants.',
  0,250,0,false,1,
  'a_vue',ARRAY['particuliers','commercants']::savings_target[],50000,25000,500000,100000,50000,
  'solde_moyen','trimestrielle','a_vue',100000,50000,
  100,true,
  'pourcentage',0,150,'[]'::jsonb),
 ('epargne_dat','Épargne à terme','Dépôt bloqué sur une durée convenue, mieux rémunéré. Nature : épargne bloquée.',
  2500000,450,0,true,2,
  'bloquee',ARRAY['particuliers','commercants']::savings_target[],100000,50000,2500000,500000,100000,
  'capitalise','annuelle','terme',200000,100000,
  400,false,
  'fixe',100000,0,'[]'::jsonb),
 ('epargne_jeune','Épargne jeune','Compte dédié aux 12-25 ans, plafond de dépôt, sans frais de tenue de compte.',
  0,300,0,false,3,
  'a_vue',ARRAY['jeunes']::savings_target[],0,0,100000,50000,25000,
  'quinzaine','trimestrielle','a_vue',0,0,
  0,true,
  'fixe',0,0,'[]'::jsonb),
 ('epargne_femme','Épargne femme entrepreneure','Compte dédié à l''entrepreneuriat féminin et aux groupements féminins.',
  0,320,0,true,4,
  'contractuelle',ARRAY['groupements_feminins','particuliers','commercants']::savings_target[],25000,25000,500000,100000,50000,
  'solde_moyen','mensuelle','mensuelle',50000,25000,
  150,true,
  'par_tranche',0,0,
  '[{"from_cents":0,"to_cents":5000000,"fee_cents":50000},{"from_cents":5000000,"to_cents":20000000,"fee_cents":150000},{"from_cents":20000000,"to_cents":null,"fee_cents":300000}]'::jsonb),
 ('epargne_agricole','Épargne agricole','Compte calé sur le calendrier des campagnes agricoles : épargne contractuelle avec retraits sur quinzaine.',
  0,350,0,true,5,
  'contractuelle',ARRAY['agriculteurs','groupements_feminins']::savings_target[],25000,25000,250000,50000,25000,
  'quinzaine','semestrielle','quinzaine',50000,25000,
  200,true,
  'par_tranche',0,0,
  '[{"from_cents":0,"to_cents":10000000,"fee_cents":100000},{"from_cents":10000000,"to_cents":null,"fee_cents":250000}]'::jsonb),
 ('compte_courant_ordinaire','Compte courant ordinaire','Compte à vue pour les opérations courantes.',
  0,0,0,true,6,
  'a_vue',ARRAY['commercants','particuliers']::savings_target[],25000,25000,0,50000,25000,
  'solde_moyen','annuelle','a_vue',100000,100000,
  0,true,
  'pourcentage',0,200,'[]'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  label               = EXCLUDED.label,
  description         = EXCLUDED.description,
  min_balance_cents   = EXCLUDED.min_balance_cents,
  interest_rate_bp    = EXCLUDED.interest_rate_bp,
  requires_kyc_complete = EXCLUDED.requires_kyc_complete,
  nature              = EXCLUDED.nature,
  targets             = EXCLUDED.targets,
  opening_fee_cents   = EXCLUDED.opening_fee_cents,
  subscription_fee_cents = EXCLUDED.subscription_fee_cents,
  min_permanent_cents = EXCLUDED.min_permanent_cents,
  min_opening_deposit_cents = EXCLUDED.min_opening_deposit_cents,
  min_deposit_cents   = EXCLUDED.min_deposit_cents,
  interest_method     = EXCLUDED.interest_method,
  interest_period     = EXCLUDED.interest_period,
  withdrawal_period   = EXCLUDED.withdrawal_period,
  closing_fee_cents   = EXCLUDED.closing_fee_cents,
  account_keeping_fee_cents = EXCLUDED.account_keeping_fee_cents,
  early_withdrawal_fee_bp = EXCLUDED.early_withdrawal_fee_bp,
  early_withdrawal_exempt_new_deposits = EXCLUDED.early_withdrawal_exempt_new_deposits,
  collection_fee_mode = EXCLUDED.collection_fee_mode,
  collection_fee_fixed_cents = EXCLUDED.collection_fee_fixed_cents,
  collection_fee_bp   = EXCLUDED.collection_fee_bp,
  collection_fee_tranches = EXCLUDED.collection_fee_tranches;

-- ---------------------------------------------------------------------------
-- 18. CAISSE / FRAIS CLIENTS — journal des frais prélevés ou en attente
--     « Frais de tenue de compte : dû pour tout mois entamé et prélevé le
--      dernier jour du mois. »
--     « Gestion des soldes insuffisants (rattrapage automatique) : si le solde
--      disponible est inférieur au solde minimum permanent, le prélèvement est
--      tout de même acté et bascule en état "En attente". Dès que le compte
--      reçoit un crédit, les frais en attente sont récupérés en priorité. »
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE fee_kind AS ENUM (
      'ouverture','souscription','tenue_compte','collecte_mobile',
      'retrait_anticipe','cloture','demande_personnalisee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fee_status AS ENUM ('en_attente','preleve','annule');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_fee (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    kind            fee_kind NOT NULL,
    amount_cents    BIGINT NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'XOF',
    status          fee_status NOT NULL DEFAULT 'preleve',
    -- période de rattachement (mois entamé, cumul de dépôts du mois…)
    period_start    DATE,
    period_end      DATE,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- levée du blocage : la date à laquelle le rattrapage a été effectué
    settled_at      TIMESTAMPTZ,
    created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fee_account  ON account_fee(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_pending  ON account_fee(account_id, status) WHERE status = 'en_attente';
CREATE INDEX IF NOT EXISTS idx_fee_period   ON account_fee(imf_id, period_start, kind);

-- ---------------------------------------------------------------------------
-- 19. DEMANDES CLIENTS (types personnalisés) — frais débités à la source
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE client_request_status AS ENUM ('soumise','en_traitement','traitee','rejetee','annulee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS client_request (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    reference       TEXT NOT NULL,
    request_type_id UUID NOT NULL REFERENCES request_type(id) ON DELETE RESTRICT,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES account(id) ON DELETE SET NULL,
    fee_cents       BIGINT NOT NULL DEFAULT 0,
    fee_charged     BOOLEAN NOT NULL DEFAULT false,
    status          client_request_status NOT NULL DEFAULT 'soumise',
    note            TEXT,
    created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    handled_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    handled_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creq_client ON client_request(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creq_imf    ON client_request(imf_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 20. MOUVEMENTS DE COMPTE (grand livre simplifié)
--     Nécessaire au calcul « quinzaine », au solde moyen, au cumul mensuel des
--     dépôts (frais de collecte mobile) et à la règle d'exonération du retrait
--     anticipé (le retrait n'entame-t-il pas les nouveaux dépôts du mois ?).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_movement (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    direction       SMALLINT NOT NULL,           -- +1 crédit, -1 débit
    amount_cents    BIGINT NOT NULL CHECK (amount_cents >= 0),
    balance_after_cents BIGINT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'operation', -- operation / fee / interest / fee_recovery
    source_id       UUID,
    label           TEXT,
    gps_lat         NUMERIC(9,6),
    gps_lng         NUMERIC(9,6),
    device_id       UUID REFERENCES device(id) ON DELETE SET NULL,
    user_id         UUID REFERENCES app_user(id) ON DELETE SET NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mvt_account ON account_movement(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mvt_month   ON account_movement(account_id, direction, occurred_at);

-- ---------------------------------------------------------------------------
-- 21. DOSSIERS DE CRÉDIT — suivi partagé Client / Collectrice / Superviseur
--     « Soumission par le Client ou saisie par la Collectrice ; traitement par
--      l'Agent de crédit ; tableau de bord commun (En attente, À l'étude,
--      Approuvé, Rejeté). »
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE credit_origin AS ENUM ('client','collectrice','guichet');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE credit_status AS ENUM ('en_attente','a_l_etude','approuve','rejete','decaisse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS credit_file (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    reference       TEXT NOT NULL,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES account(id) ON DELETE SET NULL,
    origin          credit_origin NOT NULL DEFAULT 'collectrice',
    requested_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    superviseur_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
    duration_months INTEGER,
    purpose         TEXT,
    activity        TEXT,
    collateral      TEXT,
    comments        TEXT,
    status          credit_status NOT NULL DEFAULT 'en_attente',
    officer_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,  -- Agent de crédit
    assigned_at     TIMESTAMPTZ,
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    approved_amount_cents BIGINT,
    -- pièces justificatives (dossier numérisé)
    documents       JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_client ON credit_file(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_imf    ON credit_file(imf_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_col    ON credit_file(collectrice_user_id, status);

-- Historique des changements d'état (traçabilité du suivi en temps réel)
CREATE TABLE IF NOT EXISTS credit_event (
    id              BIGSERIAL PRIMARY KEY,
    credit_file_id  UUID NOT NULL REFERENCES credit_file(id) ON DELETE CASCADE,
    from_status     credit_status,
    to_status       credit_status NOT NULL,
    actor_user_id   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    actor_role      TEXT,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cevent_file ON credit_event(credit_file_id, created_at);

-- ---------------------------------------------------------------------------
-- 22. ÉPARAGNE PARAMÉTRAGE DES FRAIS DE COLLECTE MOBILE (au niveau produit)
--     Trois modes : fixe / par tranche / pourcentage du cumul mensuel.
--     Calculés et prélevés le dernier jour du mois.
--     (colonnes ajoutées à savings_product ci-dessus)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 23. GÉNÉRATEURS DE CODES
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gen_request_ref(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_seq INT;
BEGIN
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM client_request WHERE imf_id = p_imf;
    RETURN 'DEM-' || lpad(v_seq::text, 6, '0');
END;
$$;

CREATE OR REPLACE FUNCTION fn_gen_credit_ref(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_seq INT;
BEGIN
    SELECT COALESCE(COUNT(*),0)+1 INTO v_seq FROM credit_file WHERE imf_id = p_imf;
    RETURN 'CRD-' || lpad(v_seq::text, 6, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- 24. AUDIT
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_request_type ON request_type;
CREATE TRIGGER trg_audit_request_type AFTER INSERT OR UPDATE OR DELETE ON request_type FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_client_request ON client_request;
CREATE TRIGGER trg_audit_client_request AFTER INSERT OR UPDATE OR DELETE ON client_request FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_credit_file ON credit_file;
CREATE TRIGGER trg_audit_credit_file AFTER INSERT OR UPDATE OR DELETE ON credit_file FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_account_fee ON account_fee;
CREATE TRIGGER trg_audit_account_fee AFTER INSERT OR UPDATE OR DELETE ON account_fee FOR EACH ROW EXECUTE FUNCTION fn_audit();


-- ---------------------------------------------------------------------------
-- 25. VAGUE 4 — TOURNÉE DE COLLECTE : programme par client, gel automatique,
--     explications de la collectrice, validation superviseur, géo-visites.
--     IDEMPOTENT : sans danger à relancer.
-- ---------------------------------------------------------------------------

-- 25.0 Type d'opération : ajout du type « request » (demande libre : relevé,
--      attestation, chéquier…). ALTER TYPE idempotent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'op_kind' AND e.enumlabel = 'request'
    ) THEN
        ALTER TYPE op_kind ADD VALUE 'request';
    END IF;
END $$;

-- 25.1 Programme de collecte par client (jours de passage fixés par la collectrice)
--      weekdays : jours de la semaine (0 = dimanche … 6 = samedi)
--      frequency : hebdomadaire / bimensuel / mensuel / libre
CREATE TABLE IF NOT EXISTS client_schedule (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    weekdays        INTEGER[] NOT NULL DEFAULT '{}',  -- 0..6 (0=dimanche)
    frequency       TEXT NOT NULL DEFAULT 'hebdomadaire',
    day_of_month    INTEGER,                          -- pour « mensuel » (1..31)
    effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    note            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_schedule_client ON client_schedule(client_id, is_active);
CREATE INDEX IF NOT EXISTS idx_client_schedule_collectrice ON client_schedule(collectrice_user_id);

-- 25.2 Gel d’un client (compte figé) : refus de toute opération tant qu’il est gelé.
--      Un client non visité pendant 1 mois est gelé AUTOMATIQUEMENT.
ALTER TABLE client ADD COLUMN IF NOT EXISTS frozen_at        TIMESTAMPTZ;
ALTER TABLE client ADD COLUMN IF NOT EXISTS frozen_reason    TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS frozen_by        UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE client ADD COLUMN IF NOT EXISTS frozen_auto      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client ADD COLUMN IF NOT EXISTS frozen_since_days INTEGER;   -- écart détecté (hors gel auto)
ALTER TABLE client ADD COLUMN IF NOT EXISTS last_visit_at    TIMESTAMPTZ;

-- Compatibilité : si une colonne de gel existait déjà sous un autre nom, on aligne.
ALTER TABLE client ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT false;

-- 25.3 Un client est « gelé » si frozen_at est renseigné OU is_frozen = true.
--      On garde les deux synchronisés par trigger.
CREATE OR REPLACE FUNCTION fn_client_sync_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.frozen_at IS NOT NULL THEN NEW.is_frozen := true;
    ELSIF NEW.is_frozen = false THEN NEW.frozen_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_client_sync_frozen ON client;
CREATE TRIGGER trg_client_sync_frozen
    BEFORE UPDATE OF frozen_at, is_frozen ON client
    FOR EACH ROW EXECUTE FUNCTION fn_client_sync_frozen();

-- 25.4 Explications demandées à la collectrice sur les clients gelés.
--      Le superviseur DEMANDE une explication ; la collectrice RÉPOND ;
--      puis le superviseur peut DÉGELER (ou la collectrice peut demander un dégel motivé).
CREATE TABLE IF NOT EXISTS client_freeze_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,   -- auto_freeze / explanation_request / collection_explanation /
                                     -- unfreeze_request / unfreeze / refreeze
    status          TEXT NOT NULL DEFAULT 'clos',  -- ouvert / repondu / clos
    requested_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,   -- superviseur
    answered_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,   -- collectrice
    acted_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,   -- qui dégèle/refige
    reason          TEXT,            -- motif du gel / du dégel
    explanation     TEXT,            -- explication fournie par la collectrice
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at     TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_freeze_event_client ON client_freeze_event(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_freeze_event_open ON client_freeze_event(status) WHERE status <> 'clos';

-- 25.5 Visite géo-localisée : coordonnées relevées à la validation de la visite.
ALTER TABLE collection_round_visit ADD COLUMN IF NOT EXISTS visited_gps_lat   NUMERIC(9,6);
ALTER TABLE collection_round_visit ADD COLUMN IF NOT EXISTS visited_gps_lng   NUMERIC(9,6);
ALTER TABLE collection_round_visit ADD COLUMN IF NOT EXISTS visited_accuracy_m NUMERIC(7,2);
ALTER TABLE collection_round_visit ADD COLUMN IF NOT EXISTS visited_by        UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE collection_round_visit ADD COLUMN IF NOT EXISTS visit_source      TEXT;   -- programme / recherche / manuel
-- Un client visité aujourd’hui ne doit plus apparaître dans la tournée du jour :
-- on conserve l’historique (status=visited + round_date) et le filtre applicatif s’en charge.
CREATE INDEX IF NOT EXISTS idx_visit_status ON collection_round_visit(round_id, status);

-- 25.6 Journal des visites (indépendant de la tournée) : sert au compteur « sans visite ».
CREATE TABLE IF NOT EXISTS client_visit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    visit_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    gps_lat         NUMERIC(9,6),
    gps_lng         NUMERIC(9,6),
    accuracy_m      NUMERIC(7,2),
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visit_log_client ON client_visit_log(client_id, visit_date DESC);

-- 25.7 Opérations : la date d’opération est obligatoire (régularisation guichet,
--      demandes). On garantit la colonne et on marque les écritures sans date.
ALTER TABLE operation ADD COLUMN IF NOT EXISTS operation_date DATE;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES client(id) ON DELETE SET NULL;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS freeze_blocked BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_operation_date ON operation(imf_id, operation_date);

-- 25.8 Audit des nouveaux objets.
DROP TRIGGER IF EXISTS trg_audit_client_schedule ON client_schedule;
CREATE TRIGGER trg_audit_client_schedule AFTER INSERT OR UPDATE OR DELETE ON client_schedule FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_freeze_event ON client_freeze_event;
CREATE TRIGGER trg_audit_freeze_event AFTER INSERT OR UPDATE OR DELETE ON client_freeze_event FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_visit_log ON client_visit_log;
CREATE TRIGGER trg_audit_visit_log AFTER INSERT OR UPDATE OR DELETE ON client_visit_log FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- ---------------------------------------------------------------------------
-- 26. VAGUE 5 — PLAFONDS DE CAISSE, VERSEMENTS, REÇUS, SMS CLIENT, 2FA.
--     IDEMPOTENT : sans danger à relancer.
-- ---------------------------------------------------------------------------

-- 26.1 Paramètres de collecte de l'IMF (plafonds fixés par l'admin de l'IMF).
--   max_cash_cents          : montant maximum de solde de caisse de la collectrice
--                             autorisé dans la journée.
--   max_client_daily_cents  : montant maximum à collecter auprès d'UN MÊME client
--                             dans la journée.
--   sms_sender_number       : numéro de téléphone paramétré par l'admin qui envoie
--                             automatiquement un SMS au client après chaque dépôt.
--   sms_enabled             : active/désactive l'envoi des SMS clients.
--   momo_deposit_number     : compte Mobile Money de l'IMF pour les versements des
--                             collectrices (transfert des fonds).
CREATE TABLE IF NOT EXISTS imf_collection_settings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL UNIQUE REFERENCES imf(id) ON DELETE CASCADE,
    max_cash_cents          BIGINT,          -- plafond de caisse journalière (collectrice)
    max_client_daily_cents  BIGINT,          -- plafond par client sur la journée
    sms_enabled             BOOLEAN NOT NULL DEFAULT false,
    sms_sender_number       TEXT,           -- n° expéditeur paramétré par l'admin
    momo_deposit_number     TEXT,           -- n° Mobile Money IMF (versements)
    momo_provider           TEXT,           -- Orange Money / Moov / Wave…
    updated_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 26.2 Versements de la collectrice vers la caisse (caissière) ou vers le compte
--      Mobile Money de l'IMF (avec références du transfert).
CREATE TABLE IF NOT EXISTS cash_deposit (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    collectrice_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    amount_cents        BIGINT NOT NULL,
    channel             TEXT NOT NULL,        -- caisse_caissiere / mobile_money
    status              TEXT NOT NULL DEFAULT 'declare', -- declare / valide / rejete
    momo_provider       TEXT,                 -- Orange Money / Moov / Wave…
    momo_number         TEXT,                 -- numéro destinataire (IMF)
    transfer_ref        TEXT,                 -- référence de la transaction
    transfer_date       DATE,
    proof_note          TEXT,
    declared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    validated_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    validated_at        TIMESTAMPTZ,
    rejected_reason     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_deposit_collectrice ON cash_deposit(collectrice_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_deposit_imf_status ON cash_deposit(imf_id, status);

-- 26.3 Reçus simples générés automatiquement à chaque dépôt client.
--      Le code s'affiche 1 minute (ou jusqu'à fermeture par la collectrice).
CREATE TABLE IF NOT EXISTS receipt (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    operation_id    UUID REFERENCES operation(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES client(id) ON DELETE SET NULL,
    account_id      UUID REFERENCES account(id) ON DELETE SET NULL,
    collectrice_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    code_receipt    TEXT NOT NULL UNIQUE,     -- code simple affiché à la collectrice
    amount_cents    BIGINT NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'XOF',
    balance_after_cents BIGINT,
    display_seconds INTEGER NOT NULL DEFAULT 60,
    sms_sent        BOOLEAN NOT NULL DEFAULT false,
    sms_number      TEXT,
    sms_status      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_operation ON receipt(operation_id);
CREATE INDEX IF NOT EXISTS idx_receipt_client ON receipt(client_id, created_at DESC);

-- 26.4 Journal des SMS envoyés aux clients (traçabilité / réglage admin).
CREATE TABLE IF NOT EXISTS client_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES client(id) ON DELETE SET NULL,
    receipt_id      UUID REFERENCES receipt(id) ON DELETE SET NULL,
    operation_id    UUID REFERENCES operation(id) ON DELETE SET NULL,
    phone           TEXT,
    sender_number   TEXT,
    body            TEXT,
    status          TEXT NOT NULL DEFAULT 'envoye', -- envoye / echec / desactive
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_sms_client ON client_sms_log(client_id, created_at DESC);

-- 26.5 Double authentification (2FA / authenticator) pour les comptes à privilèges.
--      Secret TOTP (base32) + codes de secours hachés + état d'enrôlement.
CREATE TABLE IF NOT EXISTS user_2fa (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    secret_base32   TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT false,
    confirmed_at    TIMESTAMPTZ,
    recovery_codes  TEXT[] NOT NULL DEFAULT '{}',   -- empreintes SHA-256 des codes de secours
    last_totp_at    TIMESTAMPTZ,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 26.6 Défis 2FA en attente de validation (après mot de passe, avant session).
CREATE TABLE IF NOT EXISTS login_challenge (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    consumed        BOOLEAN NOT NULL DEFAULT false,
    attempts        INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- AUTO-RÉPARATION (correctif) : sur une base DÉJÀ déployée, login_challenge
-- pouvait exister dans une structure ANTÉRIEURE (sans la colonne token_hash).
-- « CREATE TABLE IF NOT EXISTS » n'ajoute PAS les colonnes manquantes : la
-- création de l'index sur token_hash échouait alors avec « column "token_hash"
-- does not exist » (PostgreSQL 42703). On ajoute donc chaque colonne SI absente
-- AVANT de créer l'index, pour rejouer ce fichier sans erreur sur toute base.
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS imf_id     UUID;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS consumed   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_login_challenge_hash ON login_challenge(token_hash);

-- 26.7 Rôle « caissière » (versement à la caisse de l'IMF).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                    WHERE t.typname='user_role' AND e.enumlabel='caissier') THEN
        ALTER TYPE user_role ADD VALUE 'caissier';
    END IF;
END $$;

-- 26.8 Traçabilité : le dépôt de collecte mémorise son reçu.
ALTER TABLE operation ADD COLUMN IF NOT EXISTS receipt_id UUID;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS cash_deposit_id UUID;

CREATE INDEX IF NOT EXISTS idx_operation_kind_date ON operation(imf_id, kind, operation_date);

-- 26.9 Audit des nouveaux objets.
DROP TRIGGER IF EXISTS trg_audit_imf_collection_settings ON imf_collection_settings;
CREATE TRIGGER trg_audit_imf_collection_settings AFTER INSERT OR UPDATE OR DELETE ON imf_collection_settings FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_cash_deposit ON cash_deposit;
CREATE TRIGGER trg_audit_cash_deposit AFTER INSERT OR UPDATE OR DELETE ON cash_deposit FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_receipt ON receipt;
CREATE TRIGGER trg_audit_receipt AFTER INSERT OR UPDATE OR DELETE ON receipt FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_user_2fa ON user_2fa;
CREATE TRIGGER trg_audit_user_2fa AFTER INSERT OR UPDATE OR DELETE ON user_2fa FOR EACH ROW EXECUTE FUNCTION fn_audit();


-- ===========================================================================
-- VAGUE 6 — Parcours imposé, anti-doublons, affectations superviseur,
--           relevé BCEAO, accès caissière + export Excel.
-- ===========================================================================

-- 27.1 Unicité stricte anti-doublons (clients & comptes) --------------------
ALTER TABLE client ADD COLUMN IF NOT EXISTS name_norm TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_number_norm TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS phone_norm TEXT;

UPDATE client SET name_norm = lower(regexp_replace(coalesce(full_name,''), '[[:space:]]+', ' ', 'g')),
                  id_number_norm = nullif(upper(regexp_replace(coalesce(id_number,''), '[[:space:]]+', '', 'g')), ''),
                  phone_norm = nullif(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), '')
 WHERE name_norm IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_id_number ON client(imf_id, id_number_norm)
    WHERE id_number_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_name_phone ON client(imf_id, name_norm, phone_norm)
    WHERE phone_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_one_active ON account(client_id)
    WHERE status = 'active';

-- 27.2 Parcours imposé : profil -> compte -> premier dépôt ------------------
ALTER TABLE account ADD COLUMN IF NOT EXISTS journey_step TEXT NOT NULL DEFAULT 'compte_ouvert';

-- 27.3 Journal anti-doublons -------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_check_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    entity          TEXT NOT NULL,
    matched_id      UUID,
    reason          TEXT NOT NULL,
    payload         JSONB,
    actor_id        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dup_log_imf ON duplicate_check_log(imf_id, created_at DESC);

-- 27.4 Affectation de clients à une collectrice (par le superviseur) --------
CREATE TABLE IF NOT EXISTS collectrice_assignment (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    collectrice_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL DEFAULT 'selection',
    reason          TEXT NOT NULL,
    days            INTEGER,
    starts_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    ends_on         DATE,
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assign_collectrice ON collectrice_assignment(imf_id, collectrice_user_id, status);

CREATE TABLE IF NOT EXISTS collectrice_assignment_client (
    assignment_id   UUID NOT NULL REFERENCES collectrice_assignment(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    PRIMARY KEY (assignment_id, client_id)
);

-- 27.5 Versements : approbation par la caissière + rattachement client ---
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES client(id) ON DELETE SET NULL;
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES account(id) ON DELETE SET NULL;
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS receipt_id UUID REFERENCES receipt(id) ON DELETE SET NULL;
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE cash_deposit ADD COLUMN IF NOT EXISTS approval_note TEXT;

-- 27.6 Relevé client BCEAO : trace des éditions -----------------------------
CREATE TABLE IF NOT EXISTS statement_issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES account(id) ON DELETE SET NULL,
    period_from     DATE,
    period_to       DATE,
    format          TEXT NOT NULL DEFAULT 'bceao_html',
    issued_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 27.7 Audit des nouveaux objets.
DROP TRIGGER IF EXISTS trg_audit_collectrice_assignment ON collectrice_assignment;
CREATE TRIGGER trg_audit_collectrice_assignment AFTER INSERT OR UPDATE OR DELETE ON collectrice_assignment FOR EACH ROW EXECUTE FUNCTION fn_audit();
DROP TRIGGER IF EXISTS trg_audit_statement_issue ON statement_issue;
CREATE TRIGGER trg_audit_statement_issue AFTER INSERT OR UPDATE OR DELETE ON statement_issue FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- ===========================================================================
-- VAGUE 7 — MODULE OBJECTIFS / CIBLES HIÉRARCHIQUES
--   DG / Chef d'agence  ->  Superviseurs  ->  Collectrices
--   Affectation descendante + contrôle de cohérence + agrégation temps réel.
-- Transactions DDL idempotentes (sans danger à relancer).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 28.1 Hiérarchie fonctionnelle : lien parent auto-référencé sur app_user.
--      Une collectrice dépend d'un superviseur ; un superviseur dépend d'un
--      DG / chef d'agence. ON DELETE SET NULL : supprimer un encadrant ne
--      détruit pas ses subordonnés (ils deviennent « non rattachés »).
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS parent_id UUID;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_parent'
    ) THEN
        ALTER TABLE app_user
            ADD CONSTRAINT fk_user_parent FOREIGN KEY (parent_id)
            REFERENCES app_user(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Index pour les parcours descendants (équipe d'un superviseur).
CREATE INDEX IF NOT EXISTS idx_app_user_parent ON app_user(parent_id);
CREATE INDEX IF NOT EXISTS idx_app_user_imf_role ON app_user(imf_id, role);

-- ---------------------------------------------------------------------------
-- 28.2 Rôles hiérarchiques du module Objectifs.
--      Le socle utilise un ENUM user_role (admin_imf, direction, …). On ajoute
--      les trois rôles métier du module sans casser l'existant :
--        'dg'          -> Directeur Général / Chef d'agence
--        'supervisor'  -> Superviseur
--        'collectrice' -> Collectrice terrain
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                    WHERE t.typname='user_role' AND e.enumlabel='dg') THEN
        ALTER TYPE user_role ADD VALUE 'dg';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                    WHERE t.typname='user_role' AND e.enumlabel='supervisor') THEN
        ALTER TYPE user_role ADD VALUE 'supervisor';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                    WHERE t.typname='user_role' AND e.enumlabel='collectrice') THEN
        ALTER TYPE user_role ADD VALUE 'collectrice';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 28.3 Types énumérés du module Objectifs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kpi_type') THEN
        CREATE TYPE kpi_type AS ENUM (
            'COLLECTION_VOLUME',   -- volume de collecte (FCFA)
            'NEW_ACCOUNTS',        -- nouveaux comptes ouverts (nombre)
            'RETENTION_RATE'       -- taux de rétention (%)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'objective_status') THEN
        CREATE TYPE objective_status AS ENUM (
            'PENDING', 'IN_PROGRESS', 'ACHIEVED', 'FAILED'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'objective_period') THEN
        CREATE TYPE objective_period AS ENUM ('DAILY', 'MONTHLY', 'QUARTERLY', 'YEARLY');
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 28.4 Table objective : une cible assignée par un encadrant à un subordonné.
--      • self-ref « parent_objective_id » : la cible globale d'un superviseur
--        peut être reliée à la cible « enveloppe » du DG (traçabilité du cascade).
--      • target_value / current_realized_value en NUMERIC(18,2) : précision
--        monétaire FCFA sans arrondi flottant binaire.
--      • Corbeille de cohérence : CHECK (target_value >= 0), périodes valides.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objective (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    assigned_to_user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    assigned_by_user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    parent_objective_id   UUID REFERENCES objective(id) ON DELETE SET NULL,
    title                 TEXT,
    kpi_type              kpi_type NOT NULL,
    period                objective_period NOT NULL DEFAULT 'MONTHLY',
    target_value          NUMERIC(18,2) NOT NULL,
    current_realized_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    unit                  TEXT,                       -- affichage : FCFA / comptes / %
    start_date            DATE NOT NULL,
    end_date              DATE NOT NULL,
    status                objective_status NOT NULL DEFAULT 'PENDING',
    achieved_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_objective_target_nonneg CHECK (target_value >= 0),
    CONSTRAINT chk_objective_realized_nonneg CHECK (current_realized_value >= 0),
    CONSTRAINT chk_objective_period_order CHECK (end_date >= start_date),
    -- Une même cible (même agent, même KPI, même période) ne doit pas être
    -- dupliquée : garde-fou d'intégrité fonctionnelle.
    CONSTRAINT uq_objective_scope
        UNIQUE (imf_id, assigned_to_user_id, kpi_type, period, start_date)
);

-- Recherche des cibles d'un agent / d'une équipe / par statut.
CREATE INDEX IF NOT EXISTS idx_objective_assignee   ON objective(assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_objective_assigner   ON objective(assigned_by_user_id);
CREATE INDEX IF NOT EXISTS idx_objective_imf_period ON objective(imf_id, period, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_objective_kpi        ON objective(imf_id, kpi_type);

-- ---------------------------------------------------------------------------
-- 28.5 Journal des réalisations : chaque incrément (dépôt, compte ouvert…)
--      laisse une trace auditable. Idempotence via (source_table, source_id)
--      pour ne jamais compter deux fois la même opération métier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objective_progress_event (
    id                 BIGSERIAL PRIMARY KEY,
    imf_id             UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    objective_id       UUID NOT NULL REFERENCES objective(id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kpi_type           kpi_type NOT NULL,
    delta_value        NUMERIC(18,2) NOT NULL,
    source_table       TEXT,           -- 'operation' | 'account' | …
    source_id          UUID,           -- id de l'opération source (anti double comptage)
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotence : un même fait métier ne peut alimenter qu'une fois une cible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_progress_event_source
    ON objective_progress_event(objective_id, source_table, source_id)
    WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_progress_event_obj ON objective_progress_event(objective_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 28.6 Statut automatique : la cible bascule IN_PROGRESS / ACHIEVED / FAILED
--      à chaque mise à jour du réalisé (trigger pour garantir la cohérence
--      quel que soit le chemin d'écriture : API, roll-up, job de clôture).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_objective_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Une cible sans taux ne peut pas 'rater' : si dépassée et en cours de
    -- période, elle reste IN_PROGRESS jusqu'à la date de fin.
    IF NEW.current_realized_value >= NEW.target_value AND NEW.target_value > 0 THEN
        NEW.status := 'ACHIEVED';
        IF NEW.achieved_at IS NULL THEN NEW.achieved_at := now(); END IF;
    ELSIF NEW.current_realized_value > 0 THEN
        NEW.status := 'IN_PROGRESS';
        NEW.achieved_at := NULL;
    ELSE
        NEW.achieved_at := NULL;
        -- PENDING avant/pendant la période ; FAILED une fois la période close.
        IF CURRENT_DATE > NEW.end_date THEN
            NEW.status := 'FAILED';
        ELSE
            NEW.status := 'PENDING';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_objective_status ON objective;
CREATE TRIGGER trg_objective_status
    BEFORE INSERT OR UPDATE ON objective
    FOR EACH ROW EXECUTE FUNCTION fn_objective_status();

-- ---------------------------------------------------------------------------
-- 28.7 Audit : on réutilise fn_audit() du socle.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_objective ON objective;
CREATE TRIGGER trg_audit_objective
    AFTER INSERT OR UPDATE OR DELETE ON objective
    FOR EACH ROW EXECUTE FUNCTION fn_audit();

DROP TRIGGER IF EXISTS trg_audit_objective_progress ON objective_progress_event;
CREATE TRIGGER trg_audit_objective_progress
    AFTER INSERT OR DELETE ON objective_progress_event
    FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- ---------------------------------------------------------------------------
-- 28.8 Notifications automatiques d'objectif (VAGUE 7 — extension)
--      Journal des alertes émises lorsqu'une cible franchit un palier
--      (50 %, 80 %, 100 % atteint) ou bascule en échec.
--      Idempotence : un même (objective, palier) n'est émis qu'une fois.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objective_notification (
    id            BIGSERIAL PRIMARY KEY,
    imf_id        UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    objective_id  UUID NOT NULL REFERENCES objective(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    event         TEXT NOT NULL,          -- 'half' | 'near' | 'achieved' | 'failed'
    threshold     NUMERIC(5,2),           -- palier franchi (0-100)
    channel       TEXT NOT NULL,          -- 'whatsapp' | 'email' | 'inapp'
    status        TEXT NOT NULL DEFAULT 'queued', -- 'sent' | 'dev' | 'failed'
    payload       JSONB,                  -- message + contexte
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un franchissement de palier n'est notifié qu'une seule fois par cible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_objective_notification_event
    ON objective_notification(objective_id, event);

CREATE INDEX IF NOT EXISTS idx_objective_notification_user
    ON objective_notification(user_id, created_at DESC);

COMMIT;
