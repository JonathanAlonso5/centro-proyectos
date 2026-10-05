import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sqliteBinding} from '../vps/sqlite.mjs';
import {RequestGate} from '../vps/gate.mjs';

test('SQLite adapta first/all/run y batch atómico, con relaciones y búsqueda reales',async()=>{
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema/0001_nodos.sql',import.meta.url),'utf8'));const db=sqliteBinding(sql);
 await db.prepare("INSERT INTO nodes(id,tipo,titulo,creado,modificado) VALUES(?,?,?,?,?)").bind('P-001','proyecto','Migración fiable','fecha','fecha').run();
 assert.equal((await db.prepare('SELECT titulo FROM nodes WHERE id=?').bind('P-001').first('titulo')),'Migración fiable');
 assert.equal((await db.prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'fiable'").all()).results.length,1);
 await assert.rejects(db.batch([db.prepare("INSERT INTO etiquetas VALUES(?,?)").bind('P-001','a'),db.prepare("INSERT INTO etiquetas VALUES(?,?)").bind('P-001','a')]));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM etiquetas').first()).n,0);
});
test('cambio de base espera escrituras activas y deja en espera las nuevas',async()=>{
 const g=new RequestGate();let desbloquear;let base='D1';const eventos=[];
 const primera=g.run(async()=>{eventos.push(base);await new Promise(r=>desbloquear=r);eventos.push(base)});
 const cambio=g.exclusive(async()=>{eventos.push('copiar');base='SQLite'});
 const segunda=g.run(async()=>eventos.push(base));
 await Promise.resolve();assert.deepEqual(eventos,['D1']);desbloquear();await Promise.all([primera,cambio,segunda]);assert.deepEqual(eventos,['D1','D1','copiar','SQLite']);
});
test('una migración fallida libera la espera conservando el origen',async()=>{
 const g=new RequestGate();await assert.rejects(g.exclusive(async()=>{throw Error('fallo copia')}));assert.equal(await g.run(async()=>42),42);
});

test('importación conserva cada campo, enlaces, etiquetas y búsqueda',async()=>{
 const {importSnapshot}=await import('../vps/migrate.mjs');const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const dir=mkdtempSync(new URL('../.runtime/copia-',import.meta.url).pathname);const path=join(dir,'prueba.sqlite');
 const node={id:'N-001',tipo:'nota',titulo:'Memoria migrada',cuerpo:'Información ágil',estado:null,proyecto:null,orden:2.5,extra:'{"nulo":null}',agente:'codex',ejecucion:null,creado:'fecha',modificado:'fecha',archivado:0,huella:'huella'};
 const evidence=importSnapshot({nodes:[node],links:[],etiquetas:[{nodo:'N-001',etiqueta:'referencia'}],meta:[{clave:'version',valor:'preservar'}]},path);assert.equal(evidence.nodes.rows,1);const sql=new DatabaseSync(path);assert.equal(sql.prepare("SELECT COUNT(*) n FROM nodes_fts WHERE nodes_fts MATCH 'agil'").get().n,1);sql.close();rmSync(dir,{recursive:true});
});

test('barrera D1 impide escrituras incluso desde una versión antigua y se puede retirar',async()=>{
 const {freezeStatements,unfreezeStatements}=await import('../vps/migrate.mjs');const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema/0001_nodos.sql',import.meta.url),'utf8'));
 for(const s of freezeStatements())sql.exec(s.sql);assert.throws(()=>sql.exec("INSERT INTO meta VALUES('version','antigua')"),/trasladado/);for(const s of unfreezeStatements())sql.exec(s.sql);sql.exec("INSERT INTO meta VALUES('version','actual')");assert.equal(sql.prepare('SELECT valor FROM meta').get().valor,'actual');sql.close();
});
test('fallo al persistir activación conserva origen y elimina copia no activada',async()=>{
 const {activateLocal}=await import('../vps/migrate.mjs');const fs=await import('node:fs');const dir=fs.mkdtempSync(new URL('../.runtime/activar-',import.meta.url).pathname);const candidate=dir+'/candidate.sqlite';new DatabaseSync(candidate).close();const env={CDP:'D1'};
 assert.throws(()=>activateLocal({file:dir+'/cdp.sqlite',flag:dir+'/active-local',candidate,open:file=>({sql:new DatabaseSync(file)}),env,persist:()=>{throw Error('Disco lleno')}}),/Disco lleno/);assert.equal(env.CDP,'D1');assert.equal(fs.existsSync(dir+'/cdp.sqlite'),false);fs.rmSync(dir,{recursive:true});
});

test('fallo posterior al marcador exige reinicio y conserva base activada',async()=>{
 const {activateLocal}=await import('../vps/migrate.mjs');const fs=await import('node:fs');const dir=fs.mkdtempSync(new URL('../.runtime/activar-',import.meta.url).pathname);const candidate=dir+'/candidate.sqlite';new DatabaseSync(candidate).close();const flag=dir+'/active-local';const env={CDP:'D1'};
 assert.throws(()=>activateLocal({file:dir+'/cdp.sqlite',flag,candidate,open:file=>({sql:new DatabaseSync(file)}),env,sync:path=>{if(path===flag)throw Error('fsync falló')}}),e=>e.code==='CDP_ACTIVATION_COMMITTED');assert.equal(fs.existsSync(flag),true);assert.equal(fs.existsSync(dir+'/cdp.sqlite'),true);fs.rmSync(dir,{recursive:true});
});
