-- ===========================================================================
-- teebo — VAGUE 53 (18/11/2026)
-- « Le chef d'agence a les mêmes menus que l'administrateur de l'IMF »
-- ===========================================================================
-- Trois causes distinctes ont été corrigées dans cette vague :
--
--  1) CÔTÉ ÉCRAN : les entrées de menu « Organisation » et « Personnel »
--     n'avaient aucune condition d'accès, et la feuille de style forçait
--     l'affichage de tous les menus (elle écrasait l'attribut « hidden »).
--     Ces deux points sont corrigés dans le site (app.css, app.html, app.js,
--     menus.js) : chaque menu porte désormais la ou les habilitations qui
--     l'ouvrent.
--
--  2) CÔTÉ DROITS : le profil « Agence » recevait « users.manage » (créer des
--     comptes, renvoyer les codes d'accès). Ce droit est retiré ; l'agence
--     consulte l'organisation et l'annuaire (org.read, users.read).
--
--  3) CÔTÉ BASE : des comptes avaient pu accumuler, par surcharge, les quatre
--     habilitations de l'administrateur (personnel, structure, paramètres,
--     matrice des droits). Ce script les retire à TOUS les profils ordinaires.
--     Idempotent : peut être rejoué sans risque.
-- ===========================================================================

BEGIN;

-- 1) Plafond de superficie : seul l'administrateur de l'IMF (et l'éditeur)
--    conserve la gestion du personnel, de la structure, des paramètres et de
--    la matrice des droits. Nettoyage des surcharges accordées par erreur.
DELETE FROM user_permission up
USING app_user u
WHERE u.id = up.user_id
  AND COALESCE(u.role, '') NOT IN ('admin_imf', 'teebo_admin')
  AND up.permission_key IN ('users.manage', 'access.manage', 'org.manage', 'settings.manage');

-- 2) Un chef d'agence consulte l'arborescence de son institution (lecture
--    seule : la création d'unité reste réservée à l'administrateur).
INSERT INTO position_default_permission (imf_id, position_code, permission_key, allowed)
SELECT NULL, 'POS_CHEF_AGENCE', 'org.read', true
 WHERE NOT EXISTS (
   SELECT 1 FROM position_default_permission
    WHERE imf_id IS NULL AND position_code = 'POS_CHEF_AGENCE' AND permission_key = 'org.read');

-- 3) Les profils d'encadrement (département / service) suivent le parc de
--    terminaux et les alertes de sécurité de leur périmètre.
INSERT INTO position_default_permission (imf_id, position_code, permission_key, allowed)
SELECT NULL, p.code, 'devices.read', true
  FROM (VALUES ('POS_DIR_OPS'), ('POS_RESP_CONF')) AS p(code)
 WHERE NOT EXISTS (
   SELECT 1 FROM position_default_permission d
    WHERE d.imf_id IS NULL AND d.position_code = p.code AND d.permission_key = 'devices.read');

INSERT INTO position_default_permission (imf_id, position_code, permission_key, allowed)
SELECT NULL, p.code, 'security.read', true
  FROM (VALUES ('POS_DIR_OPS'), ('POS_RESP_CONF')) AS p(code)
 WHERE NOT EXISTS (
   SELECT 1 FROM position_default_permission d
    WHERE d.imf_id IS NULL AND d.position_code = p.code AND d.permission_key = 'security.read');

-- 4) Le chef d'agence ne tient pas la comptabilité. Son poste héritait de
--    « accounts.manage » (comptabilité + coffre), ce qui lui ouvrait les écrans
--    Comptabilité et Coffre, réservés aux fonctions comptables. On retire ce
--    droit du poste ET des comptes déjà créés. Réversible depuis l'écran
--    Habilitations par l'administrateur de l'IMF, s'il le souhaite.
DELETE FROM user_permission up
USING app_user u
WHERE u.id = up.user_id
  AND u.position_code = 'POS_CHEF_AGENCE'
  AND COALESCE(u.role, '') NOT IN ('admin_imf', 'teebo_admin')
  AND up.permission_key = 'accounts.manage';

DELETE FROM position_default_permission
 WHERE imf_id IS NULL
   AND position_code = 'POS_CHEF_AGENCE'
   AND permission_key = 'accounts.manage';

COMMIT;
