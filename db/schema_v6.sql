-- ===========================================================================
-- teebo — Schéma VAGUE 9
-- ---------------------------------------------------------------------------
--  * Réinitialisation de mot de passe (« mot de passe oublié ») pour TOUS les
--    comptes : code à usage unique, à durée limitée, envoyé par WhatsApp/e-mail.
--  * Coordonnées de notification de l'IMF (WhatsApp + e-mail) paramétrables par
--    l'administrateur IMF, pour l'envoi des codes d'accès de SES utilisateurs.
-- Toutes les instructions sont idempotentes.
-- ===========================================================================

-- Coordonnées de notification propres à l'IMF (paramètres admin IMF).
ALTER TABLE imf_document_settings ADD COLUMN IF NOT EXISTS notif_whatsapp TEXT;
ALTER TABLE imf_document_settings ADD COLUMN IF NOT EXISTS notif_email    TEXT;

-- Codes de réinitialisation de mot de passe (usage unique, expiration courte).
CREATE TABLE IF NOT EXISTS password_reset (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset(user_id);

COMMIT;
