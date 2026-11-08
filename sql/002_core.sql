-- teebo — Migration : socle utilisateurs & rôles RÉELS en base (production)
-- =========================================================================
-- Cette migration crée les tables sur lesquelles la matrice des habilitations
-- se branche réellement (fini les données de démo en mémoire) :
--   • imf            : les IMF clientes (multi-tenant)
--   • app_user       : les vrais utilisateurs (avec e-mail + mot de passe haché)
--   • role_template  : les RÔLES et leurs habilitations par défaut, EN BASE
-- À exécuter APRÈS 001_habilitations.sql, une seule fois.
-- =========================================================================

-- 1) IMF clientes -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS imf (
  id          TEXT        PRIMARY KEY,          -- ex. 'imf-001'
  name        TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Utilisateurs réels -----------------------------------------------------
-- password_hash : format scrypt$<selHex>$<hashHex> (voir password.js).
-- is_teebo_admin : super-admin plateforme (côté teebo), transverse aux IMF.
CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT        PRIMARY KEY,         -- ex. 'u1'
  imf_id        TEXT        REFERENCES imf(id),  -- NULL pour un admin teebo
  full_name     TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL,            -- clé d'un role_template
  is_teebo_admin BOOLEAN    NOT NULL DEFAULT false,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- E-mail unique par IMF (un admin teebo a imf_id NULL -> contrainte partielle).
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_email_imf
  ON app_user (lower(email), COALESCE(imf_id, '~teebo~'));
CREATE INDEX IF NOT EXISTS idx_app_user_imf ON app_user (imf_id);

-- 3) RÔLES et leurs habilitations par défaut, EN BASE ------------------------
-- Le préremplissage par rôle lit désormais CETTE table (plus le code JS).
-- Une ligne = « le rôle <role_key> inclut l'habilitation <permission_code> ».
CREATE TABLE IF NOT EXISTS role_template (
  role_key        TEXT NOT NULL,
  label           TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_key, permission_code)
);
CREATE INDEX IF NOT EXISTS idx_role_template_key ON role_template (role_key);

-- Garde-fou : un rôle ne peut jamais contenir l'habilitation interdite.
CREATE OR REPLACE FUNCTION teebo_block_forbidden_role() RETURNS trigger AS $$
BEGIN
  IF NEW.permission_code = 'credit.auto_disburse' THEN
    RAISE EXCEPTION 'Habilitation interdite (BCEAO) : credit.auto_disburse ne peut pas figurer dans un role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_block_forbidden_role ON role_template;
CREATE TRIGGER trg_block_forbidden_role
  BEFORE INSERT OR UPDATE ON role_template
  FOR EACH ROW EXECUTE FUNCTION teebo_block_forbidden_role();
