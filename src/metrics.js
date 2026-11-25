// Ratios from Yahoo through the user's proxy (/metrics): PER, P/CF, net debt / EBITDA.
// Only lines a rule applies to and that have a ticker. Ratios typed by the user (metrics.source not "Yahoo")
// are never overwritten. Missing ratios stay absent (n/d) with Yahoo's reason in metrics.notes.

import { getJson, ProviderError } from './providers/common.js';
import { inScope } from './rules.js';
import { applyEdits } from './data.js';

export const SOURCE = 'Yahoo';

/** Lines to fetch: rule applies + ticker present. Returns [{ id, symbol, manual }]. */
export function metricTargets(portfolio, config) {
  const rules = config.rules?.items ?? [];
  return portfolio.holdings
    .filter((h) => h.ticker && rules.some((r) => inScope(h, r.applies_to)))
    .map((h) => ({ id: h.id, symbol: h.symbols?.yahoo_proxy ?? h.ticker, manual: Boolean(h.metrics && h.metrics.source !== SOURCE) }));
}

/** Call the proxy, 20 symbols per request. Returns { results: { symbol: {metrics, notes} }, errors }. */
export async function fetchMetrics(symbols, ctx) {
  const base = ctx.settings.yahoo_proxy_url?.replace(/\/+$/, '');
  if (!base) throw new ProviderError('URL du proxy absente (Réglages)');
  const results = {}, errors = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    const { body, status } = await getJson(ctx, `${base}/metrics?symbols=${chunk.map(encodeURIComponent).join(',')}`, { timeoutMs: 45000 });
    if (status === 404) throw new ProviderError('le proxy ne connaît pas /metrics : recopiez la dernière version de tools/yahoo-proxy-worker.js dans Cloudflare');
    if (!body?.results) throw new ProviderError(body?.error ?? 'réponse du proxy inattendue');
    Object.assign(results, body.results); Object.assign(errors, body.errors ?? {});
  }
  return { results, errors };
}

/**
 * Write fetched ratios into the portfolio (one logged change per line). Returns { portfolio, updated, kept, empty, failed }.
 * kept = lines with ratios typed by the user (left untouched).
 */
export function applyMetrics(portfolio, targets, fetched, now = new Date()) {
  const asOf = now.toISOString().slice(0, 10);
  const edits = {};
  const out = { updated: [], kept: [], empty: [], failed: [] };
  for (const t of targets) {
    if (t.manual) { out.kept.push(t.id); continue; }
    const r = fetched.results[t.symbol];
    if (!r) { out.failed.push(`${t.symbol} : ${fetched.errors[t.symbol] ?? 'absent'}`); continue; }
    const m = { ...r.metrics, as_of: asOf, source: SOURCE, ...(r.notes ? { notes: r.notes } : {}) };
    if (!Object.keys(r.metrics).length) out.empty.push(t.id);
    edits[t.id] = { metrics: m };
    out.updated.push(t.id);
  }
  return { portfolio: Object.keys(edits).length ? applyEdits(portfolio, edits, 'user', now) : portfolio, ...out };
}
