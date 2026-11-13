-- =========================================================================
-- VAGUE 32 — ACTIONNARIAT : exports et convocations d'AG
-- Additive et reentrante : complete la vague 31.
--   1. gouvernance_export_log accepte la feuille de presence (PDF / Excel)
--   2. sessions_et_pv : convocation et type d'AG (ordinaire / extraordinaire)
-- =========================================================================
ALTER TABLE gouvernance_export_log DROP CONSTRAINT IF EXISTS gouvernance_export_log_type_export_check;
ALTER TABLE gouvernance_export_log
  ADD CONSTRAINT gouvernance_export_log_type_export_check
  CHECK (type_export IN ('RAPPORT_CAC_PDF','RAPPORT_CAC_EXCEL','PACK_INSPECTION_ZIP',
                         'FEUILLE_PRESENCE_AG_PDF','FEUILLE_PRESENCE_AG_EXCEL'));

ALTER TABLE sessions_et_pv ADD COLUMN IF NOT EXISTS convocation_envoyee_le DATE;
ALTER TABLE sessions_et_pv ADD COLUMN IF NOT EXISTS ag_extraordinaire BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_session_type ON sessions_et_pv(imf_id, type_session, date_session DESC);
