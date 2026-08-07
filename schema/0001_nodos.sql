-- CdP · esquema del segundo cerebro (fase 0)
--
-- Un solo tipo de registro (nodo) con los campos que comparten todos, y un JSON
-- con lo propio de cada tipo. Encima, enlaces y etiquetas transversales.
-- Ver docs/superpowers/specs/2026-08-06-cdp-kanban-segundo-cerebro-design.md

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  tipo       TEXT NOT NULL CHECK (tipo IN ('proyecto','tarea','nota','sesion','captura')),
  titulo     TEXT NOT NULL,
  cuerpo     TEXT NOT NULL DEFAULT '',
  estado     TEXT,
  proyecto   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  orden      REAL,
  extra      TEXT NOT NULL DEFAULT '{}',
  -- Nivel 3 (ORQUESTA): hoy solo alimentan el filtro "solo mías" del tablero.
  agente     TEXT,
  ejecucion  TEXT,
  creado     TEXT NOT NULL,
  modificado TEXT NOT NULL,
  archivado  INTEGER NOT NULL DEFAULT 0,
  -- Hash del contenido. El sync de la memoria local solo reescribe lo que cambió.
  huella     TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_tipo      ON nodes(tipo, archivado);
CREATE INDEX IF NOT EXISTS idx_nodes_proyecto  ON nodes(proyecto, tipo);
CREATE INDEX IF NOT EXISTS idx_nodes_columna   ON nodes(tipo, estado, orden);

-- Enlaces dirigidos entre nodos. El tipo dice qué significa la flecha.
CREATE TABLE IF NOT EXISTS links (
  origen  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  destino TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tipo    TEXT NOT NULL DEFAULT 'menciona',
  PRIMARY KEY (origen, destino, tipo)
);

CREATE INDEX IF NOT EXISTS idx_links_destino ON links(destino);

CREATE TABLE IF NOT EXISTS etiquetas (
  nodo     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  etiqueta TEXT NOT NULL,
  PRIMARY KEY (nodo, etiqueta)
);

CREATE INDEX IF NOT EXISTS idx_etiquetas_etiqueta ON etiquetas(etiqueta);

-- Búsqueda de texto. Tabla externa (content='nodes') para no duplicar el cuerpo:
-- FTS guarda solo el índice y lee el texto de nodes por rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  titulo,
  cuerpo,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Los disparadores mantienen el índice al día. Con content='nodes' hay que
-- escribir la fila 'delete' con los valores VIEJOS antes de reindexar.
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, titulo, cuerpo) VALUES (new.rowid, new.titulo, new.cuerpo);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, titulo, cuerpo) VALUES ('delete', old.rowid, old.titulo, old.cuerpo);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, titulo, cuerpo) VALUES ('delete', old.rowid, old.titulo, old.cuerpo);
  INSERT INTO nodes_fts(rowid, titulo, cuerpo) VALUES (new.rowid, new.titulo, new.cuerpo);
END;

-- Metadatos sueltos del propio CdP (versión de esquema, marca del último export
-- a Drive, contador de ids). Clave-valor y no le demos más vueltas.
CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
