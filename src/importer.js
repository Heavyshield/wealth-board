// Position import (e.g. Boursorama "Exporter en CSV"): map columns via config.imports.<profile>,
// compare with the holdings of ONE envelope, produce a diff, apply only what the user ticks.
// Pure functions, no DOM.
//
// Profile (config.imports.<id>):
//   { label, envelope_default, columns: { field: [header aliases...] }, required: [fields],
//     update_fields: ["quantity", "unit_cost"], asset_class_default, etf_name_pattern }
// Fields understood: isin, name, quantity, unit_cost, last_price, currency, ticker.

import { parseCsv, normHeader, parseLooseNumber } from './csv.js';

/** Map file headers to fields using the profile aliases. Returns { map: {field: header}, missing: [field] }. */
export function mapColumns(headers, profile) {
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  const map = {};
  for (const [field, aliases] of Object.entries(profile.columns)) {
    const hit = aliases.map(normHeader).find((a) => byNorm.has(a));
    if (hit) map[field] = byNorm.get(hit);
  }
  const missing = (profile.required ?? []).filter((f) => !map[f]);
  return { map, missing };
}

const NUMERIC = new Set(['quantity', 'unit_cost', 'last_price']);

/**
 * Read a CSV into normalised positions. Returns
 * { positions: [{isin, name, quantity, unit_cost, last_price, currency, line}], map, missing, problems, separator, headers }.
 * Rows without ISIN and name (totals, footers) are ignored; unreadable numbers are reported, never guessed.
 */
export function readPositions(text, profile) {
  const { headers, rows, separator, skipped } = parseCsv(text);
  const { map, missing } = mapColumns(headers, profile);
  const problems = skipped.map((s) => `ligne ${s.line} ignorée (colonnes manquantes) : ${s.text}`);
  if (missing.length) return { positions: [], map, missing, problems, separator, headers };
  const positions = [];
  rows.forEach((row, i) => {
    const p = { line: i + 2 };
    for (const [field, header] of Object.entries(map)) {
      const raw = row[header];
      if (NUMERIC.has(field)) {
        if (raw === '' || raw === undefined) continue;
        const n = parseLooseNumber(raw);
        if (Number.isNaN(n)) { problems.push(`ligne ${p.line} : « ${raw} » n'est pas un nombre (${field})`); continue; }
        p[field] = n;
      } else if (raw) p[field] = field === 'isin' ? raw.toUpperCase().replace(/\s/g, '') : raw;
    }
    if (!p.isin && !p.name) return; // total / footer line
    if (p.quantity === undefined) { problems.push(`ligne ${p.line} (${p.name ?? p.isin}) : quantité absente, ligne ignorée`); return; }
    positions.push(p);
  });
  return { positions, map, missing, problems, separator, headers };
}

const normName = (s) => normHeader(s ?? '');
const close = (a, b, tol) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;

/** Stable kebab id from envelope + name, unique within the portfolio. */
export function makeId(envelope, name, taken) {
  const base = `${envelope}-${normName(name).replace(/ /g, '-')}`.replace(/-+/g, '-').slice(0, 60).replace(/-$/, '') || `${envelope}-ligne`;
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/**
 * Diff file positions against holdings of `envelope` (quote-priced classes only; cash and metals untouched).
 * Returns { added: [{pos, holding}], changed: [{holding, pos, fields: [{field, old, new}]}], removed: [{holding}], unchanged: n }.
 */
export function diffPositions(positions, portfolio, config, envelope, profile) {
  const pricing = Object.fromEntries(config.asset_classes.map((c) => [c.id, c.pricing]));
  const mine = portfolio.holdings.filter((h) => h.envelope === envelope && pricing[h.asset_class] === 'quote');
  const byIsin = new Map(mine.filter((h) => h.isin).map((h) => [h.isin, h]));
  const byName = new Map(mine.map((h) => [normName(h.name), h]));
  const used = new Set();
  const fields = profile.update_fields ?? ['quantity', 'unit_cost'];
  const added = [], changed = [];
  let unchanged = 0;
  const taken = new Set(portfolio.holdings.map((h) => h.id));
  const envCurrency = config.envelopes.find((e) => e.id === envelope)?.currency ?? config.base_currency;
  const etfRe = profile.etf_name_pattern ? new RegExp(profile.etf_name_pattern, 'i') : null;

  for (const pos of positions) {
    const h = (pos.isin && byIsin.get(pos.isin)) || byName.get(normName(pos.name));
    if (!h || used.has(h.id)) {
      const cls = etfRe?.test(pos.name ?? '') ? 'etf' : profile.asset_class_default ?? 'equity';
      added.push({ pos, holding: {
        id: makeId(envelope, pos.name ?? pos.isin, taken),
        name: pos.name ?? pos.isin, envelope, asset_class: cls,
        ...(pos.ticker ? { ticker: pos.ticker } : {}), ...(pos.isin ? { isin: pos.isin } : {}),
        quantity: pos.quantity, unit_cost: pos.unit_cost ?? 0, currency: pos.currency ?? envCurrency,
        price_source: 'quote', tags: [], notes: '', updated_at: '',
      } });
      continue;
    }
    used.add(h.id);
    const diffs = [];
    for (const f of fields) {
      if (pos[f] === undefined) continue;
      const tol = f === 'quantity' ? 1e-9 : 0.005; // costs compared to the half-cent
      if (!close(h[f], pos[f], tol)) diffs.push({ field: f, old: h[f], new: pos[f] });
    }
    if (diffs.length) changed.push({ holding: h, pos, fields: diffs });
    else unchanged++;
  }
  const removed = mine.filter((h) => !used.has(h.id)).map((h) => ({ holding: h }));
  return { added, changed, removed, unchanged };
}

/**
 * Lines of this import that could get a ticker from their ISIN: new lines without one, plus existing
 * quote-priced lines of the envelope still without ticker (manual prices excluded). Returns [{ id, name, isin, isNew }].
 */
export function tickerCandidates(diff, portfolio, config, envelope) {
  const pricing = Object.fromEntries(config.asset_classes.map((c) => [c.id, c.pricing]));
  const removed = new Set(diff.removed.map((r) => r.holding.id));
  const fresh = diff.added.filter((a) => !a.holding.ticker && a.holding.isin)
    .map((a) => ({ id: a.holding.id, name: a.holding.name, isin: a.holding.isin, isNew: true }));
  const existing = portfolio.holdings
    .filter((h) => h.envelope === envelope && pricing[h.asset_class] === 'quote' && !removed.has(h.id)
      && !h.ticker && h.isin && !h.manual_price && h.price_source !== 'manual')
    .map((h) => ({ id: h.id, name: h.name, isin: h.isin, isNew: false }));
  return [...fresh, ...existing];
}

/**
 * Apply the selected parts of a diff. `pick` = { added: Set(ids), changed: Set(ids), removed: Set(ids) }.
 * `tickers` = { holdingId: symbol } found from the ISIN (optional; a new line gets it only if it is added).
 * `price` = { as_of, source } to store file prices as last_price when newer (optional).
 * Returns a NEW portfolio (revision+1) with one changelog entry per change (author user, note = import label).
 */
export function applyImport(portfolio, diff, pick, { label, now = new Date(), price, tickers = {} } = {}) {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = structuredClone(portfolio);
  const log = (target, field, old, nw) => next.changelog.push({ date, file: 'portfolio', target, field, old: old ?? null, new: nw ?? null, author: 'user', note: label });
  const withPrice = (h, pos) => {
    if (!price || pos.last_price === undefined || !(pos.last_price > 0)) return;
    if (h.last_price && new Date(h.last_price.as_of) >= new Date(price.as_of)) return; // newest wins
    h.last_price = { value: pos.last_price, currency: pos.currency ?? h.currency, as_of: price.as_of, source: price.source };
  };
  const asOf = (price?.as_of ?? date).slice(0, 10); // amounts are true as of the export date
  for (const a of diff.added) {
    if (!pick.added.has(a.holding.id)) continue;
    const h = { ...structuredClone(a.holding), as_of: asOf, updated_at: date };
    withPrice(h, a.pos);
    next.holdings.push(h);
    log(h.id, 'holding', null, 'ajout');
  }
  for (const c of diff.changed) {
    if (!pick.changed.has(c.holding.id)) continue;
    const h = next.holdings.find((x) => x.id === c.holding.id);
    for (const f of c.fields) { log(h.id, f.field, f.old, f.new); h[f.field] = f.new; }
    h.as_of = asOf;
    withPrice(h, c.pos);
    h.updated_at = date;
  }
  for (const r of diff.removed) {
    if (!pick.removed.has(r.holding.id)) continue;
    next.holdings = next.holdings.filter((x) => x.id !== r.holding.id);
    log(r.holding.id, 'holding', r.holding, 'suppression'); // full old line kept in the changelog
  }
  for (const [id, symbol] of Object.entries(tickers)) {
    const h = next.holdings.find((x) => x.id === id);
    if (!h || !symbol || h.ticker === symbol) continue; // new line not ticked, or removed
    log(id, 'ticker', h.ticker, symbol);
    h.ticker = symbol;
    h.updated_at = date;
  }
  next.revision = portfolio.revision + 1;
  next.updated_at = date;
  return next;
}
