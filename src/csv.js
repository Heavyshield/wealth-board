// Tolerant CSV reading for bank/broker exports. Pure functions, no DOM.
// - encoding: UTF-8 (with or without BOM), falls back to Windows-1252 (common for French bank exports)
// - separator: auto-detected among ; , tab (from the header line, quotes respected)
// - quotes: RFC 4180 ("" escapes, separators and newlines inside quotes)
// - numbers: "1 234,56", "1.234,56", "1,234.56", "12,5 %", "-3,20 €", "(45,00)" all parsed

/** Decode bytes: strict UTF-8 first, else Windows-1252. Returns { text, encoding }. */
export function decode(bytes) {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: text.replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
  }
}

function splitLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Split text into logical lines (newlines inside quotes are kept). */
function logicalLines(text) {
  const lines = [];
  let cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    if (!q && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      lines.push(cur); cur = '';
    } else cur += c;
  }
  if (cur) lines.push(cur);
  return lines;
}

function countOutsideQuotes(line, ch) {
  let n = 0, q = false;
  for (const c of line) { if (c === '"') q = !q; else if (!q && c === ch) n++; }
  return n;
}

/**
 * Parse CSV text. Returns { headers, rows: [ {header: value} ], separator, skipped }.
 * Blank lines are dropped; rows with a different column count are kept if they have at least
 * half the columns (trailing empties are common), else reported in `skipped`.
 */
export function parseCsv(text) {
  const lines = logicalLines(text).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [], separator: ';', skipped: [] };
  // Some exports put a title line first: use the first line that has a separator.
  let h = lines.findIndex((l) => [';', ',', '\t'].some((s) => countOutsideQuotes(l, s) > 0));
  if (h < 0) h = 0;
  const sep = [';', '\t', ','].map((s) => [s, countOutsideQuotes(lines[h], s)]).sort((a, b) => b[1] - a[1])[0][0];
  const headers = splitLine(lines[h], sep);
  const rows = [], skipped = [];
  for (let i = h + 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    if (cells.length < Math.ceil(headers.length / 2)) { skipped.push({ line: i + 1, text: lines[i].slice(0, 120) }); continue; }
    rows.push(Object.fromEntries(headers.map((name, j) => [name, cells[j] ?? ''])));
  }
  return { headers, rows, separator: sep, skipped };
}

/** Header normalisation for alias matching: lowercase, no accents, no punctuation. */
export function normHeader(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Parse a number written the French or English way. Returns NaN when it is not a number.
 * The last of "," / "." present is the decimal mark when both appear; a lone "," is decimal;
 * a lone "." followed by exactly 3 digits in a value with several groups is a thousands mark.
 */
export function parseLooseNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s  ]/g, '').replace(/[€$£%]|EUR|USD|CHF|GBP/gi, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = (s.match(/,/g).length > 1) ? s.split(',').join('') : s.replace(',', '.');
  } else if (lastDot >= 0 && s.match(/\./g).length > 1) {
    s = s.split('.').join('');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
  const n = Number(s);
  return neg ? -n : n;
}

/** Export time from a Boursorama-style file name: ...-dd-MM-yyyy_hh-mm-ss.csv -> ISO (local time). */
export function dateFromFileName(name) {
  const m = /(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/.exec(name ?? '');
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  return isNaN(d) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
