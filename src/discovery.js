import { config } from './config.js';
import { listMarketsPage, getMarketRewardSummary } from './predict.js';

const log = (...args) => console.log(new Date().toISOString(), '[discovery]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[discovery]', ...args);

async function listAllOpenMarkets() {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const resp = await listMarketsPage(cursor);
    for (const m of resp.markets) {
      const status = (m.status ?? '').toUpperCase();
      if (status && status !== 'OPEN' && status !== 'ACTIVE' && status !== 'REGISTERED') continue;
      out.push(m);
      if (out.length >= config.discoveryMaxMarkets) return out;
    }
    if (!resp.hasNext || !resp.nextCursor) break;
    cursor = resp.nextCursor;
  }
  return out;
}

export async function discoverRewardedMarkets() {
  log('scanning markets...');
  const markets = await listAllOpenMarkets();
  log(`found ${markets.length} open markets, checking rewards`);
  const rewarded = [];
  for (const m of markets) {
    try {
      const summary = await getMarketRewardSummary(m.id);
      if (summary.totalHourlyRate > 0) {
        rewarded.push({ id: m.id, title: summary.title ?? m.title ?? null, hourlyRate: summary.totalHourlyRate });
      }
    } catch (err) {
      warn(`reward check ${m.id} failed:`, err.message);
    }
  }
  log(`rewarded markets: ${rewarded.length}`);
  return rewarded;
}

export function shouldRunDiscovery(state) {
  if (!config.autodiscover) return false;
  return Date.now() - (state.lastDiscoveryAt ?? 0) >= config.discoveryIntervalMs;
}
