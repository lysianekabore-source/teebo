-- teebo — Migration : invitation & changement de mot de passe obligatoire
-- =========================================================================
-- Ajoute le drapeau must_change_password sur app_user.
--   • true  -> l'utilisateur DOIT changer son mot de passe à la connexion
--             (compte créé depuis l'interface, ou mot de passe réinitialisé
--              par un administrateur).
--   • false -> mot de passe personnel, plus d'obligation.
-- À exécuter APRÈS 003_seed.sql. Idempotent (ADD COLUMN IF NOT EXISTS).
-- =========================================================================

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Les comptes de départ (seed) gardent must_change_password = false :
-- ils servent à ouvrir l'application. Changez leur mot de passe depuis
-- l'onglet « Utilisateurs » ou via le changement à la connexion.
