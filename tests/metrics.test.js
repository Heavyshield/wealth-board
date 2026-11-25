// Ratios from Yahoo (proxy /metrics): parsing on REAL captured quoteSummary answers for public companies
// (Air Liquide, TSMC ADR, Ubisoft), the worker route end to end (cookie + crumb), and how results are written.

import worker from '../tools/yahoo-proxy-worker.js';
import { metricTargets, fetchMetrics, applyMetrics } from '../src/metrics.js';
import { evaluateHolding } from '../src/rules.js';
import { rankByPer } from '../src/per-rank.js';

const fx = async (n) => (await fetch(`./fixtures/yahoo-summary-${n}.json`, { cache: 'no-store' })).json();

export async function metricsTests({ test, assert, eq, files, schemas, validate, NOW }) {
  const ai = await fx('ai'), tsm = await fx('tsm'), loss = await fx('loss'), none = await fx('none');
  const raw = (b, m, k) => b.quoteSummary.result[0][m][k].raw;

  await test('Ratios Yahoo : Air Liquide (EUR/EUR) = calcul à la main', () => {
    const r = worker.parseSummary(ai);
    eq(r.metrics.per, Math.round(raw(ai, 'summaryDetail', 'trailingPE') * 100) / 100, 'PER');
    eq(r.metrics.pcf, Math.round(raw(ai, 'summaryDetail', 'marketCap') / raw(ai, 'financialData', 'operatingCashflow') * 100) / 100, 'P/CF = capitalisation / flux d’exploitation');
    eq(r.metrics.net_debt_ebitda, Math.round((raw(ai, 'financialData', 'totalDebt') - raw(ai, 'financialData', 'totalCash')) / raw(ai, 'financialData', 'ebitda') * 100) / 100, 'DN/EBITDA');
    assert(r.metrics.pcf > 21 && r.metrics.pcf < 23 && r.metrics.net_debt_ebitda > 1.9 && r.metrics.net_debt_ebitda < 2.1, JSON.stringify(r.metrics));
  });

  await test('Ratios Yahoo : devises différentes = P/CF n/d (jamais un ratio faux)', () => {
    const r = worker.parseSummary(tsm);
    assert(!('pcf' in r.metrics), 'P/CF absent'); assert(/USD.*TWD/.test(r.notes), r.notes);
    assert(r.metrics.net_debt_ebitda < 0, 'trésorerie nette (même devise) calculée');
  });

  await test('Ratios Yahoo : société en perte = PER négatif calculé, EBITDA négatif = n/d', () => {
    const r = worker.parseSummary(loss);
    eq(r.metrics.per, Math.round(raw(loss, 'financialData', 'currentPrice') / raw(loss, 'defaultKeyStatistics', 'trailingEps') * 100) / 100, 'PER = cours / BPA');
    assert(r.metrics.per < 0, 'négatif');
    assert(!('net_debt_ebitda' in r.metrics) && /EBITDA négatif/.test(r.notes), r.notes);
    const h = { ...files.portfolio.holdings[0], metrics: { ...r.metrics, as_of: '2026-11-25' } };
    eq(evaluateHolding(h, files.config, NOW).status, 'breach', 'PER négatif = au-dessus du seuil (règle require_positive)');
  });

  await test('Ratios Yahoo : application = parse du proxy', () => {
    eq(JSON.stringify(worker.parseSummary(ai)), JSON.stringify(worker.parseSummary(structuredClone(ai))), 'déterministe');
    let msg = ''; try { worker.parseSummary(none); } catch (e) { msg = e.message; }
    assert(/Quote not found/.test(msg), msg);
  });

  await test('Proxy /metrics de bout en bout : cookie + jeton, renouvelé sur 401', async () => {
    worker._resetSession();
    let crumbs = 0, first401 = true;
    const headers = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null, getSetCookie: () => (o['set-cookie'] ? [o['set-cookie']] : []) });
    const upstream = async (url, init = {}) => {
      if (url.startsWith('https://fc.yahoo.com')) return { status: 404, headers: headers({ 'set-cookie': 'A3=d=TEST; Expires=Fri; Domain=.yahoo.com' }), text: async () => '' };
      if (url.includes('getcrumb')) { crumbs++; assert(init.headers.Cookie === 'A3=d=TEST', 'cookie transmis'); return { status: 200, headers: headers({}), text: async () => `crumb${crumbs}` }; }
      if (url.includes('quoteSummary/AI.PA')) {
        if (first401) { first401 = false; return { status: 401, headers: headers({}), json: async () => ({}) }; }
        assert(url.includes('crumb=crumb2'), 'nouveau jeton après 401');
        return { status: 200, headers: headers({}), json: async () => ai };
      }
      return { status: 200, headers: headers({}), json: async () => none };
    };
    const net = async (url) => worker.handle({ url, method: 'GET', headers: new Headers({ Origin: 'http://localhost:8770' }) }, {}, upstream);
    const r = await fetchMetrics(['AI.PA', 'NOPE.PA'], { fetch: net, settings: { yahoo_proxy_url: 'https://proxy.test' } });
    eq(r.results['AI.PA'].metrics.per, worker.parseSummary(ai).metrics.per, 'PER via le proxy');
    assert(r.errors['NOPE.PA'], 'symbole inconnu en erreur'); eq(crumbs, 2, 'session renouvelée une fois');
  });

  await test('Ratios : saisies manuelles gardées, Yahoo remplacé, journal, fichier valide', () => {
    const p = structuredClone(files.portfolio);
    p.holdings.find((h) => h.id === 'pea-exemple-industries').ticker = 'AI.PA';   // has manual metrics -> kept
    p.holdings.find((h) => h.id === 'cto-sample-corp').ticker = 'TSM';
    delete p.holdings.find((h) => h.id === 'cto-sample-corp').metrics;           // none -> fetched
    p.holdings.find((h) => h.id === 'cto-fjord-exempel').ticker = 'UBI.PA';
    const targets = metricTargets(p, files.config);
    assert(!targets.some((t) => t.id === 'pea-etf-monde'), 'ETF hors règles : pas interrogé');
    const fetched = { results: { 'AI.PA': worker.parseSummary(ai), TSM: worker.parseSummary(tsm), 'UBI.PA': worker.parseSummary(loss), 'DEN.PA': worker.parseSummary(ai) }, errors: {} };
    const r = applyMetrics(p, targets, fetched, NOW);
    assert(r.kept.includes('pea-exemple-industries') && r.kept.includes('pea-demo-energie'), 'saisies manuelles gardées');
    assert(r.updated.includes('cto-sample-corp') && r.updated.includes('cto-fjord-exempel'), 'mis à jour');
    const tsmLine = r.portfolio.holdings.find((h) => h.id === 'cto-sample-corp');
    eq(tsmLine.metrics.source, 'Yahoo', 'source'); eq(tsmLine.metrics.as_of, '2026-11-24', 'date'); assert(/TWD/.test(tsmLine.metrics.notes), 'raison du n/d gardée');
    eq(p.holdings.find((h) => h.id === 'pea-exemple-industries').metrics.per, r.portfolio.holdings.find((h) => h.id === 'pea-exemple-industries').metrics.per, 'manuel intact');
    assert(validate(schemas.portfolio, r.portfolio).length === 0, JSON.stringify(validate(schemas.portfolio, r.portfolio).slice(0, 3)));
    eq(r.portfolio.changelog.length - p.changelog.length, 2, 'une entrée par ligne');
    // a second pass overwrites Yahoo values (not manual ones)
    const again = applyMetrics(r.portfolio, metricTargets(r.portfolio, files.config), fetched, NOW);
    assert(again.updated.includes('cto-sample-corp'), 'Yahoo rafraîchi');
  });

  await test('Actions par PER : actions seulement, PER croissant, négatifs puis n/d en fin', () => {
    const row = (id, cls, per, value) => ({ id, value_base: value, h: { asset_class: cls, ...(per === undefined ? {} : { metrics: { per } }) } });
    const ranked = rankByPer([row('a', 'equity', 34, 10), row('b', 'equity', 9, 5), row('c', 'etf', 3, 50), row('d', 'equity', -4, 1),
      row('e', 'equity', undefined, 7), row('f', 'equity', 14, 2), row('g', 'equity', undefined, 20)]);
    eq(ranked.map((r) => r.id).join(), 'b,f,a,d,g,e', 'ordre (n/d par valeur décroissante)');
  });
}
