-- Date comptable choisie explicitement par l’IMF. Aucune date implicite.
CREATE TABLE IF NOT EXISTS imf_accounting_context (
 imf_id uuid PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
 accounting_date date NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES app_user(id)
);
