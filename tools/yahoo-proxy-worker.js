// Cloudflare Worker: tiny read-only proxy to Yahoo Finance quotes for Wealth Board.
// Why: Yahoo sends no CORS headers, so a static page (GitHub Pages) cannot call it directly.
// Deploy: Cloudflare dashboard > Workers & Pages > Create > "Hello World" worker > paste this file > Deploy.
// Optional variable ALLOWED_ORIGINS (comma list) overrides the default below.
//
// GET /search?isins=FR0000121014,...  ->  { results: { ISIN: [{symbol, exchange, exchange_name, type, name}] }, errors }
// GET /quotes?symbols=TTE.PA,VOLV-B.ST  ->  { quotes: { SYM: {value, currency, prev_close, as_of, source} },
//                                            errors: { SYM: message }, fetched_at }
// Self-contained on purpose (no imports) so it can be pasted as-is. Parsing mirrors
// src/providers/yahoo-proxy.js parseChart(); tests/tests.js checks both give the same result.

const DEFAULT_ORIGINS = 'https://heavyshield.github.io,http://localhost:8770,http://127.0.0.1:8770';
const MAX_SYMBOLS = 20;
const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,20}$/;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MINOR = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Vary': 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=60', ...(origin ? cors(origin) : {}) },
  });
}

function parseSearch(body) {
  return (body?.quotes ?? [])
    .filter((q) => q.symbol && q.isYahooFinance !== false)
    .map((q) => ({ symbol: q.symbol, exchange: q.exchange ?? '', exchange_name: q.exchDisp ?? q.exchange ?? '', type: q.quoteType ?? '', name: q.longname ?? q.shortname ?? '' }));
}

function parseChart(body) {
  const r = body?.chart?.result?.[0];
  if (!r) throw new Error(body?.chart?.error?.description ?? 'symbole inconnu');
  const m = r.meta;
  if (typeof m.regularMarketPrice !== 'number') throw new Error('cours absent');
  const [currency, factor] = MINOR[m.currency] ?? [m.currency, 1];
  const prev = m.chartPreviousClose ?? m.previousClose;
  return {
    value: m.regularMarketPrice / factor,
    currency,
    prev_close: typeof prev === 'number' ? prev / factor : undefined,
    as_of: new Date(m.regularMarketTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'Yahoo (proxy)',
  };
}

/** ISIN -> Yahoo listings (Yahoo search). */
async function search(url, origin, upstream) {
  const isins = [...new Set((url.searchParams.get('isins') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!isins.length) return json({ error: 'paramètre isins vide' }, 400, origin);
  if (isins.length > MAX_SYMBOLS) return json({ error: `maximum ${MAX_SYMBOLS} ISIN` }, 400, origin);
  const bad = isins.filter((s) => !ISIN_RE.test(s));
  if (bad.length) return json({ error: `ISIN invalide : ${bad.join(', ')}` }, 400, origin);
  const results = {}, errors = {};
  await Promise.all(isins.map(async (isin) => {
    try {
      const res = await upstream(`https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=6&newsCount=0&listsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      const found = parseSearch(await res.json());
      if (found.length) results[isin] = found; else errors[isin] = 'aucune cotation trouvée';
    } catch (e) {
      errors[isin] = String(e.message || e).slice(0, 160);
    }
  }));
  return json({ results, errors }, 200, origin);
}

/** Request handler; `upstream` is injectable so tests can run it in a browser without Yahoo. */
async function handle(request, env = {}, upstream = fetch) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin');
  if (!origin || !allowed.includes(origin)) return json({ error: 'origine non autorisée' }, 403, null);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'GET') return json({ error: 'GET uniquement' }, 405, origin);

  const url = new URL(request.url);
  if (url.pathname === '/search') return search(url, origin, upstream);
  if (url.pathname !== '/quotes') return json({ error: 'route inconnue (/quotes?symbols=... ou /search?isins=...)' }, 404, origin);
  const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) return json({ error: 'paramètre symbols vide' }, 400, origin);
  if (symbols.length > MAX_SYMBOLS) return json({ error: `maximum ${MAX_SYMBOLS} symboles` }, 400, origin);
  const bad = symbols.filter((s) => !SYMBOL_RE.test(s));
  if (bad.length) return json({ error: `symbole invalide : ${bad.join(', ')}` }, 400, origin);

  const quotes = {}, errors = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const res = await upstream(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      quotes[s] = parseChart(await res.json());
    } catch (e) {
      errors[s] = String(e.message || e).slice(0, 160);
    }
  }));
  return json({ quotes, errors, fetched_at: new Date().toISOString() }, 200, origin);
}

// Single default export (what Cloudflare expects). handle/parseChart are attached for tests only.
export default { fetch: (request, env) => handle(request, env), handle, parseChart, parseSearch };
