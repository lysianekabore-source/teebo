-- =========================================================================
-- VAGUE 26 — Le Directeur General releve du PRESIDENT DU CONSEIL D'ADMINISTRATION.
--
-- Ajoute le poste « President du Conseil d'Administration » (PCA) au-dessus du
-- Directeur General. Le PCA ne depend de personne (sommet de l'organisation)
-- et ne dispose d'aucun droit d'operation : il est rattache a l'archetype
-- « office_staff » (consultation seulement) pour que le cloisonnement et la
-- separation des taches restent stricts (un administrateur ne manipule pas
-- la caisse ni la comptabilite).
--
-- Migration additive et reentrante : peut etre relancee sans risque.
-- =========================================================================

ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS parent_expected_label TEXT;
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS parent_expected_codes TEXT;

INSERT INTO role_catalog(role_key,label,dept_code,service_code,is_manager) VALUES
 ('office_staff','Support administratif','DG','DG_PILOTAGE',false)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO position_catalog
 (code,label,dept_code,service_code,role_key,hierarchy_level,validation_level,
  is_manager,can_supervise_collectors,needs_supervisor,sort_order,
  parent_expected_label,parent_expected_codes) VALUES
 ('POS_PCA','President du Conseil d''Administration','DG','DG_PILOTAGE','office_staff',100,0,false,false,false,0,NULL,NULL)
ON CONFLICT (code) DO NOTHING;

-- Le PCA reste au sommet et ne valide aucune operation financiere.
UPDATE position_catalog SET hierarchy_level=100, validation_level=0,
       is_manager=false, can_supervise_collectors=false, needs_supervisor=false,
       parent_expected_label=NULL, parent_expected_codes=NULL
 WHERE code='POS_PCA' AND imf_id IS NULL;

-- Le DG devient le subordonne du PCA (appellation attendue).
UPDATE position_catalog SET parent_expected_label='President du Conseil d''Administration',
       parent_expected_codes='POS_PCA'
 WHERE code='POS_DG' AND imf_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_position_catalog_parent ON position_catalog(code);
-- Harmonisation des appellations (vague 25) : libelle exact du poste, pour
-- que la comparaison cote interface (nom du poste) soit fiable.
UPDATE position_catalog SET parent_expected_label='Directeur Général'
 WHERE parent_expected_label='Directeur General' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable Sécurité des SI'
 WHERE parent_expected_label='Responsable Securite des SI (RSSI)' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur Financier'
 WHERE parent_expected_label='Directeur Financier (CFO)' AND imf_id IS NULL;

