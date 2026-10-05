# Fiabilidad CdP y avisos Friday

Objetivo: conservar actualizaciones concurrentes, mostrar errores reales y evitar volver a avisar de pasos ya contestados o proyectos pausados.
Autorización: encargo ORQUESTA 2026-10-05, decisiones reversibles y despliegue incluidos; sin nuevas confirmaciones.

- [x] Reproducir pérdida de extra concurrente con SQLite real; cambiar actualización a JSON por clave en una sentencia y CAS para huella.
- [x] Rechazar claves desconocidas del MCP; mantener contratos legacy.
- [x] Cliente bot/Friday: validar HTTP, JSON-RPC, isError y forma de datos antes de anunciar éxito.
- [x] Friday: deduplicación persistente por proyecto/estado/progreso/próximo paso, incluir legado; excluir pausados; cola valida datos frescos y envío con bloqueo persistente.
- [x] Web: serializar guardados, conservar texto ante fallo y refrescar con indicación sin sobrescribir edición.
- [x] Ejecutar contratos, regresiones, build y revisión cruzada; corregir hallazgos.
- [x] Publicar, smoke tests sin enviar mensajes a Jonathan; actualizar memoria y CdP, informe verificable.

Pendiente externo: retirada pública de copias históricas eliminadas; API confirma borrado pero HTTP público sigue sirviendo SQL. Registrado en CdP/memoria y detallado en `/home/scraper/cdp/REVISION-CDP-2026-10-05.md`. ORQUESTA recarga automáticamente al terminar carriles.
