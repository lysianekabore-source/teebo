-- teebo — VAGUE 20 : Modèle de caisse corrigé (arrêté = vidage de caisse)
-- ---------------------------------------------------------------------------
-- 1) ARRÊTÉ CAISSIER : délestage de tout le compté vers le coffre-fort.
-- 2) ARRÊTÉ SACOCHE (agent de collecte) : reversement de tout le compté au
--    caissier (versement à valider).
-- 3) APPROVISIONNEMENT DE CAISSE (coffre → caisse) : RÉSERVÉ AU CAISSIER.
--    L'agent de collecte ne peut pas approvisionner sa sacoche.
-- 4) Les régularisations guichet (retrait_regul) n'impactent JAMAIS la caisse
--    (ni caissier, ni sacoche) : déjà impacts_agent_cash = false.
--
-- Les mouvements de coffre liés à une caisse (approvisionnement/délestage
-- avec contrepartie « caisse ») sont désormais RATTACHÉS au caissier concerné
-- (user_id) afin de calculer correctement son solde théorique.
-- ---------------------------------------------------------------------------

ALTER TABLE vault_movement ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_user(id) ON DELETE SET NULL;
  -- caissier rattaché au mouvement coffre↔caisse (NULL pour les mouvements
  -- coffre↔banque globaux de l'IMF).
CREATE INDEX IF NOT EXISTS idx_vault_user ON vault_movement(imf_id, user_id, created_at);
