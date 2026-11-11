-- teebo — VAGUE 22 : Pièces requises à la création d'un client PARTICULIER
-- ---------------------------------------------------------------------------
-- Après la typologie, le dossier d'un PARTICULIER impose une liste de pièces :
--  1) Document officiel d'identité valide (CNI / Passeport / CEDEAO /
--     carte consulaire ou de séjour) + case « document physique reçu » ;
--     acte de naissance « reçu » ou « à compléter ».
--  2) Identité : nom, prénom, téléphone, dates et lieu de naissance,
--     n° + date d'établissement de la pièce ; la date d'expiration est
--     CALCULÉE automatiquement = date d'établissement + durée de validité
--     par défaut de la localité (paramètre IMF par type de pièce).
--  3) Localisation : plan de localisation du domicile et du lieu d'activité
--     (itinéraire + repères, obligatoires) + justificatifs reçus/non reçus.
--  4) Activité & revenu selon la profession (salarié / retraité / informel /
--     étudiant).
-- ---------------------------------------------------------------------------

-- Paramètre IMF : durée de validité par défaut (en MOIS) de chaque type de
-- pièce d'identité, selon la localité de l'IMF. Ex : {"cni":120,"passeport":60}.
ALTER TABLE imf_document_settings
  ADD COLUMN IF NOT EXISTS id_doc_validity_months JSONB;

-- Identité détaillée du particulier.
ALTER TABLE client ADD COLUMN IF NOT EXISTS first_name          TEXT;  -- prénom
ALTER TABLE client ADD COLUMN IF NOT EXISTS last_name           TEXT;  -- nom
ALTER TABLE client ADD COLUMN IF NOT EXISTS birth_place         TEXT;  -- lieu de naissance

-- Pièce officielle d'identité.
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_doc_type         TEXT;     -- cni|passeport|cedeao|consulaire_sejour
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_doc_received     BOOLEAN NOT NULL DEFAULT false;  -- document physique reçu
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_doc_number       TEXT;     -- n° de la pièce
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_doc_issue_date   DATE;     -- date d'établissement
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_doc_expiry_date  DATE;     -- date d'expiration (calculée)
ALTER TABLE client ADD COLUMN IF NOT EXISTS birth_cert_status   TEXT;     -- recu|a_completer (acte de naissance)

-- Localisation du domicile et du lieu d'activité + justificatifs.
ALTER TABLE client ADD COLUMN IF NOT EXISTS home_location_desc     TEXT;  -- plan de localisation du domicile
ALTER TABLE client ADD COLUMN IF NOT EXISTS home_proof_status      TEXT;  -- recu|non_recu
ALTER TABLE client ADD COLUMN IF NOT EXISTS home_proof_type        TEXT;  -- cf. client_documents.js
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_location_desc TEXT;  -- plan de localisation d'activité
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_proof_status  TEXT;  -- recu|non_recu
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_proof_type    TEXT;  -- cf. client_documents.js

-- Activité & revenu.
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_description TEXT;  -- description de l'activité (informel)
ALTER TABLE client ADD COLUMN IF NOT EXISTS school_name         TEXT;  -- université / école (étudiant)
ALTER TABLE client ADD COLUMN IF NOT EXISTS income_proof_status TEXT;  -- recu|non_recu
ALTER TABLE client ADD COLUMN IF NOT EXISTS income_proof_type   TEXT;  -- cf. client_documents.js (selon profession)

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_id_doc_type_chk;
ALTER TABLE client ADD CONSTRAINT client_id_doc_type_chk
  CHECK (id_doc_type IS NULL OR id_doc_type IN ('cni','passeport','cedeao','consulaire_sejour'));

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_birth_cert_status_chk;
ALTER TABLE client ADD CONSTRAINT client_birth_cert_status_chk
  CHECK (birth_cert_status IS NULL OR birth_cert_status IN ('recu','a_completer'));

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_home_proof_status_chk;
ALTER TABLE client ADD CONSTRAINT client_home_proof_status_chk
  CHECK (home_proof_status IS NULL OR home_proof_status IN ('recu','non_recu'));

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_activity_proof_status_chk;
ALTER TABLE client ADD CONSTRAINT client_activity_proof_status_chk
  CHECK (activity_proof_status IS NULL OR activity_proof_status IN ('recu','non_recu'));

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_income_proof_status_chk;
ALTER TABLE client ADD CONSTRAINT client_income_proof_status_chk
  CHECK (income_proof_status IS NULL OR income_proof_status IN ('recu','non_recu'));
