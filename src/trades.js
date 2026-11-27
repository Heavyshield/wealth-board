// Trade discipline: buy / sell orders derived from the import journal (changelog entries noted "import …"),
// counted per month. No separate trade list: the journal already records every position change an import made.
//
// Rules:
//   - an import batch = entries with the same date + note; the FIRST batch of an envelope is the starting
//     portfolio, not trades;
//   - quantity change = 1 order (buy if up, sell if down); new line = 1 buy; removed line = 1 sell;
//   - ticker / cost-price changes are not orders;
//   - two orders on the same line between two imports show as one (the export only shows the net result):
//     import after each trading day for an exact count.
// Amount = quantity x the price of the export (stored on the journal entry since 2026-11-27; older entries: n/d).

import * as fmt from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Orders from the journal (pure, tested). Returns [{ date, month, envelope, target, name, side, qty, price?, amount? }]. */
export function deriveTrades(portfolio, { envelope = null } = {}) {
  const byId = new Map(portfolio.holdings.map((h) => [h.id, h]));
  const log = portfolio.changelog ?? [];
  const isImport = (c) => c.file !== 'config' && typeof c.note === 'string' && c.note.startsWith('import ');
  const envOf = (c) => byId.get(c.target)?.envelope ?? (c.old && typeof c.old === 'object' ? c.old.envelope : undefined);
  const nameOf = (c) => byId.get(c.target)?.name ?? (c.old && typeof c.old === 'object' ? c.old.name : c.target);
  // Quantity of a line when it was added = "old" of its first later quantity change, else today's quantity.
  const firstQty = (target, after) => {
    const next = log.find((c) => c.target === target && c.field === 'quantity' && c.date >= after);
    return next ? next.old : byId.get(target)?.quantity;
  };
  const seenEnv = new Set();
  const batches = new Map();
  for (const c of log) {
    if (!isImport(c)) continue;
    const key = `${c.date}|${c.note}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(c);
  }
  const out = [];
  for (const entries of batches.values()) {
    const env = entries.map(envOf).find(Boolean);
    const first = env && !seenEnv.has(env);
    if (env) seenEnv.add(env);
    if (first) continue; // starting portfolio, not orders
    if (envelope && env !== envelope) continue;
    for (const c of entries) {
      let side = null, qty = null;
      if (c.field === 'quantity' && typeof c.old === 'number' && typeof c.new === 'number' && c.new !== c.old) {
        side = c.new > c.old ? 'buy' : 'sell'; qty = Math.abs(c.new - c.old);
      } else if (c.field === 'holding' && c.new === 'ajout') {
        side = 'buy'; qty = firstQty(c.target, c.date);
      } else if (c.field === 'holding' && c.new === 'suppression') {
        side = 'sell'; qty = c.old?.quantity ?? null;
      }
      if (!side) continue;
      const price = typeof c.price === 'number' ? c.price : null;
      out.push({ date: c.date, month: c.date.slice(0, 7), envelope: env, target: c.target, name: nameOf(c), side, qty,
        price, amount: price !== null && typeof qty === 'number' ? qty * price : null });
    }
  }
  return out;
}

/** Per month, newest first: { month, count, buys, sells, amount (null if any amount unknown), trades }. */
export function monthlyTrades(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.month)) by.set(t.month, []);
    by.get(t.month).push(t);
  }
  return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, ts]) => ({
    month, count: ts.length, buys: ts.filter((t) => t.side === 'buy').length, sells: ts.filter((t) => t.side === 'sell').length,
    amount: ts.every((t) => t.amount !== null) ? ts.reduce((s, t) => s + t.amount, 0) : null, trades: ts,
  }));
}

const MONTH = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

export function renderTrades(el, portfolio, config, { onSelect } = {}) {
  const env = config.discipline?.envelope ?? 'pea';
  const limit = config.discipline?.max_trades_per_month;
  const months = monthlyTrades(deriveTrades(portfolio, { envelope: env }));
  const label = config.envelopes.find((e) => e.id === env)?.label ?? env;
  const nowMonth = new Date().toISOString().slice(0, 7);
  const cur = months.find((m) => m.month === nowMonth);
  const over = (n) => limit !== undefined && n > limit;
  el.innerHTML = `
    <header class="card-head"><div><h2>Ordres ${esc(label)} par mois</h2>
      <p class="sub-title">Ce mois-ci : <strong class="${over(cur?.count ?? 0) ? 'neg' : ''}">${cur?.count ?? 0} ordre(s)</strong>${limit !== undefined ? ` sur ${limit} maximum` : ''}
        · d’après vos imports Boursorama (importez après chaque séance où vous passez des ordres).</p></div></header>
    ${months.length ? `<table class="mini trades-month"><thead><tr><th>Mois</th><th class="num">Ordres</th><th class="num">Achats</th><th class="num">Ventes</th><th class="num">Montant</th></tr></thead>
      <tbody>${months.slice(0, 12).map((m) => `<tr${over(m.count) ? ' class="over"' : ''}>
        <td><details><summary>${esc(MONTH(m.month))}</summary><ul class="trade-list">${m.trades.map((t) => `<li>${fmt.date(t.date)} · ${t.side === 'buy' ? 'achat' : 'vente'}
          ${typeof t.qty === 'number' ? fmt.number(t.qty, 4) : '?'} <button type="button" class="linklike" data-target="${esc(t.target)}">${esc(t.name)}</button>${t.amount !== null ? ` · ${fmt.money(t.amount, config.base_currency, { digits: 0 })}` : ''}</li>`).join('')}</ul></details></td>
        <td class="num"><strong${over(m.count) ? ' class="neg"' : ''}>${m.count}</strong></td><td class="num">${m.buys}</td><td class="num">${m.sells}</td>
        <td class="num">${m.amount !== null ? fmt.money(m.amount, config.base_currency, { digits: 0 }) : '<span class="sub" title="Prix d’exécution non enregistré pour les imports avant le 27/11/2026">n/d</span>'}</td></tr>`).join('')}</tbody></table>`
      : '<p class="sub">Aucun ordre détecté pour l’instant (le premier import sert de point de départ).</p>'}`;
  el.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => onSelect?.(b.dataset.target)));
}
