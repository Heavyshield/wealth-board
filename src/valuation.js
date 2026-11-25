// Valuation: turns holdings + market data into valued rows. Pure functions, no DOM.
// Money totals are summed in integer cents of the base currency to avoid float drift.
//
// Price status (shown as a badge, never hidden):
//   live    - market price younger than config.prices.stale_after_hours
//   stale   - market price older than the threshold
//   manual  - manual_price override (always wins)
//   balance - par-priced line (cash/account): value = quantity, as of updated_at
//   missing - no price at all: valued at cost so the total stays complete, flagged

export const GRAMS_PER_TROY_OZ = 31.1034768;
const TO_OZ = { oz: 1, g: 1 / GRAMS_PER_TROY_OZ, kg: 1000 / GRAMS_PER_TROY_OZ };

const toCents = (x) => Math.round(x * 100);

/**
 * FX converter. Rates are "1 base = r units of currency" (ECB convention).
 * Returns { convert(amount, cur) -> number|null, rate(cur) -> number|null }.
 */
export function makeFx(base, rates = {}) {
  const rate = (cur) => (cur === base ? 1 : rates[cur] ?? null);
  return {
    rate,
    convert(amount, cur) {
      const r = rate(cur);
      return r ? amount / r : null;
    },
  };
}

function ageHours(iso, now) {
  return (now - new Date(iso)) / 36e5;
}

/** Fine weight in troy ounces for one item. */
export function fineOz(metal) {
  return metal.weight * TO_OZ[metal.unit] * metal.purity;
}

/**
 * Resolve the unit price of one holding.
 * Returns { value, currency, as_of, source, status }.
 * `quotes` is an optional map id -> live price (filled by price providers, stage d).
 */
export function resolvePrice(h, pricing, market, config, now, quotes = {}) {
  const stale = config.prices?.stale_after_hours ?? {};
  if (h.manual_price) {
    return { ...h.manual_price, currency: h.manual_price.currency ?? h.currency, status: 'manual', source: h.manual_price.source ?? 'manuel' };
  }
  if (pricing === 'par') {
    return { value: 1, currency: h.currency, as_of: h.updated_at, source: 'solde', status: 'balance' };
  }
  if (pricing === 'spot') {
    const spot = market?.spot?.[h.metal?.code];
    if (!spot || !h.metal) return missing(h);
    const perOz = spot.value / TO_OZ[spot.per];
    const value = fineOz(h.metal) * perOz;
    const prev_close = spot.prev_close ? fineOz(h.metal) * (spot.prev_close / TO_OZ[spot.per]) : undefined;
    const status = ageHours(spot.as_of, now) > (stale.spot ?? 72) ? 'stale' : 'live';
    return { value, prev_close, currency: spot.currency, as_of: spot.as_of, source: spot.source ?? 'spot', status };
  }
  // quote
  const p = quotes[h.id] ?? h.last_price;
  if (!p) return missing(h);
  const status = ageHours(p.as_of, now) > (stale.quote ?? 72) ? 'stale' : 'live';
  return { value: p.value, prev_close: p.prev_close, currency: p.currency ?? h.currency, as_of: p.as_of, source: p.source ?? 'cache', status };
}

function missing(h) {
  return { value: h.unit_cost, currency: h.currency, as_of: null, source: 'PRU', status: 'missing' };
}

/** Region: explicit field > regions.by_isin > label by pricing (cash, metals) > ISIN country prefix > unknown label. */
export function regionOf(h, config, pricing = 'quote') {
  if (h.region) return h.region;
  if (h.isin && config.regions?.by_isin?.[h.isin]) return config.regions.by_isin[h.isin];
  const byPricing = config.regions?.by_pricing?.[pricing];
  if (byPricing) return byPricing;
  const country = h.isin?.slice(0, 2);
  return config.regions?.by_country?.[country] ?? config.regions?.unknown_label ?? '—';
}

/**
 * Value every holding. Returns rows with base-currency figures.
 * P&L split (base currency):
 *   cost_base     = qty * unit_cost / fx_at_purchase   (cost_fx_rate, else today's rate: flagged)
 *   pnl_fx_base   = qty * unit_cost / fx_now - cost_base   (currency effect)
 *   pnl_local_base= pnl_base - pnl_fx_base                (price effect)
 */
export function valueHoldings({ portfolio, config, now = new Date(), quotes = {} }) {
  const base = config.base_currency;
  const market = portfolio.market_snapshot ?? {};
  const fxRates = market.fx?.base === base ? market.fx.rates : {};
  const fx = makeFx(base, fxRates);
  const classes = Object.fromEntries(config.asset_classes.map((c) => [c.id, c]));
  const envs = Object.fromEntries(config.envelopes.map((e) => [e.id, e]));

  return portfolio.holdings.map((h) => {
    const pricing = classes[h.asset_class]?.pricing ?? 'quote';
    const price = resolvePrice(h, pricing, market, config, now, quotes);
    // quantity null = TO_FILL: shown as "à compléter", never counted (no guessing).
    const toFill = h.quantity === null || h.quantity === undefined;
    const noPrice = price.value === null || price.value === undefined; // no market price and no cost: unknown, never 0
    const valueLocal = toFill || noPrice ? null : h.quantity * price.value; // in price.currency
    const valueBase = valueLocal === null ? null : fx.convert(valueLocal, price.currency);
    const costLocal = toFill || h.unit_cost === null || h.unit_cost === undefined ? null : h.quantity * h.unit_cost; // in h.currency
    const costNow = costLocal === null ? null : fx.convert(costLocal, h.currency);
    const costFxKnown = h.currency === base || h.cost_fx_rate !== undefined;
    const costBase = costLocal === null ? null : h.currency === base ? costLocal : h.cost_fx_rate ? costLocal / h.cost_fx_rate : costNow;
    const pnlBase = valueBase !== null && costBase !== null ? valueBase - costBase : null;
    const pnlFx = costNow !== null && costBase !== null ? costNow - costBase : null;
    return {
      h,
      id: h.id,
      pricing,
      price,
      region: regionOf(h, config, pricing),
      // Day change: only from a fresh market price with a previous close; otherwise null (not 0).
      day_base: !toFill && price.status === 'live' && price.prev_close ? fx.convert(h.quantity * (price.value - price.prev_close), price.currency) : null,
      value_local: valueLocal,
      value_base: valueBase,
      value_base_cents: valueBase === null ? null : toCents(valueBase),
      cost_base: costBase,
      cost_base_cents: costBase === null ? null : toCents(costBase),
      pnl_base: pnlBase,
      pnl_pct: pnlBase !== null && costBase ? pnlBase / costBase : null,
      pnl_fx_base: pnlFx,
      pnl_local_base: pnlBase !== null && pnlFx !== null ? pnlBase - pnlFx : null,
      cost_fx_known: costFxKnown,
      to_fill: toFill,
      no_price: !toFill && noPrice,
      fx_missing: !toFill && !noPrice && valueBase === null,
      // Envelope flags (config.envelopes): out of net worth (locked pension) / out of allocation (cash reserve).
      in_total: envs[h.envelope]?.in_net_worth !== false,
      in_alloc: envs[h.envelope]?.in_net_worth !== false && envs[h.envelope]?.in_allocation !== false,
    };
  });
}

/**
 * Totals in base currency, from integer cents. Only lines counted in net worth (in_total);
 * `outside` = known value of lines outside net worth, `to_fill` = lines with an unknown amount.
 */
export function totals(rows) {
  let value = 0, cost = 0, missingFx = 0, day = 0, dayCovered = 0, outside = 0, toFill = 0;
  const byStatus = {};
  for (const r of rows) {
    if (r.to_fill || r.no_price) { toFill++; continue; }
    if (r.in_total === false) { outside += r.value_base_cents ?? 0; continue; }
    if (r.value_base_cents === null) { missingFx++; continue; }
    value += r.value_base_cents;
    cost += r.cost_base_cents ?? 0;
    byStatus[r.price.status] = (byStatus[r.price.status] ?? 0) + r.value_base_cents;
    if (r.day_base !== null) { day += toCents(r.day_base); dayCovered += r.value_base_cents; }
  }
  const share = Object.fromEntries(Object.entries(byStatus).map(([k, c]) => [k, value ? c / value : 0]));
  return {
    value: value / 100, cost: cost / 100, pnl: (value - cost) / 100, value_cents: value,
    by_status_share: share, missing_fx: missingFx, outside: outside / 100, to_fill: toFill,
    day: dayCovered ? day / 100 : null, day_coverage: value ? dayCovered / value : 0,
  };
}

/**
 * Group values by a key function, from integer cents. Returns [{ key, value, share }] sorted desc.
 * scope 'alloc' (default): lines in allocation views; 'total': all lines counted in net worth.
 */
export function groupBy(rows, keyFn, scope = 'alloc') {
  const sums = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.value_base_cents === null) continue;
    if (scope === 'alloc' ? r.in_alloc === false : r.in_total === false) continue;
    const k = keyFn(r);
    sums.set(k, (sums.get(k) ?? 0) + r.value_base_cents);
    total += r.value_base_cents;
  }
  return [...sums.entries()]
    .map(([key, c]) => ({ key, value: c / 100, share: total ? c / total : 0 }))
    .sort((a, b) => b.value - a.value);
}
