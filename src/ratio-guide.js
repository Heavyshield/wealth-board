// "Mes ratios" card: the user's thresholds per ratio, read from config.rules (nothing hard-coded but the
// plain-language explanation shown on mouse-over / focus).

import * as fmt from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const RATIO_HELP = {
  per: {
    name: 'PER',
    long: 'Price / Earnings Ratio',
    help: 'Cours ÷ bénéfice par action : combien d’années de bénéfice actuel le prix représente. Bas = action bon marché par rapport à ses bénéfices ; négatif = entreprise en perte.',
  },
  pcf: {
    name: 'P/CF',
    long: 'Cours / flux de trésorerie d’exploitation',
    help: 'Capitalisation ÷ cash généré par l’activité sur un an. Plus difficile à embellir que le bénéfice comptable : bas = beaucoup de cash réel pour le prix payé.',
  },
  net_debt_ebitda: {
    name: 'DN/EBITDA',
    long: 'Dette nette / EBITDA',
    help: 'Dette moins trésorerie, divisée par le résultat d’exploitation avant amortissements : nombre d’années de résultat pour rembourser la dette. Négatif = plus de cash que de dette. Loyers (leasing) à inclure ; Yahoo ne les compte pas toujours.',
  },
};

const OP = { '<=': '≤', '>=': '≥', '<': '<', '>': '>' };

/** Thresholds per ratio from config.rules, most severe last (pure). */
export function ratioThresholds(config) {
  const items = config.rules?.items ?? [];
  return Object.keys(RATIO_HELP).map((metric) => ({
    metric,
    rules: items.filter((r) => r.metric === metric)
      .sort((a, b) => (a.severity === 'critical') - (b.severity === 'critical') || a.value - b.value),
  }));
}

export function renderRatioGuide(el, config) {
  const rows = ratioThresholds(config);
  el.innerHTML = `
    <header class="card-head"><div><h2>Mes ratios</h2>
      <p class="sub-title">Seuils de vos règles (actions). Survolez un ratio pour son explication.</p></div></header>
    <table class="mini ratio-guide"><tbody>${rows.map(({ metric, rules }) => {
      const h = RATIO_HELP[metric];
      const tip = `${h.long} — ${h.help}`;
      const limits = rules.length
        ? rules.map((r) => `<span title="${esc(r.why ?? r.label)}">${r.severity === 'critical' ? '⛔' : '⚠'} ${OP[r.op] ?? esc(r.op)} ${fmt.number(r.value, 2)}${r.require_positive ? ' (et > 0)' : ''}</span>`).join(' · ')
        : '<span class="sub">aucune règle</span>';
      return `<tr><th scope="row"><span class="ratio-name" tabindex="0" title="${esc(tip)}">${esc(h.name)}</span>
        <span class="sub">${esc(h.long)}</span></th><td>${limits}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="sub">⚠ au-dessus du seuil : à surveiller · ⛔ zone dangereuse : réduction progressive. Ratio introuvable = n/d, pas une alerte.</p>`;
}
