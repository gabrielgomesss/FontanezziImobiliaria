import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('PDF uses exact font metrics rather than character-count spacing',()=>{assert.match(server,/PDF_FONT_WIDTHS/);assert.match(server,/measure\(t\.s,size,t\.b\)/);assert.doesNotMatch(server,/token\.text\.length\*size\*/)});
test('CEP lookup uses authenticated fixed-provider backend with timeouts',()=>{assert.match(server,/auth\(u,\['admin','broker'\]\)/);assert.match(server,/AbortSignal\.timeout\(4500\)/);assert.match(app,/api\('\/cep\/'\+v\)/);assert.doesNotMatch(app,/fetch\('https:\/\/viacep/)});
