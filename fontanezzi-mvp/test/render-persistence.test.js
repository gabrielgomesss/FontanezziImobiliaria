import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('Render: saúde, cookie seguro e dados persistentes após reinício',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'fontanezzi-render-'));
 const dataDir=join(temp,'volume');
 const port=46000+Math.floor(Math.random()*1000);
 const base=`http://127.0.0.1:${port}`;
 let proc;
 const boot=async()=>{
  proc=spawn(process.execPath,[resolve('server.js')],{
   cwd:temp,env:{...process.env,PORT:String(port),NODE_ENV:'production',ADMIN_PASSWORD:'TesteSenhaSegura123!',FONTANEZZI_DATA_DIR:dataDir},stdio:'ignore'
  });
  for(let i=0;i<80;i++){
   if(proc.exitCode!==null)throw Error('Servidor encerrou antes de iniciar');
   try{if((await fetch(base+'/healthz')).status===200)return}catch{}
   await sleep(100);
  }
  throw Error('Servidor não iniciou');
 };
 const stop=async()=>{if(!proc||proc.exitCode!==null)return;const p=proc;await new Promise(resolve=>{p.once('exit',resolve);p.kill();setTimeout(()=>{if(p.exitCode===null)p.kill('SIGKILL')},1500).unref()})};
 try{
  await boot();
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@fontanezzi.local',password:'TesteSenhaSegura123!'})});
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/; Secure/);
  const session=await login.json();
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const created=await fetch(base+'/api/people',{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({name:'Persistência de teste',kind:'other'})});
  assert.equal(created.status,201);
  await stat(join(dataDir,'fontanezzi.sqlite'));
  await stop();
  await boot();
  const login2=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@fontanezzi.local',password:'TesteSenhaSegura123!'})});
  assert.equal(login2.status,200);
  const cookie2=login2.headers.get('set-cookie').split(';')[0];
  const people=await fetch(base+'/api/people',{headers:{Cookie:cookie2}});
  assert.equal(people.status,200);
  assert.ok((await people.json()).some(p=>p.name==='Persistência de teste'));
 }finally{await stop();await rm(temp,{recursive:true,force:true})}
});
