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
  const scopeErrs = (scope, at) => {
    for (const k of scope?.asset_class ?? []) if (!classes.has(k)) errors.push({ path: at, message: `classe « ${k} » inconnue` });
    for (const k of scope?.envelope ?? []) if (!envelopes.has(k)) errors.push({ path: at, message: `enveloppe « ${k} » inconnue` });
  };
  (config.rules?.items ?? []).forEach((r, i) => scopeErrs(r.applies_to, `config.rules.items[${i}] (${r.id})`));
  (config.constraints ?? []).forEach((c, i) => {
    const at = `config.constraints[${i}] (${c.id})`;
    const need = { share_cap: ['group_by', 'keys'], runway: ['monthly_budget', 'target_months'] }[c.type] ?? [];
    for (const k of need) if (c[k] === undefined) errors.push({ path: at, message: `champ « ${k} » obligatoire pour le type ${c.type}` });
    scopeErrs(c.liquid, at);
  });
  for (const [id, p] of Object.entries(config.imports ?? {})) {
    const at = `config.imports.${id}`;
    if (p.envelope_default && !envelopes.has(p.envelope_default)) errors.push({ path: at, message: `enveloppe « ${p.envelope_default} » inconnue` });
    if (p.asset_class_default && !classes.has(p.asset_class_default)) errors.push({ path: at, message: `classe « ${p.asset_class_default} » inconnue` });
    if (!p.columns.isin && !p.columns.name) errors.push({ path: `${at}.columns`, message: 'il faut au moins des alias pour isin ou name (pour reconnaître les lignes)' });
  }
  (portfolio.accounts ?? []).forEach((a, i) => {
    if (!envelopes.has(a.envelope)) errors.push({ path: `accounts[${i}]`, message: `enveloppe « ${a.envelope} » inconnue` });
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

/** Where the user's data lives: 'repo' (sample, default), 'drive' or 'folder'. */
export const getSource = () => localStorage.getItem('wb.source') ?? 'repo';
export const setSource = (s) => localStorage.setItem('wb.source', s);

/**
 * Load files from ./data, then overlay the localStorage working copy.
 * Returns { files, source, conflicts: [{ file, mine, theirs }] }.
 * In 'repo' mode a conflict means the repo file changed (higher revision) since the working copy was
 * based on it: the UI asks. In 'drive' / 'folder' mode the repo files are only defaults for files that
 * have no local copy yet; Drive conflicts are handled by sync.js.
 */
export async function loadAll(base = '.') {
  const source = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await fetchJson(`${base}/data/${f}.json`)])));
  const files = {};
  const conflicts = [];
  const mode = getSource();
  for (const f of FILES) {
    const working = readWorking(f);
    if (!working) { files[f] = source[f]; continue; }
    files[f] = working.data;
    if (mode === 'repo' && working.base_revision !== source[f].revision && working.base_revision !== undefined) {
      conflicts.push({ file: f, mine: working.data, theirs: source[f] });
    }
  }
  return { files, source, conflicts };
}

/** Raw working-copy record { data, base_revision, saved_at, dirty, drive_version } or null. */
export function readWorking(file) {
  try { return JSON.parse(localStorage.getItem(WORKING_KEY(file))); } catch { return null; }
}

/**
 * Persist a working copy. `baseRevision` = revision of the repo file it derives from (repo mode).
 * extra.dirty (default true: a local edit not yet sent anywhere), extra.drive_version (kept from the
 * previous record when not given).
 */
export function saveWorking(file, data, baseRevision, extra = {}) {
  const prev = readWorking(file) ?? {};
  localStorage.setItem(WORKING_KEY(file), JSON.stringify({
    base_revision: baseRevision ?? prev.base_revision,
    saved_at: new Date().toISOString(),
    dirty: extra.dirty ?? true,
    drive_version: extra.drive_version ?? prev.drive_version,
    data,
  }));
}

export function dropWorking(file) { localStorage.removeItem(WORKING_KEY(file)); }

export function hasWorking(file) { return localStorage.getItem(WORKING_KEY(file)) !== null; }

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

/** Set a dotted path; `null` deletes the key. Creates intermediate objects. */
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => (o[k] ??= {}), obj);
  if (value === null) delete parent[last];
  else parent[last] = value;
}

/**
 * Apply pending edits to the portfolio. Fields may be dotted paths ("metrics.per"). `edits` = { holdingId: { field: newValue } }.
 * Returns a NEW portfolio with revision+1, updated_at, changelog entries appended.
 */
export function applyEdits(portfolio, edits, author = 'user', now = new Date()) {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = structuredClone(portfolio);
  for (const [id, fields] of Object.entries(edits)) {
    const h = next.holdings.find((x) => x.id === id);
    if (!h) continue;
    for (const [field, value] of Object.entries(fields)) {
      const old = getPath(h, field) ?? null;
      if (JSON.stringify(old) === JSON.stringify(value ?? null)) continue; // objects (metal, manual_price) compared by value
      next.changelog.push({ date, file: 'portfolio', target: id, field, old, new: value, author });
      setPath(h, field, value);
      h.updated_at = date;
    }
    if (h.metrics && Object.keys(h.metrics).every((k) => k === 'as_of' || k === 'source')) delete h.metrics; // no metric left
  }
  next.revision = portfolio.revision + 1;
  next.updated_at = date;
  return next;
}

const stamp = (now) => now.toISOString().replace(/\.\d{3}Z$/, 'Z');
const bump = (next, prev, date) => { next.revision = prev.revision + 1; next.updated_at = date; return next; };

/** Add a holding (id must be unique). Returns a NEW portfolio. */
export function addHolding(portfolio, holding, author = 'user', now = new Date()) {
  const date = stamp(now);
  const next = structuredClone(portfolio);
  if (next.holdings.some((h) => h.id === holding.id)) throw new Error(`id déjà utilisé : ${holding.id}`);
  next.holdings.push({ ...holding, updated_at: date });
  next.changelog.push({ date, file: 'portfolio', target: holding.id, field: 'holding', old: null, new: 'ajout', author });
  return bump(next, portfolio, date);
}

/** Remove a holding; the full line is kept in the changelog (`old`). Returns a NEW portfolio. */
export function removeHolding(portfolio, id, author = 'user', now = new Date()) {
  const date = stamp(now);
  const next = structuredClone(portfolio);
  const h = next.holdings.find((x) => x.id === id);
  if (!h) return portfolio;
  next.holdings = next.holdings.filter((x) => x.id !== id);
  next.changelog.push({ date, file: 'portfolio', target: id, field: 'holding', old: h, new: 'suppression', author });
  return bump(next, portfolio, date);
}

/**
 * Remove the sample lines shipped in the repo (ids of `sample.holdings`) and sample account facts,
 * mark the file as real data. One changelog entry listing what was removed. Returns a NEW portfolio.
 */
export function removeSampleData(portfolio, sample, author = 'user', now = new Date()) {
  const date = stamp(now);
  const ids = new Set(sample.holdings.map((h) => h.id));
  const next = structuredClone(portfolio);
  const removed = next.holdings.filter((h) => ids.has(h.id)).map((h) => h.id);
  next.holdings = next.holdings.filter((h) => !ids.has(h.id));
  const hadAccounts = Boolean(next.accounts);
  delete next.accounts; // legacy (PEA ceiling widget removed)
  next.sample_data = false;
  next.changelog.push({ date, file: 'portfolio', target: 'sample', field: 'holdings', old: removed, new: null, author,
    note: `données d'exemple retirées (${removed.length} lignes${hadAccounts ? ', ancien bloc accounts' : ''})` });
  return bump(next, portfolio, date);
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
