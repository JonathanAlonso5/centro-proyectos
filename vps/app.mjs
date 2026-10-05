import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const allowed=new Set(['/','/index.html','/entrar.html','/manifest.json','/pwa-init.js','/sw.js','/icons/icon-192.png','/icons/icon-512.png','/icons/icon.svg']);
let shared;
async function handlers(){if(!shared)shared=(async()=>{const b=await build({entryPoints:[new URL('handlers.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});const target=new URL('../.runtime/handlers-'+createHash('sha256').update(b.outputFiles[0].text).digest('hex').slice(0,16)+'.mjs',import.meta.url);await mkdir(new URL('../.runtime/',import.meta.url),{recursive:true});await writeFile(target,b.outputFiles[0].text);return import(target.href)})();return shared}
export async function createApplication(env,{publicDir}){
 const h=await handlers();
 return async request=>{
  const url=new URL(request.url);
  const next=async(rewritten=request)=>{
   const path=new URL(rewritten.url).pathname;
   const context={request:rewritten,env,params:{ruta:path.slice(5).split('/').filter(Boolean)},waitUntil:p=>p.catch(()=>console.error('Fallo en operación diferida CdP'))};
   if(path==='/mcp'){const fn=h.mcp['onRequest'+rewritten.method[0]+rewritten.method.slice(1).toLowerCase()];return fn?fn(context):new Response('Método no permitido',{status:405})}
   if(path.startsWith('/api/'))return h.api(context);
   if(!['GET','HEAD'].includes(rewritten.method)||!allowed.has(path))return new Response('No existe',{status:404});
   const asset=path==='/'?'/index.html':path;
   try{return new Response(rewritten.method==='HEAD'?null:await readFile(join(publicDir,asset)),{headers:{'Content-Type':types[asset.slice(asset.lastIndexOf('.'))]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'}})}catch(e){if(e.code==='ENOENT')return new Response('No existe',{status:404});throw e}
  };
  return h.middleware({request,env,params:{},next});
 };
}
