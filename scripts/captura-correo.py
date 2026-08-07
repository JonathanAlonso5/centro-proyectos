#!/usr/bin/env python3
"""Captura por correo para el CdP.

Mira un buzón por IMAP y mete cada correo nuevo en la bandeja del CdP. Pensado
para correr en el VPS cada pocos minutos desde cron, junto al bot de Telegram.

No usa Cloudflare Email Routing a propósito: obligaría a mover el DNS de
imperionoxus.com, que está en SiteGround. El VPS ya está encendido las 24 horas.

Solo la biblioteca estándar: el VPS no necesita instalar nada.

Configuración por variables de entorno (o en /home/scraper/.env):
    CDP_IMAP_HOST      imap.dominio.com
    CDP_IMAP_USER      buzon@dominio.com
    CDP_IMAP_PASS      la contraseña
    CDP_IMAP_CARPETA   INBOX (por defecto)
    CDP_URL            https://centro-proyectos.pages.dev
    CDP_SECRET         el MCP_SECRET

    python3 captura-correo.py            # dice lo que haría
    python3 captura-correo.py --aplicar  # captura y marca como leído
"""

import email
import email.header
import imaplib
import json
import os
import sys
import urllib.request

APLICAR = "--aplicar" in sys.argv
MAX_CORREOS = 25          # por pasada, para que un buzón atascado no dispare
MAX_CUERPO = 1500         # caracteres de texto que se guardan del correo


def env(nombre, defecto=None):
    valor = os.environ.get(nombre, defecto)
    if valor is None:
        sys.exit(f"Falta la variable {nombre}")
    return valor


def decodificar(cabecera):
    """Los asuntos vienen en MIME (=?UTF-8?B?...?=) más veces de las que parece."""
    if not cabecera:
        return ""
    trozos = []
    for texto, codificacion in email.header.decode_header(cabecera):
        if isinstance(texto, bytes):
            trozos.append(texto.decode(codificacion or "utf-8", errors="replace"))
        else:
            trozos.append(texto)
    return "".join(trozos).strip()


def texto_plano(mensaje):
    """El cuerpo en texto. Si el correo solo trae HTML, se queda con el asunto."""
    if mensaje.is_multipart():
        for parte in mensaje.walk():
            if parte.get_content_type() == "text/plain" and "attachment" not in str(
                parte.get("Content-Disposition", "")
            ):
                carga = parte.get_payload(decode=True) or b""
                return carga.decode(parte.get_content_charset() or "utf-8", errors="replace")
        return ""
    if mensaje.get_content_type() == "text/plain":
        carga = mensaje.get_payload(decode=True) or b""
        return carga.decode(mensaje.get_content_charset() or "utf-8", errors="replace")
    return ""


def capturar(texto, cuerpo):
    datos = json.dumps({"texto": texto, "via": "correo", "cuerpo": cuerpo}).encode()
    peticion = urllib.request.Request(
        env("CDP_URL", "https://centro-proyectos.pages.dev") + "/api/capturar",
        data=datos,
        headers={
            "Authorization": "Bearer " + env("CDP_SECRET"),
            "Content-Type": "application/json",
            # El WAF de Cloudflare devuelve 403 al User-Agent de urllib.
            "User-Agent": "curl/8.5.0",
        },
    )
    with urllib.request.urlopen(peticion, timeout=30) as respuesta:
        return json.loads(respuesta.read())


def main():
    if not APLICAR:
        print("EN SECO. Añade --aplicar para capturar y marcar como leído.\n")

    servidor = imaplib.IMAP4_SSL(env("CDP_IMAP_HOST"))
    try:
        servidor.login(env("CDP_IMAP_USER"), env("CDP_IMAP_PASS"))
        servidor.select(env("CDP_IMAP_CARPETA", "INBOX"))
        estado, respuesta = servidor.search(None, "UNSEEN")
        if estado != "OK":
            sys.exit("El buzón no responde a la búsqueda")

        ids = respuesta[0].split()
        if not ids:
            print("Nada nuevo.")
            return
        if len(ids) > MAX_CORREOS:
            print(f"{len(ids)} sin leer: se cogen los {MAX_CORREOS} más recientes.")
            ids = ids[-MAX_CORREOS:]

        for numero in ids:
            # BODY.PEEK no marca como leído: así, si algo falla a mitad, el
            # correo sigue pendiente y entra en la pasada siguiente.
            estado, datos = servidor.fetch(numero, "(BODY.PEEK[])")
            if estado != "OK":
                continue
            mensaje = email.message_from_bytes(datos[0][1])
            asunto = decodificar(mensaje.get("Subject")) or "(sin asunto)"
            remitente = decodificar(mensaje.get("From"))
            cuerpo = texto_plano(mensaje).strip()[:MAX_CUERPO]

            titulo = f"{asunto} · de {remitente}" if remitente else asunto
            print(f"  {'capturando' if APLICAR else 'capturaría'}: {titulo[:90]}")
            if APLICAR:
                capturar(titulo, cuerpo)
                servidor.store(numero, "+FLAGS", "\\Seen")

        print(f"\n{len(ids)} correos procesados.")
    finally:
        try:
            servidor.close()
        except Exception:
            pass
        servidor.logout()


if __name__ == "__main__":
    main()
