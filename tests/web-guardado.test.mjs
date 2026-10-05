import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function web(fetch) {
 const html=readFileSync('index.html','utf8');
 const fragmento=html.slice(html.indexOf('  // ---------- red ----------'),html.indexOf('  // ---------- luz ----------'));
 const el={textContent:'',className:'',hidden:false};
 const c=vm.createContext({fetch,localStorage:{getItem(){return 'clave'}},$:()=>el,pintar(){},datos:{},setTimeout,clearTimeout});
 vm.runInContext(fragmento,c);return {c,el};
}
test('un fallo de guardado conserva borrador y no recarga datos',async()=>{
 let llamadas=0;
 const {c,el}=web(async()=>{llamadas++;throw Error('sin red')});
 await assert.rejects(c.guardar('nodo',{id:'P-001',extra:{proximoPaso:'Borrador'}}));
 assert.equal(llamadas,1);assert.match(el.textContent,/sin red|sin guardar/);
});
test('dos guardados salen en orden aunque la red tarde',async()=>{
 const enviados=[];let liberar;
 const {c}=web(async(url,opts)=>{enviados.push(JSON.parse(opts.body).n);if(enviados.length===1)await new Promise(r=>liberar=r);return Response.json({})});
 const uno=c.guardar('nodo',{n:1});const dos=c.guardar('nodo',{n:2});
 await new Promise(r=>setTimeout(r,0));assert.deepEqual(enviados,[1]);
 liberar();await Promise.all([uno,dos]);assert.deepEqual(enviados,[1,2]);
});
