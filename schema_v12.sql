-- =========================================================================
-- schema_v12 : Postes (positions) rattachés strictement aux départements et
--              services. Chaque utilisateur est lié à un poste (position_code)
--              qui détermine ses permissions par défaut (via un rôle-archetype)
--              et porte un niveau hiérarchique + un niveau de validation pour
--              les circuits d'approbation.
-- -------------------------------------------------------------------------
-- Migration ADDITIVE et réentrante. Ne touche pas aux rôles existants :
-- chaque poste « mappe » vers un rôle-archetype (table role_catalog / RBAC
-- schema_v11) qui fournit la matrice de permissions par verbe. L'autorité
-- d'approbation des circuits est portée par validation_level (indépendant du
-- verbe VALIDATE). Cloisonnement multi-tenant (imf_id) inchangé.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Nouvel archetype minimal 'office_staff' (support administratif).
-- -------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'user_role' AND e.enumlabel = 'office_staff'
    ) THEN
        ALTER TYPE user_role ADD VALUE 'office_staff';
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- 2. Services définitifs (nomenclature fournie par le client).
--    On ajoute les services détaillés ; les codes de référence précédents
--    restent (inoffensifs). Les directions métier (Direction Crédit, etc.)
--    sont matérialisées comme des « services » tête-de-département.
-- -------------------------------------------------------------------------
INSERT INTO service_catalog(code,dept_code,label,sort_order) VALUES
 ('COMP_BCEAO',       'COMPLIANCE','Réglementation BCEAO',                     1),
 ('COMP_DATA',        'COMPLIANCE','Protection des Données (LBA/FT & KYC)',    2),
 ('IT_SUPPORT',       'IT',        'Support & Infrastructures',               1),
 ('IT_CYBER',         'IT',        'Cybersécurité & Data IA',               2),
 ('CREDIT_DIR',       'CREDIT',    'Direction Crédit',                        0),
 ('CREDIT_ANALYSE',   'CREDIT',    'Analyse & Octroi',                        1),
 ('CREDIT_RECOUVT',   'CREDIT',    'Recouvrement & Contentieux',              2),
 ('OPS_DIR',          'OPS',       'Direction Opérations',                    0),
 ('OPS_CAISSE',       'OPS',       'Caisses & Guichets',                      1),
 ('OPS_CLIENT',       'OPS',       'Client & Canaux Digitaux',                2),
 ('FIN_DIR',          'FINANCE',   'Direction Finance',                       0),
 ('FIN_TRESO',        'FINANCE',   'Trésorerie & Réconciliation',           1),
 ('FIN_REPORTING',    'FINANCE',   'Reporting Réglementaire',                2),
 ('AUDIT_DIR',        'AUDIT',     'Direction Audit',                         0),
 ('AUDIT_PERMANENT',  'AUDIT',     'Contrôle Permanent',                     1),
 ('AUDIT_INSPECTION', 'AUDIT',     'Inspection & Anti-Fraude',                2),
 ('HR_DIR',           'HR',        'Direction Support',                       0),
 ('HR_PAIE',          'HR',        'Paie & Administration',                   1),
 ('HR_LOGISTIQUE',    'HR',        'Logistique & Patrimoine',                 2)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------------------------
-- 3. Catalogue des POSTES.
--    role_key      : archetype RBAC -> permissions par défaut (schema_v11).
--    hierarchy_level : rang hiérarchique (0..100, plus haut = plus senior).
--    validation_level: autorité d'approbation pour les circuits (0 = aucune).
--    can_supervise_collectors : peut être « Superviseur » d'un agent de collecte.
--    needs_supervisor         : doit être rattaché à un superviseur (collecte).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS position_catalog (
    code            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    dept_code       TEXT NOT NULL REFERENCES department_catalog(code) ON DELETE CASCADE,
    service_code    TEXT REFERENCES service_catalog(code) ON DELETE SET NULL,
    role_key        TEXT NOT NULL,       -- archetype RBAC (role_catalog)
    hierarchy_level INTEGER NOT NULL DEFAULT 0,
    validation_level INTEGER NOT NULL DEFAULT 0,
    is_manager      BOOLEAN NOT NULL DEFAULT false,
    can_supervise_collectors BOOLEAN NOT NULL DEFAULT false,
    needs_supervisor BOOLEAN NOT NULL DEFAULT false,
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_position_dept ON position_catalog(dept_code);

-- -------------------------------------------------------------------------
-- 4. Rattachement de l'utilisateur à un poste.
-- -------------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS position_code TEXT;
CREATE INDEX IF NOT EXISTS idx_user_position ON app_user(position_code);

-- Permission RBAC minimale de l'archetype 'office_staff'.
INSERT INTO rbac_rule(imf_id, role_key, resource, verb, scope) VALUES
 (NULL,'office_staff','reports','READ','department'),
 (NULL,'office_staff','org','READ','tenant')
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid),
             role_key, resource, verb) DO NOTHING;

INSERT INTO role_catalog(role_key,label,dept_code,service_code,is_manager) VALUES
 ('office_staff','Support administratif','DG','DG_PILOTAGE',false)
ON CONFLICT (role_key) DO NOTHING;

-- -------------------------------------------------------------------------
-- 5. Seed des POSTES (8 départements). (code,label,dept,service,role,
--    hierarchy_level,validation_level,is_manager,supervise_collectors,
--    needs_supervisor,sort_order)
-- -------------------------------------------------------------------------
INSERT INTO position_catalog
 (code,label,dept_code,service_code,role_key,hierarchy_level,validation_level,
  is_manager,can_supervise_collectors,needs_supervisor,sort_order) VALUES
 -- 1. Direction Générale
 ('POS_DG',        'Directeur Général (DG)',          'DG','DG_PILOTAGE','superadmin',100,100,true,false,false,1),
 ('POS_DGA',       'Directeur Général Adjoint (DGA)', 'DG','DG_PILOTAGE','superadmin', 95, 95,true,false,false,2),
 ('POS_ASSIST_DG', 'Assistante de Direction',          'DG','DG_PILOTAGE','office_staff',20,0,false,false,false,3),
 -- 2. Conformité & Juridique
 ('POS_RESP_CONF', 'Responsable Conformité',          'COMPLIANCE','COMP_BCEAO','compliance_officer',80,70,true,false,false,1),
 ('POS_JURISTE',   'Juriste Spécialiste Microfinance','COMPLIANCE','COMP_BCEAO','compliance_officer',60,0,false,false,false,2),
 ('POS_LBAFT',     'Analyste LBA/FT',                  'COMPLIANCE','COMP_DATA','compliance_officer',60,0,false,false,false,3),
 ('POS_DPO',       'DPO (Data Protection Officer)',    'COMPLIANCE','COMP_DATA','compliance_officer',60,40,false,false,false,4),
 -- 3. SI & Sécurité
 ('POS_ADMIN_SYS', 'Administrateur Système & Réseau','IT','IT_SUPPORT','it_admin',80,60,true,false,false,1),
 ('POS_TECH_SUP',  'Technicien Support Informatique',  'IT','IT_SUPPORT','it_admin',40,0,false,false,false,2),
 ('POS_RSSI',      'Responsable Sécurité des SI (RSSI)','IT','IT_CYBER','security_engineer',80,60,true,false,false,3),
 ('POS_DATA_SCI',  'Data Scientist',                   'IT','IT_CYBER','security_engineer',60,0,false,false,false,4),
 -- 4. Crédit & Engagement
 ('POS_DIR_CREDIT','Directeur du Crédit',             'CREDIT','CREDIT_DIR','credit_director',80,80,true,false,false,1),
 ('POS_CHEF_OCTROI','Chef de Service Octroi',          'CREDIT','CREDIT_ANALYSE','credit_director',70,70,true,false,false,2),
 ('POS_ANALYSTE_CR','Analyste de Crédit',             'CREDIT','CREDIT_ANALYSE','credit_analyst',60,0,false,false,false,3),
 ('POS_GEST_PORT', 'Gestionnaire de portefeuille',     'CREDIT','CREDIT_ANALYSE','credit_analyst',55,0,false,false,false,4),
 ('POS_AGENT_CR',  'Agent de Crédit',                 'CREDIT','CREDIT_ANALYSE','credit_analyst',50,0,false,true,false,5),
 ('POS_RESP_RECOUV','Responsable Recouvrement',        'CREDIT','CREDIT_RECOUVT','recovery_agent',70,60,true,false,false,6),
 ('POS_AGENT_RECOUV','Agent de Recouvrement',          'CREDIT','CREDIT_RECOUVT','recovery_agent',50,0,false,false,false,7),
 ('POS_CONTENTIEUX','Spécialiste Contentieux',        'CREDIT','CREDIT_RECOUVT','recovery_agent',55,0,false,false,false,8),
 -- 5. Opérations & Réseau
 ('POS_DIR_OPS',   'Directeur des Opérations / Réseau','OPS','OPS_DIR','operations_director',80,80,true,false,false,1),
 ('POS_CHEF_AGENCE','Chef d''Agence',                  'OPS','OPS_CAISSE','agency',70,60,true,true,false,2),
 ('POS_CHEF_CAISSE','Chef de Caisse',                  'OPS','OPS_CAISSE','teller',60,50,true,false,false,3),
 ('POS_CAISSIER',  'Caissier / Guichetier',            'OPS','OPS_CAISSE','teller',40,10,false,false,false,4),
 ('POS_GEST_CLIENT','Gestionnaire de Clientèle',      'OPS','OPS_CLIENT','customer_agent',50,0,false,false,false,5),
 ('POS_AGENT_DIGITAL','Agent Support Canaux Digitaux',  'OPS','OPS_CLIENT','customer_agent',40,0,false,false,false,6),
 ('POS_AGENT_COLLECTE','Agent de collecte',             'OPS','OPS_CLIENT','collectrice',30,0,false,false,true,7),
 -- 6. Finance, Comptabilité & Trésorerie
 ('POS_CFO',       'Directeur Financier (CFO)',        'FINANCE','FIN_DIR','cfo',80,80,true,false,false,1),
 ('POS_TRESORIER', 'Trésorier',                       'FINANCE','FIN_TRESO','treasurer',60,50,false,false,false,2),
 ('POS_ANALYSTE_MM','Analyste Flux Mobile Money',       'FINANCE','FIN_TRESO','treasurer',55,0,false,false,false,3),
 ('POS_CHEF_COMPTA','Chef Comptable',                   'FINANCE','FIN_REPORTING','accountant',65,60,true,false,false,4),
 ('POS_COMPTABLE', 'Comptable',                         'FINANCE','FIN_REPORTING','accountant',50,0,false,false,false,5),
 -- 7. Audit, Risques & Contrôle Interne
 ('POS_DIR_AUDIT', 'Directeur de l''Audit et des Risques','AUDIT','AUDIT_DIR','auditor',80,80,true,false,false,1),
 ('POS_CTRL_PERM', 'Contrôleur Permanent',            'AUDIT','AUDIT_PERMANENT','auditor',60,0,false,false,false,2),
 ('POS_AUDIT_INT', 'Auditeur Interne',                 'AUDIT','AUDIT_PERMANENT','auditor',60,0,false,false,false,3),
 ('POS_INSPECTEUR','Inspecteur',                        'AUDIT','AUDIT_INSPECTION','auditor',60,0,false,false,false,4),
 ('POS_FRAUDE',    'Analyste Fraude Technologique',     'AUDIT','AUDIT_INSPECTION','auditor',60,0,false,false,false,5),
 -- 8. Capital Humain & Moyens Généraux
 ('POS_DRH',       'Directeur RH & Logistique',        'HR','HR_DIR','hr_logistics_manager',80,80,true,false,false,1),
 ('POS_RESP_RH',   'Responsable RH',                   'HR','HR_PAIE','hr_logistics_manager',70,60,true,false,false,2),
 ('POS_GEST_PAIE', 'Gestionnaire de Paie',             'HR','HR_PAIE','hr_logistics_manager',50,0,false,false,false,3),
 ('POS_RESP_LOG',  'Responsable Logistique',           'HR','HR_LOGISTIQUE','hr_logistics_manager',70,50,true,false,false,4),
 ('POS_GEST_STOCK','Gestionnaire de Stock',            'HR','HR_LOGISTIQUE','hr_logistics_manager',45,0,false,false,false,5),
 ('POS_GEST_FLOTTE','Gestionnaire de la Flotte',       'HR','HR_LOGISTIQUE','hr_logistics_manager',45,0,false,false,false,6)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------------------------
-- 6. Règle de supervision des agents de collecte.
--    Un agent de collecte (needs_supervisor) doit être rattaché (parent_id)
--    à un utilisateur dont le poste peut superviser (Chef d'Agence OU Agent
--    de Crédit). Fonction de validation réutilisable côté application.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_position_can_supervise(p_position TEXT)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT can_supervise_collectors FROM position_catalog WHERE code = p_position), false);
$$;

CREATE OR REPLACE FUNCTION fn_position_needs_supervisor(p_position TEXT)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT needs_supervisor FROM position_catalog WHERE code = p_position), false);
$$;
