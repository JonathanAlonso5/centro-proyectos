import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,writeFileSync,renameSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {sqliteBinding} from './sqlite.mjs';
import {remoteBinding} from './remote.mjs';
import {RequestGate} from './gate.mjs';
import {createApplication} from './app.mjs';
import {tables,importSnapshot,freezeStatements,unfreezeStatements,activateLocal} from './migrate.mjs';
const root=new URL('../',import.meta.url).pathname;
const data=process.env.CDP_DATA_DIR??join(root,'data');mkdirSync(data,{recursive:true,mode:0o700});
const file=join(data,'cdp.sqlite');const flag=join(data,'active-local');const gate=new RequestGate();
const secret=process.env.MCP_SECRET??process.env.CDP_SECRET;if(!secret)throw Error('Falta MCP_SECRET');
function same(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y)}
let mode=existsSync(flag)||process.env.CDP_MODE==='sqlite'?'sqlite':'remote';
function local(){if(!existsSync(file))throw Error('Falta la base SQLite activa; no crear una vacía');const sql=new DatabaseSync(file);if(sql.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||sql.prepare('PRAGMA foreign_key_check').all().length)throw Error('Base SQLite no íntegra');for(const table of tables)sql.prepare(`SELECT * FROM ${table} LIMIT 0`).all();sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');return sqliteBinding(sql)}
const env={...process.env,CDP_ORIGIN:undefined,MCP_SECRET:secret,CDP:mode==='sqlite'?local():remoteBinding({account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,database:'7c8cca0e-e507-458c-b650-bf8617f654bf'})};
// Si el proceso cayó antes del marcador, ninguna escritura local fue admitida.
// Recuperar el origen antes de servir; nunca volver a D1 si existe el marcador.
if(mode==='remote') {
 const frozen=await env.CDP.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'cdp_vps_freeze_%'").all();
 if(frozen.results.length){
  const {rmSync}=await import('node:fs');for(const partial of [file,file+'-wal',file+'-shm',join(data,'candidate.sqlite'),flag+'.new'])rmSync(partial,{force:true});
  await env.CDP.query({batch:unfreezeStatements()});console.log('Migración incompleta recuperada: D1 vuelve a ser el origen');
 }
}
const app=await createApplication(env,{publicDir:join(root,'public')});
const origins=new Set(['https://cdp.friday-imperio.com','https://centro-proyectos.pages.dev']);
const pending=new Set();let stopping=false;
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
async function migrate(){return gate.exclusive(async()=>{
 if(mode!=='remote')throw Error('Ya usa SQLite');
 const origin=env.CDP;
 try {
  await origin.query({batch:freezeStatements()});
  const result=await origin.query({batch:tables.map(t=>({sql:`SELECT * FROM ${t}`}))});
  const snapshot=Object.fromEntries(tables.map((t,i)=>[t,result[i].results]));
  const stamp=new Date().toISOString().replaceAll(':','-');const backup=join(data,'backups');mkdirSync(backup,{recursive:true,mode:0o700});
  writeFileSync(join(backup,`d1-${stamp}.json`),JSON.stringify(snapshot),{mode:0o600,flush:true});
  const candidate=join(data,'candidate.sqlite');const evidence=importSnapshot(snapshot,candidate);
  const report={fecha:new Date().toISOString(),tables:evidence,source:'D1',destination:'SQLite',requestsHeld:true,sourceReadOnly:true};writeFileSync(join(data,'migration.json'),JSON.stringify(report,null,2),{mode:0o600,flush:true});
  activateLocal({file,flag,candidate,env,open:()=>local()});mode='sqlite';return report;
 }catch(e){if(existsSync(flag)){stopping=true;setImmediate(()=>process.exit(1))}else await origin.query({batch:unfreezeStatements()});throw e}

})}
async function handle(req){
 if(stopping)return json({error:'servicio recuperándose'},503);
 const host=req.headers.host??'';const localHost=/^(127\.0\.0\.1|localhost):\d+$/.test(host);
 if(!localHost&&!['cdp.friday-imperio.com','centro-proyectos.pages.dev'].includes(host))return new Response('Host no permitido',{status:421});
 const url=new URL(req.url,localHost?'http://'+host:'https://'+host);
 if(url.pathname==='/healthz')return json({ok:true,database:mode});
 if(url.pathname.startsWith('/admin/')){
  if(!localHost||req.headers['cf-connecting-ip']||req.headers['x-cdp-proxy']||!same(req.headers.authorization,'Bearer '+secret))return json({error:'sin acceso'},403);
  if(url.pathname==='/admin/migrate'&&req.method==='POST')return json(await migrate());
  return new Response('No existe',{status:404});
 }
 return gate.run(async()=>{
  if(stopping)return json({error:'servicio recuperándose'},503);
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8*1024*1024)return json({error:'petición demasiado grande'},413);chunks.push(chunk)}
  const headers=new Headers();for(const [key,value] of Object.entries(req.headers)){if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value)}
  const legacy=req.headers['x-cdp-origin'];if(legacy){if(!same(req.headers['x-cdp-proxy'],secret)||!origins.has(legacy))return json({error:'puente no autorizado'},403);url.protocol='https:';url.host=new URL(legacy).host;url.port=''}
  headers.delete('x-cdp-origin');headers.delete('x-cdp-proxy');headers.delete('host');
  return app(new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
 })
}
const server=http.createServer((req,res)=>{
 const operation=(async()=>{try{const response=await handle(req);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body&&req.method!=='HEAD')await pipeline(Readable.fromWeb(response.body),res);else res.end()}catch(e){console.error('Fallo CdP:',e.message);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'no se ha podido completar la operación'}))}})();pending.add(operation);operation.finally(()=>pending.delete(operation));
});server.requestTimeout=60000;server.headersTimeout=15000;
const port=Number(process.env.CDP_PORT??7430);server.listen(port,'127.0.0.1',()=>console.log(`CdP escuchando en 127.0.0.1:${port}, base ${mode}`));
async function stop(){server.close();await Promise.allSettled([...pending]);if(mode==='sqlite')env.CDP.sql.close();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
