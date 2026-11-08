-- teebo — Migration : matrice des habilitations (modèle à deux étages)
-- Multi-tenant par imf_id. Audit append-only. Requêtes paramétrées côté app.
-- À exécuter une seule fois sur la base PostgreSQL de teebo.

-- 1) Habilitations AUTORISÉES par teebo pour chaque IMF (périmètre souscrit).
CREATE TABLE IF NOT EXISTS imf_entitlement (
  imf_id          TEXT        NOT NULL,
  permission_code TEXT        NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT,
  PRIMARY KEY (imf_id, permission_code)
);

-- 2) Habilitations ACCORDÉES par l'admin IMF à chaque utilisateur.
--    (présence d'une ligne = habilitation accordée)
CREATE TABLE IF NOT EXISTS user_permission (
  imf_id          TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  permission_code TEXT        NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT,
  PRIMARY KEY (imf_id, user_id, permission_code)
);
CREATE INDEX IF NOT EXISTS idx_user_permission_imf ON user_permission (imf_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_user ON user_permission (imf_id, user_id);

-- 3) Journal append-only de tous les changements d'habilitations.
CREATE TABLE IF NOT EXISTS habilitation_audit (
  id              BIGSERIAL   PRIMARY KEY,
  imf_id          TEXT        NOT NULL,
  actor_id        TEXT,                       -- qui a fait le changement
  scope           TEXT        NOT NULL,       -- 'teebo' ou 'imf'
  target_id       TEXT,                       -- imf_id (teebo) ou user_id (imf)
  permission_code TEXT        NOT NULL,
  action          TEXT        NOT NULL,       -- ENABLE/DISABLE/GRANT/REVOKE
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hab_audit_imf ON habilitation_audit (imf_id, created_at DESC);

-- Garde-fou applicatif : l'habilitation 'credit.auto_disburse' est refusée
-- côté serveur (voir catalog.js). On peut aussi le verrouiller en base :
-- empêcher toute activation accidentelle du décaissement IA automatique.
CREATE OR REPLACE FUNCTION teebo_block_forbidden() RETURNS trigger AS $$
BEGIN
  IF NEW.permission_code = 'credit.auto_disburse' AND NEW.enabled = true THEN
    RAISE EXCEPTION 'Habilitation interdite (BCEAO) : credit.auto_disburse ne peut pas etre activee';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_forbidden ON imf_entitlement;
CREATE TRIGGER trg_block_forbidden
  BEFORE INSERT OR UPDATE ON imf_entitlement
  FOR EACH ROW EXECUTE FUNCTION teebo_block_forbidden();

CREATE OR REPLACE FUNCTION teebo_block_forbidden_user() RETURNS trigger AS $$
BEGIN
  IF NEW.permission_code = 'credit.auto_disburse' THEN
    RAISE EXCEPTION 'Habilitation interdite (BCEAO) : credit.auto_disburse ne peut pas etre accordee';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_forbidden_user ON user_permission;
CREATE TRIGGER trg_block_forbidden_user
  BEFORE INSERT OR UPDATE ON user_permission
  FOR EACH ROW EXECUTE FUNCTION teebo_block_forbidden_user();

-- NB : la table imf(id, name) et app_user(id, imf_id, full_name, role) proviennent
-- des livraisons précédentes (RBAC / multi-tenant).
