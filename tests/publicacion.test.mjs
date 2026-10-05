import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
test('la publicación no sirve memoria, fixtures ni código interno',()=>{
 execFileSync(process.execPath,['scripts/preparar-publicacion.mjs']);
 assert.equal(existsSync('public/index.html'),true);
 for(const p of ['scripts/memoria.sql','scripts/instantanea-drive.json','functions/mcp.ts','package.json','dev/wrangler.jsonc'])assert.equal(existsSync('public/'+p),false,p);
 const m=JSON.parse(readFileSync('public/manifest.json','utf8'));
 for(const i of m.icons)assert.equal(existsSync('public'+i.src),true,i.src);
});
