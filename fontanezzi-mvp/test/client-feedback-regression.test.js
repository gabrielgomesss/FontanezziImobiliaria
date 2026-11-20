import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('migrações incrementais e vinculação de proprietários',()=>{
 for(const field of ['complement','rg','nationality','profession','contract_owners','guarantee_details'])assert.ok(server.includes(field),field);
 assert.match(server,/PRAGMA table_info/);
 assert.match(server,/contractOwners\(cid\)/);
});
test('contratos acessíveis pelo menu e modelo comercial parametrizado',()=>{
 assert.match(app,/\['contracts','▤','Contratos'\]/);
 assert.match(app,/data-contract=/);
 assert.match(app,/tenant_profession/);
 assert.match(app,/owner_ids/);
 assert.match(server,/Locação comercial — Fontanezzi/);
 for(const variable of ['qualificacao_proprietarios','qualificacao_locatarios','endereco_completo','garantia','vencimento'])assert.ok(server.includes('{{'+variable+'}}'),variable);
});
