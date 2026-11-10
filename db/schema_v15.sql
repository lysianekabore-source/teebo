-- teebo — VAGUE 15 : opérations bancaires RÉELLEMENT fonctionnelles
-- ---------------------------------------------------------------------------
-- Rend opérationnelles (backend + écrans) les fonctionnalités clés des postes :
--   Clients      : modifier une fiche (le gel/dégel existe déjà, round.js).
--   Caisse       : valider un dépassement de plafond ; arrêté de caisse &
--                  rapprochement.
--   Coffre       : approvisionner / délester (mouvements tracés + solde).
--   Comptabilité : saisir des écritures (charges, taxes) ; clôture comptable.
--   Crédit       : suivi des impayés & recouvrement.
-- Tout est cloisonné par imf_id ; les écrans sont gardés par les habilitations
-- de la matrice (schema_v13/v14), désormais effectivement appliquées côté
-- backend via fn_position_default_perms (voir auth.js userHasPermission).
-- ---------------------------------------------------------------------------

-- 1. Dépassement de plafond : demande + validation (habilitation cash.approve)
CREATE TABLE IF NOT EXISTS cash_overrun_request (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id        UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  client_id     UUID REFERENCES client(id) ON DELETE SET NULL,
  requested_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'client',      -- 'client' | 'caisse'
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  cap_cents     BIGINT NOT NULL DEFAULT 0,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'en_attente',  -- en_attente|approuve|rejete
  decided_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_overrun_imf ON cash_overrun_request(imf_id, status, created_at);

-- 2. Arrêté de caisse & rapprochement
CREATE TABLE IF NOT EXISTS cash_closing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id            UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES app_user(id) ON DELETE SET NULL,
  closing_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  theoretical_cents BIGINT NOT NULL DEFAULT 0,  -- solde théorique (système)
  counted_cents     BIGINT NOT NULL DEFAULT 0,  -- espèces comptées
  gap_cents         BIGINT NOT NULL DEFAULT 0,  -- écart = compté - théorique
  status            TEXT NOT NULL DEFAULT 'equilibre', -- equilibre|ecart
  note              TEXT,
  created_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cashclose_imf ON cash_closing(imf_id, closing_date);

-- 3. Mouvements de coffre (approvisionner / délester) + solde courant
CREATE TABLE IF NOT EXISTS vault_movement (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL,              -- 'approvisionnement' | 'delestage'
  amount_cents        BIGINT NOT NULL DEFAULT 0,
  counterpart         TEXT,                        -- 'caisse' | 'banque'
  reason              TEXT,
  balance_after_cents BIGINT NOT NULL DEFAULT 0,
  created_by          UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vault_imf ON vault_movement(imf_id, created_at);

-- 4. Écritures comptables (charges, taxes, produits, OD)
CREATE TABLE IF NOT EXISTS accounting_entry (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  entry_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  journal        TEXT NOT NULL DEFAULT 'OD',       -- OD|CAISSE|BANQUE|ACHATS
  category       TEXT NOT NULL DEFAULT 'charge',   -- charge|taxe|produit|od
  label          TEXT NOT NULL,
  debit_account  TEXT,
  credit_account TEXT,
  amount_cents   BIGINT NOT NULL DEFAULT 0,
  period         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE,'YYYY-MM'),
  locked         BOOLEAN NOT NULL DEFAULT false,
  created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acctentry_imf ON accounting_entry(imf_id, period);

-- 5. Clôture comptable (verrouille la période)
CREATE TABLE IF NOT EXISTS accounting_period_close (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id     UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  totals     JSONB,
  closed_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imf_id, period)
);

-- 6. Actions de recouvrement (suivi des impayés)
CREATE TABLE IF NOT EXISTS credit_recovery_action (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  credit_file_id UUID REFERENCES credit_file(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'relance',  -- relance|promesse|echeancier|contentieux|encaissement
  amount_cents   BIGINT NOT NULL DEFAULT 0,
  note           TEXT,
  due_date       DATE,
  created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recovery_imf ON credit_recovery_action(imf_id, credit_file_id);

-- 7. Marqueur d'impayé sur le dossier de crédit (suivi recouvrement)
ALTER TABLE credit_file ADD COLUMN IF NOT EXISTS overdue BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE credit_file ADD COLUMN IF NOT EXISTS overdue_amount_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE credit_file ADD COLUMN IF NOT EXISTS overdue_since DATE;
