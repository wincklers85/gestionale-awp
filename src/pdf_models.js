// src/pdf_models.js
import PDFParser from "pdf2json";
import db from "./db.js";

/** Estrae linee di testo dal PDF usando pdf2json (compatibile Node 20). */
function extractTextLinesWithPdf2Json(buffer) {
  return new Promise((resolve, reject) => {
    try {
      const Ctor = (PDFParser && PDFParser.default) ? PDFParser.default : PDFParser;
      const parser = new Ctor();

      parser.on("pdfParser_dataError", (err) =>
        reject(new Error(err?.parserError || String(err)))
      );

      parser.on("pdfParser_dataReady", (pdfData) => {
        try {
          const pages = pdfData?.Pages || [];
          const lines = [];

          for (const pg of pages) {
            const byY = new Map(); // y (arrotondato) -> array di {x, text}

            for (const t of pg?.Texts || []) {
              const yKey = Math.round(t.y);
              let frag = "";
              for (const r of t.R || []) {
                // decodeURIComponent perché pdf2json mette i testi url-encoded in R[i].T
                frag += decodeURIComponent(r.T || "");
              }
              const arr = byY.get(yKey) || [];
              arr.push({ x: t.x, text: frag });
              byY.set(yKey, arr);
            }

            // ordina per riga (y) e poi per x; unisci i frammenti
            const ys = [...byY.keys()].sort((a, b) => a - b);
            for (const y of ys) {
              const parts = (byY.get(y) || []).sort((a, b) => a.x - b.x).map((p) => p.text);
              const line = parts.join(" ").replace(/\s+/g, " ").trim();
              if (line) lines.push(line);
            }
          }

          resolve(lines);
        } catch (e) {
          reject(e);
        }
      });

      parser.parseBuffer(buffer);
    } catch (e) {
      reject(e);
    }
  });
}

const numFrom = (val) => {
  if (val == null) return null;
  const str = String(val).trim().replace(/\./g, "").replace(",", ".").replace("%", "");
  if (!str) return null;
  let n = Number(str);
  if (Number.isNaN(n)) return null;
  if (n > 1.5) n = n / 100; // 65 -> 0.65
  return n;
};

/**
 * Parsing del PDF e aggiornamento DB:
 * - default_cycle_length_in (N.PART.CICLO)
 * - default_payout_percent  (% MINIMA VINCITA CICLO PARTITE)
 * - official_name           (nome ufficiale/commerciale)
 * Match per codice modello.
 */
export async function importModelsFromPdf(buffer) {
  const lines = await extractTextLinesWithPdf2Json(buffer);
  if (!lines.length) throw new Error("PDF senza testo estraibile");

  // Regex robuste (varie formulazioni nei PDF)
  const reCode     = /\b(?:cod(?:ice)?\s*mod(?:ello)?|modello|model(?:\s*code)?|code)\s*[:\-]?\s*([A-Za-z0-9._\-\/]+)/i;
  const reCycle    = /\b(?:N\.?\s*PART\.?\s*CICLO|lunghezza\s*ciclo|ciclo|pay-?in)\s*[:\-]?\s*([0-9]{4,7})\b/i;
  const rePayout   = /\b(?:%?\s*minima\s*vincita\s*ciclo\s*partite|payout\s*minimo|payout)\s*[:\-]?\s*([0-9]{1,3}(?:[.,][0-9]+)?)%?/i;
  const reOfficial = /\b(?:nome\s*ufficiale(?:\s*adm)?|nome\s*commerciale|denominazione\s*commerciale)\s*[:\-]?\s*(.+)$/i;

  // Alcuni PDF contengono tutto su una riga: nome - codice - ciclo - payout
  const reAll = new RegExp(
    String.raw`([A-Za-z0-9._\-\/]+).*?(?:${reCycle.source}).*?(?:${rePayout.source})`,
    "i"
  );

  const found = [];
  let current = null; // { codice_modello, default_cycle_length_in, default_payout_percent, official_name }

  const flush = () => {
    if (!current || !current.codice_modello) { current = null; return; }
    if (current.default_payout_percent != null && current.default_payout_percent > 1.5) {
      current.default_payout_percent = current.default_payout_percent / 100;
    }
    found.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = String(raw).replace(/\s+/g, " ").trim();
    if (!line) continue;

    // riga "compressa": tutto assieme
    const combo = line.match(reAll);
    if (combo) {
      // combo[1] non è per forza il codice: ri-proviamo con reCode per estrarlo correttamente
      const mc = line.match(reCode);
      const code = mc ? mc[1].trim() : combo[1].trim();
      const cycM = line.match(reCycle);
      const payM = line.match(rePayout);
      flush();
      current = {
        codice_modello: code,
        default_cycle_length_in: cycM ? parseInt(cycM[1], 10) : null,
        default_payout_percent: payM ? numFrom(payM[1]) : null,
        official_name: null
      };
      flush();
      continue;
    }

    // inizio blocco modello
    const mCode = line.match(reCode);
    if (mCode) { flush(); current = {
      codice_modello: mCode[1].trim(),
      default_cycle_length_in: null,
      default_payout_percent: null,
      official_name: null
    }; continue; }

    if (!current) {
      // riga con "nome ufficiale" prima del codice (capita): la teniamo in sospeso?
      const mOff = line.match(reOfficial);
      if (mOff) {
        // nessun codice ancora -> saltiamo; verrà preso quando appare il codice
      }
      continue;
    }

    // attributi del modello "aperto"
    const mCyc = line.match(reCycle);
    if (mCyc) current.default_cycle_length_in = parseInt(mCyc[1], 10) || current.default_cycle_length_in;

    const mPay = line.match(rePayout);
    if (mPay) {
      const val = numFrom(mPay[1]);
      if (val != null) current.default_payout_percent = val;
    }

    const mOff = line.match(reOfficial);
    if (mOff) current.official_name = mOff[1].trim() || current.official_name;
  }
  flush();

  // Consolidamento per codice (ultimo valore vince)
  const byCode = new Map();
  for (const rec of found) {
    const prev = byCode.get(rec.codice_modello) || {};
    byCode.set(rec.codice_modello, {
      codice_modello: rec.codice_modello,
      default_cycle_length_in: rec.default_cycle_length_in ?? prev.default_cycle_length_in ?? null,
      default_payout_percent:  rec.default_payout_percent  ?? prev.default_payout_percent  ?? null,
      official_name:           rec.official_name           ?? prev.official_name           ?? null
    });
  }

  // Update/insert in DB per codice_modello
  let matched = 0, updated = 0, missing = 0;
  for (const rec of byCode.values()) {
    const row = db.prepare('SELECT id FROM models WHERE codice_modello IS ?').get(rec.codice_modello || null);
    if (row) {
      matched++;
      updated += db.prepare(`
        UPDATE models SET
          default_cycle_length_in = COALESCE(@default_cycle_length_in, default_cycle_length_in),
          default_payout_percent  = COALESCE(@default_payout_percent,  default_payout_percent),
          official_name           = COALESCE(@official_name,           official_name)
        WHERE id = @id
      `).run({ id: row.id, ...rec }).changes;
    } else {
      db.prepare(`
        INSERT INTO models (codice_modello, nome, default_cycle_length_in, default_payout_percent, official_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(rec.codice_modello, rec.official_name || null, rec.default_cycle_length_in, rec.default_payout_percent, rec.official_name || null);
      missing++;
    }
  }

  return {
    lines: lines.length,
    parsed: found.length,
    unique_models: byCode.size,
    matched_models: matched,
    updated_rows: updated,
    missing_models: missing
  };
}
