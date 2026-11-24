-- ===========================================================================
-- teebo — VAGUE 48 : CORRECTIFS DE LA CAMPAGNE DE VERIFICATION DES ROUTES
-- ===========================================================================
-- CE QUE CE SCRIPT APPORTE (100 % additif, AUCUNE donnee supprimee)
--
--  1. app_user.updated_at : la table des comptes utilisateurs n'avait pas de
--     colonne « date de dernière modification ». Les ecrans qui activent /
--     desactivent un compte (et ceux qui corrigent un e-mail ou un telephone)
--     la mettaient a jour : la requete echouait et l'ecran repondait 500.
--     On ajoute la colonne de facon ADDITIVE et on l'alimente.
--
--  2. Un petit index pour retrouver vite un compte par son code d'acces.
--
-- Le script est idempotent : le relancer ne change rien.
-- ===========================================================================

BEGIN;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Les comptes existants recoivent created_at comme point de depart.
UPDATE app_user
   SET updated_at = COALESCE(updated_at, created_at, now())
 WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_updated_at ON app_user (updated_at);

COMMIT;
