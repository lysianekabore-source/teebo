import express from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requirePermission } from '../auth.js';
import { bindActor } from '../audit.js';
import { CONTEXT_SCHEMA, validAccountingDate, decodeLogo, effectiveAccountingDate, accountingToday, ACCOUNTING_TIME_ZONE } from '../workspace_context.js';
const router=express.Router();
router.use('/workspace',authenticate,requireFreshPassword,(req,res,next)=>{
 res.set('Cache-Control','no-store');
 if(!req.user.imf_id||req.user.role==='teebo_admin')return res.status(403).json({error:'imf_required'});
 next();
});
router.get('/workspace/logo',async(req,res,next)=>{
 try{
  const rows=(await q('SELECT logo_data_url FROM imf_branding WHERE imf_id=$1',[req.user.imf_id])).rows;
  const logo=decodeLogo(rows[0]?.logo_data_url);
  if(!logo)return res.status(404).end();
  res.set({'Content-Type':logo.mime,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'});
  res.send(logo.bytes);
 }catch(e){next(e);}
});
router.get('/workspace/accounting-date',async(req,res,next)=>{
 try{
  await q(CONTEXT_SCHEMA);
  const row=(await q(`SELECT accounting_date::text AS date, date_mode, revision, updated_at FROM imf_accounting_context WHERE imf_id=$1`,[req.user.imf_id])).rows[0];
  const context=effectiveAccountingDate(row);
  const closed=(await q('SELECT 1 FROM accounting_period_close WHERE imf_id=$1 AND period=$2',[req.user.imf_id,context.date.slice(0,7)])).rows.length>0;
  res.json({accounting_date:context.date,mode:context.mode,time_zone:ACCOUNTING_TIME_ZONE,revision:row?.revision||0,updated_at:row?.updated_at||null,status:closed?'period_closed':'active'});
 }catch(e){next(e);}
});
router.put('/workspace/accounting-date',requirePermission('accounts.manage'),async(req,res,next)=>{
 try{
  const {revision}=req.body||{};
  const mode=req.body?.mode||'manual';
  if(!['automatic','manual'].includes(mode))return res.status(422).json({error:'invalid_date_mode'});
  const date=mode==='automatic'?accountingToday():req.body?.date;
  if(!validAccountingDate(date))return res.status(422).json({error:'invalid_accounting_date',message:'Choisissez une date valide.'});
  if(!Number.isInteger(revision)||revision<0)return res.status(422).json({error:'revision_required'});
  await q(CONTEXT_SCHEMA);
  const result=await tx(async c=>{
   await bindActor(c,req.user);
   await c.query('SELECT id FROM imf WHERE id=$1 FOR UPDATE',[req.user.imf_id]);
   const prev=(await c.query('SELECT accounting_date::text AS date, date_mode, revision FROM imf_accounting_context WHERE imf_id=$1 FOR UPDATE',[req.user.imf_id])).rows[0];
   if((prev?.revision||0)!==revision)return {error:'context_changed',status:409};
   const closed=(await c.query('SELECT 1 FROM accounting_period_close WHERE imf_id=$1 AND period=$2',[req.user.imf_id,date.slice(0,7)])).rows.length>0;
   if(closed)return {error:'periode_cloturee',status:409};
   const row=(await c.query(`INSERT INTO imf_accounting_context(imf_id,accounting_date,updated_by,date_mode) VALUES($1,$2,$3,$4)
    ON CONFLICT(imf_id) DO UPDATE SET accounting_date=EXCLUDED.accounting_date,date_mode=EXCLUDED.date_mode,revision=imf_accounting_context.revision+1,updated_at=now(),updated_by=EXCLUDED.updated_by
    RETURNING accounting_date::text AS date,revision`,[req.user.imf_id,date,req.user.id,mode])).rows[0];
   await c.query(`INSERT INTO audit_log(imf_id,actor_id,actor_role,action,entity,entity_id,payload)
    VALUES($1,$2,$3,'accounting.date.change','imf_accounting_context',$5::text,$4::jsonb)`,[req.user.imf_id,req.user.id,req.user.role,JSON.stringify({previous_date:effectiveAccountingDate(prev).date,previous_mode:effectiveAccountingDate(prev).mode,date,mode,revision:row.revision}),req.user.imf_id]);
   return {row};
  });
  if(result.error)return res.status(result.status).json({error:result.error});
  res.json({ok:true,accounting_date:result.row.date,revision:result.row.revision,mode,time_zone:ACCOUNTING_TIME_ZONE,status:'active'});
 }catch(e){next(e);}
});
export default router;
