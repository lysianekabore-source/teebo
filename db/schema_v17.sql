-- teebo — VAGUE 17 : Séparation des tâches (SoD) + couverture TOTALE des postes
-- ---------------------------------------------------------------------------
-- 1) Anti-fraude (SoD) :
--    a. Le Caissier ne peut PAS approuver ses propres versements/retraits
--       (cash.approve retiré) : l'approbation relève d'un supérieur (Chef de
--       caisse / Chef d'agence). On supprime l'auto-approbation sémée en v16.
--    b. Scission coffre/comptabilité : la nouvelle clé 'vault.manage' isole les
--       mouvements de coffre (caisse physique) de la tenue comptable
--       ('accounts.manage' = écritures de journal). Un comptable ne bouge plus
--       le coffre ; un chef de caisse ne passe plus d'écritures comptables.
-- 2) Couverture : TOUS les postes du catalogue reçoivent leurs habilitations
--    par défaut (postes non sémés en v16).
-- Défauts GLOBAUX (imf_id NULL) ; surcharge par IMF possible. Cloisonnement
-- garanti par imf_id dans chaque requête. gen_random_uuid via pgcrypto.
-- ---------------------------------------------------------------------------

-- (0) Catalogue : enregistrer la nouvelle clé 'vault.manage'.
INSERT INTO permission_catalog(imf_id,permission_key,label,category,access_kind,is_system,sort_order) VALUES
 (NULL,'vault.manage', 'Coffre / Trésorerie — mouvements de caisse & coffre','Épargne & Opérations','validation',true,57)
ON CONFLICT DO NOTHING;

-- (1a) SoD — retirer l'auto-approbation du Caissier (viol de séparation des tâches).
DELETE FROM position_default_permission
 WHERE imf_id IS NULL AND position_code='POS_CAISSIER' AND permission_key='cash.approve';

-- (1b) SoD — scission coffre/compta : les postes « caisse » perdent accounts.manage
--      (écritures comptables) et reçoivent vault.manage (mouvements de coffre).
DELETE FROM position_default_permission
 WHERE imf_id IS NULL AND permission_key='accounts.manage'
   AND position_code IN ('POS_CHEF_CAISSE','POS_CHEF_AGENCE');

-- (2) vault.manage — postes autorisés à mouvementer coffre/caisse physique :
--     Chef de caisse, Chef d'agence, Trésorier, CFO, Directeur des Opérations.
--     (La comptabilité — Comptable / Chef Comptable — conserve accounts.manage
--      uniquement : elle tient le journal, elle ne touche PAS le coffre.)
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 (NULL,'POS_CHEF_CAISSE','vault.manage',true),
 (NULL,'POS_CHEF_AGENCE','vault.manage',true),
 (NULL,'POS_TRESORIER','vault.manage',true),
 (NULL,'POS_CFO','vault.manage',true),
 (NULL,'POS_DIR_OPS','vault.manage',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- (3) POSTES NON SÉMÉS EN v16 — habilitations par défaut (principe du moindre
--     privilège, SoD respectée : aucun cumul saisie+validation sur un même flux).

-- 3.1 Direction Générale (support) — l'Assistante de Direction : lecture pilotage.
--     (POS_DG / POS_DGA = rôle 'superadmin' : accès complet via court-circuit auth.js.)
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 (NULL,'POS_ASSIST_DG','org.read',true),
 (NULL,'POS_ASSIST_DG','users.read',true),
 (NULL,'POS_ASSIST_DG','reports.read',true),
 (NULL,'POS_ASSIST_DG','objectives.read',true),

 -- 3.2 Conformité & Juridique.
 (NULL,'POS_RESP_CONF','compliance.read',true),
 (NULL,'POS_RESP_CONF','compliance.manage',true),
 (NULL,'POS_RESP_CONF','audit.read',true),
 (NULL,'POS_RESP_CONF','clients.read',true),
 (NULL,'POS_RESP_CONF','operations.read',true),
 (NULL,'POS_RESP_CONF','reports.read',true),
 (NULL,'POS_RESP_CONF','reports.export',true),
 (NULL,'POS_JURISTE','compliance.read',true),
 (NULL,'POS_JURISTE','clients.read',true),
 (NULL,'POS_JURISTE','reports.read',true),
 (NULL,'POS_LBAFT','compliance.read',true),
 (NULL,'POS_LBAFT','compliance.manage',true),
 (NULL,'POS_LBAFT','operations.read',true),
 (NULL,'POS_LBAFT','clients.read',true),
 (NULL,'POS_LBAFT','reports.read',true),
 (NULL,'POS_DPO','compliance.read',true),
 (NULL,'POS_DPO','security.read',true),
 (NULL,'POS_DPO','reports.read',true),

 -- 3.3 SI & Sécurité.
 (NULL,'POS_ADMIN_SYS','devices.read',true),
 (NULL,'POS_ADMIN_SYS','devices.manage',true),
 (NULL,'POS_ADMIN_SYS','security.read',true),
 (NULL,'POS_ADMIN_SYS','org.read',true),
 (NULL,'POS_ADMIN_SYS','users.read',true),
 (NULL,'POS_TECH_SUP','devices.read',true),
 (NULL,'POS_TECH_SUP','security.read',true),
 (NULL,'POS_RSSI','security.read',true),
 (NULL,'POS_RSSI','devices.read',true),
 (NULL,'POS_RSSI','devices.manage',true),
 (NULL,'POS_RSSI','audit.read',true),
 (NULL,'POS_RSSI','compliance.read',true),
 (NULL,'POS_DATA_SCI','reports.read',true),
 (NULL,'POS_DATA_SCI','reports.export',true),
 (NULL,'POS_DATA_SCI','operations.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed) VALUES
 -- 3.4 Crédit — encadrement (la VALIDATION FINALE credit.validate_final est
 --     déjà sémée en v13 pour POS_DIR_CREDIT / POS_CHEF_OCTROI).
 (NULL,'POS_DIR_CREDIT','credit.read',true),
 (NULL,'POS_DIR_CREDIT','credit.process',true),
 (NULL,'POS_DIR_CREDIT','clients.read',true),
 (NULL,'POS_DIR_CREDIT','operations.read',true),
 (NULL,'POS_DIR_CREDIT','reports.read',true),
 (NULL,'POS_DIR_CREDIT','reports.export',true),
 (NULL,'POS_DIR_CREDIT','objectives.set',true),
 (NULL,'POS_DIR_CREDIT','objectives.dashboard',true),
 (NULL,'POS_DIR_CREDIT','objectives.read',true),
 (NULL,'POS_CHEF_OCTROI','credit.read',true),
 (NULL,'POS_CHEF_OCTROI','credit.process',true),
 (NULL,'POS_CHEF_OCTROI','clients.read',true),
 (NULL,'POS_CHEF_OCTROI','operations.read',true),
 (NULL,'POS_CHEF_OCTROI','reports.read',true),
 (NULL,'POS_CHEF_OCTROI','objectives.dashboard',true),
 (NULL,'POS_CHEF_OCTROI','objectives.read',true),

 -- 3.5 Opérations & Réseau.
 (NULL,'POS_DIR_OPS','clients.read',true),
 (NULL,'POS_DIR_OPS','clients.manage',true),
 (NULL,'POS_DIR_OPS','operations.read',true),
 (NULL,'POS_DIR_OPS','operations.validate',true),
 (NULL,'POS_DIR_OPS','cash.approve',true),
 (NULL,'POS_DIR_OPS','collecte.supervise',true),
 (NULL,'POS_DIR_OPS','collecte.assign',true),
 (NULL,'POS_DIR_OPS','savings.read',true),
 (NULL,'POS_DIR_OPS','savings.manage',true),
 (NULL,'POS_DIR_OPS','round.manage',true),
 (NULL,'POS_DIR_OPS','reports.read',true),
 (NULL,'POS_DIR_OPS','reports.export',true),
 (NULL,'POS_DIR_OPS','objectives.set',true),
 (NULL,'POS_DIR_OPS','objectives.dashboard',true),
 (NULL,'POS_DIR_OPS','objectives.read',true),
 (NULL,'POS_DIR_OPS','users.read',true),
 (NULL,'POS_GEST_CLIENT','clients.read',true),
 (NULL,'POS_GEST_CLIENT','clients.manage',true),
 (NULL,'POS_GEST_CLIENT','clients.enroll',true),
 (NULL,'POS_GEST_CLIENT','operations.read',true),
 (NULL,'POS_GEST_CLIENT','savings.read',true),
 (NULL,'POS_GEST_CLIENT','reports.read',true),
 (NULL,'POS_AGENT_DIGITAL','clients.read',true),
 (NULL,'POS_AGENT_DIGITAL','operations.read',true),
 (NULL,'POS_AGENT_DIGITAL','devices.read',true),
 (NULL,'POS_AGENT_DIGITAL','savings.read',true),

 -- 3.6 Finance & Trésorerie (vault.manage déjà ci-dessus pour CFO/Trésorier).
 (NULL,'POS_CFO','operations.read',true),
 (NULL,'POS_CFO','operations.validate',true),
 (NULL,'POS_CFO','reports.read',true),
 (NULL,'POS_CFO','reports.export',true),
 (NULL,'POS_CFO','fees.manage',true),
 (NULL,'POS_CFO','savings.read',true),
 (NULL,'POS_CFO','objectives.read',true),
 (NULL,'POS_TRESORIER','operations.read',true),
 (NULL,'POS_TRESORIER','reports.read',true),
 (NULL,'POS_TRESORIER','reports.export',true),
 (NULL,'POS_TRESORIER','savings.read',true),
 (NULL,'POS_ANALYSTE_MM','operations.read',true),
 (NULL,'POS_ANALYSTE_MM','reports.read',true),
 (NULL,'POS_ANALYSTE_MM','savings.read',true),

 -- 3.7 RH & Logistique (complément aux postes déjà sémés DRH/RESP_RH/GEST_PAIE).
 (NULL,'POS_RESP_LOG','devices.read',true),
 (NULL,'POS_RESP_LOG','devices.manage',true),
 (NULL,'POS_RESP_LOG','org.read',true),
 (NULL,'POS_RESP_LOG','reports.read',true),
 (NULL,'POS_GEST_STOCK','devices.read',true),
 (NULL,'POS_GEST_STOCK','reports.read',true),
 (NULL,'POS_GEST_FLOTTE','devices.read',true),
 (NULL,'POS_GEST_FLOTTE','reports.read',true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;
