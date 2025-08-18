// public/app.js
window.qs = sel => document.querySelector(sel);
window.qsa = sel => Array.from(document.querySelectorAll(sel));
window.params = new URLSearchParams(location.search);
window.formatNum = (v, d = 0) =>
  v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
