-- teebo — VAGUE 19 : Arrêté de caisse enrichi (caissier & agent de collecte)
-- ---------------------------------------------------------------------------
-- Objectif :
--   1) Date = jour courant par défaut (déjà : closing_date DEFAULT CURRENT_DATE).
--   2) Solde théorique AUTO-calculé (solde antérieur + opérations), non saisi.
--   3) Billetage : comptage par coupure XOF (billets/pièces BCEAO) → espèces
--      comptées. On conserve le détail des coupures.
--   4) Tout écart (théorique vs compté) DOIT être justifié avant clôture et
--      réglé définitivement sous 24h (échéance tracée + statut de résolution).
-- Toutes les colonnes sont ajoutées de façon idempotente.
-- ---------------------------------------------------------------------------

ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS denominations JSONB;
  -- billetage : { "10000": 3, "5000": 2, ... } (clé = valeur faciale FCFA)
ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS gap_justification TEXT;
  -- justification obligatoire dès qu'il existe un écart
ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS gap_due_at TIMESTAMPTZ;
  -- échéance de règlement définitif de l'écart (clôture + 24h)
ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS gap_resolved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS gap_resolved_at TIMESTAMPTZ;
ALTER TABLE cash_closing ADD COLUMN IF NOT EXISTS gap_resolution_note TEXT;

-- Un arrêté avec écart non justifié ne doit jamais exister : garde-fou base.
ALTER TABLE cash_closing DROP CONSTRAINT IF EXISTS chk_cashclose_gap_justified;
ALTER TABLE cash_closing ADD CONSTRAINT chk_cashclose_gap_justified
  CHECK (gap_cents = 0 OR (gap_justification IS NOT NULL AND length(btrim(gap_justification)) > 0));
