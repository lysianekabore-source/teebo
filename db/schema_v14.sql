-- =========================================================================
-- schema_v14 : MATRICE COMPLÈTE des habilitations (lecture / écriture /
--              validation) pour TOUS les postes/profils du socle.
-- -------------------------------------------------------------------------
--  Objectif : couvrir le MAXIMUM d'actions/fonctionnalités de teebo et
--  attribuer à chaque poste un jeu d'habilitations par défaut cohérent avec
--  son niveau hiérarchique et son métier. Chaque habilitation porte un
--  « access_kind » : lecture | ecriture | validation.
--
--  Tout est ADDITIF et réentrant (ON CONFLICT DO NOTHING / IF NOT EXISTS).
--  Les défauts sont GLOBAUX (imf_id NULL) ; chaque IMF peut les surcharger
--  (position_default_permission.imf_id), sans toucher au socle.
-- =========================================================================

DO $$ BEGIN PERFORM 1; END $$;

-- 1. Nature de l'habilitation (droit de lecture/écriture/validation).
ALTER TABLE permission_catalog ADD COLUMN IF NOT EXISTS access_kind TEXT NOT NULL DEFAULT 'ecriture';

-- 2. Qualifier le socle existant (schema_v13).
UPDATE permission_catalog SET access_kind = v.k FROM (VALUES
  ('org.manage','ecriture'),('users.manage','ecriture'),('settings.manage','ecriture'),
  ('visibility.manage','validation'),('objectives.set','ecriture'),
  ('objectives.dashboard','lecture'),('objectives.read','lecture'),
  ('clients.enroll','ecriture'),('round.view','lecture'),('cash.declare','ecriture'),
  ('cash.validate','validation'),('reports.read','lecture'),
  ('credit.validate_final','validation')
) AS v(key,k)
 WHERE permission_catalog.imf_id IS NULL AND permission_catalog.permission_key = v.key;

-- 3. Habilitations supplémentaires du socle (couverture maximale).
INSERT INTO permission_catalog(imf_id,permission_key,label,category,access_kind,is_system,sort_order) VALUES
 (NULL,'org.read',          'Organisation — consulter la structure','Pilotage','lecture',true,20),
 (NULL,'users.read',        'Personnel — consulter les comptes','Pilotage','lecture',true,21),
 (NULL,'access.manage',     'Habilitations & profils — gérer','Pilotage','ecriture',true,22),
 (NULL,'audit.read',        'Journal d''audit — consulter','Pilotage','lecture',true,23),
 (NULL,'clients.read',      'Clients — consulter','Clients','lecture',true,30),
 (NULL,'clients.manage',    'Clients — modifier / affecter','Clients','ecriture',true,31),
 (NULL,'clients.freeze',    'Clients — geler / dégeler un compte','Clients','validation',true,32),
 (NULL,'round.manage',      'Tournée — planifier / pointer les visites','Terrain','ecriture',true,40),
 (NULL,'cash.approve',      'Reversement — approuver (caisse collectrice)','Caisse','validation',true,41),
 (NULL,'collecte.assign',   'Collecte — affecter superviseur / collectrice','Terrain','ecriture',true,42),
 (NULL,'collecte.supervise','Collecte — rapports de caisse remontés','Terrain','lecture',true,43),
 (NULL,'savings.read',      'Épargne — consulter les produits','Épargne & Opérations','lecture',true,50),
 (NULL,'savings.manage',    'Épargne — créer / gérer les produits','Épargne & Opérations','ecriture',true,51),
 (NULL,'operations.read',   'Opérations — consulter','Épargne & Opérations','lecture',true,52),
 (NULL,'operations.write',  'Opérations — saisir dépôts / retraits','Épargne & Opérations','ecriture',true,53),
 (NULL,'operations.validate','Opérations — valider / annuler','Épargne & Opérations','validation',true,54),
 (NULL,'accounts.manage',   'Comptes — ouvrir / clôturer','Épargne & Opérations','ecriture',true,55),
 (NULL,'fees.manage',       'Frais — arrêtés mensuels / recouvrement','Épargne & Opérations','validation',true,56),
 (NULL,'credit.read',       'Crédit — consulter les dossiers','Crédit','lecture',true,60),
 (NULL,'credit.initiate',   'Crédit — initier / instruire un dossier','Crédit','ecriture',true,61),
 (NULL,'credit.process',    'Crédit — étude / approbation intermédiaire','Crédit','ecriture',true,62),
 (NULL,'credit.recovery',   'Crédit — recouvrement & contentieux','Crédit','ecriture',true,63),
 (NULL,'reports.export',    'Rapports — exporter (Excel / BCEAO / PDF)','Rapports & Conformité','ecriture',true,70),
 (NULL,'compliance.read',   'Conformité / LBA-FT — consulter','Rapports & Conformité','lecture',true,71),
 (NULL,'compliance.manage', 'Conformité / LBA-FT — gérer','Rapports & Conformité','validation',true,72),
 (NULL,'devices.read',      'Terminaux — consulter','Sécurité & SI','lecture',true,80),
 (NULL,'devices.manage',    'Terminaux — révoquer / réactiver','Sécurité & SI','validation',true,81),
 (NULL,'security.read',     'Alertes de sécurité — consulter','Sécurité & SI','lecture',true,82)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

-- 4. Mise à jour de la catégorie des habilitations objectifs (regroupement).
UPDATE permission_catalog SET category='Objectifs'
 WHERE imf_id IS NULL AND permission_key IN ('objectives.set','objectives.dashboard','objectives.read');

-- =========================================================================
-- 5. MATRICE PAR DÉFAUT : habilitations accordées à chaque poste (allowed=true).
--    L'absence de ligne = habilitation NON accordée par défaut.
-- =========================================================================

-- 5.1 Direction Générale (DG / DGA) : accès complet (toutes habilitations).
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed)
 SELECT NULL, p.code, pc.permission_key, true
   FROM (VALUES ('POS_DG'),('POS_DGA')) AS p(code)
   CROSS JOIN permission_catalog pc
  WHERE pc.imf_id IS NULL
 ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.2 Autres postes : jeu explicite (lecture/écriture/validation).
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 -- Assistante de Direction (consultation large)
 (NULL,'POS_ASSIST_DG','org.read',true),(NULL,'POS_ASSIST_DG','users.read',true),
 (NULL,'POS_ASSIST_DG','clients.read',true),(NULL,'POS_ASSIST_DG','reports.read',true),
 (NULL,'POS_ASSIST_DG','objectives.read',true),(NULL,'POS_ASSIST_DG','audit.read',true),
 -- Responsable Conformité
 (NULL,'POS_RESP_CONF','org.read',true),(NULL,'POS_RESP_CONF','users.read',true),
 (NULL,'POS_RESP_CONF','reports.read',true),(NULL,'POS_RESP_CONF','reports.export',true),
 (NULL,'POS_RESP_CONF','audit.read',true),(NULL,'POS_RESP_CONF','compliance.read',true),
 (NULL,'POS_RESP_CONF','compliance.manage',true),(NULL,'POS_RESP_CONF','visibility.manage',true),
 (NULL,'POS_RESP_CONF','clients.read',true),(NULL,'POS_RESP_CONF','credit.read',true),
 (NULL,'POS_RESP_CONF','operations.read',true),(NULL,'POS_RESP_CONF','objectives.read',true),
 (NULL,'POS_RESP_CONF','security.read',true),
 -- Juriste
 (NULL,'POS_JURISTE','org.read',true),(NULL,'POS_JURISTE','reports.read',true),
 (NULL,'POS_JURISTE','compliance.read',true),(NULL,'POS_JURISTE','clients.read',true),
 (NULL,'POS_JURISTE','credit.read',true),(NULL,'POS_JURISTE','audit.read',true),
 -- Analyste LBA/FT
 (NULL,'POS_LBAFT','reports.read',true),(NULL,'POS_LBAFT','compliance.read',true),
 (NULL,'POS_LBAFT','compliance.manage',true),(NULL,'POS_LBAFT','clients.read',true),
 (NULL,'POS_LBAFT','operations.read',true),(NULL,'POS_LBAFT','audit.read',true),
 (NULL,'POS_LBAFT','credit.read',true),
 -- DPO
 (NULL,'POS_DPO','compliance.read',true),(NULL,'POS_DPO','compliance.manage',true),
 (NULL,'POS_DPO','audit.read',true),(NULL,'POS_DPO','reports.read',true),
 (NULL,'POS_DPO','security.read',true),(NULL,'POS_DPO','users.read',true),
 -- Administrateur Système & Réseau
 (NULL,'POS_ADMIN_SYS','org.read',true),(NULL,'POS_ADMIN_SYS','users.read',true),
 (NULL,'POS_ADMIN_SYS','users.manage',true),(NULL,'POS_ADMIN_SYS','settings.manage',true),
 (NULL,'POS_ADMIN_SYS','devices.read',true),(NULL,'POS_ADMIN_SYS','devices.manage',true),
 (NULL,'POS_ADMIN_SYS','security.read',true),(NULL,'POS_ADMIN_SYS','audit.read',true),
 (NULL,'POS_ADMIN_SYS','access.manage',true),(NULL,'POS_ADMIN_SYS','reports.read',true),
 -- Technicien Support
 (NULL,'POS_TECH_SUP','devices.read',true),(NULL,'POS_TECH_SUP','devices.manage',true),
 (NULL,'POS_TECH_SUP','security.read',true),(NULL,'POS_TECH_SUP','users.read',true),
 (NULL,'POS_TECH_SUP','reports.read',true),
 -- RSSI
 (NULL,'POS_RSSI','security.read',true),(NULL,'POS_RSSI','devices.read',true),
 (NULL,'POS_RSSI','devices.manage',true),(NULL,'POS_RSSI','audit.read',true),
 (NULL,'POS_RSSI','compliance.read',true),(NULL,'POS_RSSI','reports.read',true),
 (NULL,'POS_RSSI','org.read',true),(NULL,'POS_RSSI','users.read',true),
 -- Data Scientist
 (NULL,'POS_DATA_SCI','reports.read',true),(NULL,'POS_DATA_SCI','reports.export',true),
 (NULL,'POS_DATA_SCI','objectives.dashboard',true),(NULL,'POS_DATA_SCI','objectives.read',true),
 (NULL,'POS_DATA_SCI','clients.read',true),(NULL,'POS_DATA_SCI','credit.read',true),
 (NULL,'POS_DATA_SCI','operations.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.3 Crédit & Engagement.
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 -- Directeur du Crédit (validation finale incluse)
 (NULL,'POS_DIR_CREDIT','credit.read',true),(NULL,'POS_DIR_CREDIT','credit.initiate',true),
 (NULL,'POS_DIR_CREDIT','credit.process',true),(NULL,'POS_DIR_CREDIT','credit.validate_final',true),
 (NULL,'POS_DIR_CREDIT','credit.recovery',true),(NULL,'POS_DIR_CREDIT','clients.read',true),
 (NULL,'POS_DIR_CREDIT','reports.read',true),(NULL,'POS_DIR_CREDIT','reports.export',true),
 (NULL,'POS_DIR_CREDIT','objectives.read',true),(NULL,'POS_DIR_CREDIT','objectives.dashboard',true),
 (NULL,'POS_DIR_CREDIT','objectives.set',true),(NULL,'POS_DIR_CREDIT','operations.read',true),
 (NULL,'POS_DIR_CREDIT','org.read',true),(NULL,'POS_DIR_CREDIT','users.read',true),
 -- Chef de Service Octroi (validation finale incluse)
 (NULL,'POS_CHEF_OCTROI','credit.read',true),(NULL,'POS_CHEF_OCTROI','credit.initiate',true),
 (NULL,'POS_CHEF_OCTROI','credit.process',true),(NULL,'POS_CHEF_OCTROI','credit.validate_final',true),
 (NULL,'POS_CHEF_OCTROI','clients.read',true),(NULL,'POS_CHEF_OCTROI','reports.read',true),
 (NULL,'POS_CHEF_OCTROI','objectives.read',true),(NULL,'POS_CHEF_OCTROI','objectives.dashboard',true),
 -- Analyste de Crédit
 (NULL,'POS_ANALYSTE_CR','credit.read',true),(NULL,'POS_ANALYSTE_CR','credit.initiate',true),
 (NULL,'POS_ANALYSTE_CR','credit.process',true),(NULL,'POS_ANALYSTE_CR','clients.read',true),
 (NULL,'POS_ANALYSTE_CR','reports.read',true),(NULL,'POS_ANALYSTE_CR','objectives.read',true),
 -- Gestionnaire de portefeuille
 (NULL,'POS_GEST_PORT','credit.read',true),(NULL,'POS_GEST_PORT','credit.recovery',true),
 (NULL,'POS_GEST_PORT','clients.read',true),(NULL,'POS_GEST_PORT','reports.read',true),
 (NULL,'POS_GEST_PORT','objectives.read',true),
 -- Agent de Crédit (superviseur de collecte)
 (NULL,'POS_AGENT_CR','credit.read',true),(NULL,'POS_AGENT_CR','credit.initiate',true),
 (NULL,'POS_AGENT_CR','clients.read',true),(NULL,'POS_AGENT_CR','clients.enroll',true),
 (NULL,'POS_AGENT_CR','clients.manage',true),(NULL,'POS_AGENT_CR','round.view',true),
 (NULL,'POS_AGENT_CR','collecte.supervise',true),(NULL,'POS_AGENT_CR','objectives.read',true),
 (NULL,'POS_AGENT_CR','reports.read',true),
 -- Responsable Recouvrement
 (NULL,'POS_RESP_RECOUV','credit.read',true),(NULL,'POS_RESP_RECOUV','credit.recovery',true),
 (NULL,'POS_RESP_RECOUV','clients.read',true),(NULL,'POS_RESP_RECOUV','reports.read',true),
 (NULL,'POS_RESP_RECOUV','reports.export',true),(NULL,'POS_RESP_RECOUV','objectives.read',true),
 (NULL,'POS_RESP_RECOUV','objectives.dashboard',true),
 -- Agent de Recouvrement
 (NULL,'POS_AGENT_RECOUV','credit.read',true),(NULL,'POS_AGENT_RECOUV','credit.recovery',true),
 (NULL,'POS_AGENT_RECOUV','clients.read',true),(NULL,'POS_AGENT_RECOUV','reports.read',true),
 (NULL,'POS_AGENT_RECOUV','objectives.read',true),
 -- Spécialiste Contentieux
 (NULL,'POS_CONTENTIEUX','credit.read',true),(NULL,'POS_CONTENTIEUX','credit.recovery',true),
 (NULL,'POS_CONTENTIEUX','clients.read',true),(NULL,'POS_CONTENTIEUX','compliance.read',true),
 (NULL,'POS_CONTENTIEUX','reports.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.4 Opérations & Réseau.
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 -- Directeur des Opérations / Réseau
 (NULL,'POS_DIR_OPS','org.read',true),(NULL,'POS_DIR_OPS','users.read',true),
 (NULL,'POS_DIR_OPS','users.manage',true),(NULL,'POS_DIR_OPS','clients.read',true),
 (NULL,'POS_DIR_OPS','clients.manage',true),(NULL,'POS_DIR_OPS','clients.enroll',true),
 (NULL,'POS_DIR_OPS','clients.freeze',true),(NULL,'POS_DIR_OPS','round.view',true),
 (NULL,'POS_DIR_OPS','round.manage',true),(NULL,'POS_DIR_OPS','cash.declare',true),
 (NULL,'POS_DIR_OPS','cash.validate',true),(NULL,'POS_DIR_OPS','cash.approve',true),
 (NULL,'POS_DIR_OPS','collecte.assign',true),(NULL,'POS_DIR_OPS','collecte.supervise',true),
 (NULL,'POS_DIR_OPS','operations.read',true),(NULL,'POS_DIR_OPS','operations.write',true),
 (NULL,'POS_DIR_OPS','operations.validate',true),(NULL,'POS_DIR_OPS','accounts.manage',true),
 (NULL,'POS_DIR_OPS','savings.read',true),(NULL,'POS_DIR_OPS','savings.manage',true),
 (NULL,'POS_DIR_OPS','fees.manage',true),(NULL,'POS_DIR_OPS','reports.read',true),
 (NULL,'POS_DIR_OPS','reports.export',true),(NULL,'POS_DIR_OPS','objectives.read',true),
 (NULL,'POS_DIR_OPS','objectives.set',true),(NULL,'POS_DIR_OPS','objectives.dashboard',true),
 -- Chef d'Agence (superviseur de collecte)
 (NULL,'POS_CHEF_AGENCE','users.read',true),(NULL,'POS_CHEF_AGENCE','clients.read',true),
 (NULL,'POS_CHEF_AGENCE','clients.enroll',true),(NULL,'POS_CHEF_AGENCE','clients.manage',true),
 (NULL,'POS_CHEF_AGENCE','clients.freeze',true),(NULL,'POS_CHEF_AGENCE','round.view',true),
 (NULL,'POS_CHEF_AGENCE','round.manage',true),(NULL,'POS_CHEF_AGENCE','cash.declare',true),
 (NULL,'POS_CHEF_AGENCE','cash.validate',true),(NULL,'POS_CHEF_AGENCE','cash.approve',true),
 (NULL,'POS_CHEF_AGENCE','collecte.assign',true),(NULL,'POS_CHEF_AGENCE','collecte.supervise',true),
 (NULL,'POS_CHEF_AGENCE','operations.read',true),(NULL,'POS_CHEF_AGENCE','operations.write',true),
 (NULL,'POS_CHEF_AGENCE','operations.validate',true),(NULL,'POS_CHEF_AGENCE','accounts.manage',true),
 (NULL,'POS_CHEF_AGENCE','savings.read',true),(NULL,'POS_CHEF_AGENCE','reports.read',true),
 (NULL,'POS_CHEF_AGENCE','reports.export',true),(NULL,'POS_CHEF_AGENCE','objectives.read',true),
 (NULL,'POS_CHEF_AGENCE','objectives.set',true),(NULL,'POS_CHEF_AGENCE','objectives.dashboard',true),
 -- Chef de Caisse
 (NULL,'POS_CHEF_CAISSE','cash.declare',true),(NULL,'POS_CHEF_CAISSE','cash.validate',true),
 (NULL,'POS_CHEF_CAISSE','cash.approve',true),(NULL,'POS_CHEF_CAISSE','operations.read',true),
 (NULL,'POS_CHEF_CAISSE','operations.write',true),(NULL,'POS_CHEF_CAISSE','operations.validate',true),
 (NULL,'POS_CHEF_CAISSE','accounts.manage',true),(NULL,'POS_CHEF_CAISSE','fees.manage',true),
 (NULL,'POS_CHEF_CAISSE','reports.read',true),(NULL,'POS_CHEF_CAISSE','clients.read',true),
 (NULL,'POS_CHEF_CAISSE','objectives.read',true),
 -- Caissier / Guichetier
 (NULL,'POS_CAISSIER','cash.declare',true),(NULL,'POS_CAISSIER','cash.validate',true),
 (NULL,'POS_CAISSIER','operations.read',true),(NULL,'POS_CAISSIER','operations.write',true),
 (NULL,'POS_CAISSIER','clients.read',true),(NULL,'POS_CAISSIER','reports.read',true),
 (NULL,'POS_CAISSIER','objectives.read',true),
 -- Gestionnaire de Clientèle
 (NULL,'POS_GEST_CLIENT','clients.read',true),(NULL,'POS_GEST_CLIENT','clients.enroll',true),
 (NULL,'POS_GEST_CLIENT','clients.manage',true),(NULL,'POS_GEST_CLIENT','operations.read',true),
 (NULL,'POS_GEST_CLIENT','savings.read',true),(NULL,'POS_GEST_CLIENT','reports.read',true),
 (NULL,'POS_GEST_CLIENT','objectives.read',true),
 -- Agent Support Canaux Digitaux
 (NULL,'POS_AGENT_DIGITAL','clients.read',true),(NULL,'POS_AGENT_DIGITAL','operations.read',true),
 (NULL,'POS_AGENT_DIGITAL','devices.read',true),(NULL,'POS_AGENT_DIGITAL','reports.read',true),
 (NULL,'POS_AGENT_DIGITAL','objectives.read',true),
 -- Agent de collecte (collectrice mobile)
 (NULL,'POS_AGENT_COLLECTE','clients.enroll',true),(NULL,'POS_AGENT_COLLECTE','clients.read',true),
 (NULL,'POS_AGENT_COLLECTE','round.view',true),(NULL,'POS_AGENT_COLLECTE','cash.declare',true),
 (NULL,'POS_AGENT_COLLECTE','objectives.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.5 Finance, Comptabilité & Trésorerie.
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 -- Directeur Financier (CFO)
 (NULL,'POS_CFO','reports.read',true),(NULL,'POS_CFO','reports.export',true),
 (NULL,'POS_CFO','operations.read',true),(NULL,'POS_CFO','operations.validate',true),
 (NULL,'POS_CFO','fees.manage',true),(NULL,'POS_CFO','accounts.manage',true),
 (NULL,'POS_CFO','savings.read',true),(NULL,'POS_CFO','savings.manage',true),
 (NULL,'POS_CFO','objectives.read',true),(NULL,'POS_CFO','objectives.dashboard',true),
 (NULL,'POS_CFO','objectives.set',true),(NULL,'POS_CFO','org.read',true),
 (NULL,'POS_CFO','users.read',true),(NULL,'POS_CFO','compliance.read',true),
 (NULL,'POS_CFO','audit.read',true),(NULL,'POS_CFO','credit.read',true),
 -- Trésorier
 (NULL,'POS_TRESORIER','reports.read',true),(NULL,'POS_TRESORIER','reports.export',true),
 (NULL,'POS_TRESORIER','operations.read',true),(NULL,'POS_TRESORIER','operations.validate',true),
 (NULL,'POS_TRESORIER','cash.approve',true),(NULL,'POS_TRESORIER','fees.manage',true),
 (NULL,'POS_TRESORIER','objectives.read',true),
 -- Analyste Flux Mobile Money
 (NULL,'POS_ANALYSTE_MM','reports.read',true),(NULL,'POS_ANALYSTE_MM','reports.export',true),
 (NULL,'POS_ANALYSTE_MM','operations.read',true),(NULL,'POS_ANALYSTE_MM','objectives.read',true),
 -- Chef Comptable
 (NULL,'POS_CHEF_COMPTA','reports.read',true),(NULL,'POS_CHEF_COMPTA','reports.export',true),
 (NULL,'POS_CHEF_COMPTA','operations.read',true),(NULL,'POS_CHEF_COMPTA','operations.validate',true),
 (NULL,'POS_CHEF_COMPTA','fees.manage',true),(NULL,'POS_CHEF_COMPTA','accounts.manage',true),
 (NULL,'POS_CHEF_COMPTA','objectives.read',true),
 -- Comptable
 (NULL,'POS_COMPTABLE','reports.read',true),(NULL,'POS_COMPTABLE','reports.export',true),
 (NULL,'POS_COMPTABLE','operations.read',true),(NULL,'POS_COMPTABLE','fees.manage',true),
 (NULL,'POS_COMPTABLE','objectives.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.6 Audit, Risques & Contrôle Interne (lecture + conformité).
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 (NULL,'POS_DIR_AUDIT','audit.read',true),(NULL,'POS_DIR_AUDIT','reports.read',true),
 (NULL,'POS_DIR_AUDIT','reports.export',true),(NULL,'POS_DIR_AUDIT','compliance.read',true),
 (NULL,'POS_DIR_AUDIT','compliance.manage',true),(NULL,'POS_DIR_AUDIT','clients.read',true),
 (NULL,'POS_DIR_AUDIT','credit.read',true),(NULL,'POS_DIR_AUDIT','operations.read',true),
 (NULL,'POS_DIR_AUDIT','security.read',true),(NULL,'POS_DIR_AUDIT','org.read',true),
 (NULL,'POS_DIR_AUDIT','users.read',true),(NULL,'POS_DIR_AUDIT','objectives.read',true),
 (NULL,'POS_DIR_AUDIT','objectives.dashboard',true),(NULL,'POS_DIR_AUDIT','visibility.manage',true),
 (NULL,'POS_CTRL_PERM','audit.read',true),(NULL,'POS_CTRL_PERM','reports.read',true),
 (NULL,'POS_CTRL_PERM','compliance.read',true),(NULL,'POS_CTRL_PERM','clients.read',true),
 (NULL,'POS_CTRL_PERM','credit.read',true),(NULL,'POS_CTRL_PERM','operations.read',true),
 (NULL,'POS_AUDIT_INT','audit.read',true),(NULL,'POS_AUDIT_INT','reports.read',true),
 (NULL,'POS_AUDIT_INT','reports.export',true),(NULL,'POS_AUDIT_INT','compliance.read',true),
 (NULL,'POS_AUDIT_INT','clients.read',true),(NULL,'POS_AUDIT_INT','credit.read',true),
 (NULL,'POS_AUDIT_INT','operations.read',true),
 (NULL,'POS_INSPECTEUR','audit.read',true),(NULL,'POS_INSPECTEUR','reports.read',true),
 (NULL,'POS_INSPECTEUR','compliance.read',true),(NULL,'POS_INSPECTEUR','clients.read',true),
 (NULL,'POS_INSPECTEUR','credit.read',true),(NULL,'POS_INSPECTEUR','operations.read',true),
 (NULL,'POS_INSPECTEUR','security.read',true),
 (NULL,'POS_FRAUDE','audit.read',true),(NULL,'POS_FRAUDE','reports.read',true),
 (NULL,'POS_FRAUDE','compliance.read',true),(NULL,'POS_FRAUDE','compliance.manage',true),
 (NULL,'POS_FRAUDE','security.read',true),(NULL,'POS_FRAUDE','operations.read',true),
 (NULL,'POS_FRAUDE','clients.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- 5.7 Capital Humain & Moyens Généraux.
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 (NULL,'POS_DRH','users.read',true),(NULL,'POS_DRH','users.manage',true),
 (NULL,'POS_DRH','org.read',true),(NULL,'POS_DRH','reports.read',true),
 (NULL,'POS_DRH','objectives.read',true),(NULL,'POS_DRH','objectives.dashboard',true),
 (NULL,'POS_DRH','audit.read',true),
 (NULL,'POS_RESP_RH','users.read',true),(NULL,'POS_RESP_RH','users.manage',true),
 (NULL,'POS_RESP_RH','reports.read',true),(NULL,'POS_RESP_RH','objectives.read',true),
 (NULL,'POS_GEST_PAIE','users.read',true),(NULL,'POS_GEST_PAIE','reports.read',true),
 (NULL,'POS_GEST_PAIE','objectives.read',true),
 (NULL,'POS_RESP_LOG','reports.read',true),(NULL,'POS_RESP_LOG','objectives.read',true),
 (NULL,'POS_RESP_LOG','org.read',true),(NULL,'POS_RESP_LOG','users.read',true),
 (NULL,'POS_GEST_STOCK','reports.read',true),(NULL,'POS_GEST_STOCK','objectives.read',true),
 (NULL,'POS_GEST_FLOTTE','reports.read',true),(NULL,'POS_GEST_FLOTTE','objectives.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;
