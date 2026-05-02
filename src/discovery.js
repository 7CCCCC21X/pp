import { config } from './config.js';
import { getAllMarketsCached, extractHourlyRate, isMarketTradeable, marketEndMs } from './predict.js';

const log = (...a) => console.log(new Date().toISOString(), '[discovery]', ...a);

export async function discoverRewardedMarkets() {
  log('refreshing market list...');
  const all = await getAllMarketsCached();
  log(`scanned ${all.length} markets`);
  const rewarded = [];
  const minRate = Math.max(0, config.minHourlyRate);
  const minRemainingMs = Math.max(0, config.minRemainingHours) * 3600 * 1000;
  const cutoff = Date.now() + minRemainingMs;
  let belowMin = 0;
  let tooSoon = 0;
  for (const m of all) {
    if (!isMarketTradeable(m)) continue;
    const rate = extractHourlyRate(m);
    if (rate <= 0) continue;
    if (rate < minRate) { belowMin += 1; continue; }
    if (minRemainingMs > 0) {
      const endMs = marketEndMs(m);
      if (endMs != null && endMs < cutoff) { tooSoon += 1; continue; }
    }
    rewarded.push({
      id: String(m.id),
      title: m.title ?? m.question ?? null,
      hourlyRate: rate,
      endMs: marketEndMs(m),
    });
  }
  rewarded.sort((a, b) => b.hourlyRate - a.hourlyRate);
  if (config.discoveryMaxMarkets && rewarded.length > config.discoveryMaxMarkets) {
    rewarded.length = config.discoveryMaxMarkets;
  }
  log(
    `kept ${rewarded.length} rewarded markets`,
    `(min PP/h=${minRate} skipped ${belowMin};`,
    `min remaining=${config.minRemainingHours}h skipped ${tooSoon})`,
  );
  return rewarded;
}

export function shouldRunDiscovery(state) {
  if (!config.autodiscover) return false;
  return Date.now() - (state.lastDiscoveryAt ?? 0) >= config.discoveryIntervalMs;
}
