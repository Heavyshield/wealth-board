// FX from Frankfurter (ECB reference rates, published ~16:00 CET on TARGET business days).
// No key, CORS *. Verified 2026-11-24 from a browser on localhost.
import { getJson, ProviderError } from './common.js';

export function parse(body, base) {
  if (!body?.rates || body.base !== base) throw new ProviderError('réponse inattendue');
  // ECB rates are fixed around 14:15 UTC; date only in the payload.
  const as_of = `${body.date}T14:15:00Z`;
  const results = {};
  for (const [cur, rate] of Object.entries(body.rates)) results[cur] = { value: rate, currency: cur, as_of, source: 'frankfurter (BCE)' };
  return results;
}

export default {
  id: 'frankfurter',
  kind: 'fx',
  label: 'Frankfurter (BCE)',
  needs: [],
  async fetch(currencies, ctx) {
    const url = `https://api.frankfurter.dev/v1/latest?base=${ctx.base}&symbols=${currencies.join(',')}`;
    const { body } = await getJson(ctx, url);
    const results = parse(body, ctx.base);
    const errors = Object.fromEntries(currencies.filter((c) => !results[c]).map((c) => [c, 'devise non publiée par la BCE']));
    return { results, errors };
  },
};
