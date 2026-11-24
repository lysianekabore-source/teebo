-- teebo — VAGUE 23 : ayant droit, domiciliation du revenu, fiche signable
-- (PDF/impression + signatures numériques stylet/empreinte), contrôle de
-- conformité des pièces scannées avant ouverture de compte, et renforcement
-- de l'anti-doublon (n° pièce + téléphone + nom/prénom) sur les fiches.
-- ---------------------------------------------------------------------------

-- 0) CLÉS NORMALISÉES anti-doublon (recherche par n° pièce, tél, nom).
--    Alimentées à la création par normalizeClientFields (collecte_extra.js).
ALTER TABLE client ADD COLUMN IF NOT EXISTS name_norm       TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS phone_norm      TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_number_norm  TEXT;

-- 1) AYANT DROIT (bénéficiaire) d'un PARTICULIER : nom, prénom, lien.
ALTER TABLE client ADD COLUMN IF NOT EXISTS beneficiary_last_name   TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS beneficiary_first_name  TEXT;
ALTER TABLE client ADD COLUMN IF NOT EXISTS beneficiary_relation    TEXT;

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_beneficiary_rel_chk;
ALTER TABLE client ADD CONSTRAINT client_beneficiary_rel_chk
  CHECK (beneficiary_relation IS NULL OR beneficiary_relation IN
    ('pere','mere','frere','soeur','enfant','ami','epouse','epoux','conjoint'));

-- 2) DOMICILIATION du salaire / de la pension (salarié / retraité) : case « oui ».
ALTER TABLE client ADD COLUMN IF NOT EXISTS salary_domiciliation BOOLEAN NOT NULL DEFAULT false;

-- 3) FICHE CLIENT : horodatage de la dernière signature apposée.
ALTER TABLE client ADD COLUMN IF NOT EXISTS fiche_signed_at TIMESTAMPTZ;

-- Signatures numériques (client + utilisateur/agent) : tracé au stylet sur
-- écran (image data URL) OU validation par empreinte digitale (attestation).
-- Une seule signature active par (client, rôle) — enregistrement idempotent.
CREATE TABLE IF NOT EXISTS client_signature (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,                 -- client | user
  method         TEXT NOT NULL,                 -- stylet | empreinte
  image_data_url TEXT,                          -- tracé au stylet (data:image/...)
  attestation    TEXT,                          -- marqueur d'authentification biométrique
  captured_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_signature_role_chk   CHECK (role IN ('client','user')),
  CONSTRAINT client_signature_method_chk CHECK (method IN ('stylet','empreinte')),
  CONSTRAINT client_signature_unique     UNIQUE (client_id, role)
);
CREATE INDEX IF NOT EXISTS idx_client_signature_client ON client_signature(client_id);

-- 4) CONTRÔLE DE CONFORMITÉ des pièces scannées : l'agent scanne chaque
--    document reçu, le confronte aux informations saisies, et le système
--    dégage les champs non conformes à corriger AVANT l'ouverture de compte.
ALTER TABLE client ADD COLUMN IF NOT EXISTS conformity_status      TEXT NOT NULL DEFAULT 'a_verifier';
ALTER TABLE client ADD COLUMN IF NOT EXISTS conformity_reviewed_at TIMESTAMPTZ;

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_conformity_status_chk;
ALTER TABLE client ADD CONSTRAINT client_conformity_status_chk
  CHECK (conformity_status IN ('a_verifier','conforme','non_conforme'));

-- Scans des pièces reçues (image rattachée au client ; valeurs lues en option).
CREATE TABLE IF NOT EXISTS client_document_scan (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id         UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  doc_type       TEXT,
  image_data_url TEXT NOT NULL,
  extracted      JSONB,                          -- valeurs lues sur le document
  uploaded_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_document_scan_client ON client_document_scan(client_id);

-- Résultat de la confrontation champ par champ (saisie vs scan) : trace les
-- informations non conformes à corriger avant l'ouverture du compte.
CREATE TABLE IF NOT EXISTS client_conformity_check (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imf_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  field_key   TEXT NOT NULL,
  field_label TEXT NOT NULL,
  expected    TEXT,
  scanned     TEXT,
  is_conform  BOOLEAN NOT NULL DEFAULT false,
  reviewed_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_conformity_check_client ON client_conformity_check(client_id);

-- Index anti-doublon (recherche rapide par n° pièce, téléphone, nom normalisé).
CREATE INDEX IF NOT EXISTS idx_client_id_number_norm ON client(imf_id, id_number_norm);
CREATE INDEX IF NOT EXISTS idx_client_phone_norm     ON client(imf_id, phone_norm);
CREATE INDEX IF NOT EXISTS idx_client_name_norm      ON client(imf_id, name_norm);
