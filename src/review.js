// UI for stage c: "À revoir" panel and constraint meters. Logic lives in rules.js.
// Status colors (good / warning / critical) are reserved for state and always come with an icon + label.

import * as fmt from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SEVERITY = {
  3: { icon: '⛔', label: 'Critique', cls: 'crit' },
  2: { icon: '⚠', label: 'À surveiller', cls: 'warn' },
  1: { icon: 'ℹ', label: 'Info', cls: 'info' },
};
const STATE = {
  ok: { icon: '✓', label: 'OK', cls: 'good' },
  warn: { icon: '⚠', label: 'À surveiller', cls: 'warn' },
  breach: { icon: '⛔', label: 'Dépassé', cls: 'crit' },
  missing: { icon: '?', label: 'Non renseigné', cls: 'info' },
};

export function renderReview(el, items, { onSelect } = {}) {
  const counts = [3, 2, 1].map((s) => items.filter((i) => i.severity === s).length);
  const LIMIT = 8;
  el.innerHTML = `
    <header class="card-head"><div><h2>À revoir</h2>
      <p class="sub-title">${items.length ? `${counts[0]} critique(s) · ${counts[1]} à surveiller · ${counts[2]} info — triés par gravité puis montant en jeu` : 'Rien à signaler.'}</p></div></header>
    ${items.length ? `<ol class="review-list">${items.map((i, n) => `
      <li class="sev-${SEVERITY[i.severity].cls}"${n >= LIMIT ? ' data-extra hidden' : ''}>
        <span class="sev" title="${SEVERITY[i.severity].label}"><span aria-hidden="true">${SEVERITY[i.severity].icon}</span><span class="sr-only">${SEVERITY[i.severity].label}</span></span>
        <button type="button" class="linklike" data-target="${esc(i.target)}">${esc(i.title)}</button>
        <span class="kind">${esc(i.kind)}</span>
        <span class="detail">${esc(i.detail)}</span>
      </li>`).join('')}</ol>
      ${items.length > LIMIT ? `<button type="button" data-more>Afficher les ${items.length - LIMIT} autres</button>` : ''}` : ''}`;
  el.querySelector('[data-more]')?.addEventListener('click', (e) => {
    el.querySelectorAll('[data-extra]').forEach((li) => { li.hidden = false; });
    e.target.remove();
  });
  el.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => onSelect?.(b.dataset.target)));
}

function meter(ratio, cls, markers = []) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return `<div class="meter meter-${cls}"><span class="meter-fill" style="width:${pct}%"></span>${markers.map((m) => `<span class="meter-mark" style="left:${Math.min(100, m.at * 100)}%" title="${esc(m.label)}"></span>`).join('')}</div>`;
}

export function renderConstraints(el, results, { onEditAccount } = {}) {
  if (!results.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = results.map((c) => {
    const s = STATE[c.state];
    const badge = `<span class="state state-${s.cls}"><span aria-hidden="true">${s.icon}</span> ${s.label}</span>`;
    let body = `<p class="kpi-sub">${esc(c.note ?? '')}</p>`;
    if (c.type === 'contribution_ceiling' && c.state !== 'missing') {
      body = `<span class="tile-value">${fmt.money(c.value, c.base, { digits: 0 })}</span>
        <span class="kpi-sub">versés sur ${fmt.money(c.limit, c.base, { digits: 0 })} · reste ${fmt.money(c.remaining, c.base, { digits: 0 })}</span>
        ${meter(c.ratio, s.cls)}
        <span class="kpi-sub">Valeur actuelle de l'enveloppe : ${fmt.money(c.envelope_value, c.base, { digits: 0 })} · versements au ${fmt.date(c.as_of)}</span>`;
    }
    if (c.type === 'share_cap') {
      // Scale: 0 .. 125 % of the cap, with marks at min and max.
      const scale = (c.max ?? c.share) * 1.25;
      const marks = [];
      if (c.min !== undefined) marks.push({ at: c.min / scale, label: `minimum ${fmt.pct(c.min, { signed: false })}` });
      if (c.max !== undefined) marks.push({ at: c.max / scale, label: `plafond ${fmt.pct(c.max, { signed: false })}` });
      body = `<span class="tile-value">${fmt.pct(c.share, { signed: false })}</span>
        <span class="kpi-sub">${fmt.money(c.value, c.base, { digits: 0 })} · ${c.min !== undefined ? `min ${fmt.pct(c.min, { signed: false })} · ` : ''}${c.max !== undefined ? `plafond ${fmt.pct(c.max, { signed: false })}` : ''}</span>
        ${meter(c.share / scale, s.cls, marks)}
        ${c.headroom !== null ? `<span class="kpi-sub">${c.headroom >= 0 ? `Marge avant plafond : ${fmt.money(c.headroom, c.base, { digits: 0 })}` : `Au-dessus du plafond de ${fmt.money(-c.headroom, c.base, { digits: 0 })}`}</span>` : ''}`;
    }
    if (c.type === 'runway') {
      body = `<span class="tile-value">${fmt.number(c.months, 1)} mois</span>
        <span class="kpi-sub">${fmt.money(c.value, c.base, { digits: 0 })} disponibles · objectif ${c.target_months} mois × ${fmt.money(c.monthly_budget, c.base, { digits: 0 })}</span>
        ${(() => { const scale = Math.max(1.25, c.ratio * 1.05); return meter(c.ratio / scale, s.cls, [{ at: 1 / scale, label: 'objectif' }]); })()}
        <span class="kpi-sub">${c.value >= c.need ? `Excédent : ${fmt.money(c.value - c.need, c.base, { digits: 0 })}` : `Manque : ${fmt.money(c.need - c.value, c.base, { digits: 0 })}`}</span>`;
    }
    const edit = c.type === 'contribution_ceiling' ? `<button type="button" class="linklike small" data-edit-account="${esc(c.envelope)}">Modifier les versements</button>` : '';
    return `<article class="tile constraint" id="constraint-${esc(c.id)}"><div class="constraint-head"><span class="kpi-label">${esc(c.label)}</span>${badge}</div>${body}${edit}</article>`;
  }).join('');
  el.querySelectorAll('[data-edit-account]').forEach((b) => b.addEventListener('click', () => onEditAccount?.(b.dataset.editAccount)));
}
