// Trade discipline (src/trades.js): orders derived from the import journal. The scenario mirrors the
// pattern of a real day (25/11/2026: 6 orders over 3 imports) with FAKE lines.

import { deriveTrades, monthlyTrades } from '../src/trades.js';

export async function tradesTests({ test, assert, eq }) {
  const imp = (date, n) => ({ date, note: `import Boursorama — positions (CSV) (export-${n}.csv)`, author: 'user', file: 'portfolio' });
  const portfolio = {
    holdings: [
      { id: 'pea-alpha', name: 'ALPHA', envelope: 'pea', quantity: 29 },
      { id: 'pea-beta', name: 'BETA', envelope: 'pea', quantity: 168 },
      { id: 'pea-etf', name: 'ETF X', envelope: 'pea', quantity: 200 },
      { id: 'pea-new', name: 'NEW', envelope: 'pea', quantity: 40 },
      { id: 'cto-us', name: 'US', envelope: 'cto', quantity: 5 },
    ],
    changelog: [
      // first import = starting portfolio, not orders
      { ...imp('2026-11-25T10:37:40Z', 1), target: 'pea-alpha', field: 'holding', old: null, new: 'ajout' },
      { ...imp('2026-11-25T10:37:40Z', 1), target: 'pea-beta', field: 'holding', old: null, new: 'ajout' },
      // manual edits are never orders
      { date: '2026-11-25T11:00:00Z', file: 'portfolio', target: 'pea-beta', field: 'quantity', old: 260, new: 268, author: 'user' },
      { date: '2026-11-25T11:05:00Z', file: 'portfolio', target: 'pea-beta', field: 'ticker', old: null, new: 'BETA.PA', author: 'user' },
      // import 2: sell 100 BETA, buy 200 ETF X
      { ...imp('2026-11-25T13:42:05Z', 2), target: 'pea-etf', field: 'holding', old: null, new: 'ajout' },
      { ...imp('2026-11-25T13:42:05Z', 2), target: 'pea-beta', field: 'quantity', old: 268, new: 168 },
      // import 3: sell 24 ALPHA, buy 40 NEW (with the export price, recorded since 27/11)
      { ...imp('2026-11-25T14:23:28Z', 3), target: 'pea-new', field: 'holding', old: null, new: 'ajout', price: 29.5 },
      { ...imp('2026-11-25T14:23:28Z', 3), target: 'pea-alpha', field: 'quantity', old: 80, new: 56, price: 188 },
      { ...imp('2026-11-25T14:23:28Z', 3), target: 'pea-alpha', field: 'unit_cost', old: 169, new: 170 },
      // import 4: sell 27 ALPHA
      { ...imp('2026-11-25T15:01:11Z', 4), target: 'pea-alpha', field: 'quantity', old: 56, new: 29, price: 189 },
      // another month, a removed line
      { ...imp('2026-12-02T09:00:00Z', 5), target: 'pea-gone', field: 'holding', old: { id: 'pea-gone', name: 'GONE', envelope: 'pea', quantity: 10 }, new: 'suppression', price: 12 },
      // CTO: its own first import is a starting point
      { ...imp('2026-11-25T10:40:00Z', 6), target: 'cto-us', field: 'holding', old: null, new: 'ajout' },
    ],
  };

  await test('Ordres : déduits des imports (départ, modifications manuelles et coûts exclus)', () => {
    const t = deriveTrades(portfolio, { envelope: 'pea' });
    eq(t.map((x) => `${x.side} ${x.qty} ${x.name}`).join(' | '),
      'buy 200 ETF X | sell 100 BETA | buy 40 NEW | sell 24 ALPHA | sell 27 ALPHA | sell 10 GONE', 'ordres');
    eq(t.find((x) => x.name === 'NEW').amount, 40 * 29.5, 'montant = quantité x prix de l’export');
    eq(t.find((x) => x.name === 'BETA').amount, null, 'ancien import sans prix : montant n/d');
    eq(deriveTrades(portfolio, { envelope: 'cto' }).length, 0, 'premier import du CTO = point de départ');
  });

  await test('Ordres par mois : nombre, achats, ventes, montant', () => {
    const m = monthlyTrades(deriveTrades(portfolio, { envelope: 'pea' }));
    eq(m.map((x) => `${x.month}:${x.count}/${x.buys}/${x.sells}`).join(), '2026-12:1/0/1,2026-11:5/2/3', 'par mois, le plus récent d’abord');
    eq(m[0].amount, 120, 'décembre : montant connu'); eq(m[1].amount, null, 'novembre : un montant inconnu = n/d');
  });
}
