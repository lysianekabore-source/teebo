import {q,tx} from './db.js';
import {bindActor} from './audit.js';
import {deliverCmsNotification} from './notify.js';
export const CMS_KEY='COMMUNICATION_CMS';
export const FORMATS=['BANNIERE_IMAGE','ARTICLE_ILLUSTRE','CAPSULE_AUDIO_LANGUE_LOCALE','VIDEO_COURTE'];
export const LANGUES=['Français','Mooré','Dioula','Fulfuldé','Wolof','Bambara','Autre'];
export const SEGMENTS=['TOUS_CLIENTS','EPARGNANTS_ACTIFS','EMPRUNTEURS_ACTIFS','ABONNES_COMPTA_TPE'];
export const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function fail(message,status=422){const e=new Error(message);e.status=status;e.expose=true;return e;}
export function mediaUrl(v){if(!v)return null;try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password)throw Error();return u.href;}catch{throw fail('Le média doit utiliser une adresse HTTPS valide.');}}
export function validatePublication(b){
 const titre=String(b.titre||'').trim(),contenu=String(b.contenu||'');
 if(!titre||titre.length>180||contenu.length>30000)throw fail('Titre requis (180 caractères maximum) et texte limité à 30 000 caractères.');
 if(!FORMATS.includes(b.format)||!LANGUES.includes(b.langue||'Français')||!SEGMENTS.includes(b.segment_client||'TOUS_CLIENTS'))throw fail('Format, langue ou profil client invalide.');
 const agences=b.cible_agences_json||[];if(!Array.isArray(agences)||agences.length>200||!agences.every(uuid))throw fail('Sélection des agences invalide.');
 const media=mediaUrl(b.media_url),image=mediaUrl(b.image_url);
 if(['BANNIERE_IMAGE','ARTICLE_ILLUSTRE'].includes(b.format)&&!image)throw fail('Une image est requise pour ce format.');
 if(['CAPSULE_AUDIO_LANGUE_LOCALE','VIDEO_COURTE'].includes(b.format)&&!media)throw fail('Une adresse audio ou vidéo est requise.');
 const dates=['date_publication','date_expiration'].map(k=>{if(!b[k])return null;const v=String(b[k]);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw fail('Date et fuseau horaire requis.');return new Date(v).toISOString();});
 if(dates[1]&&dates[0]&&dates[1]<=dates[0])throw fail('L’expiration doit être postérieure à la publication.');
 const cta=String(b.cta_libelle||'').trim();if(cta.length>100)throw fail('Bouton d’action limité à 100 caractères.');
 if(b.notifier_immediatement&&!b.alerte_urgente)throw fail('La notification immédiate est réservée aux alertes urgentes.');
 return {titre,contenu,format:b.format,langue:b.langue||'Français',media_url:media,image_url:image,date_publication:dates[0],date_expiration:dates[1],cible_agences_json:[...new Set(agences)],segment_client:b.segment_client||'TOUS_CLIENTS',est_epingle_carrousel:b.est_epingle_carrousel===true,cta_libelle:cta||null,alerte_urgente:b.alerte_urgente===true,notifier_immediatement:b.notifier_immediatement===true};
}
// Tenant ID is tenants.id, not imf.id. Never accept it from request bodies.
export async function cmsAccess(imfId,write=false){
 const t=(await q(`SELECT t.*,m.est_actif,m.expires_at FROM tenants t LEFT JOIN tenant_modules_actifs m ON m.tenant_id=t.id AND m.code_module='COMMUNICATION_CMS' WHERE t.imf_id=$1`,[imfId])).rows[0];
 if(!t||t.est_actif!==true||(t.expires_at&&new Date(t.expires_at).toISOString().slice(0,10)<new Date().toISOString().slice(0,10)))throw fail('Le module Communication & Médias n’est pas actif pour votre institution.',403);
 if(t.statut_compte==='RESILIE')throw fail('Le contrat de votre institution ne permet plus la diffusion.',403);
 if(write){const {evaluerTenant}=await import('./saas_engine.js');const state=evaluerTenant(t);if(state.lecture_seule||state.autorise===false)throw fail('Votre institution est en consultation seule.',403);}
 return t;
}
// Client profile is derived only from banking records and explicit TPE subscription.
export const AUDIENCE_SQL=`c.imf_id=t.imf_id AND
 (jsonb_array_length(p.cible_agences_json)=0 OR p.cible_agences_json @> to_jsonb(ARRAY[c.agency_unit_id::text])) AND
 (p.segment_client='TOUS_CLIENTS' OR
  (p.segment_client='EPARGNANTS_ACTIFS' AND EXISTS(SELECT 1 FROM account a WHERE a.client_id=c.id AND a.imf_id=c.imf_id AND a.status='active')) OR
  (p.segment_client='EMPRUNTEURS_ACTIFS' AND (EXISTS(SELECT 1 FROM dossiers_credit d WHERE d.client_id=c.id AND d.imf_id=c.imf_id AND d.statut='DECAISSE' AND d.solde_capital_cents>0) OR EXISTS(SELECT 1 FROM credit_file f WHERE f.client_id=c.id AND f.imf_id=c.imf_id AND f.status::text='decaisse'))) OR
  (p.segment_client='ABONNES_COMPTA_TPE' AND EXISTS(SELECT 1 FROM cms_client_segments s WHERE s.tenant_id=t.id AND s.client_id=c.id AND s.segment='ABONNES_COMPTA_TPE' AND s.actif)))`;
export const VISIBLE_SQL="p.statut='PUBLIE' AND p.date_publication<=now() AND (p.date_expiration IS NULL OR p.date_expiration>now())";
export async function queueAlerts(c,tenant,id){
 await c.query(`INSERT INTO cms_notifications(tenant_id,publication_id,client_id,type)
 SELECT p.tenant_id,p.id,c.id,'ALERTE_CLIENT' FROM cms_publications p JOIN tenants t ON t.id=p.tenant_id JOIN client c ON ${AUDIENCE_SQL}
 JOIN client_portal cp ON cp.client_id=c.id AND cp.imf_id=c.imf_id AND cp.is_active
 WHERE p.tenant_id=$1 AND p.id=$2 AND ${VISIBLE_SQL} AND p.alerte_urgente AND p.notifier_immediatement
 ON CONFLICT(tenant_id,publication_id,client_id,type) DO NOTHING`,[tenant,id]);
}
export async function advanceSchedule(tenant){
 return tx(async c=>{await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
 await c.query("UPDATE cms_publications SET statut='ARCHIVE',est_epingle_carrousel=false,updated_at=now(),revision=revision+1 WHERE tenant_id=$1 AND statut IN ('PROGRAMME','PUBLIE') AND date_expiration<=now()",[tenant]);
 const rows=(await c.query("UPDATE cms_publications SET statut='PUBLIE',updated_at=now(),revision=revision+1 WHERE tenant_id=$1 AND statut='PROGRAMME' AND date_publication<=now() AND (date_expiration IS NULL OR date_expiration>now()) RETURNING id",[tenant])).rows;
 for(const row of rows)await queueAlerts(c,tenant,row.id);
 });
}
export async function savePublication(t,user,body,id=null){
 const v=validatePublication(body);const action=body.action||'BROUILLON';if(!['BROUILLON','PUBLIER','ARCHIVER'].includes(action))throw fail('Action invalide.');
 return tx(async c=>{await bindActor(c,user);await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[t.id]);
 let prev=null;if(id){prev=(await c.query('SELECT * FROM cms_publications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t.id,id])).rows[0];if(!prev)throw fail('Publication introuvable.',404);if(!Number.isInteger(body.revision)||body.revision!==prev.revision)throw fail('Publication modifiée par un autre utilisateur. Actualisez.',409);}
 if(v.cible_agences_json.length){const n=(await c.query("SELECT id FROM org_unit WHERE imf_id=$1 AND kind='agency' AND id=ANY($2::uuid[])",[t.imf_id,v.cible_agences_json])).rows.length;if(n!==v.cible_agences_json.length)throw fail('Une agence ne relève pas de votre IMF.');}
 const now=new Date((await c.query('SELECT now() AS clock')).rows[0].clock).getTime();const date=v.date_publication||new Date(now).toISOString();v.date_publication=action==='BROUILLON'?v.date_publication:date;
 if(action==='PUBLIER'&&v.date_expiration&&Date.parse(v.date_expiration)<=now)throw fail('Cette publication est déjà expirée.');
 v.statut=action==='ARCHIVER'?'ARCHIVE':action==='BROUILLON'?'BROUILLON':Date.parse(date)>now?'PROGRAMME':'PUBLIE';if(v.statut==='ARCHIVE')v.est_epingle_carrousel=false;
 if(v.est_epingle_carrousel){const n=(await c.query("SELECT count(*)::int AS n FROM cms_publications WHERE tenant_id=$1 AND est_epingle_carrousel AND statut<>'ARCHIVE' AND ($2::uuid IS NULL OR id<>$2)",[t.id,id])).rows[0].n;if(n>=5)throw fail('Le carrousel est limité à 5 publications épinglées.',409);}
 const keys=Object.keys(v),values=keys.map(k=>k==='cible_agences_json'?JSON.stringify(v[k]):v[k]);
 let row;if(id){row=(await c.query(`UPDATE cms_publications SET ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')},updated_by=$${keys.length+1},updated_at=now(),revision=revision+1 WHERE tenant_id=$${keys.length+2} AND id=$${keys.length+3} RETURNING *`,[...values,user.id,t.id,id])).rows[0];}
 else row=(await c.query(`INSERT INTO cms_publications(${keys.join(',')},created_by,updated_by,tenant_id) VALUES(${[...values,user.id,user.id,t.id].map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,[...values,user.id,user.id,t.id])).rows[0];
 await c.query(`INSERT INTO audit_log(imf_id,actor_id,actor_role,action,entity,entity_id,payload) VALUES($1,$2,$3,'cms.publication.save','cms_publications',$4,$5::jsonb)`,[t.imf_id,user.id,user.role,row.id,JSON.stringify({statut:row.statut,revision:row.revision})]);
 if(row.statut==='PUBLIE')await queueAlerts(c,t.id,row.id);
 return row;
 });
}
export async function clientFeed(identity,id=null){
 return (await q(`SELECT p.* FROM cms_publications p JOIN tenants t ON t.id=p.tenant_id JOIN client c ON c.id=$2 AND ${AUDIENCE_SQL}
 WHERE p.tenant_id=$1 AND ${VISIBLE_SQL} AND ($3::uuid IS NULL OR p.id=$3)
 ORDER BY p.est_epingle_carrousel DESC,p.date_publication DESC,p.id LIMIT 100`,[identity.tenant_id,identity.id,id])).rows;
}
export async function recordInteraction(identity,id,event){
 if(!['VUE','LU','ECOUTE','CTA'].includes(event))throw fail('Interaction invalide.');const p=(await clientFeed(identity,id))[0];if(!p)throw fail('Publication indisponible.',404);
 if(event==='CTA'&&!p.cta_libelle)throw fail('Cette publication ne propose pas de rappel.');
 if(event==='ECOUTE'&&!['CAPSULE_AUDIO_LANGUE_LOCALE','VIDEO_COURTE'].includes(p.format))throw fail('Ce format ne propose pas de lecture audio/vidéo.');
 return tx(async c=>{const prior=(await c.query('SELECT a_clique_cta FROM cms_interactions_clients WHERE tenant_id=$1 AND publication_id=$2 AND client_id=$3 FOR UPDATE',[identity.tenant_id,id,identity.id])).rows[0];
 const row=(await c.query(`INSERT INTO cms_interactions_clients(tenant_id,publication_id,client_id,premiere_consultation,derniere_consultation,nb_consultations,a_lu,a_ecoute,a_clique_cta,date_cta)
 VALUES($1,$2,$3,now(),now(),1,$4,$5,$6,CASE WHEN $6 THEN now() ELSE NULL END)
 ON CONFLICT(tenant_id,publication_id,client_id) DO UPDATE SET derniere_consultation=now(),nb_consultations=cms_interactions_clients.nb_consultations+CASE WHEN $7='VUE' THEN 1 ELSE 0 END,
 a_lu=cms_interactions_clients.a_lu OR $4,a_ecoute=cms_interactions_clients.a_ecoute OR $5,a_clique_cta=cms_interactions_clients.a_clique_cta OR $6,
 date_cta=COALESCE(cms_interactions_clients.date_cta,CASE WHEN $6 THEN now() ELSE NULL END) RETURNING *`,[identity.tenant_id,id,identity.id,event==='LU',event==='ECOUTE',event==='CTA',event])).rows[0];
 if(event==='CTA'&&!prior?.a_clique_cta){
 const agent=(await c.query(`SELECT u.id FROM client cl JOIN tenants t ON t.imf_id=cl.imf_id JOIN app_user u ON u.imf_id=cl.imf_id AND u.is_active
 WHERE cl.id=$2 AND t.id=$1 AND (u.id=cl.collectrice_user_id OR u.id IN(SELECT agent_credit_id FROM dossiers_credit WHERE client_id=cl.id AND imf_id=cl.imf_id AND statut NOT IN ('ANNULE','REJETE','CLOTURE_SOLDE') UNION SELECT officer_user_id FROM credit_file WHERE client_id=cl.id AND imf_id=cl.imf_id))
 ORDER BY (u.id=cl.collectrice_user_id) DESC,u.id LIMIT 1`,[identity.tenant_id,identity.id])).rows[0];
 await c.query(`INSERT INTO cms_notifications(tenant_id,publication_id,client_id,agent_id,type,statut,resultat) VALUES($1,$2,$3,$4,'LEAD_AGENT',$5,$6::jsonb) ON CONFLICT(tenant_id,publication_id,client_id,type) DO NOTHING`,[identity.tenant_id,id,identity.id,agent?.id||null,agent?'EN_ATTENTE':'NON_CONFIGURE',JSON.stringify(agent?{}:{motif:'Aucun agent affecté au client ; demande visible au studio.'})]);
 }
 return {ok:true,a_clique_cta:row.a_clique_cta};
 });
}
export async function publicationStats(tenant,id){
 const pub=(await q('SELECT * FROM cms_publications WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];if(!pub)throw fail('Publication introuvable.',404);
 const aggregate=(await q(`SELECT count(*) FILTER(WHERE nb_consultations>0)::int AS clients_touches,count(*) FILTER(WHERE a_lu)::int AS lus,count(*) FILTER(WHERE a_ecoute)::int AS ecoutes,count(*) FILTER(WHERE a_clique_cta)::int AS rappels FROM cms_interactions_clients WHERE tenant_id=$1 AND publication_id=$2`,[tenant,id])).rows[0];
 const target=(await q(`SELECT count(*)::int AS n FROM cms_publications p JOIN tenants t ON t.id=p.tenant_id JOIN client c ON ${AUDIENCE_SQL} JOIN client_portal cp ON cp.client_id=c.id AND cp.imf_id=c.imf_id AND cp.is_active WHERE p.tenant_id=$1 AND p.id=$2`,[tenant,id])).rows[0].n;
 const leads=(await q(`SELECT c.id,c.full_name,c.code_client,c.phone,i.date_cta,i.rappel_statut,u.full_name AS agent,n.statut AS notification_statut FROM cms_interactions_clients i JOIN tenants t ON t.id=i.tenant_id JOIN client c ON c.id=i.client_id AND c.imf_id=t.imf_id LEFT JOIN cms_notifications n ON n.tenant_id=i.tenant_id AND n.publication_id=i.publication_id AND n.client_id=i.client_id AND n.type='LEAD_AGENT' LEFT JOIN app_user u ON u.id=n.agent_id AND u.imf_id=t.imf_id WHERE i.tenant_id=$1 AND i.publication_id=$2 AND i.a_clique_cta ORDER BY i.date_cta DESC LIMIT 1000`,[tenant,id])).rows;
 const notifications=(await q('SELECT statut,count(*)::int AS n FROM cms_notifications WHERE tenant_id=$1 AND publication_id=$2 GROUP BY statut',[tenant,id])).rows;
 return {...aggregate,clients_cibles:target,taux_lecture:aggregate.clients_touches?Math.round(10000*aggregate.lus/aggregate.clients_touches)/100:0,taux_ecoute:aggregate.clients_touches?Math.round(10000*aggregate.ecoutes/aggregate.clients_touches)/100:0,leads,notifications};
}
let busy=false;
export async function cmsWorker(){if(busy)return;busy=true;try{
 const tenants=(await q("SELECT t.imf_id FROM tenants t JOIN tenant_modules_actifs m ON m.tenant_id=t.id WHERE m.code_module='COMMUNICATION_CMS' AND m.est_actif AND (m.expires_at IS NULL OR m.expires_at>=CURRENT_DATE)")).rows;
 for(const t of tenants){try{const active=await cmsAccess(t.imf_id);await advanceSchedule(active.id);}catch{}}
 await q("UPDATE cms_notifications SET statut='EN_ATTENTE' WHERE statut='EN_COURS' AND locked_at<now()-interval '5 minutes'");
 const jobs=await tx(async c=>(await c.query(`UPDATE cms_notifications SET statut='EN_COURS',locked_at=now(),tentatives=tentatives+1 WHERE id IN(SELECT id FROM cms_notifications WHERE statut='EN_ATTENTE' AND prochaine_tentative<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *`)).rows);
 for(const job of jobs){try{
 const ctx=(await q(`SELECT p.*,c.full_name AS client_name,c.phone,u.email AS agent_email,t.imf_id,t.nom_imf FROM cms_publications p JOIN tenants t ON t.id=p.tenant_id JOIN client c ON c.id=$3 AND c.imf_id=t.imf_id LEFT JOIN app_user u ON u.id=$4 AND u.imf_id=t.imf_id AND u.is_active WHERE p.tenant_id=$1 AND p.id=$2`,[job.tenant_id,job.publication_id,job.client_id,job.agent_id])).rows[0];
 if(!ctx)throw fail('Destinataire absent.');await cmsAccess(ctx.imf_id);
 if(job.type==='ALERTE_CLIENT'&&!(await clientFeed({tenant_id:job.tenant_id,id:job.client_id},job.publication_id)).length){await q("UPDATE cms_notifications SET statut='ANNULE' WHERE id=$1",[job.id]);continue;}
 const subscriptions=(await q('SELECT subscription FROM cms_push_subscriptions WHERE tenant_id=$1 AND client_id=$2',[job.tenant_id,job.client_id])).rows.map(x=>x.subscription);
 const result=await deliverCmsNotification(job,ctx,subscriptions);
 const status=result.ok?'REMIS':result.configured===false?'NON_CONFIGURE':job.tentatives>=3?'ECHEC':'EN_ATTENTE';
 await q("UPDATE cms_notifications SET statut=$2,resultat=$3::jsonb,prochaine_tentative=now()+interval '5 minutes' WHERE id=$1",[job.id,status,JSON.stringify(result)]);
 }catch(e){await q("UPDATE cms_notifications SET statut=$2,resultat=$3::jsonb,prochaine_tentative=now()+interval '5 minutes' WHERE id=$1",[job.id,job.tentatives>=3?'ECHEC':'EN_ATTENTE',JSON.stringify({ok:false,error:String(e.message).slice(0,250)})]);}}
 }finally{busy=false;}}
export function startCmsWorker(){const timer=setInterval(()=>cmsWorker().catch(e=>console.error('[cms] traitement différé:',e.message)),60000);timer.unref?.();setTimeout(()=>cmsWorker().catch(()=>{}),15000).unref?.();return timer;}
