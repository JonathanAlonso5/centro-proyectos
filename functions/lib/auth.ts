// Acceso al CdP.
//
// Dos puertas, a propósito:
//   - Personas: botón de Google. Se comprueba el token de Google contra sus
//     claves públicas y que el correo sea el de Jonathan. La recuperación la
//     lleva Google: no hay nada que recordar ni que guardar.
//   - Máquinas (cdp-sync, el bot de Telegram, los scripts): Bearer MCP_SECRET,
//     como siempre. También sirve a una persona como puerta de emergencia si
//     Google se cae.
//
// Tras entrar con Google se emite una sesión propia firmada con MCP_SECRET, y
// es esa la que viaja en cada petición. Así el token de Google no se guarda en
// el navegador y rotar MCP_SECRET invalida todas las sesiones de golpe.

const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const EMISORES = ["accounts.google.com", "https://accounts.google.com"];
const DIAS_DE_SESION = 30;

// El cliente OAuth que ya tenía el CdP para entrar con Google.
export const CLIENTE_GOOGLE =
  "632850738128-1rdafo4d6sc5fmp2b71igof3fea9vv8m.apps.googleusercontent.com";

const CORREOS_POR_DEFECTO = ["jonathanalonso5@gmail.com"];

// ---------- utilidades ----------

function deB64url(texto: string): Uint8Array {
  const base = texto.replace(/-/g, "+").replace(/_/g, "/");
  const relleno = base + "=".repeat((4 - (base.length % 4)) % 4);
  const bin = atob(relleno);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function aB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const texto = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Las claves públicas de Google rotan, pero no cada minuto: se guardan en la
// caché del propio Worker mientras Google diga que valen.
let cacheLlaves: { llaves: any[]; expira: number } | null = null;

async function llavesDeGoogle(): Promise<any[]> {
  const ahora = Date.now();
  if (cacheLlaves && cacheLlaves.expira > ahora) return cacheLlaves.llaves;
  const res = await fetch(JWKS);
  if (!res.ok) throw new Error("no se han podido leer las claves de Google");
  const datos = (await res.json()) as { keys: any[] };
  const control = res.headers.get("Cache-Control") ?? "";
  const maxEdad = Number(/max-age=(\d+)/.exec(control)?.[1] ?? 3600);
  cacheLlaves = { llaves: datos.keys, expira: ahora + maxEdad * 1000 };
  return datos.keys;
}

// ---------- entrada con Google ----------

export interface Persona {
  correo: string;
  nombre?: string;
}

export async function verificarGoogle(idToken: string, correosPermitidos: string[]): Promise<Persona> {
  const trozos = idToken.split(".");
  if (trozos.length !== 3) throw new Error("el token de Google no tiene la forma esperada");

  const cabecera = JSON.parse(texto(deB64url(trozos[0])));
  const carga = JSON.parse(texto(deB64url(trozos[1])));

  const jwk = (await llavesDeGoogle()).find(k => k.kid === cabecera.kid);
  if (!jwk) throw new Error("el token viene firmado con una clave que Google no reconoce");

  const clave = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const firmaValida = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    clave,
    deB64url(trozos[2]),
    new TextEncoder().encode(`${trozos[0]}.${trozos[1]}`)
  );
  if (!firmaValida) throw new Error("la firma del token no es válida");

  const ahora = Math.floor(Date.now() / 1000);
  if (typeof carga.exp !== "number" || carga.exp < ahora) throw new Error("el token de Google ha caducado");
  if (!EMISORES.includes(carga.iss)) throw new Error("el token no lo ha emitido Google");
  if (carga.aud !== CLIENTE_GOOGLE) throw new Error("el token es de otra aplicación");
  if (carga.email_verified === false) throw new Error("ese correo no está verificado en Google");

  const correo = String(carga.email ?? "").toLowerCase();
  if (!correosPermitidos.includes(correo)) {
    // Se dice QUÉ correo ha llegado: si algún día entra con otra cuenta de
    // Google, el mensaje lo explica en vez de dejarle mirando un "no puedes".
    throw new Error(`la cuenta ${correo || "(sin correo)"} no tiene acceso a este CdP`);
  }
  return { correo, nombre: carga.name };
}

export function correosPermitidos(env: { CDP_CORREOS?: string }): string[] {
  const bruto = (env.CDP_CORREOS ?? "").trim();
  if (!bruto) return CORREOS_POR_DEFECTO;
  return bruto.split(",").map(c => c.trim().toLowerCase()).filter(Boolean);
}

// ---------- sesión propia ----------

async function firmar(datos: string, secreto: string): Promise<string> {
  const clave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(datos));
  return aB64url(new Uint8Array(firma));
}

export async function emitirSesion(persona: Persona, secreto: string): Promise<{ token: string; expira: number }> {
  const expira = Math.floor(Date.now() / 1000) + DIAS_DE_SESION * 86400;
  const carga = aB64url(new TextEncoder().encode(JSON.stringify({ correo: persona.correo, exp: expira })));
  return { token: `${carga}.${await firmar(carga, secreto)}`, expira };
}

export async function verificarSesion(token: string, secreto: string): Promise<Persona | null> {
  const punto = token.lastIndexOf(".");
  if (punto < 0) return null;
  const carga = token.slice(0, punto);
  const firma = token.slice(punto + 1);
  // Comparación normal: la firma es la que decide y no se filtra nada útil por
  // el tiempo de comparación de una cadena que ya es pública.
  if ((await firmar(carga, secreto)) !== firma) return null;
  try {
    const datos = JSON.parse(texto(deB64url(carga)));
    if (typeof datos.exp !== "number" || datos.exp < Math.floor(Date.now() / 1000)) return null;
    return { correo: datos.correo };
  } catch {
    return null;
  }
}

// Puerta única: o es una máquina con el secreto, o es una sesión válida.
export async function quienEs(
  peticion: Request,
  secreto: string
): Promise<{ tipo: "maquina" | "persona"; correo?: string } | null> {
  const cabecera = peticion.headers.get("Authorization") ?? "";
  if (!cabecera.startsWith("Bearer ")) return null;
  const credencial = cabecera.slice(7);
  if (credencial === secreto) return { tipo: "maquina" };
  const persona = await verificarSesion(credencial, secreto);
  return persona ? { tipo: "persona", correo: persona.correo } : null;
}
