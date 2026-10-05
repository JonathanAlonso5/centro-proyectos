import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { actualizarNodo } from '../functions/lib/db.ts';

function base() {
 const sql = new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,tipo TEXT,titulo TEXT,cuerpo TEXT,estado TEXT,proyecto TEXT,orden REAL,extra TEXT,agente TEXT,ejecucion TEXT,creado TEXT,modificado TEXT,archivado INTEGER,huella TEXT); CREATE TABLE etiquetas(nodo TEXT,etiqueta TEXT);`);
 sql.prepare('INSERT INTO nodes(id,tipo,titulo,cuerpo,extra,modificado) VALUES(?,?,?,?,?,?)').run('P-001','proyecto','Inicial','Cuerpo',JSON.stringify({progreso:10,proximoPaso:'Inicial',conservar:null,anidado:{a:1,b:2}}),'inicio');
 const db = { prepare(query) { let args=[];return {bind(...x){args=x;return this},async first(){return sql.prepare(query).get(...args)??null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:r.changes}}}}}};
 return {sql,db};
}
test('guardados concurrentes conservan campos extra ajenos y null/objetos completos',async()=>{
 const {db}=base();
 await Promise.all([actualizarNodo(db,'P-001',{extra:{progreso:80}}),actualizarNodo(db,'P-001',{extra:{proximoPaso:'Nuevo',anidado:{a:3},nulo:null}})]);
 const n=await db.prepare('SELECT extra FROM nodes').first();
 assert.deepEqual(JSON.parse(n.extra),{progreso:80,proximoPaso:'Nuevo',conservar:null,anidado:{a:3},nulo:null});
});
test('ediciones concurrentes mantienen huella de titulo/cuerpo finales',async()=>{
 const {db}=base();
 await Promise.all([actualizarNodo(db,'P-001',{titulo:'Nuevo'}),actualizarNodo(db,'P-001',{cuerpo:'Otro'})]);
 const n=await db.prepare('SELECT * FROM nodes').first();
 const {huellaDe}=await import('../functions/lib/db.ts');
 assert.equal(n.huella,await huellaDe(n.titulo+'\n'+n.cuerpo));
});
