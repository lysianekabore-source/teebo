-- =========================================================================
-- VAGUE 28 — « Conseil d'Administration » : unite de rattachement du PCA
--
-- 1. L'unite d'organisation « Conseil d'Administration » est creee (une seule
--    par IMF) au-dessus de la Direction Generale. C'est le rattachement
--    officiel du poste « President du Conseil d'Administration ».
-- 2. Le PCA n'a AUCUN responsable hierarchique (sommet de l'organisation) :
--    l'interface l'affiche comme tel (pas de « non defini »).
-- 3. Les libelles du catalogue des postes sont harmonises.
--
-- Migration additive et reentrante : peut etre relancee sans risque.
-- =========================================================================

BEGIN;

-- 1. Une seule unite « Conseil d'Administration » par IMF --------------------
--    kind = 'direction' (au-dessus de la Direction Generale dans l'arbre),
--    code technique 'CA::<imf>' comme les autres unites semees.
INSERT INTO org_unit(imf_id, parent_id, kind, code_unit, name)
SELECT i.id, NULL, 'direction', 'CA::' || i.id::text, 'Conseil d''Administration'
  FROM imf i
 WHERE NOT EXISTS (
        SELECT 1 FROM org_unit u
         WHERE u.imf_id = i.id
           AND (u.code_unit = 'CA::' || i.id::text
                OR lower(u.name) LIKE '%conseil d%administration%'))
ON CONFLICT (code_unit) DO NOTHING;

-- 2. Le PCA n'a pas de responsable hierarchique ----------------------------
UPDATE position_catalog
   SET parent_expected_label = NULL,
       parent_expected_codes = NULL,
       hierarchy_level = 100,
       validation_level = 0,
       is_manager = false,
       can_supervise_collectors = false,
       needs_supervisor = false
 WHERE code = 'POS_PCA' AND imf_id IS NULL;

-- 3. Le PCA est rattache au Conseil d'Administration (departement DG,
--    service DG_PILOTAGE conserves : le poste reste dans la filiere pilotage).
UPDATE position_catalog
   SET label = 'President du Conseil d''Administration (PCA)'
 WHERE code = 'POS_PCA' AND imf_id IS NULL
   AND label NOT LIKE '%(PCA)%';

-- 4. Libelle attendu du responsable du DG : forme exacte du catalogue --------
UPDATE position_catalog
   SET parent_expected_label = 'President du Conseil d''Administration (PCA)'
 WHERE code = 'POS_DG' AND imf_id IS NULL;

-- 5. Rattachement des utilisateurs PCA existants a l'unite Conseil ----------
UPDATE app_user u
   SET org_unit_id = (
        SELECT o.id FROM org_unit o
         WHERE o.imf_id = u.imf_id
           AND (o.code_unit = 'CA::' || u.imf_id::text
                OR lower(o.name) LIKE '%conseil d%administration%')
         LIMIT 1)
 WHERE u.position_code = 'POS_PCA'
   AND (u.org_unit_id IS NULL
        OR u.org_unit_id NOT IN (
            SELECT o2.id FROM org_unit o2
             WHERE o2.imf_id = u.imf_id
               AND (o2.code_unit = 'CA::' || u.imf_id::text
                    OR lower(o2.name) LIKE '%conseil d%administration%')));

COMMIT;
