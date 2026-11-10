-- =========================================================================
-- schema_v13 : Habilitations ÉDITABLES par l'administrateur IMF.
-- -------------------------------------------------------------------------
--  1. permission_catalog     : catalogue d'habilitations GLOBAL (imf_id NULL)
--                              + habilitations CUSTOM créées par une IMF.
--  2. position_catalog (ext.) : postes/profils CUSTOM par IMF (imf_id).
--  3. position_default_permission : habilitations par défaut d'un poste,
--                              cochables / décochables par l'admin IMF
--                              (surcharge par imf_id, défaut global imf_id NULL).
--  4. Habilitation 'credit.validate_final' : garde l'écran de VALIDATION
--                              FINALE du crédit, réservée par défaut aux postes
--                              DG / DGA / Directeur Crédit / Chef Octroi,
--                              réaffectable librement par l'admin IMF.
-- -------------------------------------------------------------------------
-- Migration ADDITIVE et réentrante. Cloisonnement multi-tenant (imf_id)
-- inchangé. Aucune migration de données destructive.
-- =========================================================================

DO $$ BEGIN PERFORM 1; END $$;

-- -------------------------------------------------------------------------
-- 1. Catalogue des habilitations (global + custom par IMF).
--    imf_id NULL        -> habilitation GLOBALE (socle livré par teebo).
--    imf_id = <uuid>    -> habilitation CUSTOM, visible par cette IMF seule.
--    is_system = true   -> habilitation du socle, non supprimable par l'IMF.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permission_catalog (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id         UUID REFERENCES imf(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    label          TEXT NOT NULL,
    category       TEXT NOT NULL DEFAULT 'Habilitations supplémentaires',
    is_system      BOOLEAN NOT NULL DEFAULT false,
    created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    sort_order     INTEGER NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unicité d'une clé dans son périmètre (global OU une IMF donnée).
CREATE UNIQUE INDEX IF NOT EXISTS uq_permcat_scope
  ON permission_catalog(COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key);
CREATE INDEX IF NOT EXISTS idx_permcat_imf ON permission_catalog(imf_id);

-- Seed du socle d'habilitations GLOBALES (aligné sur permissions.js).
INSERT INTO permission_catalog(imf_id,permission_key,label,category,is_system,sort_order) VALUES
 (NULL,'org.manage',          'Organisation — créer / supprimer des unités','Pilotage',          true, 1),
 (NULL,'users.manage',        'Personnel — créer des comptes & envoyer les codes','Pilotage',      true, 2),
 (NULL,'settings.manage',     'Paramètres IMF & mentions légales','Pilotage',                      true, 3),
 (NULL,'visibility.manage',   'Autorisations fines inter-entités','Pilotage',                     true, 4),
 (NULL,'objectives.set',      'Objectifs — créer / répartir','Objectifs',                          true, 5),
 (NULL,'objectives.dashboard','Objectifs — tableau de bord équipe','Objectifs',                   true, 6),
 (NULL,'objectives.read',     'Objectifs — consulter','Objectifs',                               true, 7),
 (NULL,'clients.enroll',      'Enrôlement des clients','Terrain',                                 true, 8),
 (NULL,'round.view',          'Tournée du jour (collecte)','Terrain',                             true, 9),
 (NULL,'cash.declare',        'Déclaration des versements','Caisse',                             true, 10),
 (NULL,'cash.validate',       'Validation des versements','Caisse',                              true, 11),
 (NULL,'reports.read',        'Consultation des relevés & rapports','Rapports',                   true, 12),
 (NULL,'credit.validate_final','Crédit — écran de VALIDATION FINALE (octroi)','Crédit',         true, 13)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

-- -------------------------------------------------------------------------
-- 2. Postes/profils CUSTOM par IMF : on étend position_catalog (schema_v12).
--    imf_id NULL  -> poste du socle (livré par teebo, 44 postes v12).
--    imf_id set   -> poste CUSTOM créé par l'admin de cette IMF.
-- -------------------------------------------------------------------------
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS imf_id     UUID REFERENCES imf(id) ON DELETE CASCADE;
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS is_custom  BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_position_imf ON position_catalog(imf_id);

-- -------------------------------------------------------------------------
-- 3. Habilitations par DÉFAUT d'un poste, cochables/décochables par l'admin.
--    imf_id NULL  -> défaut GLOBAL (socle). imf_id set -> SURCHARGE par IMF.
--    L'effectif d'un poste pour une IMF = surcharge IMF si présente,
--    sinon défaut global.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS position_default_permission (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id         UUID REFERENCES imf(id) ON DELETE CASCADE,
    position_code  TEXT NOT NULL,
    permission_key TEXT NOT NULL,
    allowed        BOOLEAN NOT NULL DEFAULT true,
    updated_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_posdefperm
  ON position_default_permission(COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key);
CREATE INDEX IF NOT EXISTS idx_posdefperm_imf ON position_default_permission(imf_id, position_code);

-- -------------------------------------------------------------------------
-- 4. Défaut GLOBAL : qui peut ouvrir l'écran de VALIDATION FINALE du crédit.
--    Réservé par défaut à DG / DGA / Directeur Crédit / Chef de Service Octroi.
--    Réaffectable librement par l'admin IMF (surcharge imf_id).
-- -------------------------------------------------------------------------
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 (NULL,'POS_DG',        'credit.validate_final', true),
 (NULL,'POS_DGA',       'credit.validate_final', true),
 (NULL,'POS_DIR_CREDIT','credit.validate_final', true),
 (NULL,'POS_CHEF_OCTROI','credit.validate_final',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- -------------------------------------------------------------------------
-- 5. Source 'position' pour user_permission (habilitation issue d'un poste).
--    Colonne source déjà présente (schema_v7). Pas de modification d'enum :
--    'source' est un TEXT libre ('default' | 'custom' | 'position').
-- -------------------------------------------------------------------------

-- -------------------------------------------------------------------------
-- 6. Fonction : habilitations par défaut effectives d'un poste pour une IMF.
--    Renvoie la liste des permission_key allowed=true (surcharge IMF
--    prioritaire sur le défaut global).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_position_default_perms(p_imf UUID, p_position TEXT)
RETURNS TABLE(permission_key TEXT) LANGUAGE sql STABLE AS $$
  WITH eff AS (
    SELECT DISTINCT ON (pdp.permission_key) pdp.permission_key, pdp.allowed
      FROM position_default_permission pdp
     WHERE pdp.position_code = p_position
       AND (pdp.imf_id = p_imf OR pdp.imf_id IS NULL)
     ORDER BY pdp.permission_key, (pdp.imf_id IS NOT NULL) DESC
  )
  SELECT permission_key FROM eff WHERE allowed = true;
$$;
