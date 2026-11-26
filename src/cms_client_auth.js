import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {q,tx} from './db.js';
import {fail,cmsAccess} from './cms_engine.js';
export const clientHash=token=>crypto.createHash('sha256').update(token).digest('hex');
export const clientCookie={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/api/client',maxAge:8*3600000};
export async function clientLogin(req,res,next){try{
 const b=req.body||{};if(typeof b.code_client!=='string'||typeof b.password!=='string'||b.password.length>200)throw fail('Identifiants invalides.',401);
 const row=(await q(`SELECT c.id,c.full_name,c.imf_id,cp.password_hash,cp.login_mode,cp.must_change_password,t.id AS tenant_id FROM client c JOIN client_portal cp ON cp.client_id=c.id AND cp.imf_id=c.imf_id AND cp.is_active JOIN tenants t ON t.imf_id=c.imf_id WHERE c.code_client=$1`,[b.code_client.trim()])).rows[0];
 // Constant bcrypt work for unknown codes as well. OTP is not replaced by a password.
 const valid=await bcrypt.compare(b.password,row?.password_hash||'$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
 if(!row||!valid)throw fail('Code client ou mot de passe incorrect.',401);
 if(row.login_mode==='sms_otp')throw fail('Votre accès nécessite un code SMS. Contactez votre IMF pour utiliser ce portail par mot de passe.',403);
 await cmsAccess(row.imf_id);
 const token=crypto.randomBytes(32).toString('base64url');
 await q("INSERT INTO cms_client_sessions(token_hash,tenant_id,client_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[clientHash(token),row.tenant_id,row.id]);
 res.cookie('teebo_client_session',token,clientCookie);res.json({ok:true,must_change_password:row.must_change_password,client:{full_name:row.full_name}});
 }catch(e){next(e);}}
export async function clientAuthenticate(req,res,next){try{
 const token=req.cookies?.teebo_client_session;if(!token)return res.status(401).json({error:'client_not_authenticated'});
 const c=(await q(`SELECT c.id,c.full_name,c.code_client,c.imf_id,c.agency_unit_id,cp.must_change_password,s.tenant_id FROM cms_client_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN client c ON c.id=s.client_id AND c.imf_id=t.imf_id JOIN client_portal cp ON cp.client_id=c.id AND cp.imf_id=c.imf_id AND cp.is_active WHERE s.token_hash=$1 AND s.expires_at>now()`,[clientHash(token)])).rows[0];
 if(!c)return res.status(401).json({error:'client_not_authenticated'});
 req.client=c;req.cmsTenant=await cmsAccess(c.imf_id,req.method!=='GET');next();
 }catch(e){next(e);}}
export function freshClient(req,res,next){if(req.client.must_change_password)return res.status(403).json({error:'client_password_change_required',message:'Changez votre mot de passe temporaire.'});next();}
export async function changeClientPassword(req,res,next){try{
 const password=req.body?.password;if(typeof password!=='string'||password.length<10||password.length>128)throw fail('Choisissez un mot de passe de 10 à 128 caractères.');
 const hash=await bcrypt.hash(password,12);const token=req.cookies.teebo_client_session;
 await tx(async c=>{await c.query('UPDATE client_portal SET password_hash=$3,must_change_password=false WHERE client_id=$1 AND imf_id=$2',[req.client.id,req.client.imf_id,hash]);await c.query('DELETE FROM cms_client_sessions WHERE client_id=$1 AND tenant_id=$2 AND token_hash<>$3',[req.client.id,req.client.tenant_id,clientHash(token)]);});res.json({ok:true});
 }catch(e){next(e);}}
