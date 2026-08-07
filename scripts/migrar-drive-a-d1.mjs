#!/usr/bin/env node
// Migra el CdP del JSON de Drive a D1.
//
// Lee por el MCP en producción (no toca Drive directamente: así no hacen falta
// las credenciales de la cuenta de servicio en el PC), guarda una instantánea
// en scripts/instantanea-drive.json y genera scripts/migracion.sql.
//
// Es IDEMPOTENTE: los ids de tarea se derivan del contenido, y la carga empieza
// vaciando nodes. Lanzarlo dos veces da exactamente el mismo resultado.
//
//   node scripts/migrar-drive-a-d1.mjs              # solo genera el .sql
//   node scripts/migrar-drive-a-d1.mjs --aplicar    # además lo carga en D1

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP = "https://centro-proyectos.pages.dev/mcp";
const RUTA_SECRETO = "/home/jonathan/.config/tcgprecios/cdp-mcp-secret";
const AHORA = new Date().toISOString();

const secreto = readFileSync(RUTA_SECRETO, "utf8").trim();

// El WAF de Cloudflare devuelve 403 a User-Agents de librerías (pasó con
// python-urllib). Con uno de curl pasa. Ver memoria reference_cdp_mcp.
async function llamar(nombre, args = {}) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secreto}`,
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
  if (!res.ok) throw new Error(`${nombre}: HTTP ${res.status} ${await res.text()}`);
  const cuerpo = await res.json();
  if (cuerpo.error) throw new Error(`${nombre}: ${cuerpo.error.message}`);
  return JSON.parse(cuerpo.result.content[0].text);
}

function q(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Id de tarea derivado del contenido: mismo texto en la misma columna del mismo
// proyecto => mismo id. Es lo que hace la migración repetible.
function idTarea(proyecto, columna, texto, indice) {
  const h = createHash("sha256").update(`${proyecto}|${columna}|${texto}|${indice}`).digest("hex");
  return "T-" + h.slice(0, 6);
}

function huella(texto) {
  return createHash("sha256").update(texto).digest("hex").slice(0, 24);
}

const main = async () => {
  console.log("Leyendo el CdP de producción...");
  const listado = await llamar("cdp_list_projects");
  const proyectos = [];
  for (const p of listado) {
    proyectos.push(await llamar("cdp_get_project", { id: p.id }));
    process.stdout.write(`  ${p.id} `);
  }
  console.log("\n");

  writeFileSync(
    join(RAIZ, "scripts/instantanea-drive.json"),
    JSON.stringify({ tomada: AHORA, proyectos }, null, 2)
  );
  console.log(`Instantánea guardada: ${proyectos.length} proyectos`);

  const sql = [
    "-- Generado por scripts/migrar-drive-a-d1.mjs. NO editar a mano.",
    `-- Origen: instantánea del ${AHORA}`,
    "",
    "-- Carga limpia: el DELETE arrastra links y etiquetas por ON DELETE CASCADE",
    "-- y dispara los triggers que mantienen el índice de búsqueda.",
    "DELETE FROM nodes;",
    ""
  ];

  let nTareas = 0;
  const ids = new Set();

  for (const p of proyectos) {
    const extra = {
      progreso: p.progreso ?? 0,
      proximoPaso: p.proximoPaso ?? "",
      notas: p.notas ?? "",
      roadmap: Array.isArray(p.roadmap) ? p.roadmap : []
    };
    const cuerpo = p.descripcion ?? "";
    sql.push(
      `INSERT INTO nodes (id, tipo, titulo, cuerpo, estado, proyecto, orden, extra, agente, ejecucion, creado, modificado, archivado, huella) VALUES (` +
        [
          q(p.id),
          q("proyecto"),
          q(p.nombre),
          q(cuerpo),
          q(p.estado ?? "activo"),
          "NULL",
          proyectos.indexOf(p) + 1,
          q(JSON.stringify(extra)),
          "NULL",
          "NULL",
          q(p.creado ?? AHORA),
          q(AHORA),
          0,
          q(huella(p.nombre + "\n" + cuerpo))
        ].join(", ") +
        ");"
    );

    for (const etiqueta of p.tags ?? []) {
      const limpia = String(etiqueta).trim().toLowerCase();
      if (limpia) sql.push(`INSERT OR IGNORE INTO etiquetas (nodo, etiqueta) VALUES (${q(p.id)}, ${q(limpia)});`);
    }

    const tareas = p.tareas ?? {};
    for (const columna of ["porHacer", "enCurso", "hecho"]) {
      const lista = Array.isArray(tareas[columna]) ? tareas[columna] : [];
      lista.forEach((texto, i) => {
        if (typeof texto !== "string" || !texto.trim()) return;
        let id = idTarea(p.id, columna, texto, i);
        while (ids.has(id)) id = "T-" + huella(id + "x").slice(0, 6);
        ids.add(id);
        nTareas++;
        // Lo hecho hace tiempo entra ya archivado: sale del tablero pero sigue
        // buscable. Sin esto P-005 nace con 88 tarjetas en la columna Hecho.
        const archivado = columna === "hecho" ? 1 : 0;
        sql.push(
          `INSERT INTO nodes (id, tipo, titulo, cuerpo, estado, proyecto, orden, extra, agente, ejecucion, creado, modificado, archivado, huella) VALUES (` +
            [
              q(id),
              q("tarea"),
              q(texto),
              q(""),
              q(columna),
              q(p.id),
              i + 1,
              q("{}"),
              "NULL",
              "NULL",
              q(AHORA),
              q(AHORA),
              archivado,
              q(huella(texto))
            ].join(", ") +
            ");"
        );
      });
    }
  }

  sql.push("");
  sql.push("-- Reconstruir el índice de búsqueda por si algún trigger no corrió.");
  sql.push("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');");
  sql.push(`INSERT OR REPLACE INTO meta (clave, valor) VALUES ('migrado_desde_drive', ${q(AHORA)});`);
  sql.push("");

  const ruta = join(RAIZ, "scripts/migracion.sql");
  writeFileSync(ruta, sql.join("\n"));
  console.log(`SQL generado: ${proyectos.length} proyectos, ${nTareas} tareas -> ${ruta}`);

  if (process.argv.includes("--aplicar")) {
    for (const destino of ["--local", "--remote"]) {
      console.log(`\nAplicando ${destino}...`);
      // En local hace falta la config de dev/ para resolver el binding; en
      // remoto wrangler resuelve el nombre contra la cuenta.
      const args = ["wrangler", "d1", "execute", "cdp", destino, "--file=scripts/migracion.sql", "-y"];
      if (destino === "--local") args.push("-c", "dev/wrangler.jsonc");
      const salida = execFileSync("npx", args, {
        cwd: RAIZ,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      const filas = /rows_written":\s*(\d+)/.exec(salida);
      console.log(`  ok${filas ? `, ${filas[1]} filas escritas` : ""}`);
    }
  } else {
    console.log("\nRevisa el .sql y relanza con --aplicar para cargarlo.");
  }
};

main().catch(e => {
  console.error("FALLÓ:", e.message);
  process.exit(1);
});
