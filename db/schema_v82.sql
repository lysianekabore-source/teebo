-- ===========================================================================
-- teebo — VAGUE 82 : CONSOLE EDITEUR COMPLETE + DEMANDES DE MODULES DES IMF
-- ---------------------------------------------------------------------------
-- 1. demandes_modules : une IMF demande l'ouverture d'un module depuis son
--    espace ; l'editeur approuve (activation atomique) ou refuse.
-- 2. saas_paiements : historique des encaissements (un paiement = une ligne),
--    pour que la fiche d'une IMF montre QUI a paye, QUAND, COMMENT.
-- 3. Catalogue : les prix restent en FCFA (NUMERIC), jamais en flottant ;
--    un prix annuel nul est complete a 10 mensualites.
-- Aucune table existante n'est alteree : la migration est strictement
-- additive et peut etre rejouee sans effet de bord.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS demandes_modules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    imf_id         UUID REFERENCES imf(id) ON DELETE CASCADE,
    modules        JSONB NOT NULL DEFAULT '[]'::jsonb,
    motif          TEXT,
    contact_email  TEXT,
    statut         TEXT NOT NULL DEFAULT 'EN_ATTENTE',
    urgence        BOOLEAN NOT NULL DEFAULT TRUE,   -- badge « nouvelle »
    decide_par     UUID,
    decide_le      TIMESTAMPTZ,
    commentaire    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT demandes_modules_statut_chk
      CHECK (statut IN ('EN_ATTENTE','APPROUVEE','REFUSEE','ANNULEE'))
);

-- Une seule demande EN ATTENTE par IMF : une nouvelle demande met a jour la
-- precedente au lieu de creer une file d'attente illisible.
CREATE UNIQUE INDEX IF NOT EXISTS ux_demandes_modules_attente
    ON demandes_modules (tenant_id) WHERE statut = 'EN_ATTENTE';
CREATE INDEX IF NOT EXISTS idx_demandes_modules_statut
    ON demandes_modules (statut, created_at DESC);

CREATE TABLE IF NOT EXISTS saas_paiements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facture_id   UUID REFERENCES factures_saas(id) ON DELETE CASCADE,
    tenant_id    UUID,
    montant_xof  NUMERIC(14,2) NOT NULL DEFAULT 0,
    mode         TEXT NOT NULL DEFAULT 'VIREMENT',
    reference    TEXT,
    encaisse_le  DATE NOT NULL DEFAULT CURRENT_DATE,
    encaisse_par UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saas_paiements_mode_chk
      CHECK (mode IN ('VIREMENT','MOBILE_MONEY','CHEQUE','ESPECES'))
);
CREATE INDEX IF NOT EXISTS idx_saas_paiements_facture
    ON saas_paiements (facture_id);

-- Les tarifs existants sont conservés : aucun montant commercial imposé.

-- Vue de lecture : ce que voit la console (prix formates cote serveur).
CREATE OR REPLACE VIEW v_catalogue_modules_editeur AS
SELECT c.code_module, c.nom, c.description,
       c.prix_mensuel_xof::text        AS prix_mensuel_fcfa,
       c.prix_annuel_xof::text         AS prix_annuel_fcfa,
       c.module_historique, c.inclus_essai, c.ordre, c.est_actif,
       (SELECT count(*) FROM tenant_modules_actifs m
         WHERE m.code_module = c.code_module AND m.est_actif)::int AS nb_tenants_actifs
  FROM catalogue_modules c;

-- Paiements historiques : journal séparé, aucune modification de facture existante.
CREATE TABLE IF NOT EXISTS saas_paiements_historiques (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), facture_id UUID NOT NULL REFERENCES saas_invoices(id),
 institution_id UUID NOT NULL REFERENCES imf(id), montant_xof NUMERIC(14,2) NOT NULL CHECK(montant_xof>0),
 mode TEXT NOT NULL CHECK(mode IN ('VIREMENT','MOBILE_MONEY','CHEQUE','ESPECES')),
 reference TEXT, encaisse_par UUID, encaisse_le DATE NOT NULL DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paiements_historiques_facture ON saas_paiements_historiques(facture_id);
-- Essai unique conservé même après désactivation ou passage à l'abonnement payant.
CREATE TABLE IF NOT EXISTS saas_essais_utilises (
 tenant_id UUID NOT NULL REFERENCES tenants(id), code_module TEXT NOT NULL REFERENCES catalogue_modules(code_module),
 debut DATE NOT NULL DEFAULT CURRENT_DATE, fin DATE NOT NULL, PRIMARY KEY(tenant_id,code_module)
);
INSERT INTO saas_essais_utilises(tenant_id,code_module,fin)
 SELECT tenant_id,code_module,COALESCE(expires_at,CURRENT_DATE) FROM tenant_modules_actifs WHERE en_essai
 ON CONFLICT DO NOTHING;
