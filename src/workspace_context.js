// Workspace metadata and validation. No implicit calendar date is a business date.
export const CONTEXT_SCHEMA = `CREATE TABLE IF NOT EXISTS imf_accounting_context (
 imf_id uuid PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
 accounting_date date NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES app_user(id)
)`;
export function validAccountingDate(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const year=Number(value.slice(0,4));if(year<1900||year>9999)return false;
 const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
}
export function decodeLogo(value){
 if(typeof value!=='string')return null;
 const match=/^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match)return null;
 const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>400*1024)return null;
 const mime=match[1]==='image/jpg'?'image/jpeg':match[1];
 if(mime==='image/png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;
 if(mime==='image/jpeg'&&bytes.subarray(0,3).toString('hex')!=='ffd8ff')return null;
 if(mime==='image/webp'&&(bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP'))return null;
 if(mime==='image/svg+xml'){
  const s=bytes.toString('utf8');
  if(!/<svg\b/i.test(s)||/<(?:script|foreignObject|iframe|image|use|animate|set)\b|\bon\w+\s*=|(?:href|url)\s*[=(]|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|javascript:|data:/i.test(s))return null;
 }
 return {mime,bytes};
}
