-- ===========================================================================
-- teebo — VAGUE 42 : CERTIFICAT DE DILIGENCE KYC/KYB & VISITE TERRAIN
-- ---------------------------------------------------------------------------
-- Objet : donner un numéro OFFICIEL unique et inviolable à chaque
-- « Certificat de diligence KYC/KYB et de visite de terrain » généré, et
-- rendre ce certificat vérifiable par un tiers (client, régulateur, bailleur)
-- sans lui communiquer le dossier.
--
--   A. certificats_kyc        : registre des certificats émis (référence
--                               CERT-AAAA-NNNN, empreinte SHA-256, visite
--                               support, émetteur, éventuel remplacement).
--   B. Sequence par IMF et par annee : numérotation continue CERT-2026-0001.
--   C. Vue publique de verification : n'expose QUE la référence, l'IMF, les
--                               dates et l'empreinte — aucune donnée personnelle.
--   D. Habilitations + audit.
--
-- Aucune table supprimée, aucune colonne renommee, aucune donnee ecrasee.
-- Le certificat ne peut etre ni modifie ni supprime (trigger d'immuabilite) :
-- un nouveau tirage remplace l'ancien par une NOUVELLE ligne (remplace_id).
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- A. REGISTRE DES CERTIFICATS EMIS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS certificats_kyc (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    client_id           UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    entite_id           UUID REFERENCES kyb_entites_morales(id) ON DELETE SET NULL,
    visite_id           UUID,                       -- visite de terrain support
    -- Numérotation officielle
    annee               INTEGER NOT NULL,
    sequence            INTEGER NOT NULL,
    reference           TEXT NOT NULL,               -- CERT-2026-0001
    -- Empreinte d'integrite (SHA-256 de clientId|lat|lng|visiteId|horodatage)
    empreinte           TEXT NOT NULL,               -- 64 caracteres hexadecimaux
    chaine_empreinte    TEXT NOT NULL,               -- chaine canonique, pour recalcul
    -- Preuves figees au moment de l'emission (le dossier peut evoluer ensuite :
    -- le certificat doit rester verifiable tel qu'il a ete delivre)
    gps_lat             NUMERIC(9,6),
    gps_lng             NUMERIC(9,6),
    gps_precision_m     NUMERIC(7,2),
    distance_m          NUMERIC(10,2),
    visite_le           TIMESTAMPTZ,
    valide_le           TIMESTAMPTZ,                -- horodatage de validation retenu
    -- Emission
    genere_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
    genere_par          UUID REFERENCES app_user(id) ON DELETE SET NULL,
    genere_par_nom      TEXT,
    -- Cycle de vie
    statut              TEXT NOT NULL DEFAULT 'EMIS',   -- EMIS | REMPLACE | ANNULE
    remplace_id         UUID REFERENCES certificats_kyc(id) ON DELETE SET NULL,
    annule_le           TIMESTAMPTZ,
    annule_par          UUID REFERENCES app_user(id) ON DELETE SET NULL,
    annulation_motif    TEXT,
    cree_le             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE certificats_kyc ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE certificats_kyc ADD COLUMN IF NOT EXISTS entite_id UUID;
ALTER TABLE certificats_kyc ADD COLUMN IF NOT EXISTS remplace_id UUID;
ALTER TABLE certificats_kyc ADD COLUMN IF NOT EXISTS annulation_motif TEXT;
UPDATE certificats_kyc SET tenant_id = imf_id WHERE tenant_id IS NULL;

-- La reference est unique PAR IMF (deux institutions peuvent avoir CERT-2026-0001).
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificats_kyc_ref ON certificats_kyc (imf_id, reference);
-- L'empreinte est unique TOUTES IMF CONFONDUES : elle sert d'identifiant public.
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificats_kyc_empreinte ON certificats_kyc (empreinte);
CREATE INDEX IF NOT EXISTS idx_certificats_kyc_client ON certificats_kyc (client_id, genere_le DESC);
CREATE INDEX IF NOT EXISTS idx_certificats_kyc_imf ON certificats_kyc (imf_id, genere_le DESC);
CREATE INDEX IF NOT EXISTS idx_certificats_kyc_visite ON certificats_kyc (visite_id);
CREATE INDEX IF NOT EXISTS idx_certificats_kyc_actifs
    ON certificats_kyc (client_id) WHERE statut = 'EMIS';

-- ===========================================================================
-- B. NUMEROTATION : sequence continue par IMF et par annee
-- ---------------------------------------------------------------------------
-- Un certificat annule ne rend PAS son numero a la sequence (une gap est
-- acceptable et juridiquement saine : on ne reutilise jamais une reference).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS certificats_kyc_compteurs (
    imf_id     UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    annee      INTEGER NOT NULL,
    dernier    INTEGER NOT NULL DEFAULT 0,
    maj_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (imf_id, annee)
);

-- ===========================================================================
-- C. VUE PUBLIQUE DE VERIFICATION
-- ---------------------------------------------------------------------------
-- Volontairement pauvre en colonnes : elle sert la page /verify-certificat.
-- Aucune identite de client, aucune adresse, aucune position GPS.
-- SECURITY INVOKER (defaut) : la RLS de la table s'applique. La route
-- publique interroge la table DIRECTEMENT sans contexte tenant, elle ne peut
-- donc pas s'appuyer sur cette vue : elle est fournie pour les usages
-- applicatifs (console administrateur, exports internes).
-- ===========================================================================
DROP VIEW IF EXISTS v_certificats_kyc_verification;
CREATE VIEW v_certificats_kyc_verification AS
SELECT c.empreinte,
       c.reference,
       c.statut,
       c.genere_le,
       c.visite_le,
       c.annee,
       c.sequence,
       c.imf_id,
       i.name AS imf_nom,
       i.code_imf
  FROM certificats_kyc c
  JOIN imf i ON i.id = c.imf_id;

-- ===========================================================================
-- D. IMMUABILITE : un certificat emis ne se modifie pas
-- ---------------------------------------------------------------------------
-- Seules trois transitions sont autorisees depuis la base :
--   EMIS -> REMPLACE (remplace_id renseigne), EMIS -> ANNULE (annule_le).
-- Toute suppression est refusee : on annule, on ne detruit pas.
-- ===========================================================================
CREATE OR REPLACE FUNCTION fn_certificat_kyc_immuable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'certificat_kyc_immuable : un certificat emis ne peut pas etre supprime (annulez-le)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.empreinte IS DISTINCT FROM OLD.empreinte
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.annee IS DISTINCT FROM OLD.annee
     OR NEW.sequence IS DISTINCT FROM OLD.sequence THEN
    RAISE EXCEPTION 'certificat_kyc_immuable : reference et empreinte sont definitives'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.statut <> 'EMIS' AND NEW.statut <> OLD.statut THEN
    RAISE EXCEPTION 'certificat_kyc_immuable : un certificat deja % ne change plus de statut', OLD.statut
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_certificat_kyc_immuable ON certificats_kyc;
CREATE TRIGGER trg_certificat_kyc_immuable
  BEFORE UPDATE OR DELETE ON certificats_kyc
  FOR EACH ROW EXECUTE FUNCTION fn_certificat_kyc_immuable();

-- ===========================================================================
-- E. HABILITATIONS
-- ---------------------------------------------------------------------------
-- Le certificat est un document SENSIBLE : il contient le nom, l'adresse, les
-- photos et la position GPS du client, et il est remis a des tiers. La lecture
-- du dossier KYC ne suffit donc pas : on ajoute deux habilitations dediees.
--   conformite.certificat.read    -> consulter / imprimer un certificat emis
--   conformite.certificat.emettre -> emettre un nouveau certificat
-- Elles sont attribuees par defaut aux postes de controle (Responsable
-- Conformite, Direction Generale, Direction Credit, Audit interne) et aux
-- administrateurs de l'IMF. Le catalogue etant global (imf_id NULL), chaque
-- IMF peut ensuite les retirer depuis l'ecran Habilitations.
-- ===========================================================================
INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, sort_order) VALUES
 (NULL, 'conformite.certificat.read',    'Conformité - consulter et imprimer un certificat de diligence', 'Conformité', 'lecture',    true, 427),
 (NULL, 'conformite.certificat.emettre', 'Conformité - émettre un certificat de diligence KYC/KYB',       'Conformité', 'validation', true, 428)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), permission_key) DO NOTHING;

INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed) VALUES
 (NULL, 'POS_RESP_CONF',   'conformite.certificat.read',    true),
 (NULL, 'POS_RESP_CONF',   'conformite.certificat.emettre', true),
 (NULL, 'POS_DG',          'conformite.certificat.read',    true),
 (NULL, 'POS_DG',          'conformite.certificat.emettre', true),
 (NULL, 'POS_DIR_CREDIT',  'conformite.certificat.read',    true),
 (NULL, 'POS_DIR_CREDIT',  'conformite.certificat.emettre', true),
 (NULL, 'POS_AUDIT_INT',   'conformite.certificat.read',    true)
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- Les administrateurs recoivent aussi les deux habilitations, quel que soit le
-- code de poste utilise par l'IMF (les codes varient d'une institution a
-- l'autre : on se fonde sur le catalogue des postes, pas sur un code fige).
INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed)
SELECT DISTINCT NULL::uuid, pc.code, v.permission_key, true
  FROM position_catalog pc
  CROSS JOIN (VALUES ('conformite.certificat.read'), ('conformite.certificat.emettre')) AS v(permission_key)
 WHERE pc.is_custom IS NOT TRUE   -- postes du socle (l'équivalent de is_system ici)
   AND (pc.code ILIKE '%ADMIN%' OR pc.code ILIKE '%DG%')
ON CONFLICT (COALESCE(imf_id,'00000000-0000-0000-0000-000000000000'::uuid), position_code, permission_key) DO NOTHING;

-- ===========================================================================
-- F. AUDIT
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_audit') THEN
    DROP TRIGGER IF EXISTS trg_audit_certificats_kyc ON certificats_kyc;
    CREATE TRIGGER trg_audit_certificats_kyc AFTER INSERT OR UPDATE
      ON certificats_kyc FOR EACH ROW EXECUTE FUNCTION fn_audit();
  END IF;
END $$;

COMMIT;
