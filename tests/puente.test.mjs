import test from 'node:test';import assert from 'node:assert/strict';import {onRequest} from '../functions/_middleware.ts';
test('dominio antiguo usa el VPS con origen firmado y conserva errores sin escribir D1',async()=>{
 const previous=global.fetch;let target;global.fetch=async request=>{target=request;return new Response('{"error":"fallo"}',{status:503})};
 try{const r=await onRequest({request:new Request('https://centro-proyectos.pages.dev/mcp',{method:'POST',body:'{}'}),env:{MCP_SECRET:'prueba',CDP_ORIGIN:'https://cdp.friday-imperio.com'},next:()=>{throw Error('No debe usar D1')}});assert.equal(r.status,503);assert.equal(new URL(target.url).host,'cdp.friday-imperio.com');assert.equal(target.headers.get('x-cdp-origin'),'https://centro-proyectos.pages.dev');assert.equal(target.headers.get('x-cdp-proxy'),'prueba')}finally{global.fetch=previous}
});
