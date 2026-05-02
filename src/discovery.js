import { config } from './config.js';
import { getAllMarketsCached, extractHourlyRate, isMarketTradeable } from './predict.js';

const log = (...a) => console.log(new Date().toISOString(), '[discovery]', ...a);

export async function discoverRewardedMarkets() {
  log('refreshing market list...');
  const all = await getAllMarketsCached();
  log(`scanned ${all.length} markets`);
  const rewarded = [];
  for (const m of all) {
    if (!isMarketTradeable(m)) continue;
    const rate = extractHourlyRate(m.rewards);
    if (rate > 0) {
      rewarded.push({
        id: String(m.id),
        title: m.title ?? m.question ?? null,
        hourlyRate: rate,
      });
    }
  }
  rewarded.sort((a, b) => b.hourlyRate - a.hourlyRate);
  if (config.discoveryMaxMarkets && rewarded.length > config.discoveryMaxMarkets) {
    rewarded.length = config.discoveryMaxMarkets;
  }
  log(`rewarded markets: ${rewarded.length}`);
  return rewarded;
}

export function shouldRunDiscovery(state) {
  if (!config.autodiscover) return false;
  return Date.now() - (state.lastDiscoveryAt ?? 0) >= config.discoveryIntervalMs;
}
