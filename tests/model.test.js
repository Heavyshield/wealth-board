// Extensible model: TO_FILL lines (quantity null), envelope flags (out of net worth / out of allocation),
// amount caps, regions by ISIN, and the Éditeur Données merge. Fake lines only (no real data in the repo).

import { valueHoldings, totals, groupBy } from '../src/valuation.js';
import { evaluateConstraints, reviewItems, evaluateRules } from '../src/rules.js';
import { mergeFragment } from '../src/data.js';
import * as fmt from '../src/format.js';

export async function modelTests({ test, assert, eq, files, schemas, validate, NOW }) {
  const cfg = structuredClone(files.config);
  cfg.envelopes.push({ id: 'locked', label: 'Retraite bloquée', in_net_worth: false }, { id: 'reserve', label: 'Réserve', in_allocation: false });
  const pf = structuredClone(files.portfolio);
  const base = { asset_class: 'account', unit_cost: 1, currency: 'EUR', price_source: 'par', tags: [], notes: '', updated_at: '2026-11-24T00:00:00Z', as_of: '2026-11-24' };
  pf.holdings.push(
    { ...base, id: 'to-fill', name: 'Inconnu', envelope: 'livret', quantity: null },
    { ...base, id: 'locked-1', name: 'Bloqué', envelope: 'locked', quantity: 5000 },
    { ...base, id: 'reserve-1', name: 'Réserve', envelope: 'reserve', asset_class: 'cash', quantity: 1000 },
  );
  const rows = evaluateRules(valueHoldings({ portfolio: pf, config: cfg, now: NOW }), cfg, NOW);
  const r0 = evaluateRules(valueHoldings({ portfolio: files.portfolio, config: files.config, now: NOW }), files.config, NOW);

  await test('Modèle : schéma accepte montant inconnu (null), as_of, details', () => {
    pf.holdings[pf.holdings.length - 3].details = { echeance: '2030' };
    assert(validate(schemas.portfolio, pf).length === 0, JSON.stringify(validate(schemas.portfolio, pf).slice(0, 3)));
    assert(validate(schemas.config, cfg).length === 0, JSON.stringify(validate(schemas.config, cfg).slice(0, 3)));
  });

  await test('À compléter : jamais compté, jamais 0, signalé', () => {
    const r = rows.find((x) => x.id === 'to-fill');
    eq(r.to_fill, true, 'drapeau'); eq(r.value_base, null, 'pas de valeur'); eq(r.fx_missing, false, 'pas une erreur de change');
    const t = totals(rows), t0 = totals(r0);
    eq(t.to_fill, 1, 'compté comme à compléter');
    assert(reviewItems(rows, [], cfg, fmt).some((i) => i.target === 'to-fill' && i.kind === 'à compléter'), 'dans « À revoir »');
    eq(Math.round((t.value - t0.value) * 100), 100000, 'total = exemple + 1 000 € de réserve seulement');
  });

  await test('Enveloppes : hors patrimoine (bloqué) et hors allocation (réserve)', () => {
    const t = totals(rows);
    eq(t.outside, 5000, 'bloqué suivi à part');
    const alloc = groupBy(rows, (r) => r.h.envelope);
    assert(!alloc.some((g) => g.key === 'reserve' || g.key === 'locked'), 'absents des vues d’allocation');
    const tot = groupBy(rows, (r) => r.h.envelope, 'total');
    assert(tot.some((g) => g.key === 'reserve') && !tot.some((g) => g.key === 'locked'), 'réserve dans le total, pas le bloqué');
  });

  await test('Plafond en euros : 40 000 € max, 30 000 € cible', () => {
    const c = structuredClone(cfg);
    c.constraints = [{ id: 'm', type: 'share_cap', label: 'Métaux', group_by: 'asset_class', keys: ['metal'], max_amount: 40000, target_amount: 30000 }];
    const metals = groupBy(rows, (r) => r.h.asset_class).find((g) => g.key === 'metal').value;
    const [res] = evaluateConstraints(rows, pf, c);
    eq(Math.round(res.value), Math.round(metals), 'valeur de la poche');
    eq(res.state, metals > 40000 ? 'breach' : 'ok', 'état');
    eq(Math.round(res.headroom), Math.round(40000 - metals), 'marge');
    c.constraints[0].max_amount = 1000;
    eq(evaluateConstraints(rows, pf, c)[0].state, 'breach', 'dépassement en euros');
  });

  await test('Région par ISIN prioritaire sur le pays de l’ISIN', () => {
    const c = structuredClone(files.config);
    c.regions.by_isin = { FR0000000001: 'Asie' };
    eq(valueHoldings({ portfolio: files.portfolio, config: c, now: NOW }).find((x) => x.id === 'pea-exemple-industries').region, 'Asie', 'ISIN FR → Asie');
  });

  await test('Éditeur : lignes collées ajoutées / mises à jour par id, journalisées', () => {
    const frag = {
      envelopes: [{ id: 'coffre', label: 'Coffre' }],
      holdings: [
        { id: 'coffre-test', name: 'Pièce test', envelope: 'coffre', asset_class: 'metal', quantity: 10, unit_cost: null, currency: 'EUR', price_source: 'spot', metal: { code: 'XAG', weight: 31.1035, unit: 'g', purity: 0.999 }, as_of: '2026-11-25' },
        { id: 'livret-a', quantity: 13000, as_of: '2026-11-25' },
        { id: 'sans-date', name: 'X', envelope: 'livret', asset_class: 'account', quantity: 1, unit_cost: 1, currency: 'EUR', price_source: 'par' },
      ],
    };
    const r = mergeFragment(files, frag, 'claude', NOW);
    eq(r.added.join(), 'envelopes:coffre,coffre-test', 'ajouts'); eq(r.updated.join(), 'livret-a', 'mise à jour');
    assert(r.problems[0].includes('sans-date') && r.problems[0].includes('as_of'), 'as_of obligatoire');
    eq(r.files.portfolio.holdings.find((h) => h.id === 'livret-a').quantity, 13000, 'valeur mise à jour');
    eq(r.files.portfolio.revision, files.portfolio.revision + 1, 'révision portefeuille'); eq(r.files.config.revision, files.config.revision + 1, 'révision config');
    assert(r.files.portfolio.changelog.every((c) => c.author === 'claude'), 'auteur claude');
    for (const f of ['portfolio', 'config']) assert(validate(schemas[f], r.files[f]).length === 0, `${f} valide : ${JSON.stringify(validate(schemas[f], r.files[f]).slice(0, 2))}`);
    eq(files.portfolio.holdings.find((h) => h.id === 'livret-a').quantity, 12000, 'original intact');
  });
}
