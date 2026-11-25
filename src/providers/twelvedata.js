// Equity/ETF quotes from Twelve Data. Needs a key (stored in localStorage only, never in data files).
// Free plan (tested 2026-11-25): US listings only, 8 credits/minute (1 credit per symbol).
import { getJson, ProviderError, normalizeCurrency, isoFromUnix } from './common.js';

/** Parse a single-symbol or batch /quote response. */
export function parse(body, symbols) {
  const results = {}, errors = {};
  if (body?.status === 'error' || body?.code) {
    // Whole-request error (bad key, rate limit) -> every symbol fails with the same message.
    for (const s of symbols) errors[s] = `${body.code ?? ''} ${body.message ?? 'erreur'}`.trim();
    return { results, errors };
  }
  const bySymbol = symbols.length === 1 ? { [symbols[0]]: body } : body;
  for (const s of symbols) {
    const q = bySymbol?.[s];
    if (!q || q.status === 'error' || q.code) { errors[s] = (q?.message ?? 'symbole inconnu').slice(0, 160); continue; }
    const close = Number(q.close);
    if (!Number.isFinite(close)) { errors[s] = 'cours absent'; continue; }
    const n = normalizeCurrency(close, q.currency);
    const prev = Number(q.previous_close);
    results[s] = {
      value: n.value, currency: n.currency,
      prev_close: Number.isFinite(prev) ? prev / n.factor : undefined,
      as_of: isoFromUnix(q.last_quote_at ?? q.timestamp),
      source: 'Twelve Data',
    };
  }
  return { results, errors };
}

export default {
  id: 'twelvedata',
  kind: 'quote',
  label: 'Twelve Data',
  needs: ['twelvedata_key'],
  batch: 8, // = free-plan credits per minute
  minIntervalMs: 61000, // wait between batches to stay under 8 credits/min
  async fetch(symbols, ctx) {
    const key = ctx.settings.twelvedata_key;
    if (!key) throw new ProviderError('clé Twelve Data absente');
    const url = `https://api.twelvedata.com/quote?symbol=${symbols.map(encodeURIComponent).join(',')}&apikey=${encodeURIComponent(key)}`;
    const { body } = await getJson(ctx, url);
    return parse(body, symbols);
  },
};
