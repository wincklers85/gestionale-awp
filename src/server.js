import { importModelsFromPdf } from './pdf_models.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import db from './db.js';
import { ingestXlsx } from './ingest.js';
import { getEndCycleAlerts } from './prediction.js';


const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});
app.use(express.static(path.join(process.cwd(), 'public')));

// Health
app.get('/api/health', (req,res)=> res.json({ ok: true }));

// Ingest XLSX
app.post('/api/ingest', upload.single('file'), (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
    const force = String(req.query.force || '').trim() === '1' || req.body?.force === true;
    const result = ingestXlsx(req.file.buffer, req.file.originalname, { force });

    if (result.duplicate) {
  return res.status(200).json({ message: 'File già importato in precedenza', result });
}
return res.json({ message: 'Import completato', result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// in cima: import { importModelsFromPdf } from './pdf_models.js';
app.post('/api/models/import-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file PDF (campo "file")' });
    const result = await importModelsFromPdf(req.file.buffer);
    res.json({ message: 'PDF import elaborato', result });
  } catch (err) {
    console.error('IMPORT PDF ERROR:', err);
    res.status(500).json({ error: err?.message || 'Errore interno durante import PDF', stack: err?.stack || null });
  }
});
// Macchine con ultima lettura/cnt
app.get('/api/machines', (req,res) => {
  const { q, modello, esercizio, stato, limit=200, offset=0 } = req.query;
  let sql = `
    WITH last AS (
      SELECT md.machine_id, md.reading_at, md.cnttotin, md.cnttotot
      FROM machine_daily md
      JOIN (
        SELECT machine_id, MAX(datetime(reading_at)) AS mx
        FROM machine_daily
        GROUP BY machine_id
      ) j ON j.machine_id = md.machine_id AND datetime(md.reading_at) = j.mx
    )
    SELECT mach.id, mach.codeid, mach.codeid_provv, mach.stato, mach.data_attivazione, mach.percent_out_em,
           v.nome as esercizio, v.indirizzo, v.comune, v.provincia,
           m.nome as modello,
           last.reading_at as last_reading_at, last.cnttotin as last_cnttotin, last.cnttotot as last_cnttotot
    FROM machines mach
    LEFT JOIN venues v ON v.id = mach.esercizio_id
    LEFT JOIN models m ON m.id = mach.modello_id
    LEFT JOIN last ON last.machine_id = mach.id
    WHERE 1=1`;
  const params = [];
  if (q) { sql += ` AND mach.codeid LIKE ?`; params.push('%'+q+'%'); }
  if (modello) { sql += ` AND m.nome = ?`; params.push(modello); }
  if (esercizio) { sql += ` AND v.nome = ?`; params.push(esercizio); }
  if (stato) { sql += ` AND mach.stato = ?`; params.push(stato); }
  sql += ` ORDER BY v.nome, mach.codeid LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Dettaglio macchina
app.get('/api/machines/:codeid', (req,res) => {
  const { codeid } = req.params;
  const mach = db.prepare(`
    SELECT mach.*,
           v.nome as esercizio, v.indirizzo, v.comune, v.provincia,
           m.nome as modello,
           m.official_name as modello_official   -- <— AGGIUNTO
    FROM machines mach
    LEFT JOIN venues v ON v.id = mach.esercizio_id
    LEFT JOIN models m ON m.id = mach.modello_id
    WHERE mach.codeid = ?
  `).get(codeid);
  if (!mach) return res.status(404).json({ error: 'Macchina non trovata' });
  const daily = db.prepare(`
    SELECT * FROM machine_daily WHERE machine_id = ? ORDER BY datetime(reading_at) DESC LIMIT 200
  `).all(mach.id);
  const cycle = db.prepare(`SELECT * FROM cycles WHERE machine_id = ?`).get(mach.id);
  res.json({ machine: mach, daily, cycle });
});

// Ciclo (set/update)
app.put('/api/cycles/:codeid', (req,res) => {
  const { codeid } = req.params;
  const mach = db.prepare(`SELECT id FROM machines WHERE codeid = ?`).get(codeid);
  if (!mach) return res.status(404).json({ error: 'Macchina non trovata' });
  const { cycle_start_date, cycle_start_in_counter, cycle_start_out_counter, cycle_length_in, target_payout_percent, note } = req.body || {};
  const exists = db.prepare(`SELECT machine_id FROM cycles WHERE machine_id=?`).get(mach.id);
  if (exists) {
    db.prepare(`UPDATE cycles SET cycle_start_date=?, cycle_start_in_counter=?, cycle_start_out_counter=?, cycle_length_in=?, target_payout_percent=?, note=?, updated_at=datetime('now') WHERE machine_id=?`)
      .run(cycle_start_date || null, cycle_start_in_counter ?? null, cycle_start_out_counter ?? null, cycle_length_in ?? null, target_payout_percent ?? null, note || null, mach.id);
  } else {
    db.prepare(`INSERT INTO cycles (machine_id, cycle_start_date, cycle_start_in_counter, cycle_start_out_counter, cycle_length_in, target_payout_percent, note) VALUES (?,?,?,?,?,?,?)`)
      .run(mach.id, cycle_start_date || null, cycle_start_in_counter ?? null, cycle_start_out_counter ?? null, cycle_length_in ?? null, target_payout_percent ?? null, note || null);
  }
  res.json({ ok: true });
});

// Modelli: summary e lista + update impostazioni
app.get('/api/models/summary', (req,res) => {
  const rows = db.prepare(`
    SELECT m.nome as modello, COUNT(*) as num_machines
    FROM machines mach
    LEFT JOIN models m ON m.id = mach.modello_id
    GROUP BY modello
    ORDER BY num_machines DESC, modello ASC
  `).all();
  res.json(rows);
});

// Elenco modelli con default presi (anche) dal PDF
app.get('/api/models', (req, res) => {
  const rows = db.prepare(`
    SELECT id, codice_modello, nome, official_name, default_payout_percent, default_cycle_length_in
    FROM models
    ORDER BY codice_modello
  `).all();
  res.json(rows);
});

app.put('/api/models/:id', (req,res) => {
  const { id } = req.params;
  const { default_payout_percent, default_cycle_length_in } = req.body || {};
  db.prepare(`UPDATE models SET default_payout_percent = COALESCE(?, default_payout_percent),
                               default_cycle_length_in = COALESCE(?, default_cycle_length_in)
             WHERE id = ?`).run(default_payout_percent ?? null, default_cycle_length_in ?? null, id);
  res.json({ ok: true });
});

// Locali
app.get('/api/venues', (req,res) => {
  const rows = db.prepare(`
    SELECT v.id, v.nome, v.indirizzo, v.comune, v.provincia,
           COUNT(mach.id) AS num_machines
    FROM venues v
    LEFT JOIN machines mach ON mach.esercizio_id = v.id
    GROUP BY v.id
    ORDER BY v.nome
  `).all();
  res.json(rows);
});

// Lista PDA (per pdas.html senza ?mac)
app.get('/api/pdas', (req, res) => {
  const rows = db.prepare(`
    SELECT p.mac, p.last_seen_at,
           v.nome AS venue, v.indirizzo, v.comune, v.provincia
    FROM pdas p
    LEFT JOIN venues v ON v.id = p.venue_id
    ORDER BY (p.last_seen_at IS NULL), datetime(p.last_seen_at) DESC, p.mac ASC
    LIMIT 500
  `).all();
  res.json(rows);
});

app.get('/api/pdas/:mac', (req,res) => {
  const mac = req.params.mac.toUpperCase();
  const p = db.prepare(`
    SELECT p.mac, p.last_seen_at, v.nome as venue, v.indirizzo, v.comune, v.provincia
    FROM pdas p
    LEFT JOIN venues v ON v.id = p.venue_id
    WHERE p.mac = ?
  `).get(mac);
  if (!p) return res.status(404).json({ error: 'PDA non trovato' });
  res.json(p);
});
// PDA dettaglio + macchine collegate (per ultimo MAC visto)
app.get('/api/pdas/:mac/detail', (req,res)=>{
  const mac = req.params.mac.toUpperCase();
  const pda = db.prepare(`
    SELECT p.mac, p.last_seen_at, v.id as venue_id, v.nome as venue, v.indirizzo, v.comune, v.provincia
    FROM pdas p LEFT JOIN venues v ON v.id = p.venue_id
    WHERE p.mac = ?
  `).get(mac);
  if (!pda) return res.status(404).json({ error:'PDA non trovato' });

  // macchine il cui ultimo daily ha quel MAC
  const machines = db.prepare(`
    WITH last AS (
      SELECT md.machine_id, MAX(datetime(reading_at)) as mx
      FROM machine_daily md
      GROUP BY md.machine_id
    )
    SELECT mach.codeid,
           v.nome AS esercizio,
           md.cnttotin, md.cnttotot, md.reading_at
    FROM machines mach
    JOIN last ON last.machine_id = mach.id
    JOIN machine_daily md ON md.machine_id = mach.id AND datetime(md.reading_at) = datetime(last.mx)
    LEFT JOIN venues v ON v.id = mach.esercizio_id
    WHERE UPPER(md.mac_address) = ?
    ORDER BY md.reading_at DESC
  `).all(mac);

  res.json({ pda, machines });
});
// Locale dettaglio
app.get('/api/venues/:id/detail', (req,res)=>{
  const id = Number(req.params.id);
  const v = db.prepare(`
    SELECT id, nome, indirizzo, comune, provincia, codice_sede, codice_pdv
    FROM venues WHERE id=?
  `).get(id);
  if (!v) return res.status(404).json({ error: 'Locale non trovato' });

  const machines = db.prepare(`
    WITH last AS (
      SELECT machine_id, MAX(data_ultima_lettura_val) AS max_read
      FROM machine_daily
      GROUP BY machine_id
    )
    SELECT m.codeid,
           mdl.nome AS modello,
           md.cnttotin, md.cnttotot, md.reading_at,
           md.mac_address
    FROM machines m
    LEFT JOIN last ON last.machine_id = m.id
    LEFT JOIN machine_daily md ON md.machine_id = m.id AND md.data_ultima_lettura_val = last.max_read
    LEFT JOIN models mdl ON mdl.id = m.modello_id
    WHERE m.esercizio_id = ?
    ORDER BY m.codeid
  `).all(id);

  const pdas = db.prepare(`
    SELECT mac, last_seen_at
    FROM pdas
    WHERE venue_id = ?
    ORDER BY (last_seen_at IS NULL), datetime(last_seen_at) DESC, mac ASC
  `).all(id);

  res.json({ venue: v, machines, pdas });
});


// Allerta fine ciclo
app.get('/api/alerts/end-cycle', (req,res) => {
  const windowDays = Number(req.query.windowDays || 14);
  const limit = Number(req.query.limit || 100);
  const rows = getEndCycleAlerts(windowDays, limit);
  res.json(rows);
});

// Decadenza (invariato)
app.get('/api/alerts/decadenza', (req,res) => {
  const rows = db.prepare(`
    SELECT v.nome as esercizio, mach.codeid, m.nome as modello, md.gg_decadenza
    FROM machine_daily md
    JOIN machines mach ON md.machine_id = mach.id
    LEFT JOIN venues v ON mach.esercizio_id = v.id
    LEFT JOIN models m ON mach.modello_id = m.id
    WHERE md.gg_decadenza IS NOT NULL
    GROUP BY mach.id
    ORDER BY md.gg_decadenza ASC
    LIMIT 100
  `).all();
  res.json(rows);
});
app.get('/api/search', (req,res)=>{
  const q = (req.query.q||'').trim();
  if (!q) return res.json([]);

  const like      = `%${q}%`;
  const normLike  = `%${q.replace(/[^A-Za-z0-9]/g,'')}%`;

  const machines = db.prepare(`
    SELECT codeid,
           (SELECT nome FROM venues v WHERE v.id = m.esercizio_id) AS esercizio
    FROM machines m
    WHERE codeid LIKE ?
    ORDER BY codeid LIMIT 10
  `).all(like);

  const pdas = db.prepare(`
    SELECT p.mac,
           (SELECT nome FROM venues v WHERE v.id = p.venue_id) AS venue
    FROM pdas p
    WHERE p.mac LIKE ?
       OR REPLACE(p.mac, ':', '') LIKE ?
    ORDER BY p.mac LIMIT 10
  `).all(like, normLike);

  const venues = db.prepare(`
    SELECT id, nome, indirizzo, comune, provincia
    FROM venues
    WHERE nome LIKE ?
       OR indirizzo LIKE ?
       OR comune LIKE ?
       OR provincia LIKE ?
    ORDER BY nome LIMIT 10
  `).all(like, like, like, like);

  const out = [
    ...machines.map(m => ({
      kind:'MACCHINA',
      label:m.codeid,
      sub:m.esercizio || '',
      url:`machine.html?codeid=${encodeURIComponent(m.codeid)}`
    })),
    ...pdas.map(p => ({
      kind:'PDA',
      label:p.mac,
      sub:p.venue || '',
      url:`pdas.html?mac=${encodeURIComponent(p.mac)}`
    })),
    ...venues.map(v => ({
      kind:'LOCALE',
      label:v.nome,
      sub:[v.indirizzo, v.comune, v.provincia].filter(Boolean).join(' · '),
      url:`venue.html?id=${v.id}`
    })),
  ].slice(0,20);

  res.json(out);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on http://localhost:'+PORT);
});
// Scheda modelli per Impostazioni
app.get('/api/models/adm', (req, res) => {
  const rows = db.prepare(`
    SELECT id, codice_modello, commercial_name, manufacturer,
           default_payout_percent, default_cycle_length_in
    FROM models
    ORDER BY (commercial_name IS NULL), commercial_name, codice_modello
  `).all();
  res.json(rows);
});
