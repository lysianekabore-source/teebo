-- =========================================================================
-- VAGUE 29 — CAPITAL & TITRES : registre des actionnaires (SA) et des
-- membres sociétaires (SCOOPS), mouvements de titres, bénéficiaires
-- effectifs (LBC/FT) et feuille de présence en Assemblée Générale.
--
-- Quatre registres, tous rattachés à UNE IMF (imf_id) : le cloisonnement par
-- institution est garanti au niveau de la base et des index.
--
--   1. detenteurs_capital      actionnaires SA ou membres SCOOPS
--   2. mouvements_titres       registre des actions / parts sociales
--   3. beneficiaires_effectifs bénéficiaires effectifs (LBC/FT, BCEAO)
--   4. feuille_presence_ag     quorum et droits de vote en AG
--
-- Migration ADDITIVE et RÉENTRANTE : CREATE TABLE IF NOT EXISTS + index
-- après les tables. Les contraintes de valeurs sont écrites en CHECK (TEXT)
-- plutôt qu'en TYPE ENUM : un ENUM ne peut pas être complété sans ALTER TYPE,
-- ce qui casserait un redéploiement si l'on ajoutait une valeur.
--
-- Règle de base SA / SCOOPS :
--   SA     : 1 action = 1 voix ; seuils BCEAO sur les franchissements de
--            participation ; bénéficiaires effectifs obligatoires pour les
--            personnes morales.
--   SCOOPS : 1 sociétaire = 1 voix, quel que soit le nombre de parts ;
--            les personnes morales ne sont pas sociétaires.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Détenteurs de capital (registre des actionnaires / sociétaires)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detenteurs_capital (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                 UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    type_entite            TEXT NOT NULL DEFAULT 'PERSONNE_PHYSIQUE'
                             CHECK (type_entite IN ('PERSONNE_PHYSIQUE','PERSONNE_MORALE')),
    categorie              TEXT NOT NULL
                             CHECK (categorie IN ('ACTIONNAIRE_SA','MEMBRE_SCOOP')),
    numero_registre        TEXT NOT NULL,          -- n° d'actionnaire ou n° de sociétaire
    nom_ou_raison_sociale  TEXT NOT NULL,
    nationalite_ou_pays_siege TEXT,
    telephone              TEXT,
    email                  TEXT,
    est_membre_fondateur   BOOLEAN NOT NULL DEFAULT false,
    statut                 TEXT NOT NULL DEFAULT 'ACTIF'
                             CHECK (statut IN ('ACTIF','SUSPENDU','DEMISSIONNAIRE','EXCLU','DECEDE')),
    date_adhesion          DATE,
    date_sortie            DATE,
    -- Lien direct avec le compte épargne/crédit du membre dans une SCOOPS.
    client_id              UUID REFERENCES client(id) ON DELETE SET NULL,
    observations           TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by             UUID REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT uq_detenteur_registre UNIQUE (imf_id, numero_registre),
    CONSTRAINT ck_detenteur_sortie CHECK (date_sortie IS NULL OR date_adhesion IS NULL OR date_sortie >= date_adhesion)
);

-- -------------------------------------------------------------------------
-- 2. Mouvements de titres (registre des actions et parts sociales)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mouvements_titres (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    detenteur_id            UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    type_operation          TEXT NOT NULL
                              CHECK (type_operation IN ('SOUSCRIPTION_INITIALE','AUGMENTATION','CESSION','REMBOURSEMENT_SORTIE')),
    nombre_titres           INTEGER NOT NULL CHECK (nombre_titres > 0),
    valeur_nominale_unitaire NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (valeur_nominale_unitaire >= 0),
    montant_total           NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (montant_total >= 0),
    -- Suivi du capital souscrit non encore versé.
    montant_libere          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (montant_libere >= 0),
    date_operation          DATE NOT NULL,
    reference_piece_comptable TEXT,
    -- Vrai si franchissement de seuil réglementaire (SA) : visa/préalable BCEAO.
    autorisation_bceao_requise BOOLEAN NOT NULL DEFAULT false,
    observations            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    CONSTRAINT ck_mouvement_libere CHECK (montant_libere <= montant_total)
);

-- -------------------------------------------------------------------------
-- 3. Bénéficiaires effectifs (LBC/FT, BCEAO) — obligatoire pour les
--    personnes morales détenant du capital.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beneficiaires_effectifs (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                        UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    detenteur_id                  UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    nom_prenom                    TEXT NOT NULL,
    pourcentage_detention_indirecte NUMERIC(6,3) NOT NULL DEFAULT 0
                                    CHECK (pourcentage_detention_indirecte >= 0 AND pourcentage_detention_indirecte <= 100),
    piece_identite_url            TEXT,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 4. Feuille de présence en Assemblée Générale
--    nombre_voix_attribuees = nombre d'actions en SA, 1 voix en SCOOPS.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feuille_presence_ag (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                 UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    session_id             UUID NOT NULL REFERENCES sessions_et_pv(id) ON DELETE CASCADE,
    detenteur_id           UUID NOT NULL REFERENCES detenteurs_capital(id) ON DELETE CASCADE,
    mode_participation     TEXT NOT NULL DEFAULT 'ABSENT'
                             CHECK (mode_participation IN ('PRESENT','REPRESENTE_PROCURATION','ABSENT')),
    -- Si représenté par procuration : le mandataire doit être un autre détenteur.
    mandataire_id          UUID REFERENCES detenteurs_capital(id) ON DELETE SET NULL,
    nombre_titres_retenus  INTEGER NOT NULL DEFAULT 0 CHECK (nombre_titres_retenus >= 0),
    nombre_voix_attribuees INTEGER NOT NULL DEFAULT 0 CHECK (nombre_voix_attribuees >= 0),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_presence_session_detenteur UNIQUE (session_id, detenteur_id),
    CONSTRAINT ck_presence_mandataire CHECK (
        (mode_participation = 'REPRESENTE_PROCURATION' AND mandataire_id IS NOT NULL AND mandataire_id <> detenteur_id)
        OR (mode_participation <> 'REPRESENTE_PROCURATION' AND mandataire_id IS NULL)
    )
);

-- Index de cloisonnement (créés APRÈS les tables, jamais avant)
CREATE INDEX IF NOT EXISTS idx_detenteurs_imf        ON detenteurs_capital(imf_id);
CREATE INDEX IF NOT EXISTS idx_detenteurs_categorie  ON detenteurs_capital(imf_id, categorie, statut);
CREATE INDEX IF NOT EXISTS idx_detenteurs_client     ON detenteurs_capital(client_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_imf        ON mouvements_titres(imf_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_detenteur  ON mouvements_titres(detenteur_id, date_operation DESC);
CREATE INDEX IF NOT EXISTS idx_benef_imf             ON beneficiaires_effectifs(imf_id);
CREATE INDEX IF NOT EXISTS idx_benef_detenteur       ON beneficiaires_effectifs(detenteur_id);
CREATE INDEX IF NOT EXISTS idx_presence_session     ON feuille_presence_ag(session_id);
CREATE INDEX IF NOT EXISTS idx_presence_detenteur   ON feuille_presence_ag(detenteur_id);
