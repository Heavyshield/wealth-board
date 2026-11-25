// Stage g, pure functions: daily snapshot for history.json, and the "Export pour Claude" summary
// (Markdown for reading + a compact JSON block for exact numbers). No DOM.

import { totals, groupBy } from './valuation.js';

const round2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const pct1 = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1).replace('.', ',')} %`);
const eur = (x, cur) => (x === null || x === undefined ? '—' : `${Math.round(x).toLocaleString('fr-FR').replace(/ | /g, ' ')} ${cur === 'EUR' ? '€' : cur}`);

const KEYS = {
  envelope: (r) => r.h.envelope, asset_class: (r) => r.h.asset_class, currency: (r) => r.h.currency, region: (r) => r.region,
};
const breakdown = (rows, key) => Object.fromEntries(groupBy(rows, KEYS[key], 'total').map((g) => [g.key, round2(g.value)]));

/** Today's snapshot from valued rows. date = local calendar day. */
export function makeSnapshot(rows, config, now = new Date()) {
  const t = totals(rows);
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  return {
    date: d, base_currency: config.base_currency, total: round2(t.value), cost: round2(t.cost),
    by_envelope: breakdown(rows, 'envelope'), by_asset_class: breakdown(rows, 'asset_class'), by_currency: breakdown(rows, 'currency'),
    live_share: Math.round((t.by_status_share.live ?? 0) * 1000) / 1000,
  };
}

/** Add (or replace same-day) snapshot. Returns { history: NEW history (revision+1), replaced: bool }. */
export function addSnapshot(history, snap, now = new Date()) {
  const next = structuredClone(history);
  const i = next.snapshots.findIndex((s) => s.date === snap.date);
  if (i >= 0) next.snapshots[i] = snap; else next.snapshots.push(snap);
  next.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  next.revision = history.revision + 1;
  next.updated_at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (next.sample_data) next.sample_data = false;
  return { history: next, replaced: i >= 0 };
}

/**
 * Markdown + JSON summary to paste into a Claude conversation.
 * input: { rows, files: {portfolio, config, history}, constraints, review, now, refreshedAt }
 */
export function buildClaudeExport({ rows, files, constraints = [], review = [], now = new Date(), refreshedAt = null }) {
  const { portfolio, config, history } = files;
  const base = config.base_currency;
  const t = totals(rows);
  const label = Object.fromEntries([...config.envelopes, ...config.asset_classes].map((x) => [x.id, x.label]));
  const lines = [];
  const L = (s = '') => lines.push(s);

  L(`# Wealth Board — résumé du ${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
  L(`Données personnelles, à ne pas partager. Outil de suivi, pas un conseil en investissement.`);
  L(`Portefeuille rév. ${portfolio.revision}${portfolio.sample_data ? ' (DONNÉES D’EXEMPLE)' : ''} · cours vérifiés : ${refreshedAt ? new Date(refreshedAt).toLocaleString('fr-FR') : 'non (prix du fichier)'}`);
  L();
  L('## Synthèse');
  L(`- Patrimoine : **${eur(t.value, base)}** · investi ${eur(t.cost, base)} · +/- latente ${eur(t.pnl, base)} (${pct1(t.cost ? t.pnl / t.cost : null)})`);
  if (t.outside) L(`- Hors patrimoine (suivi seulement) : ${eur(t.outside, base)}`);
  if (t.to_fill) L(`- Lignes au montant inconnu (à compléter, non comptées) : ${t.to_fill}`);
  L(`- Variation du jour : ${t.day === null ? 'indisponible' : `${eur(t.day, base)} (sur ${pct1(t.day_coverage)} de la valeur)`}`);
  L(`- Fraîcheur des prix (part de la valeur) : ${Object.entries(t.by_status_share).map(([k, v]) => `${k} ${pct1(v)}`).join(', ')}`);
  const last = history.snapshots.at(-1);
  if (last) L(`- Dernier relevé : ${last.date} = ${eur(last.total, base)} (écart ${eur(t.value - last.total, base)})`);
  L();
  L('## Répartition');
  for (const [key, title] of [['envelope', 'Enveloppe'], ['asset_class', 'Classe'], ['currency', 'Devise'], ['region', 'Région']]) {
    L(`- ${title} : ${groupBy(rows, KEYS[key]).map((g) => `${label[g.key] ?? g.key} ${pct1(g.share)}`).join(' · ')}`);
  }
  const tg = config.allocation_targets;
  if (tg) {
    const cur = Object.fromEntries(groupBy(rows, KEYS[tg.group_by]).map((g) => [g.key, g.share]));
    L(`- Cibles (${tg.group_by}, tolérance ${pct1(tg.tolerance ?? 0)}) : ${Object.entries(tg.weights).map(([k, w]) => `${label[k] ?? k} ${pct1(cur[k] ?? 0)} / cible ${pct1(w)}`).join(' · ')}`);
  }
  L();
  L('## À revoir');
  if (!review.length) L('- Rien à signaler.');
  for (const i of review) L(`- [${{ 3: 'critique', 2: 'à surveiller', 1: 'info' }[i.severity]}] ${i.title} — ${i.detail}`);
  if (constraints.length) {
    L();
    L('## Contraintes');
    for (const c of constraints) L(`- ${c.label} : ${c.state}${c.type === 'share_cap' ? ` (${pct1(c.share)})` : c.type === 'runway' ? ` (${c.months?.toFixed(1)} mois)` : ''}`);
  }
  const changes = (portfolio.changelog ?? []).slice(-15).reverse();
  L();
  L('## Dernières modifications');
  if (!changes.length) L('- Aucune.');
  for (const c of changes) L(`- ${c.date} · ${c.author} · ${c.target}.${c.field} : ${short(c.old)} → ${short(c.new)}${c.note ? ` (${c.note})` : ''}`);
  L();
  L('## Lignes (JSON)');
  const compact = {
    as_of: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), base_currency: base, portfolio_revision: portfolio.revision,
    total: round2(t.value), cost: round2(t.cost),
    holdings: rows.map((r) => ({
      id: r.id, name: r.h.name, envelope: r.h.envelope, class: r.h.asset_class, ccy: r.h.currency, ticker: r.h.ticker, isin: r.h.isin,
      qty: r.h.quantity, unit_cost: r.h.unit_cost, as_of: r.h.as_of, to_fill: r.to_fill || undefined,
      in_net_worth: r.in_total === false ? false : undefined, in_allocation: r.in_alloc === false && r.in_total !== false ? false : undefined, price: round2(r.price.value), price_ccy: r.price.currency,
      price_status: r.price.status, price_as_of: r.price.as_of, value: round2(r.value_base), pnl: round2(r.pnl_base),
      rules: r.rules?.status === 'na' ? undefined : r.rules?.status, metrics: r.h.metrics,
    })),
  };
  L('```json');
  L(JSON.stringify(compact));
  L('```');
  L();
  L(`Pour modifier les données : éditer wealth-board.json sur Drive (partie concernée), incrémenter "revision", mettre à jour "updated_at" et ajouter une entrée "changelog" avec "author": "claude".`);
  return lines.join('\n');
}

function short(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : (v.name ?? v.id ?? '{…}');
  return String(v);
}
