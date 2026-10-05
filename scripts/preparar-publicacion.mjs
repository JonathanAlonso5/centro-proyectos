// Lista cerrada de assets. El repositorio incluye memoria privada y fixtures:
// jamás publicar la raíz como directorio estático.
import {mkdirSync,rmSync,cpSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const raiz=fileURLToPath(new URL('../',import.meta.url));
const destino=join(raiz,'public');
rmSync(destino,{recursive:true,force:true});mkdirSync(destino);
for(const archivo of ['index.html','manifest.json','pwa-init.js','sw.js','icons'])cpSync(join(raiz,archivo),join(destino,archivo),{recursive:true});
// Evita que el fallback SPA responda con 200 a un fichero interno inexistente.
await import('node:fs').then(({writeFileSync})=>writeFileSync(join(destino,'404.html'),'<!doctype html><html lang="es"><meta charset="utf-8"><title>No existe</title><p>No existe esta página. <a href="/">Abrir CdP</a></p></html>'));
