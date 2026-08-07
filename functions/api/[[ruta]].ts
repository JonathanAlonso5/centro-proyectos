// API de la web del CdP. La SPA ya no habla con Google Drive: habla con esto,
// que habla con D1 a través de functions/lib/db.ts.
//
// Autenticación: el mismo Bearer MCP_SECRET que el MCP. Es un panel de una sola
// persona; el secreto se escribe una vez y se guarda en el navegador.

import {
  actualizarNodo,
  borrarNodo,
  buscar,
  crearNodo,
  enlacesDe,
  enlazar,
  nodosPorTipo,
  obtenerNodo,
  ordenEntre,
  sincronizarEnlacesDelCuerpo,
  type Columna,
  type Nodo
} from "../lib/db";

import { CLIENTE_GOOGLE, correosPermitidos, emitirSesion, quienEs, verificarGoogle } from "../lib/auth";

interface Env {
  CDP: D1Database;
  MCP_SECRET: string;
  // Correos con acceso, separados por comas. Sin definir, el de Jonathan.
  CDP_CORREOS?: string;
}

const CABECERAS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type"
};

const json = (datos: unknown, status = 200) =>
  new Response(JSON.stringify(datos), { status, headers: CABECERAS });

// Cuántas tareas hechas se enseñan en el tablero. El resto sigue en la base y
// se busca, pero no ensucia la columna: P-005 arrastra 88 y el conjunto pasa
// de 700.
const HECHAS_VISIBLES = 20;

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CABECERAS });

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CABECERAS });

  const trozos = ([] as string[]).concat(params.ruta ?? []);
  const ruta = trozos[0] ?? "";
  const url = new URL(request.url);
  const cuerpo =
    request.method === "POST" ? await request.json().catch(() => ({} as any)) : ({} as any);

  // Entrar con Google es lo único que va sin credencial: es lo que la crea.
  if (ruta === "sesion") {
    if (!env.MCP_SECRET) return json({ error: "el servidor no tiene MCP_SECRET configurado" }, 500);
    try {
      const persona = await verificarGoogle(String(cuerpo.credencial ?? ""), correosPermitidos(env));
      const sesion = await emitirSesion(persona, env.MCP_SECRET);
      return json({ ...sesion, correo: persona.correo, nombre: persona.nombre });
    } catch (e: any) {
      return json({ error: e?.message ?? "no se ha podido verificar la cuenta" }, 401);
    }
  }

  // El navegador necesita saber con qué cliente pedirle el token a Google.
  if (ruta === "config") {
    return json({ clienteGoogle: CLIENTE_GOOGLE });
  }

  if (!env.CDP) return json({ error: "sin base de datos: falta el binding CDP" }, 500);

  const quien = env.MCP_SECRET ? await quienEs(request, env.MCP_SECRET) : null;
  if (!quien) return json({ error: "sin acceso" }, 401);

  const db = env.CDP;

  try {
    switch (ruta) {
      // Todo lo que la app necesita para pintarse, en una sola llamada: en el
      // móvil, cuatro peticiones encadenadas se notan.
      case "estado":
        return json(await estado(db));

      case "proyecto":
        return json(await fichaProyecto(db, trozos[1]));

      case "nodo": {
        if (request.method === "POST") return json(await guardarNodo(db, cuerpo));
        const n = await obtenerNodo(db, trozos[1]);
        if (!n) return json({ error: "no existe" }, 404);
        return json({ ...n, enlaces: await enlacesDe(db, n.id) });
      }

      case "mover":
        return json(await mover(db, cuerpo));

      case "capturar": {
        const texto = String(cuerpo.texto ?? "").trim();
        if (!texto) return json({ error: "hace falta texto" }, 400);
        const nodo = await crearNodo(db, {
          tipo: "captura",
          titulo: texto,
          // El correo trae texto de sobra: el asunto va al título y el resto
          // al cuerpo, para no perderlo ni convertir el título en un ladrillo.
          cuerpo: String(cuerpo.cuerpo ?? ""),
          estado: "sinClasificar",
          extra: { via: cuerpo.via ?? "pwa" }
        });
        return json({ ...nodo, sugerencia: await sugerirProyecto(db, texto) });
      }

      case "clasificar":
        return json(await clasificar(db, cuerpo));

      case "buscar":
        return json(
          await buscar(db, url.searchParams.get("q") ?? "", {
            tipo: (url.searchParams.get("tipo") as any) || undefined,
            limite: Number(url.searchParams.get("limite") ?? 30)
          })
        );

      case "notas": {
        const subtipo = url.searchParams.get("subtipo");
        const notas = await nodosPorTipo(db, "nota", {
          proyecto: url.searchParams.get("proyecto") ?? undefined
        });
        return json(subtipo ? notas.filter(n => n.extra?.subtipo === subtipo) : notas);
      }

      case "borrar": {
        const ok = await borrarNodo(db, cuerpo.id);
        return json({ borrado: ok ? cuerpo.id : null });
      }

      case "archivar":
        return json(await actualizarNodo(db, cuerpo.id, { archivado: cuerpo.archivado ? 1 : 0 }));

      default:
        return json({ error: `ruta desconocida: ${ruta}` }, 404);
    }
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
};

// ---------- estado general ----------

async function estado(db: D1Database) {
  const proyectos = await nodosPorTipo(db, "proyecto", { incluirArchivados: true });

  // Conteos por proyecto y columna de una sola pasada, en vez de una consulta
  // por proyecto.
  const { results: conteos } = await db
    .prepare(
      `SELECT proyecto, estado, COUNT(*) AS n FROM nodes
       WHERE tipo = 'tarea' GROUP BY proyecto, estado`
    )
    .all();
  const porProyecto = new Map<string, Record<string, number>>();
  for (const c of conteos as any[]) {
    const m = porProyecto.get(c.proyecto) ?? {};
    m[c.estado] = c.n;
    porProyecto.set(c.proyecto, m);
  }

  // Tareas del tablero global: todo lo pendiente, y de lo hecho solo lo último.
  const { results: pendientes } = await db
    .prepare(
      `SELECT * FROM nodes WHERE tipo = 'tarea' AND estado IN ('porHacer','enCurso')
       ORDER BY orden IS NULL, orden ASC, creado ASC`
    )
    .all();
  const { results: hechas } = await db
    .prepare(
      `SELECT * FROM nodes WHERE tipo = 'tarea' AND estado = 'hecho'
       ORDER BY modificado DESC LIMIT ?`
    )
    .bind(HECHAS_VISIBLES)
    .all();
  const totalHechas = await db
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE tipo = 'tarea' AND estado = 'hecho'")
    .first<{ n: number }>();

  const { results: capturas } = await db
    .prepare(
      `SELECT * FROM nodes WHERE tipo = 'captura' AND estado = 'sinClasificar'
       ORDER BY creado DESC LIMIT 50`
    )
    .all();

  const totalNotas = await db
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE tipo = 'nota' AND archivado = 0")
    .first<{ n: number }>();

  return {
    proyectos: proyectos.map(p => ({
      id: p.id,
      titulo: p.titulo,
      estado: p.estado,
      progreso: Number(p.extra.progreso ?? 0),
      proximoPaso: String(p.extra.proximoPaso ?? ""),
      etiquetas: p.etiquetas ?? [],
      orden: p.orden,
      conteos: porProyecto.get(p.id) ?? {}
    })),
    tareas: [...(pendientes as any[]), ...(hechas as any[])].map(aTarjeta),
    capturas: (capturas as any[]).map(aTarjeta),
    contadores: {
      hechasOcultas: Math.max(0, (totalHechas?.n ?? 0) - HECHAS_VISIBLES),
      notas: totalNotas?.n ?? 0,
      capturas: (capturas as any[]).length
    }
  };
}

function aTarjeta(fila: any) {
  let extra: any = {};
  try {
    extra = JSON.parse(fila.extra || "{}");
  } catch { /* extra corrupto: se ignora, no se cae la vista */ }
  return {
    id: fila.id,
    titulo: fila.titulo,
    cuerpo: fila.cuerpo,
    estado: fila.estado,
    proyecto: fila.proyecto,
    orden: fila.orden,
    agente: fila.agente,
    archivado: fila.archivado,
    modificado: fila.modificado,
    extra
  };
}

// ---------- ficha de proyecto ----------

async function fichaProyecto(db: D1Database, id: string) {
  const p = await obtenerNodo(db, id);
  if (!p) return { error: "no existe" };
  const [tareas, sesiones, notas] = await Promise.all([
    nodosPorTipo(db, "tarea", { proyecto: id, incluirArchivados: true }),
    nodosPorTipo(db, "sesion", { proyecto: id }),
    nodosPorTipo(db, "nota", { proyecto: id })
  ]);
  return {
    proyecto: p,
    tareas,
    // Las sesiones se leen de la más nueva a la más vieja: es un diario.
    sesiones: sesiones.sort((a, b) =>
      String(b.extra?.fecha ?? b.creado).localeCompare(String(a.extra?.fecha ?? a.creado))
    ),
    notas,
    enlaces: await enlacesDe(db, id)
  };
}

// ---------- escritura ----------

// Guardado PARCIAL: solo se tocan los campos que vienen en la petición. Si se
// copiaran todos con valores por defecto, editar el progreso desde la ficha
// borraría el cuerpo y el estado del nodo.
const CAMPOS_WEB = ["tipo", "titulo", "cuerpo", "estado", "proyecto", "extra", "etiquetas", "agente"];

async function guardarNodo(db: D1Database, cuerpo: any) {
  const entrada: any = {};
  for (const campo of CAMPOS_WEB) {
    if (cuerpo[campo] !== undefined) entrada[campo] = cuerpo[campo];
  }
  if (entrada.proyecto === "") entrada.proyecto = null;

  let nodo: Nodo | null;
  if (cuerpo.id) {
    nodo = await actualizarNodo(db, cuerpo.id, entrada);
  } else {
    if (!entrada.tipo || !entrada.titulo) return { error: "hacen falta tipo y titulo" };
    nodo = await crearNodo(db, entrada);
  }
  if (!nodo) return { error: "no existe" };
  if (entrada.cuerpo) await sincronizarEnlacesDelCuerpo(db, nodo.id, entrada.cuerpo);
  return nodo;
}

// Mover una tarjeta: el orden es el punto medio entre las dos vecinas. Nunca se
// renumera la columna, que es lo que provoca que dos escritores se pisen.
async function mover(db: D1Database, cuerpo: any) {
  const { id, estado } = cuerpo;
  const nodo = await obtenerNodo(db, id);
  if (!nodo) return { error: "no existe" };

  const ordenDe = async (otro: string | null) => {
    if (!otro) return null;
    const n = await obtenerNodo(db, otro);
    return n?.orden ?? null;
  };
  const anterior = await ordenDe(cuerpo.antes ?? null);
  const siguiente = await ordenDe(cuerpo.despues ?? null);

  const cambios: any = { orden: ordenEntre(anterior, siguiente) };
  if (estado && estado !== nodo.estado) cambios.estado = estado;
  // Una tarea que vuelve del archivo al tablero deja de estar archivada.
  if (nodo.archivado && estado && estado !== "hecho") cambios.archivado = 0;
  return await actualizarNodo(db, id, cambios);
}

// ---------- bandeja ----------

// Sugerir destino sin IA: por id de proyecto mencionado y por etiquetas que ya
// existen. Si hay que esperar a un modelo, deja de ser captura rápida.
async function sugerirProyecto(db: D1Database, texto: string): Promise<string | null> {
  const mencion = /\bP-\d{3}\b/.exec(texto);
  if (mencion) return mencion[0];
  const palabras = texto.toLowerCase().split(/[^a-záéíóúñ0-9]+/).filter(p => p.length > 3);
  if (!palabras.length) return null;
  const huecos = palabras.slice(0, 20).map(() => "?").join(",");
  const fila = await db
    .prepare(
      `SELECT e.nodo, COUNT(*) AS n FROM etiquetas e
       JOIN nodes n ON n.id = e.nodo AND n.tipo = 'proyecto'
       WHERE e.etiqueta IN (${huecos}) GROUP BY e.nodo ORDER BY n DESC LIMIT 1`
    )
    .bind(...palabras.slice(0, 20))
    .first<{ nodo: string }>();
  return fila?.nodo ?? null;
}

async function clasificar(db: D1Database, cuerpo: any) {
  const captura = await obtenerNodo(db, cuerpo.id);
  if (!captura) return { error: "no existe" };

  if (cuerpo.destino === "descartar") {
    return await actualizarNodo(db, captura.id, { estado: "descartada", archivado: 1 });
  }

  const nuevo = await crearNodo(db, {
    tipo: cuerpo.destino === "nota" ? "nota" : "tarea",
    titulo: captura.titulo,
    cuerpo: captura.cuerpo,
    estado: cuerpo.destino === "nota" ? null : "porHacer",
    proyecto: cuerpo.proyecto || null,
    extra: cuerpo.destino === "nota" ? { subtipo: cuerpo.subtipo ?? "project" } : {},
    agente: cuerpo.agente ?? "jonathan"
  });
  // La captura no se borra: se marca y se enlaza, para no perder de dónde salió
  // la cosa ni por qué vía entró.
  await actualizarNodo(db, captura.id, { estado: "clasificada", archivado: 1 });
  await enlazar(db, nuevo.id, captura.id, "deriva_de");
  return nuevo;
}
