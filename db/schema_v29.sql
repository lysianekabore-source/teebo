-- =========================================================================
-- VAGUE 29 — GOUVERNANCE : CONFORMITÉ PRUDENTIELLE & RÉGLEMENTAIRE
--
-- Trois blocs viennent compléter le module Gouvernance (vague 27) :
--
--   A. Conventions réglementées & crédits aux apparentés
--        a1. personnes_apparentees
--        a2. conventions_reglementees
--        a3. parametres_prudentiels       (plafonds, seuils, délais : PAR PAYS)
--        a4. gouvernance_export_log       (traçabilité des exports CAC / inspection)
--
--   B. Contrôle interne, risques & plan de continuité (PCA)
--        b1. cartographie_risques         (matrice 4 x 4)
--        b2. plans_continuite_pca         (revue à 365 jours)
--        b3. incidents_majeurs             (notification BCEAO)
--        b4. formation_lbcft               (personnel formé LBC/FT)
--
--   C. Conformité & reporting réglementaire
--        c1. echeancier_reglementaire     (alertes J-30 / J-15 / J-5)
--        c2. echeancier_pieces            (pièces / récépissés déposés)
--
-- Cohérence juridique SCOOP / SA : les titres détenus par une personne
-- apparentée s'appellent PARTS SOCIALES dans une société coopérative
-- (1 membre = 1 voix, quel que soit le nombre de parts) et ACTIONS dans une
-- société anonyme (les droits de vote suivent le nombre d'actions, donc le
-- seuil d'information > 10 % s'applique). La valeur nominale, le seuil de
-- participation et les plafonds prudentiels sont des PARAMÈTRES par pays :
-- aucun montant, aucun taux n'est écrit en dur dans le code.
--
-- Migration ADDITIVE et RÉENTRANTE (CREATE TABLE IF NOT EXISTS, ALTER TABLE
-- ... ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, INSERT ... ON
-- CONFLICT DO NOTHING) : elle peut être relancée sans risque.
-- =========================================================================

-- -------------------------------------------------------------------------
-- A3. Paramètres prudentiels et réglementaires — PAR IMF et PAR PAYS
--     Les valeurs par défaut sont celles annoncées par la réglementation
--     UMOA / BCEAO ; elles doivent être CONFIRMÉES avec la BCEAO ou la
--     Commission Bancaire avant mise en production.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parametres_prudentiels (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    pays                            TEXT,
    -- Plafonds prudentiels appliqués aux apparentés (en pourcentage des
    -- fonds propres effectifs — FPE).
    plafond_apparente_individuel_pct NUMERIC(6,2) NOT NULL DEFAULT 10.00,
    plafond_apparentes_global_pct    NUMERIC(6,2) NOT NULL DEFAULT 20.00,
    -- Fonds propres effectifs (FPE) arrêtés par la direction, en centimes.
    -- Laissé vide, le module utilise le capital social de l'IMF.
    fpe_cents                        BIGINT,
    -- Seuil d'information / d'autorisation préalable : participation d'un
    -- administrateur ou d'un dirigeant (actions en SA, parts en SCOOP).
    seuil_participation_pct          NUMERIC(6,2) NOT NULL DEFAULT 10.00,
    -- Périmètre des apparentés retenu par l'IMF.
    perimetre_apparentes             TEXT NOT NULL DEFAULT 'LARGE'
        CHECK (perimetre_apparentes IN ('STRICT','LARGE')),
    -- Contrôle interne / PCA.
    revue_pca_jours                  INTEGER NOT NULL DEFAULT 365,
    alerte_pca_sans_exercice_mois    INTEGER NOT NULL DEFAULT 12,
    seuil_risque_residuel_eleve      INTEGER NOT NULL DEFAULT 9,
    -- Échéancier réglementaire.
    alertes_jours                    TEXT NOT NULL DEFAULT '30,15,5',
    -- Devise de référence.
    devise                           TEXT NOT NULL DEFAULT 'XOF',
    observations                     TEXT,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                       UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_param_prudentiels_imf ON parametres_prudentiels(imf_id);

-- -------------------------------------------------------------------------
-- A1. Personnes apparentées
--     Une personne apparentée est rattachée à SOIT un membre de gouvernance
--     (administrateur, dirigeant), SOIT un employé. Le lien de parenté est
--     celui du Code de commerce UMOA / des instructions BCEAO (conjoint,
--     ascendant, descendant, fratrie, société sous contrôle commun…).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personnes_apparentees (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    -- Rattachement à un membre de gouvernance ou à un employé (l'un ou l'autre).
    membre_gouvernance_id UUID REFERENCES membres_gouvernance(id) ON DELETE CASCADE,
    app_user_id           UUID REFERENCES app_user(id) ON DELETE SET NULL,
    nom_complet           TEXT NOT NULL,
    type_lien             TEXT NOT NULL DEFAULT 'AUTRE'
        CHECK (type_lien IN ('CONJOINT','ENFANT','ASCENDANT','FRATRIE','BELLE_FAMILLE',
                             'SOCIETE_CONTROLEE','SOCIETE_AFFILIEE','REPRESENTANT_LEGAL','AUTRE')),
    nature_personne       TEXT NOT NULL DEFAULT 'PHYSIQUE'
        CHECK (nature_personne IN ('PHYSIQUE','MORALE')),
    -- Identification (personne physique ou morale).
    date_naissance        DATE,
    numero_piece          TEXT,
    rccm                  TEXT,
    ifu_nif               TEXT,
    telephone             TEXT,
    email                 TEXT,
    adresse               TEXT,
    -- Client de l'institution ? (permet la détection automatique au crédit)
    client_id             UUID REFERENCES client(id) ON DELETE SET NULL,
    -- Éléments de vérification.
    statut_verification   TEXT NOT NULL DEFAULT 'A_VERIFIER'
        CHECK (statut_verification IN ('A_VERIFIER','VERIFIEE','REJETEE')),
    date_verification     DATE,
    piece_justificative   TEXT,
    observations          TEXT,
    actif                 BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_apparentees_imf    ON personnes_apparentees(imf_id, actif);
CREATE INDEX IF NOT EXISTS idx_apparentees_membre ON personnes_apparentees(membre_gouvernance_id);
CREATE INDEX IF NOT EXISTS idx_apparentees_client ON personnes_apparentees(client_id);

-- -------------------------------------------------------------------------
-- A2. Conventions réglementées & crédits aux apparentés
--     Un enregistrement = une convention (crédit, achat, bail, service…)
--     conclue avec une personne apparentée. Le circuit d'autorisation est
--     conservé : autorisation préalable du conseil, exclusion du vote de
--     l'administrateur concerné, information du CAC.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conventions_reglementees (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                   UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    reference                TEXT NOT NULL,
    personne_apparentee_id   UUID NOT NULL REFERENCES personnes_apparentees(id) ON DELETE CASCADE,
    -- Administrateur / dirigeant intéressé (sa voix est exclue du vote).
    membre_gouvernance_id    UUID REFERENCES membres_gouvernance(id) ON DELETE SET NULL,
    -- Contrepartie de l'institution : client (le cas échéant) ou texte libre.
    client_id                UUID REFERENCES client(id) ON DELETE SET NULL,
    credit_file_id           UUID REFERENCES credit_file(id) ON DELETE SET NULL,
    type_convention          TEXT NOT NULL DEFAULT 'CREDIT'
        CHECK (type_convention IN ('CREDIT','DEPOT','ACHAT','VENTE','BAIL','PRESTATION',
                                   'CAUTION','PARTICIPATION','REMUNERATION','AUTRE')),
    objet                    TEXT,
    date_convention          DATE NOT NULL DEFAULT CURRENT_DATE,
    montant_cents            BIGINT NOT NULL DEFAULT 0 CHECK (montant_cents >= 0),
    taux_interet_pct         NUMERIC(6,2),
    duree_mois               INTEGER,
    conditions               TEXT,
    -- Autorisation
    statut                   TEXT NOT NULL DEFAULT 'PROJET'
        CHECK (statut IN ('PROJET','EN_ATTENTE_AUTORISATION','AUTORISEE','REFUSEE',
                                   'EN_COURS','CLOTUREE','ANNULEE')),
    autorisation_requise     BOOLEAN NOT NULL DEFAULT true,
    organe_autorisation      TEXT,
    date_autorisation        DATE,
    reference_autorisation   TEXT,
    -- Exclusion du vote de l'administrateur intéressé
    vote_exclu               BOOLEAN NOT NULL DEFAULT true,
    vote_exclusion_note      TEXT,
    -- Informations de conformité
    informe_cac              BOOLEAN NOT NULL DEFAULT false,
    date_information_cac     DATE,
    depassement_plafond      BOOLEAN NOT NULL DEFAULT false,
    commentaire_conformite   TEXT,
    observations             TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by               UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_convention_ref ON conventions_reglementees(imf_id, reference);
CREATE INDEX IF NOT EXISTS idx_conventions_imf     ON conventions_reglementees(imf_id, statut);
CREATE INDEX IF NOT EXISTS idx_conventions_personne ON conventions_reglementees(personne_apparentee_id);
CREATE INDEX IF NOT EXISTS idx_conventions_client  ON conventions_reglementees(client_id);

-- -------------------------------------------------------------------------
-- A4. Journal des exports (Rapport Spécial CAC, Pack Inspection)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gouvernance_export_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id        UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    type_export   TEXT NOT NULL CHECK (type_export IN ('RAPPORT_CAC_PDF','RAPPORT_CAC_EXCEL','PACK_INSPECTION_ZIP')),
    periode_debut DATE,
    periode_fin   DATE,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gouv_export_imf ON gouvernance_export_log(imf_id, created_at DESC);

-- -------------------------------------------------------------------------
-- B1. Cartographie des risques — matrice probabilité x impact (4 x 4)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cartographie_risques (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_risque           TEXT,
    libelle               TEXT NOT NULL,
    categorie             TEXT NOT NULL DEFAULT 'OPERATIONNEL'
        CHECK (categorie IN ('CREDIT','LIQUIDITE','MARCHE','OPERATIONNEL','CONFORMITE',
                             'GOUVERNANCE','STRATEGIQUE','TIC','LBC_FT','AUTRE')),
    processus             TEXT,
    description           TEXT,
    -- Cotation INHÉRENTE (avant mesures de maîtrise) : 1 = très faible, 4 = très élevé.
    probabilite           INTEGER NOT NULL DEFAULT 2 CHECK (probabilite BETWEEN 1 AND 4),
    impact                INTEGER NOT NULL DEFAULT 2 CHECK (impact BETWEEN 1 AND 4),
    -- Cotation RÉSIDUELLE (après mesures de maîtrise).
    probabilite_residuelle INTEGER CHECK (probabilite_residuelle BETWEEN 1 AND 4),
    impact_residuel        INTEGER CHECK (impact_residuel BETWEEN 1 AND 4),
    -- Mesures de maîtrise.
    dispositif_maitrise   TEXT,
    responsable           TEXT,
    date_revue            DATE,
    prochaine_revue       DATE,
    statut                TEXT NOT NULL DEFAULT 'ACTIF'
        CHECK (statut IN ('ACTIF','MAITRISE','SURVEILLE','CLOS')),
    observations          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_carto_imf ON cartographie_risques(imf_id, statut);

-- -------------------------------------------------------------------------
-- B2. Plans de continuité d'activité (PCA)
--     La revue est OBLIGATOIRE tous les 365 jours : au-delà, le plan passe
--     automatiquement au statut REVISION_REQUISE.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans_continuite_pca (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                    UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_plan                 TEXT NOT NULL,
    libelle                   TEXT NOT NULL,
    type_plan                 TEXT NOT NULL DEFAULT 'PCA'
        CHECK (type_plan IN ('PCA','PRA','PGI','PLAN_SECOURS')),
    perimetre                 TEXT,
    responsable               TEXT,
    version                   TEXT,
    date_approbation          DATE,
    date_derniere_revue       DATE,
    date_prochaine_revue      DATE,
    -- Exercices de simulation
    date_dernier_exercice     DATE,
    resultat_dernier_exercice TEXT
        CHECK (resultat_dernier_exercice IS NULL OR resultat_dernier_exercice IN ('SATISFAISANT','PARTIEL','NON_SATISFAISANT')),
    constats_exercice         TEXT,
    statut                    TEXT NOT NULL DEFAULT 'VALIDE'
        CHECK (statut IN ('BROUILLON','VALIDE','REVISION_REQUISE','OBSOLETE')),
    document_reference        TEXT,
    observations              TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pca_code ON plans_continuite_pca(imf_id, code_plan);
CREATE INDEX IF NOT EXISTS idx_pca_imf ON plans_continuite_pca(imf_id, statut);

-- -------------------------------------------------------------------------
-- B3. Incidents majeurs — notification BCEAO
--     Un incident majeur qui n'a pas été notifié à la BCEAO dans le délai
--     réglementaire (24 h par défaut, paramétrable) déclenche une alerte.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents_majeurs (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                   UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    reference                TEXT NOT NULL,
    date_incident            DATE NOT NULL DEFAULT CURRENT_DATE,
    heure_incident           TEXT,
    type_incident            TEXT NOT NULL DEFAULT 'AUTRE'
        CHECK (type_incident IN ('FRAUDE','VOL','INTRUSION_SI','PANNE_SI','PANNE_ELECTRIQUE',
                                 'INONDATION','INCENDIE','ARRET_ACTIVITE','ATTEINTE_DONNEES',
                                 'BLANCHIMENT_SOUPCON','AUTRE')),
    gravite                  TEXT NOT NULL DEFAULT 'MOYENNE'
        CHECK (gravite IN ('FAIBLE','MOYENNE','HAUTE','CRITIQUE')),
    description              TEXT,
    localisation             TEXT,
    pertes_cents             BIGINT NOT NULL DEFAULT 0 CHECK (pertes_cents >= 0),
    impact_activite          TEXT,
    mesures_immediates       TEXT,
    -- Notification BCEAO
    notification_bceao_requise BOOLEAN NOT NULL DEFAULT true,
    notification_bceao       BOOLEAN NOT NULL DEFAULT false,
    date_notification        DATE,
    reference_notification   TEXT,
    delai_notification_heures INTEGER NOT NULL DEFAULT 24,
    -- Suivi
    statut                   TEXT NOT NULL DEFAULT 'OUVERT'
        CHECK (statut IN ('OUVERT','EN_COURS','RESOLU','CLOS')),
    date_resolution          DATE,
    plan_action              TEXT,
    commentaires             TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by               UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_imf ON incidents_majeurs(imf_id, statut);

-- -------------------------------------------------------------------------
-- B4. Formation LBC/FT du personnel (indicateur de couverture)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formation_lbcft (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    app_user_id           UUID REFERENCES app_user(id) ON DELETE CASCADE,
    libelle               TEXT,
    date_formation        DATE NOT NULL DEFAULT CURRENT_DATE,
    organisme             TEXT,
    duree_heures          NUMERIC(6,1),
    attestation_reference TEXT,
    attestation_recue     BOOLEAN NOT NULL DEFAULT false,
    date_expiration       DATE,
    observations          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lbcft_imf  ON formation_lbcft(imf_id, date_formation DESC);
CREATE INDEX IF NOT EXISTS idx_lbcft_user ON formation_lbcft(app_user_id);

-- -------------------------------------------------------------------------
-- C1. Échéancier réglementaire (obligations périodiques par pays)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS echeancier_reglementaire (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_obligation       TEXT,
    libelle               TEXT NOT NULL,
    autorite              TEXT NOT NULL DEFAULT 'BCEAO'
        CHECK (autorite IN ('BCEAO','COMMISSION_BANCAIRE','MINISTERE_FINANCES',
                               'CENTIF','CONSEIL_REGIONAL','AUTRE')),
    categorie             TEXT NOT NULL DEFAULT 'NORMALE'
        CHECK (categorie IN ('NORMALE','PRUDENTIELLE','COMPTABLE','LBC_FT','STATISTIQUE','FISCALE','SOCIALE')),
    pays                  TEXT,
    periodicite           TEXT NOT NULL DEFAULT 'MENSUELLE'
        CHECK (periodicite IN ('HEBDOMADAIRE','MENSUELLE','TRIMESTRIELLE','SEMESTRIELLE',
                               'ANNUELLE','PONCTUELLE')),
    date_echeance         DATE NOT NULL,
    date_limite_depot     DATE,
    -- Dépôt et récépissé
    statut                TEXT NOT NULL DEFAULT 'A_FAIRE'
        CHECK (statut IN ('A_FAIRE','EN_PREPARATION','DEPOSE','RECEPISSE_RECU','EN_RETARD','SANS_OBJET')),
    date_depot            DATE,
    reference_recepisse   TEXT,
    date_recepisse        DATE,
    piece_justificative   TEXT,
    -- Rappels
    rappel_envoye_le      DATE,
    alerte_niveau         TEXT,
    responsable           TEXT,
    commentaires          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_echeancier_imf  ON echeancier_reglementaire(imf_id, statut, date_echeance);
CREATE INDEX IF NOT EXISTS idx_echeancier_date ON echeancier_reglementaire(date_echeance);

-- Pièces d'un dépôt (un dépôt peut comporter plusieurs pièces)
CREATE TABLE IF NOT EXISTS echeancier_pieces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    echeance_id     UUID NOT NULL REFERENCES echeancier_reglementaire(id) ON DELETE CASCADE,
    libelle         TEXT NOT NULL,
    reference       TEXT,
    recue           BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ech_pieces ON echeancier_pieces(echeance_id);

-- -------------------------------------------------------------------------
-- Colonnes ajoutées aux tables existantes (si elles n'existent pas déjà)
-- -------------------------------------------------------------------------
ALTER TABLE membres_gouvernance
    ADD COLUMN IF NOT EXISTS titres_detenus        BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS type_titres           TEXT,
    ADD COLUMN IF NOT EXISTS pct_participation     NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS apparente_declare     BOOLEAN NOT NULL DEFAULT false;

-- Le type de titre est déduit de la forme juridique de l'institution :
-- PARTS SOCIALES (SCOOP) ou ACTIONS (SA).
UPDATE membres_gouvernance m
   SET type_titres = CASE WHEN i.forme_juridique IN ('COOPERATIVE','SCOOPS') THEN 'PARTS_SOCIALES'
                          ELSE 'ACTIONS' END
  FROM institution_gouvernance i
 WHERE i.imf_id = m.imf_id
   AND m.type_titres IS NULL;

ALTER TABLE credit_file
    ADD COLUMN IF NOT EXISTS apparente           BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS apparente_note      TEXT,
    ADD COLUMN IF NOT EXISTS convention_id       UUID;

-- -------------------------------------------------------------------------
-- Paramètres par défaut : une ligne par IMF, recopiés du pays de l'IMF
-- -------------------------------------------------------------------------
INSERT INTO parametres_prudentiels (imf_id, pays)
SELECT i.id, i.country_code FROM imf i
ON CONFLICT (imf_id) DO NOTHING;

-- Echeancier type (JAMAIS destructif : on n'ajoute que si l'IMF est vierge)
INSERT INTO echeancier_reglementaire (imf_id, code_obligation, libelle, autorite, categorie, periodicite, date_echeance, responsable)
SELECT i.id, 'SITUATION_MENSUELLE',
       'Situation mensuelle prudentielle (états financiers et ratios)',
       'BCEAO', 'PRUDENTIELLE', 'MENSUELLE',
       (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' + INTERVAL '25 days')::date,
       'Direction financière'
  FROM imf i
 WHERE NOT EXISTS (SELECT 1 FROM echeancier_reglementaire e WHERE e.imf_id = i.id)
   AND i.code_imf <> 'TBO-SYS-000000';

INSERT INTO echeancier_reglementaire (imf_id, code_obligation, libelle, autorite, categorie, periodicite, date_echeance, responsable)
SELECT i.id, 'ETATS_FINANCIERS_ANNUELS',
       'États financiers annuels audités (rapport du CAC)',
       'BCEAO', 'COMPTABLE', 'ANNUELLE',
       (date_trunc('year', CURRENT_DATE) + INTERVAL '1 year' + INTERVAL '4 months' - INTERVAL '1 day')::date,
       'Direction financière'
  FROM imf i
 WHERE NOT EXISTS (SELECT 1 FROM echeancier_reglementaire e WHERE e.imf_id = i.id AND e.code_obligation = 'ETATS_FINANCIERS_ANNUELS')
   AND i.code_imf <> 'TBO-SYS-000000';

INSERT INTO echeancier_reglementaire (imf_id, code_obligation, libelle, autorite, categorie, periodicite, date_echeance, responsable)
SELECT i.id, 'RAPPORT_LBCFT',
       'Rapport LBC/FT et déclarations d''opérations suspectes (CENTIF)',
       'CENTIF', 'LBC_FT', 'MENSUELLE',
       (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' + INTERVAL '9 days')::date,
       'Responsable conformité'
  FROM imf i
 WHERE NOT EXISTS (SELECT 1 FROM echeancier_reglementaire e WHERE e.imf_id = i.id AND e.code_obligation = 'RAPPORT_LBCFT')
   AND i.code_imf <> 'TBO-SYS-000000';
