import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
const r=await build({entryPoints:['functions/mcp.ts'],bundle:true,format:'esm',platform:'node',write:false});
mkdirSync('.wrangler/test',{recursive:true});writeFileSync('.wrangler/test/mcp.mjs',r.outputFiles[0].text);
const {onRequestPost}=await import('../.wrangler/test/mcp.mjs');
for (const args of [{id:'P-001',nextStep:'Nuevo'},{id:'P-001',progreso:101},{id:'P-001',estado:'inexistente'},{id:'P-001',proximoPaso:4}]) {
 test('rechaza cambios inválidos '+JSON.stringify(args),async()=>{
  const request=new Request('http://local/mcp',{method:'POST',headers:{Authorization:'Bearer prueba','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'cdp_update_project',arguments:args}})});
  const body=await (await onRequestPost({request,env:{MCP_SECRET:'prueba',CDP:{prepare(){throw Error('No debe llegar a D1')}}}})).json();
  assert.match(body.error?.message??'',/desconocid|inválid|Invalid|0.*100/);
 });
}
test('sesión sin texto se rechaza antes de crear un nodo vacío',async()=>{
 const request=new Request('http://local/mcp',{method:'POST',headers:{Authorization:'Bearer prueba','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'cdp_log_session',arguments:{proyecto:'P-001',resumen:'campo incorrecto'}}})});
 const body=await (await onRequestPost({request,env:{MCP_SECRET:'prueba',CDP:{prepare(){throw Error('No debe llegar a D1')}}}})).json();
 assert.match(body.error?.message??'',/texto.*obligatorio/);
});
