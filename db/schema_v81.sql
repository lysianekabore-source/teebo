-- v81: additive only; no alteration of v1-v80 tables. All new tables use tenants.id.
INSERT INTO catalogue_modules(code_module,nom,description,module_historique,inclus_essai,ordre)
VALUES('SECRETARIAT_DIRECTION','Secrétariat de Direction & Gouvernance','Courriers, instances, résolutions, notes et agenda.','SECRETARIAT_DIRECTION',FALSE,65) ON CONFLICT(code_module) DO NOTHING;
INSERT INTO saas_modules_pricing(module_key,module_name,monthly_subscription_price,position)
VALUES('SECRETARIAT_DIRECTION','Secrétariat de Direction & Gouvernance',0,65) ON CONFLICT(module_key) DO NOTHING;
INSERT INTO permission_catalog(permission_key,label) VALUES
('sec.read','Secrétariat — consultation'),('sec.manage','Secrétariat — enregistrement et gestion'),
('sec.dg','Secrétariat — imputation DG et approbation'),('sec.confidentiel','Secrétariat — courriers confidentiels'),
('sec.notes.publish','Secrétariat — diffusion de notes'),('sec.resolutions.verify','Secrétariat — vérification des décisions') ON CONFLICT DO NOTHING;
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed)
SELECT NULL,p,k,TRUE FROM unnest(ARRAY['POS_DG','POS_ASSIST_DG','POS_SECRETAIRE_DIRECTION']) p CROSS JOIN unnest(ARRAY['sec.read','sec.manage','sec.notes.publish']) k ON CONFLICT DO NOTHING;
INSERT INTO position_default_permission(imf_id,position_code,permission_key,allowed)
VALUES(NULL,'POS_DG','sec.dg',TRUE),(NULL,'POS_DG','sec.confidentiel',TRUE),(NULL,'POS_DG','sec.resolutions.verify',TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sec_exercices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),annee int NOT NULL CHECK(annee BETWEEN 1900 AND 9999),UNIQUE(tenant_id,annee),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_compteurs(tenant_id uuid NOT NULL REFERENCES tenants(id),annee int NOT NULL,flux text NOT NULL CHECK(flux IN('ARRIVEE','DEPART','NOTE_INTERNE')),dernier int NOT NULL DEFAULT 0 CHECK(dernier>=0),PRIMARY KEY(tenant_id,annee,flux));
CREATE TABLE IF NOT EXISTS sec_courriers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 type_flux varchar NOT NULL CHECK(type_flux IN('ARRIVEE','DEPART','NOTE_INTERNE')),annee int NOT NULL,
 numero_enregistrement varchar NOT NULL,date_courrier date NOT NULL,date_enregistrement timestamptz NOT NULL DEFAULT now(),
 expediteur_ou_destinataire varchar(300) NOT NULL,categorie_correspondant varchar NOT NULL CHECK(categorie_correspondant IN('AUTORITE_TUTELLE_BCEAO','DSC_SFD','BANQUE_BAILLEUR','FOURNISSEUR_PARTENAIRE','CLIENT_RECLAMATION','ADMINISTRATION_FISCALE','AUTRE')),
 objet varchar(500) NOT NULL,niveau_urgence varchar NOT NULL DEFAULT 'NORMAL' CHECK(niveau_urgence IN('NORMAL','URGENT','TRES_URGENT_TUTELLE')),
 est_confidentiel boolean NOT NULL DEFAULT FALSE,fichier_scan_url varchar,date_limite_reponse date,
 impute_a_employe_id uuid REFERENCES app_user(id),instructions_dg text,
 statut varchar NOT NULL DEFAULT 'ENREGISTRE' CHECK(statut IN('ENREGISTRE','EN_ATTENTE_IMPUTATION_DG','IMPUTE_EN_TRAITEMENT','REPONDU_CLOTURE','ARCHIVE')),
 revision int NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,annee,numero_enregistrement),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_instances_reunions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),exercice_id uuid,
 governance_session_id uuid REFERENCES sessions_et_pv(id),
 type_instance varchar NOT NULL CHECK(type_instance IN('ASSEMBLEE_GENERALE_ORDINAIRE','ASSEMBLEE_GENERALE_EXTRAORDINAIRE','CONSEIL_ADMINISTRATION','COMITE_AUDIT','COMITE_DIRECTION','COMITE_CREDIT_CENTRAL')),
 reference_session varchar(100) NOT NULL,titre_session varchar(500) NOT NULL,date_heure_debut timestamptz NOT NULL,
 lieu_ou_lien_visio varchar(500) NOT NULL,ordre_du_jour text NOT NULL,dossier_preparatoire_url varchar,
 quorum_requis int NOT NULL DEFAULT 1 CHECK(quorum_requis>=1),nombre_presents_representes int NOT NULL DEFAULT 0 CHECK(nombre_presents_representes>=0),
 proces_verbal_contenu text,pv_signe_url varchar,
 statut varchar NOT NULL DEFAULT 'CONVOQUEE' CHECK(statut IN('CONVOQUEE','EN_COURS','PV_EN_REDACTION','PV_APPROUVE_CLOTURE')),
 revision int NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,exercice_id) REFERENCES sec_exercices(tenant_id,id),UNIQUE(tenant_id,reference_session),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_presences(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reunion_id uuid NOT NULL,
 nom_participant varchar(300) NOT NULL,qualite varchar(200) NOT NULL,mode_participation varchar NOT NULL CHECK(mode_participation IN('PRESENT','REPRESENTE_PROCURATION','VISIOCONFERENCE','ABSENT')),
 procuration_url varchar,emargement_at timestamptz NOT NULL DEFAULT now(),recorded_by uuid REFERENCES app_user(id),
 FOREIGN KEY(tenant_id,reunion_id) REFERENCES sec_instances_reunions(tenant_id,id),UNIQUE(tenant_id,reunion_id,nom_participant));
CREATE TABLE IF NOT EXISTS sec_resolutions_decisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reunion_id uuid,
 numero_resolution varchar(100) NOT NULL,intitule varchar(500) NOT NULL,contenu_decision text NOT NULL,
 responsable_execution_id uuid REFERENCES app_user(id),date_echeance date,taux_execution int NOT NULL DEFAULT 0 CHECK(taux_execution BETWEEN 0 AND 100),
 statut varchar NOT NULL DEFAULT 'ADOPTEE_A_EXECUTER' CHECK(statut IN('ADOPTEE_A_EXECUTER','EN_COURS','EXECUTEE_VERIFIEE','REPORTEE')),
 revision int NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,reunion_id) REFERENCES sec_instances_reunions(tenant_id,id),UNIQUE(tenant_id,numero_resolution),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_notes_service_circulaires(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),numero_note varchar(100) NOT NULL,
 objet varchar(500) NOT NULL,contenu text NOT NULL,piece_jointe_url varchar,
 cible_agences_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(cible_agences_json)='array'),
 date_publication timestamptz NOT NULL DEFAULT now(),accuses_lecture_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(accuses_lecture_json)='array'),
 revision int NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,numero_note),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_agenda_visiteurs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),dirigeant_id uuid NOT NULL REFERENCES app_user(id),
 type_entree varchar NOT NULL CHECK(type_entree IN('AUDIENCE_VISITEUR','REUNION_EXTERNE','DEPLACEMENT_MISSION')),
 nom_visiteur_ou_organisme varchar(300) NOT NULL,motif varchar(500) NOT NULL,date_heure_debut timestamptz NOT NULL,date_heure_fin timestamptz NOT NULL,
 statut varchar NOT NULL DEFAULT 'PLANIFIE' CHECK(statut IN('PLANIFIE','CONFIRME','TERMINE','ANNULE')),revision int NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(date_heure_fin>date_heure_debut),UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS sec_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),courrier_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES app_user(id),
 type text NOT NULL CHECK(type IN('IMPUTATION','TUTELLE_72H')),cle text NOT NULL,priorite text NOT NULL DEFAULT 'HAUTE',
 statut text NOT NULL DEFAULT 'EN_ATTENTE' CHECK(statut IN('EN_ATTENTE','EN_COURS','REMIS','NON_CONFIGURE','ECHEC','ANNULE')),
 resultat jsonb NOT NULL DEFAULT '{}'::jsonb,tentatives int NOT NULL DEFAULT 0,prochaine_tentative timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,courrier_id) REFERENCES sec_courriers(tenant_id,id),UNIQUE(tenant_id,cle));
CREATE TABLE IF NOT EXISTS sec_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid REFERENCES app_user(id),action text NOT NULL,entity_id uuid,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sec_courrier_deadline ON sec_courriers(tenant_id,date_limite_reponse);
CREATE INDEX IF NOT EXISTS sec_note_feed ON sec_notes_service_circulaires(tenant_id,date_publication DESC);
CREATE INDEX IF NOT EXISTS sec_notification_pending ON sec_notifications(statut,prochaine_tentative);
CREATE OR REPLACE FUNCTION sec_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE im uuid;uid uuid;rid uuid;BEGIN
 SELECT imf_id INTO im FROM tenants WHERE id=NEW.tenant_id;
 FOREACH uid IN ARRAY ARRAY[NULLIF(to_jsonb(NEW)->>'impute_a_employe_id','')::uuid,NULLIF(to_jsonb(NEW)->>'responsable_execution_id','')::uuid,NULLIF(to_jsonb(NEW)->>'dirigeant_id','')::uuid,NULLIF(to_jsonb(NEW)->>'created_by','')::uuid,NULLIF(to_jsonb(NEW)->>'recorded_by','')::uuid,NULLIF(to_jsonb(NEW)->>'actor_id','')::uuid,NULLIF(to_jsonb(NEW)->>'user_id','')::uuid] LOOP
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND imf_id=im) THEN RAISE EXCEPTION 'Secretariat user tenant mismatch' USING ERRCODE='23514';END IF;END LOOP;
 rid=NULLIF(to_jsonb(NEW)->>'governance_session_id','')::uuid;
 IF rid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions_et_pv WHERE id=rid AND imf_id=im) THEN RAISE EXCEPTION 'Secretariat session tenant mismatch' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='sec_notes_service_circulaires' THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.cible_agences_json) x WHERE NOT EXISTS(SELECT 1 FROM org_unit WHERE id::text=x AND imf_id=im AND kind='agency')) THEN RAISE EXCEPTION 'Secretariat agency tenant mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['sec_courriers','sec_instances_reunions','sec_presences','sec_resolutions_decisions','sec_notes_service_circulaires','sec_agenda_visiteurs','sec_notifications','sec_audit'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS sec_membership ON %I',t);
 EXECUTE format('CREATE TRIGGER sec_membership BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION sec_tenant_guard()',t);END LOOP;END $$;
CREATE OR REPLACE FUNCTION sec_courrier_immutable_number() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive courriers instead of deleting';END IF;
 IF NEW.numero_enregistrement<>OLD.numero_enregistrement OR NEW.annee<>OLD.annee OR NEW.type_flux<>OLD.type_flux OR NEW.date_enregistrement<>OLD.date_enregistrement OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'Immutable courrier registration';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sec_registration_guard ON sec_courriers;
CREATE TRIGGER sec_registration_guard BEFORE UPDATE OR DELETE ON sec_courriers FOR EACH ROW EXECUTE FUNCTION sec_courrier_immutable_number();
