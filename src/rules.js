// Rules engine + constraint widgets + "à revoir" list. Pure functions, no DOM.
// Everything is driven by config.rules / config.constraints / config.allocation_targets:
// adding or changing a rule never needs code.
//
// Rule status per holding (worst wins):
//   breach     - at least one rule fails (incl. a non-positive value where require_positive)
//   incomplete - a metric needed by a rule is missing (never guessed)
//   stale      - all rules pass but metrics.as_of is older than rules.metrics_max_age_days
//   ok         - all rules pass on recent metrics
//   na         - no rule applies to this line (ETF, cash, metals...)

import { groupBy, totals } from './valuation.js';

const SHORT = { per: 'PER', pcf: 'P/CF', net_debt_ebitda: 'DN/EBITDA' };
const metricText = (res) => SHORT[res.rule.metric] ?? res.rule.metric;

const OPS = { '<=': (a, b) => a <= b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '>': (a, b) => a > b };
const DAY = 864e5;

export const RULE_STATUS = {
  ok: { label: 'Conforme', severity: 0 },
  stale: { label: 'Métriques anciennes', severity: 2 },
  incomplete: { label: 'À compléter', severity: 2 },
  breach: { label: 'Hors règles', severity: 3 },
  na: { label: '—', severity: -1 },
};

/** Does a scope { asset_class[], envelope[], tags_exclude[] } include this holding? Empty scope = all. */
export function inScope(h, scope = {}) {
  if (scope.asset_class && !scope.asset_class.includes(h.asset_class)) return false;
  if (scope.envelope && !scope.envelope.includes(h.envelope)) return false;
  if (scope.tags_exclude && h.tags.some((t) => scope.tags_exclude.includes(t))) return false;
  return true;
}

/** Evaluate config.rules for one holding. */
export function evaluateHolding(h, config, now = new Date()) {
  const items = (config.rules?.items ?? []).filter((r) => inScope(h, r.applies_to));
  if (!items.length) return { status: 'na', results: [] };
  const m = h.metrics ?? {};
  const maxAge = config.rules?.metrics_max_age_days;
  const ageDays = m.as_of ? Math.floor((now - new Date(m.as_of)) / DAY) : null;
  const results = items.map((rule) => {
    const v = m[rule.metric];
    if (v === undefined || v === null) return { rule, state: 'missing', value: null };
    if (rule.require_positive && v <= 0) return { rule, state: 'fail', value: v, reason: 'valeur négative ou nulle' };
    return { rule, state: OPS[rule.op](v, rule.value) ? 'pass' : 'fail', value: v };
  });
  const stale = maxAge !== undefined && ageDays !== null && ageDays > maxAge;
  const status = results.some((r) => r.state === 'fail') ? 'breach'
    : results.some((r) => r.state === 'missing') ? 'incomplete'
    : stale ? 'stale' : 'ok';
  return { status, results, metrics_age_days: ageDays, metrics_stale: stale };
}

/** Attach `rules` to each valued row (returns the same rows). */
export function evaluateRules(rows, config, now = new Date()) {
  for (const r of rows) r.rules = evaluateHolding(r.h, config, now);
  return rows;
}

// ------------------------------------------------------------------ constraints

const GROUP_KEY = {
  asset_class: (r) => r.h.asset_class, envelope: (r) => r.h.envelope, currency: (r) => r.h.currency, region: (r) => r.region,
};

/**
 * Evaluate config.constraints. Each result:
 * { id, label, type, state: ok|warn|breach|missing, ratio (fill of the meter, 0..), value, limit, lines: [text] }
 */
export function evaluateConstraints(rows, portfolio, config) {
  const base = config.base_currency;
  const total = totals(rows).value;
  return (config.constraints ?? []).map((c) => {
    const out = { id: c.id, label: c.label, type: c.type, base };
    if (c.type === 'share_cap') {
      const groups = groupBy(rows, GROUP_KEY[c.group_by]);
      const share = groups.filter((g) => c.keys.includes(g.key)).reduce((a, g) => a + g.share, 0);
      const value = groups.filter((g) => c.keys.includes(g.key)).reduce((a, g) => a + g.value, 0);
      // Caps can be shares (max/min, 0..1) and/or amounts in base currency (max_amount/min_amount/target_amount).
      const over = (c.max !== undefined && share > c.max) || (c.max_amount !== undefined && value > c.max_amount);
      const under = (c.min !== undefined && share < c.min) || (c.min_amount !== undefined && value < c.min_amount);
      const toFill = rows.some((r) => r.to_fill && c.keys.includes(GROUP_KEY[c.group_by](r)));
      const headroom = c.max_amount !== undefined ? c.max_amount - value : c.max !== undefined ? c.max * totals(rows).value - value : null;
      return { ...out, ratio: c.max_amount ? value / c.max_amount : c.max ? share / c.max : share, share, value,
        min: c.min, max: c.max, max_amount: c.max_amount, min_amount: c.min_amount, target_amount: c.target_amount,
        state: over ? 'breach' : under ? 'warn' : 'ok', headroom, incomplete: toFill };
    }
    if (c.type === 'runway') {
      const liquid = rows.filter((r) => r.in_total !== false && inScope(r.h, c.liquid)).reduce((a, r) => a + (r.value_base ?? 0), 0);
      const months = liquid / c.monthly_budget;
      const ratio = months / c.target_months;
      return { ...out, ratio, value: liquid, months, target_months: c.target_months, monthly_budget: c.monthly_budget,
        need: c.monthly_budget * c.target_months,
        state: ratio < 0.5 ? 'breach' : ratio < 1 ? 'warn' : 'ok' };
    }
    return { ...out, state: 'missing', ratio: 0, note: `Type de contrainte inconnu : ${c.type}` };
  });
}

// ------------------------------------------------------------------ "à revoir"

/**
 * Build the review list: every reason to look at something, ranked by severity then by
 * money at stake. Items: { severity: 3|2|1, kind, title, detail, amount, target }.
 */
export function reviewItems(rows, constraints, config, fmt) {
  const base = config.base_currency;
  const items = [];

  for (const r of rows) {
    const ev = r.rules;
    if (ev?.status === 'breach') {
      const fails = ev.results.filter((x) => x.state === 'fail').map((x) => `${metricText(x)} ${fmt.number(x.value, 2)} (${x.reason ?? `règle ${x.rule.op.replace('<=', '≤').replace('>=', '≥')} ${fmt.number(x.rule.value, 2)}`})`);
      items.push({ severity: 3, kind: 'règle', title: r.h.name, detail: fails.join(' · ') + (ev.metrics_stale ? ` · métriques de ${ev.metrics_age_days} j` : ''), amount: r.value_base, target: r.id });
    } else if (ev?.status === 'incomplete') {
      const miss = ev.results.filter((x) => x.state === 'missing').map(metricText);
      items.push({ severity: 2, kind: 'métriques', title: r.h.name, detail: `À saisir : ${miss.join(', ')}`, amount: r.value_base, target: r.id });
    } else if (ev?.status === 'stale') {
      items.push({ severity: 2, kind: 'métriques', title: r.h.name, detail: `Métriques datées de ${ev.metrics_age_days} jours (max ${config.rules.metrics_max_age_days})`, amount: r.value_base, target: r.id });
    }
    if (r.to_fill) { items.push({ severity: 1, kind: 'à compléter', title: r.h.name, detail: 'Montant inconnu : non compté (à renseigner, sans deviner)', amount: 0, target: r.id }); continue; }
    if (r.price.status === 'missing') items.push({ severity: 3, kind: 'prix', title: r.h.name, detail: 'Aucun prix : valorisé au prix de revient', amount: r.value_base, target: r.id });
    else if (r.price.status === 'stale') items.push({ severity: 2, kind: 'prix', title: r.h.name, detail: `Dernier prix ${fmt.age(r.price.as_of)}`, amount: r.value_base, target: r.id });
    if (r.fx_missing) items.push({ severity: 3, kind: 'change', title: r.h.name, detail: `Taux ${r.h.currency} manquant : ligne exclue du total`, amount: 0, target: r.id });
  }
  for (const c of constraints) {
    if (c.state === 'ok') continue;
    const sev = c.state === 'breach' ? 3 : 2;
    let detail = c.note ?? '';
    if (c.type === 'share_cap') detail = c.max_amount !== undefined || c.min_amount !== undefined
      ? `${fmt.money(c.value, base, { digits: 0 })} ${c.state === 'breach' ? `> plafond ${fmt.money(c.max_amount, base, { digits: 0 })}` : `< minimum ${fmt.money(c.min_amount, base, { digits: 0 })}`}`
      : c.state === 'breach'
        ? `${fmt.pct(c.share, { signed: false })} > plafond ${fmt.pct(c.max, { signed: false })}`
        : `${fmt.pct(c.share, { signed: false })} < minimum ${fmt.pct(c.min, { signed: false })}`;
    if (c.type === 'runway') detail = `${fmt.number(c.months, 1)} mois couverts sur ${c.target_months} visés`;
    items.push({ severity: sev, kind: 'contrainte', title: c.label, detail, amount: Math.abs(c.value ?? 0), target: `constraint:${c.id}` });
  }
  const t = config.allocation_targets;
  if (t) {
    const total = totals(rows).value;
    const cur = Object.fromEntries(groupBy(rows, GROUP_KEY[t.group_by]).map((g) => [g.key, g.share]));
    const labels = Object.fromEntries([...config.asset_classes, ...config.envelopes].map((x) => [x.id, x.label]));
    for (const [k, w] of Object.entries(t.weights)) {
      const gap = (cur[k] ?? 0) - w;
      if (Math.abs(gap) > (t.tolerance ?? 0)) {
        items.push({ severity: 1, kind: 'allocation', title: `Allocation ${labels[k] ?? k}`, detail: `${fmt.pct(cur[k] ?? 0, { signed: false })} pour une cible de ${fmt.pct(w, { signed: false })} (écart ${fmt.signedNumber(gap * 100, 1)} pts)`, amount: Math.abs(gap * total), target: 'targets' });
      }
    }
  }
  return items.sort((a, b) => b.severity - a.severity || (b.amount ?? 0) - (a.amount ?? 0));
}
