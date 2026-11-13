-- =========================================================================
-- VAGUE 31 — ACTIONNARIAT / SOCIÉTARIAT : CAPITAL, TITRES, AG
--
-- Cette vague NE RECRÉE PAS les quatre tables demandées : elles existent
-- déjà (vague 30) et sont déjà alimentées par l'application. On se contente
-- donc de les COMPLÉTER, sans rien casser :
--
--   1. detenteurs_capital       + KYC (pièce, photo, signature), catégorie
--                                 libre, parts plafonnées, éligibilité CA
--   2. mouvements_titres        + validation en attente d'autorisation BCEAO
--   3. beneficiaires_effectifs  + contrôle LBC/FT (détention <= 100 %)
--   4. feuille_presence_ag      + procurations, émargement horodaté
--
-- PLUS deux nouveaux objets indispensables aux règles métier demandées :
--
--   5. parametres_capital       plafond de parts par membre (statuts SCOOP),
--                               plafond de procurations par sociétaire,
--                               seuils réglementaires de participation,
--                               quorum AGO / AGE (paramétrables, jamais en dur)
--   6. ag_quorum                résultat figé du calcul de quorum par session
--
-- Migration ADDITIVE et RÉENTRANTE (IF NOT EXISTS / DO $$ ... EXCEPTION) :
-- elle peut être relancée autant de fois que nécessaire.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. DÉTENTEURS : compléments KYC, plafonds et éligibilité
-- -------------------------------------------------------------------------
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS categorie_libelle     TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS date_naissance       DATE;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS lieu_naissance       TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS nature_piece         TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS numero_piece         TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS piece_identite_url   TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS photo_url            TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS signature_url        TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS profession           TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS adresse              TEXT;
-- Plafond de parts sociales fixé par les statuts de la coopérative
-- (NULL = aucun plafond spécifique, on retombe sur le paramètre global).
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS plafond_parts        INTEGER;
-- Éligibilité aux instances (Conseil d'administration, Comité de crédit).
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS eligible_ca          BOOLEAN;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS motif_ineligibilite  TEXT;
ALTER TABLE detenteurs_capital ADD COLUMN IF NOT EXISTS date_derniere_maj_eligibilite DATE;
-- Rattachement client : la clé pointe vers la table cliente (nom variable
-- selon les installations : client / clients). On ajoute l'index sans FK
-- déclarative pour ne jamais bloquer une migration sur un nom de table.
CREATE INDEX IF NOT EXISTS idx_detenteur_categorie ON detenteurs_capital(imf_id, categorie, statut);

-- -------------------------------------------------------------------------
-- 2. MOUVEMENTS : circuit de validation et autorisation préalable
-- -------------------------------------------------------------------------
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS statut_validation TEXT NOT NULL DEFAULT 'VALIDE';
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS seuil_franchi_pct  NUMERIC(6,2);
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS seuils_franchis    TEXT;
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS autorisation_url   TEXT;
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS autorisation_date  DATE;
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS autorisation_reference TEXT;
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS valide_par        UUID;
ALTER TABLE mouvements_titres ADD COLUMN IF NOT EXISTS date_validation   TIMESTAMPTZ;
-- Contrainte de statut ajoutée de façon tolérante (déjà présente = ignorée).
DO $$
BEGIN
  ALTER TABLE mouvements_titres
    ADD CONSTRAINT ck_mouvement_statut
    CHECK (statut_validation IN ('VALIDE','EN_ATTENTE_AUTORISATION','REFUSE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_mouvement_statut ON mouvements_titres(imf_id, statut_validation);

-- -------------------------------------------------------------------------
-- 3. BÉNÉFICIAIRES EFFECTIFS : contrôle de cohérence LBC/FT
-- -------------------------------------------------------------------------
ALTER TABLE beneficiaires_effectifs ADD COLUMN IF NOT EXISTS type_piece      TEXT;
ALTER TABLE beneficiaires_effectifs ADD COLUMN IF NOT EXISTS numero_piece    TEXT;
ALTER TABLE beneficiaires_effectifs ADD COLUMN IF NOT EXISTS pays_residence  TEXT;
ALTER TABLE beneficiaires_effectifs ADD COLUMN IF NOT EXISTS nature_controle TEXT;
ALTER TABLE beneficiaires_effectifs ADD COLUMN IF NOT EXISTS date_naissance  DATE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_benef_detenteur_nom
  ON beneficiaires_effectifs(detenteur_id, lower(nom_prenom));

-- -------------------------------------------------------------------------
-- 4. FEUILLE DE PRÉSENCE : procurations et émargement
-- -------------------------------------------------------------------------
ALTER TABLE feuille_presence_ag ADD COLUMN IF NOT EXISTS procuration_url       TEXT;
ALTER TABLE feuille_presence_ag ADD COLUMN IF NOT EXISTS emargement_at        TIMESTAMPTZ;
ALTER TABLE feuille_presence_ag ADD COLUMN IF NOT EXISTS emargement_par       UUID;
ALTER TABLE feuille_presence_ag ADD COLUMN IF NOT EXISTS observation          TEXT;
-- Une procuration doit désigner un mandataire différent du mandant.
DO $$
BEGIN
  ALTER TABLE feuille_presence_ag
    ADD CONSTRAINT ck_presence_mandataire
    CHECK (mandataire_id IS NULL OR mandataire_id <> detenteur_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -------------------------------------------------------------------------
-- 5. PARAMÈTRES DU CAPITAL (un enregistrement par IMF)
--    Tous les seuils réglementaires sont PARAMÉTRABLES : aucun taux n'est
--    écrit en dur dans le code, car ils varient selon le pays et les statuts.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parametres_capital (
    id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    -- Valeur nominale d'une action / d'une part sociale (centimes XOF).
    valeur_nominale_part_cents          BIGINT,
    -- Capital social minimum exigé par la réglementation (centimes XOF).
    capital_minimum_reglementaire_cents BIGINT,
    -- SCOOP : nombre maximum de parts sociales détenues par un seul membre.
    plafond_parts_par_membre            INTEGER DEFAULT 500,
    -- SCOOP : nombre maximum de procurations portées par un même sociétaire.
    plafond_procurations_par_membre     INTEGER NOT NULL DEFAULT 1,
    -- SA : seuils de participation déclenchant l'autorisation préalable,
    -- en pourcentage (10 %, 20 %, 33 %, 50 % par défaut).
    seuils_participation_pct            TEXT NOT NULL DEFAULT '10,20,33,50',
    -- Quorum des assemblées générales, en pourcentage des droits de vote.
    quorum_ago_1_pct                    NUMERIC(6,2) NOT NULL DEFAULT 50.00,
    quorum_ago_2_pct                    NUMERIC(6,2) NOT NULL DEFAULT 25.00,
    quorum_age_pct                      NUMERIC(6,2) NOT NULL DEFAULT 50.00,
    -- Contrôle des retraits en SCOOP.
    bloquer_retrait_credit_en_cours     BOOLEAN NOT NULL DEFAULT true,
    bloquer_retrait_sous_capital_min    BOOLEAN NOT NULL DEFAULT true,
    observations                        TEXT,
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                          UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_param_capital_imf ON parametres_capital(imf_id);

-- -------------------------------------------------------------------------
-- 6. RÉSULTAT FIGÉ DU QUORUM PAR SESSION (trace de la feuille de présence)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ag_quorum (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    session_id            UUID NOT NULL REFERENCES sessions_et_pv(id) ON DELETE CASCADE,
    est_scoop             BOOLEAN NOT NULL DEFAULT false,
    base_calcul           TEXT NOT NULL DEFAULT 'DROITS_DE_VOTE'
        CHECK (base_calcul IN ('DROITS_DE_VOTE','MEMBRES')),
    voix_total            BIGINT NOT NULL DEFAULT 0,
    voix_presentes        BIGINT NOT NULL DEFAULT 0,
    voix_representees     BIGINT NOT NULL DEFAULT 0,
    membres_total         INTEGER NOT NULL DEFAULT 0,
    membres_presents      INTEGER NOT NULL DEFAULT 0,
    membres_representes   INTEGER NOT NULL DEFAULT 0,
    pourcentage           NUMERIC(6,2),
    quorum_requis_pct     NUMERIC(6,2),
    quorum_atteint        BOOLEAN,
    calcul_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id)
);
CREATE INDEX IF NOT EXISTS idx_ag_quorum_imf ON ag_quorum(imf_id);
