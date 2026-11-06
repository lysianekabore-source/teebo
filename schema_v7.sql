-- ===========================================================================
-- teebo — Schéma VAGUE 10
-- ---------------------------------------------------------------------------
-- Deux ajouts, tous idempotents (CREATE TABLE IF NOT EXISTS) :
--  1) code_dispatch_log : journal des ENVOIS de codes d'accès (création ou
--     renvoi). Alimente le tableau de bord « Suivi des envois de codes ».
--  2) user_permission   : habilitations fines par utilisateur, initialisées
--     à partir de la matrice de profils par défaut lors de la création d'un
--     utilisateur IMF. Le cloisonnement reste assuré par imf_id.
-- ===========================================================================

-- 1) Journal des envois de codes d'accès ------------------------------------
CREATE TABLE IF NOT EXISTS code_dispatch_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES app_user(id) ON DELETE SET NULL, -- destinataire
    recipient_name  TEXT,                 -- nom du destinataire (copie figée)
    code_user       TEXT,                 -- code d'accès transmis
    to_phone        TEXT,                 -- numéro WhatsApp destinataire
    to_email        TEXT,                 -- e-mail destinataire
    channel         TEXT NOT NULL DEFAULT 'creation', -- 'creation' | 'resend'
    whatsapp_mode   TEXT,                 -- 'sent' | 'manual' | 'failed' | 'skipped'
    email_mode      TEXT,                 -- idem pour l'e-mail
    dispatched_by   UUID REFERENCES app_user(id) ON DELETE SET NULL, -- admin émetteur
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_dispatch_imf  ON code_dispatch_log(imf_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_dispatch_user ON code_dispatch_log(user_id);

-- 2) Habilitations fines par utilisateur ------------------------------------
CREATE TABLE IF NOT EXISTS user_permission (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    permission_key  TEXT NOT NULL,        -- clé de domaine (voir permissions.js)
    allowed         BOOLEAN NOT NULL DEFAULT true,
    source          TEXT NOT NULL DEFAULT 'default', -- 'default' | 'custom'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_user ON user_permission(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_imf  ON user_permission(imf_id);

COMMIT;
