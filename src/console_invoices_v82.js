import PDFDocument from 'pdfkit';
import Big from 'big.js';
import {q,tx} from './db.js';
import {fail,money,sql,invalidate,audit} from './console_engine_v82.js';
const asday=v=>v instanceof Date?v.toISOString().slice(0,10):String(v||'').slice(0,10);
const fmt=v=>v?asday(v).split('-').reverse().join('/'):'—';
const currency=v=>Number(v||0).toLocaleString('fr-FR',{maximumFractionDigits:2}).replace(/[\u202f\u00a0]/g,' ')+' FCFA';
export async function invoices(imf=null){
 const modern=(await q(`SELECT f.*,f.numero_facture AS numero,f.periode_debut AS debut,f.periode_fin AS fin,
 f.montant_ttc_xof::text AS total,f.statut_paiement AS statut,f.date_emission AS emise_le,f.date_paiement AS payee_le,
 i.name AS imf,i.code_imf,t.imf_id,'tenant' AS source,
 COALESCE((SELECT SUM(p.montant_xof) FROM saas_paiements p WHERE p.facture_id=f.id),0)::text AS recu
 FROM factures_saas f JOIN tenants t ON t.id=f.tenant_id JOIN imf i ON i.id=t.imf_id
 WHERE ($1::uuid IS NULL OR i.id=$1) ORDER BY f.periode_debut DESC LIMIT 300`,[imf])).rows;
 const old=(await q(`SELECT f.*,f.invoice_number AS numero,f.billing_period_start AS debut,f.billing_period_end AS fin,
 f.grand_total::text AS total,f.status AS statut,f.generated_at AS emise_le,f.paid_at AS payee_le,
 i.name AS imf,i.code_imf,i.id AS imf_id,'imf' AS source,
 COALESCE((SELECT SUM(p.montant_xof) FROM saas_paiements_historiques p WHERE p.facture_id=f.id),0)::text AS recu
 FROM saas_invoices f JOIN imf i ON i.id=f.institution_id
 WHERE ($1::uuid IS NULL OR i.id=$1) ORDER BY f.billing_period_start DESC LIMIT 300`,[imf])).rows;
 return [...modern,...old].map(f=>{const paid=['PAID','PAYEE'].includes(f.statut),cancel=['CANCELLED','ANNULEE'].includes(f.statut);
 const total=new Big(f.total||0),recu=paid?total:new Big(f.recu||0),due=paid||cancel?new Big(0):total.minus(recu);
 return {...f,debut:asday(f.debut),fin:asday(f.fin),emise_le:asday(f.emise_le),payee_le:f.payee_le?asday(f.payee_le):null,
 statut:paid?'PAYEE':cancel?'ANNULEE':'IMPAYEE',statut_libelle:paid?'Payée':cancel?'Annulée':recu.gt(0)?'Partiellement payée':'Impayée',
 total_fcfa:Number(total),recu_fcfa:Number(recu),reste_du_fcfa:Number(due),total_affiche:currency(total)};
 }).sort((a,b)=>b.debut.localeCompare(a.debut));
}
export function totals(rows){return {impaye_fcfa:Number(rows.reduce((v,f)=>v.plus(f.reste_du_fcfa),new Big(0))),encaisse_fcfa:Number(rows.filter(f=>f.statut!=='ANNULEE').reduce((v,f)=>v.plus(f.recu_fcfa),new Big(0)))};}
export async function legacyPay(id,actor,b={}){
 const out=await tx(async c=>{const f=(await c.query('SELECT * FROM saas_invoices WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!f)throw fail('Facture introuvable.',404);if(f.status!=='UNPAID')throw fail('Cette facture n’est pas payable.',409);
 const t=(await c.query('SELECT * FROM tenants WHERE imf_id=$1 FOR UPDATE',[f.institution_id])).rows[0];
 const prior=new Big((await c.query('SELECT COALESCE(SUM(montant_xof),0)::text AS total FROM saas_paiements_historiques WHERE facture_id=$1',[id])).rows[0].total),due=new Big(f.grand_total).minus(prior),amount=money(b.montant??sql(due));
 if(amount.lte(0)||amount.gt(due))throw fail('Montant supérieur au reste dû ou nul.');const mode=b.mode||'VIREMENT';if(!['VIREMENT','MOBILE_MONEY','CHEQUE','ESPECES'].includes(mode))throw fail('Mode invalide.',400);
 const payment=(await c.query(`INSERT INTO saas_paiements_historiques(facture_id,institution_id,montant_xof,mode,reference,encaisse_par) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id,f.institution_id,sql(amount),mode,String(b.reference||'').slice(0,100),actor])).rows[0];
 if(amount.eq(due))await c.query("UPDATE saas_invoices SET status='PAID',paid_at=now() WHERE id=$1",[id]);let reprise=false;
 if(t&&t.statut_compte==='SUSPENDU_IMPAYE'&&b.reactiver!==false){const n=(await c.query(`SELECT (SELECT count(*) FROM factures_saas WHERE tenant_id=$1 AND statut_paiement IN ('EN_ATTENTE','EN_RETARD'))+(SELECT count(*) FROM saas_invoices WHERE institution_id=$2 AND status='UNPAID') AS n`,[t.id,f.institution_id])).rows[0].n;
 if(Number(n)===0){await c.query("UPDATE tenants SET statut_compte='ACTIF',date_suspension=NULL,updated_at=now() WHERE id=$1",[t.id]);await c.query("UPDATE imf SET status='active',updated_at=now() WHERE id=$1",[f.institution_id]);await c.query("UPDATE abonnements_tenants SET statut='ACTIF',updated_at=now() WHERE tenant_id=$1 AND statut='SUSPENDU'",[t.id]);reprise=true;}}
 await audit(c,f.institution_id,actor,'saas.paiement.historique',id,{montant:sql(amount),mode});return {paiement:payment,reste_du:sql(due.minus(amount)),reprise,imf_id:f.institution_id};});await invalidate(out.imf_id);return out;
}
export async function invoicePdf(res,id,source,imf=null){
 const modern=source!=='imf';const query=modern?`SELECT f.*,f.numero_facture AS numero,f.periode_debut AS debut,f.periode_fin AS fin,f.montant_ht_xof AS ht,f.montant_ttc_xof AS ttc,f.tva_pct AS tva,f.date_emission AS emission,t.nom_imf,i.code_imf,i.email,i.phone_main FROM factures_saas f JOIN tenants t ON t.id=f.tenant_id JOIN imf i ON i.id=t.imf_id WHERE f.id=$1 AND ($2::uuid IS NULL OR i.id=$2)`:
 `SELECT f.*,f.invoice_number AS numero,f.billing_period_start AS debut,f.billing_period_end AS fin,f.grand_total AS ht,f.grand_total AS ttc,0 AS tva,f.generated_at AS emission,i.name AS nom_imf,i.code_imf,i.email,i.phone_main FROM saas_invoices f JOIN imf i ON i.id=f.institution_id WHERE f.id=$1 AND ($2::uuid IS NULL OR i.id=$2)`;
 const f=(await q(query,[id,imf])).rows[0];if(!f)throw fail('Facture introuvable.',404);
 const lines=modern?(Array.isArray(f.lignes)?f.lignes:JSON.parse(f.lignes||'[]')):[{libelle:'Coûts fixes',montant:f.fixed_cost_total},{libelle:'Coûts variables',montant:f.variable_cost_total}];
 const doc=new PDFDocument({size:'A4',margin:48,info:{Title:'Facture '+f.numero,Author:'teebo'}});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="'+String(f.numero).replace(/[^a-zA-Z0-9_-]/g,'_')+'.pdf"');res.setHeader('Cache-Control','no-store');doc.pipe(res);
 doc.rect(0,0,595,96).fill('#05072E');doc.fillColor('#C6EA00').font('Helvetica-Bold').fontSize(20).text('teebo',48,26);doc.fillColor('white').fontSize(10).text('FACTURE D’ABONNEMENT',48,56);doc.fontSize(10).text(f.numero,320,30,{width:225,align:'right'});doc.font('Helvetica').fontSize(9).text('Émise le '+fmt(f.emission),320,50,{width:225,align:'right'});
 doc.fillColor('#14162b').font('Helvetica-Bold').fontSize(11).text(String(f.nom_imf),48,120,{width:499});doc.font('Helvetica').fontSize(9).text('Code IMF : '+f.code_imf,{width:499}).text([f.email,f.phone_main].filter(Boolean).join(' · '),{width:499}).text('Période : '+fmt(f.debut)+' au '+fmt(f.fin),{width:499});
 let y=Math.max(195,doc.y+22);const head=()=>{doc.rect(48,y,499,23).fill('#f3f6fa');doc.fillColor('#14162b').font('Helvetica-Bold').fontSize(9).text('DÉSIGNATION',56,y+7,{width:310}).text('MONTANT',388,y+7,{width:150,align:'right'});y+=32;};head();
 for(const l of lines){const label=String(l.libelle||l.module||'Ligne');doc.font('Helvetica').fontSize(9);const height=Math.max(24,doc.heightOfString(label,{width:315})+12);if(y+height>700){doc.addPage();y=60;head();}doc.fillColor('#14162b').text(label,56,y,{width:315}).text(currency(l.montant??l.montant_xof),388,y,{width:150,align:'right'});y+=height;doc.moveTo(48,y-5).lineTo(547,y-5).strokeColor('#dcdfe9').stroke();}
 if(y+110>725){doc.addPage();y=60;}for(const [label,value] of [['Total HT',f.ht],['TVA '+f.tva+' %',new Big(f.ttc).minus(f.ht)],['Total TTC',f.ttc]]){doc.font('Helvetica-Bold').fontSize(10).fillColor('#14162b').text(label,285,y,{width:100,align:'right'}).text(currency(value),388,y,{width:150,align:'right'});y+=23;}
 if(!modern)doc.font('Helvetica').fontSize(8).text('Facture historique : ventilation et total conservés sans recalcul fiscal.',48,y+15,{width:499});doc.end();
}
