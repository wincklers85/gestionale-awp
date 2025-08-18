PRAGMA journal_mode=WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codice_modello TEXT,
  nome TEXT,
  default_payout_percent REAL,
  default_cycle_length_in REAL,
  official_name TEXT
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT UNIQUE,
  indirizzo TEXT,
  comune TEXT,
  provincia TEXT
);

CREATE TABLE IF NOT EXISTS pdas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac TEXT UNIQUE,
  venue_id INTEGER,
  last_seen_at TEXT,
  FOREIGN KEY(venue_id) REFERENCES venues(id)
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codeid TEXT UNIQUE,
  codeid_provv TEXT,
  noe TEXT,
  modello_id INTEGER,
  esercizio_id INTEGER,
  stato TEXT,
  data_attivazione TEXT,
  percent_out_em REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(modello_id) REFERENCES models(id),
  FOREIGN KEY(esercizio_id) REFERENCES venues(id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploaded_at TEXT DEFAULT (datetime('now')),
  source_filename TEXT,
  file_hash TEXT UNIQUE,
  rows_count INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS machine_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  reading_at TEXT,
  data_ultimo_collegamento TEXT,
  gg_mancato_collegamento REAL,
  gg_decadenza REAL,
  data_ultima_lettura_val TEXT,
  cnttotin REAL,
  cnttotot REAL,
  incasso_giornaliero REAL,
  media_incasso_gg REAL,
  warning TEXT,
  awp TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(machine_id, data_ultima_lettura_val),
  FOREIGN KEY(machine_id) REFERENCES machines(id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS cycles (
  machine_id INTEGER PRIMARY KEY,
  cycle_start_date TEXT,
  cycle_start_in_counter REAL,
  cycle_start_out_counter REAL,
  cycle_length_in REAL,
  target_payout_percent REAL,
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(machine_id) REFERENCES machines(id)
);

CREATE INDEX IF NOT EXISTS idx_machines_codeid ON machines(codeid);
CREATE INDEX IF NOT EXISTS idx_daily_machine_reading ON machine_daily(machine_id, reading_at);
