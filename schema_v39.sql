-- ===========================================================================
-- VAGUE 38 bis — CORRECTIF CRÉDIT (migration idempotente, rejouable)
-- ---------------------------------------------------------------------------
-- Cause racine : l'assurance de l'échéancier était facturée mais jamais
-- imputée lors d'un remboursement. Une échéance portant de l'assurance ne
-- pouvait donc JAMAIS atteindre le statut « PAYE », et un dossier avec
-- assurance ne pouvait jamais être clôturé.
-- Correctif : on suit désormais l'assurance payée, ligne par ligne.
-- Aucun impact sur la caisse ni sur les données existantes (colonne à 0).
-- ===========================================================================
ALTER TABLE echeanciers_credit
  ADD COLUMN IF NOT EXISTS assurance_payee_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE echeanciers_credit DROP CONSTRAINT IF EXISTS chk_echeance_assurance;
ALTER TABLE echeanciers_credit ADD CONSTRAINT chk_echeance_assurance
  CHECK (assurance_payee_cents >= 0 AND assurance_payee_cents <= assurance_cents);

-- Les natures d'imputation acceptent désormais l'assurance.
ALTER TABLE imputations_remboursement DROP CONSTRAINT IF EXISTS chk_imput_nature;
ALTER TABLE imputations_remboursement ADD CONSTRAINT chk_imput_nature
  CHECK (nature IN ('PENALITE', 'INTERET', 'ASSURANCE', 'CAPITAL', 'TROP_PERCU'));

-- Rattrapage : les échéances déjà soldées côté capital et intérêts
-- reçoivent l'assurance correspondante (sinon elles resteraient PARTIEL).
UPDATE echeanciers_credit
   SET assurance_payee_cents = assurance_cents,
       statut = 'PAYE',
       date_paiement = COALESCE(date_paiement, now())
 WHERE assurance_cents > 0
   AND assurance_payee_cents = 0
   AND capital_paye_cents >= capital_cents
   AND interet_paye_cents >= interet_cents
   AND statut <> 'PAYE';
