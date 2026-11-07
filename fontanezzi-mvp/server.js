import http from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join,extname,resolve} from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const PORT=Number(process.env.PORT||3000),ROOT=resolve('public');
const DATA_DIR=resolve(process.env.FONTANEZZI_DATA_DIR||'data');
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw Error('PORT inválida');
await mkdir(DATA_DIR,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(DATA_DIR,'fontanezzi.sqlite'));db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','broker','tenant')),person_id INTEGER);
CREATE TABLE IF NOT EXISTS people(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('owner','tenant','other')),document TEXT,phone TEXT,email TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY,code TEXT UNIQUE NOT NULL,title TEXT NOT NULL,address TEXT NOT NULL,city TEXT NOT NULL,type TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('rent','sale')),ownership TEXT NOT NULL CHECK(ownership IN ('own','third')),owner_id INTEGER REFERENCES people(id),rent REAL NOT NULL DEFAULT 0 CHECK(rent>=0),status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','rented','inactive')),published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),description TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),tenant_id INTEGER REFERENCES people(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,rent REAL NOT NULL CHECK(rent>=0),index_name TEXT NOT NULL DEFAULT 'IPCA',admin_fee_type TEXT NOT NULL DEFAULT 'percent' CHECK(admin_fee_type IN ('percent','fixed')),admin_fee REAL NOT NULL DEFAULT 0 CHECK(admin_fee>=0),transfer_mode TEXT NOT NULL DEFAULT 'manual' CHECK(transfer_mode IN ('manual','automatic')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','ended')),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,contract_id INTEGER NOT NULL REFERENCES contracts(id),reference TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>0),due_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),paid_at TEXT,UNIQUE(contract_id,reference));
CREATE TABLE IF NOT EXISTS transfers(id INTEGER PRIMARY KEY,payment_id INTEGER UNIQUE NOT NULL REFERENCES payments(id),amount REAL NOT NULL CHECK(amount>=0),status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN ('awaiting_approval','approved','paid')),approved_by INTEGER REFERENCES users(id),approved_at TEXT,paid_at TEXT);
CREATE TABLE IF NOT EXISTS inspections(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),kind TEXT NOT NULL CHECK(kind IN ('entry','exit')),notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor INTEGER,action TEXT NOT NULL,entity TEXT NOT NULL,entity_id INTEGER,at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);`);
if(!db.prepare('PRAGMA table_info(payments)').all().some(x=>x.name==='created_at'))db.exec('ALTER TABLE payments ADD COLUMN created_at TEXT');
// Migração para permitir contratos sem inquilino informado (cópia transacional da tabela).
if(db.prepare('PRAGMA table_info(contracts)').all().find(x=>x.name==='tenant_id')?.notnull===1){
 db.exec('PRAGMA foreign_keys=OFF');
 try{db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE contracts_new(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),tenant_id INTEGER REFERENCES people(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,rent REAL NOT NULL CHECK(rent>=0),index_name TEXT NOT NULL DEFAULT 'IPCA',admin_fee_type TEXT NOT NULL DEFAULT 'percent' CHECK(admin_fee_type IN ('percent','fixed')),admin_fee REAL NOT NULL DEFAULT 0 CHECK(admin_fee>=0),transfer_mode TEXT NOT NULL DEFAULT 'manual' CHECK(transfer_mode IN ('manual','automatic')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','ended')),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO contracts_new SELECT * FROM contracts;
 DROP TABLE contracts;
 ALTER TABLE contracts_new RENAME TO contracts;
 COMMIT;`)}catch(e){db.exec('ROLLBACK');throw e}finally{db.exec('PRAGMA foreign_keys=ON')}
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Falha de integridade após migração');
}
db.exec('CREATE TABLE IF NOT EXISTS user_contract_links(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,contract_id))');
db.exec('CREATE TABLE IF NOT EXISTS user_property_links(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,PRIMARY KEY(user_id,property_id))');
// Evolução aditiva: preserva os bancos existentes.
for(const [col,definition] of [['cep',"TEXT DEFAULT ''"],['public_description',"TEXT DEFAULT ''"]]){
 if(!db.prepare('PRAGMA table_info(properties)').all().some(x=>x.name===col))db.exec(`ALTER TABLE properties ADD COLUMN ${col} ${definition}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS property_images(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),filename TEXT NOT NULL,mime TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS adjustments(id INTEGER PRIMARY KEY,contract_id INTEGER NOT NULL REFERENCES contracts(id),old_rent REAL NOT NULL,new_rent REAL NOT NULL,rate REAL NOT NULL,reference TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),approved_by INTEGER REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP,approved_at TEXT);
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);`);
 db.exec(`CREATE TABLE IF NOT EXISTS public_leads(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT, message TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS inspection_images(id INTEGER PRIMARY KEY,inspection_id INTEGER NOT NULL REFERENCES inspections(id),filename TEXT NOT NULL,mime TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS property_contacts(id INTEGER PRIMARY KEY,property_id INTEGER NOT NULL REFERENCES properties(id),name TEXT NOT NULL,role TEXT NOT NULL,phone TEXT,email TEXT,document TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS adjustment_notifications(id INTEGER PRIMARY KEY,adjustment_id INTEGER NOT NULL REFERENCES adjustments(id),channel TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// v0.9: pagamentos demonstrativos isolados de recebimentos reais.
db.exec(`CREATE TABLE IF NOT EXISTS integration_configs(provider TEXT PRIMARY KEY,environment TEXT NOT NULL,settings_json TEXT NOT NULL,secret_cipher TEXT,updated_by INTEGER REFERENCES users(id),updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
const INTEGRATION_FIELDS={sicredi:['client_id','cooperativa','posto','beneficiario','convenio'],canalpro:['account_id','external_reference'],docusign:['integration_key','account_id','user_id'],whatsapp:['phone_number_id','business_account_id'],email:['host','port','username','from_address','secure']};
const INTEGRATION_SECRET={sicredi:'client_secret',canalpro:'api_token',docusign:'private_key',whatsapp:'access_token',email:'password'};
function integrationKey(){const hex=process.env.FONTANEZZI_INTEGRATION_KEY||'';return /^[a-fA-F0-9]{64}$/.test(hex)?Buffer.from(hex,'hex'):null}
function encryptIntegration(secret){const key=integrationKey();if(!key)err(503,'Configure FONTANEZZI_INTEGRATION_KEY com 64 caracteres hexadecimais no ambiente do servidor.');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64')}
db.exec(`CREATE TABLE IF NOT EXISTS demo_boletos(payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','simulated_paid')), simulated_at TEXT, simulated_by INTEGER REFERENCES users(id));`);
for(const [col,definition] of [['effective_start',"TEXT"],['effective_end',"TEXT"]]){
 if(!db.prepare('PRAGMA table_info(adjustments)').all().some(x=>x.name===col))db.exec(`ALTER TABLE adjustments ADD COLUMN ${col} ${definition}`);
}
// v0.5: modelos e recorrência local, sem integração bancária nem assinatura.
db.exec(`CREATE TABLE IF NOT EXISTS contract_templates(id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS billing_rules(contract_id INTEGER PRIMARY KEY REFERENCES contracts(id), mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')), issue_day INTEGER NOT NULL CHECK(issue_day BETWEEN 1 AND 28), due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 28), amount REAL NOT NULL CHECK(amount>0), updated_by INTEGER REFERENCES users(id), updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS billing_runs(id INTEGER PRIMARY KEY, ran_at TEXT NOT NULL, generated INTEGER NOT NULL, note TEXT NOT NULL);`);
// v0.6: encargos contratuais e cobrança. Valores percentuais aplicados uma única vez (multa)
// ou proporcionalmente aos dias de atraso (juros simples), nunca alteram o principal.
for(const [col,definition] of [['late_fee_percent','REAL NOT NULL DEFAULT 0'],['monthly_interest_percent','REAL NOT NULL DEFAULT 0']]){
 if(!db.prepare('PRAGMA table_info(billing_rules)').all().some(x=>x.name===col))db.exec(`ALTER TABLE billing_rules ADD COLUMN ${col} ${definition}`);
}
// Migrações aditivas: preservam dados e documentos já existentes.
for(const [table,column,definition] of [['contracts','template_id','INTEGER REFERENCES contract_templates(id)'],['properties','canalpro_enabled','INTEGER NOT NULL DEFAULT 0'],['properties','canalpro_reference',"TEXT NOT NULL DEFAULT ''"]]){
 if(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
if(!db.prepare('SELECT id FROM contract_templates LIMIT 1').get())db.prepare('INSERT INTO contract_templates(name,body) VALUES(?,?)').run('Modelo padrão de locação',`CONTRATO PARTICULAR DE LOCAÇÃO DE IMÓVEL

LOCADOR: {{proprietario}}.
LOCATÁRIO: {{inquilino}}, CPF/CNPJ: {{documento_inquilino}}.
IMÓVEL: {{imovel}}, situado em {{endereco}}, {{cidade}}.

CLÁUSULA 1 - OBJETO
O presente instrumento tem por objeto a locação do imóvel identificado acima.

CLÁUSULA 2 - VIGÊNCIA
O contrato vigorará de {{inicio}} até {{termino}}.

CLÁUSULA 3 - ALUGUEL
O aluguel mensal inicial será de {{aluguel}}, com vencimento conforme as condições ajustadas entre as partes.

CLÁUSULA 4 - REAJUSTE
Índice contratual: {{indice}}. A aplicação depende das condições legais e contratuais.

CLÁUSULA 5 - DISPOSIÇÕES
Este é um modelo inicial para revisão jurídica. Condições de garantias, encargos, rescisão, foro e demais cláusulas devem ser personalizadas antes de assinatura.

_________________________________
LOCADOR / IMOBILIÁRIA

_________________________________
LOCATÁRIO

Documento gerado em {{data_geracao}}. SEM ASSINATURAS DIGITAIS.`);
const brDate=v=>v?`${v.slice(8,10)}/${v.slice(5,7)}/${v.slice(0,4)}`:'Não informado';
const brMoney=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const tenantContractAllowed=(u,cid,tenantId)=>Boolean((u.person_id&&tenantId===u.person_id)||db.prepare('SELECT 1 FROM user_contract_links WHERE user_id=? AND contract_id=?').get(u.id,cid));
const contractData=cid=>db.prepare('SELECT c.*,p.title property_title,p.address,p.city,o.name owner_name,t.name tenant_name,t.document tenant_document FROM contracts c JOIN properties p ON p.id=c.property_id LEFT JOIN people o ON o.id=p.owner_id LEFT JOIN people t ON t.id=c.tenant_id WHERE c.id=?').get(cid);
const renderContract=(c,body)=>body.replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>({proprietario:c.owner_name||'Imobiliária Fontanezzi',inquilino:c.tenant_name||'Não informado',documento_inquilino:c.tenant_document||'Não informado',imovel:c.property_title,endereco:c.address,cidade:c.city,inicio:brDate(c.start_date),termino:brDate(c.end_date),aluguel:brMoney(c.rent),indice:c.index_name,data_geracao:brDate(new Date().toISOString().slice(0,10))})[key]??`{{${key}}}`);
const pdfDocument=(title,content)=>{const clean=s=>String(s).normalize('NFC').replace(/[\u2013\u2014]/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[^\x0A\x0D\x20-\xFF]/g,'?');const lines=[];for(const paragraph of clean(content).split(/\r?\n/)){let current='';for(const word of paragraph.split(/\s+/)){if((current+' '+word).length>88){lines.push(current);current=word}else current+=(current?' ':'')+word}lines.push(current)}const pages=[];for(let i=0;i<lines.length;i+=52)pages.push(lines.slice(i,i+52));if(!pages.length)pages.push([]);const objects=[null],add=s=>{objects.push(s);return objects.length-1};const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');const pagesObj=add('');const pageRefs=[];for(let j=0;j<pages.length;j++){const esc=s=>Buffer.from(clean(s),'latin1').toString('latin1').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');const commands=['BT','/F1 10 Tf','50 790 Td','14 TL',...pages[j].map((line,i)=>`(${esc(line)}) Tj${i<pages[j].length-1?' T*':''}`),'ET'].join('\n');const stream=add(`<< /Length ${Buffer.byteLength(commands,'latin1')} >>\nstream\n${commands}\nendstream`);pageRefs.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`))}objects[pagesObj]=`<< /Type /Pages /Kids [${pageRefs.map(x=>x+' 0 R').join(' ')}] /Count ${pageRefs.length} >>`;const catalog=add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);let data='%PDF-1.4\n',offsets=[0];for(let i=1;i<objects.length;i++){offsets[i]=Buffer.byteLength(data,'latin1');data+=`${i} 0 obj\n${objects[i]}\nendobj\n`}const xref=Buffer.byteLength(data,'latin1');data+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(data,'latin1')};
const lateCharges=(amount,dueDate,asOf,feePercent,interestPercent)=>{const days=Math.max(0,Math.floor((Date.parse(asOf+'T00:00:00Z')-Date.parse(dueDate+'T00:00:00Z'))/86400000));const fine=days?Math.round(amount*feePercent)/100:0;const interest=days?Math.round(amount*interestPercent*days/30)/100:0;return {days_overdue:days,late_fee:Number(fine.toFixed(2)),interest:Number(interest.toFixed(2)),total:Number((amount+fine+interest).toFixed(2))}};
const runRecurring=(today=new Date().toISOString().slice(0,10))=>{const day=Number(today.slice(8,10)),reference=today.slice(0,7);let count=0;const rules=db.prepare(`SELECT b.*,c.start_date,c.end_date,c.status FROM billing_rules b JOIN contracts c ON c.id=b.contract_id WHERE b.mode='automatic' AND c.status='active' AND b.issue_day<=? AND c.start_date<=? AND c.end_date>=?`).all(day,today,today);db.exec('BEGIN IMMEDIATE');try{for(const b of rules){const dueMonth=b.due_day>=b.issue_day?reference:new Date(Date.UTC(Number(reference.slice(0,4)),Number(reference.slice(5,7)),1)).toISOString().slice(0,7);const due=`${dueMonth}-${String(b.due_day).padStart(2,'0')}`;const result=db.prepare('INSERT OR IGNORE INTO payments(contract_id,reference,amount,due_date) VALUES(?,?,?,?)').run(b.contract_id,reference,b.amount,due);if(result.changes){count++;audit(b.updated_by,'generate_recurring_charge','contracts',b.contract_id)}}db.prepare('INSERT INTO billing_runs(ran_at,generated,note) VALUES(?,?,?)').run(today,count,'Cobranças internas geradas; boletos Sicredi NÃO emitidos');db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return count};

await mkdir(join(DATA_DIR,'uploads'),{recursive:true,mode:0o700});
const validDocument=v=>{const d=v.replace(/\D/g,'');if(!d)return true;if(d.length===11){if(/^(\d)\1+$/.test(d))return false;let a=0;for(let i=0;i<9;i++)a+=Number(d[i])*(10-i);let c=(a*10)%11;if(c===10)c=0;if(c!==Number(d[9]))return false;a=0;for(let i=0;i<10;i++)a+=Number(d[i])*(11-i);c=(a*10)%11;return (c===10?0:c)===Number(d[10])}if(d.length===14){if(/^(\d)\1+$/.test(d))return false;const calc=(length,weights)=>{let sum=0;for(let i=0;i<length;i++)sum+=Number(d[i])*weights[i];const n=sum%11;return n<2?0:11-n};return calc(12,[5,4,3,2,9,8,7,6,5,4,3,2])===Number(d[12])&&calc(13,[6,5,4,3,2,9,8,7,6,5,4,3,2])===Number(d[13])}return false};
const cep=v=>{const digits=String(v||'').replace(/\D/g,'');if(digits&&!/^\d{8}$/.test(digits))err(400,'CEP inválido');return digits};
const hashPassword=(p,s=randomBytes(16).toString('hex'))=>s+':'+scryptSync(p,s,64).toString('hex');
const verify=(p,h)=>{const [s,k]=h.split(':');return !!s&&!!k&&timingSafeEqual(Buffer.from(k,'hex'),scryptSync(p,s,64))};
const sha=s=>createHash('sha256').update(s).digest('hex');
if(!db.prepare('SELECT id FROM users LIMIT 1').get()){
 if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12))throw Error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres para o primeiro acesso');
 const pass=process.env.ADMIN_PASSWORD||randomBytes(12).toString('base64url');
 db.prepare('INSERT INTO users(name,email,hash,role) VALUES(?,?,?,?)').run('Administrador','admin@fontanezzi.local',hashPassword(pass),'admin');
 if(process.env.NODE_ENV!=='production')console.log('\n=== PRIMEIRO ACESSO FONTANEZZI ===\nEmail: admin@fontanezzi.local\nSenha: '+pass+'\nAltere a senha depois de entrar.\n==================================\n');
}
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
const err=(status,message)=>{const e=new Error(message);e.status=status;throw e};
const str=(v,max=200,required=true)=>{if(typeof v!=='string')err(400,'Campo inválido');const s=v.trim();if((required&&!s)||s.length>max)err(400,'Texto fora do limite');return s};
const num=(v,min=0,max=1e12)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)err(400,'Valor numérico inválido');return v};
const en=(v,values)=>values.includes(v)?v:err(400,'Opção inválida');
const date=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))err(400,'Data inválida');const d=new Date(v+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v)err(400,'Data inválida');return v};
const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)err(400,'Identificador inválido');return n};
const audit=(u,a,e,i)=>db.prepare('INSERT INTO audit(actor,action,entity,entity_id) VALUES(?,?,?,?)').run(u,a,e,i);
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
const user=req=>{const token=cookie(req).session;if(!token)return null;return db.prepare('SELECT u.id,u.name,u.email,u.role,u.person_id,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(sha(token),Date.now())||null};
const auth=(u,roles)=>{if(!u)err(401,'Faça login');if(roles&&!roles.includes(u.role))err(403,'Acesso não autorizado')};
const body=async req=>{let s='';for await(const chunk of req){s+=chunk;if(s.length>14_500_000)err(413,'Arquivo excede o limite de 10 MB por foto')}try{return JSON.parse(s||'{}')}catch{err(400,'JSON inválido')}};
const exists=(table,n)=>{if(!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(n))err(404,'Registro não encontrado')};
const imageBytes=b=>{const mime=en(b.mime,['image/jpeg','image/png','image/webp']),data=str(b.data,14_000_000),raw=Buffer.from(data,'base64');if(raw.length<32||raw.length>10_000_000)err(400,'A foto deve ter entre 32 bytes e 10 MB');const jpeg=raw[0]===255&&raw[1]===216&&raw[2]===255,png=raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),webp=raw.toString('ascii',0,4)==='RIFF'&&raw.toString('ascii',8,12)==='WEBP';if(!((mime==='image/jpeg'&&jpeg)||(mime==='image/png'&&png)||(mime==='image/webp'&&webp)))err(400,'O conteúdo da foto não corresponde ao formato declarado');return {mime,raw}};
const routes=async(req,res,path,method,u)=>{
 if(path==='/api/login'&&method==='POST'){
  const b=await body(req);const email=str(b.email,254).toLowerCase(),password=str(b.password,200);
  const row=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!row||!verify(password,row.hash))err(401,'Credenciais inválidas');
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(token),row.id,csrf,Date.now()+8*3600000);
  res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${(process.env.COOKIE_SECURE==='1'||process.env.NODE_ENV==='production')?'; Secure':''}`);
  return json(res,200,{id:row.id,name:row.name,role:row.role,csrf});
 }
 if(path==='/api/password-reset/request'&&method==='POST'){
  const b=await body(req),email=str(b.email,254).toLowerCase();const found=db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if(found){const token=randomBytes(32).toString('hex');db.prepare('DELETE FROM password_resets WHERE user_id=?').run(found.id);db.prepare('INSERT INTO password_resets(token_hash,user_id,expires) VALUES(?,?,?)').run(sha(token),found.id,Date.now()+15*60000);
   if(process.env.NODE_ENV==='development'&&process.env.ALLOW_DEV_RESET==='1')console.log('LINK DE REDEFINIÇÃO (APENAS DESENVOLVIMENTO): http://localhost:'+PORT+'/?reset='+token);
   // Nenhum e-mail é alegado como enviado sem provedor configurado.
  }
  return json(res,200,{message:'Se a conta existir, a solicitação será processada. O envio de e-mail requer configuração do provedor.'});
 }
 if(path==='/api/password-reset/confirm'&&method==='POST'){
  const b=await body(req),token=str(b.token,100),password=str(b.password,200);if(password.length<12)err(400,'Senha deve ter pelo menos 12 caracteres');const reset=db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires>? AND used=0').get(sha(token),Date.now());if(!reset)err(400,'Link inválido ou expirado');db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPassword(password),reset.user_id);db.prepare('UPDATE password_resets SET used=1 WHERE token_hash=?').run(sha(token));db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);audit(reset.user_id,'reset_password','users',reset.user_id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return json(res,200,{ok:true});
 }
 if(path==='/api/public/properties' &&method==='GET')return json(res,200,db.prepare("SELECT p.id,p.code,p.title,p.city,p.type,p.purpose,p.rent,p.description,p.public_description,(SELECT id FROM property_images WHERE property_id=p.id ORDER BY id LIMIT 1) cover_image_id FROM properties p WHERE p.published=1 AND p.status='available' ORDER BY p.id DESC").all());
 const publicDetail=path.match(/^\/api\/public\/properties\/(\d+)$/);
 if(publicDetail&&method==='GET'){const prop=db.prepare("SELECT id,code,title,city,type,purpose,rent,description,public_description FROM properties WHERE id=? AND published=1 AND status='available'").get(id(publicDetail[1]));if(!prop)err(404,'Imóvel indisponível');return json(res,200,{...prop,images:db.prepare('SELECT id FROM property_images WHERE property_id=? ORDER BY id').all(prop.id)});}
 if(path==='/api/public/leads'&&method==='POST'){const b=await body(req),pid=id(b.property_id),name=str(b.name,120),email=str(b.email,254).toLowerCase(),phone=str(b.phone||'',30),message=str(b.message||'',1000);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))err(400,'E-mail inválido');if(name.length<2)err(400,'Informe seu nome');if(!db.prepare("SELECT id FROM properties WHERE id=? AND published=1 AND status='available'").get(pid))err(404,'Imóvel indisponível');if(!b.consent)err(400,'Confirme o envio dos seus dados');const r=db.prepare('INSERT INTO public_leads(property_id,name,email,phone,message) VALUES(?,?,?,?,?)').run(pid,name,email,phone,message);return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});}
 const publicPhoto=path.match(/^\/api\/public\/images\/(\d+)$/);
 if(publicPhoto&&method==='GET'){const im=db.prepare("SELECT i.* FROM property_images i JOIN properties p ON p.id=i.property_id WHERE i.id=? AND p.published=1 AND p.status='available'").get(id(publicPhoto[1]));if(!im)err(404,'Imagem indisponível');res.writeHead(200,{'Content-Type':im.mime,'Cache-Control':'public,max-age=300','X-Content-Type-Options':'nosniff'});return res.end(await readFile(join(DATA_DIR,'uploads',im.filename)))} 
 auth(u);
 if(method!=='GET'&&req.headers['x-csrf-token']!==u.csrf)err(403,'Token de segurança inválido');
 if(path==='/api/tenant/properties'&&method==='GET'){auth(u,['tenant']);return json(res,200,db.prepare(`SELECT DISTINCT p.id,p.code,p.title,p.address,p.city,p.type,p.description,p.public_description FROM properties p WHERE EXISTS(SELECT 1 FROM user_property_links l WHERE l.property_id=p.id AND l.user_id=?) OR EXISTS(SELECT 1 FROM contracts c LEFT JOIN user_contract_links l ON l.contract_id=c.id WHERE c.property_id=p.id AND ((c.tenant_id=? AND ? IS NOT NULL) OR l.user_id=?)) ORDER BY p.title`).all(u.id,u.person_id||-1,u.person_id,u.id))}
 if(path==='/api/me'&&method==='GET')return json(res,200,{id:u.id,name:u.name,role:u.role,csrf:u.csrf});
 if(path==='/api/logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(cookie(req).session));res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true})}
 if(path==='/api/password'&&method==='POST'){const b=await body(req);const row=db.prepare('SELECT hash FROM users WHERE id=?').get(u.id);if(!verify(str(b.current,200),row.hash))err(400,'Senha atual incorreta');const next=str(b.next,200);if(next.length<12)err(400,'Use ao menos 12 caracteres');db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPassword(next),u.id);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id,sha(cookie(req).session));audit(u.id,'password_change','users',u.id);return json(res,200,{ok:true})}
 if(path==='/api/users'&&method==='GET'){auth(u,['admin']);return json(res,200,db.prepare(`SELECT u.id,u.name,u.email,u.role,u.person_id,(SELECT json_group_array(property_id) FROM user_property_links WHERE user_id=u.id) property_ids,(SELECT json_group_array(contract_id) FROM user_contract_links WHERE user_id=u.id) contract_ids FROM users u ORDER BY u.id DESC`).all())}
 const editUser=path.match(/^\/api\/users\/(\d+)$/);
 if(editUser&&method==='PATCH'){
  auth(u,['admin']);const uid=id(editUser[1]),current=db.prepare('SELECT id,role FROM users WHERE id=?').get(uid);if(!current)err(404,'Usuário não encontrado');
  const b=await body(req),name=str(b.name,160),email=str(b.email,254).toLowerCase(),role=en(b.role,['admin','broker','tenant']);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))err(400,'E-mail inválido');
  if(uid===u.id&&role!=='admin')err(400,'Não é possível remover o próprio perfil de administrador');
  const person=b.person_id?id(b.person_id):null;

  if(person){const p=db.prepare('SELECT kind FROM people WHERE id=?').get(person);if(!p)err(400,'Pessoa não encontrada');if(role==='tenant'&&p.kind!=='tenant')err(400,'Selecione uma pessoa cadastrada como inquilino')}
  if(!Array.isArray(b.property_ids)||b.property_ids.length>100)err(400,'Lista de imóveis inválida');
  const ids=[...new Set(b.property_ids.map(id))];
  if(role!=='tenant'&&ids.length)err(400,'Vínculo direto de imóvel disponível apenas para inquilinos');
  for(const pid of ids)exists('properties',pid);
  if(!Array.isArray(b.contract_ids)||b.contract_ids.length>100)err(400,'Lista de contratos inválida');const contractIds=[...new Set(b.contract_ids.map(id))];if(role!=='tenant'&&contractIds.length)err(400,'Contratos vinculados somente a inquilinos');for(const cid of contractIds){const c=db.prepare('SELECT property_id FROM contracts WHERE id=?').get(cid);if(!c||!ids.includes(c.property_id))err(400,'Contrato não pertence aos imóveis selecionados');}
  try{db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE users SET name=?,email=?,role=?,person_id=? WHERE id=?').run(name,email,role,person,uid);db.prepare('DELETE FROM user_property_links WHERE user_id=?').run(uid);for(const pid of ids)db.prepare('INSERT INTO user_property_links(user_id,property_id) VALUES(?,?)').run(uid,pid);db.prepare('DELETE FROM user_contract_links WHERE user_id=?').run(uid);for(const cid of contractIds)db.prepare('INSERT INTO user_contract_links(user_id,contract_id) VALUES(?,?)').run(uid,cid);if(uid!==u.id)db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);audit(u.id,'edit','users',uid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  return json(res,200,{ok:true});
 }

 if(path==='/api/users'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),name=str(b.name,160),email=str(b.email,254).toLowerCase(),role=en(b.role,['admin','broker','tenant']),person=b.person_id?id(b.person_id):null;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))err(400,'E-mail inválido');if(person)exists('people',person);
  const password=str(b.password,200);if(password.length<12)err(400,'Senha inicial deve ter pelo menos 12 caracteres');const r=db.prepare('INSERT INTO users(name,email,hash,role,person_id) VALUES(?,?,?,?,?)').run(name,email,hashPassword(password),role,person);audit(u.id,'create','users',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)});
 }
 const resetUser=path.match(/^\/api\/users\/(\d+)\/password-reset$/);
 if(resetUser&&method==='POST'){auth(u,['admin']);const uid=id(resetUser[1]),account=db.prepare('SELECT id,email FROM users WHERE id=?').get(uid);if(!account)err(404,'Usuário não encontrado');const token=randomBytes(32).toString('hex');db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid);db.prepare('INSERT INTO password_resets(token_hash,user_id,expires) VALUES(?,?,?)').run(sha(token),uid,Date.now()+15*60000);audit(u.id,'request_password_reset','users',uid);if(process.env.NODE_ENV==='development'&&process.env.ALLOW_DEV_RESET==='1')console.log('RESET SOLICITADO PARA '+account.email+': http://localhost:'+PORT+'/?reset='+token);return json(res,200,{message:'Solicitação registrada. Nenhum e-mail foi enviado: configure um provedor de e-mail. Em desenvolvimento, o link pode ser exibido no terminal com ALLOW_DEV_RESET=1.'})}
 if(path==='/api/users/role'&&method==='PATCH'){
  auth(u,['admin']);const b=await body(req),uid=id(b.id),role=en(b.role,['admin','broker','tenant']);if(uid===u.id)err(400,'Não é possível alterar o próprio perfil');const person=b.person_id?id(b.person_id):null;if(person)exists('people',person);const r=db.prepare('UPDATE users SET role=?,person_id=? WHERE id=?').run(role,person,uid);if(!r.changes)err(404,'Usuário não encontrado');db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);audit(u.id,'change_role','users',uid);return json(res,200,{ok:true});
 }
 if(path==='/api/dashboard' &&method==='GET'){
  auth(u,['admin','broker']);return json(res,200,{properties:db.prepare('SELECT COUNT(*) n FROM properties').get().n,rented:db.prepare("SELECT COUNT(*) n FROM properties WHERE status='rented'").get().n,available:db.prepare("SELECT COUNT(*) n FROM properties WHERE status='available'").get().n,received:db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='paid' AND substr(paid_at,1,7)=strftime('%Y-%m','now')").get().n,late:db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending' AND due_date<date('now')").get().n,transfers:db.prepare("SELECT COUNT(*) n FROM transfers WHERE status='awaiting_approval'").get().n});
 }
 if(path==='/api/people'&&method==='GET'){auth(u,['admin','broker']);return json(res,200,db.prepare(`SELECT pe.*, (SELECT json_group_array(json_object('property_id',z.property_id,'title',z.title,'code',z.code,'start_date',z.start_date,'end_date',z.end_date,'status',z.status)) FROM (SELECT DISTINCT c.property_id,p.title,p.code,c.start_date,c.end_date,c.status FROM contracts c JOIN properties p ON p.id=c.property_id WHERE c.tenant_id=pe.id ORDER BY c.start_date DESC) z) AS linked_properties FROM people pe ORDER BY pe.id DESC LIMIT 500`).all())}
 if(path==='/api/people'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),name=str(b.name,160),kind=en(b.kind,['owner','tenant','other']),document=str(b.document||'',20,false),phone=str(b.phone||'',30,false),email=str(b.email||'',254,false);
  if(document&&!validDocument(document))err(400,'CPF/CNPJ inválido');
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))err(400,'E-mail inválido');
  const r=db.prepare('INSERT INTO people(name,kind,document,phone,email) VALUES(?,?,?,?,?)').run(name,kind,document,phone,email);audit(u.id,'create','people',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)});
 }
 if(path==='/api/properties'&&method==='GET'){
  auth(u,['admin','broker']);return json(res,200,db.prepare('SELECT p.*,o.name owner_name FROM properties p LEFT JOIN people o ON o.id=p.owner_id ORDER BY p.id DESC LIMIT 500').all());
 }
 if(path==='/api/properties'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),ownership=en(b.ownership,['own','third']),owner=b.owner_id? id(b.owner_id):null;
  if(owner)exists('people',owner);
  const r=db.prepare('INSERT INTO properties(code,title,address,city,type,purpose,ownership,owner_id,rent,status,published,description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('IMV-'+Date.now().toString(36).toUpperCase(),str(b.title,160),str(b.address,250),str(b.city,100),en(b.type,['Casa','Apartamento','Galpão','Salão','Outros']),en(b.purpose,['rent','sale']),ownership,owner,num(b.rent),en(b.status,['available','rented','inactive']),b.published===true?1:0,str(b.description||'',2000,false));db.prepare('UPDATE properties SET cep=?,public_description=? WHERE id=?').run(cep(b.cep),str(b.public_description||'',3000,false),r.lastInsertRowid);audit(u.id,'create','properties',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)});
 }
 const pm=path.match(/^\/api\/properties\/(\d+)$/);
 if(pm&&method==='PATCH'){
  auth(u,['admin']);const b=await body(req),pid=id(pm[1]);exists('properties',pid);
  const fields=['title','address','city','type','purpose','ownership','owner_id','rent','status','published','description','cep','public_description'];const update=[];const vals=[];
  for(const k of fields)if(Object.hasOwn(b,k)){let v=b[k];if(['title','address','city','type','description','public_description'].includes(k))v=str(v,k==='public_description'?3000:k==='description'?2000:250,!['description','public_description'].includes(k));if(k==='cep')v=cep(v);if(k==='type')v=en(v,['Casa','Apartamento','Galpão','Salão','Outros']);if(k==='purpose')v=en(v,['rent','sale']);if(k==='ownership')v=en(v,['own','third']);if(k==='status')v=en(v,['available','rented','inactive']);if(k==='owner_id'){v=v?id(v):null;if(v)exists('people',v)}if(k==='rent')v=num(v);if(k==='published')v=v===true?1:0;update.push(k+'=?');vals.push(v)}
  if(!update.length)err(400,'Nenhuma alteração');db.prepare(`UPDATE properties SET ${update.join(',')} WHERE id=?`).run(...vals,pid);audit(u.id,'update','properties',pid);return json(res,200,{ok:true});
 }
 if(pm&&method==='DELETE'){
  auth(u,['admin']);const pid=id(pm[1]);exists('properties',pid);
  const dependencies=[['contracts','contratos'],['inspections','vistorias'],['property_contacts','contatos adicionais'],['property_images','imagens']];
  const blockers=dependencies.map(([table,label])=>({label,count:db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE property_id=?`).get(pid).n})).filter(x=>x.count>0);
  if(blockers.length)err(409,'Este imóvel não pode ser excluído porque possui '+blockers.map(x=>`${x.count} ${x.label}`).join(', ')+'. Preserve o histórico e altere a situação para Inativo.');
  db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM properties WHERE id=?').run(pid);audit(u.id,'delete','properties',pid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  return json(res,200,{ok:true,message:'Imóvel excluído com sucesso'});
 }
 const detail=path.match(/^\/api\/properties\/(\d+)\/details$/);
 if(detail&&method==='GET'){
  auth(u,['admin','broker']);const pid=id(detail[1]);const property=db.prepare('SELECT p.*,o.name owner_name FROM properties p LEFT JOIN people o ON o.id=p.owner_id WHERE p.id=?').get(pid);if(!property)err(404,'Imóvel não encontrado');if(u.role!=='admin'){delete property.canalpro_enabled;delete property.canalpro_reference;}return json(res,200,{property,contracts:db.prepare('SELECT c.*,t.name tenant_name FROM contracts c LEFT JOIN people t ON t.id=c.tenant_id WHERE c.property_id=? ORDER BY c.id DESC').all(pid),payments:db.prepare('SELECT p.* FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE c.property_id=? ORDER BY p.id DESC').all(pid),inspections:db.prepare('SELECT i.*,u.name author FROM inspections i JOIN users u ON u.id=i.created_by WHERE i.property_id=? ORDER BY i.id DESC').all(pid),images:db.prepare('SELECT id,mime FROM property_images WHERE property_id=? ORDER BY id DESC').all(pid),leads:db.prepare('SELECT id,name,email,phone,message,created_at FROM public_leads WHERE property_id=? ORDER BY id DESC LIMIT 100').all(pid),audit:db.prepare("SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor WHERE (a.entity='properties' AND a.entity_id=?) OR (a.entity='contracts' AND a.entity_id IN (SELECT id FROM contracts WHERE property_id=?)) ORDER BY a.id DESC LIMIT 100").all(pid,pid),adjustments:db.prepare("SELECT a.*, (SELECT group_concat(n.channel || ': ' || n.status, ', ') FROM adjustment_notifications n WHERE n.adjustment_id=a.id) notification_status FROM adjustments a JOIN contracts c ON c.id=a.contract_id WHERE c.property_id=? ORDER BY a.id DESC").all(pid),extra_contacts:db.prepare('SELECT * FROM property_contacts WHERE property_id=? ORDER BY id DESC').all(pid),contacts:db.prepare("SELECT 'Proprietário' kind,o.name,o.document,o.phone,o.email FROM properties p JOIN people o ON o.id=p.owner_id WHERE p.id=? UNION ALL SELECT 'Inquilino',t.name,t.document,t.phone,t.email FROM contracts c LEFT JOIN people t ON t.id=c.tenant_id WHERE c.property_id=? AND c.tenant_id IS NOT NULL ORDER BY kind,name").all(pid,pid)});
 }
 const contactPost=path.match(/^\/api\/properties\/(\d+)\/contacts$/);
 if(contactPost&&method==='POST'){auth(u,['admin']);const pid=id(contactPost[1]);exists('properties',pid);const b=await body(req),name=str(b.name,160),role=str(b.role,80),phone=str(b.phone||'',30,false),email=str(b.email||'',254,false),document=str(b.document||'',20,false);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))err(400,'Informe um e-mail válido');if(document&&!validDocument(document))err(400,'CPF/CNPJ do contato inválido');const r=db.prepare('INSERT INTO property_contacts(property_id,name,role,phone,email,document) VALUES(?,?,?,?,?,?)').run(pid,name,role,phone,email,document);audit(u.id,'create_contact','properties',pid);return json(res,201,{id:Number(r.lastInsertRowid)})}
 const contractDetail=path.match(/^\/api\/contracts\/(\d+)$/);
 if(contractDetail&&method==='GET'){auth(u);const cid=id(contractDetail[1]);const c=db.prepare('SELECT c.*,p.title property_title,p.address,p.city,t.name tenant_name,t.document tenant_document,t.phone tenant_phone,t.email tenant_email FROM contracts c JOIN properties p ON p.id=c.property_id LEFT JOIN people t ON t.id=c.tenant_id WHERE c.id=?').get(cid);if(!c)err(404,'Contrato não encontrado');if(u.role==='tenant'&&!tenantContractAllowed(u,c.id,c.tenant_id))err(403,'Este contrato não pertence ao seu usuário');return json(res,200,c)}
 const adjustmentEdit=path.match(/^\/api\/adjustments\/(\d+)$/);
 if(adjustmentEdit&&method==='PATCH'){auth(u,['admin']);const aid=id(adjustmentEdit[1]),b=await body(req),a=db.prepare('SELECT a.*,c.rent current_rent FROM adjustments a JOIN contracts c ON c.id=a.contract_id WHERE a.id=?').get(aid);if(!a)err(404,'Reajuste não encontrado');if(a.status!=='pending')err(409,'Somente reajustes pendentes podem ser editados');const rate=num(b.rate,-100,1000),reference=str(b.reference,7);if(!/^\d{4}-\d{2}$/.test(reference))err(400,'Competência inválida. Use AAAA-MM');const next=Math.round(a.current_rent*(1+rate/100)*100)/100;const start=b.effective_start?date(b.effective_start):a.effective_start;const end=b.effective_end?date(b.effective_end):a.effective_end;if(start&&end&&end<start)err(400,'A data final deve ser igual ou posterior à data inicial');db.prepare('UPDATE adjustments SET rate=?,reference=?,old_rent=?,new_rent=?,effective_start=?,effective_end=? WHERE id=?').run(rate,reference,a.current_rent,next,start,end,aid);audit(u.id,'edit_adjustment','adjustments',aid);return json(res,200,{id:aid,new_rent:next})}
 const notify=path.match(/^\/api\/adjustments\/(\d+)\/notify$/);
 if(notify&&method==='POST'){auth(u,['admin']);const aid=id(notify[1]);const a=db.prepare('SELECT a.*,t.email tenant_email FROM adjustments a JOIN contracts c ON c.id=a.contract_id LEFT JOIN people t ON t.id=c.tenant_id WHERE a.id=?').get(aid);if(!a)err(404,'Reajuste não encontrado');if(!a.tenant_email)err(400,'Cadastre um e-mail do inquilino antes de enviar o reajuste');err(503,'Envio indisponível: configure um provedor de e-mail homologado. Nenhuma mensagem foi enviada')}
 const inspectionDetail=path.match(/^\/api\/inspections\/(\d+)$/);
 if(inspectionDetail&&method==='GET'){auth(u,['admin','broker']);const iid=id(inspectionDetail[1]),inspection=db.prepare('SELECT i.*,p.title property_title,p.address,p.city,u.name author FROM inspections i JOIN properties p ON p.id=i.property_id JOIN users u ON u.id=i.created_by WHERE i.id=?').get(iid);if(!inspection)err(404,'Vistoria não encontrada');return json(res,200,{inspection,images:db.prepare('SELECT id,mime FROM inspection_images WHERE inspection_id=? ORDER BY id').all(iid)})}
 const inspectionImagePost=path.match(/^\/api\/inspections\/(\d+)\/images$/);
 if(inspectionImagePost&&method==='POST'){auth(u,['admin','broker']);const iid=id(inspectionImagePost[1]);exists('inspections',iid);const {mime,raw}=imageBytes(await body(req));const name=randomBytes(20).toString('hex')+'.'+({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime]);await writeFile(join(DATA_DIR,'uploads',name),raw,{flag:'wx',mode:0o600});const r=db.prepare('INSERT INTO inspection_images(inspection_id,filename,mime) VALUES(?,?,?)').run(iid,name,mime);audit(u.id,'upload_inspection_photo','inspections',iid);return json(res,201,{id:Number(r.lastInsertRowid)})}
 const inspectionImageGet=path.match(/^\/api\/inspection-images\/(\d+)$/);
 if(inspectionImageGet&&method==='GET'){auth(u,['admin','broker']);const im=db.prepare('SELECT * FROM inspection_images WHERE id=?').get(id(inspectionImageGet[1]));if(!im)err(404,'Foto não encontrada');res.writeHead(200,{'Content-Type':im.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(await readFile(join(DATA_DIR,'uploads',im.filename)))}
 const configRoute=path.match(/^\/api\/integrations\/(sicredi|canalpro|docusign|whatsapp|email)\/config$/);
 if(configRoute&&method==='GET'){
  auth(u,['admin']);const provider=configRoute[1],r=db.prepare('SELECT environment,settings_json,secret_cipher,updated_at FROM integration_configs WHERE provider=?').get(provider);
  return json(res,200,{provider,environment:r?.environment||'sandbox',settings:r?JSON.parse(r.settings_json):{},secret_configured:!!r?.secret_cipher,updated_at:r?.updated_at||null,active:false,notice:'Configuração armazenada. Conexão externa não implementada nem validada.'});
 }
 if(configRoute&&method==='PUT'){
  auth(u,['admin']);const provider=configRoute[1],b=await body(req),environment=en(b.environment,['sandbox','production']);
  if(!b.settings||typeof b.settings!=='object'||Array.isArray(b.settings))err(400,'Configurações inválidas');
  const settings={};for(const field of INTEGRATION_FIELDS[provider]){const value=b.settings[field]??'';if(typeof value!=='string'||value.length>500)err(400,'Campo inválido: '+field);settings[field]=value.trim()}
  if(provider==='email'&&settings.port&&(!/^\d{1,5}$/.test(settings.port)||Number(settings.port)>65535||Number(settings.port)<1))err(400,'Porta SMTP inválida');
  const secret=b.secret??'';if(typeof secret!=='string'||secret.length>12000)err(400,'Credencial inválida');
  const old=db.prepare('SELECT secret_cipher FROM integration_configs WHERE provider=?').get(provider);
  const secretCipher=secret?encryptIntegration(secret):(old?.secret_cipher||null);
  db.prepare(`INSERT INTO integration_configs(provider,environment,settings_json,secret_cipher,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET environment=excluded.environment,settings_json=excluded.settings_json,secret_cipher=excluded.secret_cipher,updated_by=excluded.updated_by,updated_at=datetime('now')`).run(provider,environment,JSON.stringify(settings),secretCipher,u.id);
  audit(u.id,'configure_integration','integration_configs',null);
  return json(res,200,{ok:true,secret_configured:!!secretCipher,active:false,notice:'Configuração salva. Nenhuma conexão externa foi ativada.'});
 }
 if(path==='/api/integrations/overview'&&method==='GET'){
  auth(u,['admin']);const result={};for(const provider of Object.keys(INTEGRATION_FIELDS)){const r=db.prepare('SELECT environment,secret_cipher FROM integration_configs WHERE provider=?').get(provider);result[provider]={configured:!!r,credentials_saved:!!r?.secret_cipher,environment:r?.environment||'sandbox',live:false}}return json(res,200,{...result,signatures:{configured:false,legal_signing:false},fiscal:{configured:false,official_issuance:false},notice:'Configurações locais salvas; integrações externas ainda não ativadas.'});
 }
 const sicrediStatus=path==='/api/integrations/sicredi/status';
 if(sicrediStatus&&method==='GET'){auth(u,['admin']);return json(res,200,{configured:false,issuance:false,reconciliation:false,message:'Integração Sicredi não configurada. Boletos e baixas bancárias não estão disponíveis.'})}
 const canalLink=path.match(/^\/api\/properties\/(\d+)\/canalpro$/);
 if(canalLink&&method==='PUT'){auth(u,['admin']);const pid=id(canalLink[1]),b=await body(req);exists('properties',pid);if(typeof b.enabled!=='boolean')err(400,'Vínculo inválido');const ref=str(b.reference||'',120,false).trim();db.prepare('UPDATE properties SET canalpro_enabled=?,canalpro_reference=? WHERE id=?').run(b.enabled?1:0,ref,pid);audit(u.id,'configure_canalpro_property','properties',pid);return json(res,200,{ok:true,notice:'Vínculo local salvo. Sincronização externa ainda não implementada.'})}
 const imageDelete=path.match(/^\/api\/properties\/(\d+)\/images\/(\d+)$/);
 if(imageDelete&&method==='DELETE'){auth(u,['admin']);const pid=id(imageDelete[1]),iid=id(imageDelete[2]);const result=db.prepare('DELETE FROM property_images WHERE id=? AND property_id=?').run(iid,pid);if(!result.changes)err(404,'Foto não encontrada');audit(u.id,'delete_property_photo','properties',pid);return json(res,200,{ok:true})}
 const imagePost=path.match(/^\/api\/properties\/(\d+)\/images$/);
 if(imagePost&&method==='POST'){
  auth(u,['admin','broker']);const pid=id(imagePost[1]);exists('properties',pid);const b=await body(req),mime=en(b.mime,['image/jpeg','image/png','image/webp']),data=str(b.data,4_000_000),raw=Buffer.from(data,'base64');if(raw.length<32||raw.length>2_000_000)err(400,'Imagem deve ter até 2 MB');const jpeg=raw[0]===255&&raw[1]===216&&raw[2]===255,png=raw.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),webp=raw.toString('ascii',0,4)==='RIFF'&&raw.toString('ascii',8,12)==='WEBP';if(!((mime==='image/jpeg'&&jpeg)||(mime==='image/png'&&png)||(mime==='image/webp'&&webp)))err(400,'Conteúdo de imagem inválido');const name=randomBytes(20).toString('hex')+({ 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime]);await writeFile(join(DATA_DIR,'uploads',name),raw,{flag:'wx',mode:0o600});const r=db.prepare('INSERT INTO property_images(property_id,filename,mime) VALUES(?,?,?)').run(pid,name,mime);audit(u.id,'upload','properties',pid);return json(res,201,{id:Number(r.lastInsertRowid)});
 }
 const imageGet=path.match(/^\/api\/images\/(\d+)$/);
 if(imageGet&&method==='GET'){
  auth(u,['admin','broker']);const image=db.prepare('SELECT * FROM property_images WHERE id=?').get(id(imageGet[1]));if(!image)err(404,'Imagem não encontrada');res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(await readFile(join(DATA_DIR,'uploads',image.filename)));
 }
 if(path==='/api/contract-templates'&&method==='POST'){auth(u,['admin']);const b=await body(req),name=str(b.name,120),content=str(b.body,16000);if(!content.includes('{{imovel}}')||!content.includes('{{inquilino}}'))err(400,'Inclua {{imovel}} e {{inquilino}}');const r=db.prepare('INSERT INTO contract_templates(name,body) VALUES(?,?)').run(name,content);audit(u.id,'create_contract_template','contract_templates',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)})}
 const tplDelete=path.match(/^\/api\/contract-templates\/(\d+)$/);
 if(tplDelete&&method==='DELETE'){auth(u,['admin']);const tid=id(tplDelete[1]);exists('contract_templates',tid);if(db.prepare('SELECT COUNT(*) n FROM contract_templates').get().n<=1)err(409,'Mantenha pelo menos um modelo');if(db.prepare('SELECT 1 FROM contracts WHERE template_id=? LIMIT 1').get(tid))err(409,'Modelo vinculado a contratos; não pode ser excluído');db.prepare('DELETE FROM contract_templates WHERE id=?').run(tid);audit(u.id,'delete_contract_template','contract_templates',tid);return json(res,200,{ok:true})}
 if(path==='/api/contract-templates'&&method==='GET'){auth(u,['admin']);return json(res,200,db.prepare('SELECT * FROM contract_templates ORDER BY id').all())}
 const tplUpdate=path.match(/^\/api\/contract-templates\/(\d+)$/);
 if(tplUpdate&&method==='PUT'){auth(u,['admin']);const tid=id(tplUpdate[1]),b=await body(req);exists('contract_templates',tid);const name=str(b.name,120),content=str(b.body,16000);if(!content.includes('{{imovel}}')||!content.includes('{{inquilino}}'))err(400,'O modelo precisa conter {{imovel}} e {{inquilino}}');db.prepare("UPDATE contract_templates SET name=?,body=?,updated_at=datetime('now') WHERE id=?").run(name,content,tid);audit(u.id,'edit_contract_template','contract_templates',tid);return json(res,200,{ok:true})}
 const contractPdf=path.match(/^\/api\/contracts\/(\d+)\/pdf$/);
 if(contractPdf&&method==='GET'){auth(u);const cid=id(contractPdf[1]),c=contractData(cid);if(!c)err(404,'Contrato não encontrado');if(u.role==='tenant'&&!tenantContractAllowed(u,c.id,c.tenant_id))err(403,'Você não tem acesso a este contrato');const template=db.prepare('SELECT body FROM contract_templates WHERE id=COALESCE(?,(SELECT id FROM contract_templates ORDER BY id LIMIT 1))').get(c.template_id);const pdf=pdfDocument('Contrato',renderContract(c,template.body));res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="contrato-${cid}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(pdf)}
 const demo=path.match(/^\/api\/payments\/(\d+)\/demo-boleto$/);
 if(demo&&method==='GET'){
  auth(u,['admin','broker']);const pid=id(demo[1]);const payment=db.prepare(`SELECT p.*,c.property_id,c.tenant_id,pr.title property_title,pr.address,pr.city,pe.name tenant_name FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN properties pr ON pr.id=c.property_id LEFT JOIN people pe ON pe.id=c.tenant_id WHERE p.id=?`).get(pid);if(!payment)err(404,'Cobrança não encontrada');const demoState=db.prepare('SELECT status,simulated_at FROM demo_boletos WHERE payment_id=?').get(pid);return json(res,200,{...payment,demo_status:demoState?.status||'pending',simulated_at:demoState?.simulated_at||null,bank_boleto_issued:false,bank_payment_confirmed:false,notice:'BOLETO DEMONSTRATIVO — NÃO PAGÁVEL. A simulação não confirma recebimento real.'});
 }
 const demoSim=path.match(/^\/api\/payments\/(\d+)\/demo-boleto\/simulate$/);
 if(demoSim&&method==='POST'){
  auth(u,['admin']);const pid=id(demoSim[1]);exists('payments',pid);db.prepare(`INSERT INTO demo_boletos(payment_id,status,simulated_at,simulated_by) VALUES(?,'simulated_paid',datetime('now'),?) ON CONFLICT(payment_id) DO NOTHING`).run(pid,u.id);audit(u.id,'simulate_demo_payment','payments',pid);return json(res,200,{ok:true,bank_payment_confirmed:false,message:'Pagamento simulado. Nenhum recebimento bancário foi confirmado.'});
 }
 const demoCreate=path.match(/^\/api\/contracts\/(\d+)\/demo-charge$/);
 if(demoCreate&&method==='POST'){
  auth(u,['admin']);const cid=id(demoCreate[1]);const c=db.prepare('SELECT c.*,b.issue_day,b.due_day,b.amount FROM contracts c JOIN billing_rules b ON b.contract_id=c.id WHERE c.id=?').get(cid);
  if(!c)err(404,'Configure a cobrança deste contrato antes de gerar o boleto demonstrativo');
  const today=new Date().toISOString().slice(0,10),ref=today.slice(0,7);
  if(today<c.start_date||today>c.end_date||c.status!=='active')err(409,'O contrato não está ativo ou está fora da vigência');
  const dueMonth=c.due_day>=c.issue_day?ref:new Date(Date.UTC(Number(ref.slice(0,4)),Number(ref.slice(5,7)),1)).toISOString().slice(0,7);
  const due=dueMonth+'-'+String(c.due_day).padStart(2,'0');
  const result=db.prepare('INSERT OR IGNORE INTO payments(contract_id,reference,amount,due_date) VALUES(?,?,?,?)').run(cid,ref,c.amount,due);
  const payment=db.prepare('SELECT id FROM payments WHERE contract_id=? AND reference=?').get(cid,ref);
  if(result.changes)audit(u.id,'generate_demo_charge','contracts',cid);
  return json(res,200,{payment_id:payment.id,created:!!result.changes,bank_boleto_issued:false,message:result.changes?'Cobrança demonstrativa criada. Nenhum boleto bancário foi emitido.':'Já existe uma cobrança para esta competência; abrindo demonstrativo.'});
 }
 const propertyBilling=path.match(/^\/api\/properties\/(\d+)\/billing-overview$/);
 if(propertyBilling&&method==='GET'){
  auth(u,['admin','broker']);const pid=id(propertyBilling[1]);exists('properties',pid);
  const rules=db.prepare(`SELECT b.contract_id,b.mode,b.issue_day,b.due_day,b.amount,b.late_fee_percent,b.monthly_interest_percent,b.updated_at,c.start_date,c.end_date,c.status AS contract_status,c.rent AS contract_rent,t.name AS tenant_name FROM billing_rules b JOIN contracts c ON c.id=b.contract_id LEFT JOIN people t ON t.id=c.tenant_id WHERE c.property_id=? ORDER BY c.id DESC`).all(pid);
  const charges=db.prepare(`SELECT p.id,p.contract_id,p.reference,p.amount,p.due_date,p.status,p.paid_at,p.created_at FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE c.property_id=? ORDER BY p.reference DESC,p.id DESC`).all(pid);
  return json(res,200,{rules:rules.map(r=>({...r,history:charges.filter(x=>x.contract_id===r.contract_id).map(x=>({...x,bank_boleto_issued:false,bank_status:'Integração Sicredi não configurada'}))})),bank_integration_enabled:false,notice:'Cobranças internas não equivalem a boletos Sicredi emitidos.'});
 }
 const rule=path.match(/^\/api\/contracts\/(\d+)\/billing-rule$/);
 if(rule&&method==='GET'){auth(u,['admin']);const cid=id(rule[1]);exists('contracts',cid);return json(res,200,db.prepare('SELECT * FROM billing_rules WHERE contract_id=?').get(cid)||{contract_id:cid,mode:'manual',issue_day:10,due_day:15,late_fee_percent:0,monthly_interest_percent:0,amount:db.prepare('SELECT rent FROM contracts WHERE id=?').get(cid).rent})}
 if(rule&&method==='PUT'){auth(u,['admin']);const cid=id(rule[1]),b=await body(req),c=contractData(cid);if(!c)err(404,'Contrato não encontrado');const mode=en(b.mode,['manual','automatic']),issue=num(b.issue_day,1,28),due=num(b.due_day,1,28),amount=num(b.amount,0.01,1e9),lateFee=num(b.late_fee_percent??0,0,100),interest=num(b.monthly_interest_percent??0,0,100);if(!Number.isInteger(issue)||!Number.isInteger(due))err(400,'Os dias devem ser números inteiros entre 1 e 28');db.prepare(`INSERT INTO billing_rules(contract_id,mode,issue_day,due_day,amount,late_fee_percent,monthly_interest_percent,updated_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(contract_id) DO UPDATE SET mode=excluded.mode,issue_day=excluded.issue_day,due_day=excluded.due_day,amount=excluded.amount,late_fee_percent=excluded.late_fee_percent,monthly_interest_percent=excluded.monthly_interest_percent,updated_by=excluded.updated_by,updated_at=datetime('now')`).run(cid,mode,issue,due,amount,lateFee,interest,u.id);audit(u.id,'configure_billing','contracts',cid);return json(res,200,{ok:true,bank_boleto_issued:false})}
 if(path==='/api/billing/run'&&method==='POST'){auth(u,['admin']);const generated=runRecurring();return json(res,200,{generated,bank_boleto_issued:false,message:`${generated} cobrança(s) interna(s) gerada(s). Nenhum boleto Sicredi foi emitido.`})}
 if(path==='/api/contracts'&&method==='GET'){
  if(u.role==='tenant')return json(res,200,db.prepare('SELECT c.*,p.title property_title,t.name tenant_name FROM contracts c JOIN properties p ON p.id=c.property_id LEFT JOIN people t ON t.id=c.tenant_id WHERE (c.tenant_id=? AND ? IS NOT NULL) OR EXISTS (SELECT 1 FROM user_contract_links l WHERE l.user_id=? AND l.contract_id=c.id) ORDER BY c.id DESC').all(u.person_id||-1,u.person_id,u.id));
  return json(res,200,db.prepare('SELECT c.*,p.title property_title,t.name tenant_name FROM contracts c JOIN properties p ON p.id=c.property_id LEFT JOIN people t ON t.id=c.tenant_id ORDER BY c.id DESC LIMIT 500').all());
 }
 if(path==='/api/contracts'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),property=id(b.property_id),start=date(b.start_date),end=date(b.end_date);exists('properties',property);if(end<=start)err(400,'Término deve ser posterior ao início');
  const tenantName=str(b.tenant_name||'',160,false).trim();const tenantDocument=str(b.tenant_document||'',20,false),tenantPhone=str(b.tenant_phone||'',30,false),tenantEmail=str(b.tenant_email||'',254,false);
  if(tenantDocument&&!validDocument(tenantDocument))err(400,'CPF/CNPJ inválido');if(tenantEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenantEmail))err(400,'E-mail inválido');
  if(tenantName&&tenantName.length<2)err(400,'Nome do inquilino muito curto');if(!tenantName&&(tenantDocument||tenantPhone||tenantEmail))err(400,'Informe o nome para cadastrar os contatos do inquilino');
  if(!/^\+?[\d\s().-]{0,30}$/.test(tenantPhone))err(400,'Telefone inválido');
  const feeType=en(b.admin_fee_type,['percent','fixed']),fee=num(b.admin_fee,0,1e9);if(feeType==='percent'&&fee>100)err(400,'Percentual máximo 100%');
  db.exec('BEGIN IMMEDIATE');try{let tenant=null;if(tenantName){const person=db.prepare('INSERT INTO people(name,kind,document,phone,email) VALUES(?,?,?,?,?)').run(tenantName,'tenant',tenantDocument,tenantPhone,tenantEmail);tenant=Number(person.lastInsertRowid);audit(u.id,'create','people',tenant);}const templateId=b.template_id?id(b.template_id):db.prepare('SELECT id FROM contract_templates ORDER BY id LIMIT 1').get().id;exists('contract_templates',templateId);const r=db.prepare('INSERT INTO contracts(property_id,tenant_id,start_date,end_date,rent,index_name,admin_fee_type,admin_fee,transfer_mode,status,template_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(property,tenant,start,end,num(b.rent),en(b.index_name,['IPCA','IGP-M','INPC','NONE']),feeType,fee,en(b.transfer_mode,['manual','automatic']),en(b.status,['draft','active','ended']),templateId);audit(u.id,'create','contracts',r.lastInsertRowid);db.exec('COMMIT');return json(res,201,{id:Number(r.lastInsertRowid)});}catch(e){db.exec('ROLLBACK');throw e}
 }
 const contractTemplate=path.match(/^\/api\/contracts\/(\d+)\/template$/);
 if(contractTemplate&&method==='PUT'){auth(u,['admin']);const cid=id(contractTemplate[1]),b=await body(req),tid=id(b.template_id);exists('contracts',cid);exists('contract_templates',tid);db.prepare('UPDATE contracts SET template_id=? WHERE id=?').run(tid,cid);audit(u.id,'assign_contract_template','contracts',cid);return json(res,200,{ok:true})}
 if(path==='/api/adjustments'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),cid=id(b.contract_id),rate=num(b.rate,-100,1000),reference=str(b.reference,7),source=en(b.source,['manual','automatic']);if(!/^\d{4}-\d{2}$/.test(reference))err(400,'Competência inválida');const start=b.effective_start?date(b.effective_start):null,end=b.effective_end?date(b.effective_end):null;if(start&&end&&end<start)err(400,'A data final deve ser igual ou posterior à inicial');const c=db.prepare('SELECT * FROM contracts WHERE id=?').get(cid);if(!c||c.status!=='active')err(400,'Contrato ativo não encontrado');const newRent=Math.round(c.rent*(1+rate/100)*100)/100;if(newRent<0)err(400,'Valor reajustado inválido');const r=db.prepare('INSERT INTO adjustments(contract_id,old_rent,new_rent,rate,reference,source,effective_start,effective_end) VALUES(?,?,?,?,?,?,?,?)').run(cid,c.rent,newRent,rate,reference,source,start,end);audit(u.id,'propose_adjustment','contracts',cid);return json(res,201,{id:Number(r.lastInsertRowid),new_rent:newRent});
 }
 const adj=path.match(/^\/api\/adjustments\/(\d+)\/approve$/);
 if(adj&&method==='POST'){
  auth(u,['admin']);const aid=id(adj[1]),a=db.prepare('SELECT * FROM adjustments WHERE id=?').get(aid);if(!a||a.status!=='pending')err(409,'Reajuste indisponível');db.exec('BEGIN IMMEDIATE');try{const r=db.prepare('UPDATE contracts SET rent=? WHERE id=? AND rent=?').run(a.new_rent,a.contract_id,a.old_rent);if(!r.changes)err(409,'Aluguel mudou; recalcule o reajuste');db.prepare("UPDATE adjustments SET status='approved',approved_by=?,approved_at=datetime('now') WHERE id=?").run(u.id,aid);
  if(a.source==='automatic'){
   for(const channel of ['email','whatsapp']) db.prepare('INSERT INTO adjustment_notifications(adjustment_id,channel,status) VALUES(?,?,?)').run(aid,channel,'pending_integration');
  }
  audit(u.id,'approve_adjustment','contracts',a.contract_id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return json(res,200,{ok:true});
 }
 const simulation=path==='/api/billing/simulate' && method==='POST';
 if(simulation){
  auth(u,['admin']);const b=await body(req),asOf=date(b.as_of),propertyId=id(b.property_id);exists('properties',propertyId);const day=Number(asOf.slice(8)),reference=asOf.slice(0,7);
  const eligible=db.prepare(`SELECT b.contract_id,b.amount,b.issue_day,b.due_day,c.start_date,c.end_date FROM billing_rules b JOIN contracts c ON c.id=b.contract_id WHERE c.property_id=? AND b.mode='automatic' AND c.status='active' AND b.issue_day<=? AND c.start_date<=? AND c.end_date>=?`).all(propertyId,day,asOf,asOf);
  const preview=[];let generated=0;
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const r of eligible){
    const dueMonth=r.due_day>=r.issue_day?reference:new Date(Date.UTC(Number(reference.slice(0,4)),Number(reference.slice(5,7)),1)).toISOString().slice(0,7);
    const dueDate=`${dueMonth}-${String(r.due_day).padStart(2,'0')}`;
    const existing=db.prepare('SELECT id FROM payments WHERE contract_id=? AND reference=?').get(r.contract_id,reference);
    let paymentId=existing?.id;
    if(!existing){
     const inserted=db.prepare('INSERT OR IGNORE INTO payments(contract_id,reference,amount,due_date) VALUES(?,?,?,?)').run(r.contract_id,reference,r.amount,dueDate);
     paymentId=inserted.changes?Number(inserted.lastInsertRowid):db.prepare('SELECT id FROM payments WHERE contract_id=? AND reference=?').get(r.contract_id,reference)?.id;
     if(inserted.changes){generated++;audit(u.id,'simulate_generate_demo_charge','payments',paymentId)}
    }
    preview.push({...r,reference,already_exists:!!existing,payment_id:paymentId,due_date:dueDate});
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return json(res,200,{as_of:asOf,preview,generated,bank_boleto_issued:false,notice:'Cobranças internas demonstrativas geradas. Boletos Sicredi NÃO emitidos.'});
 }
 const contractEdit=path.match(/^\/api\/contracts\/(\d+)$/);
 if(contractEdit&&method==='PATCH'){
  auth(u,['admin']);const cid=id(contractEdit[1]),b=await body(req),old=contractData(cid);if(!old)err(404,'Contrato não encontrado');
  const start=date(b.start_date),end=date(b.end_date);if(end<start)err(400,'A data final deve ser posterior à data inicial');
  const rent=num(b.rent,0,1e9),fee=num(b.admin_fee,0,1e9),feeType=en(b.admin_fee_type,['percent','fixed']);if(rent===0&&old.rent!==0)err(400,'O aluguel não pode ser zerado nesta edição');if(feeType==='percent'&&fee>100)err(400,'Taxa percentual não pode exceder 100%');
  const index=en(b.index_name,['IPCA','IGP-M','INPC','NONE']),mode=en(b.transfer_mode,['manual','automatic']),status=en(b.status,['draft','active','ended']);
  if(db.prepare('SELECT 1 FROM payments WHERE contract_id=? LIMIT 1').get(cid)&&rent!==old.rent)err(409,'Este contrato possui cobranças. Para alterar o aluguel, use o fluxo de reajuste ou aditivo.');
  if(db.prepare("SELECT 1 FROM adjustments WHERE contract_id=? AND status='approved' LIMIT 1").get(cid)&&rent!==old.rent)err(409,'Há reajustes aprovados; não é permitido sobrescrever o aluguel.');
  const tenantId=b.tenant_id===null||b.tenant_id===''||b.tenant_id===undefined?null:id(b.tenant_id);
  if(tenantId){const person=db.prepare('SELECT kind FROM people WHERE id=?').get(tenantId);if(!person||person.kind!=='tenant')err(400,'Selecione uma pessoa cadastrada como inquilino');}
  db.prepare('UPDATE contracts SET start_date=?,end_date=?,rent=?,index_name=?,admin_fee_type=?,admin_fee=?,transfer_mode=?,status=?,tenant_id=? WHERE id=?').run(start,end,rent,index,feeType,fee,mode,status,tenantId,cid);
  audit(u.id,'edit_contract','contracts',cid);return json(res,200,{ok:true,id:cid});
 }
 const chargePreview=path.match(/^\/api\/payments\/(\d+)\/charges$/);
 if(chargePreview&&method==='GET'){
  auth(u,['admin','broker','tenant']);const pid=id(chargePreview[1]);const payment=db.prepare('SELECT p.*,c.tenant_id,b.late_fee_percent,b.monthly_interest_percent FROM payments p JOIN contracts c ON c.id=p.contract_id LEFT JOIN billing_rules b ON b.contract_id=c.id WHERE p.id=?').get(pid);
  if(!payment)err(404,'Cobrança não encontrada');if(u.role==='tenant'&&!tenantContractAllowed(u,payment.contract_id,payment.tenant_id))err(403,'Acesso não autorizado');
  const requested=new URL(req.url,'http://localhost').searchParams.get('as_of');const today=requested?(auth(u,['admin']),date(requested)):new Date().toISOString().slice(0,10);return json(res,200,{payment_id:pid,principal:payment.amount,due_date:payment.due_date,as_of:today,...lateCharges(payment.amount,payment.due_date,payment.status==='paid'?(payment.paid_at||today).slice(0,10):today,payment.late_fee_percent||0,payment.monthly_interest_percent||0),notice:'Simulação de encargos; não há atualização bancária nem cobrança automática dos acréscimos'});
 }
 if(path==='/api/payments'&&method==='GET'){
  if(u.role==='tenant')return json(res,200,db.prepare('SELECT p.*,c.property_id,pr.title property_title FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN properties pr ON pr.id=c.property_id WHERE (c.tenant_id=? AND ? IS NOT NULL) OR EXISTS (SELECT 1 FROM user_contract_links l WHERE l.user_id=? AND l.contract_id=c.id) ORDER BY p.id DESC').all(u.person_id||-1,u.person_id,u.id));
  return json(res,200,db.prepare('SELECT p.*,c.property_id,pr.title property_title FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN properties pr ON pr.id=c.property_id ORDER BY p.id DESC LIMIT 500').all());
 }
 if(path==='/api/payments'&&method==='POST'){
  auth(u,['admin']);const b=await body(req),cid=id(b.contract_id);exists('contracts',cid);if(b.provider==='sicredi')err(503,'Emissão Sicredi indisponível: credenciais e homologação bancária pendentes. Nenhum boleto foi gerado');const r=db.prepare('INSERT INTO payments(contract_id,reference,amount,due_date) VALUES(?,?,?,?)').run(cid,str(b.reference,7),num(b.amount,0.01),date(b.due_date));audit(u.id,'create','payments',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)});
 }
 const paid=path.match(/^\/api\/payments\/(\d+)\/confirm$/);
 if(paid&&method==='POST'){
  auth(u,['admin']);const pid=id(paid[1]);const p=db.prepare('SELECT p.*,c.admin_fee_type,c.admin_fee,c.transfer_mode,pr.ownership FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN properties pr ON pr.id=c.property_id WHERE p.id=?').get(pid);if(!p)err(404,'Pagamento não encontrado');if(p.status==='paid')err(409,'Pagamento já confirmado');
  db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE payments SET status='paid',paid_at=datetime('now') WHERE id=?").run(pid);if(p.ownership==='third'){const fee=p.admin_fee_type==='percent'?p.amount*p.admin_fee/100:p.admin_fee;const amount=Math.max(0,Math.round((p.amount-fee)*100)/100);db.prepare('INSERT INTO transfers(payment_id,amount,status) VALUES(?,?,?)').run(pid,amount,'awaiting_approval')}audit(u.id,'confirm','payments',pid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return json(res,200,{ok:true,notice:'Pagamento confirmado manualmente; não houve consulta bancária'});
 }
 if(path==='/api/transfers'&&method==='GET'){auth(u,['admin']);return json(res,200,db.prepare('SELECT t.*,p.reference,pr.title property_title,c.transfer_mode FROM transfers t JOIN payments p ON p.id=t.payment_id JOIN contracts c ON c.id=p.contract_id JOIN properties pr ON pr.id=c.property_id ORDER BY t.id DESC').all())}
 const approve=path.match(/^\/api\/transfers\/(\d+)\/approve$/);
 if(approve&&method==='POST'){auth(u,['admin']);const tid=id(approve[1]);const r=db.prepare("UPDATE transfers SET status='approved',approved_by=?,approved_at=datetime('now') WHERE id=? AND status='awaiting_approval'").run(u.id,tid);if(!r.changes)err(409,'Repasse não está aguardando aprovação');audit(u.id,'approve','transfers',tid);return json(res,200,{ok:true})}
 const transferPaid=path.match(/^\/api\/transfers\/(\d+)\/mark-paid$/);
 if(transferPaid&&method==='POST'){auth(u,['admin']);const tid=id(transferPaid[1]);const r=db.prepare("UPDATE transfers SET status='paid',paid_at=datetime('now') WHERE id=? AND status='approved'").run(tid);if(!r.changes)err(409,'Aprove antes de registrar o repasse');audit(u.id,'mark_paid','transfers',tid);return json(res,200,{ok:true,notice:'Registro manual, sem transferência bancária'})}
 if(path==='/api/inspections'&&method==='GET'){auth(u,['admin','broker']);return json(res,200,db.prepare('SELECT i.*,p.title property_title,u.name author FROM inspections i JOIN properties p ON p.id=i.property_id JOIN users u ON u.id=i.created_by ORDER BY i.id DESC LIMIT 500').all())}
 if(path==='/api/inspections'&&method==='POST'){auth(u,['admin','broker']);const b=await body(req),pid=id(b.property_id);exists('properties',pid);const r=db.prepare('INSERT INTO inspections(property_id,kind,notes,created_by) VALUES(?,?,?,?)').run(pid,en(b.kind,['entry','exit']),str(b.notes,5000),u.id);audit(u.id,'create','inspections',r.lastInsertRowid);return json(res,201,{id:Number(r.lastInsertRowid)})}
 if(path==='/api/audit'&&method==='GET'){auth(u,['admin']);return json(res,200,db.prepare('SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 200').all())}
 err(404,'Rota não encontrada');
};
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');const path=url.pathname;
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 if(path==='/healthz'&&req.method==='GET')return json(res,200,{status:'ok'});
 if(path.startsWith('/api/'))return await routes(req,res,path,req.method,user(req));
 if(req.method!=='GET')err(405,'Método não permitido');
 const file=path==='/'?'index.html':path.slice(1);if(!['index.html','app.js','style.css'].includes(file))err(404,'Arquivo não encontrado');
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-store'});res.end(await readFile(join(ROOT,file)));
 }catch(e){if(e.code?.startsWith('SQLITE_CONSTRAINT'))return json(res,409,{error:'Registro duplicado ou relacionamento inválido'});console.error(e.status?e.message:e);json(res,e.status||500,{error:e.status?e.message:'Erro interno'})}});
try{console.log('Cobranças internas recorrentes geradas:',runRecurring())}catch(e){console.error('Erro na rotina recorrente:',e)}
const billingTimer=setInterval(()=>{try{runRecurring()}catch(e){console.error('Erro na rotina recorrente:',e)}},6*60*60*1000);billingTimer.unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Fontanezzi iniciado na porta ${PORT}`));
