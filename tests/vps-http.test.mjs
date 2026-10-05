import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sqliteBinding} from '../vps/sqlite.mjs';
import {createApplication} from '../vps/app.mjs';
const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema/0001_nodos.sql',import.meta.url),'utf8'));
const app=await createApplication({CDP:sqliteBinding(sql),MCP_SECRET:'prueba'},{publicDir:new URL('../public/',import.meta.url).pathname});
const req=(p,options={})=>app(new Request('https://cdp.friday-imperio.com'+p,options));
test('VPS conserva autenticación, metadatos OAuth y contratos MCP',async()=>{
 assert.equal((await req('/api/estado')).status,401);
 const meta=await (await req('/.well-known/oauth-authorization-server')).json();assert.equal(meta.issuer,'https://cdp.friday-imperio.com');
 const response=await req('/mcp',{method:'POST',headers:{Authorization:'Bearer prueba','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'cdp_create_project',arguments:{nombre:'Prueba VPS',estado:'pausado'}}})});assert.equal(response.status,200);const r=await response.json();assert.ok(r.result);assert.equal(r.result.isError,undefined);
 assert.equal((await req('/api/estado',{headers:{Authorization:'Bearer prueba'}})).status,200);
});
test('VPS permite únicamente assets publicados y nunca datos, backup ni código',async()=>{
 assert.equal((await req('/')).status,200);
 for(const p of ['/scripts/memoria.sql','/data/cdp.sqlite','/vps/server.mjs','/.env','/icons/../index.html','/icons/%2e%2e%2fdata/cdp.sqlite']) {const r=await req(p);if(p.includes('/icons/../'))continue;assert.equal(r.status,404,p)}
 assert.match((await req('/icons/icon-192.png')).headers.get('Content-Type'),/image\/png/);
});
