// Equity/ETF quotes from Yahoo Finance through YOUR OWN proxy (tools/yahoo-proxy-worker.js on
// Cloudflare Workers, free tier). Yahoo blocks browsers (no CORS), so the page cannot call it directly.
// Covers Euronext (TTE.PA), Nordics (VOLV-B.ST, EQNR.OL, NOVO-B.CO), Swiss (NESN.SW), London (VOD.L)...
// Proxy URL lives in localStorage settings ("yahoo_proxy_url"), not in the public repo.
import { getJson, ProviderError, normalizeCurrency, isoFromUnix } from './common.js';

/** Parse one Yahoo v8 chart response (range=1d) -> Price. Used by the worker and the tests. */
export function parseChart(body) {
  const r = body?.chart?.result?.[0];
  if (!r) throw new ProviderError(body?.chart?.error?.description ?? 'symbole inconnu');
  const m = r.meta;
  if (typeof m.regularMarketPrice !== 'number') throw new ProviderError('cours absent');
  const n = normalizeCurrency(m.regularMarketPrice, m.currency);
  // chartPreviousClose (range=1d) = close before the current session: the base for "today's change".
  const prev = m.chartPreviousClose ?? m.previousClose;
  return {
    value: n.value, currency: n.currency,
    prev_close: typeof prev === 'number' ? prev / n.factor : undefined,
    as_of: isoFromUnix(m.regularMarketTime),
    source: 'Yahoo (proxy)',
  };
}

/** Parse the proxy response: { quotes: { SYM: Price }, errors: { SYM: msg } }. */
export function parseProxy(body, symbols) {
  if (!body || typeof body !== 'object' || !body.quotes) throw new ProviderError(body?.error ?? 'réponse du proxy inattendue');
  const results = {}, errors = {};
  for (const s of symbols) {
    if (body.quotes[s]) results[s] = body.quotes[s];
    else errors[s] = body.errors?.[s] ?? 'absent de la réponse';
  }
  return { results, errors };
}

export default {
  id: 'yahoo_proxy',
  kind: 'quote',
  label: 'Yahoo (via votre proxy)',
  needs: ['yahoo_proxy_url'],
  batch: 20,
  minIntervalMs: 0,
  async fetch(symbols, ctx) {
    const base = ctx.settings.yahoo_proxy_url?.replace(/\/+$/, '');
    if (!base) throw new ProviderError('URL du proxy absente');
    const { body, status } = await getJson(ctx, `${base}/quotes?symbols=${symbols.map(encodeURIComponent).join(',')}`, { timeoutMs: 15000 });
    if (status === 403) throw new ProviderError('proxy : origine refusée (vérifier ALLOWED_ORIGINS)');
    return parseProxy(body, symbols);
  },
};
