// "Plus gros mouvements de la semaine" card: the 3 lines whose value moved most in euros over ~1 week
// (up or down), from live quotes only. Move = current quantity x (price now - close ~7 days ago), today's FX:
// it tracks the market move of what you hold, not deposits or trades.

import * as fmt from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

/** Lines with a weekly move, biggest absolute move first (pure, tested). */
export function topMoves(rows, n = 3) {
  return rows
    .filter((r) => typeof r.week_base === 'number' && r.week_base !== 0 && r.in_total !== false)
    .sort((a, b) => Math.abs(b.week_base) - Math.abs(a.week_base))
    .slice(0, n);
}

export function renderTopMoves(el, rows, config, { onSelect } = {}) {
  const base = config.base_currency;
  const top = topMoves(rows);
  const all = rows.filter((r) => typeof r.week_base === 'number' && r.in_total !== false);
  const net = all.reduce((s, r) => s + r.week_base, 0);
  el.innerHTML = `
    <header class="card-head"><div><h2>Plus gros mouvements de la semaine</h2>
      <p class="sub-title">${all.length
        ? `Variation en euros sur ~7 jours (quantité actuelle) · ${all.length} ligne(s) cotée(s) : <span class="${signCls(net)}">${fmt.signedMoney(net, base)}</span> au total`
        : 'Pas encore de données : actualisez les cours (proxy Yahoo à jour requis).'}</p></div></header>
    ${top.length ? `<table class="mini top-moves"><tbody>${top.map((r) => `<tr>
      <td><button type="button" class="linklike" data-target="${esc(r.id)}">${esc(r.h.name)}</button></td>
      <td class="num"><strong class="${signCls(r.week_base)}">${fmt.signedMoney(r.week_base, base)}</strong></td>
      <td class="num"><span class="${signCls(r.week_pct)}">${fmt.pct(r.week_pct)}</span></td></tr>`).join('')}</tbody></table>` : ''}`;
  el.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => onSelect?.(b.dataset.target)));
}
