// French formatting helpers. All display formatting goes through here.

let LOCALE = 'fr-FR';
export function setLocale(locale) { LOCALE = locale || 'fr-FR'; }

const cache = new Map();
function nf(key, opts) {
  const k = LOCALE + key;
  if (!cache.has(k)) cache.set(k, new Intl.NumberFormat(LOCALE, opts));
  return cache.get(k);
}

/** 1234.5, "EUR" -> "1 234,50 €" */
export function money(value, currency, { digits = 2 } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return nf(`m${currency}${digits}`, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Signed money: "+1 234,50 €" / "−56,00 €" */
export function signedMoney(value, currency) {
  if (value === null || value === undefined) return '—';
  return nf(`sm${currency}`, { style: 'currency', currency, signDisplay: 'exceptZero' }).format(value);
}

export function number(value, maxDigits = 4) {
  if (value === null || value === undefined) return '—';
  return nf(`n${maxDigits}`, { maximumFractionDigits: maxDigits }).format(value);
}

/** 0.1234 -> "+12,3 %" */
export function pct(ratio, { signed = true, digits = 1 } = {}) {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return '—';
  return nf(`p${signed}${digits}`, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signed ? 'exceptZero' : 'auto' }).format(ratio);
}

/** Signed plain number: "+1,5" */
export function signedNumber(value, digits = 1) {
  if (value === null || value === undefined || !isFinite(value)) return '—';
  return nf(`sn${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero' }).format(value);
}

/** Axis ticks: "45 k€", "1,2 M€" */
export function compactMoney(value, currency) {
  return nf(`cm${currency}`, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** "2026-03-20" -> "mars 26" */
export function monthLabel(iso) {
  return new Date(iso).toLocaleDateString(LOCALE, { month: 'short', year: '2-digit' });
}

export function date(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hasTime = iso.length > 10;
  return d.toLocaleString(LOCALE, hasTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Age in words: "il y a 3 j" */
export function age(iso, now = new Date()) {
  if (!iso) return '—';
  const h = (now - new Date(iso)) / 36e5;
  if (h < 1) return "il y a moins d'1 h";
  if (h < 48) return `il y a ${Math.round(h)} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

/** Parse a French-typed number: "1 234,5" -> 1234.5. Returns NaN if invalid. */
export function parseNumber(text) {
  const clean = String(text).replace(/[\s  ]/g, '').replace(',', '.');
  return clean === '' ? NaN : Number(clean);
}
