# CdP · operaciones

## Qué es cada cosa

| Pieza | Dónde | Para qué |
|---|---|---|
| Web (PWA) | `index.html` | El panel: proyectos, tareas, cerebro y bandeja |
| API | `functions/api/[[ruta]].ts` | Lo que consume la web |
| MCP | `functions/mcp.ts` | Lo que consumen Claude Code, Codex, el bot de Telegram y el conector de claude.ai |
| Datos | D1 `cdp` (`7c8cca0e-e507-458c-b650-bf8617f654bf`) | La fuente de verdad |
| Drive | `centro-proyectos-data.json` | **Solo copia de seguridad**, vía `cdp_backup_drive` |
| Memoria local | `~/.claude/projects/-home-jonathan-proyectos-tcgprecios/memory/*.md` | Caché de los nodos de tipo nota |

## Paso manual pendiente: el binding de D1

**Hay que hacerlo una vez, y hasta entonces la web y el MCP no funcionan en
producción** (dan `missing-env` con `CDP: false`).

Panel de Cloudflare → Workers & Pages → **centro-proyectos** → Settings →
Bindings → Add → **D1 database**:

- Variable name: `CDP`
- D1 database: `cdp`

Añadirlo en **Production** y en **Preview**. Después, Deployments → Retry
deployment del último de producción, que Cloudflare no siempre propaga un
binding nuevo sin redesplegar.

**Por qué esto no lo hace un script:** la alternativa es meter un
`wrangler.toml` en la raíz, y entonces el CI de Pages deja de leer la
configuración del panel, que es donde viven `MCP_SECRET`, `SA_KEY` y
`DRIVE_FILE_ID`. La otra alternativa, un PATCH a la API de Pages, ya se llevó
por delante secretos en esta cuenta una vez (memoria
`feedback_dont_clobber_secrets`). Treinta segundos de panel salen más baratos.

Por eso la configuración de wrangler vive en `dev/wrangler.jsonc` y no en la
raíz: es solo para desarrollo local.

## Desplegar

`main` es la rama de producción y Cloudflare Pages despliega solo al empujar.
Antes de mezclar nada en `main`:

```bash
# 1. Servidor local
npx wrangler pages dev . \
  --d1 CDP=7c8cca0e-e507-458c-b650-bf8617f654bf \
  --binding MCP_SECRET=local-test --port 8788

# 2. Contrato del MCP (recarga la base local y compara contra producción)
./tests/probar.sh

# 3. Solo si está en verde
git checkout main && git merge segundo-cerebro && git push
```

Tras desplegar, comprobar que el MCP sigue vivo:

```bash
curl -s https://centro-proyectos.pages.dev/mcp | grep -E '"version"|"CDP"'
```

## Migraciones

```bash
node scripts/migrar-drive-a-d1.mjs --aplicar   # proyectos y tareas desde Drive
node scripts/migrar-memoria.mjs --aplicar      # las notas desde los .md locales
```

Las dos son idempotentes: los ids salen del contenido y la carga empieza
borrando lo que va a reescribir. Se pueden relanzar sin miedo.

## Sincronizar la memoria

```bash
node scripts/cdp-sync.mjs             # dice lo que haría
node scripts/cdp-sync.mjs --aplicar   # lo hace
```

Variables útiles: `CDP_URL` (por defecto producción), `CDP_SECRET` y
`CDP_MEMORIA` (para ensayar sobre una copia de la carpeta de memoria).

Manda el CdP. Si un `.md` y su nodo han cambiado los dos, gana el CdP y la
versión local queda como `<nombre>.local-<fecha>.md`. Sin red, las subidas se
encolan en `~/.cdp-pendiente.jsonl` y salen en la siguiente pasada.

Para que Claude lo lance solo al abrir sesión, en `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command",
                    "command": "node /mnt/e/Claude/centro-proyectos/scripts/cdp-sync.mjs --aplicar" }] }
    ]
  }
}
```

## Copia de seguridad

La herramienta `cdp_backup_drive` del MCP vuelca todo el CdP al JSON de Drive
en el formato de siempre. Conviene llamarla desde el cron nocturno del VPS.

## Si algo va mal

## Quién entra y cómo

Dos puertas, a propósito:

- **Personas**: botón de Google. El servidor comprueba el token contra las claves
  públicas de Google (firma, emisor, caducidad, que la aplicación sea la nuestra
  y que el correo esté verificado) y que la cuenta esté en la lista. Después
  emite una **sesión propia de 30 días firmada con `MCP_SECRET`**, y es esa la
  que viaja en cada petición: el token de Google no se queda en el navegador y
  rotar `MCP_SECRET` echa a todas las sesiones de golpe.
- **Máquinas** (`cdp-sync`, el bot de Telegram, los scripts, el MCP): `Bearer
  MCP_SECRET`, como siempre. También sirve de puerta de emergencia si Google
  falla; en la web está detrás de "Entrar con la clave larga".

La lista de correos con acceso se controla con la variable de entorno
`CDP_CORREOS` (separados por comas). Sin definir, solo entra
`jonathanalonso5@gmail.com`.

El cliente OAuth es el que ya tenía el CdP
(`632850738128-…apps.googleusercontent.com`). Sus **orígenes de JavaScript
autorizados** tienen que incluir `https://centro-proyectos.pages.dev`; si algún
día se cambia de dominio, hay que añadirlo ahí o el botón no pinta.

## Si algo va mal

| Síntoma | Mira primero |
|---|---|
| "la cuenta X no tiene acceso" | Has entrado con otra cuenta de Google. O cambias de cuenta, o añades esa a `CDP_CORREOS` |
| El botón de Google no aparece | Orígenes autorizados del cliente OAuth. Mientras tanto, "Entrar con la clave larga" |
| La web pide entrar cada dos por tres | La sesión caduca a los 30 días, pero rotar `MCP_SECRET` la invalida antes |
| `missing-env` con `CDP: false` | Falta el binding de D1, arriba |
| El MCP responde pero sin proyectos | La D1 de producción está vacía: relanzar `migrar-drive-a-d1.mjs --aplicar` |
| El bot de Telegram deja de escribir | Pasar `./tests/probar.sh`: si el contrato está roto, es el MCP |
| El sync canta choques todo el rato | Borrar `.cdp-sync.json` de la carpeta de memoria y relanzar |
