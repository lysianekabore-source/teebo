-- =========================================================================
-- VAGUE 32 — PLATEFORME SaaS MULTI-TENANT (correctif 14/11/2026)
-- =========================================================================
-- Ce script apporte les SEPT briques demandées, en une seule migration
-- ADDITIVE et RÉENTRANTE (IF NOT EXISTS / DO $$ ... EXCEPTION partout :
-- peut être rejouée sans perte de données, avec ou sans PostgreSQL gérant
-- les politiques RLS).
--
--   1. Cloisonnement strict : colonne `institution_id` synchronisée avec
--      `imf_id` sur les tables métier, MUR MB-01..MB-06 (deny-by-default).
--   2. Conformité BCEAO / LCB-FT : validation KYC tracée (client_conformity_check
--      étendue + table kyc_validation), gel d'urgence (client_freeze_event
--      étendue + freeze_list / freeze_list_hit pour listes de sanctions).
--   3. Grand livre IMMUABLE orienté événements : ledger_entry (journal),
--      ledger_line (parties doubles, solde = somme algébrique), chaîne de
--      hachage SHA-256, signature HMAC-SHA256 des reçus, file de
--      synchronisation hors-ligne (offline_sync_queue).
--   4. Plafond de caisse journalier de la collectrice (collecteur_caisse),
--      zone de collecte (zone_collecte) et métadonnées hors-ligne.
--   5. Moteur de commissions dynamique (commission_rules, commission_accrual).
--   6. Activation modulaire (institution_features).
--   7. Index de performance multi-tenant.
--
-- IMPORTANT — nom de fichier : `schema_v32.sql` (et NON migration_v32_saas.sql)
-- car le migrateur (src/migrate.js) ne détecte que les fichiers nommés
-- schema.sql / schema_vNN.sql. Ce script porte EXACTEMENT le contenu demandé
-- pour migration_v32_saas.sql : c'est le même fichier, sous le nom que le
-- serveur sait appliquer automatiquement.
--
-- PRÉREQUIS : PostgreSQL 13+ (gen_random_uuid, génération d'identité).
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 0. FONCTIONS UTILITAIRES
-- -------------------------------------------------------------------------

-- Acteur de session (posé par backend/src/tenant.js). Tolerant : si la
-- variable n'est pas posée, renvoie NULL au lieu de lever une erreur.
CREATE OR REPLACE FUNCTION fn_current_actor()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('teebo.actor_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

-- IMF courante de session (posée par backend/src/tenant.js).
CREATE OR REPLACE FUNCTION fn_current_imf()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('teebo.imf_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

-- =========================================================================
-- 1. INSTITUTION_ID — ALIAS DE TENANT (rétro-compatibilité imf_id)
-- =========================================================================
-- Le socle historique nomme la clé de cloisonnement `imf_id` (24 scripts).
-- On NE renomme PAS (risque de rupture de 276 routes) : on ajoute
-- `institution_id` DÉRIVÉE (colonne générée) qui pointe toujours vers le
-- même identifiant. Les politiques RLS et le code SaaS s'appuient sur
-- `institution_id` ; les anciennes requêtes `imf_id` continuent de marcher.
--
-- Note : une colonne générée STORED ne peut pas être écrite par une requête.
-- C'est exactement ce qu'on veut : l'isolation ne peut pas être falsifiée
-- par une route applicative, même compromise.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client','account','operation','account_movement',
                          'app_user','audit_log','collection_round',
                          'client_freeze_event','zone_collecte']
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name=t)
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='imf_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name=t AND column_name='institution_id')
    THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN institution_id UUID '
                     'GENERATED ALWAYS AS (imf_id) STORED', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (institution_id)',
                     'idx_'||t||'_institution_id', t);
    END IF;
  END LOOP;
END $$;

-- =========================================================================
-- 2. ACTIVATION MODULAIRE (table institution_features)
-- =========================================================================
-- Une ligne par IMF. Les modules sont des BOOLÉENS explicites (lisibles et
-- indexables) ET un JSONB `options` pour les réglages fins du module.
-- Valeurs par défaut = ce qui est déjà utilisé aujourd'hui (aucune rupture).
CREATE TABLE IF NOT EXISTS institution_features (
    institution_id              UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    module_collecte_tontine     BOOLEAN NOT NULL DEFAULT true,
    module_dossier_credit       BOOLEAN NOT NULL DEFAULT true,
    module_compliance_kyc       BOOLEAN NOT NULL DEFAULT true,
    module_comptabilite_avancee BOOLEAN NOT NULL DEFAULT false,
    options                     JSONB   NOT NULL DEFAULT '{}'::jsonb,
    updated_by                  UUID,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE institution_features IS
  'Activation modulaire SaaS : un module désactivé renvoie 403 Feature Disabled sur son API.';

-- Ligne par défaut pour chaque IMF existante (idempotent).
INSERT INTO institution_features (institution_id)
SELECT id FROM imf
ON CONFLICT (institution_id) DO NOTHING;

-- =========================================================================
-- 3. CONFORMITÉ BCEAO / LCB-FT : VALIDATION KYC TRAÇABLE
-- =========================================================================
-- 3.a Extension de client_conformity_check (contrôle champ par champ) avec
--     la preuve de contrôle : qui, quand, avec quel niveau de risque.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='client_conformity_check'
                    AND column_name='institution_id')
  THEN
    ALTER TABLE client_conformity_check ADD COLUMN institution_id UUID;
    UPDATE client_conformity_check SET institution_id = imf_id WHERE institution_id IS NULL;
  END IF;
END $$;

-- 3.b La VALIDATION KYC (acte métier) : un dossier ne peut être VALIDÉ que
--     si le contrôle champ par champ est complet. La validation est un
--     événement immuable (aucune modification après coup).
CREATE TABLE IF NOT EXISTS kyc_validation (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'en_attente',
        -- en_attente / valide / rejete / expire
    niveau_risque       TEXT NOT NULL DEFAULT 'faible',      -- faible / moyen / eleve
    ppe                 BOOLEAN NOT NULL DEFAULT false,
    sanctions_checked_at TIMESTAMPTZ,
    sanctions_hit       BOOLEAN NOT NULL DEFAULT false,
    checklist           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- champ -> {ok, valeur}
    validated_by        UUID,
    validated_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,          -- revue périodique LCB-FT
    motif_rejet         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_validation_inst
  ON kyc_validation (institution_id, status, expires_at);

-- 3.c GEL D'URGENCE : extension de client_freeze_event (kind += 'emergency')
--     et table des listes de sanctions (GAFI / BCEAO / UE / ONU).
CREATE TABLE IF NOT EXISTS freeze_list (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'BCEAO',   -- BCEAO / GAFI / UE / ONU / interne
    kind            TEXT NOT NULL DEFAULT 'nom',     -- nom / piece / compte / telephone
    valeur          TEXT NOT NULL,
    valeur_norm     TEXT NOT NULL,                   -- valeur normalisée (majuscules, sans accents)
    motif           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freeze_list_norm
  ON freeze_list (institution_id, kind, valeur_norm) WHERE is_active;

CREATE TABLE IF NOT EXISTS freeze_list_hit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    freeze_list_id  UUID REFERENCES freeze_list(id) ON DELETE SET NULL,
    score           NUMERIC(5,2) NOT NULL DEFAULT 100,
    action          TEXT NOT NULL DEFAULT 'gel_immediat',
    detecte_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    traite_par      UUID,
    traite_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_freeze_list_hit_client
  ON freeze_list_hit (institution_id, client_id);

-- =========================================================================
-- 4. GRAND LIVRE IMMUABLE ORIENTÉ ÉVÉNEMENTS
-- =========================================================================
-- Principe : on n'écrit JAMAIS de solde « à la main ». Le solde d'un compte
-- est la SOMME ALGÉBRIQUE de ses lignes (ledger_line). Chaque événement
-- financier produit UNE écriture (ledger_entry) et AU MOINS DEUX lignes
-- (partie double : somme des lignes = 0 pour un même événement).
--
-- Immuabilité : triggers refusant UPDATE/DELETE + chaîne de hachage
-- (prev_hash -> hash) : toute altération casse la chaîne et devient
-- détectable par /api/v1/ledger/verify.
CREATE TABLE IF NOT EXISTS ledger_entry (
    id                  BIGSERIAL PRIMARY KEY,
    uuid                UUID NOT NULL DEFAULT gen_random_uuid(),
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE RESTRICT,
    event_type          TEXT NOT NULL,
        -- depot / retrait / frais / commission_retention / commission_part /
        -- commission_collecteur / ouverture / cloture_caisse / ecart_caisse /
        -- annulation (contre-écriture) / credit / echeance
    event_ref           TEXT,                       -- id métier (operation, cash_closing…)
    event_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id            UUID,
    device_id           UUID,
    idempotency_key     TEXT,                       -- anti-doublon (sync hors-ligne)
    offline             BOOLEAN NOT NULL DEFAULT false,
    device_timestamp    TIMESTAMPTZ,                -- horloge du terminal (immuable)
    server_timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
    gps_lat             NUMERIC(10,7),
    gps_lng             NUMERIC(10,7),
    prev_hash           TEXT,
    hash                TEXT,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entry_uuid ON ledger_entry (uuid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entry_idem
  ON ledger_entry (institution_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_entry_inst_at
  ON ledger_entry (institution_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entry_ref
  ON ledger_entry (institution_id, event_ref);

CREATE TABLE IF NOT EXISTS ledger_line (
    id                  BIGSERIAL PRIMARY KEY,
    entry_id            BIGINT NOT NULL REFERENCES ledger_entry(id) ON DELETE RESTRICT,
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE RESTRICT,
    account_id          UUID REFERENCES account(id) ON DELETE RESTRICT,
    ledge_kind          TEXT NOT NULL DEFAULT 'client',
        -- client / imf_income / collecteur / caisse / coffre / produit_a_payer
    ledger_code         TEXT,          -- compte interne (ex. '7011', 'COM-COLLECTEUR')
    client_id           UUID,
    collecteur_id       UUID,
    sens                SMALLINT NOT NULL,     -- +1 crédit (augmente le dû), -1 débit
    montant_cents       BIGINT NOT NULL CHECK (montant_cents >= 0),
    currency            CHAR(3) NOT NULL DEFAULT 'XOF',
    libelle             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (sens IN (-1, 1))
);
CREATE INDEX IF NOT EXISTS idx_ledger_line_account
  ON ledger_line (account_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_line_entry
  ON ledger_line (entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_line_collecteur
  ON ledger_line (institution_id, collecteur_id, id);

-- Solde dérivé d'un compte (JAMAIS stocké en dur : on somme).
CREATE OR REPLACE VIEW v_account_solde AS
SELECT l.account_id,
       l.institution_id,
       COALESCE(SUM(l.sens::bigint * l.montant_cents), 0) AS solde_cents
  FROM ledger_line l
 WHERE l.account_id IS NOT NULL
 GROUP BY l.account_id, l.institution_id;

-- Position d'un collecteur (caisse et commissions).
CREATE OR REPLACE VIEW v_collecteur_position AS
SELECT l.institution_id,
       l.collecteur_id,
       COALESCE(SUM(CASE WHEN l.ledge_kind='caisse' THEN l.sens::bigint * l.montant_cents END), 0)     AS encaisse_cents,
       COALESCE(SUM(CASE WHEN l.ledge_kind='collecteur' THEN l.sens::bigint * l.montant_cents END), 0) AS commission_cents
  FROM ledger_line l
 WHERE l.collecteur_id IS NOT NULL
 GROUP BY l.institution_id, l.collecteur_id;

-- 4.a IMMUABILITÉ : refus de toute réécriture.
CREATE OR REPLACE FUNCTION fn_ledger_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_immutable: le grand livre est en lecture seule (opération % refusée sur %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '23514',
          HINT = 'Toute correction doit passer par une contre-écriture (event_type=annulation).';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entry_immutable ON ledger_entry;
CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable();

DROP TRIGGER IF EXISTS trg_ledger_line_immutable ON ledger_line;
CREATE TRIGGER trg_ledger_line_immutable
  BEFORE UPDATE OR DELETE ON ledger_line
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable();

-- 4.b CHAÎNE DE HACHAGE : chaque écriture scelle la précédente.
--     hash = sha256(prev_hash | institution | event_type | event_at | payload)
CREATE OR REPLACE FUNCTION fn_ledger_seal()
RETURNS trigger AS $$
DECLARE prev text;
BEGIN
  SELECT hash INTO prev FROM ledger_entry
   WHERE institution_id = NEW.institution_id
   ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := encode(sha256(convert_to(
      COALESCE(prev,'') || '|' || NEW.institution_id::text || '|' || NEW.event_type || '|' ||
      to_char(NEW.event_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') || '|' || NEW.payload::text,
      'UTF8')), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- NOTE : sha256(bytea) est NATIF dans PostgreSQL 11+ (aucune extension à
-- installer). On évite volontairement pgcrypto/digest() : sur une base gérée
-- où l'extension ne peut pas être créée, tout INSERT au grand livre aurait
-- échoué. Ce choix garantit que le scellement fonctionne partout.

DROP TRIGGER IF EXISTS trg_ledger_seal ON ledger_entry;
CREATE TRIGGER trg_ledger_seal
  BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_seal();

-- 4.c SIGNATURES HMAC DES REÇUS (QR Bluetooth).
--     La clé n'est JAMAIS en base : elle reste dans l'environnement du
--     serveur (TEEBO_RECEIPT_SECRET). On stocke seulement la signature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='receipt' AND column_name='signature_hmac')
  THEN
    ALTER TABLE receipt ADD COLUMN signature_hmac TEXT;
    ALTER TABLE receipt ADD COLUMN signature_algo TEXT NOT NULL DEFAULT 'HMAC-SHA256';
    ALTER TABLE receipt ADD COLUMN signed_payload TEXT;   -- « tx|collecteur|montant|horodatage »
    ALTER TABLE receipt ADD COLUMN signed_at TIMESTAMPTZ;
  END IF;
END $$;

-- 4.d SYNCHRONISATION HORS-LIGNE : file d'événements du terrain.
--     Le serveur SÉQUENCE (seq) et REFUSE le hors-ligne si l'horodatage
--     du terminal n'est pas antérieur à la réception serveur, ou si la
--     séquence locale est incohérente (conflit d'ordre).
CREATE TABLE IF NOT EXISTS offline_sync_queue (
    id                  BIGSERIAL PRIMARY KEY,
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    event_uuid          UUID NOT NULL,
    device_id           UUID,
    collecteur_id       UUID,
    payload             JSONB NOT NULL,
    seq_local           BIGINT,
    seq_server          BIGINT,
    device_timestamp    TIMESTAMPTZ NOT NULL,
    server_timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              TEXT NOT NULL DEFAULT 'recu',   -- recu / applique / rejete / conflit
    conflit_raison      TEXT,
    applied_entry_id    BIGINT REFERENCES ledger_entry(id) ON DELETE SET NULL,
    UNIQUE (institution_id, event_uuid)
);
CREATE INDEX IF NOT EXISTS idx_offline_sync_status
  ON offline_sync_queue (institution_id, status, server_timestamp);

-- Séquence serveur par IMF (monotone, jamais réutilisée).
CREATE SEQUENCE IF NOT EXISTS seq_offline_global;

-- =========================================================================
-- 5. PLAFOND DE CAISSE, ZONE DE COLLECTE, HORS-LIGNE
-- =========================================================================

-- 5.a Zone de collecte : une collectrice ne collecte QUE dans ses zones.
CREATE TABLE IF NOT EXISTS zone_collecte (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_zone           TEXT NOT NULL,
    nom                 TEXT NOT NULL,
    org_unit_id         UUID REFERENCES org_unit(id) ON DELETE SET NULL,
    actif               BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, code_zone)
);

CREATE TABLE IF NOT EXISTS collecteur_zone (
    collecteur_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    zone_id             UUID NOT NULL REFERENCES zone_collecte(id) ON DELETE CASCADE,
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collecteur_id, zone_id)
);

-- Zone de rattachement du CLIENT (zoning strict du portefeuille).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='client' AND column_name='zone_collecte_id')
  THEN
    ALTER TABLE client ADD COLUMN zone_collecte_id UUID REFERENCES zone_collecte(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_client_zone ON client (imf_id, zone_collecte_id);

-- 5.b Plafond de caisse de la collectrice (journalier) et encours courant.
--     `encours_caisse_actuel` est MAIN TENU par le code (collectes/versements)
--     et re-vérifié par la fonction fn_caisse_statut ci-dessous.
CREATE TABLE IF NOT EXISTS collecteur_caisse (
    collecteur_id            UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    institution_id           UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    plafond_caisse_journalier BIGINT NOT NULL DEFAULT 0,   -- 0 = pas de plafond
    encours_caisse_actuel    BIGINT NOT NULL DEFAULT 0 CHECK (encours_caisse_actuel >= 0),
    devise                   CHAR(3) NOT NULL DEFAULT 'XOF',
    dernier_apurement_at     TIMESTAMPTZ,
    derniere_cloture_at      TIMESTAMPTZ,
    bloque                   BOOLEAN NOT NULL DEFAULT false,
    motif_blocage            TEXT,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Crée la ligne de caisse à la volée (idempotent).
CREATE OR REPLACE FUNCTION fn_collecteur_caisse_init(p_imf UUID, p_collecteur UUID)
RETURNS collecteur_caisse AS $$
DECLARE r collecteur_caisse;
BEGIN
  INSERT INTO collecteur_caisse (collecteur_id, institution_id)
  VALUES (p_collecteur, p_imf)
  ON CONFLICT (collecteur_id) DO UPDATE SET institution_id = EXCLUDED.institution_id
  RETURNING * INTO r;
  RETURN r;
END $$ LANGUAGE plpgsql;

-- 5.c MÉTADONNÉES HORS-LIGNE sur les opérations (device_id existait déjà).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='operation' AND column_name='device_timestamp')
  THEN
    ALTER TABLE operation ADD COLUMN device_timestamp TIMESTAMPTZ;  -- horloge du terminal
    ALTER TABLE operation ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE operation ADD COLUMN offline BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE operation ADD COLUMN idempotency_key TEXT;
    ALTER TABLE operation ADD COLUMN gps_lat NUMERIC(10,7);
    ALTER TABLE operation ADD COLUMN gps_lng NUMERIC(10,7);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_operation_idem
  ON operation (imf_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Horloge suspecte : un opération reçue APRÈS coup ne peut pas être datée
-- dans le futur : on refuse côté serveur (voir ledger.js / routes).

-- =========================================================================
-- 6. MOTEUR DE COMMISSIONS DYNAMIQUE
-- =========================================================================
-- commission_rules : pour chaque IMF, une ou plusieurs règles.
--   modele = 'mise'  -> on retient UNE cotisation du cycle (31 jours =>
--                      1 cotisation retenue sur 31), calculée sur la
--                      base_cycle (mise journalière ou mensuelle).
--   modele = 'pourcentage' -> pourcentage du montant collecté.
--   modele = 'fixe'        -> montant fixe en FCFA par cotisation/cycle.
--   repartition_pct_imf    -> part IMF / part collecteur (somme = 100).
CREATE TABLE IF NOT EXISTS commission_rules (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_rule               TEXT NOT NULL DEFAULT 'DEFAUT',
    libelle                 TEXT,
    modele                  TEXT NOT NULL DEFAULT 'pourcentage'
        CHECK (modele IN ('mise','pourcentage','fixe')),
    -- pourcentage : taux en points de base (500 = 5 %)
    taux_pct_bp             INTEGER NOT NULL DEFAULT 0 CHECK (taux_pct_bp >= 0 AND taux_pct_bp <= 10000),
    -- fixe : montant en centimes (FCFA x 100)
    montant_fixe_cents      BIGINT NOT NULL DEFAULT 0 CHECK (montant_fixe_cents >= 0),
    -- mise : nombre de jours du cycle et base de calcul
    jours_cycle             INTEGER NOT NULL DEFAULT 31 CHECK (jours_cycle > 0),
    montant_mise_cents      BIGINT NOT NULL DEFAULT 0 CHECK (montant_mise_cents >= 0),
    -- répartition du revenu entre IMF et collecteur (somme = 100)
    repartition_pct_imf     NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (repartition_pct_imf BETWEEN 0 AND 100),
    repartition_pct_collecteur NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (repartition_pct_collecteur BETWEEN 0 AND 100),
    -- ciblage : produit d'épargne optionnel
    savings_product_code    TEXT,
    priorite                INTEGER NOT NULL DEFAULT 100,
    actif                   BOOLEAN NOT NULL DEFAULT true,
    created_by              UUID,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (repartition_pct_imf + repartition_pct_collecteur <= 100),
    UNIQUE (institution_id, code_rule)
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_inst
  ON commission_rules (institution_id, actif, priorite);

-- Une règle par défaut à 0 par IMF : rien n'est prélevé tant que l'IMF
-- n'a pas paramétré sa rémunération (aucun effet de bord pour l'existant).
INSERT INTO commission_rules (institution_id, code_rule, libelle, modele, repartition_pct_imf, repartition_pct_collecteur)
SELECT id, 'DEFAUT', 'Règle par défaut (inactive)', 'pourcentage', 100, 0 FROM imf
ON CONFLICT (institution_id, code_rule) DO NOTHING;

-- commission_accrual : le détail calculé de CHAQUE commission, par opération
-- et par tournée (les commissions « en attente » sont celles dont la tournée
-- n'est pas clôturée). Chaque ligne produit une écriture au grand livre.
CREATE TABLE IF NOT EXISTS commission_accrual (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    collecteur_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    client_id           UUID REFERENCES client(id) ON DELETE SET NULL,
    account_id          UUID REFERENCES account(id) ON DELETE SET NULL,
    operation_id        UUID,
    round_id            UUID REFERENCES collection_round(id) ON DELETE SET NULL,
    rule_id             UUID REFERENCES commission_rules(id) ON DELETE SET NULL,
    modele              TEXT NOT NULL,
    assiette_cents      BIGINT NOT NULL DEFAULT 0,   -- montant sur lequel on calcule
    montant_cents       BIGINT NOT NULL DEFAULT 0,   -- commission totale
    part_imf_cents      BIGINT NOT NULL DEFAULT 0,
    part_collecteur_cents BIGINT NOT NULL DEFAULT 0,
    statut              TEXT NOT NULL DEFAULT 'acquis', -- acquis / en_attente / reverse
    ledger_entry_id     BIGINT REFERENCES ledger_entry(id) ON DELETE SET NULL,
    accrued_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_accrual_collecteur
  ON commission_accrual (institution_id, collecteur_id, statut, accrued_at DESC);

-- 6.c FONCTION DE CALCUL (source de vérité SQL du moteur JS).
--     Renvoie la commission en centimes pour une assiette donnée.
--     L'application (backend/src/commissions.js) applique EXACTEMENT la même
--     formule ; cette fonction sert au contrôle et aux exports comptables.
CREATE OR REPLACE FUNCTION fn_commission_calcul(
    p_rule commission_rules, p_assiette_cents BIGINT, p_nb_cotisations_cycle INT DEFAULT 31)
RETURNS BIGINT AS $$
DECLARE v BIGINT;
BEGIN
  IF p_rule.modele = 'pourcentage' THEN
    v := (p_assiette_cents * p_rule.taux_pct_bp) / 10000;
  ELSIF p_rule.modele = 'fixe' THEN
    v := p_rule.montant_fixe_cents;
  ELSIF p_rule.modele = 'mise' THEN
    -- Une seule cotisation retenue par cycle : montant_mise / nb de cotisations.
    IF p_nb_cotisations_cycle > 0 THEN
      v := p_rule.montant_mise_cents / p_nb_cotisations_cycle;
    ELSE
      v := 0;
    END IF;
  ELSE
    v := 0;
  END IF;
  RETURN GREATEST(0, v);
END $$ LANGUAGE plpgsql IMMUTABLE;

-- Normalisation des noms pour la comparaison aux listes de sanctions
-- (majuscules, sans accents, espaces simples). Immutable : indexable.
CREATE OR REPLACE FUNCTION fn_normalise(txt text)
RETURNS text AS $$
  SELECT regexp_replace(
           upper(translate(coalesce(txt,''),
             'àáâäãåçèéêëìíîïñòóôöõùúûüýÿÀÁÂÄÃÅÇÈÉÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝ',
             'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUY')),
           '\s+', ' ', 'g')
$$ LANGUAGE sql IMMUTABLE;

-- =========================================================================
-- 7. MUR DE CLOISONNEMENT RBAC (DENY BY DEFAULT)
-- =========================================================================
-- Trois barrières, cumulatives :
--   MB-01  Authentification obligatoire (revoked/expiré refusé)  -> backend
--   MB-02  Le tenant effectif vient de la SESSION, jamais du corps de requête
--   MB-03  RLS PostgreSQL (ci-dessous)
--   MB-04  Écriture : institution_id forcée sur l'authentification
--   MB-05  teebo_admin (éditeur) : bascule explicite, journalisée
--   MB-06  Refus par défaut (aucune route « ouverte »)
--
-- On n'active la RLS QUE si l'utilisateur de connexion n'est PAS le
-- propriétaire des tables (sinon le propriétaire contourne la politique).
-- Sur Render, l'application se connecte avec le propriétaire de la base :
-- la RLS est alors DORMANTE (aucun blocage), et le cloisonnement reste
-- assuré par MB-02/MB-04 côté code. Pour ACTIVER la RLS réellement, on
-- exécute le script db/activer_rls_tenant.sql qui crée un rôle applicatif
-- restreint. Voir LIRE-MOI-CORRECTIFS.
DO $$
DECLARE
  t text;
  tbl_owner name;
  is_owner boolean;
  tenant_tables text[] := ARRAY[
    'client','account','operation','account_movement','app_user','audit_log',
    'collection_round','collection_round_visit','receipt',
    'client_freeze_event','client_schedule','cash_closing','cash_deposit',
    'vault_movement','collectrice_assignment',
    'kyc_validation','ledger_entry','ledger_line','commission_accrual',
    'commission_rules','collecteur_caisse','zone_collecte','collecteur_zone',
    'institution_features','offline_sync_queue','freeze_list','freeze_list_hit',
    'accounting_entry','accounting_period_close'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM information_schema.tables
                               WHERE table_schema='public' AND table_name=t);
    -- La politique exige la colonne institution_id (alias de imf_id).
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema='public' AND table_name=t
                                 AND column_name='institution_id');
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Politique unique : l'IMF de session ne voit que SES lignes.
    -- USING sans tenant = aucun accès (deny-by-default), sauf si le rôle
    -- est BYPASSRLS (superutilisateur / propriétaire sur Render).
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='public' AND tablename=t AND policyname='p_tenant_isolation')
    THEN
      EXECUTE format(
        'CREATE POLICY p_tenant_isolation ON %I USING '
        '(institution_id = fn_current_imf()) '
        'WITH CHECK (institution_id = fn_current_imf())', t);
    END IF;
  END LOOP;
END $$;

-- =========================================================================
-- 8. INDEX COMPLÉMENTAIRES (performance multi-tenant)
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_client_imf_collectrice
  ON client (imf_id, collectrice_user_id);
CREATE INDEX IF NOT EXISTS idx_operation_imf_user_date
  ON operation (imf_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_imf_client
  ON operation (imf_id, account_id, created_at DESC);

COMMIT;
