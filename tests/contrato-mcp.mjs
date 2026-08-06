#!/usr/bin/env node
// Pruebas de contrato del MCP.
//
// Comprueban que el servidor sobre D1 devuelve EXACTAMENTE lo mismo que el de
// Drive. De estas siete herramientas dependen el bot de Telegram del VPS
// (P-008) y los subagentes cdp-updater y docs-updater de tcgprecios: si una
// falla, no se despliega.
//
// La referencia es scripts/instantanea-drive.json, tomada de producción antes
// de migrar.
//
//   node tests/contrato-mcp.mjs                       # contra localhost:8788
//   node tests/contrato-mcp.mjs https://otro/mcp SECRETO

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_MCP = process.argv[2] ?? "http://127.0.0.1:8788/mcp";
const SECRETO = process.argv[3] ?? "local-test";

const referencia = JSON.parse(readFileSync(join(RAIZ, "scripts/instantanea-drive.json"), "utf8"));

let pasadas = 0;
const fallos = [];

function comprobar(nombre, condicion, detalle = "") {
  if (condicion) {
    pasadas++;
  } else {
    fallos.push(`${nombre}${detalle ? ": " + detalle : ""}`);
  }
}

function igualdad(nombre, actual, esperado) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(esperado);
  comprobar(nombre, a === e, a === e ? "" : `\n    esperado: ${e}\n    actual:   ${a}`);
}

async function tool(nombre, args = {}) {
  const res = await fetch(URL_MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRETO}`,
      "Content-Type": "application/json",
      "User-Agent": "curl/8.5.0"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: nombre, arguments: args }
    })
  });
  const cuerpo = await res.json();
  if (cuerpo.error) throw new Error(`${nombre}: ${cuerpo.error.message}`);
  return JSON.parse(cuerpo.result.content[0].text);
}

// Las etiquetas se normalizan a minúsculas al guardarlas, y el orden de una
// lista de etiquetas nunca ha significado nada.
const normEtiquetas = t => [...(t ?? [])].map(x => String(x).toLowerCase()).sort();

const main = async () => {
  console.log(`Contrato del MCP contra ${URL_MCP}\n`);

  // ---- 1. tools/list sigue anunciando las de siempre ----
  const listaRes = await fetch(URL_MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRETO}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  const { result } = await listaRes.json();
  const nombres = result.tools.map(t => t.name);
  for (const esperada of [
    "cdp_list_projects",
    "cdp_get_project",
    "cdp_update_project",
    "cdp_create_project",
    "cdp_add_task",
    "cdp_complete_task",
    "cdp_add_roadmap",
    "cdp_delete_project"
  ]) {
    comprobar(`tools/list expone ${esperada}`, nombres.includes(esperada));
  }

  // ---- 2. cdp_list_projects ----
  const listado = await tool("cdp_list_projects");
  comprobar(
    "cdp_list_projects devuelve los 19 proyectos",
    listado.length === referencia.proyectos.length,
    `${listado.length} vs ${referencia.proyectos.length}`
  );
  for (const esperado of referencia.proyectos) {
    const actual = listado.find(p => p.id === esperado.id);
    if (!actual) {
      fallos.push(`cdp_list_projects: falta ${esperado.id}`);
      continue;
    }
    igualdad(`${esperado.id} nombre`, actual.nombre, esperado.nombre);
    igualdad(`${esperado.id} estado`, actual.estado, esperado.estado);
    igualdad(`${esperado.id} progreso`, actual.progreso, esperado.progreso);
    igualdad(`${esperado.id} proximoPaso`, actual.proximoPaso, esperado.proximoPaso);
    igualdad(`${esperado.id} tags`, normEtiquetas(actual.tags), normEtiquetas(esperado.tags));
    // El listado NO debe traer las tareas: son kilobytes por proyecto y el
    // contrato de siempre es un resumen.
    comprobar(`${esperado.id} el listado no arrastra tareas`, actual.tareas === undefined);
  }

  // ---- 3. cdp_get_project, campo a campo ----
  // El JSON de Drive arrastra huecos: P-003 tiene 7 nulls dentro de porHacer,
  // seguramente de algún borrado por índice de hace tiempo. Un null no es una
  // tarea, así que la migración los tira. Se cuentan aquí para que quede a la
  // vista en vez de desaparecer sin más.
  let huecos = 0;
  for (const p of referencia.proyectos) {
    for (const col of ["porHacer", "enCurso", "hecho"]) {
      huecos += ((p.tareas ?? {})[col] ?? []).filter(t => typeof t !== "string" || !t.trim()).length;
    }
  }
  if (huecos) console.log(`  (la instantánea de Drive traía ${huecos} huecos vacíos en las tareas; se descartan)\n`);
  const soloTareas = lista => (lista ?? []).filter(t => typeof t === "string" && t.trim());

  for (const esperado of referencia.proyectos) {
    const actual = await tool("cdp_get_project", { id: esperado.id });
    igualdad(`${esperado.id} descripcion`, actual.descripcion, esperado.descripcion ?? "");
    igualdad(`${esperado.id} notas`, actual.notas, esperado.notas ?? "");
    igualdad(`${esperado.id} roadmap`, actual.roadmap, esperado.roadmap ?? []);
    for (const col of ["porHacer", "enCurso", "hecho"]) {
      const esp = soloTareas((esperado.tareas ?? {})[col]);
      const act = (actual.tareas ?? {})[col] ?? [];
      igualdad(`${esperado.id} tareas.${col}`, act, esp);
    }
  }

  // ---- 4. Mutaciones: crear, tareas, roadmap, actualizar, borrar ----
  const creado = await tool("cdp_create_project", {
    nombre: "PRUEBA contrato",
    descripcion: "Proyecto de usar y tirar",
    tags: ["prueba"]
  });
  comprobar("cdp_create_project devuelve un id P-NNN", /^P-\d{3}$/.test(creado.id), creado.id);
  igualdad("cdp_create_project estado por defecto", creado.estado, "planificacion");
  igualdad("cdp_create_project tareas vacías", creado.tareas, {
    porHacer: [],
    enCurso: [],
    hecho: []
  });
  const idPrueba = creado.id;

  const anadida = await tool("cdp_add_task", { id: idPrueba, text: "primera" });
  igualdad("cdp_add_task forma de respuesta", anadida, {
    added: "primera",
    column: "porHacer",
    project: idPrueba
  });
  await tool("cdp_add_task", { id: idPrueba, text: "segunda" });
  await tool("cdp_add_task", { id: idPrueba, text: "tercera", column: "enCurso" });

  let p = await tool("cdp_get_project", { id: idPrueba });
  igualdad("las tareas conservan el orden de alta", p.tareas.porHacer, ["primera", "segunda"]);

  // El índice es base-0 dentro de la columna origen. Esta es la firma que
  // usan hoy los subagentes: {id, index, from}.
  const completada = await tool("cdp_complete_task", { id: idPrueba, index: 0, from: "porHacer" });
  igualdad("cdp_complete_task cierra por índice", completada, {
    completed: "primera",
    project: idPrueba
  });
  p = await tool("cdp_get_project", { id: idPrueba });
  igualdad("la cerrada sale de porHacer", p.tareas.porHacer, ["segunda"]);
  igualdad("y entra en hecho", p.tareas.hecho, ["primera"]);

  const porDefecto = await tool("cdp_complete_task", { id: idPrueba, index: 0 });
  igualdad("cdp_complete_task sin 'from' usa enCurso", porDefecto, {
    completed: "tercera",
    project: idPrueba
  });

  let fallo = null;
  try {
    await tool("cdp_complete_task", { id: idPrueba, index: 99 });
  } catch (e) {
    fallo = e.message;
  }
  comprobar("un índice inexistente da error, no un cierre en silencio", fallo !== null, String(fallo));

  const conRoadmap = await tool("cdp_add_roadmap", {
    id: idPrueba,
    fecha: "2026-09",
    texto: "hito de prueba"
  });
  igualdad("cdp_add_roadmap forma de respuesta", conRoadmap, {
    added: "hito de prueba",
    project: idPrueba
  });
  p = await tool("cdp_get_project", { id: idPrueba });
  igualdad("el hito queda con estado future", p.roadmap, [
    { fecha: "2026-09", texto: "hito de prueba", estado: "future" }
  ]);

  await tool("cdp_update_project", { id: idPrueba, progreso: 42, proximoPaso: "seguir" });
  p = await tool("cdp_get_project", { id: idPrueba });
  igualdad("cdp_update_project escribe progreso", p.progreso, 42);
  igualdad("cdp_update_project escribe proximoPaso", p.proximoPaso, "seguir");
  igualdad("y NO se lleva por delante el roadmap", p.roadmap.length, 1);
  igualdad("ni las tareas", p.tareas.hecho, ["primera", "tercera"]);

  const borrado = await tool("cdp_delete_project", { id: idPrueba });
  igualdad("cdp_delete_project forma de respuesta", borrado, {
    deleted: idPrueba,
    nombre: "PRUEBA contrato"
  });
  let borradoFalla = null;
  try {
    await tool("cdp_get_project", { id: idPrueba });
  } catch (e) {
    borradoFalla = e.message;
  }
  comprobar("el proyecto borrado ya no está", borradoFalla !== null);

  // ---- 5. Herramientas nuevas del cerebro ----
  const captura = await tool("cdp_capture", { texto: "algo suelto", via: "telegram" });
  comprobar("cdp_capture devuelve id", /^C-/.test(captura.id ?? ""), JSON.stringify(captura));

  const nota = await tool("cdp_upsert_node", {
    tipo: "nota",
    titulo: "nota de prueba del contrato",
    cuerpo: "Cuerpo con un enlace a [[nota de prueba del contrato]] (a sí misma, no debe enlazarse).",
    extra: { subtipo: "gotcha" },
    etiquetas: ["Prueba", "prueba"]
  });
  comprobar("cdp_upsert_node crea la nota", /^N-/.test(nota.id ?? ""));
  igualdad("las etiquetas se normalizan y deduplican", nota.etiquetas, ["prueba"]);
  igualdad("un nodo no se enlaza consigo mismo", nota.enlacesCreados, 0);

  const encontrado = await tool("cdp_search", { q: "nota de prueba del contrato" });
  comprobar(
    "cdp_search encuentra lo recién escrito",
    encontrado.some(n => n.id === nota.id),
    JSON.stringify(encontrado.map(n => n.id))
  );

  // Una búsqueda con signos raros no puede reventar el FTS.
  const raro = await tool("cdp_search", { q: "¿por qué falla el cron? (urgente)" });
  comprobar("cdp_search aguanta signos de puntuación", Array.isArray(raro));

  await tool("cdp_link", { origen: nota.id, destino: "P-004", tipo: "menciona" });
  const conEnlaces = await tool("cdp_get_node", { id: nota.id });
  comprobar(
    "cdp_link deja el enlace en el nodo",
    conEnlaces.enlaces.salen.some(e => e.id === "P-004")
  );
  const p004 = await tool("cdp_get_node", { id: "P-004" });
  comprobar(
    "y el destino lo ve como enlace entrante",
    p004.enlaces.entran.some(e => e.id === nota.id)
  );

  const sesion = await tool("cdp_log_session", {
    proyecto: "P-001",
    texto: "Prueba de contrato",
    fecha: "2026-08-06"
  });
  igualdad("cdp_log_session cuelga del proyecto", sesion.proyecto, "P-001");

  // Limpieza de lo que han dejado las pruebas del cerebro.
  for (const id of [captura.id, nota.id, sesion.id]) {
    await tool("cdp_upsert_node", { id, tipo: "captura", titulo: "borrame", estado: "descartada" });
  }

  // ---- Resultado ----
  console.log(`\n${pasadas} comprobaciones pasadas`);
  if (fallos.length) {
    console.log(`${fallos.length} FALLOS:\n`);
    for (const f of fallos) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("Contrato intacto.");
};

main().catch(e => {
  console.error("\nLa prueba reventó:", e.message);
  process.exit(1);
});
