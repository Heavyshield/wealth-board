// Shared helpers for price providers.
//
// Provider interface (one file per provider in src/providers/):
//   export default {
//     id, kind: 'fx' | 'spot' | 'quote', label,
//     needs: [settingKey...]              // e.g. ['yahoo_proxy_url']; missing -> provider skipped
//     batch: n                            // max symbols per request (quote providers)
//     async fetch(items, ctx) -> { results: { key: Price }, errors: { key: message } }
//   }
// items: fx -> currency codes; spot -> metal codes (XAU...); quote -> provider symbols.
// Price: { value, currency, as_of (ISO), prev_close?, source }  (fx: value = units per 1 base)
// ctx: { fetch, settings, base, signal }  -- fetch is injectable for tests.

export class ProviderError extends Error {}

/** fetch + timeout + JSON + readable errors. */
export async function getJson(ctx, url, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  ctx.signal?.addEventListener('abort', () => ctrl.abort());
  let res;
  try {
    res = await (ctx.fetch ?? fetch)(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ProviderError(e.name === 'AbortError' ? 'délai dépassé' : `réseau / CORS : ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new ProviderError('limite de requêtes atteinte (429)');
  let body;
  try { body = await res.json(); } catch { throw new ProviderError(`réponse illisible (HTTP ${res.status})`); }
  if (!res.ok && !body) throw new ProviderError(`HTTP ${res.status}`);
  return { status: res.status, body };
}

/** Minor-unit currencies some exchanges quote in: GBp (pence) -> GBP / 100, etc. */
const MINOR = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };
export function normalizeCurrency(value, currency) {
  const m = MINOR[currency];
  return m ? { value: value / m[1], currency: m[0], factor: m[1] } : { value, currency, factor: 1 };
}

export const isoFromUnix = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
