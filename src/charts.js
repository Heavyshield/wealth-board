// KPIs + charts (Chart.js, loaded as a pinned classic script -> window.Chart).
// Every chart has a data table next to or under it, so nothing depends on hover or color alone.
// Colors: categorical palette from config.charts.palette (light/dark), assigned by a stable
// entity order (config order for envelopes / classes, alphabetical otherwise), never by rank.

import * as fmt from './format.js';
import { totals, groupBy } from './valuation.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => css('color-scheme') === 'dark';

export const GROUPINGS = {
  envelope: { label: 'Enveloppe', key: (r) => r.h.envelope },
  asset_class: { label: 'Classe', key: (r) => r.h.asset_class },
  currency: { label: 'Devise', key: (r) => r.h.currency },
  region: { label: 'Région', key: (r) => r.region },
};

const charts = {}; // id -> Chart instance

function destroy(id) { charts[id]?.destroy(); delete charts[id]; }

/** Labels + stable order for a grouping. */
function groupMeta(grouping, rows, config) {
  if (grouping === 'envelope') return { order: config.envelopes.map((e) => e.id), label: Object.fromEntries(config.envelopes.map((e) => [e.id, e.label])) };
  if (grouping === 'asset_class') return { order: config.asset_classes.map((c) => c.id), label: Object.fromEntries(config.asset_classes.map((c) => [c.id, c.label])) };
  const keys = [...new Set(rows.map(GROUPINGS[grouping].key))].sort((a, b) => a.localeCompare(b, 'fr'));
  return { order: keys, label: Object.fromEntries(keys.map((k) => [k, k])) };
}

function palette(config) {
  return config.charts?.palette?.[isDark() ? 'dark' : 'light'] ?? ['#2a78d6'];
}

function baseOptions() {
  const ink = css('--muted'), grid = css('--grid');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text'), borderColor: css('--border'), borderWidth: 1, padding: 10, boxPadding: 4 } },
    scales: {},
    _ink: ink, _grid: grid,
  };
}

function axis(opts, { money, base, stacked = false } = {}) {
  return {
    stacked,
    grid: { color: opts._grid, lineWidth: 1, drawTicks: false },
    border: { color: css('--axis') },
    // Only override the tick callback when needed: `callback: undefined` breaks category labels.
    ticks: { color: opts._ink, padding: 6, ...(money ? { callback: (v) => fmt.compactMoney(v, base) } : {}) },
  };
}

// ---------------------------------------------------------------- KPIs

/** Change in % of the starting value of the lines it covers (balances included at 0). */
export function changePct(change, coverage, value) {
  const covered = coverage * value;
  return change === null || covered - change <= 0 ? null : change / (covered - change);
}

export function renderKpis(el, rows, config, history) {
  const t = totals(rows);
  const base = config.base_currency;
  const last = history?.snapshots?.at(-1);
  const sinceLast = last ? t.value - last.total : null;
  const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const share = t.by_status_share;
  const statuses = { live: 'à jour', stale: 'périmé', manual: 'manuel', balance: 'solde', missing: 'absent' };
  const segs = Object.entries(statuses).filter(([k]) => share[k]);

  el.innerHTML = `
    <div class="hero">
      <span class="kpi-label">Patrimoine total</span>
      <span class="hero-value">${fmt.money(t.value, base, { digits: 0 })}</span>
      ${sinceLast !== null ? `<span class="kpi-sub"><span class="${sign(sinceLast)}">${fmt.signedMoney(sinceLast, base)}</span> depuis le relevé du ${fmt.date(last.date)}</span>` : ''}
    </div>
    <div class="tile">
      <span class="kpi-label">+/- value latente</span>
      <span class="tile-value ${sign(t.pnl)}">${fmt.signedMoney(t.pnl, base)} <span class="tile-pct">${fmt.pct(t.cost ? t.pnl / t.cost : null)}</span></span>
      <span class="kpi-sub">sur ${fmt.money(t.cost, base, { digits: 0 })} investis</span>
    </div>
    <div class="tile">
      <span class="kpi-label">Variation de la semaine</span>
      ${t.week === null
        ? '<span class="tile-value muted">indisponible</span><span class="kpi-sub">aucun cours avec une clôture d’il y a ~7 jours (actualiser les cours)</span>'
        : `<span class="tile-value ${sign(t.week)}">${fmt.signedMoney(t.week, base)} <span class="tile-pct" title="Par rapport à la valeur d’il y a ~7 jours des lignes comptées">${fmt.pct(changePct(t.week, t.week_coverage, t.value))}</span></span>
           <span class="kpi-sub" title="Quantités actuelles × variation des cours sur ~7 jours. Comptent : les soldes (comptes, cash : 0 €) et les lignes avec un cours à jour (actions, ETF, métaux). Aujourd’hui : ${t.day === null ? 'n/d' : fmt.signedMoney(t.day, base)}">calculée sur ${fmt.pct(t.week_coverage, { signed: false })} de la valeur</span>`}
    </div>
    <div class="tile freshness">
      <span class="kpi-label">Fraîcheur des prix (part de la valeur)</span>
      <div class="strip" role="img" aria-label="${segs.map(([k, l]) => `${l} ${fmt.pct(share[k], { signed: false })}`).join(', ')}">
        ${segs.map(([k]) => `<span class="seg seg-${k}" style="flex:${share[k]}"></span>`).join('')}
      </div>
      <ul class="legend">${segs.map(([k, l]) => `<li><span class="dot seg-${k}"></span>${l} ${fmt.pct(share[k], { signed: false })}</li>`).join('')}</ul>
      ${t.missing_fx ? `<p class="warn">⚠ ${t.missing_fx} ligne(s) exclue(s) : taux de change manquant.</p>` : ''}
      ${t.to_fill ? `<p class="kpi-sub">${t.to_fill} ligne(s) au montant inconnu, non comptée(s) (à compléter).</p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- Allocation (donut + table)

export function renderAllocation(el, rows, config, grouping) {
  const base = config.base_currency;
  const meta = groupMeta(grouping, rows, config);
  const groups = groupBy(rows, GROUPINGS[grouping].key);
  const max = config.charts?.max_slices ?? 7;
  let shown = groups;
  if (groups.length > max) {
    const rest = groups.slice(max - 1);
    shown = [...groups.slice(0, max - 1), { key: '__other', value: rest.reduce((a, g) => a + g.value, 0), share: rest.reduce((a, g) => a + g.share, 0) }];
  }
  const pal = palette(config);
  const stableIdx = (k) => meta.order.indexOf(k);
  const ordered = shown.filter((g) => g.key !== '__other').sort((a, b) => stableIdx(a.key) - stableIdx(b.key));
  const color = Object.fromEntries(ordered.map((g, i) => [g.key, pal[i % pal.length]]));
  color.__other = css('--muted');
  const label = (k) => (k === '__other' ? 'Autres' : meta.label[k] ?? k);

  el.querySelector('.alloc-table').innerHTML = `
    <table class="mini"><caption class="sr-only">Répartition par ${GROUPINGS[grouping].label.toLowerCase()}</caption>
      <thead><tr><th scope="col">${GROUPINGS[grouping].label}</th><th scope="col" class="num">Valeur</th><th scope="col" class="num">Part</th></tr></thead>
      <tbody>${shown.map((g) => `<tr><td><span class="swatch" style="background:${color[g.key]}"></span>${esc(label(g.key))}</td><td class="num">${fmt.money(g.value, base, { digits: 0 })}</td><td class="num">${fmt.pct(g.share, { signed: false })}</td></tr>`).join('')}</tbody>
    </table>`;

  destroy('alloc');
  if (!window.Chart) return;
  const opts = baseOptions();
  opts.cutout = '62%';
  opts.plugins.tooltip.callbacks = { label: (c) => ` ${label(shown[c.dataIndex].key)} : ${fmt.money(shown[c.dataIndex].value, base, { digits: 0 })} (${fmt.pct(shown[c.dataIndex].share, { signed: false })})` };
  charts.alloc = new Chart(el.querySelector('canvas'), {
    type: 'doughnut',
    data: { labels: shown.map((g) => label(g.key)), datasets: [{ data: shown.map((g) => g.value), backgroundColor: shown.map((g) => color[g.key]), borderColor: css('--surface'), borderWidth: 2, hoverOffset: 6 }] },
    options: opts,
  });
}

// ---------------------------------------------------------------- Net worth over time

export function renderHistory(el, history, config, rows) {
  const base = config.base_currency;
  const snaps = history?.snapshots ?? [];
  const canvasBox = el.querySelector('.chart-box');
  const tableBox = el.querySelector('.data-table');
  destroy('history');
  tableBox.innerHTML = !snaps.length ? '' : `<table class="mini"><thead><tr><th scope="col">Date</th><th scope="col" class="num">Patrimoine</th><th scope="col" class="num">Investi</th></tr></thead>
    <tbody>${snaps.map((s) => `<tr><td>${fmt.date(s.date)}</td><td class="num">${fmt.money(s.total, base, { digits: 0 })}</td><td class="num">${s.cost !== undefined ? fmt.money(s.cost, base, { digits: 0 }) : '—'}</td></tr>`).join('')}</tbody></table>`;
  if (snaps.length < 2) {
    canvasBox.innerHTML = snaps.length
      ? `<p class="empty-chart">1 relevé (${fmt.date(snaps[0].date)} : ${fmt.money(snaps[0].total, base, { digits: 0 })}). La courbe apparaît au 2e relevé, pris un autre jour à l’enregistrement.</p>`
      : '<p class="empty-chart">Aucun relevé : le premier est pris au prochain « Enregistrer » (Données).</p>';
    return;
  }
  if (!canvasBox.querySelector('canvas')) canvasBox.innerHTML = '<canvas aria-label="Évolution du patrimoine"></canvas>';
  if (!window.Chart) return;

  const pal = palette(config);
  const opts = baseOptions();
  // Short history: one label per day; beyond ~3 months: month labels.
  const spanDays = (new Date(snaps.at(-1).date) - new Date(snaps[0].date)) / 864e5;
  const labels = snaps.map((s) => (spanDays < 90 ? fmt.date(s.date) : fmt.monthLabel(s.date)));
  opts.interaction = { mode: 'index', intersect: false };
  opts.scales = { x: axis(opts), y: axis(opts, { money: true, base }) };
  opts.scales.x.grid.display = false;
  opts.plugins.tooltip.callbacks = { title: (c) => fmt.date(snaps[c[0].dataIndex].date), label: (c) => ` ${c.dataset.label} : ${fmt.money(c.parsed.y, base, { digits: 0 })}` };
  const hasCost = snaps.some((s) => s.cost !== undefined);
  el.querySelector('.legend-inline').hidden = !hasCost;
  el.querySelector('.key-total').style.background = pal[0];
  const surface = css('--surface');
  charts.history = new Chart(canvasBox.querySelector('canvas'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Patrimoine', data: snaps.map((s) => s.total), borderColor: pal[0], backgroundColor: pal[0] + '1a', fill: 'origin', borderWidth: 2, pointRadius: (c) => (c.dataIndex === snaps.length - 1 ? 5 : 0), pointBackgroundColor: pal[0], pointBorderColor: surface, pointBorderWidth: 2, pointHoverRadius: 5, tension: 0 },
        ...(hasCost ? [{ label: 'Investi', data: snaps.map((s) => s.cost ?? null), borderColor: css('--muted'), borderWidth: 2, borderDash: [], pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0 }] : []),
      ],
    },
    options: { ...opts, scales: { ...opts.scales, y: { ...opts.scales.y, beginAtZero: false } } },
  });
}

// ---------------------------------------------------------------- Current vs target

export function renderTargets(el, rows, config) {
  const t = config.allocation_targets;
  const base = config.base_currency;
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const meta = groupMeta(t.group_by, rows, config);
  const cur = Object.fromEntries(groupBy(rows, GROUPINGS[t.group_by].key).map((g) => [g.key, g]));
  const keys = [...new Set([...meta.order.filter((k) => t.weights[k] !== undefined || cur[k]), ...Object.keys(t.weights)])];
  const tol = t.tolerance ?? 0;
  const data = keys.map((k) => {
    const actual = cur[k]?.share ?? 0, target = t.weights[k] ?? 0;
    return { k, label: meta.label[k] ?? k, actual, target, gap: actual - target, off: Math.abs(actual - target) > tol, value: cur[k]?.value ?? 0 };
  });
  const total = totals(rows).value;
  el.querySelector('.sub-title').textContent = `Par ${GROUPINGS[t.group_by].label.toLowerCase()} · tolérance ± ${fmt.number(tol * 100, 1)} pts`;
  el.querySelector('.data-table').innerHTML = `<table class="mini"><thead><tr><th scope="col">${GROUPINGS[t.group_by].label}</th><th scope="col" class="num">Actuel</th><th scope="col" class="num">Cible</th><th scope="col" class="num">Écart</th><th scope="col" class="num">Écart en €</th></tr></thead>
    <tbody>${data.map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${fmt.pct(d.actual, { signed: false })}</td><td class="num">${fmt.pct(d.target, { signed: false })}</td>
      <td class="num">${d.off ? '<span class="flag" title="Hors tolérance">⚠<span class="flag-text"> hors tolérance</span></span> ' : ''}${fmt.signedNumber(d.gap * 100, 1)} pts</td>
      <td class="num">${fmt.signedMoney((d.actual - d.target) * total, base)}</td></tr>`).join('')}</tbody></table>`;

  destroy('targets');
  if (!window.Chart) return;
  const pal = palette(config);
  const opts = baseOptions();
  opts.indexAxis = 'y';
  opts.scales = { x: axis(opts), y: axis(opts) };
  opts.scales.x.ticks.callback = (v) => fmt.pct(v, { signed: false, digits: 0 });
  opts.scales.y.grid.display = false;
  opts.plugins.tooltip.callbacks = { label: (c) => ` ${c.dataset.label} : ${fmt.pct(c.parsed.x, { signed: false })}` };
  el.querySelector('.key-actual').style.background = pal[0];
  const box = el.querySelector('.chart-box');
  box.style.height = `${data.length * 52 + 40}px`;
  charts.targets = new Chart(box.querySelector('canvas'), {
    type: 'bar',
    data: {
      labels: data.map((d) => d.label),
      datasets: [
        { label: 'Actuel', data: data.map((d) => d.actual), backgroundColor: pal[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 16, categoryPercentage: 0.8, barPercentage: 0.9 },
        { label: 'Cible', data: data.map((d) => d.target), backgroundColor: css('--muted'), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 16, categoryPercentage: 0.8, barPercentage: 0.9 },
      ],
    },
    options: opts,
  });
}

// ---------------------------------------------------------------- P&L per line

export function renderPnl(el, rows, config) {
  const base = config.base_currency;
  const data = rows.filter((r) => r.pricing !== 'par' && r.pnl_base !== null).sort((a, b) => b.pnl_base - a.pnl_base);
  el.querySelector('.data-table').innerHTML = `<table class="mini"><thead><tr><th scope="col">Ligne</th><th scope="col" class="num">+/- value</th><th scope="col" class="num">%</th><th scope="col" class="num">dont change</th></tr></thead>
    <tbody>${data.map((r) => `<tr><td>${esc(r.h.name)}</td><td class="num">${fmt.signedMoney(r.pnl_base, base)}</td><td class="num">${fmt.pct(r.pnl_pct)}</td><td class="num">${r.h.currency === base ? '—' : fmt.signedMoney(r.pnl_fx_base, base)}</td></tr>`).join('')}</tbody></table>`;
  destroy('pnl');
  if (!window.Chart) return;
  const gain = css('--div-pos'), loss = css('--div-neg');
  const opts = baseOptions();
  opts.indexAxis = 'y';
  opts.scales = { x: axis(opts, { money: true, base }), y: axis(opts) };
  opts.scales.y.grid.display = false;
  opts.scales.y.ticks.callback = (_, i) => { const n = data[i].h.name; return n.length > 26 ? n.slice(0, 25) + '…' : n; };
  opts.plugins.tooltip.callbacks = {
    title: (c) => data[c[0].dataIndex].h.name,
    label: (c) => { const r = data[c.dataIndex]; return ` ${fmt.signedMoney(r.pnl_base, base)} (${fmt.pct(r.pnl_pct)})`; },
  };
  el.querySelector('.key-gain').style.background = gain;
  el.querySelector('.key-loss').style.background = loss;
  const box = el.querySelector('.chart-box');
  box.style.height = `${data.length * 30 + 40}px`;
  charts.pnl = new Chart(box.querySelector('canvas'), {
    type: 'bar',
    data: { labels: data.map((r) => r.h.name), datasets: [{ label: '+/- value', data: data.map((r) => r.pnl_base), backgroundColor: data.map((r) => (r.pnl_base >= 0 ? gain : loss)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 18 }] },
    options: opts,
  });
}

export function chartsAvailable() { return Boolean(window.Chart); }

export function configureChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 12;
}
