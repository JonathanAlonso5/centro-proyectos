// CdP · capa de datos. Es lo ÚNICO que habla SQL: el MCP y la API de la web
// llaman aquí. Si algo necesita una consulta nueva, se añade aquí, no allí.

export interface EntornoD1 {
  CDP: D1Database;
}

export type TipoNodo = "proyecto" | "tarea" | "nota" | "sesion" | "captura";
export type Columna = "porHacer" | "enCurso" | "hecho";

export interface Nodo {
  id: string;
  tipo: TipoNodo;
  titulo: string;
  cuerpo: string;
  estado: string | null;
  proyecto: string | null;
  orden: number | null;
  extra: Record<string, any>;
  agente: string | null;
  ejecucion: string | null;
  creado: string;
  modificado: string;
  archivado: number;
  huella: string | null;
  etiquetas?: string[];
}

const COLUMNAS: Columna[] = ["porHacer", "enCurso", "hecho"];

// ---------- utilidades ----------

export function ahora(): string {
  return new Date().toISOString();
}

// Ids cortos y legibles. El prefijo dice de un vistazo qué es la cosa.
const PREFIJO: Record<TipoNodo, string> = {
  proyecto: "P",
  tarea: "T",
  nota: "N",
  sesion: "S",
  captura: "C"
};

export function nuevoId(tipo: TipoNodo): string {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${PREFIJO[tipo]}-${hex}`;
}

// Huella del contenido, para que el sync de la memoria solo reescriba lo que
// cambió de verdad. No es criptográfica: es un detector de cambios.
export async function huellaDe(texto: string): Promise<string> {
  const datos = new TextEncoder().encode(texto);
  const buf = await crypto.subtle.digest("SHA-256", datos);
  return Array.from(new Uint8Array(buf).slice(0, 12))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseExtra(v: unknown): Record<string, any> {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function aNodo(fila: any): Nodo {
  return { ...fila, extra: parseExtra(fila.extra) } as Nodo;
}

// ---------- lectura de nodos ----------

export async function obtenerNodo(db: D1Database, id: string): Promise<Nodo | null> {
  const fila = await db.prepare("SELECT * FROM nodes WHERE id = ?").bind(id).first();
  if (!fila) return null;
  const nodo = aNodo(fila);
  nodo.etiquetas = await etiquetasDe(db, id);
  return nodo;
}

export async function etiquetasDe(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT etiqueta FROM etiquetas WHERE nodo = ? ORDER BY etiqueta")
    .bind(id)
    .all();
  return (results as any[]).map(r => r.etiqueta);
}

export async function etiquetasDeVarios(
  db: D1Database,
  ids: string[]
): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>();
  if (!ids.length) return mapa;
  // D1 topa en 100 parámetros por consulta, y un proyecto como P-005 pasa de
  // 200 tareas. Se trocea.
  const TROZO = 80;
  for (let i = 0; i < ids.length; i += TROZO) {
    const trozo = ids.slice(i, i + TROZO);
    const huecos = trozo.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT nodo, etiqueta FROM etiquetas WHERE nodo IN (${huecos}) ORDER BY etiqueta`)
      .bind(...trozo)
      .all();
    for (const r of results as any[]) {
      if (!mapa.has(r.nodo)) mapa.set(r.nodo, []);
      mapa.get(r.nodo)!.push(r.etiqueta);
    }
  }
  return mapa;
}

export async function nodosPorTipo(
  db: D1Database,
  tipo: TipoNodo,
  opts: { proyecto?: string; incluirArchivados?: boolean } = {}
): Promise<Nodo[]> {
  let sql = "SELECT * FROM nodes WHERE tipo = ?";
  const args: any[] = [tipo];
  if (opts.proyecto) {
    sql += " AND proyecto = ?";
    args.push(opts.proyecto);
  }
  if (!opts.incluirArchivados) sql += " AND archivado = 0";
  sql += " ORDER BY orden IS NULL, orden ASC, creado ASC";
  const { results } = await db.prepare(sql).bind(...args).all();
  const nodos = (results as any[]).map(aNodo);
  const etq = await etiquetasDeVarios(db, nodos.map(n => n.id));
  for (const n of nodos) n.etiquetas = etq.get(n.id) ?? [];
  return nodos;
}

// ---------- escritura de nodos ----------

export interface NodoEntrada {
  id?: string;
  tipo: TipoNodo;
  titulo: string;
  cuerpo?: string;
  estado?: string | null;
  proyecto?: string | null;
  orden?: number | null;
  extra?: Record<string, any>;
  agente?: string | null;
  ejecucion?: string | null;
  etiquetas?: string[];
  archivado?: number;
}

export async function crearNodo(db: D1Database, entrada: NodoEntrada): Promise<Nodo> {
  const id = entrada.id ?? nuevoId(entrada.tipo);
  const t = ahora();
  const cuerpo = entrada.cuerpo ?? "";
  const orden =
    entrada.orden ?? (entrada.tipo === "tarea" || entrada.tipo === "proyecto"
      ? await ordenAlFinal(db, entrada.tipo, entrada.estado ?? null, entrada.proyecto ?? null)
      : null);

  await db
    .prepare(
      `INSERT INTO nodes (id, tipo, titulo, cuerpo, estado, proyecto, orden, extra,
                          agente, ejecucion, creado, modificado, archivado, huella)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      entrada.tipo,
      entrada.titulo,
      cuerpo,
      entrada.estado ?? null,
      entrada.proyecto ?? null,
      orden,
      JSON.stringify(entrada.extra ?? {}),
      entrada.agente ?? null,
      entrada.ejecucion ?? null,
      t,
      t,
      entrada.archivado ?? 0,
      await huellaDe(entrada.titulo + "\n" + cuerpo)
    )
    .run();

  if (entrada.etiquetas?.length) await fijarEtiquetas(db, id, entrada.etiquetas);
  return (await obtenerNodo(db, id))!;
}

const CAMPOS_ACTUALIZABLES = [
  "titulo",
  "cuerpo",
  "estado",
  "proyecto",
  "orden",
  "agente",
  "ejecucion",
  "archivado"
] as const;

export async function actualizarNodo(
  db: D1Database,
  id: string,
  cambios: Partial<NodoEntrada>
): Promise<Nodo | null> {
  const actual = await obtenerNodo(db, id);
  if (!actual) return null;

  const sets: string[] = [];
  const args: any[] = [];
  for (const campo of CAMPOS_ACTUALIZABLES) {
    if ((cambios as any)[campo] !== undefined) {
      sets.push(`${campo} = ?`);
      args.push((cambios as any)[campo]);
    }
  }
  // extra se funde con lo que ya había: así una tool que solo toca `progreso`
  // no borra `roadmap` sin querer.
  if (cambios.extra !== undefined) {
    sets.push("extra = ?");
    args.push(JSON.stringify({ ...actual.extra, ...cambios.extra }));
  }

  const titulo = cambios.titulo ?? actual.titulo;
  const cuerpo = cambios.cuerpo ?? actual.cuerpo;
  sets.push("huella = ?");
  args.push(await huellaDe(titulo + "\n" + cuerpo));
  sets.push("modificado = ?");
  args.push(ahora());

  args.push(id);
  await db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();

  if (cambios.etiquetas !== undefined) await fijarEtiquetas(db, id, cambios.etiquetas);
  return await obtenerNodo(db, id);
}

export async function borrarNodo(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM nodes WHERE id = ?").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function fijarEtiquetas(db: D1Database, id: string, etiquetas: string[]): Promise<void> {
  const limpias = [...new Set(etiquetas.map(e => e.trim().toLowerCase()).filter(Boolean))];
  const ops: D1PreparedStatement[] = [
    db.prepare("DELETE FROM etiquetas WHERE nodo = ?").bind(id)
  ];
  for (const e of limpias) {
    ops.push(db.prepare("INSERT OR IGNORE INTO etiquetas (nodo, etiqueta) VALUES (?, ?)").bind(id, e));
  }
  await db.batch(ops);
}

// ---------- orden fraccional ----------
//
// Mover una tarjeta entre otras dos calcula el punto medio en vez de renumerar
// la columna entera. Con tres escritores (web, MCP, Telegram) renumerar índices
// es justo lo que provoca que se pisen.

async function ordenAlFinal(
  db: D1Database,
  tipo: TipoNodo,
  estado: string | null,
  proyecto: string | null
): Promise<number> {
  const fila = await db
    .prepare(
      `SELECT MAX(orden) AS m FROM nodes
       WHERE tipo = ? AND (estado IS ? OR estado = ?) AND (proyecto IS ? OR proyecto = ?)`
    )
    .bind(tipo, estado, estado, proyecto, proyecto)
    .first<{ m: number | null }>();
  return (fila?.m ?? 0) + 1;
}

export function ordenEntre(anterior: number | null, siguiente: number | null): number {
  if (anterior === null && siguiente === null) return 1;
  if (anterior === null) return (siguiente as number) - 1;
  if (siguiente === null) return anterior + 1;
  return (anterior + siguiente) / 2;
}

// ---------- proyectos: forma legacy ----------
//
// El MCP público sigue hablando el idioma de siempre (tareas como arrays de
// strings, roadmap como array de objetos). Aquí se traduce de nodos a esa forma
// y al revés. Cambiar esto rompe el bot de Telegram y los subagentes.

export interface ProyectoLegacy {
  id: string;
  nombre: string;
  descripcion: string;
  estado: string;
  progreso: number;
  proximoPaso: string;
  tags: string[];
  tareas: Record<Columna, string[]>;
  roadmap: any[];
  notas: string;
  creado: string;
}

export function proyectoALegacy(p: Nodo, tareas: Nodo[]): ProyectoLegacy {
  const porColumna: Record<Columna, string[]> = { porHacer: [], enCurso: [], hecho: [] };
  for (const t of tareas) {
    const col = (t.estado ?? "porHacer") as Columna;
    if (COLUMNAS.includes(col)) porColumna[col].push(t.titulo);
  }
  return {
    id: p.id,
    nombre: p.titulo,
    descripcion: p.cuerpo,
    estado: p.estado ?? "activo",
    progreso: Number(p.extra.progreso ?? 0),
    proximoPaso: String(p.extra.proximoPaso ?? ""),
    tags: p.etiquetas ?? [],
    tareas: porColumna,
    roadmap: Array.isArray(p.extra.roadmap) ? p.extra.roadmap : [],
    notas: String(p.extra.notas ?? ""),
    creado: p.creado
  };
}

export async function listarProyectos(db: D1Database): Promise<any[]> {
  const proyectos = await nodosPorTipo(db, "proyecto", { incluirArchivados: true });
  return proyectos.map(p => ({
    id: p.id,
    nombre: p.titulo,
    estado: p.estado,
    progreso: Number(p.extra.progreso ?? 0),
    proximoPaso: String(p.extra.proximoPaso ?? ""),
    tags: p.etiquetas ?? []
  }));
}

export async function obtenerProyectoLegacy(
  db: D1Database,
  id: string
): Promise<ProyectoLegacy | null> {
  const p = await obtenerNodo(db, id);
  if (!p || p.tipo !== "proyecto") return null;
  // Las tareas archivadas siguen contando para la forma legacy: el bot y los
  // subagentes esperan ver el histórico de 'hecho' que había en el JSON.
  const tareas = await nodosPorTipo(db, "tarea", { proyecto: id, incluirArchivados: true });
  return proyectoALegacy(p, tareas);
}

// Tareas de una columna, en orden. Es la lista contra la que se resuelven los
// índices base-0 que sigue usando cdp_complete_task.
export async function tareasDeColumna(
  db: D1Database,
  proyecto: string,
  columna: Columna
): Promise<Nodo[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM nodes WHERE tipo = 'tarea' AND proyecto = ? AND estado = ?
       ORDER BY orden IS NULL, orden ASC, creado ASC`
    )
    .bind(proyecto, columna)
    .all();
  return (results as any[]).map(aNodo);
}

// ---------- búsqueda ----------

export async function buscar(
  db: D1Database,
  consulta: string,
  opts: { tipo?: TipoNodo; limite?: number } = {}
): Promise<Nodo[]> {
  const limite = Math.min(opts.limite ?? 20, 100);
  const termino = prepararConsultaFts(consulta);
  if (!termino) return [];
  let sql = `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH ? AND n.archivado = 0`;
  const args: any[] = [termino];
  if (opts.tipo) {
    sql += " AND n.tipo = ?";
    args.push(opts.tipo);
  }
  sql += " ORDER BY bm25(nodes_fts) LIMIT ?";
  args.push(limite);
  const { results } = await db.prepare(sql).bind(...args).all();
  const nodos = (results as any[]).map(aNodo);
  const etq = await etiquetasDeVarios(db, nodos.map(n => n.id));
  for (const n of nodos) n.etiquetas = etq.get(n.id) ?? [];
  return nodos;
}

// FTS5 interpreta comillas, asteriscos y operadores. Un texto escrito a mano
// ("¿por qué falla el cron?") reventaría la consulta, así que lo troceamos en
// palabras y las unimos con AND, con prefijo en la última.
function prepararConsultaFts(consulta: string): string {
  const palabras = consulta
    .toLowerCase()
    .replace(/["'*^:()-]/g, " ")
    .split(/\s+/)
    .filter(p => p.length > 1);
  if (!palabras.length) return "";
  return palabras.map((p, i) => (i === palabras.length - 1 ? `"${p}"*` : `"${p}"`)).join(" AND ");
}

// ---------- enlaces ----------

export async function enlazar(
  db: D1Database,
  origen: string,
  destino: string,
  tipo = "menciona"
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO links (origen, destino, tipo) VALUES (?, ?, ?)")
    .bind(origen, destino, tipo)
    .run();
}

export async function enlacesDe(db: D1Database, id: string): Promise<{ salen: any[]; entran: any[] }> {
  const salen = await db
    .prepare(
      `SELECT l.tipo, n.id, n.titulo, n.tipo AS tipoNodo FROM links l
       JOIN nodes n ON n.id = l.destino WHERE l.origen = ?`
    )
    .bind(id)
    .all();
  const entran = await db
    .prepare(
      `SELECT l.tipo, n.id, n.titulo, n.tipo AS tipoNodo FROM links l
       JOIN nodes n ON n.id = l.origen WHERE l.destino = ?`
    )
    .bind(id)
    .all();
  return { salen: salen.results as any[], entran: entran.results as any[] };
}

// Los [[enlaces]] del cuerpo se convierten en filas de links. Se resuelven por
// id exacto o, si no, por título exacto (que es como se escriben en la memoria
// local: [[feedback_no_emdash]] es el nombre del fichero).
export async function sincronizarEnlacesDelCuerpo(
  db: D1Database,
  id: string,
  cuerpo: string
): Promise<number> {
  const nombres = [...cuerpo.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim());
  if (!nombres.length) return 0;
  let creados = 0;
  for (const nombre of [...new Set(nombres)]) {
    const destino = await db
      .prepare(
        `SELECT id FROM nodes WHERE id = ? OR titulo = ?
         OR json_extract(extra, '$.nombreMemoria') = ? LIMIT 1`
      )
      .bind(nombre, nombre, nombre)
      .first<{ id: string }>();
    if (destino?.id && destino.id !== id) {
      await enlazar(db, id, destino.id, "menciona");
      creados++;
    }
  }
  return creados;
}
