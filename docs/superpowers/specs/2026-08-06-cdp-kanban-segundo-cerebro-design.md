# CdP: Kanban dual y segundo cerebro

Fecha: 2026-08-06 · Estado: aprobado por Jonathan · Proyecto: P-001

## Por qué

El CdP de hoy es una rejilla de tarjetas con un kanban de tres columnas escondido dentro
del modal de cada proyecto. Funciona, pero se ha quedado corto en dos frentes:

1. **El `proximoPaso` se ha convertido en un vertedero.** En P-005, P-006 y P-015 son
   informes de más de 3.000 caracteres con decisiones, avisos y tareas mezclados. Es
   información valiosa metida en un campo que no se puede filtrar, enlazar ni buscar.
2. **El segundo cerebro ya existe, pero está en el PC.** Son los ~90 ficheros de
   `~/.claude/projects/-home-jonathan-proyectos-tcgprecios/memory/*.md`, con su índice y
   sus `[[enlaces]]`. Solo los ve Claude Code, solo desde esa máquina. Jonathan no los ve
   desde el iPhone y Codex no los ve en absoluto.

Y el almacén (un único JSON en Drive reescrito entero en cada operación) ya provocó
pérdida de cambios por escritura concurrente en julio de 2026 (commit `50110c2`). El
parche de entonces (releer fresco y aplicar operaciones semánticas encima) redujo la
ventana de choque de horas a milisegundos, pero no la cierra. Con capturas entrando por
tres vías nuevas, volvería a morder.

## Qué se construye

Un **núcleo común con vistas afiladas**: todo lo que guarda el CdP es un *nodo* con los
mismos campos base, y encima de eso cada tipo tiene su vista propia. Búsqueda, etiquetas,
enlaces y herramientas MCP se escriben una vez y valen para todo.

### Decisiones cerradas

| Decisión | Alternativas descartadas |
|---|---|
| Núcleo común de nodos + extras por tipo en JSON | Una tabla por tipo (5 CRUD para el mismo resultado); todo genérico sin vistas propias (acaba en un Notion cutre) |
| El CdP es la fuente de verdad de la memoria; los `.md` locales son caché | Espejo bidireccional (dos copias que divergen); no mezclar (te quedas con dos cerebros) |
| Almacén en D1 | Seguir en Drive (es la causa raíz del bug de concurrencia) |
| Acento latón apagado, fuera de la gama rojo/ámbar/verde del estado | Que el acento comparta gama con las alarmas |
| Agentes: cerebro compartido y rastro automático. El lanzador se deja preparado, no construido | Absorber P-020 ORQUESTA entero (el doble de trabajo y un demonio con permisos en el PC) |
| Correo de captura por IMAP desde el VPS | Cloudflare Email Routing (obligaría a mover el DNS de `imperionoxus.com`, que está en SiteGround) |

### Fuera de alcance

- **Los ADR y los `docs/` de cada repo se quedan en su repo.** Van versionados con el
  código que explican. El CdP guarda como mucho el titular con el enlace.
- **Nada de jerarquía de carpetas.** Un nodo cuelga de un proyecto o de ninguno; lo demás
  se resuelve con etiquetas y enlaces. Las carpetas convierten el sistema en un rato de
  decidir dónde va cada cosa en vez de escribirla.
- **El ejecutor de agentes (nivel 3).** Arrastrar una tarjeta y que se lance una sesión
  real es P-020 ORQUESTA. Aquí solo se dejan los campos que lo harán posible.

## Modelo de datos

```sql
nodes (
  id         TEXT PRIMARY KEY,   -- P-004, T-7f3a, N-2c91, S-..., C-...
  tipo       TEXT NOT NULL,      -- proyecto | tarea | nota | sesion | captura
  titulo     TEXT NOT NULL,
  cuerpo     TEXT DEFAULT '',    -- markdown
  estado     TEXT,               -- según el tipo
  proyecto   TEXT,               -- nodo padre; NULL = transversal
  orden      REAL,               -- posición en su columna (índice fraccional)
  extra      TEXT DEFAULT '{}',  -- JSON con lo propio de cada tipo
  agente     TEXT,               -- jonathan | claude-code | codex  (nivel 3)
  ejecucion  TEXT,               -- NULL | pendiente | corriendo | fallida (nivel 3)
  creado     TEXT NOT NULL,
  modificado TEXT NOT NULL,
  archivado  INTEGER DEFAULT 0,
  huella     TEXT                -- hash del contenido, para el sync de la memoria
)
links (origen TEXT, destino TEXT, tipo TEXT)    -- menciona | bloquea | deriva_de
etiquetas (nodo TEXT, etiqueta TEXT)
nodes_fts                                        -- FTS5 sobre titulo + cuerpo
```

**Estados por tipo:**

- `proyecto`: `activo`, `desarrollo`, `pausado`, `planificacion`, `completado`
- `tarea`: `porHacer`, `enCurso`, `hecho`
- `nota`: sin estado. En `extra.subtipo`: `user`, `feedback`, `project`, `reference`,
  `gotcha` (los cuatro primeros son los que ya usa la memoria local; `gotcha` recoge los
  "MIRA PRIMERO", que en la memoria de Jonathan ya son un género propio)
- `sesion`: sin estado. `extra.fecha` y `extra.proyecto`
- `captura`: `sinClasificar`, `clasificada`, `descartada`. En `extra.via`: `pwa`,
  `telegram`, `correo`

**`orden` es un índice fraccional**: mover una tarjeta entre otras dos calcula el punto
medio en vez de renumerar la columna. Con tres escritores concurrentes (web, MCP,
Telegram), renumerar índices es exactamente lo que provoca las pisadas que ya se
sufrieron.

**Los campos `agente` y `ejecucion`** hoy solo alimentan el filtro "solo mías" del
tablero. El día que exista ORQUESTA, son el enganche del lanzador, sin migrar nada.

## Vistas

Cuatro lentes sobre el mismo dato, con conmutador arriba:

- **Proyectos**: kanban por estado. Se arrastra el proyecto entero de columna.
- **Tareas**: kanban global con las tareas de todos los proyectos, cada tarjeta con su
  etiqueta de proyecto. Filtros: todas, hoy, solo mías.
- **Cerebro**: buscador sobre las notas (FTS5), filtro por subtipo, ficha con enlaces
  salientes y entrantes.
- **Bandeja**: capturas sin clasificar, con destino propuesto por etiquetas y proyecto
  mencionado. Sin IA: si hay que esperar a que un modelo clasifique, deja de ser captura
  rápida.

**Reglas de la interfaz:**

- **Arrastrar solo en pantalla grande.** En móvil, cada tarjeta lleva un "mover a": con el
  dedo es más fiable que arrastrar dentro de una lista que además baja.
- **En móvil no hay tablero horizontal.** Se elige columna con botones y la página baja
  entera. Un carrusel dentro de una página que ya hace scroll es justo lo que Jonathan
  odia (memoria `feedback_mobile_llm_first`).
- **La columna Hecho se archiva sola** a los 30 días. Sale del tablero y se queda buscable.
  Sin esto el tablero nace muerto: P-005 ya acumula 88 tareas hechas.
- **`proximoPaso` con tope de 280 caracteres.** No es estética: mientras quepa un informe,
  ahí seguirá cayendo el informe.
- **La captura está siempre visible**, arriba del todo, en todas las vistas.

**Luz y color.** Tres grados en lugar de claro/oscuro, porque "que no deslumbre" y "que se
lea con cualquier luz" se pelean en una sola paleta:

- `noche`: fondo #080a0d, texto #b6bcc4. Contraste bajo para leer a oscuras.
- `interior` (defecto): fondo #101318, texto #d5dae0. Ni negro puro ni blanco puro.
- `sol`: fondo #e4e6e3, texto #171b20. Papel apagado, nunca #fff, para la calle.

Acento latón (#c08a4a en oscuro, #8a5a1e en claro), deliberadamente fuera de la gama
rojo/ámbar/verde que usa el estado, para que un acento no se pueda leer como una alarma.

## Arquitectura

```
Cloudflare Pages (proyecto centro-proyectos)
├── public/                      estáticos (PWA)
├── functions/mcp.ts             MCP dual-era, ahora sobre D1
├── functions/api/[[ruta]].ts    API REST para la web
├── functions/lib/db.ts          capa de datos (única que habla SQL)
└── D1: cdp                      nodes + links + etiquetas + nodes_fts

VPS Hetzner
├── bot de Telegram (P-008)      captura por chat
└── buzón IMAP                   captura por correo

PC / cualquier máquina
└── cdp-sync                     nodos nota <-> ficheros .md de memoria
```

**Drive no desaparece**: se queda como copia de seguridad, con un export nocturno del
JSON. Lo que deja de ser es la fuente de verdad.

### Compatibilidad del MCP: innegociable

Las siete herramientas actuales (`cdp_list_projects`, `cdp_get_project`,
`cdp_update_project`, `cdp_create_project`, `cdp_add_task`, `cdp_complete_task`,
`cdp_add_roadmap`, `cdp_delete_project`) **mantienen su firma y su forma de respuesta**,
reimplementadas sobre D1. De ellas dependen hoy:

- el bot de Telegram del VPS (P-008),
- los subagentes `cdp-updater` y `docs-updater` de tcgprecios,
- el conector CdP de claude.ai en todas las superficies.

`cdp_get_project` sigue devolviendo `tareas: {porHacer, enCurso, hecho}` como arrays de
strings y `roadmap` como array de objetos, reconstruidos desde los nodos. `cdp_complete_task`
sigue aceptando índices base-0 dentro de la columna origen; el índice se resuelve contra
los nodos ordenados por `orden`.

Herramientas nuevas: `cdp_search` (FTS), `cdp_get_node`, `cdp_upsert_node`, `cdp_link`,
`cdp_capture`, `cdp_log_session`, `cdp_list_notes`.

### Sync de la memoria local

`cdp-sync` es un script que se lanza al arrancar sesión:

1. Sube lo local que haya cambiado y no esté en el CdP (compara `huella`).
2. Baja los nodos de tipo `nota` a `.md` con su cabecera de siempre y regenera `MEMORY.md`.
3. Solo escribe los ficheros cuya huella cambió.

Sin red, los `.md` siguen ahí y el agente trabaja; las escrituras se encolan en
`~/.cdp-pendiente.jsonl` y suben al siguiente arranque. Si un `.md` local y su nodo
divergen, **manda el CdP** y el local se sobrescribe, porque es caché; el sync avisa antes
si detecta algo local sin subir.

## Migración

**Los 90 ficheros de memoria migran solos.** Ya tienen cabecera con `name`, `description` y
`metadata.type`, que es exactamente el nodo nota. Los `[[enlaces]]` del cuerpo se
convierten en filas de `links`.

**Los `proximoPaso` no migran solos.** Son 19 textos, dos de ellos de más de 3.000
caracteres con decisiones, avisos y tareas mezclados; trocearlos a ciegas es perder
información. Se hace asistido: el script propone las tareas y notas que salen de cada uno
y Jonathan acepta o tira. Es un rato de trabajo, una vez.

## Riesgos y cómo se tapan

1. **Romper lo que ya funciona.** Antes de tocar el almacén se escriben pruebas de
   contrato de las siete herramientas actuales, con la respuesta de hoy como referencia.
   Tienen que seguir pasando después. Si una falla, no se despliega.
2. **Perder datos migrando.** El JSON de Drive se conserva intacto y la migración es
   idempotente: se puede lanzar dos veces y da el mismo resultado. Si sale mal, se
   relanza.
3. **Que el sync pise trabajo.** Solo se escribe lo que cambió de verdad (huella), y lo
   local sin subir se sube antes de bajar nada.
4. **Romper el despliegue de producción.** Todo el trabajo va en la rama
   `segundo-cerebro` con despliegues de vista previa. `main` (que auto-despliega a
   producción) no se toca hasta que las pruebas de contrato pasen contra la vista previa.

## Fases

| Fase | Entrega |
|---|---|
| **0** | Esquema D1, capa de datos, MCP reimplementado, migración desde Drive, pruebas de contrato |
| **1** | Kanban dual (proyectos y tareas) sobre la API nueva |
| **2** | Nodos de conocimiento, herramientas MCP nuevas, migración de la memoria, `cdp-sync` |
| **3** | Captura: barra de la PWA y destino de "Compartir", comando del bot de Telegram, buzón IMAP |
| **4** | Enlaces y backlinks en la ficha, registro de sesiones con fecha, archivado automático |

Cada fase es usable por sí sola. La 0 es la que desbloquea todo y la que mata el bug de
concurrencia.

## Cómo se sabe que está bien

- Las siete herramientas MCP devuelven lo mismo que antes de la migración (pruebas de
  contrato en verde).
- El bot de Telegram del VPS sigue leyendo y escribiendo sin cambios.
- Los 19 proyectos, sus tareas y su roadmap están en D1 con el mismo contenido.
- La memoria local y el CdP coinciden tras un `cdp-sync`, y un cambio en cualquiera de los
  dos lados llega al otro.
- El tablero se usa con una mano en el iPhone, sin scroll horizontal.
