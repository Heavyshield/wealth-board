// Data layer: load the three JSON files, validate them, keep a local working copy,
// apply edits with a changelog. Storage backends (Drive, local folder) plug in later
// through the same load/save shape; today the source is ./data/*.json (read-only)
// plus a working copy in localStorage.

import { validate } from './schema.js';

export const FILES = ['portfolio', 'config', 'history'];
const WORKING_KEY = (file) => `wb.working.${file}`;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${url} : JSON illisible (${e.message})`);
  }
}

/** Load schemas once. */
export async function loadSchemas(base = '.') {
  const entries = await Promise.all(FILES.map(async (f) => [f, await fetchJson(`${base}/schema/${f}.schema.json`)]));
  return Object.fromEntries(entries);
}

/** Checks JSON Schema cannot express: ids unique, references to config ids exist. */
export function crossCheck(portfolio, config) {
  const errors = [];
  const envelopes = new Set(config.envelopes.map((e) => e.id));
  const classes = new Map(config.asset_classes.map((c) => [c.id, c]));
  const seen = new Set();
  portfolio.holdings.forEach((h, i) => {
    const at = `holdings[${i}] (${h.id})`;
    if (seen.has(h.id)) errors.push({ path: at, message: 'id en double' });
    seen.add(h.id);
    if (!envelopes.has(h.envelope)) errors.push({ path: `${at}.envelope`, message: `enveloppe « ${h.envelope} » absente de config.envelopes` });
    const cls = classes.get(h.asset_class);
    if (!cls) errors.push({ path: `${at}.asset_class`, message: `classe « ${h.asset_class} » absente de config.asset_classes` });
    if (cls?.pricing === 'spot' && !h.metal) errors.push({ path: at, message: 'ligne métal sans bloc « metal » (code, poids, unité, pureté)' });
  });
  const t = config.allocation_targets;
  if (t) {
    const sum = Object.values(t.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) errors.push({ path: 'config.allocation_targets.weights', message: `la somme des cibles fait ${Math.round(sum * 1000) / 10} %, attendu 100 %` });
    const known = t.group_by === 'asset_class' ? classes : t.group_by === 'envelope' ? envelopes : null;
    for (const k of Object.keys(t.weights)) {
      if (known && !known.has(k)) errors.push({ path: `config.allocation_targets.weights.${k}`, message: `« ${k} » inconnu dans config.${t.group_by === 'asset_class' ? 'asset_classes' : 'envelopes'}` });
    }
  }
  return errors;
}

/** Validate all files. Returns { file: errors[] } with only files that have errors. */
export function validateAll(files, schemas) {
  const out = {};
  for (const f of FILES) {
    const errs = validate(schemas[f], files[f]);
    if (errs.length) out[f] = errs;
  }
  if (!out.portfolio && !out.config) {
    const errs = crossCheck(files.portfolio, files.config);
    if (errs.length) out.portfolio = errs;
  }
  return out;
}

/**
 * Load files from ./data, then reconcile with the localStorage working copy.
 * Returns { files, conflicts: [{ file, mine, theirs }] }.
 * A conflict means the source file changed (higher revision) since the working copy
 * was based on it: the UI must ask, never pick silently.
 */
export async function loadAll(base = '.') {
  const source = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await fetchJson(`${base}/data/${f}.json`)])));
  const files = {};
  const conflicts = [];
  for (const f of FILES) {
    const working = readWorking(f);
    if (!working) { files[f] = source[f]; continue; }
    if (working.base_revision === source[f].revision) files[f] = working.data;
    else { files[f] = working.data; conflicts.push({ file: f, mine: working.data, theirs: source[f] }); }
  }
  return { files, source, conflicts };
}

function readWorking(file) {
  try { return JSON.parse(localStorage.getItem(WORKING_KEY(file))); } catch { return null; }
}

/** Persist a working copy. `baseRevision` = revision of the source file it derives from. */
export function saveWorking(file, data, baseRevision) {
  localStorage.setItem(WORKING_KEY(file), JSON.stringify({ base_revision: baseRevision, saved_at: new Date().toISOString(), data }));
}

export function dropWorking(file) { localStorage.removeItem(WORKING_KEY(file)); }

export function hasWorking(file) { return localStorage.getItem(WORKING_KEY(file)) !== null; }

/**
 * Apply pending edits to the portfolio. `edits` = { holdingId: { field: newValue } }.
 * Returns a NEW portfolio with revision+1, updated_at, changelog entries appended.
 */
export function applyEdits(portfolio, edits, author = 'user', now = new Date()) {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = structuredClone(portfolio);
  for (const [id, fields] of Object.entries(edits)) {
    const h = next.holdings.find((x) => x.id === id);
    if (!h) continue;
    for (const [field, value] of Object.entries(fields)) {
      if (h[field] === value) continue;
      next.changelog.push({ date, file: 'portfolio', target: id, field, old: h[field] ?? null, new: value, author });
      h[field] = value;
      h.updated_at = date;
    }
  }
  next.revision = portfolio.revision + 1;
  next.updated_at = date;
  return next;
}

/** Trigger a JSON download of a data file (export fallback, always available). */
export function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
