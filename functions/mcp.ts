// MCP server for Centro de Proyectos
// Streamable HTTP transport (MCP spec 2025-03-26 + 2024-11-05 compat)
//
// POST /mcp with JSON-RPC body
//   - initialize: returns serverInfo and issues Mcp-Session-Id response header
//   - tools/list: returns the catalog
//   - tools/call: executes the tool
//   - notifications/*: returns 204
// GET /mcp with Accept: text/event-stream
//   - Returns a long-lived SSE stream (used by mcp-remote / Claude Desktop bridge
//     to keep the connection alive and receive server-initiated messages)
// GET /mcp without that Accept
//   - Returns metadata as application/json (health check)

interface Env {
  SA_KEY: string;
  DRIVE_FILE_ID: string;
  MCP_SECRET: string;
}

const PROTOCOL_VERSION = "2024-11-05";
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

async function executeTool(name: string, args: any, env: Env): Promise<any> {
  const saKey: SAKey = JSON.parse(env.SA_KEY);
  const token = await getAccessToken(saKey);
  // Resolve the canonical fileId at request time: pick the most recent file
  // with the canonical name, falling back to DRIVE_FILE_ID. This keeps the
  // MCP in sync with the web (which also reads "most recent by name") even
  // if the legacy skill creates duplicate files via create_file.
  const fileId = await findCanonicalFileId(token, env.DRIVE_FILE_ID);
  const file = await readDriveFile(token, fileId);
  if (!Array.isArray(file.proyectos)) throw new Error("Invalid data file: proyectos missing");

  const findProject = (id: string) => {
    const idx = file.proyectos.findIndex((p: any) => p.id === id);
    if (idx < 0) throw new Error(`Project ${id} not found`);
    return idx;
  };

  switch (name) {
    case "cdp_list_projects":
      return file.proyectos.map((p: any) => ({
        id: p.id,
        nombre: p.nombre,
        estado: p.estado,
        progreso: p.progreso,
        proximoPaso: p.proximoPaso,
        tags: p.tags
      }));

    case "cdp_get_project":
      return file.proyectos[findProject(args.id)];

    case "cdp_update_project": {
      const idx = findProject(args.id);
      const allowed = ["nombre", "descripcion", "estado", "progreso", "proximoPaso", "notas", "tags"];
      for (const k of allowed) {
        if (args[k] !== undefined) file.proyectos[idx][k] = args[k];
      }
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return file.proyectos[idx];
    }

    case "cdp_create_project": {
      const next = (file.proyectos.length + 1).toString().padStart(3, "0");
      const newP = {
        id: "P-" + next,
        nombre: args.nombre,
        descripcion: args.descripcion ?? "",
        estado: args.estado ?? "planificacion",
        progreso: args.progreso ?? 0,
        proximoPaso: args.proximoPaso ?? "",
        tags: args.tags ?? [],
        tareas: { porHacer: [], enCurso: [], hecho: [] },
        roadmap: [],
        notas: args.notas ?? "",
        creado: new Date().toISOString()
      };
      file.proyectos.push(newP);
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return newP;
    }

    case "cdp_add_task": {
      const idx = findProject(args.id);
      const p = file.proyectos[idx];
      if (!p.tareas) p.tareas = { porHacer: [], enCurso: [], hecho: [] };
      const col = (args.column ?? "porHacer") as "porHacer" | "enCurso" | "hecho";
      if (!["porHacer", "enCurso", "hecho"].includes(col)) throw new Error("Invalid column");
      p.tareas[col].push(args.text);
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return { added: args.text, column: col, project: args.id };
    }

    case "cdp_complete_task": {
      const idx = findProject(args.id);
      const p = file.proyectos[idx];
      if (!p.tareas) throw new Error("Project has no tasks");
      const from = (args.from ?? "enCurso") as "porHacer" | "enCurso";
      const i = args.index;
      if (typeof i !== "number" || !p.tareas[from] || !p.tareas[from][i]) {
        throw new Error(`Task index ${i} not found in ${from}`);
      }
      const task = p.tareas[from].splice(i, 1)[0];
      p.tareas.hecho.push(task);
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return { completed: task, project: args.id };
    }

    case "cdp_add_roadmap": {
      const idx = findProject(args.id);
      const p = file.proyectos[idx];
      if (!Array.isArray(p.roadmap)) p.roadmap = [];
      p.roadmap.push({
        fecha: args.fecha,
        texto: args.texto,
        estado: args.estado ?? "future"
      });
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return { added: args.texto, project: args.id };
    }

    case "cdp_delete_project": {
      const idx = findProject(args.id);
      const removed = file.proyectos.splice(idx, 1)[0];
      file.updated = new Date().toISOString();
      await writeDriveFile(token, fileId, file);
      return { deleted: args.id, nombre: removed?.nombre ?? null };
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

async function handleRpc(req: RpcRequest, env: Env): Promise<any | null> {
  const { method, params, id } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "centro-proyectos-mcp", version: "0.3.0" }
      }
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    try {
      const result = await executeTool(params.name, params.arguments ?? {}, env);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        }
      };
    } catch (e: any) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e.message ?? String(e) }
      };
    }
  }

  // Notifications: no response, but valid
  if (method.startsWith("notifications/") || method === "ping") return null;

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
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
  if (!env.MCP_SECRET || !env.SA_KEY || !env.DRIVE_FILE_ID) {
    return new Response(
      JSON.stringify({
        error: "missing-env",
        missing: { MCP_SECRET: !env.MCP_SECRET, SA_KEY: !env.SA_KEY, DRIVE_FILE_ID: !env.DRIVE_FILE_ID }
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

  // Detect initialize to issue session ID
  const requests = Array.isArray(body) ? body : [body];
  const isInitialize = requests.some(r => r?.method === "initialize");
  const sessionId = isInitialize
    ? crypto.randomUUID()
    : request.headers.get("Mcp-Session-Id") || crypto.randomUUID();

  const results = await Promise.all(requests.map(r => handleRpc(r, env)));
  const filtered = results.filter(r => r !== null);

  // No body for notifications-only requests
  if (filtered.length === 0) {
    return new Response(null, {
      status: 202,
      headers: { ...CORS_HEADERS, "Mcp-Session-Id": sessionId }
    });
  }

  const responseBody = Array.isArray(body) ? filtered : filtered[0];

  // If client accepts SSE, we COULD stream — but plain JSON works per spec
  // when there's a single response. Return JSON to keep it simple.
  return new Response(JSON.stringify(responseBody), {
    headers: {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
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
      name: "centro-proyectos-mcp",
      version: "0.3.0",
      transport: "Streamable HTTP",
      protocolVersion: PROTOCOL_VERSION,
      methods: ["initialize", "tools/list", "tools/call"],
      tools: TOOLS.map(t => t.name),
      fileResolution: "by-name (most recent non-trashed file named " + DATA_FILE_NAME + "); DRIVE_FILE_ID used only as fallback",
      configured: {
        MCP_SECRET: !!env.MCP_SECRET,
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
