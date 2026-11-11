-- teebo — VAGUE 21 : Typologie client + qualité de membre (SCOOP) / usager
-- ---------------------------------------------------------------------------
-- 1) IMF SCOOP (coopérative) : un client qui souscrit au moins UNE part sociale
--    est un CLIENT MEMBRE ; sinon c'est un CLIENT USAGER. La valeur nominale
--    d'une part sociale est un paramètre de l'IMF (part_sociale_nominal_cents).
--    IMF SA : pas de part sociale — ce sont de simples « clients ».
-- 2) Typologie à la création (cascade) :
--    Particulier  -> genre + profession (salarié[public/privé],
--                    informel[commerçant/artisan/agriculteur], retraité, étudiant)
--    Groupe       -> informel / coopérative / association / ONG
--    Entreprise   -> TPME-PME[SARL/SA/SAS/Ent. individuelle] /
--                    Grande entreprise & multinationale[SA/SAS] /
--                    Institution & organisme public[collectivité locale /
--                    établissement public / projet de développement]
-- ---------------------------------------------------------------------------

-- Paramètre IMF : valeur nominale d'une part sociale (SCOOP). NULL = non fixée.
ALTER TABLE imf_document_settings
  ADD COLUMN IF NOT EXISTS part_sociale_nominal_cents BIGINT;

-- Qualité du client vis-à-vis de l'IMF (SCOOP uniquement ; NULL pour une SA).
ALTER TABLE client ADD COLUMN IF NOT EXISTS membership_type TEXT;        -- 'membre' | 'usager'
ALTER TABLE client ADD COLUMN IF NOT EXISTS shares_count    INTEGER NOT NULL DEFAULT 0;  -- nb de parts sociales
ALTER TABLE client ADD COLUMN IF NOT EXISTS shares_paid_cents BIGINT NOT NULL DEFAULT 0;  -- montant total libere

-- Typologie (cascade). Toutes les colonnes sont facultatives au niveau SQL ;
-- la cohérence de la cascade est validée côté serveur (client_typology.js).
ALTER TABLE client ADD COLUMN IF NOT EXISTS client_category    TEXT;  -- particulier | groupe | entreprise
ALTER TABLE client ADD COLUMN IF NOT EXISTS gender             TEXT;  -- feminin | masculin (particulier)
ALTER TABLE client ADD COLUMN IF NOT EXISTS profession         TEXT;  -- salarie | informel | retraite | etudiant
ALTER TABLE client ADD COLUMN IF NOT EXISTS profession_detail  TEXT;  -- secteur_public|secteur_prive|commercant|artisan|agriculteur|retraite|etudiant
ALTER TABLE client ADD COLUMN IF NOT EXISTS group_type         TEXT;  -- informel | cooperative | association | ong
ALTER TABLE client ADD COLUMN IF NOT EXISTS enterprise_segment TEXT;  -- tpme_pme | grande_multinationale | institution_publique
ALTER TABLE client ADD COLUMN IF NOT EXISTS legal_form         TEXT;  -- sarl|sa|sas|entreprise_individuelle|collectivite_locale|etablissement_public|projet_developpement

ALTER TABLE client
  DROP CONSTRAINT IF EXISTS client_membership_type_chk;
ALTER TABLE client
  ADD CONSTRAINT client_membership_type_chk
  CHECK (membership_type IS NULL OR membership_type IN ('membre','usager'));

ALTER TABLE client
  DROP CONSTRAINT IF EXISTS client_category_chk;
ALTER TABLE client
  ADD CONSTRAINT client_category_chk
  CHECK (client_category IS NULL OR client_category IN ('particulier','groupe','entreprise'));

CREATE INDEX IF NOT EXISTS idx_client_category   ON client(imf_id, client_category);
CREATE INDEX IF NOT EXISTS idx_client_membership ON client(imf_id, membership_type);
