import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data.sqlite');
const db = new Database(dbPath);

// Carica schema base
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;

function hasTable(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

function hasColumn(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(c => c.name === column);
}

/* ------------------------------------------------------------------
   FALLBACK: crea 'venues' se manca (con colonne aggiornate)
------------------------------------------------------------------- */
if (!hasTable('venues')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT UNIQUE,
      indirizzo TEXT,
      comune TEXT,
      provincia TEXT,
      codice_sede TEXT,
      codice_pdv  TEXT
    );
  `);
}

/* ------------------------------------------------------------------
   MIGRAZIONI SAFE (aggiunge colonne se mancano)
------------------------------------------------------------------- */
// machine_daily.mac_address
if (hasTable('machine_daily') && !hasColumn('machine_daily', 'mac_address')) {
  db.exec(`ALTER TABLE machine_daily ADD COLUMN mac_address TEXT;`);
}

// models.official_name
if (hasTable('models') && !hasColumn('models', 'official_name')) {
  db.exec(`ALTER TABLE models ADD COLUMN official_name TEXT;`);
}

// venues.codice_sede / venues.codice_pdv
if (hasTable('venues') && !hasColumn('venues', 'codice_sede')) {
  db.exec(`ALTER TABLE venues ADD COLUMN codice_sede TEXT;`);
}
if (hasTable('venues') && !hasColumn('venues', 'codice_pdv')) {
  db.exec(`ALTER TABLE venues ADD COLUMN codice_pdv TEXT;`);
}
// Nuove colonne per i modelli (scheda PDF)
if (hasTable('models') && !hasColumn('models', 'manufacturer')) {
  db.exec(`ALTER TABLE models ADD COLUMN manufacturer TEXT;`);
}
if (hasTable('models') && !hasColumn('models', 'commercial_name')) {
  db.exec(`ALTER TABLE models ADD COLUMN commercial_name TEXT;`);
}
