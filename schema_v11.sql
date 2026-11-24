-- =========================================================================
-- schema_v11 : Structure organisationnelle fine (8 départements / services),
--              rôles métier, matrice RBAC par verbe, audit enrichi anti-fraude.
-- -------------------------------------------------------------------------
-- Principes conservés :
--   * Multi-tenancy : chaque IMF = un tenant (imf.id = tenant_id), cloisonné.
--   * Hiérarchie : Direction Générale > Département > Service (> Agence/Guichet).
--   * Audit append-only : l'immutabilité (trg_audit_immutable) reste en place ;
--     on ne fait qu'AJOUTER des colonnes de contexte (actor, département).
-- Migration ADDITIVE, réentrante (IF NOT EXISTS / guardée), sans migration de
-- données ni perte. Compatible avec l'existant (anciens rôles préservés).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Extension de l'ENUM user_role avec les rôles métier exacts.
--    (Pattern identique à schema_v3 : ADD VALUE guardé, hors référence same-tx.)
-- -------------------------------------------------------------------------
DO $$
DECLARE
    v_role TEXT;
    v_roles TEXT[] := ARRAY[
        'superadmin',            -- Direction Générale (SuperAdmin / Executive)
        'compliance_officer',    -- Conformité (LAB-FT)
        'it_admin',              -- SI & Sécurité : administration système
        'security_engineer',     -- SI & Sécurité : ingénierie sécurité
        'credit_director',       -- Crédit : directeur
        'credit_analyst',        -- Crédit : analyste
        'recovery_agent',        -- Crédit : recouvrement
        'operations_director',   -- Opérations : directeur
        'teller',                -- Opérations : guichetier / caissier
        'customer_agent',        -- Opérations : chargé de clientèle
        'cfo',                   -- Finance : directeur financier
        'treasurer',             -- Finance : trésorier
        'accountant',            -- Finance : comptable
        'auditor',               -- Audit interne
        'hr_logistics_manager'   -- RH & Logistique
    ];
BEGIN
    FOREACH v_role IN ARRAY v_roles LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'user_role' AND e.enumlabel = v_role
        ) THEN
            EXECUTE format('ALTER TYPE user_role ADD VALUE %L', v_role);
        END IF;
    END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- 2. Catalogue de référence : départements, services, rôles.
--    Référentiel GLOBAL (partagé par tous les tenants) ; les rôles y sont
--    stockés en TEXT (et non user_role) pour rester insensible à l'ordre des
--    ADD VALUE ci-dessus (une nouvelle valeur d'enum n'est pas utilisable dans
--    la même transaction que son ADD VALUE).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS department_catalog (
    code        TEXT PRIMARY KEY,          -- ex: 'DG', 'COMPLIANCE', 'CREDIT'
    label       TEXT NOT NULL,             -- libellé français
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_catalog (
    code        TEXT PRIMARY KEY,          -- ex: 'CREDIT_OCTROI'
    dept_code   TEXT NOT NULL REFERENCES department_catalog(code) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_catalog (
    role_key    TEXT PRIMARY KEY,          -- = valeur user_role
    label       TEXT NOT NULL,             -- libellé français
    dept_code   TEXT REFERENCES department_catalog(code) ON DELETE SET NULL,
    service_code TEXT REFERENCES service_catalog(code) ON DELETE SET NULL,
    is_manager  BOOLEAN NOT NULL DEFAULT false
);

-- -------------------------------------------------------------------------
-- 3. Matrice RBAC par verbe (READ / WRITE / UPDATE / DELETE / VALIDATE).
--    Une ligne = (rôle, ressource, verbe, portée). La portée borne le
--    cloisonnement : 'tenant' | 'department' | 'service' | 'self'.
--    imf_id NULL = règle de référence globale ; une ligne imf_id non NULL
--    permet une surcharge locale (même clé) sans toucher au référentiel.
-- -------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rbac_verb') THEN
        CREATE TYPE rbac_verb AS ENUM ('READ','WRITE','UPDATE','DELETE','VALIDATE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rbac_scope') THEN
        CREATE TYPE rbac_scope AS ENUM ('tenant','department','service','self');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS rbac_rule (
    id         BIGSERIAL PRIMARY KEY,
    imf_id     UUID REFERENCES imf(id) ON DELETE CASCADE,  -- NULL = règle globale
    role_key   TEXT NOT NULL,
    resource   TEXT NOT NULL,                              -- domaine métier
    verb       rbac_verb NOT NULL,
    scope      rbac_scope NOT NULL DEFAULT 'service',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rbac_rule
    ON rbac_rule (COALESCE(imf_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  role_key, resource, verb);
CREATE INDEX IF NOT EXISTS idx_rbac_role ON rbac_rule(role_key);

-- -------------------------------------------------------------------------
-- 4. Rattachement fin de l'utilisateur : département + service.
--    (org_unit_id reste la hiérarchie physique ; ces codes donnent le
--    périmètre RBAC métier sans ambiguïté.)
-- -------------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS dept_code    TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS service_code TEXT;

-- -------------------------------------------------------------------------
-- 5. Audit enrichi pour l'IA anti-fraude.
--    On AJOUTE le contexte demandé : utilisateur, rôle, département, service.
--    (action = TG_OP ; timestamp = created_at ; données modifiées = payload.)
--    L'immutabilité append-only (trg_audit_immutable) est déjà en place.
-- -------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_role  TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS department  TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS service     TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_dept  ON audit_log(department);

-- fn_audit enrichi : capte l'acteur et son périmètre via des variables de
-- session (GUC) posées par le backend (SET LOCAL teebo.*). Si absentes, on
-- reste rétrocompatible (valeurs NULL), sans jamais bloquer l'écriture.
CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_row  JSONB;
    v_imf  UUID;
    v_id   TEXT;
    v_actor UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;

    IF v_row ? 'imf_id' THEN
        v_imf := NULLIF(v_row->>'imf_id', '')::uuid;
    ELSIF TG_TABLE_NAME = 'imf' THEN
        v_imf := NULLIF(v_row->>'id', '')::uuid;
    ELSE
        v_imf := NULL;
    END IF;
    v_id := COALESCE(v_row->>'id', '');
    BEGIN v_actor := NULLIF(current_setting('teebo.actor_id', true), '')::uuid;
    EXCEPTION WHEN others THEN v_actor := NULL; END;

    INSERT INTO audit_log(imf_id, actor_id, actor_role, department, service,
                          action, entity, entity_id, payload)
    VALUES (v_imf, v_actor,
            NULLIF(current_setting('teebo.actor_role', true), ''),
            NULLIF(current_setting('teebo.department', true), ''),
            NULLIF(current_setting('teebo.service', true), ''),
            TG_OP, TG_TABLE_NAME, v_id, v_row);

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------
-- 6. Seed du référentiel : 8 départements, leurs services, leurs rôles.
-- -------------------------------------------------------------------------
INSERT INTO department_catalog(code,label,sort_order) VALUES
 ('DG',         'Direction Générale',              1),
 ('COMPLIANCE', 'Conformité (LAB-FT)',             2),
 ('IT',         'Système d''Information & Sécurité',3),
 ('CREDIT',     'Crédit',                          4),
 ('OPS',        'Opérations',                      5),
 ('FINANCE',    'Finance',                         6),
 ('AUDIT',      'Audit Interne',                   7),
 ('HR',         'Ressources Humaines & Logistique',8)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_catalog(code,dept_code,label,sort_order) VALUES
 ('DG_PILOTAGE',    'DG',        'Pilotage stratégique',        1),
 ('COMP_LABFT',     'COMPLIANCE','Contrôle de conformité / LAB-FT',1),
 ('IT_SYSTEME',     'IT',        'Administration système',      1),
 ('IT_SECURITE',    'IT',        'Ingénierie sécurité',         2),
 ('CREDIT_OCTROI',  'CREDIT',    'Octroi & analyse crédit',     1),
 ('CREDIT_RECOUV',  'CREDIT',    'Recouvrement',                2),
 ('OPS_GUICHET',    'OPS',       'Guichet / Caisse',            1),
 ('OPS_CLIENTELE',  'OPS',       'Relation clientèle',          2),
 ('FIN_TRESORERIE', 'FINANCE',   'Trésorerie',                  1),
 ('FIN_COMPTA',     'FINANCE',   'Comptabilité',                2),
 ('AUDIT_INSPECT',  'AUDIT',     'Audit & inspection',          1),
 ('HR_RHLOG',       'HR',        'RH & Logistique',             1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_catalog(role_key,label,dept_code,service_code,is_manager) VALUES
 ('superadmin',          'Directeur Général (SuperAdmin)',  'DG','DG_PILOTAGE',true),
 ('compliance_officer',  'Responsable Conformité',          'COMPLIANCE','COMP_LABFT',true),
 ('it_admin',            'Administrateur Système',          'IT','IT_SYSTEME',true),
 ('security_engineer',   'Ingénieur Sécurité',             'IT','IT_SECURITE',false),
 ('credit_director',     'Directeur du Crédit',             'CREDIT','CREDIT_OCTROI',true),
 ('credit_analyst',      'Analyste Crédit',                 'CREDIT','CREDIT_OCTROI',false),
 ('recovery_agent',      'Agent de Recouvrement',           'CREDIT','CREDIT_RECOUV',false),
 ('operations_director', 'Directeur des Opérations',        'OPS','OPS_GUICHET',true),
 ('teller',              'Guichetier / Caissier',           'OPS','OPS_GUICHET',false),
 ('customer_agent',      'Chargé de Clientèle',            'OPS','OPS_CLIENTELE',false),
 ('cfo',                 'Directeur Financier (CFO)',       'FINANCE','FIN_TRESORERIE',true),
 ('treasurer',           'Trésorier',                      'FINANCE','FIN_TRESORERIE',false),
 ('accountant',          'Comptable',                       'FINANCE','FIN_COMPTA',false),
 ('auditor',             'Auditeur Interne',                'AUDIT','AUDIT_INSPECT',true),
 ('hr_logistics_manager','Responsable RH & Logistique',     'HR','HR_RHLOG',true)
ON CONFLICT (role_key) DO NOTHING;

-- -------------------------------------------------------------------------
-- 7. Seed de la matrice RBAC globale (imf_id NULL).
--    Les rôles d'administration (DG + admin_imf) obtiennent tous les verbes
--    sur toutes les ressources au périmètre 'tenant'. Les autres rôles sont
--    bornés à leur département/service.
-- -------------------------------------------------------------------------
DO $$
DECLARE
    v_res  TEXT;
    v_verb rbac_verb;
    v_role TEXT;
    v_resources TEXT[] := ARRAY['org','users','settings','clients','accounts',
        'operations','credit','recovery','treasury','accounting','reports',
        'compliance','it_security','hr','audit'];
    v_admins TEXT[] := ARRAY['superadmin','admin_imf'];
BEGIN
    FOREACH v_role IN ARRAY v_admins LOOP
      FOREACH v_res IN ARRAY v_resources LOOP
        FOREACH v_verb IN ARRAY ARRAY['READ','WRITE','UPDATE','DELETE','VALIDATE']::rbac_verb[] LOOP
          INSERT INTO rbac_rule(imf_id, role_key, resource, verb, scope)
          VALUES (NULL, v_role, v_res, v_verb, 'tenant')
          ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid),
                       role_key, resource, verb) DO NOTHING;
        END LOOP;
      END LOOP;
    END LOOP;
END $$;

-- Règles scopées (role, resource, verb, scope). Table lisible = source de vérité.
INSERT INTO rbac_rule(imf_id, role_key, resource, verb, scope) VALUES
 -- Conformité (LAB-FT) : pilote la conformité, lit tout pour la surveillance.
 (NULL,'compliance_officer','compliance','READ','service'),
 (NULL,'compliance_officer','compliance','WRITE','service'),
 (NULL,'compliance_officer','compliance','UPDATE','service'),
 (NULL,'compliance_officer','compliance','VALIDATE','service'),
 (NULL,'compliance_officer','clients','READ','tenant'),
 (NULL,'compliance_officer','operations','READ','tenant'),
 (NULL,'compliance_officer','operations','VALIDATE','tenant'),
 (NULL,'compliance_officer','audit','READ','tenant'),
 (NULL,'compliance_officer','reports','READ','tenant'),
 -- SI & Sécurité : administration système.
 (NULL,'it_admin','it_security','READ','tenant'),
 (NULL,'it_admin','it_security','WRITE','tenant'),
 (NULL,'it_admin','it_security','UPDATE','tenant'),
 (NULL,'it_admin','it_security','DELETE','tenant'),
 (NULL,'it_admin','users','READ','tenant'),
 (NULL,'it_admin','users','UPDATE','tenant'),
 (NULL,'it_admin','settings','READ','tenant'),
 (NULL,'it_admin','audit','READ','tenant'),
 -- SI & Sécurité : ingénierie sécurité.
 (NULL,'security_engineer','it_security','READ','service'),
 (NULL,'security_engineer','it_security','WRITE','service'),
 (NULL,'security_engineer','it_security','UPDATE','service'),
 (NULL,'security_engineer','audit','READ','tenant'),
 (NULL,'security_engineer','operations','READ','tenant'),
 -- Crédit : directeur (périmètre département, valide les dossiers).
 (NULL,'credit_director','credit','READ','department'),
 (NULL,'credit_director','credit','WRITE','department'),
 (NULL,'credit_director','credit','UPDATE','department'),
 (NULL,'credit_director','credit','DELETE','department'),
 (NULL,'credit_director','credit','VALIDATE','department'),
 (NULL,'credit_director','recovery','READ','department'),
 (NULL,'credit_director','recovery','UPDATE','department'),
 (NULL,'credit_director','recovery','VALIDATE','department'),
 (NULL,'credit_director','clients','READ','department'),
 (NULL,'credit_director','reports','READ','department'),
 -- Crédit : analyste (instruit, ne valide pas).
 (NULL,'credit_analyst','credit','READ','service'),
 (NULL,'credit_analyst','credit','WRITE','service'),
 (NULL,'credit_analyst','credit','UPDATE','service'),
 (NULL,'credit_analyst','clients','READ','service'),
 (NULL,'credit_analyst','reports','READ','service'),
 -- Crédit : recouvrement.
 (NULL,'recovery_agent','recovery','READ','service'),
 (NULL,'recovery_agent','recovery','WRITE','service'),
 (NULL,'recovery_agent','recovery','UPDATE','service'),
 (NULL,'recovery_agent','credit','READ','service'),
 (NULL,'recovery_agent','clients','READ','service'),
 -- Opérations : directeur.
 (NULL,'operations_director','operations','READ','department'),
 (NULL,'operations_director','operations','WRITE','department'),
 (NULL,'operations_director','operations','UPDATE','department'),
 (NULL,'operations_director','operations','VALIDATE','department'),
 (NULL,'operations_director','clients','READ','department'),
 (NULL,'operations_director','clients','WRITE','department'),
 (NULL,'operations_director','clients','UPDATE','department'),
 (NULL,'operations_director','accounts','READ','department'),
 (NULL,'operations_director','accounts','WRITE','department'),
 (NULL,'operations_director','accounts','UPDATE','department'),
 (NULL,'operations_director','users','READ','department'),
 (NULL,'operations_director','reports','READ','department'),
 -- Opérations : guichetier / caissier (déclare ET valide les versements).
 (NULL,'teller','operations','READ','service'),
 (NULL,'teller','operations','WRITE','service'),
 (NULL,'teller','operations','VALIDATE','service'),
 (NULL,'teller','clients','READ','service'),
 (NULL,'teller','accounts','READ','service'),
 -- Opérations : chargé de clientèle (enrôlement).
 (NULL,'customer_agent','clients','READ','service'),
 (NULL,'customer_agent','clients','WRITE','service'),
 (NULL,'customer_agent','clients','UPDATE','service'),
 (NULL,'customer_agent','accounts','READ','service'),
 (NULL,'customer_agent','accounts','WRITE','service'),
 (NULL,'customer_agent','operations','READ','service'),
 -- Finance : CFO.
 (NULL,'cfo','treasury','READ','department'),
 (NULL,'cfo','treasury','WRITE','department'),
 (NULL,'cfo','treasury','UPDATE','department'),
 (NULL,'cfo','treasury','VALIDATE','department'),
 (NULL,'cfo','accounting','READ','department'),
 (NULL,'cfo','accounting','UPDATE','department'),
 (NULL,'cfo','accounting','VALIDATE','department'),
 (NULL,'cfo','reports','READ','tenant'),
 (NULL,'cfo','settings','READ','tenant'),
 -- Finance : trésorier.
 (NULL,'treasurer','treasury','READ','service'),
 (NULL,'treasurer','treasury','WRITE','service'),
 (NULL,'treasurer','treasury','UPDATE','service'),
 (NULL,'treasurer','accounting','READ','service'),
 (NULL,'treasurer','reports','READ','department'),
 -- Finance : comptable.
 (NULL,'accountant','accounting','READ','service'),
 (NULL,'accountant','accounting','WRITE','service'),
 (NULL,'accountant','accounting','UPDATE','service'),
 (NULL,'accountant','treasury','READ','service'),
 (NULL,'accountant','reports','READ','department'),
 -- Audit interne : lecture seule sur tout le tenant (aucune écriture).
 (NULL,'auditor','audit','READ','tenant'),
 (NULL,'auditor','reports','READ','tenant'),
 (NULL,'auditor','clients','READ','tenant'),
 (NULL,'auditor','operations','READ','tenant'),
 (NULL,'auditor','credit','READ','tenant'),
 (NULL,'auditor','accounting','READ','tenant'),
 (NULL,'auditor','treasury','READ','tenant'),
 (NULL,'auditor','compliance','READ','tenant'),
 -- RH & Logistique.
 (NULL,'hr_logistics_manager','hr','READ','department'),
 (NULL,'hr_logistics_manager','hr','WRITE','department'),
 (NULL,'hr_logistics_manager','hr','UPDATE','department'),
 (NULL,'hr_logistics_manager','hr','DELETE','department'),
 (NULL,'hr_logistics_manager','users','READ','tenant'),
 (NULL,'hr_logistics_manager','users','WRITE','tenant'),
 (NULL,'hr_logistics_manager','users','UPDATE','tenant'),
 (NULL,'hr_logistics_manager','reports','READ','department')
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid),
             role_key, resource, verb) DO NOTHING;

-- -------------------------------------------------------------------------
-- 8. Matérialisation de la structure dans org_unit pour un tenant donné.
--    Crée la Direction Générale, puis les 8 départements et leurs services,
--    de façon idempotente. Respecte le cloisonnement (imf_id).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_seed_org_structure(p_imf UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_dg    UUID;
    d       RECORD;
    s       RECORD;
    v_dept  UUID;
BEGIN
    -- Direction Générale (racine), une seule par IMF.
    SELECT id INTO v_dg FROM org_unit
      WHERE imf_id = p_imf AND kind = 'direction' AND code_unit = 'DG::'||p_imf;
    IF v_dg IS NULL THEN
        INSERT INTO org_unit(imf_id, parent_id, kind, code_unit, name)
        VALUES (p_imf, NULL, 'direction', 'DG::'||p_imf, 'Direction Générale')
        RETURNING id INTO v_dg;
    END IF;

    FOR d IN SELECT code,label FROM department_catalog WHERE code <> 'DG' ORDER BY sort_order LOOP
        SELECT id INTO v_dept FROM org_unit
          WHERE imf_id = p_imf AND kind = 'department' AND code_unit = d.code||'::'||p_imf;
        IF v_dept IS NULL THEN
            INSERT INTO org_unit(imf_id, parent_id, kind, code_unit, name)
            VALUES (p_imf, v_dg, 'department', d.code||'::'||p_imf, d.label)
            RETURNING id INTO v_dept;
        END IF;
        FOR s IN SELECT code,label FROM service_catalog WHERE dept_code = d.code ORDER BY sort_order LOOP
            IF NOT EXISTS (SELECT 1 FROM org_unit WHERE imf_id = p_imf
                             AND kind='service' AND code_unit = s.code||'::'||p_imf) THEN
                INSERT INTO org_unit(imf_id, parent_id, kind, code_unit, name)
                VALUES (p_imf, v_dept, 'service', s.code||'::'||p_imf, s.label);
            END IF;
        END LOOP;
    END LOOP;
END $$;
