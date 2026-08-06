// MCP server for Centro de Proyectos — servidor DUAL-ERA
// Streamable HTTP transport.
//
// Habla las dos eras del protocolo sobre el MISMO endpoint (permitido
// explícitamente por la spec 2026-07-28, §Backward Compatibility):
//
//   - "moderna" (2026-07-28+): sin handshake. Cada request lleva su versión y
//     capabilities en `params._meta` (+ cabecera MCP-Protocol-Version). El
//     servidor DEBE implementar `server/discover`. Los results llevan
//     `resultType` y `_meta.io.modelcontextprotocol/serverInfo`; las listas
//     llevan `ttlMs`/`cacheScope`. No hay sesiones ni Mcp-Session-Id.
//   - "legacy" (2025-11-25 y anteriores): handshake `initialize` +
//     Mcp-Session-Id + GET SSE. Es lo que hablan hoy Claude Code, los
//     conectores de claude.ai y mcp-remote.
//
// La era se decide POR REQUEST: si trae versión >= 2026-07-28 (en _meta o en
// cabecera) o el método es `server/discover`, se sirve moderna; si no, legacy.
//
// POST /mcp con cuerpo JSON-RPC
//   - server/discover: versiones soportadas + capabilities + identidad (moderna)
//   - initialize: handshake legacy, emite Mcp-Session-Id
//   - tools/list / tools/call: en ambas eras
//   - notifications/*: 202 sin cuerpo
// GET /mcp con Accept: text/event-stream → stream SSE largo (solo legacy)
// GET /mcp sin ese Accept → metadata JSON (health check)
// DELETE /mcp → 204 (cierre de sesión legacy)

import {
  actualizarNodo,
  borrarNodo,
  buscar,
  crearNodo,
  enlacesDe,
  enlazar,
  listarProyectos,
  nodosPorTipo,
  obtenerNodo,
  obtenerProyectoLegacy,
  proyectoALegacy,
  sincronizarEnlacesDelCuerpo,
  tareasDeColumna,
  type Columna
} from "./lib/db";

interface Env {
  // El almacén. Todo lo demás es histórico.
  CDP: D1Database;
  // Solo los usa cdp_backup_drive (copia de seguridad nocturna en Drive).
  SA_KEY?: string;
  DRIVE_FILE_ID?: string;
  MCP_SECRET: string;
}

// Revisión moderna (sin handshake) que implementamos.
const MODERN_VERSION = "2026-07-28";
// Revisiones legacy que aceptamos en `initialize`. Para un servidor que solo
// expone tools, `initialize`/`tools/list`/`tools/call` son idénticos en todas.
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
// Versión legacy por defecto si el cliente no pide ninguna reconocible.
const LEGACY_DEFAULT = "2024-11-05";
const SERVER_INFO = { name: "centro-proyectos-mcp", version: "0.6.0" };
const SERVER_INSTRUCTIONS =
  "Centro de Proyectos: panel personal de proyectos de Jonathan y su segundo cerebro. " +
  "Llama cdp_list_projects al inicio de una sesion para tener contexto, y cdp_update_project / cdp_add_task / cdp_complete_task al cerrarla. " +
  "Antes de dar por bueno un diagnostico, busca en el cerebro con cdp_search: los 'gotcha' son fallos ya vistos y ya resueltos. " +
  "Al cerrar sesion, deja el rastro con cdp_log_session en vez de alargar proximoPaso.";

// Claves _meta del namespace oficial.
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

// Códigos de error reservados por la spec (rango -32020..-32099).
const ERR_HEADER_MISMATCH = -32020;
const ERR_UNSUPPORTED_VERSION = -32022;

// Cache hint para las listas (CacheableResult). "private": la respuesta va
// ligada al Bearer del usuario, ningun intermediario compartido debe cachearla.
const LIST_CACHE = { ttlMs: 300000, cacheScope: "private" as const };

const DATA_FILE_NAME = "centro-proyectos-data.json";

// ---------- Tool catalog ----------

const TOOLS = [
  {
    name: "cdp_list_projects",
    description:
      "Lista todos los proyectos de Centro de Proyectos: id, nombre, estado (activo|pausado|planificacion|completado), progreso 0-100 y proximo paso. Llama esto al inicio de cualquier sesion para tener contexto del usuario.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "cdp_get_project",
    description:
      "Devuelve TODOS los campos de un proyecto por id (descripcion, tareas, roadmap, notas, tags, etc).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "ID del proyecto, ej. P-001" }
      }
    }
  },
  {
    name: "cdp_update_project",
    description:
      "Actualiza uno o varios campos de un proyecto existente. Acepta cualquier subconjunto de: nombre, descripcion, estado, progreso, proximoPaso, notas, tags. Para tareas/roadmap usar las tools especificas.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        nombre: { type: "string" },
        descripcion: { type: "string" },
        estado: { type: "string", enum: ["activo", "pausado", "planificacion", "completado"] },
        progreso: { type: "number", minimum: 0, maximum: 100 },
        proximoPaso: { type: "string" },
        notas: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "cdp_create_project",
    description:
      "Crea un proyecto nuevo. Solo nombre es obligatorio; el resto va con defaults sensatos.",
    inputSchema: {
      type: "object",
      required: ["nombre"],
      properties: {
        nombre: { type: "string" },
        descripcion: { type: "string" },
        estado: { type: "string", enum: ["activo", "pausado", "planificacion", "completado"] },
        progreso: { type: "number" },
        proximoPaso: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        notas: { type: "string" }
      }
    }
  },
  {
    name: "cdp_add_task",
    description:
      "Anade una tarea a un proyecto. column elige el kanban: porHacer (default), enCurso, hecho.",
    inputSchema: {
      type: "object",
      required: ["id", "text"],
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        column: { type: "string", enum: ["porHacer", "enCurso", "hecho"] }
      }
    }
  },
  {
    name: "cdp_complete_task",
    description:
      "Mueve una tarea a la columna 'hecho'. Especifica el indice dentro de la columna origen (default: enCurso).",
    inputSchema: {
      type: "object",
      required: ["id", "index"],
      properties: {
        id: { type: "string" },
        index: { type: "number", description: "Indice de la tarea en la columna origen, base 0" },
        from: { type: "string", enum: ["porHacer", "enCurso"], description: "Columna origen, default enCurso" }
      }
    }
  },
  {
    name: "cdp_add_roadmap",
    description:
      "Anade un hito a la hoja de ruta de un proyecto.",
    inputSchema: {
      type: "object",
      required: ["id", "fecha", "texto"],
      properties: {
        id: { type: "string" },
        fecha: { type: "string", description: "Fecha en formato libre, ej '2026-06' o 'Q3 2026'" },
        texto: { type: "string" },
        estado: { type: "string", enum: ["future", "current", "done"], description: "Default future" }
      }
    }
  },
  {
    name: "cdp_delete_project",
    description:
      "Elimina un proyecto del CdP. Operacion destructiva: borra entrada completa (tareas, roadmap, notas).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" }
      }
    }
  },

  // ---- Segundo cerebro (v0.6.0) ----

  {
    name: "cdp_search",
    description:
      "Busca por texto en TODO el cerebro (proyectos, tareas, notas, sesiones, capturas). Usalo ANTES de diagnosticar un fallo o de proponer una solucion: las notas de tipo gotcha son problemas ya resueltos, con su causa y su arreglo.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "Texto libre, en espanol" },
        tipo: { type: "string", enum: ["proyecto", "tarea", "nota", "sesion", "captura"] },
        limite: { type: "number", description: "Default 20, maximo 100" }
      }
    }
  },
  {
    name: "cdp_get_node",
    description:
      "Devuelve un nodo cualquiera por id, con sus etiquetas y sus enlaces (los que salen y los que entran).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } }
    }
  },
  {
    name: "cdp_upsert_node",
    description:
      "Crea o actualiza un nodo. Sin id crea uno nuevo. Los [[enlaces]] que haya en el cuerpo se convierten en enlaces reales. Para notas, extra.subtipo debe ser user|feedback|project|reference|gotcha.",
    inputSchema: {
      type: "object",
      required: ["tipo", "titulo"],
      properties: {
        id: { type: "string" },
        tipo: { type: "string", enum: ["proyecto", "tarea", "nota", "sesion", "captura"] },
        titulo: { type: "string" },
        cuerpo: { type: "string" },
        estado: { type: "string" },
        proyecto: { type: "string", description: "Id del proyecto padre, o vacio si es transversal" },
        extra: { type: "object" },
        etiquetas: { type: "array", items: { type: "string" } },
        agente: { type: "string", enum: ["jonathan", "claude-code", "codex"] }
      }
    }
  },
  {
    name: "cdp_link",
    description: "Enlaza dos nodos. tipo: menciona (default), bloquea o deriva_de.",
    inputSchema: {
      type: "object",
      required: ["origen", "destino"],
      properties: {
        origen: { type: "string" },
        destino: { type: "string" },
        tipo: { type: "string", enum: ["menciona", "bloquea", "deriva_de"] }
      }
    }
  },
  {
    name: "cdp_capture",
    description:
      "Suelta algo en la bandeja de entrada sin decidir donde va. Se clasifica despues, desde la web.",
    inputSchema: {
      type: "object",
      required: ["texto"],
      properties: {
        texto: { type: "string" },
        via: { type: "string", enum: ["pwa", "telegram", "correo", "agente"] },
        proyecto: { type: "string", description: "Proyecto sugerido, opcional" }
      }
    }
  },
  {
    name: "cdp_log_session",
    description:
      "Deja el rastro de una sesion de trabajo: que se hizo y por que, con fecha. Esto es lo que sustituye a seguir alargando proximoPaso.",
    inputSchema: {
      type: "object",
      required: ["proyecto", "texto"],
      properties: {
        proyecto: { type: "string" },
        texto: { type: "string" },
        fecha: { type: "string", description: "YYYY-MM-DD. Default: hoy" },
        agente: { type: "string", enum: ["jonathan", "claude-code", "codex"] }
      }
    }
  },
  {
    name: "cdp_list_notes",
    description:
      "Lista las notas del cerebro, opcionalmente filtradas por subtipo o proyecto. Para buscar por contenido usa cdp_search.",
    inputSchema: {
      type: "object",
      properties: {
        subtipo: { type: "string", enum: ["user", "feedback", "project", "reference", "gotcha"] },
        proyecto: { type: "string" },
        limite: { type: "number" }
      }
    }
  },
  {
    name: "cdp_backup_drive",
    description:
      "Vuelca todo el CdP al fichero JSON de Drive como copia de seguridad. Drive ya no es la fuente de verdad: esto es solo respaldo.",
    inputSchema: { type: "object", properties: {} }
  }
];

// ---------- Base64url helpers ----------

function b64url(input: string | Uint8Array): string {
  let bin: string;
  if (typeof input === "string") {
    bin = unescape(encodeURIComponent(input));
  } else {
    bin = "";
    for (const b of input) bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------- JWT signing using SubtleCrypto ----------

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signJWT(claims: object, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const message = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(message)
  );
  return `${message}.${b64url(new Uint8Array(sig))}`;
}

// ---------- Google OAuth (Service Account) ----------

interface SAKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

async function getAccessToken(saKey: SAKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: saKey.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: saKey.token_uri,
    iat: now,
    exp: now + 3600
  };
  const jwt = await signJWT(claims, saKey.private_key);
  const res = await fetch(saKey.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
      jwt
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) throw new Error("No access_token returned");
  return data.access_token;
}

// ---------- Drive helpers ----------

// Find the canonical fileId: the most recently modified, non-trashed file
// with the canonical name. Mirrors what the web app does (loadOrCreateFile in
// index.html). Trashing of older duplicates is left to the web app (which uses
// OAuth and can trash files it owns).
//
// We pass the env-provided DRIVE_FILE_ID as a fallback in case the lookup
// fails (e.g. Drive permissions blip). If we don't find any file by name, we
// fall back to that id too — that keeps the server from breaking right after
// a deploy if the lookup is slow.
async function findCanonicalFileId(token: string, fallback: string): Promise<string> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `name='${DATA_FILE_NAME}' and trashed=false`);
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("fields", "files(id,modifiedTime)");
  url.searchParams.set("pageSize", "1");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    console.warn(`findCanonicalFileId: list failed ${res.status}, using fallback`);
    return fallback;
  }
  const data = (await res.json()) as { files?: Array<{ id: string }> };
  if (data.files && data.files.length > 0) return data.files[0].id;
  return fallback;
}

async function readDriveFile(token: string, fileId: string): Promise<any> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive read failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function writeDriveFile(token: string, fileId: string, data: any): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data, null, 2)
    }
  );
  if (!res.ok) throw new Error(`Drive write failed: ${res.status} ${await res.text()}`);
}

// ---------- Tool execution ----------

// Las siete herramientas de siempre mantienen su firma y su forma de respuesta:
// de ellas dependen el bot de Telegram del VPS y los subagentes cdp-updater y
// docs-updater. Lo único que cambia por debajo es que ya no hay un JSON de
// Drive, sino filas en D1. Hay pruebas de contrato en tests/contrato-mcp.mjs.
async function executeTool(name: string, args: any, env: Env): Promise<any> {
  const db = env.CDP;

  const exigirProyecto = async (id: string) => {
    const p = await obtenerNodo(db, id);
    if (!p || p.tipo !== "proyecto") throw new Error(`Project ${id} not found`);
    return p;
  };

  switch (name) {
    case "cdp_list_projects":
      return await listarProyectos(db);

    case "cdp_get_project": {
      const p = await obtenerProyectoLegacy(db, args.id);
      if (!p) throw new Error(`Project ${args.id} not found`);
      return p;
    }

    case "cdp_update_project": {
      await exigirProyecto(args.id);
      const cambios: any = { extra: {} };
      if (args.nombre !== undefined) cambios.titulo = args.nombre;
      if (args.descripcion !== undefined) cambios.cuerpo = args.descripcion;
      if (args.estado !== undefined) cambios.estado = args.estado;
      if (args.tags !== undefined) cambios.etiquetas = args.tags;
      for (const k of ["progreso", "proximoPaso", "notas"]) {
        if (args[k] !== undefined) cambios.extra[k] = args[k];
      }
      await actualizarNodo(db, args.id, cambios);
      return await obtenerProyectoLegacy(db, args.id);
    }

    case "cdp_create_project": {
      // El id sale del máximo existente, no del número de proyectos: con
      // count+1 (lo que hacía la versión de Drive), borrar uno y crear otro
      // reutilizaba un id ya usado.
      const fila = await db
        .prepare(
          "SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS m FROM nodes WHERE tipo = 'proyecto' AND id LIKE 'P-%'"
        )
        .first<{ m: number | null }>();
      const id = "P-" + String((fila?.m ?? 0) + 1).padStart(3, "0");
      await crearNodo(db, {
        id,
        tipo: "proyecto",
        titulo: args.nombre,
        cuerpo: args.descripcion ?? "",
        estado: args.estado ?? "planificacion",
        etiquetas: args.tags ?? [],
        extra: {
          progreso: args.progreso ?? 0,
          proximoPaso: args.proximoPaso ?? "",
          notas: args.notas ?? "",
          roadmap: []
        }
      });
      return await obtenerProyectoLegacy(db, id);
    }

    case "cdp_add_task": {
      await exigirProyecto(args.id);
      const col = (args.column ?? "porHacer") as Columna;
      if (!["porHacer", "enCurso", "hecho"].includes(col)) throw new Error("Invalid column");
      await crearNodo(db, {
        tipo: "tarea",
        titulo: args.text,
        estado: col,
        proyecto: args.id,
        agente: args.agente ?? null
      });
      return { added: args.text, column: col, project: args.id };
    }

    case "cdp_complete_task": {
      await exigirProyecto(args.id);
      const from = (args.from ?? "enCurso") as Columna;
      const i = args.index;
      if (typeof i !== "number") throw new Error(`Task index ${i} not found in ${from}`);
      // El índice es base-0 dentro de la columna origen, como siempre. Aquí se
      // resuelve contra las tareas ordenadas por `orden`, que es el mismo orden
      // que ve la web.
      const lista = await tareasDeColumna(db, args.id, from);
      const tarea = lista[i];
      if (!tarea) throw new Error(`Task index ${i} not found in ${from}`);
      await actualizarNodo(db, tarea.id, { estado: "hecho", orden: null });
      return { completed: tarea.titulo, project: args.id };
    }

    case "cdp_add_roadmap": {
      const p = await exigirProyecto(args.id);
      const roadmap = Array.isArray(p.extra.roadmap) ? p.extra.roadmap : [];
      roadmap.push({ fecha: args.fecha, texto: args.texto, estado: args.estado ?? "future" });
      await actualizarNodo(db, args.id, { extra: { roadmap } });
      return { added: args.texto, project: args.id };
    }

    case "cdp_delete_project": {
      const p = await exigirProyecto(args.id);
      // Las tareas, sesiones y notas del proyecto caen con él por ON DELETE CASCADE.
      await borrarNodo(db, args.id);
      return { deleted: args.id, nombre: p.titulo };
    }

    // ---- Segundo cerebro ----

    case "cdp_search": {
      const nodos = await buscar(db, String(args.q ?? ""), {
        tipo: args.tipo,
        limite: args.limite
      });
      return nodos.map(n => ({
        id: n.id,
        tipo: n.tipo,
        subtipo: n.extra?.subtipo ?? null,
        titulo: n.titulo,
        proyecto: n.proyecto,
        etiquetas: n.etiquetas,
        extracto: n.cuerpo.length > 400 ? n.cuerpo.slice(0, 400) + "..." : n.cuerpo
      }));
    }

    case "cdp_get_node": {
      const n = await obtenerNodo(db, args.id);
      if (!n) throw new Error(`Node ${args.id} not found`);
      return { ...n, enlaces: await enlacesDe(db, args.id) };
    }

    case "cdp_upsert_node": {
      const entrada = {
        tipo: args.tipo,
        titulo: args.titulo,
        cuerpo: args.cuerpo ?? "",
        estado: args.estado ?? null,
        proyecto: args.proyecto || null,
        extra: args.extra ?? {},
        etiquetas: args.etiquetas ?? [],
        agente: args.agente ?? null
      };
      const nodo = args.id
        ? (await actualizarNodo(db, args.id, entrada)) ?? (await crearNodo(db, { ...entrada, id: args.id }))
        : await crearNodo(db, entrada);
      const enlaces = await sincronizarEnlacesDelCuerpo(db, nodo.id, entrada.cuerpo);
      return { ...nodo, enlacesCreados: enlaces };
    }

    case "cdp_link": {
      await enlazar(db, args.origen, args.destino, args.tipo ?? "menciona");
      return { origen: args.origen, destino: args.destino, tipo: args.tipo ?? "menciona" };
    }

    case "cdp_capture": {
      const nodo = await crearNodo(db, {
        tipo: "captura",
        titulo: args.texto,
        estado: "sinClasificar",
        proyecto: args.proyecto || null,
        extra: { via: args.via ?? "agente" }
      });
      return { id: nodo.id, capturado: nodo.titulo, via: nodo.extra.via };
    }

    case "cdp_log_session": {
      await exigirProyecto(args.proyecto);
      const fecha = args.fecha ?? new Date().toISOString().slice(0, 10);
      const nodo = await crearNodo(db, {
        tipo: "sesion",
        titulo: `${fecha} · ${args.proyecto}`,
        cuerpo: args.texto,
        proyecto: args.proyecto,
        agente: args.agente ?? "claude-code",
        extra: { fecha }
      });
      await sincronizarEnlacesDelCuerpo(db, nodo.id, args.texto);
      return { id: nodo.id, proyecto: args.proyecto, fecha };
    }

    case "cdp_list_notes": {
      const notas = await nodosPorTipo(db, "nota", { proyecto: args.proyecto });
      const filtradas = args.subtipo
        ? notas.filter(n => n.extra?.subtipo === args.subtipo)
        : notas;
      return filtradas.slice(0, Math.min(args.limite ?? 100, 200)).map(n => ({
        id: n.id,
        subtipo: n.extra?.subtipo ?? null,
        titulo: n.titulo,
        descripcion: n.extra?.descripcion ?? "",
        proyecto: n.proyecto,
        etiquetas: n.etiquetas
      }));
    }

    case "cdp_backup_drive": {
      if (!env.SA_KEY || !env.DRIVE_FILE_ID) throw new Error("Drive no configurado (falta SA_KEY o DRIVE_FILE_ID)");
      const saKey: SAKey = JSON.parse(env.SA_KEY);
      const token = await getAccessToken(saKey);
      const fileId = await findCanonicalFileId(token, env.DRIVE_FILE_ID);
      const proyectos = await nodosPorTipo(db, "proyecto", { incluirArchivados: true });
      const salida = [];
      for (const p of proyectos) {
        const tareas = await nodosPorTipo(db, "tarea", { proyecto: p.id, incluirArchivados: true });
        salida.push(proyectoALegacy(p, tareas));
      }
      await writeDriveFile(token, fileId, {
        proyectos: salida,
        updated: new Date().toISOString(),
        origen: "copia de seguridad desde D1; la fuente de verdad es D1"
      });
      return { respaldados: salida.length, fileId };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- JSON-RPC dispatch ----------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

// Respuesta con cuerpo + el status HTTP que le corresponde. La era moderna
// mapea ciertos errores JSON-RPC a status concretos (400 version/cabeceras,
// 404 metodo desconocido); la legacy siempre va 200.
interface RpcOutcome {
  body: any | null;
  status: number;
}

const NO_BODY: RpcOutcome = { body: null, status: 202 };

// Versión declarada por el request: `params._meta` manda, la cabecera es
// espejo. Las YYYY-MM-DD se comparan como strings sin problema.
function requestedVersion(req: RpcRequest, headerVersion: string | null): string | null {
  return req?.params?._meta?.[META_VERSION] ?? headerVersion ?? null;
}

function isModernRequest(req: RpcRequest, headerVersion: string | null): boolean {
  if (req?.method === "server/discover") return true;
  const v = requestedVersion(req, headerVersion);
  return !!v && v >= MODERN_VERSION;
}

function rpcError(id: any, code: number, message: string, data?: any, status = 200): RpcOutcome {
  return {
    body: { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } },
    status
  };
}

// Envuelve un result: la era moderna exige `resultType` y recomienda
// identificarse en `_meta`; la legacy lo deja tal cual.
function rpcResult(id: any, result: any, modern: boolean, cache?: typeof LIST_CACHE): RpcOutcome {
  if (!modern) return { body: { jsonrpc: "2.0", id, result }, status: 200 };
  return {
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        ...result,
        ...(cache ?? {}),
        _meta: { [META_SERVER_INFO]: SERVER_INFO }
      }
    },
    status: 200
  };
}

async function handleRpc(
  req: RpcRequest,
  env: Env,
  headerVersion: string | null
): Promise<RpcOutcome> {
  const { method, params, id } = req;
  const modern = isModernRequest(req, headerVersion);
  const version = requestedVersion(req, headerVersion);

  // Version desconocida en un request moderno → el cliente debe reintentar con
  // una de las nuestras. `initialize` NO pasa por aqui: ahi la negociacion es
  // por eco de version, no por error.
  if (modern && version && !SUPPORTED_VERSIONS.includes(version)) {
    return rpcError(
      id,
      ERR_UNSUPPORTED_VERSION,
      "Unsupported protocol version",
      { supported: SUPPORTED_VERSIONS, requested: version },
      400
    );
  }

  // --- Era moderna: descubrimiento (obligatorio segun spec) ---
  if (method === "server/discover") {
    return rpcResult(
      id,
      {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS
      },
      true,
      LIST_CACHE
    );
  }

  // --- Era legacy: handshake ---
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    // Devolvemos la version pedida si la soportamos; si no, nuestra legacy por
    // defecto (el cliente decide si sigue o corta).
    const negotiated =
      typeof asked === "string" && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_DEFAULT;
    return {
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS
        }
      },
      status: 200
    };
  }

  if (method === "tools/list") {
    // Orden estable (array estatico): permite cachear en cliente y mejora el
    // hit del prompt cache del LLM.
    return rpcResult(id, { tools: TOOLS }, modern, modern ? LIST_CACHE : undefined);
  }

  if (method === "tools/call") {
    try {
      const result = await executeTool(params.name, params.arguments ?? {}, env);
      return rpcResult(
        id,
        { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        modern
      );
    } catch (e: any) {
      return rpcError(id, -32603, e.message ?? String(e));
    }
  }

  // Notificaciones: sin cuerpo. `ping` desaparece en la era moderna pero lo
  // seguimos tolerando (clientes legacy lo usan como keepalive).
  if (method.startsWith("notifications/") || method === "ping") return NO_BODY;

  // Metodo desconocido: en moderna va 404 con el error JSON-RPC dentro, que es
  // justo lo que distingue "servidor moderno" de "endpoint inexistente".
  return rpcError(id, -32601, `Method not found: ${method}`, undefined, modern ? 404 : 200);
}

// Decodifica el sentinel Base64 de la spec (`=?base64?...?=`) usado en
// Mcp-Name / Mcp-Param-* cuando el valor no es ASCII seguro.
function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return decodeURIComponent(escape(atob(m[1])));
  } catch {
    return v;
  }
}

// Validación de cabeceras espejo (Mcp-Method / Mcp-Name / MCP-Protocol-Version).
// Deliberadamente PERMISIVA: solo rechazamos si la cabecera viene y NO cuadra
// con el cuerpo. La spec pide rechazar tambien si falta, pero eso rompe a
// clientes modernos poco rigurosos y aqui no hay balanceador que enrute por
// cabecera, que es el riesgo que la regla estricta cubre.
function headerMismatch(req: RpcRequest, request: Request): string | null {
  const hMethod = request.headers.get("Mcp-Method");
  if (hMethod && hMethod !== req.method) {
    return `Mcp-Method header value '${hMethod}' does not match body value '${req.method}'`;
  }
  const hName = request.headers.get("Mcp-Name");
  if (hName) {
    const bodyName = req.params?.name ?? req.params?.uri;
    const decoded = decodeHeaderValue(hName);
    if (bodyName && decoded !== bodyName) {
      return `Mcp-Name header value '${decoded}' does not match body value '${bodyName}'`;
    }
  }
  const hVersion = request.headers.get("MCP-Protocol-Version");
  const metaVersion = req.params?._meta?.[META_VERSION];
  if (hVersion && metaVersion && hVersion !== metaVersion) {
    return `MCP-Protocol-Version header value '${hVersion}' does not match body value '${metaVersion}'`;
  }
  return null;
}

// ---------- HTTP entrypoints ----------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400"
};

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const expected = `Bearer ${env.MCP_SECRET}`;
  return auth === expected;
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // SA_KEY y DRIVE_FILE_ID ya no son obligatorios: solo los usa la copia de
  // seguridad. Lo que no puede faltar es el binding de D1.
  if (!env.MCP_SECRET || !env.CDP) {
    return new Response(
      JSON.stringify({
        error: "missing-env",
        missing: { MCP_SECRET: !env.MCP_SECRET, CDP: !env.CDP }
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!checkAuth(request, env)) return unauthorized();

  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid-json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const requests = Array.isArray(body) ? body : [body];
  const modernBatch = requests.some(r => isModernRequest(r, headerVersion));

  // Cabeceras espejo: si vienen y no cuadran con el cuerpo → 400 + -32020.
  for (const r of requests) {
    const mismatch = headerMismatch(r, request);
    if (mismatch) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: r?.id ?? null,
          error: { code: ERR_HEADER_MISMATCH, message: `Header mismatch: ${mismatch}` }
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  }

  // Sesiones: solo era legacy. En la moderna no se emiten ni se hacen eco.
  const isInitialize = requests.some(r => r?.method === "initialize");
  const sessionId = modernBatch
    ? null
    : isInitialize
      ? crypto.randomUUID()
      : request.headers.get("Mcp-Session-Id") || crypto.randomUUID();
  const sessionHeader = sessionId ? { "Mcp-Session-Id": sessionId } : {};

  // Serializar (no Promise.all): si un batch trae varias mutaciones, cada
  // executeTool hace read-modify-write sobre el MISMO fichero de Drive; en
  // paralelo se pisarían entre ellas (last-writer-wins). En secuencia cada una
  // ve lo que escribió la anterior. Los batches son raros (y en la era moderna
  // ya no existen: un POST = un mensaje) pero esto los blinda.
  const outcomes: RpcOutcome[] = [];
  for (const r of requests) {
    outcomes.push(await handleRpc(r, env, headerVersion));
  }
  const filtered = outcomes.filter(o => o.body !== null);

  // Solo notificaciones: 202 sin cuerpo
  if (filtered.length === 0) {
    return new Response(null, { status: 202, headers: { ...CORS_HEADERS, ...sessionHeader } });
  }

  const responseBody = Array.isArray(body) ? filtered.map(o => o.body) : filtered[0].body;
  // El status distinto de 200 solo tiene sentido con una respuesta única; un
  // batch (siempre legacy) va 200 y el error viaja dentro de cada elemento.
  const status = Array.isArray(body) ? 200 : filtered[0].status;

  // Podríamos abrir un SSE por request, pero JSON plano es válido por spec en
  // ambas eras cuando no hay notificaciones intermedias que emitir.
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...sessionHeader,
      ...CORS_HEADERS
    }
  });
};

// GET handler:
//   - If Accept includes text/event-stream → return long-lived SSE stream
//   - Otherwise → return health JSON
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const accept = request.headers.get("Accept") || "";
  const wantsSse = accept.includes("text/event-stream");

  if (wantsSse) {
    if (!checkAuth(request, env)) return unauthorized();

    const sessionId = request.headers.get("Mcp-Session-Id") || crypto.randomUUID();
    const enc = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        // Send a comment immediately so the client knows we're alive.
        controller.enqueue(enc.encode(": connected\n\n"));
        // Keep-alive ping every 25s. Cloudflare Workers SSE has a max
        // duration of ~30s for free / 5min on paid; we can't keep this
        // open forever, but pings during the window prevent timeouts.
        const interval = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keepalive " + Date.now() + "\n\n"));
          } catch {
            clearInterval(interval);
          }
        }, 25000);
        // Note: there's no built-in "abort" notification on the stream
        // here; the client closing will drop the response naturally.
      },
      cancel() {
        // client disconnected
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Mcp-Session-Id": sessionId,
        ...CORS_HEADERS
      }
    });
  }

  // Plain GET — health/discovery
  return new Response(
    JSON.stringify({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      transport: "Streamable HTTP (dual-era)",
      supportedVersions: SUPPORTED_VERSIONS,
      modernVersion: MODERN_VERSION,
      methods: ["server/discover", "initialize", "tools/list", "tools/call"],
      tools: TOOLS.map(t => t.name),
      storage: "Cloudflare D1 (binding CDP). Drive queda como copia de seguridad via cdp_backup_drive.",
      configured: {
        MCP_SECRET: !!env.MCP_SECRET,
        CDP: !!env.CDP,
        SA_KEY: !!env.SA_KEY,
        DRIVE_FILE_ID: !!env.DRIVE_FILE_ID
      }
    }, null, 2),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
};

// DELETE: spec says client may DELETE to close session. Just 200.
export const onRequestDelete: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};
