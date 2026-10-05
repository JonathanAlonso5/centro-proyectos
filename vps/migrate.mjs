import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,chmodSync,existsSync,rmSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
function syncDirectory(path){const fd=openSync(dirname(path),'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
export const tables=['nodes','links','etiquetas','meta'];
export function fingerprint(rows){return createHash('sha256').update(JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')}
export function importSnapshot(snapshot,path){
 if(existsSync(path))throw Error('El destino ya existe; no sobrescribir');
 const sql=new DatabaseSync(path);
 try {
  sql.exec(readFileSync(new URL('../schema/0001_nodos.sql',import.meta.url),'utf8'));
  sql.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  for(const table of tables){for(const row of snapshot[table]){const columns=Object.keys(row);if(columns.some(c=>!/^[a-z_]+$/.test(c)))throw Error('Columna inválida');sql.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]))}}
  sql.exec('COMMIT; PRAGMA foreign_keys=ON;');
  if(sql.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||sql.prepare('PRAGMA foreign_key_check').all().length)throw Error('Integridad no válida');
  sql.exec("INSERT INTO nodes_fts(nodes_fts,rank) VALUES('integrity-check',1)");
  const evidence={};for(const table of tables){const rows=sql.prepare(`SELECT * FROM ${table}`).all();if(fingerprint(rows)!==fingerprint(snapshot[table]))throw Error('Contenido diferente: '+table);evidence[table]={rows:rows.length,sha256:fingerprint(rows)}}
  sql.close();chmodSync(path,0o600);return evidence;
 }catch(e){try{sql.close()}catch{};rmSync(path,{force:true});throw e}
}

export function freezeStatements(){return tables.flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>({sql:`CREATE TRIGGER IF NOT EXISTS cdp_vps_freeze_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'CdP trasladado al VPS: usar cdp.friday-imperio.com'); END`,params:[]})))}
export function unfreezeStatements(){return tables.flatMap(table=>['insert','update','delete'].map(operation=>({sql:`DROP TRIGGER IF EXISTS cdp_vps_freeze_${table}_${operation}`,params:[]})))}
export function activateLocal({file,flag,candidate,open,env,persist=writeFileSync,sync=syncDirectory}){
 if(existsSync(file))throw Error('Ya existe la base local; requiere recuperación explícita');
 renameSync(candidate,file);sync(file);let binding;
 try{binding=open(file);persist(flag+'.new','SQLite\n',{mode:0o600,flush:true});renameSync(flag+'.new',flag);sync(flag);env.CDP=binding;return binding}
 catch(e){binding?.sql?.close();rmSync(flag+'.new',{force:true});if(!existsSync(flag)){rmSync(file,{force:true});throw e}const error=new Error('Activación persistida: reinicio necesario',{cause:e});error.code='CDP_ACTIVATION_COMMITTED';throw error}
}
