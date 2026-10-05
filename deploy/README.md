# CdP en VPS · operación segura

**Estado 2026-10-05: preparado y probado localmente, NO migrado en producción.**
Cloudflare API devuelve 403/10000 al crear DNS en friday-imperio.com y al crear túnel. La CLI carece de cert.pem. Hace falta DNS:Edit para esa zona en CLOUDFLARE_API_TOKEN de la bóveda. Puede reutilizarse el túnel actual de ORQUESTA con una recarga escalonada de conectores; no reiniciar ORQUESTA. Crear un túnel independiente requiere además permiso Cloudflare Tunnel:Edit. No cambiar fuentes/integraciones antes de verificar nuevo hostname.

## Antes de publicar

- Revisar `.env.vps` privado y conservar MCP_SECRET: cambiarlo invalida sesiones. Inicialmente incluye credenciales Cloudflare de la bóveda para el adaptador D1 temporal. `SA_KEY`/`DRIVE_FILE_ID` solo si ya estaban configurados; en esta cuenta no lo estaban.
- `npm run build && npm test`; ejecutar los contratos contra una base fixture SQLite, nunca sembrar fixtures en producción. `deploy/cdp.service` sirve solo 127.0.0.1:7430; no instalar hasta tener ruta pública autorizada.
- Configurar DNS `cdp.friday-imperio.com` hacia el túnel elegido y servicio 127.0.0.1:7430. Conservar config previa. Si se reutiliza ORQUESTA, levantar conector puente con ingress viejo+nuevo antes de recargar el original y retirar puente después de confirmar salud; la aplicación ORQUESTA no se reinicia.
- Arrancar CdP inicialmente sobre D1; comprobar ambos accesos y OAuth. La entrada Google usa popup del dominio anterior autorizado y postMessage con origen, ventana y nonce comprobados; no hay que cambiar el cliente OAuth en Google.
- Publicar los cambios del middleware en Pages y añadir `CDP_ORIGIN=https://cdp.friday-imperio.com` preservando todo el resto de la configuración. `/api/estado` y `/mcp` antiguos deben devolver `x-cdp-backend: vps`. No retirar dominio anterior: mantiene conectores, Google y sesiones.

## Cambio de datos

Solo cuando todo el tráfico de la URL canónica anterior y nueva llega al VPS: POST local `/admin/migrate` con bearer de bóveda. El handler rechaza acceso público aunque esté autenticado. Pone las peticiones en espera, drena trabajo activo, instala triggers de bloqueo de INSERT/UPDATE/DELETE en D1 (también impide escribir a despliegues históricos), copia nodes/links/etiquetas/meta y comprueba hashes completos, claves foráneas, integridad y FTS. Activa marcador persistente antes de liberar tráfico y conserva snapshot privado en data/backups. D1 queda solo lectura; la base activa es data/cdp.sqlite y jamás volver a la copia D1 obsoleta.

Tras comprobar ambas URLs: retirar credenciales Cloudflare temporales de `.env.vps`, reiniciar únicamente cdp.service y verificar healthz=sqlite y escrituras reales por ambas URLs. Actualizar Friday CDP_MCP_URL, bot MCP_URL y configuración ORQUESTA/Codex al nuevo dominio sin rotar secretos. ORQUESTA se recarga cuando queden libres sus carriles; el proxy conserva su funcionamiento mientras espera. Conservar modelo y cron existentes.

## Copias y vuelta atrás

Antes de activar: cualquier fallo retira triggers y conserva D1 como fuente; si el proceso cae, al arrancar recupera ese estado cuando no hay marcador. Si hay marcador, usa SQLite y no vuelve automáticamente a D1.

Después de activar: la vuelta atrás es de **código**, conservando la SQLite actual con todas las escrituras posteriores. Guardar release validada de vps/functions/schema/public/package*.json antes de futuras modificaciones y usar esa release con CDP_DATA_DIR apuntando a la data activa original; conservar secreto y proxy. No restaurar el snapshot D1 antiguo ni retirar el proxy. Restaurar datos solo tras conciliar cambios explícitamente.

Copiar SQLite con `deploy/backup.mjs`, nunca con cp del fichero en modo WAL. Instalar timer diario tras activación, probar restauración y comprobar búsqueda y conteos en copia. Las copias no están en public/.

La migración no elimina las copias históricas de Pages que seguían sirviendo memoria privada; conservar su incidencia abierta hasta verificar retirada pública.
