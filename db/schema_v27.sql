-- =========================================================================
-- VAGUE 27 — Module GOUVERNANCE & CONFORMITÉ (loi-cadre UMOA sur la
-- gouvernance des institutions de finance inclusive).
--
-- Six registres, tous rattachés à UNE IMF (imf_id) : le cloisonnement par
-- institution est garanti au niveau de la base et des index (aucune requête
-- ne peut lire les données d'une autre IMF).
--
--   1. institution_gouvernance        fiche de gouvernance de l'IMF
--   2. organes_gouvernance            organes statutaires (CA, comités…)
--   3. membres_gouvernance            dirigeants et administrateurs
--   4. mandats_instances              mandats (dates, renouvellements, cumul)
--   5. sessions_et_pv                 sessions des organes + PV scellés
--   6. resolutions_et_recommandations décisions et suites
--
-- Migration ADDITIVE et RÉENTRANTE : CREATE TABLE IF NOT EXISTS + index
-- après les tables. Les contraintes de valeurs sont écrites en CHECK (TEXT)
-- plutôt qu'en TYPE ENUM : un ENUM ne peut pas être complété sans ALTER TYPE,
-- ce qui casserait un redéploiement si l'on ajoutait une valeur.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Fiche de gouvernance de l'IMF (une seule ligne par IMF)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_gouvernance (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                   UUID NOT NULL UNIQUE REFERENCES imf(id) ON DELETE CASCADE,
    raison_sociale           TEXT,
    forme_juridique          TEXT CHECK (forme_juridique IS NULL OR forme_juridique IN ('SA','SAS','SARL','COOPERATIVE','SCOOPS','ASSOCIATION','GIE','AUTRE')),
    rccm                     TEXT,
    ifu_nif                  TEXT,
    numero_agrement          TEXT,
    date_agrement            DATE,
    capital_social_cents     BIGINT,
    siege_social             TEXT,
    pays                     TEXT,
    ville                    TEXT,
    telephone                TEXT,
    email                    TEXT,
    site_web                 TEXT,
    president_ca             TEXT,
    directeur_general        TEXT,
    nombre_administrateurs   INTEGER,
    nombre_femmes_dirigeantes INTEGER,
    date_derniere_ag         DATE,
    date_prochaine_ag        DATE,
    statut_conformite        TEXT NOT NULL DEFAULT 'NON_EVALUEE' CHECK (statut_conformite IN ('NON_EVALUEE','CONFORME','ECARTS_MINEURS','NON_CONFORME')),
    observations             TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by               UUID REFERENCES app_user(id) ON DELETE SET NULL
);

-- -------------------------------------------------------------------------
-- 2. Organes de gouvernance (CA, comité d'audit, comité de risque…)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organes_gouvernance (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id               UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code_organe          TEXT NOT NULL,
    libelle              TEXT NOT NULL,
    type_organe          TEXT NOT NULL CHECK (type_organe IN ('CONSEIL_ADMINISTRATION','COMITE_AUDIT','COMITE_RISQUE','COMITE_CREDIT','COMITE_ALM','ASSEMBLEE_GENERALE','DIRECTION_GENERALE','AUTRE')),
    statut               TEXT NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('ACTIF','SUSPENDU','DISSOUS','INACTIF')),
    nombre_membres       INTEGER NOT NULL DEFAULT 0,
    quorum_requis        INTEGER NOT NULL DEFAULT 0,
    frequence_reunion    TEXT CHECK (frequence_reunion IS NULL OR frequence_reunion IN ('MENSUELLE','BIMESTRIELLE','TRIMESTRIELLE','SEMESTRIELLE','ANNUELLE','A_LA_DEMANDE')),
    obligatoire          BOOLEAN NOT NULL DEFAULT true,
    base_reglementaire   TEXT,
    date_creation        DATE,
    observations         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, code_organe)
);

-- -------------------------------------------------------------------------
-- 3. Membres de gouvernance (administrateurs, dirigeants)
--    app_user_id : lien facultatif vers un compte d'accès existant, pour
--    éviter la double saisie (le nom, la fonction et les coordonnées sont
--    alors repris automatiquement du compte).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membres_gouvernance (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                 UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    app_user_id            UUID REFERENCES app_user(id) ON DELETE SET NULL,
    organe_id              UUID REFERENCES organes_gouvernance(id) ON DELETE SET NULL,
    nom_complet            TEXT NOT NULL,
    fonction               TEXT NOT NULL,
    type_membre            TEXT NOT NULL DEFAULT 'ADMINISTRATEUR' CHECK (type_membre IN ('ADMINISTRATEUR','DIRECTEUR_GENERAL','DIRECTEUR_GENERAL_ADJOINT','MEMBRE_COMITE','COMMISSAIRE_COMPTES','SECRETAIRE','AUTRE')),
    qualite                TEXT CHECK (qualite IS NULL OR qualite IN ('INTERNE','INDEPENDANT','EXTERNE','REPRESENTANT_ETAT')),
    sexe                   TEXT CHECK (sexe IS NULL OR sexe IN ('F','M')),
    date_naissance         DATE,
    nationalite            TEXT,
    profession             TEXT,
    telephone              TEXT,
    email                  TEXT,
    adresse                TEXT,
    diplome_principal      TEXT,
    experience_annees      INTEGER,
    casier_judiciaire_date DATE,
    casier_judiciaire_ok   BOOLEAN,
    declaration_interets  BOOLEAN NOT NULL DEFAULT false,
    date_entree            DATE,
    date_sortie            DATE,
    actif                  BOOLEAN NOT NULL DEFAULT true,
    observations           TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 4. Mandats (traçabilité des nominations, renouvellements, cumul)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mandats_instances (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id               UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    membre_id            UUID NOT NULL REFERENCES membres_gouvernance(id) ON DELETE CASCADE,
    organe_id            UUID REFERENCES organes_gouvernance(id) ON DELETE SET NULL,
    fonction             TEXT NOT NULL,
    type_mandat          TEXT NOT NULL DEFAULT 'ADMINISTRATEUR' CHECK (type_mandat IN ('ADMINISTRATEUR','DIRECTEUR_GENERAL','DIRECTEUR_GENERAL_ADJOINT','MEMBRE_COMITE','COMMISSAIRE_COMPTES','AUTRE')),
    date_debut           DATE NOT NULL,
    date_fin             DATE,
    duree_mois           INTEGER,
    numero_renouvellement INTEGER NOT NULL DEFAULT 1,
    acte_nomination      TEXT,
    reference_ag         TEXT,
    statut               TEXT NOT NULL DEFAULT 'EN_COURS' CHECK (statut IN ('EN_COURS','EXPIRE','REVOQUE','RENOUVELE','TERMINE')),
    observations         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 5. Sessions et PV (le PV signé est scellé par une empreinte SHA-256)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions_et_pv (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                 UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    organe_id              UUID REFERENCES organes_gouvernance(id) ON DELETE SET NULL,
    type_session           TEXT NOT NULL DEFAULT 'ORDINAIRE' CHECK (type_session IN ('ORDINAIRE','EXTRAORDINAIRE','ASSEMBLEE_GENERALE','STATUTAIRE')),
    numero_session         TEXT,
    date_session           DATE NOT NULL,
    heure_debut            TEXT,
    heure_fin              TEXT,
    lieu                   TEXT,
    ordre_du_jour          TEXT,
    nombre_presents        INTEGER NOT NULL DEFAULT 0,
    nombre_invites         INTEGER NOT NULL DEFAULT 0,
    quorum_requis          INTEGER NOT NULL DEFAULT 0,
    quorum_atteint         BOOLEAN,
    president_seance       TEXT,
    secretaire_seance      TEXT,
    pv_reference           TEXT,
    pv_resume              TEXT,
    pv_url                 TEXT,
    hash_integrite_pv      TEXT,
    statut                 TEXT NOT NULL DEFAULT 'BROUILLON' CHECK (statut IN ('PLANIFIEE','BROUILLON','SIGNE_VERROUILLE','ANNULEE')),
    date_signature         DATE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- 6. Résolutions et recommandations (décisions + suivi des échéances)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolutions_et_recommandations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id            UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    session_id        UUID REFERENCES sessions_et_pv(id) ON DELETE SET NULL,
    organe_id         UUID REFERENCES organes_gouvernance(id) ON DELETE SET NULL,
    numero            TEXT,
    intitule          TEXT NOT NULL,
    texte             TEXT,
    type_element      TEXT NOT NULL DEFAULT 'RESOLUTION' CHECK (type_element IN ('RESOLUTION','RECOMMANDATION','DECISION','INSTRUCTION')),
    domaine           TEXT CHECK (domaine IS NULL OR domaine IN ('GOUVERNANCE','RISQUE','CREDIT','AUDIT','COMPTABILITE','RESSOURCES_HUMAINES','SYSTEME_INFORMATION','CONFORMITE','STRATEGIE','AUTRE')),
    responsable       TEXT,
    date_adoption     DATE,
    date_echeance     DATE,
    date_realisation  DATE,
    statut            TEXT NOT NULL DEFAULT 'A_FAIRE' CHECK (statut IN ('A_FAIRE','EN_COURS','REALISEE','EN_RETARD','REJETEE','ANNULEE')),
    taux_execution    INTEGER NOT NULL DEFAULT 0 CHECK (taux_execution BETWEEN 0 AND 100),
    priorite          TEXT NOT NULL DEFAULT 'NORMALE' CHECK (priorite IN ('BASSE','NORMALE','HAUTE','CRITIQUE')),
    observations      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index de cloisonnement (créés APRÈS les tables, jamais avant)
CREATE INDEX IF NOT EXISTS idx_gouv_organes_imf     ON organes_gouvernance(imf_id);
CREATE INDEX IF NOT EXISTS idx_gouv_membres_imf     ON membres_gouvernance(imf_id);
CREATE INDEX IF NOT EXISTS idx_gouv_membres_organe  ON membres_gouvernance(organe_id);
CREATE INDEX IF NOT EXISTS idx_gouv_mandats_imf     ON mandats_instances(imf_id);
CREATE INDEX IF NOT EXISTS idx_gouv_mandats_membre  ON mandats_instances(membre_id);
CREATE INDEX IF NOT EXISTS idx_gouv_sessions_imf    ON sessions_et_pv(imf_id);
CREATE INDEX IF NOT EXISTS idx_gouv_sessions_date   ON sessions_et_pv(imf_id, date_session DESC);
CREATE INDEX IF NOT EXISTS idx_gouv_resol_imf       ON resolutions_et_recommandations(imf_id);
CREATE INDEX IF NOT EXISTS idx_gouv_resol_statut    ON resolutions_et_recommandations(imf_id, statut);
