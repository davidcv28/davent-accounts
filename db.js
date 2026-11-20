/* Persistencia del servicio de cuentas — node:sqlite (built-in, cero deps).
   Un solo archivo davent.db al lado del código. Tablas:

   accounts   un cupón canjeado = una cuenta vigente (code → days)
   devices    dispositivos registrados por cuenta (histórico, para auditoría)
   screens    leases de pantalla activa: expiran solas si el player deja de
              hacer heartbeat (SCREEN_TTL_MS)
   debrid     key de debrid POR CUENTA (el usuario pone la suya)
   vod / series_index  índice del catálogo Xtream (name+year → stream_id) —
              se reconstruye periódicamente, es cache, no estado */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'davent.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    code        TEXT PRIMARY KEY,
    days        INTEGER NOT NULL,
    max_screens INTEGER NOT NULL DEFAULT 3,
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    activated_at INTEGER,
    revoked     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS devices (
    account_code TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    PRIMARY KEY (account_code, device_id)
  );
  CREATE TABLE IF NOT EXISTS screens (
    account_code TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    lease_until  INTEGER NOT NULL,
    PRIMARY KEY (account_code, device_id)
  );
  CREATE TABLE IF NOT EXISTS debrid (
    account_code TEXT PRIMARY KEY,
    service      TEXT NOT NULL,
    api_key      TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vod (
    stream_id INTEGER NOT NULL,
    name      TEXT NOT NULL,
    norm      TEXT NOT NULL,
    year      INTEGER,
    ext       TEXT NOT NULL DEFAULT 'mp4',
    variant   TEXT NOT NULL DEFAULT 'latino',
    panel_key TEXT NOT NULL,
    PRIMARY KEY (panel_key, stream_id)
  );
  CREATE INDEX IF NOT EXISTS vod_norm ON vod (norm);
  CREATE TABLE IF NOT EXISTS series_index (
    series_id INTEGER NOT NULL,
    name      TEXT NOT NULL,
    norm      TEXT NOT NULL,
    year      INTEGER,
    panel_key TEXT NOT NULL,
    PRIMARY KEY (panel_key, series_id)
  );
  CREATE INDEX IF NOT EXISTS series_norm ON series_index (norm);
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );
`);

/* Migración multi-panel: el esquema viejo tenía stream_id/series_id como PK
   simple — los ids son POR PANEL y dos paneles chocarían. Es cache de
   catálogo (se resincroniza solo), así que se dropea sin drama. */
const pkCols = (t) =>
  db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('${t}') WHERE pk > 0`).get().n;
if (pkCols('vod') === 1) {
  db.exec(`
    DROP TABLE vod;
    DROP TABLE series_index;
    CREATE TABLE vod (
      stream_id INTEGER NOT NULL,
      name      TEXT NOT NULL,
      norm      TEXT NOT NULL,
      year      INTEGER,
      ext       TEXT NOT NULL DEFAULT 'mp4',
      variant   TEXT NOT NULL DEFAULT 'latino',
      panel_key TEXT NOT NULL,
      PRIMARY KEY (panel_key, stream_id)
    );
    CREATE INDEX IF NOT EXISTS vod_norm ON vod (norm);
    CREATE TABLE series_index (
      series_id INTEGER NOT NULL,
      name      TEXT NOT NULL,
      norm      TEXT NOT NULL,
      year      INTEGER,
      panel_key TEXT NOT NULL,
      PRIMARY KEY (panel_key, series_id)
    );
    CREATE INDEX IF NOT EXISTS series_norm ON series_index (norm);
  `);
}

module.exports = db;
/* Conexión separada para ESCRITURA del índice: el sync hace wipe+insert en
   una transacción — desde la misma conexión los SELECT ven la tabla ya
   vaciada (lectura propia del tx). Con WAL, un lector en otra conexión sigue
   viendo el último snapshot commiteado hasta el COMMIT, así que los resolve
   nunca encuentran la tabla vacía a mitad de resync. */
module.exports.openWriter = () => new DatabaseSync(path.join(__dirname, 'davent.db'));
