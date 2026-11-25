// Precious-metal spot from gold-api.com: /price/{XAU|XAG|XPT|XPD}/{CUR}, price per troy ounce.
// No key, CORS ok (verified 2026-11-25). No previous close: day change for metals stays unavailable.
import { getJson, ProviderError } from './common.js';

export function parse(body, code) {
  if (typeof body?.price !== 'number' || body.symbol !== code) throw new ProviderError('réponse inattendue');
  return { value: body.price, currency: body.currency, per: 'oz', as_of: body.updatedAt, source: 'gold-api.com' };
}

export default {
  id: 'goldapi',
  kind: 'spot',
  label: 'gold-api.com',
  needs: [],
  async fetch(codes, ctx) {
    const results = {}, errors = {};
    for (const code of codes) { // one request per metal, sequential (rate-limit friendly)
      try {
        const { body } = await getJson(ctx, `https://api.gold-api.com/price/${code}/${ctx.base}`);
        results[code] = parse(body, code);
      } catch (e) { errors[code] = e.message; }
    }
    return { results, errors };
  },
};
