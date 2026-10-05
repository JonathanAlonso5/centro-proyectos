import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
const r=await build({entryPoints:['functions/_middleware.ts'],bundle:true,format:'esm',platform:'node',write:false});
mkdirSync('.wrangler/test',{recursive:true});writeFileSync('.wrangler/test/middleware.mjs',r.outputFiles[0].text);
const {onRequest}=await import('../.wrangler/test/middleware.mjs');
test('no se sirven ficheros privados ni aunque exista caché de una versión antigua',async()=>{
 for(const p of ['/scripts/memoria.sql','/scripts/instantanea-drive.json','/dev/wrangler.jsonc','/package.json']){
  const r=await onRequest({request:new Request('http://local'+p),env:{},next:async()=>new Response('dato privado')});
  assert.equal(r.status,404,p);
 }
});
