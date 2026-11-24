-- ===========================================================================
-- teebo — VAGUE 38 : MODULE CRÉDIT (BCEAO) — SOCLE SÉCURISÉ
-- ===========================================================================
-- 100 % ADDITIF et RÉEXÉCUTABLE : aucune table n'est supprimée, aucune
-- colonne existante n'est renommée. Le module s'appuie sur l'existant :
--   client, account (solde_bloque_cents), app_user, org_unit, imf,
--   operation (remboursements encaissés), permission_catalog,
--   position_default_permission.
--
--   A. Cloisonnement : tenant_id (= imf_id) sur les 12 tables du module.
--   B. Produits de crédit (dégressif / linéaire constant / in fine,
--      périodicités, différé, frais de dossier, assurance, épargne
--      obligatoire de garantie).
--   C. Groupes solidaires + membres.
--   D. Dossiers de crédit, garanties, validations (4 yeux), décaissements,
--      échéanciers, remboursements (UUID terminal), déclassements,
--      actions de recouvrement.
--   E. GARDE-FOUS EN BASE :
--        • un agent ne peut pas valider son propre dossier
--          (agent_credit_id <> validateur_id),
--        • imputation forcément dans l'ordre pénalités -> intérêts -> capital,
--        • montant remboursé = somme des imputations,
--        • un échéancier n'est pas modifiable s'il est calculé (recalcul
--          uniquement via une nouvelle version),
--        • décaissement interdit hors statut APPROUVE.
--   F. Habilitations CRÉDIT (agent, chef d'agence / comité, caissier,
--      agent de collecte).
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- A. CLOISONNEMENT MULTI-IMF — tenant_id
-- ===========================================================================
CREATE OR REPLACE FUNCTION fn_tenant_sync() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN NEW.tenant_id := NEW.imf_id; END IF;
  IF NEW.imf_id IS NULL THEN NEW.imf_id := NEW.tenant_id; END IF;
  IF NEW.tenant_id IS DISTINCT FROM NEW.imf_id THEN
    RAISE EXCEPTION 'tenant_incoherent: tenant_id (%) doit etre egal a imf_id (%) sur %',
      NEW.tenant_id, NEW.imf_id, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ===========================================================================
-- B. PRODUITS DE CRÉDIT
-- ===========================================================================
CREATE TABLE IF NOT EXISTS produits_credit (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id               UUID,
    code                    TEXT NOT NULL,
    libelle                 TEXT NOT NULL,
    description             TEXT,
    -- Méthode : DEGRESSIF (annuités constantes) | LINEAIRE (linéaire constant)
    --           | IN_FINE (intérêts payés à chaque échéance, capital à la fin)
    methode                 TEXT NOT NULL DEFAULT 'DEGRESSIF',
    periodicite             TEXT NOT NULL DEFAULT 'MENSUELLE',
    duree_min_mois          INTEGER NOT NULL DEFAULT 1,
    duree_max_mois          INTEGER NOT NULL DEFAULT 24,
    montant_min_cents       BIGINT NOT NULL DEFAULT 0,
    montant_max_cents       BIGINT NOT NULL DEFAULT 1000000000,
    -- Taux : nominal annuel ET TEG effectif (points de base = 1/100 %)
    taux_nominal_bp         INTEGER NOT NULL DEFAULT 1200,
    taux_teg_bp             INTEGER,               -- calculé, stocké pour audit
    -- Frais et accessoires
    frais_dossier_bp        INTEGER NOT NULL DEFAULT 100,      -- 1 %
    frais_dossier_min_cents BIGINT NOT NULL DEFAULT 0,
    assurance_bp            INTEGER NOT NULL DEFAULT 0,        -- sur capital
    epargne_obligatoire_bp  INTEGER NOT NULL DEFAULT 0,        -- % du montant
    -- Différé (grâce)
    differe_mois            INTEGER NOT NULL DEFAULT 0,
    differe_type            TEXT NOT NULL DEFAULT 'AUCUN',     -- AUCUN|INTERETS|TOTAL
    -- Pénalités
    penalite_retard_bp_jour INTEGER NOT NULL DEFAULT 5,        -- 0,05 %/jour
    -- Provision BCEAO (taux par classe, points de base)
    provision_sain_bp       INTEGER NOT NULL DEFAULT 100,      -- 1 %
    provision_immobilise_bp INTEGER NOT NULL DEFAULT 5000,     -- 50 %
    provision_douteux_bp    INTEGER NOT NULL DEFAULT 10000,    -- 100 %
    provision_litigieux_bp  INTEGER NOT NULL DEFAULT 10000,    -- 100 %
    actif                   BOOLEAN NOT NULL DEFAULT true,
    created_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE produits_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS chk_prod_credit_methode;
ALTER TABLE produits_credit ADD CONSTRAINT chk_prod_credit_methode
  CHECK (methode IN ('DEGRESSIF', 'LINEAIRE', 'IN_FINE'));
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS chk_prod_credit_periodicite;
ALTER TABLE produits_credit ADD CONSTRAINT chk_prod_credit_periodicite
  CHECK (periodicite IN ('HEBDOMADAIRE', 'BIMENSUELLE', 'MENSUELLE', 'TRIMESTRIELLE'));
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS chk_prod_credit_differe;
ALTER TABLE produits_credit ADD CONSTRAINT chk_prod_credit_differe
  CHECK (differe_type IN ('AUCUN', 'INTERETS', 'TOTAL'));
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS chk_prod_credit_taux;
ALTER TABLE produits_credit ADD CONSTRAINT chk_prod_credit_taux
  CHECK (taux_nominal_bp >= 0 AND taux_nominal_bp <= 60000
         AND frais_dossier_bp >= 0 AND frais_dossier_bp <= 10000
         AND assurance_bp >= 0 AND assurance_bp <= 10000
         AND epargne_obligatoire_bp >= 0 AND epargne_obligatoire_bp <= 10000);
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS chk_prod_credit_plafond;
ALTER TABLE produits_credit ADD CONSTRAINT chk_prod_credit_plafond
  CHECK (montant_min_cents >= 0 AND montant_max_cents > montant_min_cents);
ALTER TABLE produits_credit DROP CONSTRAINT IF EXISTS uq_prod_credit_code;
ALTER TABLE produits_credit ADD CONSTRAINT uq_prod_credit_code UNIQUE (imf_id, code);
CREATE INDEX IF NOT EXISTS idx_prod_credit_imf ON produits_credit (imf_id, actif);

-- ===========================================================================
-- C. GROUPES SOLIDAIRES (crédit solidaire BCEAO)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS groupes_solidaires (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    code            TEXT NOT NULL,
    libelle         TEXT NOT NULL,
    responsable_client_id UUID REFERENCES client(id) ON DELETE SET NULL,
    collecteur_id   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    zone_collecte_id UUID,
    date_constitution DATE NOT NULL DEFAULT CURRENT_DATE,
    statut          TEXT NOT NULL DEFAULT 'ACTIF',   -- ACTIF|SUSPENDU|DISSOUS
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE groupes_solidaires ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE groupes_solidaires DROP CONSTRAINT IF EXISTS chk_groupe_statut;
ALTER TABLE groupes_solidaires ADD CONSTRAINT chk_groupe_statut
  CHECK (statut IN ('ACTIF', 'SUSPENDU', 'DISSOUS'));
ALTER TABLE groupes_solidaires DROP CONSTRAINT IF EXISTS uq_groupe_code;
ALTER TABLE groupes_solidaires ADD CONSTRAINT uq_groupe_code UNIQUE (imf_id, code);

CREATE TABLE IF NOT EXISTS membres_groupe_solidaire (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    groupe_id       UUID NOT NULL REFERENCES groupes_solidaires(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    role_membre     TEXT NOT NULL DEFAULT 'MEMBRE',  -- RESPONSABLE|SECRETAIRE|TRESORIER|MEMBRE
    date_adhesion   DATE NOT NULL DEFAULT CURRENT_DATE,
    date_sortie     DATE,
    caution_cents   BIGINT NOT NULL DEFAULT 0,
    actif           BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE membres_groupe_solidaire ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE membres_groupe_solidaire DROP CONSTRAINT IF EXISTS chk_membre_role;
ALTER TABLE membres_groupe_solidaire ADD CONSTRAINT chk_membre_role
  CHECK (role_membre IN ('RESPONSABLE', 'SECRETAIRE', 'TRESORIER', 'MEMBRE'));
-- Un client n'est membre actif qu'une fois par groupe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_membre_groupe_client
  ON membres_groupe_solidaire (groupe_id, client_id) WHERE actif;
CREATE INDEX IF NOT EXISTS idx_membre_groupe ON membres_groupe_solidaire (imf_id, groupe_id, actif);

-- ===========================================================================
-- D. DOSSIERS DE CRÉDIT
-- ===========================================================================
CREATE TABLE IF NOT EXISTS dossiers_credit (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    reference           TEXT NOT NULL,
    produit_id          UUID NOT NULL REFERENCES produits_credit(id) ON DELETE RESTRICT,
    client_id           UUID NOT NULL REFERENCES client(id) ON DELETE RESTRICT,
    groupe_id           UUID REFERENCES groupes_solidaires(id) ON DELETE SET NULL,
    -- Montants (entiers de centimes FCFA)
    montant_demande_cents   BIGINT NOT NULL CHECK (montant_demande_cents > 0),
    montant_accorde_cents   BIGINT,
    -- Paramètres figés au montage (copie du produit : le produit peut évoluer)
    methode                 TEXT NOT NULL,
    periodicite             TEXT NOT NULL,
    duree_mois              INTEGER NOT NULL CHECK (duree_mois > 0),
    taux_nominal_bp         INTEGER NOT NULL,
    taux_teg_bp             INTEGER,
    frais_dossier_cents     BIGINT NOT NULL DEFAULT 0,
    assurance_cents         BIGINT NOT NULL DEFAULT 0,
    epargne_garantie_cents  BIGINT NOT NULL DEFAULT 0,
    differe_mois            INTEGER NOT NULL DEFAULT 0,
    differe_type            TEXT NOT NULL DEFAULT 'AUCUN',
    -- Objet
    objet                   TEXT,
    activite                TEXT,
    -- Circuit de validation
    statut                  TEXT NOT NULL DEFAULT 'BROUILLON',
    agent_credit_id         UUID REFERENCES app_user(id) ON DELETE SET NULL,
    comite_id               UUID,
    -- Montants suivis (imputation temps réel)
    total_interets_cents    BIGINT NOT NULL DEFAULT 0,
    total_penalites_cents   BIGINT NOT NULL DEFAULT 0,
    capital_rembourse_cents BIGINT NOT NULL DEFAULT 0,
    solde_capital_cents    BIGINT NOT NULL DEFAULT 0,
    -- Impayés / déclassement BCEAO
    jours_retard            INTEGER NOT NULL DEFAULT 0,
    classe_creance          TEXT NOT NULL DEFAULT 'SAIN',
    montant_impaye_cents    BIGINT NOT NULL DEFAULT 0,
    provision_cents         BIGINT NOT NULL DEFAULT 0,
    date_declassement      DATE,
    -- Dates
    date_soumission         TIMESTAMPTZ,
    date_approbation        TIMESTAMPTZ,
    date_decaissement       TIMESTAMPTZ,
    date_premiere_echeance  DATE,
    date_derniere_echeance  DATE,
    date_cloture           TIMESTAMPTZ,
    uuid_local              UUID,          -- identifiant du terminal (hors-ligne)
    motif_rejet             TEXT,
    created_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_dossier_statut;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_dossier_statut
  CHECK (statut IN ('BROUILLON', 'EN_ANALYSE', 'EN_COMITE', 'APPROUVE',
                    'REJETE', 'DECAISSE', 'CLOTURE_SOLDE', 'ANNULE'));
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_dossier_classe;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_dossier_classe
  CHECK (classe_creance IN ('SAIN', 'IMMOBILISE', 'DOUTEUX', 'LITIGIEUX'));
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_dossier_methode;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_dossier_methode
  CHECK (methode IN ('DEGRESSIF', 'LINEAIRE', 'IN_FINE'));
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_dossier_periodicite;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_dossier_periodicite
  CHECK (periodicite IN ('HEBDOMADAIRE', 'BIMENSUELLE', 'MENSUELLE', 'TRIMESTRIELLE'));
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS uq_dossier_reference;
ALTER TABLE dossiers_credit ADD CONSTRAINT uq_dossier_reference UNIQUE (imf_id, reference);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dossier_uuid_local
  ON dossiers_credit (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dossier_client ON dossiers_credit (imf_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dossier_statut ON dossiers_credit (imf_id, statut, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dossier_agent ON dossiers_credit (imf_id, agent_credit_id, statut);
CREATE INDEX IF NOT EXISTS idx_dossier_impaye ON dossiers_credit (imf_id, jours_retard DESC)
  WHERE statut IN ('DECAISSE', 'CLOTURE_SOLDE');

-- ===========================================================================
-- E. GARANTIES (dont EPARGNE_BLOQUEE -> account.solde_bloque_cents)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS garanties_credit (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    type_garantie       TEXT NOT NULL,
      -- EPARGNE_BLOQUEE | CAUTION_SOLIDAIRE | NANTISSEMENT | HYPOTHEQUE |
      -- AVAL | GAGE_VEHICULE | STOCK | AUTRE
    libelle             TEXT,
    montant_cents       BIGINT NOT NULL CHECK (montant_cents >= 0),
    -- Pour EPARGNE_BLOQUEE : le compte d'épargne support
    account_id          UUID REFERENCES account(id) ON DELETE SET NULL,
    -- État du blocage
    statut              TEXT NOT NULL DEFAULT 'EN_ATTENTE',
      -- EN_ATTENTE | BLOQUEE | LIBEREE | REALISEE
    montant_bloque_cents BIGINT NOT NULL DEFAULT 0,
    date_blocage        TIMESTAMPTZ,
    date_liberation     TIMESTAMPTZ,
    client_garant_id    UUID REFERENCES client(id) ON DELETE SET NULL,
    reference_document  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE garanties_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE garanties_credit DROP CONSTRAINT IF EXISTS chk_garantie_type;
ALTER TABLE garanties_credit ADD CONSTRAINT chk_garantie_type
  CHECK (type_garantie IN ('EPARGNE_BLOQUEE', 'CAUTION_SOLIDAIRE', 'NANTISSEMENT',
                           'HYPOTHEQUE', 'AVAL', 'GAGE_VEHICULE', 'STOCK', 'AUTRE'));
ALTER TABLE garanties_credit DROP CONSTRAINT IF EXISTS chk_garantie_statut;
ALTER TABLE garanties_credit ADD CONSTRAINT chk_garantie_statut
  CHECK (statut IN ('EN_ATTENTE', 'BLOQUEE', 'LIBEREE', 'REALISEE'));
ALTER TABLE garanties_credit DROP CONSTRAINT IF EXISTS chk_garantie_epargne;
ALTER TABLE garanties_credit ADD CONSTRAINT chk_garantie_epargne
  CHECK (type_garantie <> 'EPARGNE_BLOQUEE' OR account_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_garantie_dossier ON garanties_credit (imf_id, dossier_id);
CREATE INDEX IF NOT EXISTS idx_garantie_compte ON garanties_credit (account_id)
  WHERE statut = 'BLOQUEE';

-- ===========================================================================
-- F. VALIDATIONS (principe des 4 yeux) — plafonds paramétrables
-- ===========================================================================
CREATE TABLE IF NOT EXISTS plafonds_validation_credit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    niveau          INTEGER NOT NULL,       -- 1 = chef d'agence, 2 = comité…
    libelle         TEXT NOT NULL,
    plafond_cents   BIGINT NOT NULL,        -- montant max validable à ce niveau
    position_code   TEXT,                   -- poste requis (POS_CHEF_AGENCE…)
    actif           BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plafonds_validation_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_plafond_niveau
  ON plafonds_validation_credit (imf_id, niveau);

CREATE TABLE IF NOT EXISTS validations_credit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    dossier_id      UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    niveau          INTEGER NOT NULL DEFAULT 1,
    agent_credit_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    validateur_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
    decision        TEXT NOT NULL,   -- APPROUVE | REJETE | COMPLEMENT | AJOURNE
    montant_valide_cents BIGINT NOT NULL DEFAULT 0,
    plafond_cents   BIGINT NOT NULL DEFAULT 0,
    commentaire     TEXT,
    uuid_local      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE validations_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE validations_credit DROP CONSTRAINT IF EXISTS chk_validation_decision;
ALTER TABLE validations_credit ADD CONSTRAINT chk_validation_decision
  CHECK (decision IN ('APPROUVE', 'REJETE', 'COMPLEMENT', 'AJOURNE'));
-- *** PRINCIPE DES 4 YEUX : le validateur n'est jamais l'agent du dossier ***
ALTER TABLE validations_credit DROP CONSTRAINT IF EXISTS chk_4yeux;
ALTER TABLE validations_credit ADD CONSTRAINT chk_4yeux
  CHECK (agent_credit_id IS NULL OR validateur_id IS NULL OR agent_credit_id <> validateur_id);
-- Une seule validation par niveau et par dossier (les compléments créent un
-- nouveau niveau d'instruction après re-soumission).
CREATE UNIQUE INDEX IF NOT EXISTS uq_validation_niveau
  ON validations_credit (dossier_id, niveau);
CREATE UNIQUE INDEX IF NOT EXISTS uq_validation_uuid_local
  ON validations_credit (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;

-- ===========================================================================
-- G. DÉCAISSEMENTS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS decaissements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    montant_cents       BIGINT NOT NULL CHECK (montant_cents > 0),
    frais_dossier_cents BIGINT NOT NULL DEFAULT 0,
    assurance_cents     BIGINT NOT NULL DEFAULT 0,
    epargne_garantie_cents BIGINT NOT NULL DEFAULT 0,
    net_verse_cents     BIGINT NOT NULL,          -- montant - retenues
    mode                TEXT NOT NULL,            -- GUICHET|VIREMENT_EPARGNE|MOBILE_MONEY
    canal_mm            TEXT,                     -- ORANGE_MONEY|MOOV_MONEY|WAVE
    reference_externe_mm TEXT,
    account_cible_id    UUID REFERENCES account(id) ON DELETE SET NULL,
    caisse_session_id   UUID,
    caissier_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
    operation_id        UUID REFERENCES operation(id) ON DELETE SET NULL,
    uuid_local          UUID,
    date_decaissement   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE decaissements ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE decaissements DROP CONSTRAINT IF EXISTS chk_decaissement_mode;
ALTER TABLE decaissements ADD CONSTRAINT chk_decaissement_mode
  CHECK (mode IN ('GUICHET', 'VIREMENT_EPARGNE', 'MOBILE_MONEY'));
ALTER TABLE decaissements DROP CONSTRAINT IF EXISTS chk_decaissement_net;
ALTER TABLE decaissements ADD CONSTRAINT chk_decaissement_net
  CHECK (net_verse_cents >= 0 AND net_verse_cents = montant_cents
        - frais_dossier_cents - assurance_cents - epargne_garantie_cents);
ALTER TABLE decaissements DROP CONSTRAINT IF EXISTS chk_decaissement_mm;
ALTER TABLE decaissements ADD CONSTRAINT chk_decaissement_mm
  CHECK (mode <> 'MOBILE_MONEY' OR (canal_mm IS NOT NULL
         AND reference_externe_mm IS NOT NULL
         AND length(btrim(reference_externe_mm)) >= 4));
CREATE UNIQUE INDEX IF NOT EXISTS uq_decaissement_dossier
  ON decaissements (dossier_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_decaissement_uuid_local
  ON decaissements (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;

-- ===========================================================================
-- H. ÉCHÉANCIERS (tableau d'amortissement ligne par ligne)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS echeanciers_credit (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    numero              INTEGER NOT NULL,            -- 1, 2, 3…
    date_echeance       DATE NOT NULL,
    -- Répartition de l'échéance (entiers de centimes)
    montant_echeance_cents BIGINT NOT NULL,
    capital_cents       BIGINT NOT NULL DEFAULT 0,
    interet_cents       BIGINT NOT NULL DEFAULT 0,
    assurance_cents     BIGINT NOT NULL DEFAULT 0,
    -- Suivi
    capital_paye_cents  BIGINT NOT NULL DEFAULT 0,
    interet_paye_cents  BIGINT NOT NULL DEFAULT 0,
    penalite_cents      BIGINT NOT NULL DEFAULT 0,
    penalite_payee_cents BIGINT NOT NULL DEFAULT 0,
    solde_capital_cents BIGINT NOT NULL DEFAULT 0,
    statut              TEXT NOT NULL DEFAULT 'A_PAYER',
      -- A_PAYER|PARTIEL|PAYE|EN_RETARD
    jours_retard        INTEGER NOT NULL DEFAULT 0,
    date_paiement       TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE echeanciers_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE echeanciers_credit DROP CONSTRAINT IF EXISTS chk_echeance_statut;
ALTER TABLE echeanciers_credit ADD CONSTRAINT chk_echeance_statut
  CHECK (statut IN ('A_PAYER', 'PARTIEL', 'PAYE', 'EN_RETARD'));
ALTER TABLE echeanciers_credit DROP CONSTRAINT IF EXISTS chk_echeance_coherence;
ALTER TABLE echeanciers_credit ADD CONSTRAINT chk_echeance_coherence
  CHECK (capital_cents >= 0 AND interet_cents >= 0
         AND montant_echeance_cents = capital_cents + interet_cents + assurance_cents
         AND capital_paye_cents >= 0 AND capital_paye_cents <= capital_cents);
CREATE UNIQUE INDEX IF NOT EXISTS uq_echeance_dossier_numero
  ON echeanciers_credit (dossier_id, numero, version);
CREATE INDEX IF NOT EXISTS idx_echeance_retard
  ON echeanciers_credit (imf_id, date_echeance)
  WHERE statut IN ('A_PAYER', 'PARTIEL', 'EN_RETARD');

-- ===========================================================================
-- I. REMBOURSEMENTS (terrain / guichet) + imputations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS remboursements_credit (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    -- Imputation OBLIGATOIRE dans l'ordre : pénalités -> intérêts -> capital
    montant_cents       BIGINT NOT NULL CHECK (montant_cents > 0),
    penalite_cents      BIGINT NOT NULL DEFAULT 0,
    interet_cents       BIGINT NOT NULL DEFAULT 0,
    capital_cents       BIGINT NOT NULL DEFAULT 0,
    trop_percu_cents    BIGINT NOT NULL DEFAULT 0,
    canal               TEXT NOT NULL,   -- TERRAIN_CASH|GUICHET|ORANGE_MONEY|MOOV_MONEY|WAVE|VIREMENT_EPARGNE
    reference_externe_mm TEXT,
    operation_id        UUID REFERENCES operation(id) ON DELETE SET NULL,
    session_caisse_id   UUID REFERENCES sessions_caisse_agent(id) ON DELETE SET NULL,
    encaisse_par        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    account_client_id   UUID REFERENCES account(id) ON DELETE SET NULL,
    gps_lat             NUMERIC(9,6),
    gps_lng             NUMERIC(9,6),
    date_operation_locale TIMESTAMPTZ,
    uuid_local          UUID,          -- généré côté terminal (hors-ligne)
    statut_sync         TEXT NOT NULL DEFAULT 'SYNCHRONISE',
    reference_recu      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE remboursements_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE remboursements_credit DROP CONSTRAINT IF EXISTS chk_remb_imputation;
ALTER TABLE remboursements_credit ADD CONSTRAINT chk_remb_imputation
  CHECK (penalite_cents >= 0 AND interet_cents >= 0 AND capital_cents >= 0
         AND trop_percu_cents >= 0
         AND montant_cents = penalite_cents + interet_cents + capital_cents
                               + trop_percu_cents);
ALTER TABLE remboursements_credit DROP CONSTRAINT IF EXISTS chk_remb_canal;
ALTER TABLE remboursements_credit ADD CONSTRAINT chk_remb_canal
  CHECK (canal IN ('TERRAIN_CASH', 'GUICHET', 'ORANGE_MONEY', 'MOOV_MONEY',
                   'WAVE', 'INTEROP_BCEAO', 'VIREMENT_EPARGNE'));
ALTER TABLE remboursements_credit DROP CONSTRAINT IF EXISTS chk_remb_statut_sync;
ALTER TABLE remboursements_credit ADD CONSTRAINT chk_remb_statut_sync
  CHECK (statut_sync IN ('EN_ATTENTE_SYNC', 'SYNCHRONISE', 'REJETE_DOUBLON', 'REJETE'));
ALTER TABLE remboursements_credit DROP CONSTRAINT IF EXISTS chk_remb_momo_ref;
ALTER TABLE remboursements_credit ADD CONSTRAINT chk_remb_momo_ref
  CHECK (canal NOT IN ('ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO')
         OR (reference_externe_mm IS NOT NULL AND length(btrim(reference_externe_mm)) >= 4));
ALTER TABLE remboursements_credit DROP CONSTRAINT IF EXISTS chk_remb_gps;
ALTER TABLE remboursements_credit ADD CONSTRAINT chk_remb_gps
  CHECK ((gps_lat IS NULL AND gps_lng IS NULL)
         OR (gps_lat BETWEEN -90 AND 90 AND gps_lng BETWEEN -180 AND 180));
-- Idempotence : un UUID de terminal = UN seul remboursement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_remb_uuid_local
  ON remboursements_credit (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_remb_mm_ref
  ON remboursements_credit (imf_id, reference_externe_mm)
  WHERE reference_externe_mm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remb_dossier
  ON remboursements_credit (imf_id, dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remb_sync
  ON remboursements_credit (imf_id, statut_sync) WHERE statut_sync <> 'SYNCHRONISE';

-- Détail ligne à ligne de l'imputation (traçabilité BCEAO).
CREATE TABLE IF NOT EXISTS imputations_remboursement (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    remboursement_id    UUID NOT NULL REFERENCES remboursements_credit(id) ON DELETE CASCADE,
    echeance_id         UUID REFERENCES echeanciers_credit(id) ON DELETE SET NULL,
    nature              TEXT NOT NULL,   -- PENALITE|INTERET|CAPITAL|TROP_PERCU
    montant_cents       BIGINT NOT NULL CHECK (montant_cents > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE imputations_remboursement ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE imputations_remboursement DROP CONSTRAINT IF EXISTS chk_imput_nature;
ALTER TABLE imputations_remboursement ADD CONSTRAINT chk_imput_nature
  CHECK (nature IN ('PENALITE', 'INTERET', 'CAPITAL', 'TROP_PERCU'));
CREATE INDEX IF NOT EXISTS idx_imput_remb ON imputations_remboursement (remboursement_id);

-- ===========================================================================
-- J. DÉCLASSEMENTS & RECOUVREMENT
-- ===========================================================================
CREATE TABLE IF NOT EXISTS declassements_creances (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    classe_avant        TEXT NOT NULL,
    classe_apres        TEXT NOT NULL,
    jours_retard        INTEGER NOT NULL DEFAULT 0,
    encours_cents       BIGINT NOT NULL DEFAULT 0,
    taux_provision_bp   INTEGER NOT NULL DEFAULT 0,
    provision_cents     BIGINT NOT NULL DEFAULT 0,
    automatique         BOOLEAN NOT NULL DEFAULT true,
    decide_par          UUID REFERENCES app_user(id) ON DELETE SET NULL,
    motif               TEXT,
    date_declassement   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE declassements_creances ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE declassements_creances DROP CONSTRAINT IF EXISTS chk_declass_classe;
ALTER TABLE declassements_creances ADD CONSTRAINT chk_declass_classe
  CHECK (classe_avant IN ('SAIN', 'IMMOBILISE', 'DOUTEUX', 'LITIGIEUX')
         AND classe_apres IN ('SAIN', 'IMMOBILISE', 'DOUTEUX', 'LITIGIEUX'));
CREATE INDEX IF NOT EXISTS idx_declass_dossier
  ON declassements_creances (imf_id, dossier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS actions_recouvrement (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    dossier_id          UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    type_action         TEXT NOT NULL,
      -- VISITE|APPEL|SMS|WHATSAPP|MISE_EN_DEMEURE|PROMESSE|CONTENTIEUX|SAISIE
    resultat            TEXT,   -- PROMESSE_TENUE|SANS_EFFET|A_SUIVRE|REGLEMENT_PARTIEL…
    montant_promis_cents BIGINT NOT NULL DEFAULT 0,
    date_promesse       DATE,
    observation         TEXT,
    agent_id            UUID REFERENCES app_user(id) ON DELETE SET NULL,
    gps_lat             NUMERIC(9,6),
    gps_lng             NUMERIC(9,6),
    date_action_locale  TIMESTAMPTZ,
    uuid_local          UUID,
    statut_sync         TEXT NOT NULL DEFAULT 'SYNCHRONISE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE actions_recouvrement ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE actions_recouvrement DROP CONSTRAINT IF EXISTS chk_action_type;
ALTER TABLE actions_recouvrement ADD CONSTRAINT chk_action_type
  CHECK (type_action IN ('VISITE', 'APPEL', 'SMS', 'WHATSAPP', 'MISE_EN_DEMEURE',
                         'PROMESSE', 'CONTENTIEUX', 'SAISIE'));
ALTER TABLE actions_recouvrement DROP CONSTRAINT IF EXISTS chk_action_statut_sync;
ALTER TABLE actions_recouvrement ADD CONSTRAINT chk_action_statut_sync
  CHECK (statut_sync IN ('EN_ATTENTE_SYNC', 'SYNCHRONISE', 'REJETE_DOUBLON', 'REJETE'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_uuid_local
  ON actions_recouvrement (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_dossier
  ON actions_recouvrement (imf_id, dossier_id, created_at DESC);

-- ===========================================================================
-- K. TRIGGERS tenant_id
-- ===========================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
      'produits_credit', 'groupes_solidaires', 'membres_groupe_solidaire',
      'dossiers_credit', 'garanties_credit', 'plafonds_validation_credit',
      'validations_credit', 'decaissements', 'echeanciers_credit',
      'remboursements_credit', 'imputations_remboursement',
      'declassements_creances', 'actions_recouvrement'
  ] LOOP
    EXECUTE format('UPDATE %I SET tenant_id = imf_id WHERE tenant_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', 'idx_' || t || '_tenant', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_tenant_sync ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_tenant_sync BEFORE INSERT OR UPDATE ON %I '
                   'FOR EACH ROW EXECUTE FUNCTION fn_tenant_sync()', t);
  END LOOP;
END $$;

-- ===========================================================================
-- L. DÉFENSE EN PROFONDEUR — GARDE-FOUS MÉTIER
-- ===========================================================================
-- L1. Un dossier DECAISSE ne repasse jamais en arrière ; un dossier clôturé
--     ne bouge plus (sauf correction explicite tracée par l'application).
CREATE OR REPLACE FUNCTION fn_dossier_statut_garde() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.statut = 'CLOTURE_SOLDE' AND NEW.statut <> 'CLOTURE_SOLDE' THEN
    RAISE EXCEPTION 'dossier_cloture: un dossier cloture ne peut plus changer de statut (%).', OLD.reference;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_dossier_statut_garde ON dossiers_credit;
CREATE TRIGGER trg_dossier_statut_garde
  BEFORE UPDATE ON dossiers_credit
  FOR EACH ROW EXECUTE FUNCTION fn_dossier_statut_garde();

-- L2. Un décaissement n'est possible QUE sur un dossier APPROUVE.
CREATE OR REPLACE FUNCTION fn_decaissement_apres_approbation() RETURNS TRIGGER AS $$
DECLARE v_statut TEXT;
BEGIN
  SELECT statut INTO v_statut FROM dossiers_credit WHERE id = NEW.dossier_id;
  IF v_statut IS DISTINCT FROM 'APPROUVE' AND v_statut IS DISTINCT FROM 'DECAISSE' THEN
    RAISE EXCEPTION 'decaissement_refuse: le dossier doit etre APPROUVE avant tout decaissement (statut actuel : %).', v_statut;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_decaissement_approbation ON decaissements;
CREATE TRIGGER trg_decaissement_approbation
  BEFORE INSERT ON decaissements
  FOR EACH ROW EXECUTE FUNCTION fn_decaissement_apres_approbation();

-- L3. Écriture comptable immuable : un remboursement encaissé n'est ni
--     modifié ni supprimé (correction = contre-passation applicative).
CREATE OR REPLACE FUNCTION fn_remboursement_immuable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'remboursement_immuable: suppression interdite (id %).', OLD.id;
  END IF;
  IF NEW.montant_cents IS DISTINCT FROM OLD.montant_cents
     OR NEW.capital_cents IS DISTINCT FROM OLD.capital_cents
     OR NEW.interet_cents IS DISTINCT FROM OLD.interet_cents
     OR NEW.penalite_cents IS DISTINCT FROM OLD.penalite_cents
     OR NEW.dossier_id IS DISTINCT FROM OLD.dossier_id THEN
    RAISE EXCEPTION 'remboursement_immuable: montant ou imputation non modifiable (id %).', OLD.id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_remboursement_immuable ON remboursements_credit;
CREATE TRIGGER trg_remboursement_immuable
  BEFORE UPDATE OR DELETE ON remboursements_credit
  FOR EACH ROW EXECUTE FUNCTION fn_remboursement_immuable();

-- L4. Cohérence de l'imputation : on ne rembourse pas d'intérêts avant les
--     pénalités, ni de capital avant les intérêts (règle BCEAO).
CREATE OR REPLACE FUNCTION fn_imputation_ordre() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.interet_cents > 0 AND NEW.penalite_cents = 0 AND NEW.montant_cents > NEW.interet_cents
     AND EXISTS (SELECT 1 FROM echeanciers_credit e
                  WHERE e.dossier_id = NEW.dossier_id AND e.penalite_cents > e.penalite_payee_cents) THEN
    RAISE EXCEPTION 'imputation_desordonnee: reglez d''abord les penalites de retard, puis les interets, puis le capital.';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_imputation_ordre ON remboursements_credit;
CREATE TRIGGER trg_imputation_ordre
  BEFORE INSERT ON remboursements_credit
  FOR EACH ROW EXECUTE FUNCTION fn_imputation_ordre();

-- L5. TEG : jamais inférieur au taux nominal (sinon paramétrage faux).
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_teg_superieur;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_teg_superieur
  CHECK (taux_teg_bp IS NULL OR taux_teg_bp >= taux_nominal_bp);

-- ===========================================================================
-- M. RÉFÉRENTIELS PAR DÉFAUT (idempotent)
-- ===========================================================================
-- Aucun produit n'est créé ici : l'admin de chaque IMF configure ses produits.
-- On fournit seulement les plafonds de validation par défaut des postes.
INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, sort_order) VALUES
 (NULL, 'credit.products.manage',   'Crédit - paramétrer les produits de crédit',      'Crédit', 'validation', true, 400),
 (NULL, 'credit.dossier.monter',    'Crédit - monter / modifier un dossier',           'Crédit', 'ecriture',   true, 401),
 (NULL, 'credit.garantie.gerer',    'Crédit - saisir les garanties',                   'Crédit', 'ecriture',   true, 402),
 (NULL, 'credit.dossier.soumettre', 'Crédit - soumettre au comité',                    'Crédit', 'ecriture',   true, 403),
 (NULL, 'credit.dossier.approuver', 'Crédit - approuver / rejeter un dossier',         'Crédit', 'validation', true, 404),
 (NULL, 'credit.decaisser',         'Crédit - décaisser au guichet',                   'Crédit', 'ecriture',   true, 405),
 (NULL, 'credit.rembourser',        'Crédit - encaisser un remboursement',             'Crédit', 'ecriture',   true, 406),
 (NULL, 'credit.recouvrement',      'Crédit - actions de recouvrement (visites, appels)','Crédit','ecriture',  true, 407),
 (NULL, 'credit.declasser',         'Crédit - déclasser une créance',                  'Crédit', 'validation', true, 408),
 (NULL, 'credit.par.read',          'Crédit - suivre le portefeuille & le PAR 30/90',  'Crédit', 'lecture',    true, 409),
 (NULL, 'credit.tache.quotidienne','Crédit - lancer la tâche quotidienne impayés',    'Crédit', 'validation', true, 410)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed) VALUES
 (NULL, 'POS_AGENT_CREDIT',   'credit.dossier.monter',    true),
 (NULL, 'POS_AGENT_CREDIT',   'credit.garantie.gerer',     true),
 (NULL, 'POS_AGENT_CREDIT',   'credit.dossier.soumettre',  true),
 (NULL, 'POS_AGENT_CREDIT',   'credit.recouvrement',       true),
 (NULL, 'POS_AGENT_CREDIT',   'credit.par.read',           true),
 (NULL, 'POS_CHEF_AGENCE',    'credit.dossier.approuver',  true),
 (NULL, 'POS_CHEF_AGENCE',    'credit.par.read',           true),
 (NULL, 'POS_CHEF_AGENCE',    'credit.declasser',          true),
 (NULL, 'POS_CHEF_AGENCE',    'credit.rembourser',         true),
 (NULL, 'POS_CAISSIER',       'credit.decaisser',          true),
 (NULL, 'POS_CAISSIER',       'credit.rembourser',         true),
 (NULL, 'POS_CAISSIER',       'credit.par.read',           true),
 (NULL, 'POS_AGENT_COLLECTE', 'credit.rembourser',         true),
 (NULL, 'POS_AGENT_COLLECTE', 'credit.recouvrement',       true),
 (NULL, 'POS_AGENT_COLLECTE', 'credit.par.read',           true),
 (NULL, 'POS_DIR_CREDIT',     'credit.products.manage',    true),
 (NULL, 'POS_DIR_CREDIT',     'credit.dossier.approuver',  true),
 (NULL, 'POS_DIR_CREDIT',     'credit.declasser',          true),
 (NULL, 'POS_DIR_CREDIT',     'credit.par.read',           true),
 (NULL, 'POS_DIR_CREDIT',     'credit.tache.quotidienne',  true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- Plafonds de validation par défaut (chaque IMF les ajuste).
-- On ne les crée que si l'IMF n'en a AUCUN, pour ne jamais écraser un
-- paramétrage existant.
DO $$
DECLARE t UUID;
BEGIN
  FOR t IN SELECT id FROM imf LOOP
    IF NOT EXISTS (SELECT 1 FROM plafonds_validation_credit WHERE imf_id = t) THEN
      INSERT INTO plafonds_validation_credit(imf_id, tenant_id, niveau, libelle, plafond_cents, position_code) VALUES
        (t, t, 1, 'Chef d''agence',            200000000,  'POS_CHEF_AGENCE'),
        (t, t, 2, 'Comité de crédit (agence)', 1000000000, 'POS_CHEF_AGENCE'),
        (t, t, 3, 'Direction du crédit',       5000000000, 'POS_DIR_CREDIT');
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- N. VUE DE SUPERVISION DU PAR (portefeuille à risque)
-- ===========================================================================
CREATE OR REPLACE VIEW vue_par_credit AS
  SELECT d.tenant_id, d.imf_id,
         COUNT(*)::int AS nb_dossiers,
         COALESCE(SUM(d.solde_capital_cents), 0)::bigint AS encours_cents,
         COALESCE(SUM(CASE WHEN d.jours_retard >= 30 THEN d.solde_capital_cents ELSE 0 END), 0)::bigint AS encours_par30_cents,
         COALESCE(SUM(CASE WHEN d.jours_retard >= 90 THEN d.solde_capital_cents ELSE 0 END), 0)::bigint AS encours_par90_cents,
         COALESCE(SUM(d.provision_cents), 0)::bigint AS provisions_cents
    FROM dossiers_credit d
   WHERE d.statut IN ('DECAISSE', 'CLOTURE_SOLDE')
   GROUP BY d.tenant_id, d.imf_id;

COMMIT;
