// Stage d tests: provider parsing on REAL captured responses (tests/fixtures, 2026-11-25),
// proxy worker behaviour, fallback chain, cache TTL, rate-limit batching, merge rules.
// Exports a function the main runner calls with its `test` / `assert` / `eq` helpers.

import * as frank from '../src/providers/frankfurter.js';
import * as ecb from '../src/providers/ecb.js';
import * as gold from '../src/providers/goldapi.js';
import * as yp from '../src/providers/yahoo-proxy.js';
import worker from '../tools/yahoo-proxy-worker.js';
import { refreshPrices, mergeLive, persistPrices, liveFromCache, withFuturesHistory } from '../src/prices.js';
import { topMoves } from '../src/top-moves.js';
import { totals } from '../src/valuation.js';
import { changePct } from '../src/charts.js';

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
    unknown: await fx('yahoo-chart-unknown.json'), san1mo: await fx('yahoo-chart-san-1mo.json'),
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
    for (const f of [F.tte, F.vod, F.volvo, F.san1mo]) eq(JSON.stringify(worker.parseChart(f)), JSON.stringify(yp.parseChart(f)), f.chart.result[0].meta.symbol);
  });

  await test('Yahoo 1 mois (Sanofi réel, 25/11/2026) : veille, ~1 semaine, ~1 mois depuis les clôtures du jour', () => {
    const s = yp.parseChart(F.san1mo);
    const r2 = (v) => Math.round(v * 100) / 100;
    eq(r2(s.prev_close), 93.58, 'veille = dernière séance avant aujourd’hui (pas chartPreviousClose, qui précède la période)');
    eq(r2(s.close_1w), 86.25, 'il y a ~7 jours');
    eq(r2(s.close_1m), 74.58, 'il y a ~30 jours');
    const old = yp.parseChart(F.tte);
    assert(old.close_1w === undefined && old.close_1m === undefined, 'réponse 1 jour (ancien proxy) : pas de semaine / mois');
  });

  await test('Métaux : variation jour / semaine / mois des contrats à terme appliquée au spot', () => {
    const spot = { value: 35, currency: 'EUR', per: 'oz', as_of: '2026-11-25T15:00:00Z', source: 'gold-api.com' };
    const fut = { value: 40, prev_close: 38, close_1w: 32, close_1m: 50, as_of: '2026-11-25T14:55:00Z', symbol: 'SI=F' };
    const s = withFuturesHistory(spot, fut);
    eq(s.prev_close, 35 * 38 / 40, 'veille = spot x (veille / cours) du contrat');
    eq(s.close_1w, 28, 'semaine'); eq(s.close_1m, 43.75, 'mois'); eq(s.history_source, 'Yahoo SI=F', 'source');
    eq(withFuturesHistory(spot, { ...fut, as_of: '2026-11-15T00:00:00Z' }), spot, 'contrat trop ancien : ignoré');
    eq(withFuturesHistory(spot, undefined), spot, 'pas de contrat : spot inchangé');
  });

  await test('Variation de la semaine : total, couverture (soldes à 0 €), % sur la valeur de départ', () => {
    const row = (status, cents, week_base) => ({ in_total: true, value_base_cents: cents, cost_base_cents: cents, price: { status }, day_base: null, week_base });
    const t = totals([row('live', 110000, 100), row('live', 50000, null), row('balance', 40000, null), row('live', 0, null)]);
    eq(t.week, 100, 'total semaine'); eq(t.week_coverage, 150000 / 200000, 'couverture : ligne avec semaine + solde');
    eq(Math.round(changePct(t.week, t.week_coverage, t.value) * 1e6), Math.round(100 / 1400 * 1e6), '% = 100 / (1 500 − 100)');
    eq(totals([row('balance', 40000, null)]).week, null, 'soldes seuls : indisponible');
  });

  await test('Plus gros mouvements : 3 plus grandes variations en euros, hausse ou baisse, hors patrimoine exclu', () => {
    const row = (id, week_base, in_total) => ({ id, week_base, ...(in_total === false ? { in_total } : {}) });
    const top = topMoves([row('a', 120), row('b', -900), row('c', null), row('d', 450), row('e', 50), row('f', -2000, false), row('g', 0)]);
    eq(top.map((r) => r.id).join(), 'b,d,a', 'ordre par valeur absolue');
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

  // -------------------------------------------------------------- orchestration with a fake network
  const config = structuredClone(files.config);
  const portfolio = structuredClone(files.portfolio);
  portfolio.holdings.find((h) => h.id === 'pea-exemple-industries').ticker = 'TTE.PA';
  portfolio.holdings.find((h) => h.id === 'cto-sample-corp').ticker = 'AAPL';
  // AAPL has no captured Yahoo answer here: it exercises the 'unknown symbol' path.
  portfolio.holdings.find((h) => h.id === 'cto-sample-corp').last_price.as_of = '2026-11-20T21:00:00Z';
  // Fake network: FX / metals from fixtures; the proxy URL is served by the REAL worker code,
  // whose Yahoo upstream answers from the captured fixtures (TTE.PA known, anything else unknown).
  const calls = [];
  const yahoo = async (url) => res(200, url.includes('/TTE.PA') ? F.tte : F.unknown);
  const net = async (url) => {
    calls.push(url);
    if (url.includes('frankfurter')) return res(200, F.frank);
    if (url.includes('gold-api')) return res(200, { ...F.gold, symbol: url.match(/price\/(\w+)/)[1] });
    if (url.startsWith('https://proxy.test')) {
      return worker.handle({ url, method: 'GET', headers: new Headers({ Origin: 'http://localhost:8770' }) }, {}, yahoo);
    }
    if (url.startsWith('https://down.test')) return res(503, null);
    return res(404, null);
  };
  const settings = { yahoo_proxy_url: 'https://proxy.test' };
  const run = (extra = {}) => refreshPrices(portfolio, config, { fetch: net, storage: memoryStorage(), settings, now: NOW, sleep: async () => {}, ...extra });

  await test('Chaîne complète : adaptateur → proxy → Yahoo ; symbole inconnu signalé, jamais inventé', async () => {
    calls.length = 0;
    const { live, report } = await run();
    eq(live.quotes['pea-exemple-industries']?.source, 'Yahoo (proxy)', 'TTE.PA via le proxy');
    eq(live.quotes['pea-exemple-industries'].value, F.tte.chart.result[0].meta.regularMarketPrice, 'cours TTE.PA');
    assert(!live.quotes['cto-sample-corp'], 'AAPL inconnu ici : pas de cours inventé');
    assert(report.find((r) => r.provider === 'yahoo_proxy').errors.AAPL, 'erreur AAPL remontée');
    assert(live.fx.CHF && live.spot.XAU, 'change + métaux');
    const stockCalls = calls.filter((u) => u.startsWith('https://proxy.test') && !u.includes('%3DF'));
    eq(stockCalls.length, 1, 'une seule requête pour toutes les actions');
    assert(calls.some((u) => u.startsWith('https://proxy.test') && u.includes('GC%3DF')), 'contrats à terme métaux demandés (1 requête de plus)');
  });

  await test('Proxy en panne : erreur remontée pour chaque ligne, aucun cours', async () => {
    const { live, report } = await run({ settings: { yahoo_proxy_url: 'https://down.test' } });
    eq(Object.keys(live.quotes).length, 0, 'aucun cours');
    const errs = report.find((r) => r.provider === 'yahoo_proxy').errors;
    assert(errs['TTE.PA'] && errs.AAPL, JSON.stringify(errs));
  });

  await test('Cache : dans le TTL aucune requête ; forcer = nouvelles requêtes', async () => {
    const storage = memoryStorage();
    await run({ storage });
    calls.length = 0;
    await run({ storage, now: new Date(NOW.getTime() + 5 * 6e4) });
    eq(calls.filter((u) => !u.startsWith('https://proxy.test')).length, 0, 'change et métaux en cache');
    const proxyCalls = calls.filter((u) => u.startsWith('https://proxy.test'));
    assert(proxyCalls.every((u) => !u.includes('TTE.PA')), 'TTE.PA en cache, seul l’échec est redemandé');
    calls.length = 0;
    await run({ storage, force: true });
    assert(calls.some((u) => u.includes('frankfurter')), 'forcé : change redemandé');
  });

  await test('Non configuré : proxy sauté et signalé', async () => {
    const { report } = await run({ settings: {} });
    assert(report.find((r) => r.provider === 'yahoo_proxy').skipped, 'proxy sauté');
  });

  await test('Lots : 21 actions = 2 requêtes au proxy (max 20), sans pause', async () => {
    const p = structuredClone(portfolio);
    const base = p.holdings.find((h) => h.id === 'pea-exemple-industries');
    p.holdings = p.holdings.filter((h) => h.asset_class !== 'equity' && h.asset_class !== 'etf');
    for (let i = 0; i < 21; i++) p.holdings.push({ ...structuredClone(base), id: `eq-${i}`, ticker: `EQ${i}.PA` });
    let sleeps = 0; calls.length = 0;
    await refreshPrices(p, config, { fetch: net, storage: memoryStorage(), settings, now: NOW, sleep: async () => { sleeps++; } });
    eq(calls.filter((u) => u.startsWith('https://proxy.test') && !u.includes('%3DF')).length, 2, 'requêtes'); eq(sleeps, 0, 'pauses');
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
    const { live } = await run({ storage });
    const merged = mergeLive(portfolio, config, live);
    const next = persistPrices(portfolio, merged, 'user', NOW);
    assert(validate(schemas.portfolio, next).length === 0, JSON.stringify(validate(schemas.portfolio, next).slice(0, 3)));
    eq(next.revision, portfolio.revision + 1, 'révision');
    eq(next.changelog.at(-1).field, 'prices', 'journal');
    eq(next.holdings.find((h) => h.id === 'pea-exemple-industries').last_price.source, 'Yahoo (proxy)', 'last_price écrit');
    eq(Object.keys(liveFromCache(portfolio, config, JSON.parse(storage.getItem('wb.cache.prices'))).quotes).length, 1, 'cache relu');
  });
}
