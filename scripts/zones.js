// Scan every PP-rewarded market and dump its per-market reward-zone
// thresholds (spreadThreshold / shareThreshold from REST). Answers
// "are these standards fixed across all markets, or do they vary?"
// and surfaces which path the bot's rewardZoneStatus will take.
//
// Usage:  npm run zones [topN]    (default 50, ranked by PP/h)
//         npm run zones 200       (scan more, parallel batches of 10)
//         npm run zones all       (no cap — slow if you have many markets)

import { config } from '../src/config.js';
import {
  getAllMarketsCached,
  getMarketRestById,
  extractHourlyRate,
  isMarketTradeable,
} from '../src/predict.js';

const arg = process.argv[2];
const limit = arg === 'all' ? Infinity : (Number(arg) || 50);

function pad(s, n, ch = ' ') {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ch.repeat(n - s.length);
}

(async () => {
  console.log('> fetching rewarded markets via GraphQL');
  const all = await getAllMarketsCached();
  console.log(`  ${all.length} markets in cache`);

  const candidates = all
    .filter((m) => isMarketTradeable(m))
    .map((m) => ({
      id: String(m.id),
      title: m.title ?? m.question ?? '',
      graphRate: extractHourlyRate(m),
    }))
    .filter((c) => c.graphRate > 0)
    .sort((a, b) => b.graphRate - a.graphRate);

  const slice = Number.isFinite(limit) ? candidates.slice(0, limit) : candidates;
  console.log(`  ${candidates.length} tradeable + rewarded; checking top ${slice.length} (by GraphQL PP/h)`);
  console.log('');
  console.log('> per-market thresholds (REST /v1/markets/<id>):');
  console.log(`  ${pad('id', 8)}  ${pad('spread', 8)}${pad('size', 7)}${pad('rate', 8)}  title`);

  // Parallel REST fetches in batches of 10 — Predict.fun's REST is
  // tolerant of bursts but we don't want to hammer it.
  const results = [];
  const BATCH = 10;
  for (let i = 0; i < slice.length; i += BATCH) {
    const batch = slice.slice(i, i + BATCH);
    const fetched = await Promise.all(batch.map(async (c) => {
      try {
        const m = await getMarketRestById(c.id);
        return {
          ...c,
          spreadThreshold: Number.isFinite(m?.spreadThreshold) && m.spreadThreshold > 0 ? m.spreadThreshold : null,
          shareThreshold: Number.isFinite(m?.shareThreshold) && m.shareThreshold > 0 ? m.shareThreshold : null,
          restRate: extractHourlyRate(m),
          categorySlug: m?.categorySlug ?? null,
        };
      } catch (err) {
        return { ...c, error: err.message };
      }
    }));
    for (const r of fetched) {
      results.push(r);
      if (r.error) {
        console.log(`  ${pad(r.id, 8)}  ERROR  ${r.error.slice(0, 60)}`);
        continue;
      }
      const sT = r.spreadThreshold != null ? r.spreadThreshold.toString() : '(unset)';
      const shT = r.shareThreshold != null ? r.shareThreshold.toString() : '(unset)';
      const rate = (r.restRate || r.graphRate || 0).toFixed(0);
      const title = (r.title || '').slice(0, 50);
      console.log(`  ${pad(r.id, 8)}  ${pad(sT, 8)}${pad(shT, 7)}${pad(rate, 6)}/h  ${title}`);
    }
  }

  // Distribution: how many markets share each (spread, size) combination?
  // Answers "is this a per-market knob or just a few global tiers?"
  console.log('');
  console.log('> threshold distribution:');
  const dist = new Map();
  let withMarketLevel = 0;
  let usingGlobalDefault = 0;
  for (const r of results) {
    if (r.error) continue;
    if (r.spreadThreshold != null || r.shareThreshold != null) withMarketLevel++;
    else usingGlobalDefault++;
    const k = `spread=${r.spreadThreshold ?? '(unset→global)'}  size=${r.shareThreshold ?? '(unset→global)'}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of sorted) {
    console.log(`  ${pad(k, 50)}  ${n} markets`);
  }

  console.log('');
  console.log(`> summary:`);
  console.log(`  ${withMarketLevel}/${results.length} markets carry an explicit per-market threshold (REST sets spreadThreshold/shareThreshold)`);
  console.log(`  ${usingGlobalDefault}/${results.length} markets fall back to global config defaults`);

  console.log('');
  console.log('> bot precedence (src/format.js: rewardZoneStatus, src/monitor.js):');
  console.log('  1. /setmarket override (state.overrides[id].rewardZoneMaxDistance / rewardZoneMinSize)  — highest');
  console.log('  2. REST market.spreadThreshold / shareThreshold (this script)                         — middle');
  console.log('  3. ENV REWARD_ZONE_MAX_DISTANCE / REWARD_ZONE_MIN_SIZE                                — fallback');
  console.log('');
  console.log(`  current global defaults:`);
  console.log(`    REWARD_ZONE_MAX_DISTANCE = ${config.rewardZoneMaxDistance}`);
  console.log(`    REWARD_ZONE_MIN_SIZE     = ${config.rewardZoneMinSize}`);

  if (withMarketLevel > 0 && usingGlobalDefault > 0) {
    console.log('');
    console.log('  → 标准 NOT fixed: some markets carry their own thresholds, others fall back.');
    console.log('  → bot already honors both paths via rewardZoneStatus(orderbook, market, defaults).');
  } else if (withMarketLevel === 0) {
    console.log('');
    console.log('  → all sampled markets fall back to global defaults (no per-market values seen).');
    console.log('    REWARD_ZONE_* env vars are the ONLY knobs in effect.');
  } else {
    console.log('');
    console.log('  → all sampled markets carry per-market thresholds; global defaults never fire here.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
