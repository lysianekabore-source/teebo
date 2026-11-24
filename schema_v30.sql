-- =========================================================================
-- VAGUE 30 — CAPITAL & TITRES (correction 13/11/2026)
--
-- Le module Gouvernance (routes/governance.js, section 9 « Capital & titres »)
-- lit et écrit quatre registres qui n'étaient créés par AUCUNE migration :
--
--   1. detenteurs_capital      actionnaires (SA) / membres (SCOOPS)
--   2. mouvements_titres       souscriptions, libérations, cessions, sorties
--   3. beneficiaires_effectifs bénéficiaires effectifs (LBC/FT)
--   4. feuille_presence_ag     feuille de présence en AG (quorum, voix)
--
-- Conséquence avant ce correctif : toute consultation de l'écran Capital
-- renvoyait une erreur 500 (relation inexistante).
--
-- Migration ADDITIVE et RÉENTRANTE (IF NOT EXISTS partout) : peut être
-- relancée sans risque. Contraintes en CHECK (TEXT) plutôt qu'en ENUM, comme
-- la vague 27, pour ne jamais casser un redéploiement.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Registre des détenteurs de titres
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detenteurs_capital (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                    UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    type_entite               TEXT NOT NULL DEFAULT 'PERSONNE_PHYSIQUE'
        CHECK (type_entite IN ('PERSONNE_PHYSIQUE','PERSONNE_MORALE')),
    categorie                 TEXT NOT NULL DEFAULT 'ACTIONNAIRE_SA'
        CHECK (categorie IN ('ACTIONNAIRE_SA','MEMBRE_SCOOP')),
    numero_registre           TEXT NOT NULL,
    nom_ou_raison_sociale     TEXT NOT NULL,
    nationalite_ou_pays_siege TEXT,
    telephone                 TEXT,
    email                     TEXT,
    est_membre_fondateur      BOOLEAN NOT NULL DEFAULT false,
    statut                    TEXT NOT NULL DEFAULT 'ACTIF'
        CHECK (statut IN ('ACTIF','SUSPENDU','DEMISSIONNAIRE','EXCLU','DECEDE')),
    date_adhesion             DATE,
    date_sortie               DATE,
    client_id                 UUID,
    observations              TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                UUID,
    updated_by                UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_detenteur_registre ON detenteurs_capital(imf_id, numero_registre);
CREATE INDEX IF NOT EXISTS idx_detenteur_imf    ON detenteurs_capital(imf_id, statut);
CREATE INDEX IF NOT EXISTS idx_detenteur_client ON detenteurs_capital(client_id);

-- -------------------------------------------------------------------------
-- 2. Mouvements de titres (un enregistrement = une opération)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mouvements_titres (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                       UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    detenteur_id                 UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    type_operation               TEXT NOT NULL DEFAULT 'SOUSCRIPTION_INITIALE'
        CHECK (type_operation IN ('SOUSCRIPTION_INITIALE','SOUSCRIPTION_AUGMENTATION',
                                  'LIBERATION','CESSION','REMBOURSEMENT_SORTIE',
                                  'DIVIDENDE_EN_ACTIONS','AUTRE')),
    nombre_titres                INTEGER NOT NULL CHECK (nombre_titres > 0),
    valeur_nominale_unitaire     NUMERIC(16,2) NOT NULL DEFAULT 0,
    montant_total                NUMERIC(16,2) NOT NULL DEFAULT 0,
    montant_libere               NUMERIC(16,2) NOT NULL DEFAULT 0,
    date_operation               DATE NOT NULL DEFAULT CURRENT_DATE,
    reference_piece_comptable    TEXT,
    autorisation_bceao_requise   BOOLEAN NOT NULL DEFAULT false,
    observations                 TEXT,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                   UUID,
    -- Le libéré ne peut jamais dépasser le montant souscrit.
    CONSTRAINT ck_mouvement_libere CHECK (montant_libere <= montant_total)
);
CREATE INDEX IF NOT EXISTS idx_mouvement_imf   ON mouvements_titres(imf_id, date_operation DESC);
CREATE INDEX IF NOT EXISTS idx_mouvement_det   ON mouvements_titres(detenteur_id);

-- -------------------------------------------------------------------------
-- 3. Bénéficiaires effectifs (LBC/FT) — personnes morales uniquement
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beneficiaires_effectifs (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    detenteur_id                    UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    nom_prenom                      TEXT NOT NULL,
    pourcentage_detention_indirecte NUMERIC(6,2) NOT NULL DEFAULT 0
        CHECK (pourcentage_detention_indirecte >= 0 AND pourcentage_detention_indirecte <= 100),
    piece_identite_url              TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_benef_imf ON beneficiaires_effectifs(imf_id);
CREATE INDEX IF NOT EXISTS idx_benef_det ON beneficiaires_effectifs(detenteur_id);

-- -------------------------------------------------------------------------
-- 4. Feuille de présence en AG (quorum, droits de vote, procurations)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feuille_presence_ag (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    session_id              UUID NOT NULL REFERENCES sessions_et_pv(id) ON DELETE CASCADE,
    detenteur_id            UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    mode_participation      TEXT NOT NULL DEFAULT 'PRESENT'
        CHECK (mode_participation IN ('PRESENT','REPRESENTE_PROCURATION','ABSENT','VISIOCONFERENCE')),
    mandataire_id           UUID REFERENCES detenteurs_capital(id) ON DELETE SET NULL,
    nombre_titres_retenus   INTEGER NOT NULL DEFAULT 0,
    nombre_voix_attribuees  INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, detenteur_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_session ON feuille_presence_ag(session_id);
CREATE INDEX IF NOT EXISTS idx_presence_imf     ON feuille_presence_ag(imf_id);
