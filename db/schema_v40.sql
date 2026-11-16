-- ===========================================================================
-- teebo — VAGUE 40 : SCORING DE CRÉDIT ALTERNATIF (SECTEUR INFORMEL)
-- ===========================================================================
-- Objectif : noter un emprunteur qui n'a PAS d'historique bancaire, à partir
-- des traces laissées dans le système : épargne, tontines, flux de collecte
-- (Mobile Money + espèces), stabilité du lieu relevé par GPS, historique de
-- crédit et garanties. Tout est explicable : on garde le détail des cinq
-- piliers, pas seulement une note.
--
-- Contenu (100 % ADDITIF, réexécutable sans perte de données) :
--   A. Ligne de base si elle n'existe pas encore (savings_product, account)
--      puis ALTER ADD COLUMN IF NOT EXISTS : le fichier peut donc tourner sur
--      une base ancienne comme sur une base récente.
--   B. Grilles de scoring : pondérations des 5 piliers (somme = 100),
--      seuils de classe A/B/C/D, taux d'effort maximal, plafond de garantie
--      exigé. Une grille par produit de crédit, ou une grille par défaut
--      pour l'IMF (produit_id NULL).
--   C. Évaluations : une ligne par calcul (jamais écrasée), avec score_global,
--      classe_risque, plafond_montant_suggere_cents et le détail JSON des
--      indicateurs. Cloisonnée par imf_id + tenant_id.
--   D. Référentiel par défaut : pondérations 30 / 25 / 20 / 15 / 10 pour les
--      IMF qui n'ont encore aucune grille.
--   E. Habilitations : consulter un score, recalculer un score, paramétrer
--      les grilles (réservé au pilotage : ce ne sont pas les mêmes mains qui
--      notent et qui décident).
--   F. Audit (trigger standard fn_audit) : toute modification de grille est
--      tracée, en lecture seule pour les contrôleurs.
--
-- Aucune table n'est supprimée, aucune colonne existante n'est renommée.
-- Aucune donnée métier n'est modifiée par ce fichier.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- A. LIGNE DE BASE (sécurise les clés étrangères sur base ancienne)
-- ===========================================================================
-- Les tables ci-dessous existent depuis les vagues 1/37/38. Le CREATE
-- IF NOT EXISTS ne fait rien si elles sont déjà là ; il évite seulement un
-- échec si le fichier est appliqué sur une base qui ne les aurait pas.
CREATE TABLE IF NOT EXISTS savings_product (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    code            TEXT NOT NULL,
    libelle         TEXT,
    actif           BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    code_account        TEXT,
    balance_cents       BIGINT NOT NULL DEFAULT 0,
    currency            CHAR(3) NOT NULL DEFAULT 'XOF',
    status              TEXT NOT NULL DEFAULT 'active',
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE account ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE account ADD COLUMN IF NOT EXISTS product_code TEXT;
ALTER TABLE account ADD COLUMN IF NOT EXISTS solde_bloque_cents BIGINT NOT NULL DEFAULT 0;

-- Colonnes de contexte utilisées par le moteur (elles existent déjà en
-- pratique ; on les garantit pour que les requêtes du score ne cassent pas).
ALTER TABLE client ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(9,6);
ALTER TABLE client ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(9,6);
ALTER TABLE client ADD COLUMN IF NOT EXISTS gps_accuracy_m NUMERIC(7,2);
ALTER TABLE client ADD COLUMN IF NOT EXISTS gps_captured_at TIMESTAMPTZ;

ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS activite TEXT;
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS jours_retard INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS classe_creance TEXT NOT NULL DEFAULT 'SAIN';
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS solde_capital_cents BIGINT NOT NULL DEFAULT 0;
-- Avis de la Centrale des Risques / BIC UEMOA : saisi À LA MAIN par l'analyste
-- (aucune interconnexion automatique). NULL = non disponible.
ALTER TABLE dossiers_credit ADD COLUMN IF NOT EXISTS avis_bic_uemoa CHAR(1);
ALTER TABLE dossiers_credit DROP CONSTRAINT IF EXISTS chk_dossier_avis_bic;
ALTER TABLE dossiers_credit ADD CONSTRAINT chk_dossier_avis_bic
  CHECK (avis_bic_uemoa IS NULL OR avis_bic_uemoa IN ('A', 'B', 'C', 'D'));

ALTER TABLE garanties_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- ===========================================================================
-- B. GRILLES DE SCORING
-- ===========================================================================
-- Pondérations en pourcentage entier (5 colonnes) : la somme doit valoir 100.
-- Les seuils de classe sont les notes minimales pour obtenir A, B, C ;
-- en dessous du seuil C, la classe est D (« à ne pas financer en l'état »).
CREATE TABLE IF NOT EXISTS grilles_scoring_credit (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id                   UUID,
    code                        TEXT NOT NULL,
    libelle                     TEXT NOT NULL,
    produit_id                  UUID REFERENCES produits_credit(id) ON DELETE CASCADE,
      -- NULL = grille par défaut de l'IMF (produits sans grille dédiée)
    -- Les 5 piliers (en % du score global, somme = 100)
    poids_epargne               INTEGER NOT NULL DEFAULT 30,
    poids_flux                  INTEGER NOT NULL DEFAULT 25,
    poids_stabilite_gps         INTEGER NOT NULL DEFAULT 20,
    poids_historique            INTEGER NOT NULL DEFAULT 15,
    poids_garanties             INTEGER NOT NULL DEFAULT 10,
    -- Seuils de classe_risque (score sur 100)
    seuil_classe_a              INTEGER NOT NULL DEFAULT 75,
    seuil_classe_b              INTEGER NOT NULL DEFAULT 60,
    seuil_classe_c              INTEGER NOT NULL DEFAULT 45,
    -- Règles métier
    taux_effort_max_bp          INTEGER NOT NULL DEFAULT 3500,   -- 35 % du revenu net
    plafond_epargne_bp          INTEGER NOT NULL DEFAULT 3000,   -- 30 % du montant couverts par l'épargne
    plafond_tontine_bp          INTEGER NOT NULL DEFAULT 8000,   -- 80 % sur cycles tontine complets
    plafond_score_bp            INTEGER NOT NULL DEFAULT 13000,  -- note 100 → 130 % du montant demandé
    plafond_garantie_bp         INTEGER NOT NULL DEFAULT 10000,  -- garanties exigées au minimum
    couverture_min_bp           INTEGER NOT NULL DEFAULT 5000,   -- garanties ≥ 50 % pour classe A/B
    stabilite_min_m             INTEGER NOT NULL DEFAULT 50,     -- rayon GPS accepté (mètres)
    nb_visites_min              INTEGER NOT NULL DEFAULT 3,
    epargne_min_mois            INTEGER NOT NULL DEFAULT 3,
    actif                       BOOLEAN NOT NULL DEFAULT true,
    version                     INTEGER NOT NULL DEFAULT 1,
    created_by                  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_by                  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_grille_poids_somme CHECK (
      poids_epargne + poids_flux + poids_stabilite_gps + poids_historique + poids_garanties = 100),
    CONSTRAINT chk_grille_poids_positifs CHECK (
      poids_epargne >= 0 AND poids_flux >= 0 AND poids_stabilite_gps >= 0
      AND poids_historique >= 0 AND poids_garanties >= 0),
    CONSTRAINT chk_grille_seuils CHECK (
      seuil_classe_a > seuil_classe_b AND seuil_classe_b > seuil_classe_c
      AND seuil_classe_c > 0 AND seuil_classe_a <= 100),
    CONSTRAINT chk_grille_effort CHECK (taux_effort_max_bp BETWEEN 500 AND 8000)
);

ALTER TABLE grilles_scoring_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE grilles_scoring_credit ADD COLUMN IF NOT EXISTS produit_id UUID REFERENCES produits_credit(id) ON DELETE CASCADE;

-- Repli : tenant_id = imf_id (jamais l'inverse), puis NOT NULL quand c'est possible.
UPDATE grilles_scoring_credit SET tenant_id = imf_id WHERE tenant_id IS NULL;

-- Une seule grille par produit et par IMF, et une seule grille par défaut.
CREATE UNIQUE INDEX IF NOT EXISTS uq_grille_scoring_produit
  ON grilles_scoring_credit (imf_id, produit_id) WHERE produit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_grille_scoring_defaut
  ON grilles_scoring_credit (imf_id) WHERE produit_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_grille_scoring_tenant ON grilles_scoring_credit (tenant_id);

-- ===========================================================================
-- C. ÉVALUATIONS (historique du score : on n'écrase jamais une décision)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS evaluations_scoring_credit (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id                   UUID,
    dossier_credit_id           UUID NOT NULL REFERENCES dossiers_credit(id) ON DELETE CASCADE,
    grille_id                   UUID REFERENCES grilles_scoring_credit(id) ON DELETE SET NULL,
    -- Résultat
    score_global                NUMERIC(5,2) NOT NULL CHECK (score_global >= 0 AND score_global <= 100),
    classe_risque               TEXT NOT NULL,
    plafond_montant_suggere_cents BIGINT NOT NULL DEFAULT 0,
    montant_demande_cents       BIGINT NOT NULL DEFAULT 0,
    -- Détail explicable : points par pilier, indicateurs bruts, alertes.
    details_indicateurs_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Traçabilité
    declencheur                 TEXT NOT NULL DEFAULT 'MANUEL',
      -- EN_ANALYSE | MANUEL | COMITE | OUTIL
    calcule_le                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    calcule_par                 UUID REFERENCES app_user(id) ON DELETE SET NULL,
    duree_ms                    INTEGER
);
ALTER TABLE evaluations_scoring_credit ADD COLUMN IF NOT EXISTS tenant_id UUID;

ALTER TABLE evaluations_scoring_credit DROP CONSTRAINT IF EXISTS chk_eval_classe;
ALTER TABLE evaluations_scoring_credit ADD CONSTRAINT chk_eval_classe
  CHECK (classe_risque IN ('A', 'B', 'C', 'D'));
ALTER TABLE evaluations_scoring_credit DROP CONSTRAINT IF EXISTS chk_eval_declencheur;
ALTER TABLE evaluations_scoring_credit ADD CONSTRAINT chk_eval_declencheur
  CHECK (declencheur IN ('EN_ANALYSE', 'MANUEL', 'COMITE', 'OUTIL'));

UPDATE evaluations_scoring_credit SET tenant_id = imf_id WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_eval_scoring_dossier
  ON evaluations_scoring_credit (imf_id, dossier_credit_id, calcule_le DESC);
CREATE INDEX IF NOT EXISTS idx_eval_scoring_tenant
  ON evaluations_scoring_credit (tenant_id, calcule_le DESC);

-- ===========================================================================
-- D. GARDE-FOUS DE COHÉRENCE (imf_id = tenant_id, comme la vague 37)
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_tenant_sync') THEN
    CREATE OR REPLACE FUNCTION fn_tenant_sync() RETURNS TRIGGER AS $f$
    BEGIN
      IF NEW.tenant_id IS NULL THEN NEW.tenant_id := NEW.imf_id; END IF;
      IF NEW.imf_id IS NULL THEN NEW.imf_id := NEW.tenant_id; END IF;
      IF NEW.tenant_id IS DISTINCT FROM NEW.imf_id THEN
        RAISE EXCEPTION 'tenant_incoherent: tenant_id (%) doit être égal à imf_id (%) sur %',
          NEW.tenant_id, NEW.imf_id, TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END; $f$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tenant_sync ON grilles_scoring_credit;
CREATE TRIGGER trg_tenant_sync BEFORE INSERT OR UPDATE ON grilles_scoring_credit
  FOR EACH ROW EXECUTE FUNCTION fn_tenant_sync();
DROP TRIGGER IF EXISTS trg_tenant_sync ON evaluations_scoring_credit;
CREATE TRIGGER trg_tenant_sync BEFORE INSERT OR UPDATE ON evaluations_scoring_credit
  FOR EACH ROW EXECUTE FUNCTION fn_tenant_sync();

-- Audit : chaque changement de grille ou de score est journalisé.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_audit') THEN
    DROP TRIGGER IF EXISTS trg_audit_grille_scoring ON grilles_scoring_credit;
    CREATE TRIGGER trg_audit_grille_scoring AFTER INSERT OR UPDATE OR DELETE
      ON grilles_scoring_credit FOR EACH ROW EXECUTE FUNCTION fn_audit();
    DROP TRIGGER IF EXISTS trg_audit_eval_scoring ON evaluations_scoring_credit;
    CREATE TRIGGER trg_audit_eval_scoring AFTER INSERT OR UPDATE OR DELETE
      ON evaluations_scoring_credit FOR EACH ROW EXECUTE FUNCTION fn_audit();
  END IF;
END $$;

-- ===========================================================================
-- E. HABILITATIONS (moindre privilège, séparation des tâches)
-- ===========================================================================
INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, sort_order) VALUES
 (NULL, 'credit.scoring.read',     'Crédit - consulter le score et son explication',        'Crédit', 'lecture',    true, 411),
 (NULL, 'credit.scoring.recalculer','Crédit - recalculer le score d''un dossier',          'Crédit', 'ecriture',   true, 412),
 (NULL, 'credit.scoring.parametrer','Crédit - paramétrer les grilles de scoring',          'Crédit', 'validation', true, 413)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed) VALUES
 (NULL, 'POS_AGENT_CREDIT',    'credit.scoring.read',       true),
 (NULL, 'POS_AGENT_CREDIT',    'credit.scoring.recalculer', true),
 (NULL, 'POS_CHEF_AGENCE',     'credit.scoring.read',       true),
 (NULL, 'POS_CHEF_AGENCE',     'credit.scoring.recalculer', true),
 (NULL, 'POS_DIR_CREDIT',      'credit.scoring.read',       true),
 (NULL, 'POS_DIR_CREDIT',      'credit.scoring.recalculer', true),
 (NULL, 'POS_DIR_CREDIT',      'credit.scoring.parametrer', true),
 (NULL, 'POS_ANALYSTE',        'credit.scoring.read',       true),
 (NULL, 'POS_ANALYSTE',        'credit.scoring.recalculer', true),
 (NULL, 'POS_AUDITEUR',        'credit.scoring.read',       true),
 (NULL, 'POS_AUDITEUR_INTERNE','credit.scoring.read',       true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- ===========================================================================
-- F. GRILLE PAR DÉFAUT 30 / 25 / 20 / 15 / 10 (jamais écrasée)
-- ===========================================================================
-- On la crée UNIQUEMENT pour une IMF qui n'a encore aucune grille : un
-- paramétrage existant reste intact.
DO $$
DECLARE t UUID;
BEGIN
  FOR t IN SELECT id FROM imf LOOP
    IF NOT EXISTS (SELECT 1 FROM grilles_scoring_credit WHERE imf_id = t) THEN
      INSERT INTO grilles_scoring_credit
        (imf_id, tenant_id, code, libelle, produit_id,
         poids_epargne, poids_flux, poids_stabilite_gps, poids_historique, poids_garanties,
         seuil_classe_a, seuil_classe_b, seuil_classe_c, version)
      VALUES
        (t, t, 'SCORING_INFORMEL_STD',
         'Score secteur informel (standard)', NULL,
         30, 25, 20, 15, 10, 75, 60, 45, 1);
    END IF;
  END LOOP;
END $$;

COMMIT;
