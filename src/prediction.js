import db from './db.js';

function getLastCounters(machineId){
  const row = db.prepare(`
    SELECT md.cnttotin, md.cnttotot, md.reading_at
    FROM machine_daily md
    WHERE md.machine_id = ?
    ORDER BY datetime(md.reading_at) DESC
    LIMIT 1
  `).get(machineId);
  return row || { cnttotin: null, cnttotot: null, reading_at: null };
}

function computeCycleStats(cntIn, cntOut, L, P){
  // L = N.PART.CICLO (es. 30000), P = payout (es. 0.65)
  if (!L || !P || cntIn == null || cntOut == null) {
    return { cycles_done:null, in_curr:null, out_curr:null, curr_pct:null, remaining_in:null, remaining_out_to_target:null, good:null };
  }
  const cycles_done = Math.floor(cntIn / L);
  const in_curr = cntIn - cycles_done * L;

  const cycleOutValue = Math.round(L * P); // es. 30000 * 0.65 = 19500
  const out_curr = cntOut - cycles_done * cycleOutValue;

  const curr_pct = (in_curr > 0) ? (out_curr / in_curr) : null; // % di pagamento del ciclo corrente
  const remaining_in = L - in_curr;                               // quanto resta da introdurre per finire ciclo
  const remaining_out_to_target = Math.max(0, cycleOutValue - out_curr); // quanto manca da pagare per arrivare al target ciclo

  const good = remaining_out_to_target <= remaining_in; // "buona" se quello che deve ancora pagare è ≤ a quanto resta da introdurre
  return { cycles_done, in_curr, out_curr, curr_pct, remaining_in, remaining_out_to_target, good, cycleOutValue };
}

export function getEndCycleAlerts(limit = 100){
  const machines = db.prepare(`
    SELECT mach.id as machine_id, mach.codeid, v.nome as esercizio, m.nome as modello,
           COALESCE(c.cycle_length_in, m.default_cycle_length_in) AS L,
           COALESCE(c.target_payout_percent, m.default_payout_percent, 0.65) AS P
    FROM machines mach
    LEFT JOIN venues v ON v.id = mach.esercizio_id
    LEFT JOIN models m ON m.id = mach.modello_id
    LEFT JOIN cycles c ON c.machine_id = mach.id
  `).all();

  const rows = [];
  for (const mc of machines){
    const last = getLastCounters(mc.machine_id);
    const stats = computeCycleStats(last.cnttotin, last.cnttotot, mc.L, mc.P);

    const percent_cycle = (stats.in_curr != null && mc.L) ? (stats.in_curr / mc.L) : null;
    const data = {
      codeid: mc.codeid,
      esercizio: mc.esercizio,
      modello: mc.modello,
      cycle_length_in: mc.L,
      payout_percent: mc.P,
      last_reading_at: last.reading_at,
      cycles_done: stats.cycles_done,
      in_corrente: stats.in_curr,
      out_corrente: stats.out_curr,
      pct_ciclo_corrente: (stats.curr_pct == null ? null : (stats.curr_pct * 100)),
      percentuale_ciclo: (percent_cycle == null ? null : (percent_cycle * 100)),
      manca_introdurre: stats.remaining_in,
      manca_pagare: stats.remaining_out_to_target,
      buona: !!stats.good
    };
    rows.push(data);
  }

  // Ordinamento: prima le "buone", poi più vicine a fine ciclo, poi chi ha più "manca pagare"
  rows.sort((a,b) => {
    if (a.buona !== b.buona) return a.buona ? -1 : 1; // buone per prime
    const pa = a.percentuale_ciclo ?? -1, pb = b.percentuale_ciclo ?? -1;
    if (pb !== pa) return pb - pa; // più vicine alla fine prima
    const ma = a.manca_pagare ?? 0, mb = b.manca_pagare ?? 0;
    return ma - mb;
  });

  return rows.slice(0, limit);
}
