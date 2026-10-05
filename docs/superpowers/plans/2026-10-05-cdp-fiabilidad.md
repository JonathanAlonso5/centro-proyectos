# Fiabilidad CdP y avisos Friday

Objetivo: conservar actualizaciones concurrentes, mostrar errores reales y evitar volver a avisar de pasos ya contestados o proyectos pausados.
Autorización: encargo ORQUESTA 2026-10-05, decisiones reversibles y despliegue incluidos; sin nuevas confirmaciones.

- [ ] Reproducir pérdida de extra concurrente con SQLite real; cambiar actualización a JSON por clave en una sentencia y CAS para huella.
- [ ] Rechazar claves desconocidas del MCP; mantener contratos legacy.
- [ ] Cliente bot/Friday: validar HTTP, JSON-RPC, isError y forma de datos antes de anunciar éxito.
- [ ] Friday: deduplicación persistente por proyecto/estado/progreso/próximo paso, incluir legado; excluir pausados; cola valida datos frescos y envío con bloqueo persistente.
- [ ] Web: serializar guardados, conservar texto ante fallo y refrescar con indicación sin sobrescribir edición.
- [ ] Ejecutar contratos, regresiones, build y revisión cruzada; corregir hallazgos.
- [ ] Publicar, smoke tests sin enviar mensajes a Jonathan; actualizar memoria y CdP, informe verificable.
