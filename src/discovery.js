import { config } from './config.js';
import {
  getAllMarketsCached,
  listActiveRewardedMarketsRest,
  extractHourlyRate,
  isMarketTradeable,
  marketEndMs,
} from './predict.js';

const log = (...a) => console.log(new Date().toISOString(), '[discovery]', ...a);
const warn = (...a) => console.warn(new Date().toISOString(), '[discovery]', ...a);

export async function discoverRewardedMarkets() {
  log('refreshing market list...');
  // PRIMARY: REST `?hasActiveRewards=true` — server already drops markets
  // not currently in a reward window, so the response is ~100 markets vs
  // GraphQL's ~thousands. Falls back to the GraphQL list (scanned
  // client-side) on REST error so we degrade rather than fail discovery.
  let all;
  let source = 'rest';
  try {
    all = await listActiveRewardedMarketsRest();
  } catch (err) {
    warn(`REST hasActiveRewards fetch failed (${err.message}); falling back to GraphQL`);
    all = await getAllMarketsCached();
    source = 'graphql';
  }
  log(`scanned ${all.length} markets (source=${source})`);
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

// Side-by-side audit: hits both market-list sources, applies the same
// downstream filters as discoverRewardedMarkets, and returns counts +
// id-set diffs so the user can see which side disagrees and where.
// Used by /diagdiscover when the running market count looks off.
export async function compareDiscoverySources() {
  const t0 = Date.now();
  const [restRes, gqlRes] = await Promise.allSettled([
    listActiveRewardedMarketsRest(),
    (async () => {
      const all = await getAllMarketsCached();
      // Mirror the old discovery's client-side filter: "has currently
      // active reward" means extractHourlyRate(m) > 0.
      return all.filter((m) => extractHourlyRate(m) > 0);
    })(),
  ]);
  const restList = restRes.status === 'fulfilled' ? restRes.value : [];
  const gqlList = gqlRes.status === 'fulfilled' ? gqlRes.value : [];
  const restErr = restRes.status === 'rejected' ? (restRes.reason?.message ?? String(restRes.reason)) : null;
  const gqlErr = gqlRes.status === 'rejected' ? (gqlRes.reason?.message ?? String(gqlRes.reason)) : null;

  const restIds = new Set(restList.map((m) => String(m.id)));
  const gqlIds = new Set(gqlList.map((m) => String(m.id)));
  const onlyRest = [...restIds].filter((id) => !gqlIds.has(id));
  const onlyGql = [...gqlIds].filter((id) => !restIds.has(id));
  const both = [...restIds].filter((id) => gqlIds.has(id));

  const minRate = Math.max(0, config.minHourlyRate);
  const minRemainingMs = Math.max(0, config.minRemainingHours) * 3600 * 1000;
  const cutoff = Date.now() + minRemainingMs;
  const breakdown = (list) => {
    let notTradeable = 0;
    let belowMin = 0;
    let tooSoon = 0;
    let kept = 0;
    for (const m of list) {
      if (!isMarketTradeable(m)) { notTradeable += 1; continue; }
      const rate = extractHourlyRate(m);
      if (rate < minRate) { belowMin += 1; continue; }
      if (minRemainingMs > 0) {
        const endMs = marketEndMs(m);
        if (endMs != null && endMs < cutoff) { tooSoon += 1; continue; }
      }
      kept += 1;
    }
    return { raw: list.length, notTradeable, belowMin, tooSoon, kept };
  };

  // Pull a few sample titles for the "only in X" lists so the user can
  // recognise if the gap is "obscure markets we don't care about" vs
  // "live markets we should be tracking".
  const sample = (idList, sourceList) => {
    const map = new Map(sourceList.map((m) => [String(m.id), m]));
    return idList.slice(0, 8).map((id) => {
      const m = map.get(id);
      const title = m?.title ?? m?.question ?? `(no title)`;
      const rate = m ? extractHourlyRate(m) : 0;
      return { id, title, rate };
    });
  };

  return {
    elapsedMs: Date.now() - t0,
    rest: {
      count: restList.length,
      err: restErr,
      breakdown: restErr ? null : breakdown(restList),
    },
    gql: {
      count: gqlList.length,
      err: gqlErr,
      breakdown: gqlErr ? null : breakdown(gqlList),
    },
    bothCount: both.length,
    onlyRest: { count: onlyRest.length, sample: sample(onlyRest, restList) },
    onlyGql: { count: onlyGql.length, sample: sample(onlyGql, gqlList) },
    config: {
      minRate, minRemainingHours: config.minRemainingHours,
      discoveryMaxMarkets: config.discoveryMaxMarkets,
    },
  };
}
