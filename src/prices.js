// Price orchestration: which prices are needed, cache (localStorage, TTL per kind),
// per-kind fallback chain from config.providers, batching + pauses for rate limits,
// and merging live prices over the file's market_snapshot / last_price (newest wins).
// Manual prices (holding.manual_price) are never fetched and always win in valuation.

import frankfurter from './providers/frankfurter.js';
import ecb from './providers/ecb.js';
import goldapi from './providers/goldapi.js';
import twelvedata from './providers/twelvedata.js';
import yahooProxy from './providers/yahoo-proxy.js';

export const PROVIDERS = Object.fromEntries([frankfurter, ecb, goldapi, twelvedata, yahooProxy].map((p) => [p.id, p]));

const SETTINGS_KEY = 'wb.settings.prices';
const CACHE_KEY = 'wb.cache.prices';

// ---------------------------------------------------------------- settings (keys stay in this browser)
export function loadSettings(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}
export function saveSettings(s, storage = globalThis.localStorage) { storage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// ---------------------------------------------------------------- cache
export function loadCache(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(CACHE_KEY)) ?? { fx: {}, spot: {}, quote: {} }; } catch { return { fx: {}, spot: {}, quote: {} }; }
}
export function saveCache(cache, storage = globalThis.localStorage) { storage.setItem(CACHE_KEY, JSON.stringify(cache)); }
export function clearCache(storage = globalThis.localStorage) { storage.removeItem(CACHE_KEY); }

const fresh = (entry, ttlMin, now) => entry && (now - new Date(entry.fetched_at)) / 6e4 < ttlMin;

// ---------------------------------------------------------------- what is needed
/** Holdings that get a market quote, with the provider chain and symbol per provider. */
export function quoteTargets(portfolio, config) {
  const pricing = Object.fromEntries(config.asset_classes.map((c) => [c.id, c.pricing]));
  const chainAll = config.providers?.quote ?? [];
  return portfolio.holdings
    .filter((h) => pricing[h.asset_class] === 'quote' && !h.manual_price && h.price_source !== 'manual' && (h.ticker || h.symbols))
    .map((h) => {
      const forced = h.price_source?.startsWith('quote:') ? [h.price_source.slice(6)] : null;
      const chain = forced ?? chainAll;
      return { id: h.id, chain, symbol: (p) => h.symbols?.[p] ?? h.ticker };
    });
}

export function fxNeeded(portfolio, config) {
  const base = config.base_currency;
  return [...new Set(portfolio.holdings.map((h) => h.currency).concat(Object.values(portfolio.market_snapshot?.spot ?? {}).map((s) => s.currency)))]
    .filter((c) => c && c !== base).sort();
}

export function spotNeeded(portfolio) {
  return [...new Set(portfolio.holdings.filter((h) => h.metal).map((h) => h.metal.code))].sort();
}

// ---------------------------------------------------------------- refresh
/**
 * Refresh prices. Returns { live: { fx, spot, quotes }, report }.
 * report: [{ provider, kind, ok, errors: {item: msg}, skipped? }] -- shown to the user, never hidden.
 * ctx: { fetch, sleep, storage, now, force, settings, onProgress } (all optional, injectable for tests).
 */
export async function refreshPrices(portfolio, config, ctx = {}) {
  const now = ctx.now ?? new Date();
  const storage = ctx.storage ?? globalThis.localStorage;
  const settings = ctx.settings ?? loadSettings(storage);
  const ttl = { quote: 15, spot: 15, fx: 360, ...(config.providers?.ttl_minutes ?? {}) };
  const cache = loadCache(storage);
  const pctx = { fetch: ctx.fetch, settings, base: config.base_currency, signal: ctx.signal };
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const report = [];
  const stamp = new Date(now).toISOString();

  async function runChain(kind, items, chain, keyOf = (p, i) => i) {
    let remaining = ctx.force ? items : items.filter((i) => !chain.some((p) => fresh(cache[kind][keyOf(p, i)], ttl[kind], now)));
    for (const pid of chain) {
      if (!remaining.length) break;
      const p = PROVIDERS[pid];
      if (!p) { report.push({ provider: pid, kind, ok: 0, errors: { '*': 'fournisseur inconnu (config.providers)' } }); continue; }
      const missing = (p.needs ?? []).filter((k) => !settings[k]);
      if (missing.length) { report.push({ provider: pid, kind, ok: 0, skipped: `non configuré (${missing.join(', ')})`, errors: {} }); continue; }
      const entry = { provider: pid, kind, ok: 0, errors: {} };
      report.push(entry);
      const symbols = [...new Set(remaining.map((i) => keyOf(pid, i).split(':').slice(1).join(':') || i))];
      const batch = p.batch ?? symbols.length;
      const got = new Set();
      for (let start = 0; start < symbols.length; start += batch) {
        if (start > 0 && p.minIntervalMs) { ctx.onProgress?.(`${p.label} : pause pour respecter la limite de requêtes…`); await sleep(p.minIntervalMs); }
        const chunk = symbols.slice(start, start + batch);
        ctx.onProgress?.(`${p.label} : ${chunk.length} élément(s)…`);
        try {
          const { results, errors } = await p.fetch(chunk, pctx);
          for (const [sym, price] of Object.entries(results)) {
            cache[kind][kind === 'quote' ? `${pid}:${sym}` : sym] = { ...price, provider: pid, fetched_at: stamp };
            got.add(sym); entry.ok++;
          }
          Object.assign(entry.errors, errors);
        } catch (e) {
          for (const s of chunk) entry.errors[s] = e.message;
        }
      }
      remaining = remaining.filter((i) => !got.has(kind === 'quote' ? keyOf(pid, i).split(':').slice(1).join(':') : i));
    }
  }

  await runChain('fx', fxNeeded(portfolio, config), config.providers?.fx ?? ['frankfurter', 'ecb']);
  await runChain('spot', spotNeeded(portfolio), config.providers?.spot ?? ['goldapi']);
  // Quotes: group holdings by chain so each provider sees only its own symbols.
  const targets = quoteTargets(portfolio, config);
  const chains = new Map();
  for (const t of targets) {
    const k = t.chain.join('>');
    if (!chains.has(k)) chains.set(k, []);
    chains.get(k).push(t);
  }
  for (const group of chains.values()) {
    const byId = Object.fromEntries(group.map((t) => [t.id, t]));
    await runChain('quote', group.map((t) => t.id), group[0].chain, (pid, id) => `${pid}:${byId[id].symbol(pid)}`);
  }
  saveCache(cache, storage);
  return { live: liveFromCache(portfolio, config, cache), report, refreshed_at: stamp };
}

/** Build { fx, spot, quotes(by holding id) } from the cache (first provider of each chain that has data). */
export function liveFromCache(portfolio, config, cache = loadCache()) {
  const fx = {}, spot = {}, quotes = {};
  for (const c of fxNeeded(portfolio, config)) if (cache.fx[c]) fx[c] = cache.fx[c];
  for (const m of spotNeeded(portfolio)) if (cache.spot[m]) spot[m] = cache.spot[m];
  for (const t of quoteTargets(portfolio, config)) {
    for (const pid of t.chain) {
      const q = cache.quote[`${pid}:${t.symbol(pid)}`];
      if (q) { quotes[t.id] = q; break; }
    }
  }
  return { fx, spot, quotes };
}

// ---------------------------------------------------------------- merge for valuation
const newer = (a, b) => !b || (a && new Date(a) > new Date(b));

/**
 * Overlay live prices on the portfolio for valuation (in memory only).
 * Newest wins: a live price never replaces a more recent price written in the file (e.g. by Claude).
 * Returns { portfolio, quotes } ready for valueHoldings({ portfolio, quotes }).
 */
export function mergeLive(portfolio, config, live) {
  const p = structuredClone(portfolio);
  const base = config.base_currency;
  p.market_snapshot ??= {};
  const fxFile = p.market_snapshot.fx?.base === base ? p.market_snapshot.fx : { base, as_of: '1970-01-01T00:00:00Z', rates: {} };
  const liveFx = Object.entries(live.fx ?? {});
  if (liveFx.length && newer(liveFx[0][1].as_of, fxFile.as_of)) {
    // One as_of for the block: the oldest live rate used (conservative).
    const rates = { ...fxFile.rates };
    for (const [c, r] of liveFx) rates[c] = r.value;
    const asOf = liveFx.map(([, r]) => r.as_of).sort()[0];
    p.market_snapshot.fx = { base, as_of: asOf, source: liveFx[0][1].source, rates };
  }
  p.market_snapshot.spot ??= {};
  for (const [code, s] of Object.entries(live.spot ?? {})) {
    const cur = p.market_snapshot.spot[code];
    if (!cur || newer(s.as_of, cur.as_of)) p.market_snapshot.spot[code] = { value: s.value, currency: s.currency, per: s.per ?? 'oz', as_of: s.as_of, source: s.source, ...(s.prev_close ? { prev_close: s.prev_close } : {}) };
  }
  const quotes = {};
  for (const h of p.holdings) {
    const q = live.quotes?.[h.id];
    if (q && newer(q.as_of, h.last_price?.as_of)) quotes[h.id] = q;
  }
  return { portfolio: p, quotes };
}

/**
 * Write the prices in use into the portfolio file (last_price + market_snapshot), so Claude and
 * offline/phone sessions see them. Returns a NEW portfolio (revision+1) with one changelog entry.
 */
export function persistPrices(portfolio, merged, author = 'user', now = new Date()) {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = structuredClone(portfolio);
  next.market_snapshot = merged.portfolio.market_snapshot;
  let n = 0;
  for (const h of next.holdings) {
    const q = merged.quotes[h.id];
    if (!q) continue;
    h.last_price = { value: q.value, currency: q.currency, as_of: q.as_of, source: q.source, ...(q.prev_close ? { prev_close: q.prev_close } : {}) };
    n++;
  }
  next.changelog.push({ date, file: 'portfolio', target: 'market', field: 'prices', old: null, new: n, author, note: `${n} cours + change + métaux mémorisés` });
  next.revision = portfolio.revision + 1;
  next.updated_at = date;
  return next;
}
