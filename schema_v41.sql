-- ===========================================================================
-- teebo — VAGUE 41 : CONFORMITÉ BCEAO (Instruction n°003-03-2025 du 18/03/2025)
--            et Loi uniforme LBC/FT/FP (UEMOA)
-- ===========================================================================
-- Objectif : porter la connaissance du client (KYC) et de l'entreprise (KYB)
-- au niveau attendu par le superviseur :
--   • identité complète : date ET lieu de naissance, nationalité, profession
--     et source de revenus, justificatif de domicile OU visite GPS certifiée,
--     expiration de la pièce, selfie de vérification ;
--   • échéance de révision périodique : 1 an (risque ÉLEVÉ / PPE),
--     3 ans (risque MOYEN), 5 ans (risque FAIBLE) ;
--   • personnes morales : bénéficiaires effectifs (> 25 %) et mandataires
--     signataires, avec pièce valide et criblage des listes ;
--   • criblage flou (fuzzy) contre les listes sanctions / PPE ;
--   • visites de terrain hors-ligne (UUID mobile, GPS certifié, repères
--     visuels, photos horodatées) ;
--   • restriction automatique « ALERTE_KYC_EXPIRE » quand une pièce ou une
--     revue est échue ;
--   • seuil paramétrable au-dessus duquel un décaissement exige une visite
--     de moins de 30 jours au statut ACTIF_CONFORME.
--
-- Contenu (100 % ADDITIF, réexécutable) :
--   A. Fonctions utilitaires (arrondi, distance) — sans dépendance PostGIS.
--   B. Compléments sur la table client (identité, risque, échéance de revue).
--   C. kyc_evaluations : résultat historisé de chaque évaluation KYC.
--   D. kyb_entites_morales, kyb_beneficiaires_effectifs,
--      kyb_mandataires_signataires (tenant_id obligatoire).
--   E. visites_terrain_kyc : visites GPS hors-ligne.
--   F. listes_sanctions_ppe + kyc_criblage_resultats.
--   G. kyc_restrictions : restrictions de conformité (ALERTE_KYC_EXPIRE…).
--   H. Paramétrage conformité par IMF (seuils) + référentiel par défaut.
--   I. Habilitations (lecture / validation / PPE / paramétrage).
--   J. Audit (trigger standard fn_audit).
--
-- Aucune table supprimée, aucune colonne renommée, aucune donnée écrasée.
-- La géolocalisation est stockée en lat/lng + précision + distance calculée :
-- le module ne dépend donc PAS de l'extension PostGIS.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- A. FONCTIONS UTILITAIRES
-- ===========================================================================
-- Distance en mètres entre deux points (formule de haversine, WGS-84).
CREATE OR REPLACE FUNCTION fn_kyc_distance_m(
  lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC) RETURNS NUMERIC AS $$
DECLARE r CONSTANT NUMERIC := 6371000; dlat NUMERIC; dlng NUMERIC; a NUMERIC;
BEGIN
  IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN RETURN NULL; END IF;
  dlat := radians(lat2::double precision - lat1::double precision)::numeric;
  dlng := radians(lng2::double precision - lng1::double precision)::numeric;
  a := sin(dlat / 2) ^ 2
       + cos(radians(lat1::double precision))::numeric * cos(radians(lat2::double precision))::numeric
         * sin(dlng / 2) ^ 2;
  RETURN round(r * 2 * atan2(sqrt(a), sqrt(1 - a)), 2);
END $$ LANGUAGE plpgsql IMMUTABLE;

-- ===========================================================================
-- B. COMPLÉMENTS SUR LA TABLE client (identité LBC/FT + risque)
-- ===========================================================================
ALTER TABLE client ADD COLUMN IF NOT EXISTS lieu_naissance        TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS pays_naissance        TEXT DEFAULT 'CI';
ALTER TABLE client ADD COLUMN IF NOT EXISTS nationalite           TEXT DEFAULT 'CI';
ALTER TABLE client ADD COLUMN IF NOT EXISTS profession            TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS secteur_activite      TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS source_revenus        TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS revenu_mensuel_cents  BIGINT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS type_piece            TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS piece_emise_le        DATE;
ALTER TABLE client ADD COLUMN IF NOT EXISTS piece_expire_le       DATE;
ALTER TABLE client ADD COLUMN IF NOT EXISTS justificatif_domicile_type TEXT;   -- FACTURE | ATTESTATION | BAIL | VISITE_GPS
ALTER TABLE client ADD COLUMN IF NOT EXISTS justificatif_domicile_ref  TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS selfie_data_url       TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS selfie_captured_at    TIMESTAMPTZ;
ALTER TABLE client ADD COLUMN IF NOT EXISTS niveau_risque_lbc     TEXT NOT NULL DEFAULT 'MOYEN'; -- FAIBLE | MOYEN | ELEVE
ALTER TABLE client ADD COLUMN IF NOT EXISTS statut_kyc            TEXT NOT NULL DEFAULT 'A_COMPLETER'; -- A_COMPLETER | ACTIF_CONFORME | A_REVOIR | EXPIRE
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe                    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe_fonction           TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS kyc_valide_le          TIMESTAMPTZ;
ALTER TABLE client ADD COLUMN IF NOT EXISTS kyc_prochaine_revue_le DATE;
ALTER TABLE client ADD COLUMN IF NOT EXISTS kyc_derniere_visite_le  TIMESTAMPTZ;
ALTER TABLE client ADD COLUMN IF NOT EXISTS kyc_score              INTEGER;
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe_valide_par         UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe_valide_le          TIMESTAMPTZ;
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe_approuve_dg_par    UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE client ADD COLUMN IF NOT EXISTS ppe_approuve_dg_le     TIMESTAMPTZ;

-- Contraintes souples (ajoutées seulement si absentes, jamais bloquantes
-- pour des lignes historiques : on borne par NOT VALID puis validation douce).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_client_niveau_risque_lbc') THEN
    ALTER TABLE client ADD CONSTRAINT chk_client_niveau_risque_lbc
      CHECK (niveau_risque_lbc IN ('FAIBLE','MOYEN','ELEVE')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_client_statut_kyc') THEN
    ALTER TABLE client ADD CONSTRAINT chk_client_statut_kyc
      CHECK (statut_kyc IN ('A_COMPLETER','ACTIF_CONFORME','A_REVOIR','EXPIRE')) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_kyc_revue   ON client (imf_id, kyc_prochaine_revue_le);
CREATE INDEX IF NOT EXISTS idx_client_kyc_statut  ON client (imf_id, statut_kyc);
CREATE INDEX IF NOT EXISTS idx_client_ppe         ON client (imf_id) WHERE ppe;

-- ===========================================================================
-- C. kyc_evaluations — une ligne par évaluation (jamais écrasée)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS kyc_evaluations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id               UUID,
    client_id               UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    -- Note de conformité (0 = dossier inexploitable, 100 = complet)
    score_kyc               INTEGER NOT NULL DEFAULT 0 CHECK (score_kyc >= 0 AND score_kyc <= 100),
    niveau_risque_lbc       TEXT NOT NULL DEFAULT 'MOYEN',
    statut                  TEXT NOT NULL DEFAULT 'A_COMPLETER',
    -- Résultat détaillé et explicable (checklist, manques, criblage)
    controle_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Échéance de révision calculée : 1 an (ÉLEVÉ/PPE), 3 ans (MOYEN), 5 ans (FAIBLE)
    revue_intervalle_mois   INTEGER NOT NULL DEFAULT 36,
    prochaine_revue_le      DATE,
    -- Décision
    decide_par              TEXT NOT NULL DEFAULT 'SYSTEME',  -- SYSTEME | AGENT | COMITE
    valide_par              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    valide_le               TIMESTAMPTZ,
    commentaire             TEXT,
    cree_le                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kyc_evaluations ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE kyc_evaluations ADD COLUMN IF NOT EXISTS revue_intervalle_mois INTEGER NOT NULL DEFAULT 36;
UPDATE kyc_evaluations SET tenant_id = imf_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_eval_client ON kyc_evaluations (client_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_eval_imf    ON kyc_evaluations (imf_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_eval_revue  ON kyc_evaluations (imf_id, prochaine_revue_le);

-- ===========================================================================
-- D. KYB — PERSONNES MORALES
-- ===========================================================================
CREATE TABLE IF NOT EXISTS kyb_entites_morales (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                 UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id              UUID REFERENCES client(id) ON DELETE SET NULL,  -- client entreprise rattaché
    raison_sociale         TEXT NOT NULL,
    forme_juridique        TEXT,                        -- SA | SARL | SAS | SURL | GIE | COOPERATIVE | ASSOCIATION
    rccm                   TEXT,
    compte_contribuable    TEXT,
    date_immatriculation    DATE,
    pays_immatriculation   TEXT DEFAULT 'CI',
    siege_adresse          TEXT,
    siege_gps_lat          NUMERIC(9,6),
    siege_gps_lng          NUMERIC(9,6),
    siege_gps_precision_m  NUMERIC(7,2),
    siege_gps_le           TIMESTAMPTZ,
    activite_principale    TEXT,
    capital_social_cents   BIGINT,
    chiffre_affaires_cents BIGINT,
    pays_operation         TEXT DEFAULT 'CI',
    -- Conformité
    statut_kyb             TEXT NOT NULL DEFAULT 'A_COMPLETER', -- A_COMPLETER | ACTIF_CONFORME | A_REVOIR | EXPIRE
    niveau_risque_lbc      TEXT NOT NULL DEFAULT 'MOYEN',
    score_kyb              INTEGER NOT NULL DEFAULT 0,
    prochaine_revue_le     DATE,
    cree_par               UUID REFERENCES app_user(id) ON DELETE SET NULL,
    valide_par             UUID REFERENCES app_user(id) ON DELETE SET NULL,
    valide_le              TIMESTAMPTZ,
    cree_le                TIMESTAMPTZ NOT NULL DEFAULT now(),
    maj_le                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyb_entite_tenant ON kyb_entites_morales (tenant_id, imf_id);
CREATE INDEX IF NOT EXISTS idx_kyb_entite_client ON kyb_entites_morales (client_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyb_entite_rccm
  ON kyb_entites_morales (imf_id, lower(rccm)) WHERE rccm IS NOT NULL;

-- Bénéficiaires effectifs (> 25 % du capital ou des droits de vote)
CREATE TABLE IF NOT EXISTS kyb_beneficiaires_effectifs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id             UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    entite_id          UUID NOT NULL REFERENCES kyb_entites_morales(id) ON DELETE CASCADE,
    nom_complet        TEXT NOT NULL,
    date_naissance     DATE,
    lieu_naissance     TEXT,
    nationalite        TEXT,
    pays_residence     TEXT,
    adresse            TEXT,
    type_piece         TEXT,
    numero_piece       TEXT,
    piece_expire_le    DATE,
    detention_pct      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (detention_pct >= 0 AND detention_pct <= 100),
    nature_controle    TEXT,                     -- CAPITAL | DROITS_DE_VOTE | AUTRE
    est_ppe            BOOLEAN NOT NULL DEFAULT false,
    criblage_statut    TEXT NOT NULL DEFAULT 'A_FAIRE', -- A_FAIRE | CLAIR | SUSPECT | CONFIRME
    criblage_score     NUMERIC(5,2),
    criblage_le        TIMESTAMPTZ,
    piece_valide       BOOLEAN NOT NULL DEFAULT false,
    cree_le            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyb_be_entite ON kyb_beneficiaires_effectifs (entite_id);
CREATE INDEX IF NOT EXISTS idx_kyb_be_tenant ON kyb_beneficiaires_effectifs (tenant_id);

-- Mandataires signataires (pouvoir de signature)
CREATE TABLE IF NOT EXISTS kyb_mandataires_signataires (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id             UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    entite_id          UUID NOT NULL REFERENCES kyb_entites_morales(id) ON DELETE CASCADE,
    nom_complet        TEXT NOT NULL,
    fonction           TEXT,
    date_naissance     DATE,
    lieu_naissance     TEXT,
    nationalite        TEXT,
    type_piece         TEXT,
    numero_piece       TEXT,
    piece_expire_le    DATE,
    pouvoir_ref        TEXT,
    pouvoir_expire_le  DATE,
    plafond_signature_cents BIGINT,
    est_ppe            BOOLEAN NOT NULL DEFAULT false,
    criblage_statut    TEXT NOT NULL DEFAULT 'A_FAIRE',
    criblage_score     NUMERIC(5,2),
    criblage_le        TIMESTAMPTZ,
    piece_valide       BOOLEAN NOT NULL DEFAULT false,
    actif              BOOLEAN NOT NULL DEFAULT true,
    cree_le            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyb_mand_entite ON kyb_mandataires_signataires (entite_id);
CREATE INDEX IF NOT EXISTS idx_kyb_mand_tenant ON kyb_mandataires_signataires (tenant_id);

-- ===========================================================================
-- E. VISITES DE TERRAIN (hors-ligne : UUID généré sur le téléphone)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS visites_terrain_kyc (
    id                    UUID PRIMARY KEY,           -- UUID généré par l'appareil (idempotence)
    imf_id                UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id             UUID,
    client_id             UUID REFERENCES client(id) ON DELETE CASCADE,
    entite_id             UUID REFERENCES kyb_entites_morales(id) ON DELETE CASCADE,
    agent_id              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    appareil_id           TEXT,
    -- Type de visite
    objet                 TEXT NOT NULL DEFAULT 'VERIFICATION_DOMICILE',
      -- VERIFICATION_DOMICILE | VERIFICATION_ACTIVITE | CONTROLE_PERIODIQUE | ENROLEMENT
    statut                TEXT NOT NULL DEFAULT 'ACTIF_CONFORME',
      -- ACTIF_CONFORME | NON_CONFORME | INCOMPLET
    -- GPS certifié (capteur uniquement, jamais saisi à la main)
    gps_lat               NUMERIC(9,6),
    gps_lng               NUMERIC(9,6),
    gps_precision_m       NUMERIC(7,2),
    gps_capture_le        TIMESTAMPTZ,
    gps_source            TEXT NOT NULL DEFAULT 'CAPTEUR',   -- CAPTEUR (seule valeur acceptée)
    gps_alerte_precision  BOOLEAN NOT NULL DEFAULT false,    -- précision > 30 m
    point_reference_lat   NUMERIC(9,6),
    point_reference_lng   NUMERIC(9,6),
    distance_m            NUMERIC(10,2),
    distance_alerte       BOOLEAN NOT NULL DEFAULT false,
    -- Constat de terrain
    reperes_visuels       TEXT,
    present               BOOLEAN,
    activite_constatee    TEXT,
    observations          TEXT,
    photos_json           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ url, prise_le, lat, lng, legende }]
    visite_le             TIMESTAMPTZ NOT NULL DEFAULT now(),
    capture_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
    synchronise_le        TIMESTAMPTZ,
    hors_ligne            BOOLEAN NOT NULL DEFAULT true,
    cree_le               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE visites_terrain_kyc ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE visites_terrain_kyc SET tenant_id = imf_id WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_visite_client  ON visites_terrain_kyc (client_id, visite_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_entite  ON visites_terrain_kyc (entite_id, visite_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_imf     ON visites_terrain_kyc (imf_id, visite_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_agent   ON visites_terrain_kyc (agent_id, visite_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_hors_ligne ON visites_terrain_kyc (imf_id) WHERE synchronise_le IS NULL;

-- ===========================================================================
-- F. LISTES DE SANCTIONS / PPE + RÉSULTATS DE CRIBLAGE
-- ===========================================================================
CREATE TABLE IF NOT EXISTS listes_sanctions_ppe (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source         TEXT NOT NULL,               -- ONU | UE | TRESOR_US | BCEAO | PPE_NATIONALE | INTERNE
    reference      TEXT,                        -- n° de liste / décision
    type_liste     TEXT NOT NULL DEFAULT 'SANCTIONS',  -- SANCTIONS | PPE | GEL_AVOIRS
    nom_complet    TEXT NOT NULL,
    nom_normalise  TEXT NOT NULL,
    alias_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
    date_naissance DATE,
    pays           TEXT,
    fonction       TEXT,
    actif          BOOLEAN NOT NULL DEFAULT true,
    mise_a_jour_le TIMESTAMPTZ NOT NULL DEFAULT now(),
    cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liste_nom_norm ON listes_sanctions_ppe (nom_normalise);
CREATE INDEX IF NOT EXISTS idx_liste_type     ON listes_sanctions_ppe (type_liste, actif);

CREATE TABLE IF NOT EXISTS kyc_criblage_resultats (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id      UUID,
    client_id      UUID REFERENCES client(id) ON DELETE CASCADE,
    entite_id      UUID REFERENCES kyb_entites_morales(id) ON DELETE CASCADE,
    sujet_type     TEXT NOT NULL,               -- CLIENT | BENEFICIAIRE_EFFECTIF | MANDATAIRE
    sujet_id       UUID,
    sujet_nom      TEXT,
    liste_id       UUID REFERENCES listes_sanctions_ppe(id) ON DELETE SET NULL,
    liste_source   TEXT,
    liste_type     TEXT,
    score_similarite NUMERIC(5,2) NOT NULL DEFAULT 0,
    verdict        TEXT NOT NULL DEFAULT 'CLAIR', -- CLAIR | A_VERIFIER | SUSPECT | CONFIRME
    decision       TEXT NOT NULL DEFAULT 'AUCUNE', -- AUCUNE | ECARTE | FAUX_POSITIF | CONFIRME
    decide_par     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decide_le      TIMESTAMPTZ,
    motif          TEXT,
    crible_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kyc_criblage_resultats ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE INDEX IF NOT EXISTS idx_criblage_client ON kyc_criblage_resultats (client_id, crible_le DESC);
CREATE INDEX IF NOT EXISTS idx_criblage_entite ON kyc_criblage_resultats (entite_id, crible_le DESC);

-- ===========================================================================
-- G. RESTRICTIONS DE CONFORMITÉ (ALERTE_KYC_EXPIRE…)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS kyc_restrictions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id      UUID,
    client_id      UUID REFERENCES client(id) ON DELETE CASCADE,
    entite_id      UUID REFERENCES kyb_entites_morales(id) ON DELETE CASCADE,
    code           TEXT NOT NULL,               -- ALERTE_KYC_EXPIRE | ALERTE_PPE_A_VALIDER | ALERTE_SANCTIONS | ALERTE_VISITE
    gravite        TEXT NOT NULL DEFAULT 'BLOQUANT',  -- INFO | ALERTE | BLOQUANT
    motif          TEXT NOT NULL,
    detail_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    levee_le       TIMESTAMPTZ,
    levee_par      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    motif_levee    TEXT,
    cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_restriction_active
  ON kyc_restrictions (imf_id, COALESCE(client_id,'00000000-0000-0000-0000-000000000000'::uuid),
                       COALESCE(entite_id,'00000000-0000-0000-0000-000000000000'::uuid), code)
  WHERE levee_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_restriction_client ON kyc_restrictions (client_id) WHERE levee_le IS NULL;

-- ===========================================================================
-- H. PARAMÉTRAGE CONFORMITÉ PAR IMF (+ référentiel par défaut)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conformite_parametres (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id                       UUID,
    -- Seuils opérationnels
    seuil_decaissement_visite_cents BIGINT NOT NULL DEFAULT 50000000,  -- 500 000 FCFA
    validite_visite_jours           INTEGER NOT NULL DEFAULT 30,
    precision_gps_max_m             INTEGER NOT NULL DEFAULT 30,
    distance_max_enrolement_m       INTEGER NOT NULL DEFAULT 100,
    -- Seuil de détection du criblage flou (0-100)
    seuil_criblage                  NUMERIC(5,2) NOT NULL DEFAULT 82,
    seuil_detention_be_pct          NUMERIC(5,2) NOT NULL DEFAULT 25,
    -- Revues périodiques (mois)
    revue_risque_eleve_mois         INTEGER NOT NULL DEFAULT 12,
    revue_risque_moyen_mois         INTEGER NOT NULL DEFAULT 36,
    revue_risque_faible_mois        INTEGER NOT NULL DEFAULT 60,
    -- Contrôle automatique quotidien
    tache_quotidienne_active        BOOLEAN NOT NULL DEFAULT true,
    maj_le                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    maj_par                         UUID REFERENCES app_user(id) ON DELETE SET NULL
);
ALTER TABLE conformite_parametres ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conformite_param_imf ON conformite_parametres (imf_id);

DO $$
DECLARE t UUID;
BEGIN
  FOR t IN SELECT id FROM imf LOOP
    IF NOT EXISTS (SELECT 1 FROM conformite_parametres WHERE imf_id = t) THEN
      INSERT INTO conformite_parametres (imf_id, tenant_id) VALUES (t, t);
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- I. HABILITATIONS (moindre privilège, séparation des tâches)
-- ===========================================================================
INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, sort_order) VALUES
 (NULL, 'conformite.kyc.read',    'Conformité - consulter le dossier KYC / KYB',            'Conformité', 'lecture',    true, 421),
 (NULL, 'conformite.kyc.write',   'Conformité - compléter et enregistrer un dossier KYC',    'Conformité', 'ecriture',   true, 422),
 (NULL, 'conformite.kyc.valider', 'Conformité - valider une évaluation KYC / KYB',           'Conformité', 'validation', true, 423),
 (NULL, 'conformite.ppe.declarer','Conformité - déclarer une PPE et lever un faux positif',  'Conformité', 'validation', true, 424),
 (NULL, 'conformite.visite',      'Conformité - réaliser et synchroniser une visite terrain', 'Conformité', 'ecriture',   true, 425),
 (NULL, 'conformite.parametrer',  'Conformité - paramétrer les seuils LBC/FT',                'Conformité', 'validation', true, 426)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed) VALUES
 (NULL, 'POS_RESP_CONF',  'conformite.kyc.read',     true),
 (NULL, 'POS_RESP_CONF',  'conformite.kyc.write',    true),
 (NULL, 'POS_RESP_CONF',  'conformite.kyc.valider',  true),
 (NULL, 'POS_RESP_CONF',  'conformite.ppe.declarer', true),
 (NULL, 'POS_RESP_CONF',  'conformite.visite',       true),
 (NULL, 'POS_AGENT_CR',     'conformite.kyc.read',     true),
 (NULL, 'POS_AGENT_CR',     'conformite.visite',       true),
 (NULL, 'POS_CHEF_AGENCE',      'conformite.kyc.read',     true),
 (NULL, 'POS_CHEF_AGENCE',      'conformite.kyc.write',    true),
 (NULL, 'POS_CHEF_AGENCE',      'conformite.visite',       true),
 (NULL, 'POS_DIR_CREDIT',       'conformite.kyc.read',     true),
 (NULL, 'POS_DIR_CREDIT',       'conformite.kyc.valider',  true),
 (NULL, 'POS_AUDIT_INT',         'conformite.kyc.read',     true),
 (NULL, 'POS_DG',      'conformite.kyc.read',     true),
 (NULL, 'POS_DG',      'conformite.ppe.declarer', true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- ===========================================================================
-- J. AUDIT
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_audit') THEN
    DROP TRIGGER IF EXISTS trg_audit_kyc_evaluations ON kyc_evaluations;
    CREATE TRIGGER trg_audit_kyc_evaluations AFTER INSERT OR UPDATE OR DELETE
      ON kyc_evaluations FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_kyb_entites ON kyb_entites_morales;
    CREATE TRIGGER trg_audit_kyb_entites AFTER INSERT OR UPDATE OR DELETE
      ON kyb_entites_morales FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_kyb_be ON kyb_beneficiaires_effectifs;
    CREATE TRIGGER trg_audit_kyb_be AFTER INSERT OR UPDATE OR DELETE
      ON kyb_beneficiaires_effectifs FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_kyb_mand ON kyb_mandataires_signataires;
    CREATE TRIGGER trg_audit_kyb_mand AFTER INSERT OR UPDATE OR DELETE
      ON kyb_mandataires_signataires FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_visites_terrain_kyc ON visites_terrain_kyc;
    CREATE TRIGGER trg_audit_visites_terrain_kyc AFTER INSERT OR UPDATE OR DELETE
      ON visites_terrain_kyc FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_kyc_restrictions ON kyc_restrictions;
    CREATE TRIGGER trg_audit_kyc_restrictions AFTER INSERT OR UPDATE OR DELETE
      ON kyc_restrictions FOR EACH ROW EXECUTE FUNCTION fn_audit();
  END IF;
END $$;

COMMIT;