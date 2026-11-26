-- Preserve dates manually chosen before v79. New/unconfigured institutions use today's date.
CREATE TABLE IF NOT EXISTS imf_accounting_context (
 imf_id uuid PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
 accounting_date date NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES app_user(id),
 date_mode text NOT NULL DEFAULT 'manual' CHECK (date_mode IN ('automatic','manual'))
); ALTER TABLE imf_accounting_context ADD COLUMN IF NOT EXISTS date_mode text NOT NULL DEFAULT 'manual' CHECK (date_mode IN ('automatic','manual'));
