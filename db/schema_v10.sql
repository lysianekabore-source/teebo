-- =========================================================================
-- schema_v10 : Réinitialisation de mot de passe (« mot de passe oublié »)
-- -------------------------------------------------------------------------
-- Jetons à usage unique, hachés (SHA-256) et à durée de vie courte.
-- Le jeton en clair n'est JAMAIS stocké : il est transmis à l'utilisateur
-- par e-mail / WhatsApp et comparé par empreinte, comme les sessions.
-- Respecte le cloisonnement : chaque jeton est lié à un utilisateur précis.
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
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_hash ON password_reset(token_hash);
