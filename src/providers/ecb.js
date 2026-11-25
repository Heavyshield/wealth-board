// FX fallback: ECB Data Portal (SDMX-JSON), series EXR/D.<CUR>.EUR.SP00.A. CORS *.
// Only works with EUR as base (ECB publishes "units of currency per 1 EUR").
import { getJson, ProviderError } from './common.js';

export function parse(body) {
  const dims = body?.structure?.dimensions?.series;
  const obsDim = body?.structure?.dimensions?.observation?.[0];
  const series = body?.dataSets?.[0]?.series;
  if (!dims || !series || !obsDim) throw new ProviderError('réponse SDMX inattendue');
  const curDim = dims.findIndex((d) => d.id === 'CURRENCY');
  const results = {};
  for (const [key, s] of Object.entries(series)) {
    const cur = dims[curDim].values[Number(key.split(':')[curDim])].id;
    const [obsIdx, obs] = Object.entries(s.observations).at(-1);
    const date = obsDim.values[Number(obsIdx)].id;
    results[cur] = { value: obs[0], currency: cur, as_of: `${date}T14:15:00Z`, source: 'BCE' };
  }
  return results;
}

export default {
  id: 'ecb',
  kind: 'fx',
  label: 'BCE (SDMX)',
  needs: [],
  async fetch(currencies, ctx) {
    if (ctx.base !== 'EUR') throw new ProviderError('BCE : devise de base EUR uniquement');
    const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${currencies.join('+')}.EUR.SP00.A?lastNObservations=1&format=jsondata`;
    const { body } = await getJson(ctx, url, { timeoutMs: 15000 });
    const results = parse(body);
    const errors = Object.fromEntries(currencies.filter((c) => !results[c]).map((c) => [c, 'série absente']));
    return { results, errors };
  },
};
