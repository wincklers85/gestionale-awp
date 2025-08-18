import crypto from 'crypto';
import XLSX from 'xlsx';
import db from './db.js';
import { mapHeader, parseItalianDateTime, parseItalianNumber } from './utils.js';

function hashFile(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function upsertModel(codice_modello, nome) {
  // 1) prova per codice
  const byCode = db.prepare('SELECT id FROM models WHERE codice_modello IS ?').get(codice_modello || null);
  if (byCode) {
    if (nome) {
      // aggiorna il nome se mancante (non sovrascrivo se già c’è)
      db.prepare('UPDATE models SET nome = COALESCE(nome, ?) WHERE id=?').run(nome, byCode.id);
    }
    return byCode.id;
  }
  // 2) se non c’è, inserisci con codice e (eventuale) nome
  const info = db.prepare(
    'INSERT INTO models (codice_modello, nome) VALUES (?, ?)'
  ).run(codice_modello || null, nome || null);
  return info.lastInsertRowid;
}

function clean(s) {
  return (s || '').toString().trim().replace(/\s+/g, ' ');
}

function dedupeAddressWords(addr) {
  // evita "VIA VIA ..." / parole duplicate consecutive
  return (addr || '').replace(/\b(\p{L}+)\s+\1\b/giu, '$1');
}

function buildVenueName(nome, indirizzo, comune, provincia) {
  const n = clean(nome);
  if (n) return n;
  const parts = [clean(indirizzo), clean(comune), clean(provincia)].filter(Boolean);
  return parts.length ? parts.join(' - ') : 'Senza nome';
}

function upsertVenueRaw({ nome, indirizzo, comune, provincia }) {
  const existing = db.prepare(
    `SELECT id FROM venues 
     WHERE nome = ? AND COALESCE(indirizzo,'') = COALESCE(?, '') 
       AND COALESCE(comune,'') = COALESCE(?, '') 
       AND COALESCE(provincia,'') = COALESCE(?, '')`
  ).get(nome, indirizzo || null, comune || null, provincia || null);

  if (existing) return existing.id;

  const info = db.prepare(
    `INSERT INTO venues (nome, indirizzo, comune, provincia) VALUES (?,?,?,?)`
  ).run(nome, indirizzo || null, comune || null, provincia || null);

  return info.lastInsertRowid;
}

function upsertVenue({ nome, indirizzo, comune, provincia, codice_sede, codice_pdv }) {
  const _nome = buildVenueName(nome, indirizzo, comune, provincia);

  // match completo (nome+indirizzo+comune+provincia)
  const existing = db.prepare(`
    SELECT id FROM venues
    WHERE nome = ? AND COALESCE(indirizzo,'') = COALESCE(?, '')
      AND COALESCE(comune,'')   = COALESCE(?, '')
      AND COALESCE(provincia,'')= COALESCE(?, '')
  `).get(_nome, indirizzo || null, comune || null, provincia || null);

  if (existing) {
    db.prepare(`UPDATE venues
                SET indirizzo   = COALESCE(?, indirizzo),
                    comune      = COALESCE(?, comune),
                    provincia   = COALESCE(?, provincia),
                    codice_sede = COALESCE(?, codice_sede),
                    codice_pdv  = COALESCE(?, codice_pdv)
                WHERE id = ?`)
      .run(indirizzo || null, comune || null, provincia || null,
           codice_sede || null, codice_pdv || null, existing.id);
    return existing.id;
  }

  const info = db.prepare(`
    INSERT INTO venues (nome, indirizzo, comune, provincia, codice_sede, codice_pdv)
    VALUES (?,?,?,?,?,?)
  `).run(_nome, indirizzo || null, comune || null, provincia || null,
         codice_sede || null, codice_pdv || null);

  return info.lastInsertRowid;
}

function upsertPda(mac, venue_id, seenAtISO) {
  if (!mac) return null;
  const existing = db.prepare('SELECT id FROM pdas WHERE mac = ?').get(mac);
  if (existing) {
    db.prepare('UPDATE pdas SET venue_id=?, last_seen_at=? WHERE id=?')
      .run(venue_id || null, seenAtISO || null, existing.id);
    return existing.id;
  } else {
    const info = db.prepare('INSERT INTO pdas (mac, venue_id, last_seen_at) VALUES (?,?,?)')
      .run(mac, venue_id || null, seenAtISO || null);
    return info.lastInsertRowid;
  }
}

function upsertMachine({ codeid, codeid_provv, noe, modello_id, esercizio_id, stato, data_attivazione, percent_out_em }) {
  const existing = db.prepare('SELECT id FROM machines WHERE codeid = ?').get(codeid);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE machines SET codeid_provv=?, noe=?, modello_id=?, esercizio_id=?, stato=?, data_attivazione=?, percent_out_em=?, updated_at=? WHERE id=?`)
      .run(codeid_provv || null, noe || null, modello_id || null, esercizio_id || null,
           stato || null, data_attivazione || null, percent_out_em ?? null, now, existing.id);
    return existing.id;
  } else {
    const info = db.prepare(`INSERT INTO machines (codeid, codeid_provv, noe, modello_id, esercizio_id, stato, data_attivazione, percent_out_em)
                             VALUES (?,?,?,?,?,?,?,?)`)
      .run(codeid, codeid_provv || null, noe || null, modello_id || null, esercizio_id || null,
           stato || null, data_attivazione || null, percent_out_em ?? null);
    return info.lastInsertRowid;
  }
}

export function ingestXlsx(buffer, originalFilename, options = {}) {
  const { force = false } = options;

  const baseHash = hashFile(buffer);
  const fileHash = force ? `${baseHash}::force::${Date.now()}` : baseHash;

  const existingSnap = db.prepare('SELECT id, uploaded_at FROM snapshots WHERE file_hash = ?').get(fileHash);
  if (existingSnap && !force) {
    return { duplicate: true, snapshotId: existingSnap.id, uploadedAt: existingSnap.uploaded_at };
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

  if (!rows || rows.length < 2) throw new Error('Foglio vuoto o senza intestazioni');

  const header = rows[0].map(mapHeader);
  const dataRows = rows.slice(1);

  const insSnap = db.prepare('INSERT INTO snapshots (source_filename, file_hash, rows_count) VALUES (?,?,?)');
  const snapshotId = insSnap.run(originalFilename || null, fileHash, dataRows.length).lastInsertRowid;

const insDaily = db.prepare(`
  INSERT INTO machine_daily
    (machine_id, snapshot_id, reading_at, data_ultimo_collegamento,
     gg_mancato_collegamento, gg_decadenza, data_ultima_lettura_val,
     cnttotin, cnttotot, incasso_giornaliero, media_incasso_gg, warning, awp, mac_address)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(machine_id, data_ultima_lettura_val) DO UPDATE SET
     reading_at            = excluded.reading_at,
     data_ultimo_collegamento = excluded.data_ultimo_collegamento,
     gg_mancato_collegamento  = excluded.gg_mancato_collegamento,
     gg_decadenza             = excluded.gg_decadenza,
     cnttotin              = COALESCE(excluded.cnttotin, machine_daily.cnttotin),
     cnttotot              = COALESCE(excluded.cnttotot, machine_daily.cnttotot),
     incasso_giornaliero   = COALESCE(excluded.incasso_giornaliero, machine_daily.incasso_giornaliero),
     media_incasso_gg      = COALESCE(excluded.media_incasso_gg, machine_daily.media_incasso_gg),
     warning               = COALESCE(excluded.warning, machine_daily.warning),
     awp                   = COALESCE(excluded.awp, machine_daily.awp),
     mac_address           = COALESCE(excluded.mac_address, machine_daily.mac_address)
`);

  let createdMachines = 0, updatedMachines = 0, insertedDaily = 0, skippedDaily = 0;

  const idx = name => header.indexOf(name);

  for (const r of dataRows) {
    const codeid = (r[idx('codeid')] || '').toString().trim();
    if (!codeid) continue;

    // Modello e payout di default
    const codice_modello = (r[idx('codice_modello')] || '').toString().trim();
    const modello_nome   = (r[idx('modello')] || '').toString().trim() || null;

    const modello_id = upsertModel(codice_modello, modello_nome);

// percentuale “% out e/m” continua ad andare nel campo macchina (se lo usi):
let percent_out_em = parseItalianNumber(r[idx('% out e/m')] ?? r[idx('percent_out_em')]);
if (percent_out_em && percent_out_em > 1.5) percent_out_em = percent_out_em / 100.0;

// Locale da DENOMINAZIONE + indirizzo (+ codici sede/PDV se presenti)
  const esercizio_nome = r[idx('denominazione')] || r[idx('esercizio')];
  const esercizio_id = upsertVenue({
  nome: esercizio_nome,
  indirizzo: r[idx('indirizzo')],
  comune: r[idx('comune')],
  provincia: r[idx('provincia')],
  codice_sede: r[idx('codice_sede')],
  codice_pdv: r[idx('codice_pdv')]
});

    // PDA (MAC → locale)
    const mac = (r[idx('mac_address')] || '').toString().trim().toUpperCase();
    const dataUltLettISO = parseItalianDateTime(r[idx('data_ultima_lettura_val')]);
    if (mac) upsertPda(mac, esercizio_id, dataUltLettISO);

    const data_attivazione = parseItalianDateTime(r[idx('data_attivazione')]);
    const existsBefore = db.prepare('SELECT id FROM machines WHERE codeid=?').get(codeid);
    const machine_id = upsertMachine({
      codeid,
      codeid_provv: r[idx('codeid_provv')],
      noe: r[idx('noe')],
      modello_id,
      esercizio_id,
      stato: r[idx('stato')],
      data_attivazione,
      percent_out_em
    });
    if (existsBefore) updatedMachines++; else createdMachines++;

  // Calcolo IN/OUT senza centesimi (rimuove gli ultimi due zeri)
const rawIn  = parseItalianNumber(r[idx('cnttotin')]);
const rawOut = parseItalianNumber(r[idx('cnttotot')]);
const cntIn  = (rawIn  == null) ? null : Math.floor(rawIn  / 100);
const cntOut = (rawOut == null) ? null : Math.floor(rawOut / 100);

// Storico giornaliero
const daily = {
  reading_at: dataUltLettISO,
  data_ultimo_collegamento: parseItalianDateTime(r[idx('data_ultimo_collegamento')]),
  gg_mancato_collegamento: parseItalianNumber(r[idx('gg_mancato_collegamento')]),
  gg_decadenza: parseItalianNumber(r[idx('gg_decadenza')]),
  data_ultima_lettura_val: dataUltLettISO,
  cnttotin: cntIn,                 // 👈 usa i valori calcolati
  cnttotot: cntOut,                // 👈 usa i valori calcolati
  incasso_giornaliero: parseItalianNumber(r[idx('incasso_giornaliero')]),
  media_incasso_gg: parseItalianNumber(r[idx('media_incasso_gg')]),
  warning: r[idx('warning')],
  awp: r[idx('awp')]
};


    try {
      insDaily.run(
        machine_id, snapshotId,
        daily.reading_at,
        daily.data_ultimo_collegamento,
        daily.gg_mancato_collegamento,
        daily.gg_decadenza,
        daily.data_ultima_lettura_val,
        daily.cnttotin,
        daily.cnttotot,
        daily.incasso_giornaliero,
        daily.media_incasso_gg,
        daily.warning,
        daily.awp,
        mac
);
      insertedDaily++;
    } catch {
      skippedDaily++;
    }
  }

  return {
    duplicate: false,
    snapshotId,
    createdMachines,
    updatedMachines,
    insertedDaily,
    skippedDaily
  };
}
