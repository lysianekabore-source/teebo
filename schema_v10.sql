-- =========================================================================
-- schema_v10 : Réinitialisation de mot de passe (« mot de passe oublié »)
-- -------------------------------------------------------------------------
-- Jetons à usage unique, hachés (SHA-256) et à durée de vie courte.
-- Le jeton en clair n'est JAMAIS stocké : il est transmis à l'utilisateur
-- par e-mail / WhatsApp et comparé par empreinte, comme les sessions.
-- Respecte le cloisonnement : chaque jeton est lié à un utilisateur précis.
--
-- IDEMPOTENCE / AUTO-RÉPARATION (correctif) :
--   Sur une base DÉJÀ déployée, la table password_reset pouvait exister avec
--   une structure ANTÉRIEURE (sans la colonne token_hash). « CREATE TABLE IF
--   NOT EXISTS » n'ajoute PAS les colonnes manquantes : la création de l'index
--   sur token_hash échouait alors avec « column "token_hash" does not exist »
--   (PostgreSQL 42703). On crée donc la table SI absente, PUIS on ajoute chaque
--   colonne SI absente (ADD COLUMN IF NOT EXISTS), AVANT de créer les index.
--   Ce fichier se rejoue ainsi sans erreur sur une base vierge comme sur une
--   base déjà existante.
-- =========================================================================
CREATE TABLE IF NOT EXISTS password_reset (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    imf_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);

-- Auto-réparation : garantir la présence de CHAQUE colonne même si la table
-- provient d'un déploiement antérieur à la structure ci-dessus.
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS user_id     UUID;
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS imf_id      UUID;
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS token_hash  TEXT;
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;
ALTER TABLE password_reset ADD COLUMN IF NOT EXISTS used_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_hash ON password_reset(token_hash);
