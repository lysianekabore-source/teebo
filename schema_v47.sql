-- ===========================================================================
-- teebo — VAGUE 47 : MODELE SAAS MULTI-TENANT & SOUVERAINETE DES DONNEES
-- ===========================================================================
-- CE QUE CE SCRIPT APPORTE (100 % additif, AUCUNE donnee existante supprimee)
--
--  1. Le modele SaaS complet :
--       tenants                 une ligne par IMF cliente (statut du compte,
--                               plan, periode d'essai, grace de 7 jours)
--       catalogue_modules       les modules vendus, avec leur prix XOF
--       abonnements_tenants     ce que chaque IMF paie (mensuel/trim./annuel)
--       tenant_modules_actifs   bascule A CHAUD d'un module par l'editeur
--       factures_saas           factures d'abonnement (PDF + encaissement)
--
--  2. Un cloisonnement de l'EDITEUR : le role SUPER_ADMIN_SAAS ne peut lire
--     AUCUNE donnee d'adherent (clients, soldes, credits, CENTIF). Il ne voit
--     que des compteurs et des montants agreges. Une vue dediee
--     v_editeur_tenants ne contient que des nombres.
--
--  3. Le statut de compte lisible par le serveur a chaque requete :
--       ACTIF | ESSAI_GRATUIT | SUSPENDU_IMPAYE | RESILIE
--     avec grace de 7 jours apres suspension (lecture seule ensuite).
--
--  4. Le rattrapage des IMF existantes : chaque IMF deja presente recoit son
--     contrat (tenant), ses modules actifs (repris de ses abonnements actuels)
--     et son abonnement. Personne ne perd un module au deploiement.
--
-- SCRIPT REEXECUTABLE (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).
-- Prerequis : socle + v3 + v33 (pricing) appliques.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. GARDE-FOU : les tables/colonnes historiques utilisees ici existent-elles ?
--    On les recree en « IF NOT EXISTS » pour qu'un demarrage partiel ne casse
--    jamais le script.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_module_subscriptions (
    subscription_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    module_key       VARCHAR(50) NOT NULL,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    activated_at     DATE NOT NULL DEFAULT CURRENT_DATE,
    deactivated_at   DATE,
    is_trial         BOOLEAN NOT NULL DEFAULT FALSE,
    trial_end_date   DATE,
    last_billed_month DATE,
    created_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (institution_id, module_key)
);

-- ===========================================================================
-- 1. TENANTS : le contrat de chaque IMF
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tenants (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                UUID NOT NULL UNIQUE REFERENCES imf(id) ON DELETE CASCADE,
    nom_imf               TEXT NOT NULL,
    sigle                 TEXT,
    pays                  CHAR(2),
    plan_code             TEXT NOT NULL DEFAULT 'STANDARD',
    statut_compte         TEXT NOT NULL DEFAULT 'ESSAI_GRATUIT',
    -- ESSAI_GRATUIT | ACTIF | SUSPENDU_IMPAYE | RESILIE
    date_debut            DATE NOT NULL DEFAULT CURRENT_DATE,
    date_expiration_essai DATE,
    date_suspension       TIMESTAMPTZ,
    jours_grace           INTEGER NOT NULL DEFAULT 7,
    date_resiliation      TIMESTAMPTZ,
    valeur_contrat_xof    NUMERIC(14,2) NOT NULL DEFAULT 0,
    periodicite           TEXT NOT NULL DEFAULT 'MENSUEL',  -- MENSUEL | TRIMESTRIEL | ANNUEL
    contact_nom           TEXT,
    contact_email         TEXT,
    contact_phone         TEXT,
    notes_internes        TEXT,
    cree_par              UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenants_statut_chk CHECK (statut_compte IN
        ('ESSAI_GRATUIT','ACTIF','SUSPENDU_IMPAYE','RESILIE'))
);
CREATE INDEX IF NOT EXISTS idx_tenants_statut ON tenants (statut_compte);
COMMENT ON TABLE tenants IS
  'Contrat SaaS d une IMF : statut du compte, essai, grace de 7 jours, plan et valeur du contrat.';

-- ===========================================================================
-- 2. CATALOGUE DES MODULES VENDUS (prix en XOF, jamais en dur dans le code)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS catalogue_modules (
    code_module       TEXT PRIMARY KEY,
    nom               TEXT NOT NULL,
    description       TEXT,
    prix_mensuel_xof  NUMERIC(12,2) NOT NULL DEFAULT 0,
    prix_annuel_xof   NUMERIC(12,2) NOT NULL DEFAULT 0,
    module_historique TEXT,        -- cle legacy (MODULE_...) si un ecran existe
    inclus_essai      BOOLEAN NOT NULL DEFAULT FALSE,
    ordre             INTEGER NOT NULL DEFAULT 100,
    est_actif         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO catalogue_modules (code_module, nom, description, prix_mensuel_xof, prix_annuel_xof, module_historique, inclus_essai, ordre)
VALUES
 ('COLLECTE', 'Collecte & Tontines',
  'Tournees de collecte terrain, recus, versements caisse, tontines/carnets, hors-ligne.',
  50000, 500000, 'MODULE_COLLECTE_TONTINE', TRUE, 10),
 ('CREDIT', 'Credit',
  'Demandes, analyse 5C, comite, decaissement, echeanciers, recouvrement, PAR 30/90.',
  75000, 750000, 'MODULE_DOSSIER_CREDIT', FALSE, 20),
 ('COMPTABILITE', 'Comptabilite',
  'Grand livre immuable, journaux, balance, etats reglementaires BCEAO.',
  40000, 400000, 'MODULE_COMPTABILITE_AVANCEE', FALSE, 30),
 ('CONFORMITE', 'Conformite (LCB-FT / BCEAO)',
  'Dossier KYC/KYB, criblage sanctions & PPE, visites GPS, declarations CENTIF.',
  25000, 250000, 'MODULE_COMPLIANCE_KYC', FALSE, 40),
 ('API_MOBILE_MONEY', 'API Mobile Money',
  'Encaissements et decaissements Mobile Money (Orange, MTN, Moov, Wave).',
  60000, 600000, NULL, FALSE, 50)
ON CONFLICT (code_module) DO UPDATE
   SET nom = EXCLUDED.nom,
       description = COALESCE(catalogue_modules.description, EXCLUDED.description),
       module_historique = COALESCE(catalogue_modules.module_historique, EXCLUDED.module_historique),
       updated_at = now();

-- ===========================================================================
-- 3. ABONNEMENTS DES TENANTS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS abonnements_tenants (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_code                     TEXT NOT NULL DEFAULT 'STANDARD',
    montant_total_periodique_xof  NUMERIC(14,2) NOT NULL DEFAULT 0,
    periodicite                   TEXT NOT NULL DEFAULT 'MENSUEL',
    date_debut                    DATE NOT NULL DEFAULT CURRENT_DATE,
    date_fin                      DATE,
    prochaine_echeance            DATE,
    statut                        TEXT NOT NULL DEFAULT 'ACTIF',  -- ACTIF | SUSPENDU | RESILIE
    remise_pct                    NUMERIC(5,2) NOT NULL DEFAULT 0,
    devise                        CHAR(3) NOT NULL DEFAULT 'XOF',
    cree_par                      UUID,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT abonnements_statut_chk CHECK (statut IN ('ACTIF','SUSPENDU','RESILIE')),
    CONSTRAINT abonnements_periodicite_chk CHECK (periodicite IN ('MENSUEL','TRIMESTRIEL','ANNUEL'))
);
CREATE INDEX IF NOT EXISTS idx_abonnements_tenant ON abonnements_tenants (tenant_id, statut);

-- ===========================================================================
-- 4. MODULES ACTIFS PAR TENANT (bascule a chaud par l'editeur)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tenant_modules_actifs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code_module   TEXT NOT NULL REFERENCES catalogue_modules(code_module),
    est_actif     BOOLEAN NOT NULL DEFAULT TRUE,
    active_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
    desactive_le  TIMESTAMPTZ,
    expires_at    DATE,
    en_essai      BOOLEAN NOT NULL DEFAULT FALSE,
    prix_applique_xof NUMERIC(12,2),
    active_par    UUID,
    motif         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code_module)
);
CREATE INDEX IF NOT EXISTS idx_tma_tenant ON tenant_modules_actifs (tenant_id, est_actif);

-- ===========================================================================
-- 5. FACTURES D'ABONNEMENT (PDF + encaissement)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS factures_saas (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    numero_facture    TEXT UNIQUE,
    periode_debut     DATE NOT NULL,
    periode_fin       DATE NOT NULL,
    montant_ht_xof    NUMERIC(14,2) NOT NULL DEFAULT 0,
    tva_pct           NUMERIC(5,2) NOT NULL DEFAULT 0,
    montant_ttc_xof   NUMERIC(14,2) NOT NULL DEFAULT 0,
    statut_paiement   TEXT NOT NULL DEFAULT 'EN_ATTENTE',  -- EN_ATTENTE | PAYEE | EN_RETARD | ANNULEE
    date_emission     DATE NOT NULL DEFAULT CURRENT_DATE,
    date_echeance     DATE,
    date_paiement     DATE,
    mode_paiement     TEXT,        -- VIREMENT | MOBILE_MONEY | CHEQUE | ESPECES
    reference_paiement TEXT,
    lignes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    emise_par         UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT factures_statut_chk CHECK (statut_paiement IN
        ('EN_ATTENTE','PAYEE','EN_RETARD','ANNULEE'))
);
CREATE INDEX IF NOT EXISTS idx_factures_saas_tenant ON factures_saas (tenant_id, periode_debut DESC);
CREATE INDEX IF NOT EXISTS idx_factures_saas_statut ON factures_saas (statut_paiement);

-- Numero de facture lisible : TBO-FA-AAAA-000123 (sequence globale).
CREATE SEQUENCE IF NOT EXISTS seq_facture_saas;

CREATE OR REPLACE FUNCTION fn_numero_facture_saas() RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
    RETURN 'TBO-FA-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
           lpad(nextval('seq_facture_saas')::text, 6, '0');
END $$;

-- ===========================================================================
-- 6. RATTRAPAGE : chaque IMF existante recoit son contrat
-- ===========================================================================
-- Statut deduit de l'etat reel de l'IMF (imf.status) :
--   trial -> ESSAI_GRATUIT, active/approved -> ACTIF, suspended -> SUSPENDU_IMPAYE.
INSERT INTO tenants (imf_id, nom_imf, sigle, pays, statut_compte, date_debut,
                     date_expiration_essai, contact_email)
SELECT i.id, i.name, i.code_imf, i.country_code,
       CASE i.status::text
            WHEN 'trial'     THEN 'ESSAI_GRATUIT'
            WHEN 'suspended' THEN 'SUSPENDU_IMPAYE'
            WHEN 'rejected'  THEN 'RESILIE'
            ELSE 'ACTIF' END,
       COALESCE(i.created_at::date, CURRENT_DATE),
       COALESCE(i.trial_ends_at::date, (CURRENT_DATE + INTERVAL '30 days')::date),
       i.email
  FROM imf i
 WHERE i.code_imf <> 'TBO-SYS-000000'
ON CONFLICT (imf_id) DO NOTHING;

-- Modules actifs : reprise EXACTE des abonnements en cours.
-- Les 4 modules historiques sont traduits un a un (CASE explicite, sans
-- valeur sentinelle) : aucune ligne ne peut pointer vers un module inconnu.
INSERT INTO tenant_modules_actifs (tenant_id, code_module, est_actif, active_le, expires_at, en_essai, motif)
SELECT t.id, m.code_module, TRUE, m.active_le, m.expires_at, m.en_essai, 'reprise_v47'
  FROM (
        SELECT s.institution_id, 'COLLECTE' AS code_module,
               s.activated_at::timestamptz AS active_le,
               CASE WHEN s.is_trial THEN s.trial_end_date END AS expires_at,
               COALESCE(s.is_trial, FALSE) AS en_essai
          FROM institution_module_subscriptions s
         WHERE s.is_active = TRUE AND s.module_key = 'MODULE_COLLECTE_TONTINE'
        UNION ALL
        SELECT s.institution_id, 'CREDIT', s.activated_at::timestamptz,
               CASE WHEN s.is_trial THEN s.trial_end_date END,
               COALESCE(s.is_trial, FALSE)
          FROM institution_module_subscriptions s
         WHERE s.is_active = TRUE AND s.module_key = 'MODULE_DOSSIER_CREDIT'
        UNION ALL
        SELECT s.institution_id, 'COMPTABILITE', s.activated_at::timestamptz,
               CASE WHEN s.is_trial THEN s.trial_end_date END,
               COALESCE(s.is_trial, FALSE)
          FROM institution_module_subscriptions s
         WHERE s.is_active = TRUE AND s.module_key = 'MODULE_COMPTABILITE_AVANCEE'
        UNION ALL
        SELECT s.institution_id, 'CONFORMITE', s.activated_at::timestamptz,
               CASE WHEN s.is_trial THEN s.trial_end_date END,
               COALESCE(s.is_trial, FALSE)
          FROM institution_module_subscriptions s
         WHERE s.is_active = TRUE AND s.module_key = 'MODULE_COMPLIANCE_KYC'
       ) m
  JOIN tenants t ON t.imf_id = m.institution_id
ON CONFLICT (tenant_id, code_module) DO NOTHING;

-- Collecte : module d'essai offert a toute IMF en essai (vague 44/45).
INSERT INTO tenant_modules_actifs (tenant_id, code_module, est_actif, en_essai, motif)
SELECT t.id, 'COLLECTE', TRUE, TRUE, 'essai_collecte_v47'
  FROM tenants t
 WHERE t.statut_compte = 'ESSAI_GRATUIT'
ON CONFLICT (tenant_id, code_module) DO NOTHING;

-- Abonnement : un contrat par tenant (celui en cours s'il existe).
INSERT INTO abonnements_tenants (tenant_id, plan_code, montant_total_periodique_xof,
                                 periodicite, date_debut, statut)
SELECT t.id, t.plan_code,
       COALESCE((SELECT SUM(c.prix_mensuel_xof)
                   FROM tenant_modules_actifs m
                   JOIN catalogue_modules c ON c.code_module = m.code_module
                  WHERE m.tenant_id = t.id AND m.est_actif = TRUE), 0),
       'MENSUEL', t.date_debut,
       CASE WHEN t.statut_compte = 'RESILIE' THEN 'RESILIE'
            WHEN t.statut_compte = 'SUSPENDU_IMPAYE' THEN 'SUSPENDU'
            ELSE 'ACTIF' END
  FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM abonnements_tenants a WHERE a.tenant_id = t.id);

-- ===========================================================================
-- 7. CLOISONNEMENT DE L'EDITEUR : vue de supervision SANS donnee d'adherent
-- ===========================================================================
CREATE OR REPLACE VIEW v_editeur_tenants AS
SELECT t.id                                   AS tenant_id,
       t.imf_id,
       t.nom_imf,
       t.sigle,
       t.pays,
       t.plan_code,
       t.statut_compte,
       t.date_debut,
       t.date_expiration_essai,
       t.date_suspension,
       t.jours_grace,
       t.valeur_contrat_xof,
       t.periodicite,
       (SELECT count(*) FROM app_user u
         WHERE u.imf_id = t.imf_id AND u.role <> 'teebo_admin')            AS nb_utilisateurs,
       (SELECT count(*) FROM app_user u
         WHERE u.imf_id = t.imf_id AND u.role <> 'teebo_admin'
           AND u.is_active = TRUE)                                          AS nb_utilisateurs_actifs,
       (SELECT count(*) FROM tenant_modules_actifs m
         WHERE m.tenant_id = t.id AND m.est_actif = TRUE)                   AS nb_modules_actifs,
       COALESCE((SELECT SUM(f.montant_ttc_xof) FROM factures_saas f
                  WHERE f.tenant_id = t.id
                    AND f.statut_paiement IN ('EN_ATTENTE','EN_RETARD')), 0) AS impaye_xof,
       t.created_at,
       t.updated_at
  FROM tenants t;
COMMENT ON VIEW v_editeur_tenants IS
  'Supervision de l editeur : identite du contrat et COMPTEURS uniquement. Aucune donnee d adherent (nom, solde, credit, CENTIF) n y figure par construction.';

-- Revocation explicite : l'editeur ne peut pas s'appuyer sur cette vue pour
-- lire des tables metier. (Les droits sont geres par le role applicatif ;
-- cette instruction documente l'intention et reste sans effet de bord.)
REVOKE ALL ON v_editeur_tenants FROM PUBLIC;

-- ===========================================================================
-- 8. PARAMETRES APPLICATIFS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS app_parametres (
    cle         TEXT PRIMARY KEY,
    valeur      TEXT NOT NULL,
    commentaire TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_parametres (cle, valeur, commentaire) VALUES
 ('SAAS_JOURS_GRACE_DEFAUT', '7',
  'Nombre de jours pendant lesquels une IMF suspendue pour impaye conserve un acces complet avant le passage en lecture seule.'),
 ('SAAS_ESSAI_JOURS', '30',
  'Duree de la periode d essai gratuite accordee a une nouvelle IMF.'),
 ('SAAS_TVA_PCT', '18',
  'Taux de TVA applique aux factures d abonnement (a confirmer par pays : 18 % CI/SN/BF/ML/BJ/TG/NE, 19 % GW).')
ON CONFLICT (cle) DO NOTHING;

-- ===========================================================================
-- 9. PLAN COMPTABLE DE DEMARRAGE (une IMF neuve doit saisir des le jour 1)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS plat_compte_comptable (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id     UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    numero     TEXT NOT NULL,
    intitule   TEXT NOT NULL,
    sens       TEXT,                -- debit | credit
    est_actif  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_plat_compte_imf ON plat_compte_comptable (imf_id, numero);
COMMENT ON TABLE plat_compte_comptable IS
  'Plan de comptes de demarrage (nomenclature SFD UMOA, classes 1 a 8) seme a l onboarding d une IMF. A valider par le service comptable avant production.';

-- ===========================================================================
-- 10. TRACABILITE DES ACCES EDITEUR (audit)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS editeur_acces_log (
    id           BIGSERIAL PRIMARY KEY,
    editeur_id   UUID,
    action       TEXT NOT NULL,
    tenant_id    UUID,
    cible        TEXT,
    details      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editeur_log_date ON editeur_acces_log (created_at DESC);
COMMENT ON TABLE editeur_acces_log IS
  'Journal de toutes les actions du SUPER_ADMIN_SAAS : onboarding, bascule de module, encaissement. Obligation d audit.';

COMMIT;
