// "Actions par PER" card: direct stocks only (asset class equity), lowest PER first.
// Order: positive PER ascending, then negative PER (loss-making, fails the rule), then n/d.
// Ratio cells reuse the holdings table rendering (same rule colors and tooltips).

import * as fmt from './format.js';
import { RATIOS, ratioCell } from './table.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Stock rows ranked by PER (pure, tested). */
export function rankByPer(rows) {
  const per = (r) => r.h.metrics?.per;
  const group = (r) => { const v = per(r); return typeof v !== 'number' ? 2 : v < 0 ? 1 : 0; };
  return rows
    .filter((r) => r.h.asset_class === 'equity')
    .sort((a, b) => group(a) - group(b) || (group(a) < 2 ? per(a) - per(b) : 0) || (b.value_base ?? 0) - (a.value_base ?? 0));
}

export function renderPerRank(el, rows, config, { onSelect } = {}) {
  const ranked = rankByPer(rows);
  const base = config.base_currency;
  const nd = ranked.filter((r) => typeof r.h.metrics?.per !== 'number').length;
  el.innerHTML = `
    <header class="card-head"><div><h2>Actions par PER</h2>
      <p class="sub-title">${ranked.length ? `${ranked.length} action(s), PER le plus bas en premier${nd ? ` · ${nd} sans PER (ticker manquant ou ratios à récupérer)` : ''}` : 'Aucune action en direct.'}</p></div></header>
    ${ranked.length ? `<table class="mini per-rank"><thead><tr><th>#</th><th>Ligne</th>${RATIOS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Valeur</th></tr></thead>
      <tbody>${ranked.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td><button type="button" class="linklike" data-target="${esc(r.id)}">${esc(r.h.name)}</button></td>
        ${RATIOS.map(([k, l]) => `<td class="num">${ratioCell(r, k, l)}</td>`).join('')}
        <td class="num">${fmt.money(r.value_base, base)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  el.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => onSelect?.(b.dataset.target)));
}
