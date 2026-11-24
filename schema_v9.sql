-- ===========================================================================
-- teebo — Schéma VAGUE 12
-- ---------------------------------------------------------------------------
-- 1) Enrolement client conforme BCEAO / UEMOA (connaissance du client — KYC).
--    L'instruction BCEAO n°007-06-2020 (LBC/FT) et le dispositif prudentiel
--    SFD exigent, pour toute entrée en relation, un socle d'identification :
--      • état civil complet (nom, prénoms, sexe, date ET lieu de naissance,
--        nationalité, situation matrimoniale) ;
--      • pièce d'identité officielle : type, numéro, autorité, dates de
--        délivrance et d'expiration ;
--      • identifiant fiscal / NIU-NINA lorsqu'il existe ;
--      • profession, employeur, adresse précise, téléphone ;
--      • objet et nature de la relation d'affaires + origine des fonds ;
--      • détection des Personnes Politiquement Exposées (PPE) ;
--      • bénéficiaire effectif (si le client agit pour un tiers).
--
-- 2) Suppression d'une IMF par teebo (super-admin) : traçabilité d'audit.
--
-- Toutes les instructions sont idempotentes (rejouables sans effet de bord).
-- ===========================================================================

-- --- 1. Socle KYC BCEAO sur la fiche client --------------------------------
ALTER TABLE client ADD COLUMN IF NOT EXISTS gender            TEXT;   -- M / F
ALTER TABLE client ADD COLUMN IF NOT EXISTS birth_place       TEXT;   -- lieu de naissance
ALTER TABLE client ADD COLUMN IF NOT EXISTS nationality       TEXT;   -- nationalité
ALTER TABLE client ADD COLUMN IF NOT EXISTS marital_status    TEXT;   -- situation matrimoniale
ALTER TABLE client ADD COLUMN IF NOT EXISTS profession        TEXT;   -- profession / activité
ALTER TABLE client ADD COLUMN IF NOT EXISTS employer          TEXT;   -- employeur
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_type           TEXT;   -- CNI / passeport / permis…
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_issuer         TEXT;   -- autorité de délivrance
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_issue_date     DATE;   -- date de délivrance
ALTER TABLE client ADD COLUMN IF NOT EXISTS id_expiry_date    DATE;   -- date d'expiration
ALTER TABLE client ADD COLUMN IF NOT EXISTS tax_id            TEXT;   -- NIU / NINA / IFU
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_sector   TEXT;   -- secteur d'activité
ALTER TABLE client ADD COLUMN IF NOT EXISTS fund_origin       TEXT;   -- origine des fonds
ALTER TABLE client ADD COLUMN IF NOT EXISTS business_purpose  TEXT;   -- objet de la relation
ALTER TABLE client ADD COLUMN IF NOT EXISTS is_pep            BOOLEAN NOT NULL DEFAULT false; -- PPE
ALTER TABLE client ADD COLUMN IF NOT EXISTS pep_detail        TEXT;   -- précision PPE
ALTER TABLE client ADD COLUMN IF NOT EXISTS beneficial_owner  TEXT;   -- bénéficiaire effectif
ALTER TABLE client ADD COLUMN IF NOT EXISTS risk_level        TEXT NOT NULL DEFAULT 'standard'; -- faible / standard / élevé

-- --- 2. Mêmes champs sur le dossier d'enrôlement (complétion < 1 mois) ------
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS gender           TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS birth_place      TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS nationality      TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS marital_status   TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS profession       TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS employer         TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS id_type          TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS id_issuer        TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS id_issue_date    DATE;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS id_expiry_date   DATE;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS tax_id           TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS activity_sector  TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS fund_origin      TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS business_purpose TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS is_pep           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS pep_detail       TEXT;
ALTER TABLE client_enrollment ADD COLUMN IF NOT EXISTS beneficial_owner TEXT;

-- --- 3. Traçabilité de suppression d'IMF (audit super-admin teebo) ---------
ALTER TABLE imf ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
ALTER TABLE imf ADD COLUMN IF NOT EXISTS deleted_by  UUID;

CREATE TABLE IF NOT EXISTS imf_deletion_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_code      TEXT NOT NULL,
    imf_name      TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'hard',   -- 'hard' (purge) | 'soft' (archive)
    stats         JSONB,                          -- comptage des entités supprimées
    deleted_by    UUID,
    deleted_by_email TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
