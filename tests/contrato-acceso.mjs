#!/usr/bin/env node
// Pruebas del acceso al CdP.
//
// Lo que NO se puede probar aquí es el token real de Google (haría falta que
// una persona pulse el botón). Sí se prueba todo lo demás: que un token
// inventado se rechaza, que la sesión firmada vale, que una manipulada no, que
// caducan, y que la clave de las máquinas sigue abriendo.
//
//   node tests/contrato-acceso.mjs [url] [secreto]

import { createHmac } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const SECRETO = process.argv[3] ?? "local-test";

let pasadas = 0;
const fallos = [];
const revisar = (nombre, ok, detalle = "") => {
  if (ok) pasadas++;
  else fallos.push(nombre + (detalle ? ": " + detalle : ""));
};

const b64url = b => Buffer.from(b).toString("base64url");

// Misma construcción que emitirSesion() del servidor.
function sesionFirmada(correo, expiraEn) {
  const carga = b64url(JSON.stringify({ correo, exp: Math.floor(Date.now() / 1000) + expiraEn }));
  const firma = createHmac("sha256", SECRETO).update(carga).digest("base64url");
  return `${carga}.${firma}`;
}

async function pedir(ruta, credencial) {
  const res = await fetch(`${BASE}/api/${ruta}`, {
    headers: credencial ? { Authorization: `Bearer ${credencial}` } : {}
  });
  return { estado: res.status, cuerpo: await res.json().catch(() => ({})) };
}

const main = async () => {
  console.log(`Acceso contra ${BASE}\n`);

  // ---- la puerta está cerrada ----
  revisar("sin credencial no se entra", (await pedir("estado")).estado === 401);
  revisar("con una credencial inventada tampoco", (await pedir("estado", "loquesea")).estado === 401);

  // ---- máquinas ----
  const maquina = await pedir("estado", SECRETO);
  revisar("la clave larga sigue abriendo (bot, scripts, sync)", maquina.estado === 200, String(maquina.estado));
  revisar("y trae datos", Array.isArray(maquina.cuerpo.proyectos) && maquina.cuerpo.proyectos.length > 0);

  // ---- sesiones de persona ----
  const buena = sesionFirmada("jonathanalonso5@gmail.com", 3600);
  revisar("una sesión firmada entra", (await pedir("estado", buena)).estado === 200);

  const caducada = sesionFirmada("jonathanalonso5@gmail.com", -60);
  revisar("una sesión caducada no entra", (await pedir("estado", caducada)).estado === 401);

  const manipulada = buena.slice(0, buena.lastIndexOf(".")) + ".firmaInventada";
  revisar("una sesión con la firma cambiada no entra", (await pedir("estado", manipulada)).estado === 401);

  // Cambiar el correo obliga a rehacer la firma, que es justo lo que no se
  // puede sin el secreto.
  const otroCorreo = b64url(JSON.stringify({ correo: "otro@ejemplo.com", exp: Math.floor(Date.now() / 1000) + 3600 }));
  const cargaCambiada = otroCorreo + "." + buena.split(".")[1];
  revisar("cambiar el correo de la sesión no cuela", (await pedir("estado", cargaCambiada)).estado === 401);

  // ---- entrada con Google ----
  const config = await fetch(`${BASE}/api/config`).then(r => r.json());
  revisar("la web puede pedir el cliente de Google sin credencial",
    typeof config.clienteGoogle === "string" && config.clienteGoogle.endsWith(".apps.googleusercontent.com"),
    JSON.stringify(config));

  const inventado = await fetch(`${BASE}/api/sesion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credencial: "esto.no.es" })
  });
  const cuerpoInventado = await inventado.json();
  revisar("un token de Google inventado se rechaza", inventado.status === 401, String(inventado.status));
  revisar("y dice por qué", typeof cuerpoInventado.error === "string" && cuerpoInventado.error.length > 5,
    JSON.stringify(cuerpoInventado));

  // Un JWT bien formado pero firmado por cualquiera: el caso que de verdad
  // importa, porque es lo que intentaría alguien que sepa lo que hace.
  const cabecera = b64url(JSON.stringify({ alg: "RS256", kid: "inventado" }));
  const carga = b64url(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: config.clienteGoogle,
    email: "jonathanalonso5@gmail.com",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  }));
  const falso = await fetch(`${BASE}/api/sesion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credencial: `${cabecera}.${carga}.firmaFalsa` })
  });
  revisar("un token con el correo correcto pero mal firmado se rechaza", falso.status === 401, String(falso.status));

  console.log(`${pasadas} comprobaciones pasadas`);
  if (fallos.length) {
    console.log(`${fallos.length} FALLOS:\n`);
    for (const f of fallos) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("Acceso correcto.");
};

main().catch(e => {
  console.error("La prueba reventó:", e.message);
  process.exit(1);
});
