import http from 'node:http';import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';import {once} from 'node:events';
const root=new URL('../',import.meta.url).pathname;mkdirSync(root+'.runtime',{recursive:true});
test('HTTP real: cambio D1→SQLite, proxy antiguo, bloqueo del origen y reinicio sin pérdida',async()=>{
 const dir=mkdtempSync(root+'.runtime/http-');const source=dir+'/remote.sqlite';const initial=new DatabaseSync(source);initial.exec(readFileSync(root+'schema/0001_nodos.sql','utf8'));initial.close();
 let child;const start=async()=>{child=spawn(process.execPath,['--no-warnings','--import',root+'tests/remote-fixture.mjs',root+'vps/server.mjs'],{env:{...process.env,MCP_SECRET:'local-test',CDP_PORT:'7432',CDP_DATA_DIR:dir+'/local',CDP_TEST_SOURCE:source,CLOUDFLARE_ACCOUNT_ID:'fixture',CLOUDFLARE_API_TOKEN:'fixture'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(errors||'Servidor terminado')})])};
 const stop=async()=>{child.kill('SIGTERM');await once(child,'exit')};
 const rpc=async(name,args,extra={})=>{const r=await fetch('http://127.0.0.1:7432/mcp',{method:'POST',headers:{Authorization:'Bearer local-test','Content-Type':'application/json',...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const b=await r.json();assert.equal(r.status,200);assert.equal(b.result?.isError,undefined,JSON.stringify(b));return JSON.parse(b.result.content[0].text)};
 try {
  await start();const p=await rpc('cdp_create_project',{nombre:'Migración real',estado:'pausado'});
  const publicStatus=await new Promise((resolve,reject)=>{const request=http.request('http://127.0.0.1:7432/admin/migrate',{method:'POST',headers:{Host:'cdp.friday-imperio.com',Authorization:'Bearer local-test'}},r=>{r.resume();resolve(r.statusCode)});request.on('error',reject);request.end()});assert.equal(publicStatus,403);
  const m=await fetch('http://127.0.0.1:7432/admin/migrate',{method:'POST',headers:{Authorization:'Bearer local-test'}});assert.equal(m.status,200);const evidence=await m.json();assert.ok(evidence.tables.meta);assert.equal(evidence.sourceReadOnly,true);
  const sourceDb=new DatabaseSync(source);assert.throws(()=>sourceDb.exec("INSERT INTO meta VALUES('prohibido','cambio')"),/trasladado/);sourceDb.close();
  const legacy={'x-cdp-origin':'https://centro-proyectos.pages.dev','x-cdp-proxy':'local-test'};
  await rpc('cdp_update_project',{id:p.id,proximoPaso:'Cambio posterior'},legacy);assert.equal((await rpc('cdp_get_project',{id:p.id})).proximoPaso,'Cambio posterior');
  await stop();await start();assert.equal((await rpc('cdp_get_project',{id:p.id},legacy)).proximoPaso,'Cambio posterior');assert.equal((await (await fetch('http://127.0.0.1:7432/healthz')).json()).database,'sqlite');
  const oldmeta=await (await fetch('http://127.0.0.1:7432/.well-known/oauth-authorization-server',{headers:legacy})).json();assert.equal(oldmeta.issuer,'https://centro-proyectos.pages.dev');
 }finally{if(child?.exitCode===null)await stop();rmSync(dir,{recursive:true,force:true})}
});

test('marcador sin base activa falla cerrado y jamás crea SQLite vacía',async()=>{
 const fs=await import('node:fs');const dir=mkdtempSync(root+'.runtime/sin-base-');fs.writeFileSync(dir+'/active-local','SQLite');
 const child=spawn(process.execPath,['--no-warnings',root+'vps/server.mjs'],{env:{...process.env,MCP_SECRET:'local-test',CDP_PORT:'7433',CDP_DATA_DIR:dir},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',d=>error+=d);const [code]=await once(child,'exit');assert.notEqual(code,0);assert.match(error,/Falta la base SQLite activa/);assert.equal(fs.existsSync(dir+'/cdp.sqlite'),false);rmSync(dir,{recursive:true});
});
