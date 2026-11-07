-- ===========================================================================
-- teebo — Schéma VAGUE 9
-- ---------------------------------------------------------------------------
-- Canaux d'ENVOI des codes d'accès paramétrables par l'administrateur IMF.
-- L'IMF choisit le numéro WhatsApp et l'adresse e-mail « expéditeur » qui
-- serviront à transmettre les codes d'accès à son personnel. À défaut, on
-- retombe sur les coordonnées de la fiche imf (whatsapp / email).
-- Toutes les instructions sont idempotentes (ADD COLUMN IF NOT EXISTS).
-- ===========================================================================

ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS notify_whatsapp TEXT; -- numéro WhatsApp expéditeur des codes
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS notify_email    TEXT; -- e-mail expéditeur des codes

COMMIT;
