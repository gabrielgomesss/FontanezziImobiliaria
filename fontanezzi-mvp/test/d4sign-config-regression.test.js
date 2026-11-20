import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('D4Sign is the supported signature configuration provider',()=>{
 assert.match(server,/d4sign:\['account_uuid','safe_uuid'\]/);
 assert.match(server,/d4sign:'token_api'/);
 assert.match(server,/sicredi\|canalpro\|d4sign\|whatsapp\|email/);
 assert.match(app,/\['d4sign','D4Sign'/);
 assert.doesNotMatch(server+app,/docusign/i);
});
test('Signature dispatch remains explicitly unavailable without API integration',()=>{
 assert.match(app,/D4Sign ainda não está conectada/);
 assert.match(server,/Conexão externa não implementada nem validada/);
});
