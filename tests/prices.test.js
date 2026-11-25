// Stage d tests: provider parsing on REAL captured responses (tests/fixtures, 2026-11-25),
// proxy worker behaviour, fallback chain, cache TTL, rate-limit batching, merge rules.
// Exports a function the main runner calls with its `test` / `assert` / `eq` helpers.

import * as frank from '../src/providers/frankfurter.js';
import * as ecb from '../src/providers/ecb.js';
import * as gold from '../src/providers/goldapi.js';
import * as td from '../src/providers/twelvedata.js';
import * as yp from '../src/providers/yahoo-proxy.js';
import worker from '../tools/yahoo-proxy-worker.js';
import { refreshPrices, mergeLive, persistPrices, liveFromCache } from '../src/prices.js';

const fx = async (name) => (await fetch(`./fixtures/${name}`, { cache: 'no-store' })).json();

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const res = (status, body) => ({ status, ok: status < 400, json: async () => body });

export async function pricesTests({ test, assert, eq, files, schemas, validate, NOW }) {
  const F = {
    frank: await fx('frankfurter.json'), ecb: await fx('ecb.json'), gold: await fx('goldapi-xau-eur.json'),
    tte: await fx('yahoo-chart-tte.json'), vod: await fx('yahoo-chart-vod-gbp.json'), volvo: await fx('yahoo-chart-volvo-sek.json'),
    unknown: await fx('yahoo-chart-unknown.json'), tdBatch: await fx('twelvedata-batch.json'), tdSingle: await fx('twelvedata-single.json'),
  };

  await test('Change : Frankfurter et BCE (deux sources) donnent les mêmes taux', () => {
    const a = frank.parse(F.frank, 'EUR'), b = ecb.parse(F.ecb);
    for (const c of ['CHF', 'USD', 'SEK']) {
      assert(a[c] && b[c], `taux ${c} manquant`);
      if (a[c].as_of === b[c].as_of) eq(a[c].value, b[c].value, `taux ${c} (même date)`);
    }
    assert(/T14:15:00Z$/.test(a.CHF.as_of), 'horodatage BCE');
  });

  await test('Métaux : gold-api en EUR par once', () => {
    const p = gold.parse(F.gold, 'XAU');
    eq(p.currency, 'EUR', 'devise'); eq(p.per, 'oz', 'unité');
    assert(p.value > 1000 && p.value < 10000, `valeur plausible ${p.value}`);
  });

  await test('Yahoo : cours, clôture veille, devise ; GBp converti en GBP', () => {
    const t = yp.parseChart(F.tte);
    eq(t.currency, 'EUR', 'TTE devise'); eq(t.value, F.tte.chart.result[0].meta.regularMarketPrice, 'TTE cours');
    const v = yp.parseChart(F.vod);
    eq(v.currency, 'GBP', 'VOD.L en GBP');
    eq(Math.round(v.value * 1e4), Math.round(F.vod.chart.result[0].meta.regularMarketPrice * 100), 'pence / 100');
    eq(Math.round(v.prev_close * 1e4), Math.round(F.vod.chart.result[0].meta.chartPreviousClose * 100), 'veille / 100');
    eq(yp.parseChart(F.volvo).currency, 'SEK', 'Volvo SEK');
    let msg = '';
    try { yp.parseChart(F.unknown); } catch (e) { msg = e.message; }
    assert(/No data found/.test(msg), `symbole inconnu : ${msg}`);
  });

  await test('Proxy : même résultat que l’adaptateur sur les vraies réponses', () => {
    for (const f of [F.tte, F.vod, F.volvo]) eq(JSON.stringify(worker.parseChart(f)), JSON.stringify(yp.parseChart(f)), f.chart.result[0].meta.symbol);
  });

  await test('Proxy : origine, limites, CORS', async () => {
    const up = async (url) => res(200, url.includes('TTE.PA') ? F.tte : url.includes('VOD.L') ? F.vod : F.unknown);
    // Request-like object: browsers strip a forged Origin header from real Request objects.
    const req = (path, origin, method = 'GET') => ({ url: `https://w.example${path}`, method, headers: new Headers(origin ? { Origin: origin } : {}) });
    const env = { ALLOWED_ORIGINS: 'https://heavyshield.github.io' };
    eq((await worker.handle(req('/quotes?symbols=TTE.PA', 'https://evil.example'), env, up)).status, 403, 'origine refusée');
    eq((await worker.handle(req('/quotes?symbols=TTE.PA', null), env, up)).status, 403, 'sans origine');
    const pre = await worker.handle(req('/quotes', 'https://heavyshield.github.io', 'OPTIONS'), env, up);
    eq(pre.status, 204, 'pré-vol'); eq(pre.headers.get('Access-Control-Allow-Origin'), 'https://heavyshield.github.io', 'ACAO');
    eq((await worker.handle(req(`/quotes?symbols=${Array.from({ length: 21 }, (_, i) => `S${i}`).join(',')}`, 'https://heavyshield.github.io'), env, up)).status, 400, '> 20 symboles');
    eq((await worker.handle(req('/quotes?symbols=TTE.PA,<script>', 'https://heavyshield.github.io'), env, up)).status, 400, 'symbole invalide');
    const ok = await worker.handle(req('/quotes?symbols=TTE.PA,VOD.L,NOPE.PA', 'https://heavyshield.github.io'), env, up);
    const body = await ok.json();
    eq(ok.status, 200, 'statut'); eq(body.quotes['VOD.L'].currency, 'GBP', 'GBP');
    assert(body.errors['NOPE.PA'], 'erreur par symbole');
    const parsed = yp.parseProxy(body, ['TTE.PA', 'VOD.L', 'NOPE.PA']);
    eq(Object.keys(parsed.results).length, 2, 'adaptateur : 2 cours'); assert(parsed.errors['NOPE.PA'], 'adaptateur : 1 erreur');
  });

  await test('Twelve Data : lot, unitaire, erreur de plan', () => {
    const b = td.parse(F.tdBatch, ['AAPL', 'MSFT']);
    eq(Object.keys(b.results).length, 2, 'lot');
    eq(b.results.AAPL.value, Number(F.tdBatch.AAPL.close), 'AAPL'); eq(b.results.AAPL.prev_close, Number(F.tdBatch.AAPL.previous_close), 'veille');
    eq(td.parse(F.tdSingle, ['AAPL']).results.AAPL.currency, 'USD', 'unitaire');
    const err = td.parse({ code: 404, message: 'This symbol is available starting with the Grow or Venture plan.', status: 'error' }, ['TTE']);
    assert(/Grow/.test(err.errors.TTE), 'erreur de plan remontée');
  });

  // -------------------------------------------------------------- orchestration with a fake network
  const config = structuredClone(files.config);
  const portfolio = structuredClone(files.portfolio);
  portfolio.holdings.find((h) => h.id === 'pea-exemple-industries').ticker = 'TTE.PA';
  portfolio.holdings.find((h) => h.id === 'cto-sample-corp').ticker = 'AAPL';
  // File price older than the captured quote, so the merge (newest wins) uses the live one.
  portfolio.holdings.find((h) => h.id === 'cto-sample-corp').last_price.as_of = '2026-11-20T21:00:00Z';
  const calls = [];
  const net = async (url) => {
    calls.push(url);
    if (url.includes('frankfurter')) return res(200, F.frank);
    if (url.includes('gold-api')) return res(200, { ...F.gold, symbol: url.match(/price\/(\w+)/)[1] });
    if (url.includes('proxy.test')) return res(503, null);
    if (url.includes('twelvedata')) {
      const syms = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]).split(',');
      return res(200, syms.length === 1 ? F.tdSingle : Object.fromEntries(syms.map((s) => [s, F.tdBatch[s] ?? { code: 404, status: 'error', message: 'Grow plan' }])));
    }
    return res(404, null);
  };
  const settings = { yahoo_proxy_url: 'https://proxy.test', twelvedata_key: 'test-key' };

  await test('Chaîne : proxy en panne → Twelve Data ; non couvert signalé, jamais inventé', async () => {
    const storage = memoryStorage(); calls.length = 0;
    const { live, report } = await refreshPrices(portfolio, config, { fetch: net, storage, settings, now: NOW, sleep: async () => {} });
    assert(calls.some((u) => u.includes('proxy.test')), 'proxy essayé');
    eq(live.quotes['cto-sample-corp']?.source, 'Twelve Data', 'AAPL via Twelve Data');
    assert(!live.quotes['pea-exemple-industries'], 'TTE.PA : pas de cours inventé');
    const tdRep = report.find((r) => r.provider === 'twelvedata');
    assert(tdRep.errors['TTE.PA'], 'erreur TTE.PA remontée');
    assert(live.fx.CHF && live.spot.XAU, 'change + métaux');
  });

  await test('Cache : dans le TTL aucune requête ; forcer = nouvelles requêtes', async () => {
    const storage = memoryStorage();
    await refreshPrices(portfolio, config, { fetch: net, storage, settings, now: NOW, sleep: async () => {} });
    calls.length = 0;
    await refreshPrices(portfolio, config, { fetch: net, storage, settings, now: new Date(NOW.getTime() + 5 * 6e4), sleep: async () => {} });
    eq(calls.filter((u) => !u.includes('proxy.test') && !u.includes('TTE')).length, 0, 'aucune requête dans le TTL (hors échecs)');
    calls.length = 0;
    await refreshPrices(portfolio, config, { fetch: net, storage, settings, now: NOW, force: true, sleep: async () => {} });
    assert(calls.some((u) => u.includes('frankfurter')), 'forcé : change redemandé');
  });

  await test('Non configuré : fournisseur sauté et signalé', async () => {
    const { report } = await refreshPrices(portfolio, config, { fetch: net, storage: memoryStorage(), settings: {}, now: NOW, sleep: async () => {} });
    assert(report.find((r) => r.provider === 'yahoo_proxy').skipped, 'proxy sauté');
    assert(report.find((r) => r.provider === 'twelvedata').skipped, 'Twelve Data sauté');
  });

  await test('Limite Twelve Data : 9 symboles = 2 lots + 1 pause', async () => {
    const p = structuredClone(portfolio);
    const base = p.holdings.find((h) => h.id === 'cto-sample-corp');
    p.holdings = p.holdings.filter((h) => h.asset_class !== 'equity' && h.asset_class !== 'etf');
    for (let i = 0; i < 9; i++) p.holdings.push({ ...structuredClone(base), id: `us-${i}`, ticker: `US${i}`, price_source: 'quote:twelvedata' });
    let sleeps = 0; calls.length = 0;
    await refreshPrices(p, config, { fetch: net, storage: memoryStorage(), settings, now: NOW, sleep: async () => { sleeps++; } });
    eq(calls.filter((u) => u.includes('twelvedata')).length, 2, 'requêtes'); eq(sleeps, 1, 'pauses');
  });

  await test('Fusion : le plus récent gagne ; prix manuel jamais écrasé', () => {
    const live = { fx: {}, spot: {}, quotes: {
      'pea-exemple-industries': { value: 70, currency: 'EUR', as_of: '2026-11-01T10:00:00Z', source: 'old' },
      'cto-sample-corp': { value: 180, currency: 'USD', as_of: '2026-11-24T22:00:00Z', source: 'new' },
      'pea-etf-monde': { value: 1, currency: 'EUR', as_of: '2026-11-24T22:00:00Z', source: 'x' } } };
    const m = mergeLive(files.portfolio, files.config, live);
    assert(!m.quotes['pea-exemple-industries'], 'plus ancien que le fichier : ignoré');
    eq(m.quotes['cto-sample-corp'].value, 180, 'plus récent : utilisé');
  });

  await test('Mémoriser les cours : fichier valide, journal, révision', async () => {
    const storage = memoryStorage();
    const { live } = await refreshPrices(portfolio, config, { fetch: net, storage, settings, now: NOW, sleep: async () => {} });
    const merged = mergeLive(portfolio, config, live);
    const next = persistPrices(portfolio, merged, 'user', NOW);
    assert(validate(schemas.portfolio, next).length === 0, JSON.stringify(validate(schemas.portfolio, next).slice(0, 3)));
    eq(next.revision, portfolio.revision + 1, 'révision');
    eq(next.changelog.at(-1).field, 'prices', 'journal');
    eq(next.holdings.find((h) => h.id === 'cto-sample-corp').last_price.source, 'Twelve Data', 'last_price écrit');
    eq(Object.keys(liveFromCache(portfolio, config, JSON.parse(storage.getItem('wb.cache.prices'))).quotes).length, 1, 'cache relu');
  });
}
