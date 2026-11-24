-- =========================================================================
-- VAGUE 25 — Responsable hierarchique par APPELLATION DE POSTE.
--
-- Chaque poste occupe porte l'APPELLATION de son superieur direct :
--   Directeur General Adjoint -> Directeur General
--   Chef de Caisse           -> Chef d'Agence
--   Agent de collecte        -> Chef d'Agence (ou Agent de credit)
--   Directeur General        -> (aucun : sommet de l'organisation)
-- L'interface pre-remplit alors le champ "Superviseur / Responsable
-- hierarchique" avec la bonne appellation (modifiable).
--
-- parent_expected_label = appellation attendue ; parent_expected_codes = codes
-- de postes acceptes (separes par des virgules), le plus prioritaire d'abord.
-- =========================================================================
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS parent_expected_label TEXT;
ALTER TABLE position_catalog ADD COLUMN IF NOT EXISTS parent_expected_codes TEXT;

UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG'
 WHERE code='POS_DGA' AND imf_id IS NULL AND parent_expected_label IS NULL;

-- Direction Generale
UPDATE position_catalog SET parent_expected_label='Directeur General Adjoint',
       parent_expected_codes='POS_DGA,POS_DG'
 WHERE code='POS_ASSIST_DG' AND imf_id IS NULL;
-- Conformite
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG,POS_DIR_AUDIT'
 WHERE code='POS_RESP_CONF' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable Conformite',
       parent_expected_codes='POS_RESP_CONF'
 WHERE code IN ('POS_JURISTE','POS_LBAFT','POS_DPO') AND imf_id IS NULL;
-- Systeme d'information
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG'
 WHERE code='POS_ADMIN_SYS' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Administrateur Systeme & Reseau',
       parent_expected_codes='POS_ADMIN_SYS'
 WHERE code='POS_TECH_SUP' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG'
 WHERE code='POS_RSSI' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable Sécurité des SI',
       parent_expected_codes='POS_RSSI'
 WHERE code='POS_DATA_SCI' AND imf_id IS NULL;
-- Credit
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG,POS_DGA'
 WHERE code='POS_DIR_CREDIT' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur du Credit',
       parent_expected_codes='POS_DIR_CREDIT'
 WHERE code='POS_CHEF_OCTROI' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef de Service Octroi',
       parent_expected_codes='POS_CHEF_OCTROI,POS_DIR_CREDIT'
 WHERE code IN ('POS_ANALYSTE_CR','POS_GEST_PORT') AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef d''Agence',
       parent_expected_codes='POS_CHEF_AGENCE,POS_CHEF_OCTROI'
 WHERE code='POS_AGENT_CR' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur du Credit',
       parent_expected_codes='POS_DIR_CREDIT'
 WHERE code='POS_RESP_RECOUV' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable Recouvrement',
       parent_expected_codes='POS_RESP_RECOUV'
 WHERE code IN ('POS_AGENT_RECOUV','POS_CONTENTIEUX') AND imf_id IS NULL;
-- Operations & Reseau
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG,POS_DGA'
 WHERE code='POS_DIR_OPS' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur des Operations / Reseau',
       parent_expected_codes='POS_DIR_OPS'
 WHERE code='POS_CHEF_AGENCE' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef d''Agence',
       parent_expected_codes='POS_CHEF_AGENCE'
 WHERE code IN ('POS_CHEF_CAISSE','POS_GEST_CLIENT','POS_AGENT_DIGITAL') AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef de Caisse',
       parent_expected_codes='POS_CHEF_CAISSE,POS_CHEF_AGENCE'
 WHERE code='POS_CAISSIER' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef d''Agence',
       parent_expected_codes='POS_CHEF_AGENCE,POS_AGENT_CR'
 WHERE code='POS_AGENT_COLLECTE' AND imf_id IS NULL;
-- Finance
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG,POS_DGA'
 WHERE code='POS_CFO' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur Financier',
       parent_expected_codes='POS_CFO'
 WHERE code IN ('POS_TRESORIER','POS_ANALYSTE_MM','POS_CHEF_COMPTA') AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Chef Comptable',
       parent_expected_codes='POS_CHEF_COMPTA'
 WHERE code='POS_COMPTABLE' AND imf_id IS NULL;
-- Audit
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG'
 WHERE code='POS_DIR_AUDIT' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur de l''Audit et des Risques',
       parent_expected_codes='POS_DIR_AUDIT'
 WHERE code IN ('POS_CTRL_PERM','POS_AUDIT_INT','POS_INSPECTEUR','POS_FRAUDE') AND imf_id IS NULL;
-- Ressources humaines
UPDATE position_catalog SET parent_expected_label='Directeur Général',
       parent_expected_codes='POS_DG,POS_DGA'
 WHERE code='POS_DRH' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Directeur RH & Logistique',
       parent_expected_codes='POS_DRH'
 WHERE code IN ('POS_RESP_RH','POS_RESP_LOG') AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable RH',
       parent_expected_codes='POS_RESP_RH'
 WHERE code='POS_GEST_PAIE' AND imf_id IS NULL;
UPDATE position_catalog SET parent_expected_label='Responsable Logistique',
       parent_expected_codes='POS_RESP_LOG'
 WHERE code IN ('POS_GEST_STOCK','POS_GEST_FLOTTE') AND imf_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_position_catalog_parent ON position_catalog(code);
