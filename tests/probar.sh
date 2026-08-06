#!/usr/bin/env bash
# Prepara la D1 local con los datos de la instantánea y pasa las pruebas de
# contrato del MCP.
#
# Las pruebas comparan campo a campo contra producción, así que necesitan una
# base limpia: si antes se ha trasteado con la web, sobran tareas movidas y
# faltan campos, y los fallos que salen no son del código.
#
#   ./tests/probar.sh
#
# Requiere el servidor local levantado:
#   npx wrangler pages dev . --d1 CDP=<id> --binding MCP_SECRET=local-test --port 8788
set -euo pipefail
cd "$(dirname "$0")/.."

W=(npx wrangler d1 execute cdp --local -c dev/wrangler.jsonc --persist-to .wrangler/state -y)

echo "Recargando la D1 local..."
"${W[@]}" --file=schema/0001_nodos.sql   > /dev/null
"${W[@]}" --file=scripts/migracion.sql   > /dev/null   # proyectos y tareas
"${W[@]}" --file=scripts/memoria.sql     > /dev/null   # notas del cerebro
sleep 2

node tests/contrato-mcp.mjs "$@"
