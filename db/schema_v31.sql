-- =========================================================================
-- VAGUE 31 — TABLES MANQUANTES DU MODULE CAPITAL & GOUVERNANCE
--           (correctif 13/11/2026-E bis)
--
-- Constat (vérification automatique du code contre les scripts SQL) :
-- deux tables sont lues et écrites par le code, mais AUCUN script de
-- migration ne les créait :
--
--   1. parametres_capital   (capital_engine.js — lecture ET écriture)
--        -> « Get » : repli silencieux sur les valeurs par défaut.
--        -> « Save » : erreur 500 « relation "parametres_capital" does not
--           exist » dès qu'un administrateur enregistre les paramètres du
--           capital de son IMF.
--
--   2. ag_quorum            (capital_engine.js — calcul du quorum en AG)
--        -> le calcul échouait, le quorum n'était jamais archivé et la
--           feuille de présence pouvait afficher un quorum faux.
--
-- Ces deux tables manquaient aussi au décompte de /ready, qui restait donc
-- en dessous du seuil de « prêt ».
--
-- Migration ADDITIVE et RÉENTRANTE (IF NOT EXISTS partout) : peut être
-- relancée autant de fois que nécessaire, sans perte de données.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Paramètres du capital, PAR IMF (donc par pays : seuils et plafonds
--    réglementaires différents en UEMOA selon la forme juridique).
--    Une seule ligne par IMF : ON CONFLICT (imf_id) utilisé par le code.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parametres_capital (
    imf_id                              UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    valeur_nominale_part_cents          BIGINT,
    capital_minimum_reglementaire_cents BIGINT,
    plafond_parts_par_membre            INTEGER NOT NULL DEFAULT 500,
    plafond_procurations_par_membre     INTEGER NOT NULL DEFAULT 1,
    seuils_participation_pct            TEXT    NOT NULL DEFAULT '10,20,33,50',
    quorum_ago_1_pct                    NUMERIC(5,2) NOT NULL DEFAULT 50,
    quorum_ago_2_pct                    NUMERIC(5,2) NOT NULL DEFAULT 25,
    quorum_age_pct                      NUMERIC(5,2) NOT NULL DEFAULT 50,
    bloquer_retrait_credit_en_cours     BOOLEAN NOT NULL DEFAULT true,
    bloquer_retrait_sous_capital_min    BOOLEAN NOT NULL DEFAULT true,
    observations                        TEXT,
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                          UUID REFERENCES app_user(id) ON DELETE SET NULL
);

-- -------------------------------------------------------------------------
-- 2. Quorum figé d'une assemblée générale (trace légale : le quorum constaté
--    ne doit plus bouger si la feuille de présence est modifiée après coup).
--    Le code fait ON CONFLICT (session_id) : la contrainte d'unicité est
--    donc portée par session_id.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ag_quorum (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    session_id          UUID NOT NULL REFERENCES sessions_et_pv(id) ON DELETE CASCADE,
    est_scoop           BOOLEAN NOT NULL DEFAULT false,
    base_calcul         TEXT NOT NULL DEFAULT 'DROITS_DE_VOTE'
        CHECK (base_calcul IN ('DROITS_DE_VOTE','MEMBRES')),
    voix_total          INTEGER NOT NULL DEFAULT 0,
    voix_presentes      INTEGER NOT NULL DEFAULT 0,
    voix_representees   INTEGER NOT NULL DEFAULT 0,
    membres_total       INTEGER NOT NULL DEFAULT 0,
    membres_presents    INTEGER NOT NULL DEFAULT 0,
    membres_representes INTEGER NOT NULL DEFAULT 0,
    pourcentage         NUMERIC(6,2),
    quorum_requis_pct   NUMERIC(5,2),
    quorum_atteint      BOOLEAN,
    calcul_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 3. Index et contraintes (APRÈS la création des tables : un index ne se
--    crée jamais avant sa table, c'est exactement ce qui a cassé la v10).
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_ag_quorum_session ON ag_quorum(session_id);
CREATE INDEX IF NOT EXISTS idx_ag_quorum_imf          ON ag_quorum(imf_id, calcul_at DESC);

-- -------------------------------------------------------------------------
-- 4. Amorce : chaque IMF existante reçoit sa ligne de paramètres (valeurs
--    par défaut identiques à PARAM_DEFAUT du moteur, seuil de participation
--    légal UMOA 10/20/33/50). Idempotent, aucune ligne existante modifiée.
-- -------------------------------------------------------------------------
INSERT INTO parametres_capital (imf_id)
SELECT i.id FROM imf i
WHERE NOT EXISTS (SELECT 1 FROM parametres_capital p WHERE p.imf_id = i.id);
