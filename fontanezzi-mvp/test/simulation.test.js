import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('simulação gera cobrança demonstrativa na tabela sem duplicar e sem confirmar pagamento',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'fontanezzi-simulation-'));
 const port=44000+Math.floor(Math.random()*1000);
 const proc=spawn(process.execPath,[resolve('server.js')],{cwd,env:{...process.env,PORT:String(port),ADMIN_PASSWORD:'TesteSenhaSegura123!'},stdio:'ignore'});
 try{
  const base=`http://localhost:${port}/api`;
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base+'/public/properties')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.ok(ready);
  const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@fontanezzi.local',password:'TesteSenhaSegura123!'})});
  assert.equal(login.status,200);
  const user=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const req=async(path,method='GET',data)=>{const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':user.csrf,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});return [r.status,await r.json()]};
  const [,p]=await req('/properties','POST',{title:'Casa Simulação',address:'Rua A',city:'Santo André',type:'Casa',purpose:'rent',ownership:'own',rent:1000,status:'rented',published:false});
  const [,c]=await req('/contracts','POST',{property_id:p.id,tenant_name:'Locatário',start_date:'2026-01-01',end_date:'2030-12-31',rent:1000,index_name:'IPCA',admin_fee_type:'percent',admin_fee:5,transfer_mode:'manual',status:'active'});
  assert.equal((await req('/contracts/'+c.id+'/billing-rule','PUT',{mode:'automatic',issue_day:2,due_day:15,amount:1000}))[0],200);
  const [code,first]=await req('/billing/simulate','POST',{as_of:'2027-11-02',property_id:p.id});
  assert.equal(code,200);assert.equal(first.generated,1);assert.equal(first.bank_boleto_issued,false);
  const [,second]=await req('/billing/simulate','POST',{as_of:'2027-11-02',property_id:p.id});
  assert.equal(second.generated,0);assert.equal(second.preview[0].already_exists,true);
  const [,detail]=await req('/properties/'+p.id+'/details');
  const matching=detail.payments.filter(x=>x.contract_id===c.id&&x.reference==='2027-11');
  assert.equal(matching.length,1);assert.equal(matching[0].status,'pending');assert.equal(matching[0].due_date,'2027-11-15');
  const [demoStatus,demo]=await req('/payments/'+matching[0].id+'/demo-boleto');
  assert.equal(demoStatus,200);assert.equal(demo.bank_boleto_issued,false);
 }finally{proc.kill();await rm(cwd,{recursive:true,force:true})}
});
