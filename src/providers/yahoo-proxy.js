// Equity/ETF quotes from Yahoo Finance through YOUR OWN proxy (tools/yahoo-proxy-worker.js on
// Cloudflare Workers, free tier). Yahoo blocks browsers (no CORS), so the page cannot call it directly.
// Covers Euronext (TTE.PA), Nordics (VOLV-B.ST, EQNR.OL, NOVO-B.CO), Swiss (NESN.SW), London (VOD.L)...
// Proxy URL lives in localStorage settings ("yahoo_proxy_url"), not in the public repo.
import { getJson, ProviderError, normalizeCurrency, isoFromUnix } from './common.js';

/**
 * Daily closes of a chart response (worker asks range=1mo&interval=1d): close of the previous session,
 * ~1 week ago and ~1 month ago (last close on or before that day; undefined when the range does not reach it).
 * Days are counted in the exchange's local time (gmtoffset). Mirrored in the worker.
 */
export function closesFrom(r, m) {
  const ts = r.timestamp ?? [], cl = r.indicators?.quote?.[0]?.close ?? [];
  const off = m.gmtoffset ?? 0;
  const day = (t) => Math.floor((t + off) / 86400);
  const today = day(m.regularMarketTime);
  const bars = ts.map((t, i) => [day(t), cl[i]]).filter(([, c]) => typeof c === 'number');
  const onOrBefore = (d) => { let v; for (const [bd, c] of bars) if (bd <= d) v = c; return v; };
  const first = bars[0];
  return {
    prev: onOrBefore(today - 1),
    w: onOrBefore(today - 7),
    mo: onOrBefore(today - 30) ?? (first && first[0] <= today - 25 ? first[1] : undefined),
  };
}

/** Parse one Yahoo v8 chart response -> Price (+ close_1w / close_1m when the range covers them). Used by the worker and the tests. */
export function parseChart(body) {
  const r = body?.chart?.result?.[0];
  if (!r) throw new ProviderError(body?.chart?.error?.description ?? 'symbole inconnu');
  const m = r.meta;
  if (typeof m.regularMarketPrice !== 'number') throw new ProviderError('cours absent');
  const n = normalizeCurrency(m.regularMarketPrice, m.currency);
  const c = closesFrom(r, m);
  // range=1d: chartPreviousClose = close before the current session. Longer ranges: it is the close before the
  // range, so the previous session comes from the daily bars instead.
  const prev = c.prev ?? (m.range && m.range !== '1d' ? m.previousClose : m.chartPreviousClose ?? m.previousClose);
  const per = (v) => (typeof v === 'number' ? v / n.factor : undefined);
  return {
    value: n.value, currency: n.currency,
    prev_close: per(prev),
    close_1w: per(c.w),
    close_1m: per(c.mo),
    as_of: isoFromUnix(m.regularMarketTime),
    source: 'Yahoo (proxy)',
  };
}

/** Parse a Yahoo search response -> [{ symbol, exchange, exchange_name, type, name }]. Mirrors the worker. */
export function parseSearch(body) {
  return (body?.quotes ?? [])
    .filter((q) => q.symbol && q.isYahooFinance !== false)
    .map((q) => ({ symbol: q.symbol, exchange: q.exchange ?? '', exchange_name: q.exchDisp ?? q.exchange ?? '', type: q.quoteType ?? '', name: q.longname ?? q.shortname ?? '' }));
}

/**
 * Pick the best listing: first by config preferred exchanges order, then Yahoo's own order.
 * Returns { pick, candidates } (pick may be undefined).
 */
export function bestListing(candidates, preferred = []) {
  const rank = (c) => { const i = preferred.indexOf(c.exchange); return i < 0 ? preferred.length : i; };
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  return { pick: sorted[0], candidates: sorted };
}

/** Yahoo quoteType -> suggested asset class id (only if that class exists in config). */
export const TYPE_TO_CLASS = { EQUITY: 'equity', ETF: 'etf', MUTUALFUND: 'fund' };

/** Ask the proxy for listings of up to 20 ISINs per request. Returns { results: {ISIN: [..]}, errors }. */
export async function searchIsins(isins, ctx) {
  const base = ctx.settings.yahoo_proxy_url?.replace(/\/+$/, '');
  if (!base) throw new ProviderError('URL du proxy absente (Réglages)');
  const results = {}, errors = {};
  for (let i = 0; i < isins.length; i += 20) {
    const chunk = isins.slice(i, i + 20);
    const { body, status } = await getJson(ctx, `${base}/search?isins=${chunk.join(',')}`, { timeoutMs: 20000 });
    if (status === 404) throw new ProviderError('le proxy ne connaît pas /search : recopiez la dernière version de tools/yahoo-proxy-worker.js dans Cloudflare');
    if (status === 403) throw new ProviderError('proxy : origine refusée');
    if (!body?.results) throw new ProviderError(body?.error ?? 'réponse du proxy inattendue');
    Object.assign(results, body.results); Object.assign(errors, body.errors ?? {});
  }
  return { results, errors };
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
