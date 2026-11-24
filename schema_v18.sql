-- =========================================================================
-- schema_v18 : Auto-réparation des colonnes "token_hash" (correctif deploy)
-- -------------------------------------------------------------------------
-- CONTEXTE : le déploiement Render échouait à la migration avec
--   « column "token_hash" does not exist » (PostgreSQL 42703), lors de la
--   création d'un index sur une table d'authentification dont la structure,
--   sur une base DÉJÀ déployée, datait d'une version ANTÉRIEURE sans cette
--   colonne. « CREATE TABLE IF NOT EXISTS » n'ajoute pas les colonnes
--   manquantes, d'où l'échec de l'index.
--
-- Ce fichier garantit, de façon idempotente et sans jamais détruire de
-- données, que les colonnes token_hash existent sur TOUTES les tables qui en
-- dépendent (session, login_challenge, password_reset), AVANT (re)création des
-- index correspondants. Il se rejoue sans erreur sur une base vierge comme sur
-- une base existante.
-- =========================================================================

-- 1) Sessions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID,
    imf_id        UUID,
    token_hash    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    revoked       BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE session ADD COLUMN IF NOT EXISTS token_hash   TEXT;
ALTER TABLE session ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE session ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ;
ALTER TABLE session ADD COLUMN IF NOT EXISTS revoked      BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_hash ON session(token_hash);

-- 2) Défis 2FA (login_challenge) ----------------------------------------
CREATE TABLE IF NOT EXISTS login_challenge (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID,
    imf_id      UUID,
    token_hash  TEXT,
    consumed    BOOLEAN NOT NULL DEFAULT false,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE login_challenge ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_login_challenge_hash ON login_challenge(token_hash);

-- 3) Réinitialisation de mot de passe (password_reset) ------------------
CREATE TABLE IF NOT EXISTS password_reset (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID,
    imf_id      UUID,
    token_hash  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    used_at     TIMESTAMPTZ
);
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_password_reset_hash ON password_reset(token_hash);
