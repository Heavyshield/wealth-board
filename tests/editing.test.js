// Tests: ISIN -> ticker search (real captured Yahoo responses for PUBLIC example ISINs, never the
// user's holdings), and the editing operations (add / remove / account / sample cleanup).

import worker from '../tools/yahoo-proxy-worker.js';
import { parseSearch, bestListing, searchIsins } from '../src/providers/yahoo-proxy.js';
import { addHolding, removeHolding, setAccount, removeSampleData, applyEdits } from '../src/data.js';

const fx = async (name) => (await fetch(`./fixtures/${name}`, { cache: 'no-store' })).json();
const res = (status, body) => ({ status, ok: status < 400, json: async () => body });

export async function editingTests({ test, assert, eq, files, schemas, validate, NOW }) {
  const lvmh = await fx('yahoo-search-lvmh.json'), iwda = await fx('yahoo-search-iwda.json'), none = await fx('yahoo-search-none.json');

  await test('Recherche ISIN : cotation, place, type ; aucun résultat géré', () => {
    const a = parseSearch(lvmh);
    eq(a[0].symbol, 'MC.PA', 'LVMH'); eq(a[0].exchange, 'PAR', 'place'); eq(a[0].type, 'EQUITY', 'type');
    eq(parseSearch(iwda)[0].type, 'ETF', 'ETF'); eq(parseSearch(none).length, 0, 'aucun');
    eq(JSON.stringify(worker.parseSearch(lvmh)), JSON.stringify(a), 'proxy = application');
  });

  await test('Meilleure cotation : ordre des places de config.providers', () => {
    const c = [{ symbol: 'X.L', exchange: 'LSE' }, { symbol: 'X.AS', exchange: 'AMS' }, { symbol: 'X.PA', exchange: 'PAR' }];
    eq(bestListing(c, files.config.providers.preferred_exchanges).pick.symbol, 'X.PA', 'Paris d’abord');
    eq(bestListing(c, []).pick.symbol, 'X.L', 'sans préférence : ordre Yahoo');
  });

  await test('Proxy /search de bout en bout (code réel du proxy, réponses Yahoo enregistrées)', async () => {
    const upstream = async (url) => res(200, url.includes('FR0000121014') ? lvmh : url.includes('IE00B4L5Y983') ? iwda : none);
    const net = async (url) => worker.handle({ url, method: 'GET', headers: new Headers({ Origin: 'http://localhost:8770' }) }, {}, upstream);
    const r = await searchIsins(['FR0000121014', 'IE00B4L5Y983', 'FR0000000001'], { fetch: net, settings: { yahoo_proxy_url: 'https://proxy.test' } });
    eq(r.results.FR0000121014[0].symbol, 'MC.PA', 'LVMH'); eq(r.results.IE00B4L5Y983[0].symbol, 'IWDA.L', 'IWDA');
    eq(r.errors.FR0000000001, 'aucune cotation trouvée', 'ISIN sans cotation');
    const bad = await net('https://proxy.test/search?isins=NOTANISIN');
    eq(bad.status, 400, 'ISIN invalide refusé');
  });

  await test('Ajout / suppression de ligne : journal complet, fichier valide', () => {
    const line = { id: 'livret-test', name: 'Livret test', envelope: 'livret', asset_class: 'account', quantity: 1500, unit_cost: 1, currency: 'EUR', price_source: 'par', tags: [], notes: '' };
    const added = addHolding(files.portfolio, line, 'user', NOW);
    assert(validate(schemas.portfolio, added).length === 0, 'valide après ajout');
    eq(added.changelog.at(-1).new, 'ajout', 'journal ajout');
    let dup = ''; try { addHolding(added, line, 'user', NOW); } catch (e) { dup = e.message; }
    assert(/déjà utilisé/.test(dup), 'id en double refusé');
    const removed = removeHolding(added, 'livret-test', 'user', NOW);
    eq(removed.holdings.length, files.portfolio.holdings.length, 'supprimée');
    eq(removed.changelog.at(-1).old.quantity, 1500, 'ligne complète dans le journal');
  });

  await test('Édition d’objets (métal, prix manuel) : seulement si la valeur change', () => {
    const bar = files.portfolio.holdings.find((h) => h.id === 'metal-bar-100g');
    const same = applyEdits(files.portfolio, { 'metal-bar-100g': { metal: { ...bar.metal } } }, 'user', NOW);
    eq(same.changelog.length, files.portfolio.changelog.length, 'même objet : aucune entrée');
    const diff = applyEdits(files.portfolio, { 'metal-bar-100g': { metal: { ...bar.metal, weight: 50 } } }, 'user', NOW);
    eq(diff.changelog.at(-1).field, 'metal', 'objet modifié journalisé');
    const unset = applyEdits(files.portfolio, { 'pea-etf-monde': { manual_price: null } }, 'user', NOW);
    assert(!('manual_price' in unset.holdings.find((h) => h.id === 'pea-etf-monde')), 'null = champ retiré');
  });

  await test('Versements PEA : création, mise à jour, journal', () => {
    const next = setAccount(files.portfolio, 'pea', { contributions: 61000, as_of: '2026-11-25' }, 'user', NOW);
    eq(next.accounts.find((a) => a.envelope === 'pea').contributions, 61000, 'montant');
    eq(next.changelog.at(-1).target, 'account:pea', 'cible');
    const cto = setAccount(files.portfolio, 'cto', { contributions: 5000, as_of: '2026-11-25' }, 'user', NOW);
    eq(cto.accounts.length, (files.portfolio.accounts?.length ?? 0) + 1, 'nouveau compte');
    assert(validate(schemas.portfolio, cto).length === 0, 'valide');
  });

  await test('Retirer les données d’exemple : garde les lignes réelles, une entrée de journal', () => {
    const real = { id: 'pea-vraie-ligne', name: 'Vraie ligne', envelope: 'pea', asset_class: 'equity', isin: 'FR0000121014', quantity: 3, unit_cost: 600, currency: 'EUR', price_source: 'quote', tags: [], notes: '' };
    const mixed = addHolding(files.portfolio, real, 'user', NOW);
    const clean = removeSampleData(mixed, files.portfolio, 'user', NOW);
    eq(clean.holdings.map((h) => h.id).join(), 'pea-vraie-ligne', 'seule la ligne réelle reste');
    eq(clean.sample_data, false, 'drapeau retiré'); eq((clean.accounts ?? []).length, 0, 'versements d’exemple retirés');
    eq(clean.changelog.at(-1).old.length, files.portfolio.holdings.length, 'ids retirés listés');
    assert(validate(schemas.portfolio, clean).length === 0, 'valide');
  });
}
