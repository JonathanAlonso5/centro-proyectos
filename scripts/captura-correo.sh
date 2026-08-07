#!/usr/bin/env bash
# Pasada de captura por correo del CdP. Lo llama el crontab cada 10 minutos.
#
# Sale en silencio y con éxito mientras el buzón no esté configurado: así el
# cron puede estar puesto desde el primer día sin llenar el log de quejas, y
# empieza a funcionar solo en cuanto se rellene el .env.
DIR=/home/scraper/cdp
cd "$DIR" || exit 1
grep -q '__PENDIENTE' .env && exit 0
set -a; . ./.env; set +a
exec /home/scraper/tcgprecios/.venv/bin/python "$DIR/captura-correo.py" --aplicar
