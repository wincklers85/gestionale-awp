export function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// numero IT → Number
export function parseItalianNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const str = String(v).trim();
  if (!str || str.toUpperCase() === 'ND') return null;
  const norm = str.replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return isNaN(n) ? null : n;
}

// dd/mm/yyyy[ hh:mm[:ss]] → ISO
export function parseItalianDateTime(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();

  const str = String(v).trim();
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [_, dd, mm, yyyy, HH = '00', MM = '00', SS = '00'] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d2 = new Date(str);
  return isNaN(d2.getTime()) ? null : d2.toISOString();
}


export function mapHeader(h) {
  const key = String(h || '').trim().toLowerCase();

  const replacements = {
    'codeid': 'codeid',
    'codeid provv': 'codeid_provv',
    'descr. stato': 'stato',
    'stato': 'stato',
    'data attivazione': 'data_attivazione',
    'data ultimo collegamento': 'data_ultimo_collegamento',
    'gg mancato collegamento': 'gg_mancato_collegamento',
    'gg decadenza': 'gg_decadenza',
    'data ultima lettura val.': 'data_ultima_lettura_val',
    'cnttotin': 'cnttotin',
    'cnttotot': 'cnttotot',
    'data rilascio n.o.e.': 'data_rilascio_noe',
    'noe': 'noe',
    'codice modello': 'codice_modello',
    'cod. modello': 'codice_modello',
    'cod. mod.': 'codice_modello',
    'model code': 'codice_modello',
    'model': 'codice_modello',
    'modello (codice)': 'codice_modello',
    'esercizio': 'esercizio',
    'denomin. sede': 'denominazione',
    'denominazione sede': 'denominazione',   // per sicurezza varianti
    'denominazione (sede)': 'denominazione',
    'denominazione': 'denominazione',     // NEW (nome locale)
    'codice sede': 'codice_sede',
    'codice pdv': 'codice_pdv',
    'cod. sede': 'codice_sede',
    'cod. pdv': 'codice_pdv',
    'indirizzo': 'indirizzo',             // NEW
    'provincia': 'provincia',             // NEW
    'comune': 'comune',                   // NEW
    'macaddress pda': 'mac_address',
    'mac address pda': 'mac_address',
    'macaddress': 'mac_address',
    'mac': 'mac_address',
    'mac (pda)': 'mac_address',
    'mac address (pda)': 'mac_address',
    'incasso giornaliero': 'incasso_giornaliero',
    'media incasso gg': 'media_incasso_gg',
    'warning': 'warning',
    'ir': 'ir',
    'awp': 'awp'
  };
  return replacements[key] || slugify(key);
}
