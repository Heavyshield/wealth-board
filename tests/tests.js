// Browser test runner. Open /tests.html; results also in window.testResults.
// The valuation check compares against tests/expected.json, produced by an independent
// Python/Decimal implementation (tests/compute_expected.py).

import { validate } from '../src/schema.js';
import { loadSchemas, validateAll, crossCheck, applyEdits } from '../src/data.js';
import { valueHoldings, totals } from '../src/valuation.js';
import * as fmt from '../src/format.js';
import { pricesTests } from './prices.test.js';
import { importTests } from './import.test.js';
import { editingTests } from './editing.test.js';
import { filesTests } from './files.test.js';
import { stageGTests } from './stage-g.test.js';
import { modelTests } from './model.test.js';
import { evaluateRules, evaluateHolding, evaluateConstraints, reviewItems } from '../src/rules.js';

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(a === b, `${msg} : attendu ${JSON.stringify(b)}, reçu ${JSON.stringify(a)}`);
const getJson = async (p) => (await fetch(p, { cache: 'no-store' })).json();
const spaces = (s) => s.replace(/[  ]/g, ' ');

const NOW = new Date('2026-11-24T22:00:00Z');

const schemas = await loadSchemas('..');
const files = { portfolio: await getJson('../data/portfolio.json'), config: await getJson('../data/config.json'), history: await getJson('../data/history.json') };
const expected = await getJson('./expected.json');

await test('Schémas : les 3 fichiers de données sont valides', () => {
  const errs = validateAll(files, schemas);
  assert(Object.keys(errs).length === 0, JSON.stringify(errs));
});

await test('Schéma : champ inconnu, date invalide, type faux, champ manquant détectés', () => {
  const bad = structuredClone(files.portfolio);
  bad.holdings[0].quantitty = 3;                 // typo
  bad.holdings[1].updated_at = '2026-13-45';     // bad date
  bad.holdings[2].quantity = '25';               // string instead of number
  delete bad.holdings[3].currency;               // missing required
  const errs = validate(schemas.portfolio, bad);
  const text = JSON.stringify(errs);
  assert(text.includes('holdings[0].quantitty'), 'typo non détectée');
  assert(text.includes('holdings[1].updated_at'), 'date non détectée');
  assert(text.includes('holdings[2].quantity'), 'type non détecté');
  assert(text.includes('currency'), 'champ manquant non détecté');
});

await test('Contrôle croisé : enveloppe inconnue et id en double détectés', () => {
  const bad = structuredClone(files.portfolio);
  bad.holdings[0].envelope = 'pea_typo';
  bad.holdings[1].id = bad.holdings[2].id;
  const text = JSON.stringify(crossCheck(bad, files.config));
  assert(text.includes('pea_typo'), 'enveloppe inconnue non détectée');
  assert(text.includes('id en double'), 'doublon non détecté');
});

const rows = valueHoldings({ portfolio: files.portfolio, config: files.config, now: NOW });

await test('Valorisation ligne à ligne = référence Python (au centime)', () => {
  for (const r of rows) {
    const e = expected.lines[r.id];
    assert(e, `ligne ${r.id} absente de expected.json (relancer compute_expected.py)`);
    eq(r.value_base_cents, e.value_cents, `valeur ${r.id}`);
    eq(r.cost_base_cents, e.cost_cents, `coût ${r.id}`);
  }
});

await test('Total patrimoine = référence Python (au centime)', () => {
  const t = totals(rows);
  eq(t.value_cents, expected.total_value_cents, 'total');
});

await test('Statuts de prix : à jour / périmé / manuel / solde', () => {
  const s = Object.fromEntries(rows.map((r) => [r.id, r.price.status]));
  eq(s['pea-exemple-industries'], 'live', 'cours récent');
  eq(s['pea-demo-energie'], 'stale', 'cours du 10/11');
  eq(s['pea-etf-monde'], 'manual', 'prix manuel');
  eq(s['livret-a'], 'balance', 'livret');
  eq(s['metal-bar-100g'], 'live', 'spot récent');
});

await test('Prix absent : valorisé au PRU et signalé', () => {
  const p = structuredClone(files.portfolio);
  delete p.holdings[0].last_price;
  const r = valueHoldings({ portfolio: p, config: files.config, now: NOW })[0];
  eq(r.price.status, 'missing', 'statut');
  eq(r.value_base, 40 * 50, 'valeur au PRU');
});

await test('Effet de change isolé (SEK, taux d\'achat 11,0)', () => {
  const r = rows.find((x) => x.id === 'cto-fjord-exempel');
  // cost 21000 SEK: at 11.0 = 1909.09, at 11.5 = 1826.09 -> FX effect -83.00
  eq(Math.round(r.pnl_fx_base * 100), -8300, 'effet change');
  eq(Math.round((r.pnl_local_base + r.pnl_fx_base) * 100), Math.round(r.pnl_base * 100), 'somme des effets');
});

await test('Variation du jour = référence Python, et pas de variation sur prix périmé/manuel', () => {
  const t = totals(rows);
  const sumCents = rows.reduce((a, r) => a + (r.day_base === null ? 0 : Math.round(r.day_base * 100)), 0);
  eq(sumCents, expected.total_day_cents, 'variation du jour (centimes)');
  eq(Math.round(t.day * 100), expected.total_day_cents, 'total jour');
  for (const r of rows) eq(r.day_base === null, !(r.id in expected.lines && 'day_cents' in expected.lines[r.id]), `couverture ${r.id}`);
  assert(t.day_coverage > 0 && t.day_coverage < 1, 'couverture partielle attendue');
});

await test('Régions : cash et métaux par type de prix, actions par ISIN', () => {
  const g = Object.fromEntries(rows.map((r) => [r.id, r.region]));
  eq(g['livret-a'], 'Liquidités', 'livret');
  eq(g['metal-bar-100g'], 'Métaux', 'lingot');
  eq(g['cto-fjord-exempel'], 'Nordiques', 'SE');
  eq(g['pea-etf-monde'], 'Monde (ETF)', 'IE');
});

await test('Cibles d’allocation : somme ≠ 100 % et clé inconnue détectées', () => {
  const cfg = structuredClone(files.config);
  cfg.allocation_targets.weights.equity = 0.5;
  cfg.allocation_targets.weights.cryptos = 0.1;
  const text = JSON.stringify(crossCheck(files.portfolio, cfg));
  assert(text.includes('somme des cibles'), 'somme non détectée');
  assert(text.includes('cryptos'), 'clé inconnue non détectée');
});

await test('Édition : journal des changements + révision', () => {
  const next = applyEdits(files.portfolio, { 'livret-a': { quantity: 12500, notes: 'test' } }, 'claude', NOW);
  eq(next.revision, files.portfolio.revision + 1, 'révision');
  eq(next.changelog.length, files.portfolio.changelog.length + 2, 'entrées journal');
  const c = next.changelog.at(-2);
  eq(c.old, 12000, 'ancienne valeur'); eq(c.new, 12500, 'nouvelle valeur'); eq(c.author, 'claude', 'auteur');
  assert(validate(schemas.portfolio, next).length === 0, 'fichier édité invalide');
  eq(files.portfolio.holdings.find((h) => h.id === 'livret-a').quantity, 12000, 'original non modifié');
});

await test('Format français : 1 234,56 € et saisie « 1 234,5 »', () => {
  eq(spaces(fmt.money(1234.56, 'EUR')), '1 234,56 €', 'montant');
  eq(spaces(fmt.pct(0.1234)), '+12,3 %', 'pourcentage');
  eq(fmt.parseNumber('1 234,5'), 1234.5, 'saisie');
  assert(Number.isNaN(fmt.parseNumber('abc')), 'saisie invalide');
});

// ---------------------------------------------------------------- stage c: rules + constraints
// Expected values below are worked out by hand from data/*.json and the rule definitions.
evaluateRules(rows, files.config, NOW);
const st = (id) => rows.find((r) => r.id === id).rules.status;

await test('Règles : statuts attendus sur les données d’exemple', () => {
  eq(st('pea-exemple-industries'), 'ok', 'PER 18, P/CF 11, DN/EBITDA 1,2');
  eq(st('pea-demo-energie'), 'breach', 'PER 31 > 25 et DN/EBITDA 3,1 > 2,5');
  eq(st('cto-fjord-exempel'), 'unknown', 'aucun ratio : n/d, pas d’alerte');
  eq(st('cto-sample-corp'), 'breach', 'P/CF 16,5 > 15');
  eq(st('pea-etf-monde'), 'na', 'ETF hors périmètre');
  eq(st('livret-a'), 'na', 'livret hors périmètre');
  const demo = rows.find((r) => r.id === 'pea-demo-energie').rules.results;
  eq(demo.filter((x) => x.state === 'fail').map((x) => x.rule.id).join(','), 'per-max,leverage-max', 'règles enfreintes');
});

await test('Règles : PER négatif = hors règles, dette nette négative = conforme', () => {
  const h = structuredClone(files.portfolio.holdings[0]);
  h.metrics = { per: -8, pcf: 5, net_debt_ebitda: -0.7, as_of: '2026-10-31' };
  const ev = evaluateHolding(h, files.config, NOW);
  eq(ev.status, 'breach', 'statut');
  eq(ev.results.find((x) => x.rule.metric === 'per').reason, 'valeur négative ou nulle', 'raison');
  eq(ev.results.find((x) => x.rule.metric === 'net_debt_ebitda').state, 'pass', 'trésorerie nette');
});

await test('Règles : métriques trop anciennes signalées', () => {
  const h = structuredClone(files.portfolio.holdings[0]);
  h.metrics.as_of = '2025-01-01';
  const ev = evaluateHolding(h, files.config, NOW);
  eq(ev.status, 'stale', 'statut'); assert(ev.metrics_age_days > 600, 'âge');
});

await test('Règles : une règle ajoutée dans le JSON seul s’applique (métrique libre)', () => {
  const cfg = structuredClone(files.config);
  cfg.rules.items.push({ id: 'yield-min', label: 'Rendement ≥ 2 %', metric: 'dividend_yield', op: '>=', value: 2, applies_to: { asset_class: ['equity'] } });
  const h = structuredClone(files.portfolio.holdings[0]);
  eq(evaluateHolding(h, cfg, NOW).status, 'partial', 'un ratio n/d, les autres conformes');
  h.metrics.dividend_yield = 1.4;
  eq(evaluateHolding(h, cfg, NOW).status, 'breach', 'rendement 1,4 < 2');
  assert(validate(schemas.config, cfg).length === 0, 'config étendue valide');
  const p = structuredClone(files.portfolio); p.holdings[0] = h;
  assert(validate(schemas.portfolio, p).length === 0, 'métrique libre valide');
});

const cons = Object.fromEntries(evaluateConstraints(rows, files.portfolio, files.config).map((c) => [c.id, c]));

await test('Contrainte poche métaux : 10 067,20 / 48 392,14 = 20,8 % > 20 %', () => {
  eq(cons['metals-pocket'].state, 'breach', 'état');
  eq(Math.round(cons['metals-pocket'].share * 1000), 208, 'part');
});

await test('Contrainte réserve : 27 495,65 € / 2 500 € = 11,0 mois ≥ 6', () => {
  eq(Math.round(cons['cash-runway'].value * 100), 2749565, 'liquidités');
  eq(Math.round(cons['cash-runway'].months * 10), 110, 'mois');
  eq(cons['cash-runway'].state, 'ok', 'état');
});

await test('À revoir : critiques d’abord, triés par montant', () => {
  const items = reviewItems(rows, Object.values(cons), files.config, fmt);
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    assert(a.severity > b.severity || (a.severity === b.severity && (a.amount ?? 0) >= (b.amount ?? 0)), `ordre ${i}`);
  }
  const crit = items.filter((i) => i.severity === 3).map((i) => i.title);
  const warn = items.filter((i) => i.severity === 2).map((i) => i.title);
  assert(crit.includes('Poche métaux précieux'), 'contrainte métaux');
  assert(warn.includes('Démo Énergie (fictif)') && warn.includes('Sample Corp (fictive)'), 'seuils dépassés = avertissement');
  assert(!items.some((i) => i.title === 'Fjord Exempel AB (fictif)' && i.kind !== 'prix'), 'ratios n/d : aucune alerte');
});

await test('Édition de métrique (chemin metrics.per) + suppression', () => {
  let next = applyEdits(files.portfolio, { 'pea-demo-energie': { 'metrics.per': 22.5 } }, 'user', NOW);
  eq(next.holdings[1].metrics.per, 22.5, 'valeur');
  eq(next.changelog.at(-1).field, 'metrics.per', 'journal'); eq(next.changelog.at(-1).old, 31, 'ancienne');
  next = applyEdits(next, { 'pea-demo-energie': { 'metrics.pcf': null } }, 'user', NOW);
  assert(!('pcf' in next.holdings[1].metrics), 'supprimée');
  assert(validate(schemas.portfolio, next).length === 0, 'valide');
  const bad = applyEdits(files.portfolio, { 'cto-fjord-exempel': { 'metrics.per': 12 } }, 'user', NOW);
  assert(JSON.stringify(validate(schemas.portfolio, bad)).includes('as_of'), 'date des métriques exigée');
});

await test('Contrôle croisé : contrainte et règle avec ids inconnus', () => {
  const cfg = structuredClone(files.config);
  cfg.constraints.find((c) => c.type === 'runway').liquid = { asset_class: ['cashh'] };
  cfg.rules.items[0].applies_to = { asset_class: ['equities'] };
  const text = JSON.stringify(crossCheck(files.portfolio, cfg));
  assert(text.includes('cashh') && text.includes('equities'), text);
});

// ---------------------------------------------------------------- stage d: prices
await pricesTests({ test, assert, eq, files, schemas, validate, NOW });

// ---------------------------------------------------------------- stage e: CSV import
await importTests({ test, assert, eq, files, schemas, validate, NOW });

// ---------------------------------------------------------------- tickers + editing
await editingTests({ test, assert, eq, files, schemas, validate, NOW });

// ---------------------------------------------------------------- single-file storage (Drive)
await filesTests({ test, assert, eq, files, schemas, validate, NOW });

// ---------------------------------------------------------------- stage g: snapshot, export, optional Drive login
await stageGTests({ test, assert, eq, files, schemas, validate, NOW, rows, expected });

// ---------------------------------------------------------------- extensible model + Éditeur Données
await modelTests({ test, assert, eq, files, schemas, validate, NOW });

const failed = results.filter((r) => !r.ok);
window.testResults = { pass: results.length - failed.length, fail: failed.length, results };
document.querySelector('#out').innerHTML = `<h2>${failed.length ? `❌ ${failed.length} échec(s)` : '✅ Tous les tests passent'} (${results.length})</h2>` +
  '<ul>' + results.map((r) => `<li>${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : ` — <code>${r.error}</code>`}</li>`).join('') + '</ul>';
document.title = failed.length ? 'FAIL' : 'PASS';
