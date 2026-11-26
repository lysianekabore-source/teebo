-- v80 Communication CMS. Additive, idempotent; no activation or billing price imposed.
ALTER TABLE institution_features ADD COLUMN IF NOT EXISTS communication_cms BOOLEAN NOT NULL DEFAULT FALSE;
INSERT INTO saas_modules_pricing(module_key,module_name,monthly_subscription_price,position)
VALUES('COMMUNICATION_CMS','Communication et Medias',0,60) ON CONFLICT(module_key) DO NOTHING;
INSERT INTO catalogue_modules(code_module,nom,description,module_historique,inclus_essai,ordre)
VALUES('COMMUNICATION_CMS','Communication et Medias','Studio multimédia, actualités client et demandes de rappel.','COMMUNICATION_CMS',FALSE,60)
ON CONFLICT(code_module) DO UPDATE SET nom=EXCLUDED.nom,module_historique=EXCLUDED.module_historique;
INSERT INTO permission_catalog(permission_key,label) VALUES
 ('cms.manage','Communication — studio, publication et statistiques'),
 ('cms.leads.read','Communication — consulter les demandes de rappel attribuées')
ON CONFLICT DO NOTHING;
-- Named CMS functions are positions using existing role_key office_staff.
INSERT INTO position_catalog(code,label,dept_code,service_code,role_key,hierarchy_level,validation_level,is_manager)
VALUES('POS_RESP_MARKETING','Responsable Marketing','DG','DG_PILOTAGE','office_staff',60,0,TRUE),
 ('POS_SECRETAIRE_DIRECTION','Secrétaire de Direction','DG','DG_PILOTAGE','office_staff',30,0,FALSE)
ON CONFLICT(code) DO NOTHING;
-- Existing roles are preserved; use positions rather than adding enum roles.
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed)
VALUES(NULL,'POS_DG','cms.manage',TRUE),(NULL,'POS_ASSIST_DG','cms.manage',TRUE),(NULL,'POS_SECRETAIRE_DIRECTION','cms.manage',TRUE),(NULL,'POS_RESP_MARKETING','cms.manage',TRUE)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS cms_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 titre text NOT NULL CHECK(length(titre) BETWEEN 1 AND 180), contenu text NOT NULL DEFAULT '' CHECK(length(contenu)<=30000),
 format text NOT NULL CHECK(format IN ('BANNIERE_IMAGE','ARTICLE_ILLUSTRE','CAPSULE_AUDIO_LANGUE_LOCALE','VIDEO_COURTE')),
 langue text NOT NULL DEFAULT 'Français', media_url text, image_url text,
 statut text NOT NULL DEFAULT 'BROUILLON' CHECK(statut IN ('BROUILLON','PROGRAMME','PUBLIE','ARCHIVE')),
 date_publication timestamptz, date_expiration timestamptz,
 cible_agences_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(cible_agences_json)='array'),
 segment_client text NOT NULL DEFAULT 'TOUS_CLIENTS' CHECK(segment_client IN ('TOUS_CLIENTS','EPARGNANTS_ACTIFS','EMPRUNTEURS_ACTIFS','ABONNES_COMPTA_TPE')),
 est_epingle_carrousel boolean NOT NULL DEFAULT FALSE, cta_libelle text CHECK(length(cta_libelle)<=100),
 alerte_urgente boolean NOT NULL DEFAULT FALSE, notifier_immediatement boolean NOT NULL DEFAULT FALSE,
 revision integer NOT NULL DEFAULT 1, created_by uuid REFERENCES app_user(id), updated_by uuid REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), CHECK(date_expiration IS NULL OR date_publication IS NULL OR date_expiration>date_publication)
);
CREATE INDEX IF NOT EXISTS cms_feed_idx ON cms_publications(tenant_id,statut,est_epingle_carrousel,date_publication DESC);
CREATE TABLE IF NOT EXISTS cms_interactions_clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 publication_id uuid NOT NULL, client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
 premiere_consultation timestamptz, derniere_consultation timestamptz, nb_consultations integer NOT NULL DEFAULT 0,
 a_lu boolean NOT NULL DEFAULT FALSE, a_ecoute boolean NOT NULL DEFAULT FALSE, a_clique_cta boolean NOT NULL DEFAULT FALSE,
 date_cta timestamptz, rappel_statut text NOT NULL DEFAULT 'A_TRAITER' CHECK(rappel_statut IN ('A_TRAITER','CONTACTE','CLOTURE')),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES cms_publications(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,publication_id,client_id)
);
CREATE TABLE IF NOT EXISTS cms_client_sessions (
 token_hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cms_client_segments (
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
 segment text NOT NULL CHECK(segment='ABONNES_COMPTA_TPE'), actif boolean NOT NULL DEFAULT TRUE,
 updated_by uuid REFERENCES app_user(id), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,client_id,segment)
);
CREATE TABLE IF NOT EXISTS cms_push_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,endpoint text NOT NULL, subscription jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(endpoint)
);
CREATE TABLE IF NOT EXISTS cms_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 publication_id uuid NOT NULL, client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
 agent_id uuid REFERENCES app_user(id), type text NOT NULL CHECK(type IN ('ALERTE_CLIENT','LEAD_AGENT')),
 statut text NOT NULL DEFAULT 'EN_ATTENTE' CHECK(statut IN ('EN_ATTENTE','EN_COURS','REMIS','NON_CONFIGURE','ECHEC','ANNULE')),
 resultat jsonb NOT NULL DEFAULT '{}'::jsonb, tentatives integer NOT NULL DEFAULT 0,
 prochaine_tentative timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES cms_publications(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,publication_id,client_id,type)
);
-- Enforce client/agent membership at database level as well as in every route.
CREATE OR REPLACE FUNCTION cms_check_tenant_client() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE im uuid;
BEGIN
 SELECT imf_id INTO im FROM tenants WHERE id=NEW.tenant_id;
 IF NOT EXISTS(SELECT 1 FROM client WHERE id=NEW.client_id AND imf_id=im) THEN RAISE EXCEPTION 'CMS client tenant mismatch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='cms_notifications' THEN
 IF NEW.agent_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.agent_id AND imf_id=im) THEN RAISE EXCEPTION 'CMS agent tenant mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cms_interactions_clients','cms_client_sessions','cms_client_segments','cms_push_subscriptions','cms_notifications'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS cms_tenant_guard ON %I',t);
  EXECUTE format('CREATE TRIGGER cms_tenant_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cms_check_tenant_client()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION cms_pin_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,80));
 IF NEW.est_epingle_carrousel AND NEW.statut<>'ARCHIVE' AND
 (SELECT count(*) FROM cms_publications WHERE tenant_id=NEW.tenant_id AND id<>NEW.id AND est_epingle_carrousel AND statut<>'ARCHIVE')>=5 THEN
 RAISE EXCEPTION 'Maximum 5 publications épinglées' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cms_pins_guard ON cms_publications;
CREATE TRIGGER cms_pins_guard BEFORE INSERT OR UPDATE ON cms_publications FOR EACH ROW EXECUTE FUNCTION cms_pin_limit();
