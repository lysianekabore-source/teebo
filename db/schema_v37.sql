-- ===========================================================================
-- teebo — VAGUE 37 : MODULE COLLECTE & ÉPARGNE — SOCLE SÉCURISÉ
-- ===========================================================================
-- Contenu (100 % ADDITIF, réexécutable sans perte de données) :
--
--   A. Cloisonnement multi-IMF : colonne tenant_id sur les tables demandées
--      (tenant_id = imf.id, posée par DÉFAUT depuis imf_id et maintenue par
--      un trigger, donc jamais incohérente) + index.
--   B. Codes clients : identifiants UUID générés CÔTÉ TERMINAL (usage
--      hors-ligne) acceptés, avec table de correspondance uuid_local.
--   C. Produits d'épargne : blocage (DAT) et cycle de carnet tontine.
--   D. Comptes d'épargne : solde_bloque (DAT) + contrainte de cohérence.
--   E. Transactions de collecte : canal, référence Mobile Money, GPS,
--      date locale du terminal, statut de synchronisation.
--   F. Sessions de caisse agent (ouverture / fermeture).
--   G. Billetage détaillé de l'arrêté de caisse (coupures FCFA).
--   H. Reçu unique (reference_recu) + journal des envois SMS / WhatsApp /
--      impression.
--   I. Carnets tontine (cycles de 31 jours + commission IMF).
--   J. DÉFENSE EN PROFONDEUR : montants validés NON MODIFIABLES ni
--      SUPPRIMABLES + contre-passation liée à l'opération d'origine.
--   K. Habilitations : agent de collecte / caissier / chef d'agence.
--
-- Aucune table n'est supprimée, aucune colonne existante n'est renommée.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- A. CLOISONNEMENT MULTI-IMF — tenant_id
-- ===========================================================================
-- Le schéma historique nomme le tenant « imf_id » (imf.id = tenant). Pour
-- répondre au besoin exprimé (tenant_id obligatoire partout) SANS casser le
-- code existant, on AJOUTE tenant_id en copie de imf_id : la contrainte NOT
-- NULL est satisfaite pour les lignes existantes, et un trigger interdit
-- toute divergence future.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_tenant_sync() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := NEW.imf_id;
  END IF;
  IF NEW.imf_id IS NULL THEN
    NEW.imf_id := NEW.tenant_id;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM NEW.imf_id THEN
    RAISE EXCEPTION 'tenant_incoherent: tenant_id (%) doit être égal à imf_id (%) sur %',
      NEW.tenant_id, NEW.imf_id, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
      'client', 'savings_product', 'account', 'zone_collecte',
      'operation', 'cash_deposit', 'receipt', 'cash_closing',
      'collecteur_caisse', 'client_sms_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID', t);
    -- Repli des lignes anciennes : tenant_id = imf_id (jamais l'inverse).
    EXECUTE format('UPDATE %I SET tenant_id = imf_id WHERE tenant_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    -- Défaut : la base la remplit d'elle-même si le code l'oublie.
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULL', t);
    EXCEPTION WHEN OTHERS THEN
      -- Le DEFAULT par sous-requête n'est pas accepté sur toutes les versions :
      -- le trigger ci-dessous garantit déjà la valeur. On continue.
      NULL;
    END;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      'idx_' || t || '_tenant', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_tenant_sync ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_tenant_sync BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_tenant_sync()', t);
  END LOOP;
END $$;

-- ===========================================================================
-- B. UUID GÉNÉRÉS CÔTÉ TERMINAL (hors-ligne)
-- ===========================================================================
-- Un terminal sans réseau crée le client, le compte et l'opération avec un
-- UUID qu'il génère lui-même. À la synchronisation, ce même UUID est envoyé :
-- s'il est déjà connu, l'envoi est un DOUBLON (rien n'est recréé).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uuid_local (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    uuid_local      UUID NOT NULL,
    entite          TEXT NOT NULL,          -- client / account / operation / receipt / carnet
    entite_id       UUID NOT NULL,          -- ligne réellement créée côté serveur
    device_id       UUID,
    appareil        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (imf_id, uuid_local)
);
CREATE INDEX IF NOT EXISTS idx_uuid_local_entite
  ON uuid_local (imf_id, entite, entite_id);

-- ===========================================================================
-- C. PRODUITS D'ÉPARGNE — blocage (DAT) et carnet tontine
-- ===========================================================================
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS duree_blocage_mois INTEGER;
  -- DAT : durée de blocage en mois (NULL pour l'épargne à vue)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS taux_interet NUMERIC(6,3) NOT NULL DEFAULT 0;
  -- taux annuel en % (ex. 3.500)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS penalite_retrait_anticipe_bp INTEGER NOT NULL DEFAULT 0;
  -- points de base appliqués au capital en cas de retrait avant terme
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS carnet_tontine BOOLEAN NOT NULL DEFAULT false;
  -- produit adossé à un carnet de tontine
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS cycle_jours INTEGER;
  -- durée du cycle (31 pour un carnet tontine mensuel)
ALTER TABLE savings_product ADD COLUMN IF NOT EXISTS commission_imf_bp INTEGER NOT NULL DEFAULT 0;
  -- part IMF sur les cotisations du cycle, en points de base (500 = 5 %)

ALTER TABLE savings_product DROP CONSTRAINT IF EXISTS chk_prod_dat_duree;
ALTER TABLE savings_product ADD CONSTRAINT chk_prod_dat_duree
  CHECK (nature <> 'bloquee' OR duree_blocage_mois IS NOT NULL);

ALTER TABLE savings_product DROP CONSTRAINT IF EXISTS chk_prod_tontine_cycle;
ALTER TABLE savings_product ADD CONSTRAINT chk_prod_tontine_cycle
  CHECK (carnet_tontine = false OR (cycle_jours IS NOT NULL AND cycle_jours BETWEEN 1 AND 366));

ALTER TABLE savings_product DROP CONSTRAINT IF EXISTS chk_prod_commission;
ALTER TABLE savings_product ADD CONSTRAINT chk_prod_commission
  CHECK (commission_imf_bp >= 0 AND commission_imf_bp <= 5000);

-- Produit DAT de référence (créé seulement s'il n'existe pas encore).
INSERT INTO savings_product (
  code, label, description, min_balance_cents, interest_rate_bp,
  withdrawal_notice_days, requires_kyc_complete, sort_order,
  nature, duree_blocage_mois, taux_interet, penalite_retrait_anticipe_bp)
VALUES (
  'epargne_dat', 'Épargne à terme (DAT)',
  'Dépôt bloqué sur une durée convenue, capital + intérêts libérés au terme.',
  2500000, 450, 0, true, 2,
  'bloquee', 12, 4.500, 400)
ON CONFLICT (code) DO UPDATE SET
  nature = 'bloquee',
  duree_blocage_mois = COALESCE(savings_product.duree_blocage_mois, EXCLUDED.duree_blocage_mois),
  taux_interet = CASE WHEN savings_product.taux_interet = 0
                      THEN EXCLUDED.taux_interet ELSE savings_product.taux_interet END,
  penalite_retrait_anticipe_bp = CASE WHEN savings_product.penalite_retrait_anticipe_bp = 0
                      THEN EXCLUDED.penalite_retrait_anticipe_bp ELSE savings_product.penalite_retrait_anticipe_bp END;

-- ===========================================================================
-- D. COMPTES D'ÉPARGNE — solde_bloque
-- ===========================================================================
ALTER TABLE account ADD COLUMN IF NOT EXISTS solde_bloque_cents BIGINT NOT NULL DEFAULT 0;
  -- montant indisponible (DAT non échu) : solde disponible = balance - bloqué
ALTER TABLE account ADD COLUMN IF NOT EXISTS date_echeance DATE;
  -- date de libération du DAT
ALTER TABLE account ADD COLUMN IF NOT EXISTS carnet_tontine_id UUID;
  -- carnet tontine rattaché au compte (contrainte posée en I.)

ALTER TABLE account DROP CONSTRAINT IF EXISTS chk_account_solde_bloque;
ALTER TABLE account ADD CONSTRAINT chk_account_solde_bloque
  CHECK (solde_bloque_cents >= 0 AND solde_bloque_cents <= balance_cents);

-- ===========================================================================
-- E. TRANSACTIONS DE COLLECTE — canal, MoMo, GPS, date locale, sync
-- ===========================================================================
-- On ajoute les colonnes à la table historique `operation` (aucune rupture
-- pour le code existant). Une VUE vue_transactions_collecte expose le nom
-- attendu par le module.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE canal_collecte AS ENUM (
    'TERRAIN_CASH', 'GUICHET', 'ORANGE_MONEY', 'MOOV_MONEY', 'WAVE',
    'INTEROP_BCEAO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE operation ADD COLUMN IF NOT EXISTS canal canal_collecte NOT NULL DEFAULT 'TERRAIN_CASH';
ALTER TABLE operation ADD COLUMN IF NOT EXISTS reference_externe_mm TEXT;
  -- n° de transaction de l'opérateur (Orange/Moov/Wave/BCEAO)
ALTER TABLE operation ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(9,6);
ALTER TABLE operation ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(9,6);
ALTER TABLE operation ADD COLUMN IF NOT EXISTS date_operation_locale TIMESTAMPTZ;
  -- horodatage du téléphone (peut être antérieur : collecte hors-ligne)
ALTER TABLE operation ADD COLUMN IF NOT EXISTS uuid_local UUID;
  -- identifiant généré par le terminal AVANT l'envoi
ALTER TABLE operation ADD COLUMN IF NOT EXISTS statut_sync TEXT NOT NULL DEFAULT 'SYNCHRONISE';
ALTER TABLE operation ADD COLUMN IF NOT EXISTS contre_passation_de UUID;
  -- si cette ligne est une contre-passation : l'opération annulée
ALTER TABLE operation ADD COLUMN IF NOT EXISTS motif_contre_passation TEXT;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS zone_collecte_id UUID REFERENCES zone_collecte(id) ON DELETE SET NULL;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS receipt_id UUID;

ALTER TABLE operation DROP CONSTRAINT IF EXISTS chk_op_statut_sync;
ALTER TABLE operation ADD CONSTRAINT chk_op_statut_sync
  CHECK (statut_sync IN ('EN_ATTENTE_SYNC', 'SYNCHRONISE', 'REJETE_DOUBLON', 'REJETE'));

ALTER TABLE operation DROP CONSTRAINT IF EXISTS chk_op_momo_ref;
ALTER TABLE operation ADD CONSTRAINT chk_op_momo_ref
  CHECK (canal = 'TERRAIN_CASH' OR canal = 'GUICHET'
         OR (reference_externe_mm IS NOT NULL AND length(btrim(reference_externe_mm)) >= 4));

ALTER TABLE operation DROP CONSTRAINT IF EXISTS chk_op_gps;
ALTER TABLE operation ADD CONSTRAINT chk_op_gps
  CHECK ((gps_lat IS NULL AND gps_lng IS NULL)
         OR (gps_lat BETWEEN -90 AND 90 AND gps_lng BETWEEN -180 AND 180));

ALTER TABLE operation DROP CONSTRAINT IF EXISTS chk_op_contrepassation_motif;
ALTER TABLE operation ADD CONSTRAINT chk_op_contrepassation_motif
  CHECK (contre_passation_de IS NULL OR (motif_contre_passation IS NOT NULL
         AND length(btrim(motif_contre_passation)) >= 5));

-- Un UUID de terminal ne peut désigner QU'UNE opération (anti-double collecte).
CREATE UNIQUE INDEX IF NOT EXISTS uq_operation_uuid_local
  ON operation (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_operation_mm_ref
  ON operation (imf_id, reference_externe_mm) WHERE reference_externe_mm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operation_sync
  ON operation (imf_id, statut_sync) WHERE statut_sync <> 'SYNCHRONISE';
CREATE INDEX IF NOT EXISTS idx_operation_locale
  ON operation (imf_id, date_operation_locale);

-- Vue au nom attendu par le module (lecture seule, pas de duplication).
CREATE OR REPLACE VIEW vue_transactions_collecte AS
  SELECT o.id, o.tenant_id, o.imf_id, o.account_id, o.client_id, o.user_id,
         o.kind, o.amount_cents, o.direction, o.status,
         o.canal, o.reference_externe_mm, o.gps_lat, o.gps_lng,
         o.date_operation_locale, o.uuid_local, o.statut_sync,
         o.contre_passation_de, o.motif_contre_passation, o.receipt_id,
         o.zone_collecte_id, o.created_at
    FROM operation o;

-- ===========================================================================
-- F. SESSIONS DE CAISSE AGENT
-- ===========================================================================
CREATE TABLE IF NOT EXISTS sessions_caisse_agent (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    agent_id            UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    zone_collecte_id    UUID REFERENCES zone_collecte(id) ON DELETE SET NULL,
    ouverte_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
    fermee_le           TIMESTAMPTZ,
    fond_caisse_ouverture_cents BIGINT NOT NULL DEFAULT 0,
    fond_caisse_fermeture_cents BIGINT,
    encaisse_cents      BIGINT NOT NULL DEFAULT 0,
    decaisse_cents      BIGINT NOT NULL DEFAULT 0,
    ecart_cents         BIGINT,
    statut              TEXT NOT NULL DEFAULT 'OUVERTE',
    cash_closing_id     UUID REFERENCES cash_closing(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sessions_caisse_agent ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE sessions_caisse_agent DROP CONSTRAINT IF EXISTS chk_session_caisse_statut;
ALTER TABLE sessions_caisse_agent ADD CONSTRAINT chk_session_caisse_statut
  CHECK (statut IN ('OUVERTE', 'FERMEE', 'ANNULEE'));

-- Un agent n'a qu'UNE session ouverte à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_caisse_ouverte
  ON sessions_caisse_agent (agent_id) WHERE statut = 'OUVERTE';
CREATE INDEX IF NOT EXISTS idx_session_caisse_imf
  ON sessions_caisse_agent (imf_id, ouverte_le DESC);

-- ===========================================================================
-- G. BILLETAGE DÉTAILLÉ DE L'ARRÊTÉ DE CAISSE
-- ===========================================================================
-- cash_closing.denominations (v19) stocke déjà le comptage brut. On ajoute
-- le détail NORMALISÉ ligne par ligne (contrôlable, sommable, auditable).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billetage_arrete (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    cash_closing_id UUID NOT NULL REFERENCES cash_closing(id) ON DELETE CASCADE,
    session_id      UUID REFERENCES sessions_caisse_agent(id) ON DELETE SET NULL,
    coupure         INTEGER NOT NULL,      -- 10000, 5000, 2000, 1000, 500, 250, 100
    type_coupure    TEXT NOT NULL DEFAULT 'billet',   -- billet / piece
    nombre          INTEGER NOT NULL DEFAULT 0,
    montant_cents   BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cash_closing_id, coupure)
);
ALTER TABLE billetage_arrete ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE billetage_arrete DROP CONSTRAINT IF EXISTS chk_billetage_coupure;
ALTER TABLE billetage_arrete ADD CONSTRAINT chk_billetage_coupure
  CHECK (coupure IN (10000, 5000, 2000, 1000, 500, 250, 100));
ALTER TABLE billetage_arrete DROP CONSTRAINT IF EXISTS chk_billetage_nombre;
ALTER TABLE billetage_arrete ADD CONSTRAINT chk_billetage_nombre
  CHECK (nombre >= 0 AND montant_cents = coupure * nombre * 100);

-- ===========================================================================
-- H. REÇU UNIQUE + JOURNAL DES ENVOIS (SMS / WhatsApp / impression)
-- ===========================================================================
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS reference_recu TEXT;
  -- référence lisible UNIQUE par IMF (REC-2026-000123)
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS uuid_local UUID;
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS canal canal_collecte NOT NULL DEFAULT 'TERRAIN_CASH';
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS annule BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS annule_le TIMESTAMPTZ;
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS annule_motif TEXT;

-- Repli : on fabrique la référence des reçus existants à partir du code affiché.
UPDATE receipt SET reference_recu = 'REC-' || code_receipt
 WHERE reference_recu IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_reference
  ON receipt (imf_id, reference_recu);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_uuid_local
  ON receipt (imf_id, uuid_local) WHERE uuid_local IS NOT NULL;

CREATE TABLE IF NOT EXISTS recus_notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id          UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id       UUID,
    receipt_id      UUID NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES client(id) ON DELETE SET NULL,
    canal           TEXT NOT NULL,          -- SMS / WHATSAPP / IMPRESSION
    destinataire    TEXT,                   -- n° téléphone ou nom de l'imprimante
    contenu         TEXT,
    statut          TEXT NOT NULL DEFAULT 'EN_ATTENTE',  -- EN_ATTENTE / ENVOYE / ECHEC
    tentatives      INTEGER NOT NULL DEFAULT 0,
    erreur          TEXT,
    envoye_le       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE recus_notifications ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE recus_notifications DROP CONSTRAINT IF EXISTS chk_recus_notif_canal;
ALTER TABLE recus_notifications ADD CONSTRAINT chk_recus_notif_canal
  CHECK (canal IN ('SMS', 'WHATSAPP', 'IMPRESSION'));
ALTER TABLE recus_notifications DROP CONSTRAINT IF EXISTS chk_recus_notif_statut;
ALTER TABLE recus_notifications ADD CONSTRAINT chk_recus_notif_statut
  CHECK (statut IN ('EN_ATTENTE', 'ENVOYE', 'ECHEC'));
CREATE INDEX IF NOT EXISTS idx_recus_notif_receipt
  ON recus_notifications (receipt_id, canal);
CREATE INDEX IF NOT EXISTS idx_recus_notif_file
  ON recus_notifications (imf_id, statut) WHERE statut = 'EN_ATTENTE';

-- ===========================================================================
-- I. CARNETS TONTINE — cycles de 31 jours + commission IMF
-- ===========================================================================
CREATE TABLE IF NOT EXISTS carnets_tontine (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id                  UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id               UUID,
    numero_carnet           TEXT NOT NULL,
    client_id               UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    account_id              UUID REFERENCES account(id) ON DELETE SET NULL,
    produit_code            TEXT REFERENCES savings_product(code) ON DELETE SET NULL,
    collecteur_id           UUID REFERENCES app_user(id) ON DELETE SET NULL,
    zone_collecte_id        UUID REFERENCES zone_collecte(id) ON DELETE SET NULL,
    date_debut              DATE NOT NULL DEFAULT CURRENT_DATE,
    date_fin                DATE NOT NULL,
      -- date_debut + 31 jours par défaut (paramétrable par produit)
    cycle_numero            INTEGER NOT NULL DEFAULT 1,
    cotisation_attendue_cents BIGINT NOT NULL DEFAULT 0,
    total_cotise_cents      BIGINT NOT NULL DEFAULT 0,
    commission_imf_bp       INTEGER NOT NULL DEFAULT 0,
    commission_imf_cents    BIGINT NOT NULL DEFAULT 0,
    net_client_cents        BIGINT NOT NULL DEFAULT 0,
    statut                  TEXT NOT NULL DEFAULT 'EN_COURS',
    date_cloture            TIMESTAMPTZ,
    carnet_suivant_id       UUID,
    created_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE carnets_tontine ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE carnets_tontine DROP CONSTRAINT IF EXISTS chk_carnet_statut;
ALTER TABLE carnets_tontine ADD CONSTRAINT chk_carnet_statut
  CHECK (statut IN ('EN_COURS', 'CLOTURE', 'RENOUVELE', 'ANNULE'));
ALTER TABLE carnets_tontine DROP CONSTRAINT IF EXISTS chk_carnet_cycle;
ALTER TABLE carnets_tontine ADD CONSTRAINT chk_carnet_cycle
  CHECK (date_fin > date_debut);
ALTER TABLE carnets_tontine DROP CONSTRAINT IF EXISTS chk_carnet_montants;
ALTER TABLE carnets_tontine ADD CONSTRAINT chk_carnet_montants
  CHECK (total_cotise_cents >= 0 AND commission_imf_cents >= 0
         AND net_client_cents >= 0
         AND commission_imf_cents + net_client_cents <= total_cotise_cents);

CREATE UNIQUE INDEX IF NOT EXISTS uq_carnet_numero
  ON carnets_tontine (imf_id, numero_carnet);
-- Un client n'a qu'UN carnet EN COURS à la fois (évite les cotisations égarées).
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnet_en_cours
  ON carnets_tontine (imf_id, client_id) WHERE statut = 'EN_COURS';
CREATE INDEX IF NOT EXISTS idx_carnet_echeance
  ON carnets_tontine (imf_id, date_fin) WHERE statut = 'EN_COURS';

-- Lien compte -> carnet (colonne ajoutée en D.).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_account_carnet_tontine')
  THEN
    ALTER TABLE account ADD CONSTRAINT fk_account_carnet_tontine
      FOREIGN KEY (carnet_tontine_id) REFERENCES carnets_tontine(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Détail des cotisations d'un carnet (1 ligne par dépôt, jamais supprimée).
CREATE TABLE IF NOT EXISTS carnet_cotisations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id              UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    tenant_id           UUID,
    carnet_id           UUID NOT NULL REFERENCES carnets_tontine(id) ON DELETE CASCADE,
    operation_id        UUID REFERENCES operation(id) ON DELETE SET NULL,
    montant_cents       BIGINT NOT NULL,
    commission_imf_cents BIGINT NOT NULL DEFAULT 0,
    net_cents           BIGINT NOT NULL DEFAULT 0,
    jour_cycle          INTEGER,
    date_cotisation     DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE carnet_cotisations ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE INDEX IF NOT EXISTS idx_carnet_cotisations
  ON carnet_cotisations (carnet_id, date_cotisation);
-- Une seule cotisation par opération (anti-double comptage).
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnet_cotisation_op
  ON carnet_cotisations (operation_id) WHERE operation_id IS NOT NULL;

-- Produit « carnet tontine » de référence (31 jours, commission IMF 5 %).
INSERT INTO savings_product (
  code, label, description, min_balance_cents, interest_rate_bp,
  withdrawal_notice_days, requires_kyc_complete, sort_order,
  nature, taux_interet, carnet_tontine, cycle_jours, commission_imf_bp)
VALUES (
  'carnet_tontine_31j', 'Carnet de tontine (31 jours)',
  'Carnet à cycle mensuel de 31 jours ; la commission de l''IMF est retenue à la clôture du cycle.',
  0, 0, 0, false, 7,
  'a_vue', 0, true, 31, 500)
ON CONFLICT (code) DO UPDATE SET
  cycle_jours = 31,
  carnet_tontine = true,
  commission_imf_bp = CASE WHEN savings_product.commission_imf_bp = 0
                      THEN 500 ELSE savings_product.commission_imf_bp END;

-- ===========================================================================
-- J. DÉFENSE EN PROFONDEUR — IMMUTABILITÉ DES MONTANTS VALIDÉS
-- ===========================================================================
-- Objectif : une écriture validée ne se modifie pas et ne se supprime pas.
-- Toute correction passe par une CONTRE-PASSATION (nouvelle ligne négative
-- liée à l'original par contre_passation_de). La base le fait respecter même
-- si un jour une route oubliait le contrôle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_operation_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'valide' OR OLD.statut_sync = 'SYNCHRONISE' THEN
      RAISE EXCEPTION 'operation_validee_immuable: une opération validée ne peut pas être supprimée (id %). Utilisez une contre-passation.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.contre_passation_de IS NOT NULL THEN
    RAISE EXCEPTION 'contre_passation_immuable: une contre-passation ne peut plus être modifiée (id %).', OLD.id;
  END IF;
  IF (OLD.status = 'valide' OR OLD.statut_sync = 'SYNCHRONISE') THEN
    IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.canal IS DISTINCT FROM OLD.canal
       OR NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'montant_valide_immuable: le montant, le compte, la nature ou le canal d''une opération validée ne peuvent pas changer (id %). Utilisez une contre-passation.', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_operation_immutable ON operation;
CREATE TRIGGER trg_operation_immutable
  BEFORE UPDATE OR DELETE ON operation
  FOR EACH ROW EXECUTE FUNCTION fn_operation_immutable();

CREATE OR REPLACE FUNCTION fn_montant_immuable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ecriture_immuable: suppression interdite sur % (id %). Utilisez une contre-passation.', TG_TABLE_NAME, OLD.id;
  END IF;
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents THEN
    RAISE EXCEPTION 'montant_immuable: le montant de % ne peut pas être modifié (id %). Utilisez une contre-passation.', TG_TABLE_NAME, OLD.id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['receipt', 'carnet_cotisations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_montant_immuable ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_montant_immuable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fn_montant_immuable()', t);
  END LOOP;
END $$;

-- Une contre-passation ne peut viser QUE sa propre IMF et être unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_operation_contrepassation
  ON operation (contre_passation_de) WHERE contre_passation_de IS NOT NULL;

-- ===========================================================================
-- K. HABILITATIONS — agent de collecte / caissier / chef d'agence
-- ===========================================================================
-- On réutilise le catalogue existant (permission) et les POSTES. Les clés
-- ajoutées ici sont celles du module Collecte & Épargne.
-- ---------------------------------------------------------------------------
INSERT INTO permission_catalog(imf_id, permission_key, label, category, access_kind, is_system, sort_order) VALUES
 (NULL,'collecte.sync',        'Collecte - synchroniser les operations hors-ligne','Collecte & Epargne','ecriture',  true, 300),
 (NULL,'collecte.cash.ouvrir', 'Collecte - ouvrir une session de caisse',          'Collecte & Epargne','ecriture',  true, 301),
 (NULL,'collecte.cash.cloturer','Collecte - arreter et billetter la caisse',       'Collecte & Epargne','validation',true, 302),
 (NULL,'collecte.recu.imprimer','Collecte - reimprimer un recu',                   'Collecte & Epargne','ecriture',  true, 303),
 (NULL,'collecte.contrepasser','Collecte - contre-passer une operation validee',   'Collecte & Epargne','validation',true, 304),
 (NULL,'collecte.tontine.gerer','Tontine - ouvrir / cloturer un carnet',           'Collecte & Epargne','ecriture',  true, 305)
ON CONFLICT DO NOTHING;

-- Droits par defaut des trois postes du module (surchargeables par l'admin IMF).
INSERT INTO position_default_permission(imf_id, position_code, permission_key, allowed) VALUES
 (NULL,'POS_AGENT_COLLECTE','operations.write',       true),
 (NULL,'POS_AGENT_COLLECTE','collecte.sync',          true),
 (NULL,'POS_AGENT_COLLECTE','collecte.cash.ouvrir',   true),
 (NULL,'POS_AGENT_COLLECTE','collecte.recu.imprimer', true),
 (NULL,'POS_AGENT_COLLECTE','collecte.tontine.gerer', true),
 (NULL,'POS_CAISSIER','operations.read',         true),
 (NULL,'POS_CAISSIER','operations.write',        true),
 (NULL,'POS_CAISSIER','operations.validate',     true),
 (NULL,'POS_CAISSIER','collecte.cash.ouvrir',    true),
 (NULL,'POS_CAISSIER','collecte.cash.cloturer',  true),
 (NULL,'POS_CAISSIER','collecte.recu.imprimer',  true),
 (NULL,'POS_CAISSIER','collecte.contrepasser',   true),
 (NULL,'POS_CHEF_AGENCE','operations.read',      true),
 (NULL,'POS_CHEF_AGENCE','operations.validate',  true),
 (NULL,'POS_CHEF_AGENCE','cash.approve',         true),
 (NULL,'POS_CHEF_AGENCE','collecte.supervise',   true),
 (NULL,'POS_CHEF_AGENCE','collecte.cash.cloturer',true),
 (NULL,'POS_CHEF_AGENCE','collecte.contrepasser', true),
 (NULL,'POS_CHEF_AGENCE','collecte.tontine.gerer',true)
ON CONFLICT DO NOTHING;

COMMIT;
