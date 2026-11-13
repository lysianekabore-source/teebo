-- =========================================================================
-- VAGUE 33 — FILET DE SECURITE : tables de l'actionnariat / societariat
--
-- CORRECTIF 13/11/2026 : sur Render, la migration s'arretait a schema_v30,
-- les tables de la vague 30 (detenteurs_capital, mouvements_titres,
-- beneficiaires_effectifs, feuille_presence_ag) n'etaient donc creees nulle
-- part et les ecrans Renvoyaient une erreur 500.
--
-- La liste des schemas est desormais lue dans db/ (migrate.js). Ce fichier
-- sert de filet de securite : il recree, en version minimale mais STRICTE
-- (memes colonnes, memes contraintes), toute table manquante. Si la vague 30
-- est deja passee, chaque instruction est ignoree (IF NOT EXISTS).
-- Reentrant : peut etre relance indefiniment.
-- =========================================================================

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
CREATE INDEX IF NOT EXISTS idx_detenteur_imf ON detenteurs_capital(imf_id, statut);

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
    CONSTRAINT ck_mouvement_libere CHECK (montant_libere <= montant_total)
);
CREATE INDEX IF NOT EXISTS idx_mouvement_imf ON mouvements_titres(imf_id, date_operation DESC);
CREATE INDEX IF NOT EXISTS idx_mouvement_det ON mouvements_titres(detenteur_id);

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
CREATE INDEX IF NOT EXISTS idx_presence_imf ON feuille_presence_ag(imf_id);
