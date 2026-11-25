// Cloudflare Worker: tiny read-only proxy to Yahoo Finance quotes for Wealth Board.
// Why: Yahoo sends no CORS headers, so a static page (GitHub Pages) cannot call it directly.
// Deploy: Cloudflare dashboard > Workers & Pages > Create > "Hello World" worker > paste this file > Deploy.
// Optional variable ALLOWED_ORIGINS (comma list) overrides the default below.
//
// GET /search?isins=FR0000121014,...  ->  { results: { ISIN: [{symbol, exchange, exchange_name, type, name}] }, errors }
// GET /metrics?symbols=AI.PA,...       ->  { results: { SYM: { metrics: {per, pcf, net_debt_ebitda}, notes } }, errors, as_of }
// GET /quotes?symbols=TTE.PA,VOLV-B.ST  ->  { quotes: { SYM: {value, currency, prev_close, close_1w, close_1m, as_of, source} },
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

// Mirrors closesFrom() in src/providers/yahoo-proxy.js.
function closesFrom(r, m) {
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

function parseChart(body) {
  const r = body?.chart?.result?.[0];
  if (!r) throw new Error(body?.chart?.error?.description ?? 'symbole inconnu');
  const m = r.meta;
  if (typeof m.regularMarketPrice !== 'number') throw new Error('cours absent');
  const [currency, factor] = MINOR[m.currency] ?? [m.currency, 1];
  const c = closesFrom(r, m);
  const prev = c.prev ?? (m.range && m.range !== '1d' ? m.previousClose : m.chartPreviousClose ?? m.previousClose);
  const per = (v) => (typeof v === 'number' ? v / factor : undefined);
  return {
    value: m.regularMarketPrice / factor,
    currency,
    prev_close: per(prev),
    close_1w: per(c.w),
    close_1m: per(c.mo),
    as_of: new Date(m.regularMarketTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'Yahoo (proxy)',
  };
}

/**
 * Yahoo quoteSummary (summaryDetail, financialData, defaultKeyStatistics) -> the user's 3 ratios.
 *   per             = trailingPE; if Yahoo omits it and trailing EPS < 0: price / EPS (negative = loss-making)
 *   pcf             = market cap / operating cash flow (only when price and accounts share a currency)
 *   net_debt_ebitda = (total debt - total cash) / EBITDA (only when EBITDA > 0)
 * Unavailable -> omitted (n/d), with the reason in `notes`. Never estimated.
 */
function parseSummary(body) {
  const r = body?.quoteSummary?.result?.[0];
  if (!r) throw new Error(body?.quoteSummary?.error?.description ?? 'symbole inconnu');
  const v = (m, k) => { const x = r[m]?.[k]; return typeof x?.raw === 'number' ? x.raw : null; };
  const priceCcy = r.summaryDetail?.currency ?? null;
  const finCcy = r.financialData?.financialCurrency ?? null;
  const sameCcy = priceCcy && finCcy && priceCcy === finCcy;
  const out = {}, notes = [];
  const pe = v('summaryDetail', 'trailingPE'), eps = v('defaultKeyStatistics', 'trailingEps'), price = v('financialData', 'currentPrice');
  if (pe !== null) out.per = round(pe);
  else if (eps !== null && eps < 0 && price !== null && sameCcy) { out.per = round(price / eps); notes.push('PER calculé : bénéfice par action négatif'); }
  else notes.push('PER n/d');
  const mcap = v('summaryDetail', 'marketCap'), ocf = v('financialData', 'operatingCashflow');
  if (!sameCcy) notes.push(`P/CF n/d : cours en ${priceCcy ?? '?'}, comptes en ${finCcy ?? '?'}`);
  else if (mcap !== null && ocf !== null && ocf !== 0) out.pcf = round(mcap / ocf);
  else notes.push('P/CF n/d');
  const debt = v('financialData', 'totalDebt'), cash = v('financialData', 'totalCash'), ebitda = v('financialData', 'ebitda');
  if (ebitda !== null && ebitda <= 0) notes.push('DN/EBITDA n/d : EBITDA négatif');
  else if (debt !== null && cash !== null && ebitda) out.net_debt_ebitda = round((debt - cash) / ebitda);
  else notes.push('DN/EBITDA n/d');
  return { metrics: out, notes: notes.join(' · '), currency: priceCcy, financial_currency: finCcy };
}
const round = (x) => Math.round(x * 100) / 100;

// Yahoo needs a cookie + "crumb" for quoteSummary. Kept per worker instance, renewed on failure.
let yahooSession = null;
async function getSession(upstream, fresh = false) {
  if (yahooSession && !fresh && Date.now() - yahooSession.t < 3600e3) return yahooSession;
  const r1 = await upstream('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' });
  const raw = (typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') ?? '']).join(', ');
  const cookie = (raw.match(/A3=[^;]+/) ?? [''])[0];
  if (!cookie) throw new Error('Yahoo : cookie de session indisponible');
  const r2 = await upstream('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('Yahoo : jeton (crumb) indisponible');
  yahooSession = { cookie, crumb, t: Date.now() };
  return yahooSession;
}

async function metrics(url, origin, upstream) {
  const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) return json({ error: 'paramètre symbols vide' }, 400, origin);
  if (symbols.length > MAX_SYMBOLS) return json({ error: `maximum ${MAX_SYMBOLS} symboles` }, 400, origin);
  const bad = symbols.filter((s) => !SYMBOL_RE.test(s));
  if (bad.length) return json({ error: `symbole invalide : ${bad.join(', ')}` }, 400, origin);
  const results = {}, errors = {};
  const one = async (s, session) => {
    const res = await upstream(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=summaryDetail,financialData,defaultKeyStatistics&crumb=${encodeURIComponent(session.crumb)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Cookie: session.cookie }, cf: { cacheTtl: 21600, cacheEverything: true },
    });
    if (res.status === 401) throw Object.assign(new Error('session'), { retry: true });
    return parseSummary(await res.json());
  };
  let session;
  try { session = await getSession(upstream); } catch (e) { return json({ error: String(e.message) }, 502, origin); }
  for (const s of symbols) { // sequential: gentle with Yahoo
    try {
      try { results[s] = await one(s, session); } catch (e) { if (!e.retry) throw e; session = await getSession(upstream, true); results[s] = await one(s, session); }
    } catch (e) { errors[s] = String(e.message || e).slice(0, 160); }
  }
  return json({ results, errors, as_of: new Date().toISOString().slice(0, 10) }, 200, origin);
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
  if (url.pathname === '/metrics') return metrics(url, origin, upstream);
  if (url.pathname !== '/quotes') return json({ error: 'route inconnue (/quotes, /search, /metrics)' }, 404, origin);
  const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) return json({ error: 'paramètre symbols vide' }, 400, origin);
  if (symbols.length > MAX_SYMBOLS) return json({ error: `maximum ${MAX_SYMBOLS} symboles` }, 400, origin);
  const bad = symbols.filter((s) => !SYMBOL_RE.test(s));
  if (bad.length) return json({ error: `symbole invalide : ${bad.join(', ')}` }, 400, origin);

  const quotes = {}, errors = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const res = await upstream(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1mo&interval=1d`, {
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
export default { fetch: (request, env) => handle(request, env), handle, parseChart, parseSearch, parseSummary, _resetSession: () => { yahooSession = null; } };
