#!/usr/bin/env node
// Sube la memoria local de Claude (los .md de ~/.claude/.../memory) al CdP como
// nodos de tipo nota. A partir de aquí, el CdP manda y esos ficheros son caché;
// quien los mantiene al día es scripts/cdp-sync.mjs.
//
// Es IDEMPOTENTE: el id sale del nombre del fichero y la carga empieza borrando
// solo las notas que vinieron de la memoria (las escritas a mano en la web no
// se tocan).
//
//   node scripts/migrar-memoria.mjs             # genera scripts/memoria.sql
//   node scripts/migrar-memoria.mjs --aplicar   # además lo carga en D1

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEMORIA = "/home/jonathan/.claude/projects/-home-jonathan-proyectos-tcgprecios/memory";
const AHORA = new Date().toISOString();

const q = v =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : "'" + String(v).replace(/'/g, "''") + "'";

const idDe = nombre => "N-" + createHash("sha256").update("memoria:" + nombre).digest("hex").slice(0, 6);
const huella = t => createHash("sha256").update(t).digest("hex").slice(0, 24);

// Los [[enlaces]] no son consistentes: unos con guion bajo y otros con guion
// normal, y alguno en mayúsculas. Se comparan normalizados.
const normalizar = s => s.toLowerCase().replace(/[-_\s]/g, "");

// ---------- 1. El índice: da el título humano, el gancho y el proyecto ----------

function leerIndice() {
  const texto = readFileSync(join(MEMORIA, "MEMORY.md"), "utf8");
  const porFichero = new Map();
  let proyectoActual = null;

  for (const linea of texto.split("\n")) {
    const seccion = /^##\s+(.+)$/.exec(linea);
    if (seccion) {
      // "## tcgprecios (P-004)" -> P-004. Las secciones sin id (Transversal,
      // Otros proyectos) dejan las notas como transversales.
      const conId = /\((P-\d{3})\)/.exec(seccion[1]);
      proyectoActual = conId ? conId[1] : PROYECTO_POR_SECCION[seccion[1].trim()] ?? null;
      continue;
    }
    const item = /^-\s+\[([^\]]+)\]\(([^)]+\.md)\)\s*(?:—|·|-)?\s*(.*)$/.exec(linea.trim());
    if (item) {
      porFichero.set(item[2], { titulo: item[1].trim(), gancho: item[3].trim(), proyecto: proyectoActual });
    }
  }
  return porFichero;
}

// Secciones del índice cuyo nombre no lleva el id del proyecto dentro.
const PROYECTO_POR_SECCION = {
  "Imperio Friki (IFK)": "P-005",
  "TabletopAgenda (P-011)": "P-011",
  "Abriendo Boosters / MBBOX (directos)": "P-006",
  "Imperio Noxus (infra común)": "P-002"
};

// ---------- 2. Las notas ----------

function leerFrontmatter(texto) {
  if (!texto.startsWith("---")) return { datos: {}, cuerpo: texto };
  const fin = texto.indexOf("\n---", 3);
  if (fin < 0) return { datos: {}, cuerpo: texto };
  const cabecera = texto.slice(3, fin);
  const cuerpo = texto.slice(fin + 4).replace(/^\n+/, "");
  const datos = {};
  for (const linea of cabecera.split("\n")) {
    const m = /^(\s*)([a-zA-Z_]+):\s*(.*)$/.exec(linea);
    if (!m) continue;
    let valor = m[3].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
    // Con dos espacios de sangría es hijo de metadata; para lo que necesitamos
    // (type) da igual aplanarlo.
    datos[m[2]] = valor;
  }
  return { datos, cuerpo };
}

// Los "MIRA PRIMERO" son un género propio en esta memoria: fallos ya vistos con
// su causa y su arreglo. Merecen subtipo propio aunque el fichero diga otra cosa.
function subtipoDe(datos, titulo, gancho) {
  const junto = (titulo + " " + gancho + " " + (datos.description ?? "")).toUpperCase();
  if (/MIRA (ESTO )?PRIMERO|MIRA ANTES DE TOCAR|GOTCHA/.test(junto)) return "gotcha";
  const tipo = (datos.type ?? "").trim();
  return ["user", "feedback", "project", "reference"].includes(tipo) ? tipo : "project";
}

const main = () => {
  const indice = leerIndice();
  const ficheros = readdirSync(MEMORIA).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
  const notas = [];

  for (const fichero of ficheros) {
    const bruto = readFileSync(join(MEMORIA, fichero), "utf8");
    const { datos, cuerpo } = leerFrontmatter(bruto);
    const stem = fichero.replace(/\.md$/, "");
    const meta = indice.get(fichero) ?? {};
    const titulo = meta.titulo || datos.description || stem;
    notas.push({
      id: idDe(stem),
      stem,
      fichero,
      titulo,
      cuerpo,
      proyecto: meta.proyecto ?? null,
      subtipo: subtipoDe(datos, titulo, meta.gancho ?? ""),
      descripcion: datos.description ?? meta.gancho ?? "",
      gancho: meta.gancho ?? "",
      nombreFrontmatter: datos.name ?? stem
    });
  }

  // Índice de resolución: por nombre de fichero, por `name` del frontmatter y
  // por título, todo normalizado.
  const porNombre = new Map();
  for (const n of notas) {
    for (const alias of [n.stem, n.nombreFrontmatter, n.titulo]) {
      if (alias) porNombre.set(normalizar(alias), n.id);
    }
  }

  const enlaces = [];
  let sinResolver = 0;
  for (const n of notas) {
    const vistos = new Set();
    for (const m of n.cuerpo.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const destino = porNombre.get(normalizar(m[1]));
      if (!destino) { sinResolver++; continue; }
      if (destino === n.id || vistos.has(destino)) continue;
      vistos.add(destino);
      enlaces.push([n.id, destino]);
    }
  }

  const sql = [
    "-- Generado por scripts/migrar-memoria.mjs. NO editar a mano.",
    `-- ${notas.length} notas de la memoria local, ${AHORA}`,
    "",
    "-- Solo se recargan las notas que vinieron de la memoria: las escritas a",
    "-- mano desde la web no llevan nombreMemoria y se quedan donde están.",
    "DELETE FROM nodes WHERE tipo = 'nota' AND json_extract(extra, '$.nombreMemoria') IS NOT NULL;",
    ""
  ];

  for (const n of notas) {
    const extra = {
      subtipo: n.subtipo,
      nombreMemoria: n.stem,
      fichero: n.fichero,
      descripcion: n.descripcion,
      gancho: n.gancho
    };
    sql.push(
      "INSERT INTO nodes (id, tipo, titulo, cuerpo, estado, proyecto, orden, extra, agente, ejecucion, creado, modificado, archivado, huella) VALUES (" +
        [
          q(n.id), q("nota"), q(n.titulo), q(n.cuerpo), "NULL", q(n.proyecto), "NULL",
          q(JSON.stringify(extra)), "NULL", "NULL", q(AHORA), q(AHORA), 0,
          q(huella(n.titulo + "\n" + n.cuerpo))
        ].join(", ") + ");"
    );
    sql.push(`INSERT OR IGNORE INTO etiquetas (nodo, etiqueta) VALUES (${q(n.id)}, ${q(n.subtipo)});`);
  }

  for (const [origen, destino] of enlaces) {
    sql.push(`INSERT OR IGNORE INTO links (origen, destino, tipo) VALUES (${q(origen)}, ${q(destino)}, 'menciona');`);
  }

  sql.push("", "INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');");
  sql.push(`INSERT OR REPLACE INTO meta (clave, valor) VALUES ('memoria_migrada', ${q(AHORA)});`, "");

  const ruta = join(RAIZ, "scripts/memoria.sql");
  writeFileSync(ruta, sql.join("\n"));

  const porSubtipo = {};
  for (const n of notas) porSubtipo[n.subtipo] = (porSubtipo[n.subtipo] ?? 0) + 1;
  const transversales = notas.filter(n => !n.proyecto).length;

  console.log(`${notas.length} notas -> ${ruta}`);
  console.log("  por tipo:", JSON.stringify(porSubtipo));
  console.log(`  con proyecto: ${notas.length - transversales} · transversales: ${transversales}`);
  console.log(`  enlaces resueltos: ${enlaces.length} · sin destino: ${sinResolver}`);

  if (process.argv.includes("--aplicar")) {
    for (const destino of ["--local", "--remote"]) {
      process.stdout.write(`\nAplicando ${destino}... `);
      const args = ["wrangler", "d1", "execute", "cdp", destino, "--file=scripts/memoria.sql", "-y"];
      if (destino === "--local") args.push("-c", "dev/wrangler.jsonc", "--persist-to", ".wrangler/state");
      execFileSync("npx", args, { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      console.log("ok");
    }
  } else {
    console.log("\nRelanza con --aplicar para cargarlo.");
  }
};

main();
