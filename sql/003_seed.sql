-- teebo — Données initiales (seed) pour une mise en production réelle.
-- =========================================================================
-- Contient : les rôles (role_template), 2 IMF de départ, 1 super-admin teebo,
-- 2 admins IMF et quelques utilisateurs, + le périmètre souscrit par IMF.
-- Mots de passe de départ (À CHANGER dès la 1re connexion) :
--   • teebo (super-admin)      e-mail admin@teebo.io        mot de passe  Teebo!2026
--   • admin IMF-001            e-mail admin@imf001.bf       mot de passe  AdminImf!2026
--   • admin IMF-002            e-mail admin@imf002.bf       mot de passe  AdminImf!2026
-- Pour (re)générer un hachage : node scripts/hash-password.mjs "MonMotDePasse"
-- Idempotent : relançable sans doublon (ON CONFLICT).
-- =========================================================================

-- 1) RÔLES (role_template) --------------------------------------------------
INSERT INTO role_template (role_key, label, permission_code) VALUES
  ('collectrice','Collectrice','tour.collect'),
  ('collectrice','Collectrice','momo.collect'),
  ('collectrice','Collectrice','momo.view'),
  ('collectrice','Collectrice','client.view'),
  ('superviseur','Superviseur','supervisor.validate'),
  ('superviseur','Superviseur','report.view'),
  ('superviseur','Superviseur','report.export'),
  ('superviseur','Superviseur','tour.close'),
  ('superviseur','Superviseur','momo.view'),
  ('superviseur','Superviseur','client.view'),
  ('guichet','Agent de guichet / caissier','cash.view'),
  ('guichet','Agent de guichet / caissier','cash.deposit'),
  ('guichet','Agent de guichet / caissier','cash.withdraw'),
  ('guichet','Agent de guichet / caissier','client.view'),
  ('guichet','Agent de guichet / caissier','client.create'),
  ('comptable','Comptable','accounting.view'),
  ('comptable','Comptable','accounting.post'),
  ('comptable','Comptable','report.bceao'),
  ('comptable','Comptable','report.view'),
  ('agent_credit','Agent de crédit','credit.view'),
  ('agent_credit','Agent de crédit','credit.analyze'),
  ('agent_credit','Agent de crédit','client.view'),
  ('agent_credit','Agent de crédit','client.kyc'),
  ('responsable_credit','Responsable crédit','credit.view'),
  ('responsable_credit','Responsable crédit','credit.analyze'),
  ('responsable_credit','Responsable crédit','credit.validate'),
  ('responsable_credit','Responsable crédit','client.view'),
  ('admin_imf','Administrateur IMF','user.manage'),
  ('admin_imf','Administrateur IMF','rbac.manage'),
  ('admin_imf','Administrateur IMF','report.view'),
  ('admin_imf','Administrateur IMF','report.export'),
  ('admin_imf','Administrateur IMF','client.view'),
  ('admin_imf','Administrateur IMF','accounting.view')
ON CONFLICT (role_key, permission_code) DO UPDATE SET label = EXCLUDED.label;

-- 2) IMF --------------------------------------------------------------------
INSERT INTO imf (id, name) VALUES
  ('imf-001','IMF Faso Djigui'),
  ('imf-002','IMF Nianan Finance')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 3) UTILISATEURS -----------------------------------------------------------
-- Super-admin teebo (transverse, imf_id NULL).
INSERT INTO app_user (id, imf_id, full_name, email, password_hash, role, is_teebo_admin) VALUES
  ('teebo-admin', NULL, 'Super Admin teebo', 'admin@teebo.io',
   'scrypt$3ec732094e8166dd01d513a7b67b25bc$f8e0ad0c1a69921772f70abb465ab3cbb539c01070af1bddc6ce6bf9e6a7668cd273ba76e087d8960423b4e97d3648c40bd322920c53bb514e6a9c486295b3c9',
   'admin_imf', true)
ON CONFLICT (id) DO NOTHING;

-- Admins IMF + utilisateurs métier.
INSERT INTO app_user (id, imf_id, full_name, email, password_hash, role, is_teebo_admin) VALUES
  ('a1','imf-001','Admin Faso Djigui','admin@imf001.bf',
   'scrypt$eeee7527c05ec80e7aa049876349870c$25133a362246e01bbbf27417f1a24148f2382a4e1c6ecdfc2e0c1e7fb93d9f2e2bcac09d4405daa8a3d7fd00aea7ff4f64660bf67441d1d65144e93de4d51318',
   'admin_imf', false),
  ('u1','imf-001','Aïssata Ouédraogo','aissata@imf001.bf',
   'scrypt$eeee7527c05ec80e7aa049876349870c$25133a362246e01bbbf27417f1a24148f2382a4e1c6ecdfc2e0c1e7fb93d9f2e2bcac09d4405daa8a3d7fd00aea7ff4f64660bf67441d1d65144e93de4d51318',
   'collectrice', false),
  ('u2','imf-001','Fatou Sanogo','fatou@imf001.bf',
   'scrypt$eeee7527c05ec80e7aa049876349870c$25133a362246e01bbbf27417f1a24148f2382a4e1c6ecdfc2e0c1e7fb93d9f2e2bcac09d4405daa8a3d7fd00aea7ff4f64660bf67441d1d65144e93de4d51318',
   'collectrice', false),
  ('u3','imf-001','Ibrahim Touré','ibrahim@imf001.bf',
   'scrypt$eeee7527c05ec80e7aa049876349870c$25133a362246e01bbbf27417f1a24148f2382a4e1c6ecdfc2e0c1e7fb93d9f2e2bcac09d4405daa8a3d7fd00aea7ff4f64660bf67441d1d65144e93de4d51318',
   'superviseur', false),
  ('u4','imf-001','Mariam Koné','mariam@imf001.bf',
   'scrypt$eeee7527c05ec80e7aa049876349870c$25133a362246e01bbbf27417f1a24148f2382a4e1c6ecdfc2e0c1e7fb93d9f2e2bcac09d4405daa8a3d7fd00aea7ff4f64660bf67441d1d65144e93de4d51318',
   'guichet', false),
  ('a2','imf-002','Admin Nianan','admin@imf002.bf',
   'scrypt$59a68a4f064d85af443406937f331038$0f324652761f7fcc703d2caaa688b927aaa7c6d1d3efcc93b0a008a990c9e4d5ece251a78be24d71fe4d88a548dfb89d167d3bcf8b9815769523bd6f119a15ea',
   'admin_imf', false),
  ('v1','imf-002','Salif Diarra','salif@imf002.bf',
   'scrypt$59a68a4f064d85af443406937f331038$0f324652761f7fcc703d2caaa688b927aaa7c6d1d3efcc93b0a008a990c9e4d5ece251a78be24d71fe4d88a548dfb89d167d3bcf8b9815769523bd6f119a15ea',
   'superviseur', false),
  ('v2','imf-002','Awa Cissé','awa@imf002.bf',
   'scrypt$59a68a4f064d85af443406937f331038$0f324652761f7fcc703d2caaa688b927aaa7c6d1d3efcc93b0a008a990c9e4d5ece251a78be24d71fe4d88a548dfb89d167d3bcf8b9815769523bd6f119a15ea',
   'collectrice', false)
ON CONFLICT (id) DO NOTHING;

-- 4) PÉRIMÈTRE SOUSCRIT par IMF (imf_entitlement) ----------------------------
-- IMF-001 : périmètre large (toutes les habilitations non interdites).
INSERT INTO imf_entitlement (imf_id, permission_code, enabled, updated_by)
SELECT 'imf-001', rt.permission_code, true, 'seed'
FROM (SELECT DISTINCT permission_code FROM role_template) rt
WHERE rt.permission_code <> 'credit.auto_disburse'
ON CONFLICT (imf_id, permission_code) DO UPDATE SET enabled = EXCLUDED.enabled;

-- IMF-002 : périmètre restreint (collecte + caisse + reporting de base).
INSERT INTO imf_entitlement (imf_id, permission_code, enabled, updated_by) VALUES
  ('imf-002','cash.view',true,'seed'),
  ('imf-002','tour.collect',true,'seed'),
  ('imf-002','tour.close',true,'seed'),
  ('imf-002','momo.collect',true,'seed'),
  ('imf-002','momo.view',true,'seed'),
  ('imf-002','report.view',true,'seed'),
  ('imf-002','client.view',true,'seed'),
  ('imf-002','client.create',true,'seed')
ON CONFLICT (imf_id, permission_code) DO UPDATE SET enabled = EXCLUDED.enabled;

-- 5) Quelques habilitations déjà accordées (user_permission) ------------------
INSERT INTO user_permission (imf_id, user_id, permission_code, updated_by) VALUES
  ('imf-001','u1','tour.collect','seed'),
  ('imf-001','u1','momo.collect','seed'),
  ('imf-001','u1','client.view','seed'),
  ('imf-001','u3','supervisor.validate','seed'),
  ('imf-001','u3','report.view','seed'),
  ('imf-001','u3','tour.close','seed'),
  ('imf-002','v1','supervisor.validate','seed'),
  ('imf-002','v1','report.view','seed'),
  ('imf-002','v1','tour.close','seed')
ON CONFLICT (imf_id, user_id, permission_code) DO NOTHING;
