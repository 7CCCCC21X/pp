import { config } from '../src/config.js';
import { fetchJson } from '../src/http.js';
import { resolveSlugToId } from '../src/predict.js';
import { slugifyMarketTitle, rewardZoneStatus } from '../src/format.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run reward-check <marketId | slug | URL>');
  process.exit(1);
}

function restHeaders() {
  const h = { Accept: 'application/json' };
  if (config.predictApiKey) h['x-api-key'] = config.predictApiKey;
  return h;
}

async function postGraphQL(query, variables) {
  const res = await fetch(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Extract slug from a predict.fun URL or accept a bare slug. Returns
// null if the input looks like a numeric id.
function extractSlug(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return null;
  const m = s.match(/\/market\/([^/?#]+)/);
  if (m) return m[1];
  if (/^[a-z0-9][a-z0-9-]{1,200}$/i.test(s)) return s.toLowerCase();
  return null;
}

(async () => {
  // 0. If input is a slug or URL, resolve to a numeric id first.
  let marketId = arg;
  const maybeSlug = extractSlug(arg);
  if (maybeSlug) {
    console.log(`> resolving slug "${maybeSlug}" -> id`);
    try {
      const id = await resolveSlugToId(maybeSlug, slugifyMarketTitle);
      if (!id) {
        console.error(`  could not resolve slug "${maybeSlug}". Try the numeric id instead.`);
        process.exit(1);
      }
      console.log(`  -> #${id}`);
      marketId = id;
    } catch (err) {
      console.error('  resolve failed:', err.message);
      process.exit(1);
    }
  }

  // 1. Introspect RewardTiming GraphQL type — what fields does it actually have?
  console.log('> introspecting RewardTiming type');
  const intro = await postGraphQL(`query I {
    __type(name: "RewardTiming") {
      name
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }`, {});
  const rt = intro?.data?.__type;
  if (!rt) {
    console.log('  RewardTiming type not found in schema');
  } else {
    console.log(`  ${rt.fields.length} fields on RewardTiming:`);
    for (const f of rt.fields) {
      let t = f.type;
      while (t?.ofType) t = t.ofType;
      console.log(`    ${String(f.name).padEnd(20)} ${t?.kind ?? '?'} ${t?.name ?? ''}`);
    }
  }

  // 2. Fetch the market via GraphQL with EVERY rewardTimings field selected
  const allFields = (rt?.fields ?? []).map((f) => f.name).join(' ') || 'hourlyRate';
  console.log(`\n> fetching market ${marketId} (selecting all RewardTiming fields)`);
  const q = `query M($id: ID!) {
    market(id: $id) {
      id title question
      rewardTimings { ${allFields} }
    }
  }`;
  const m = await postGraphQL(q, { id: String(marketId) });
  if (m?.errors) {
    console.log(`  GraphQL errors: ${JSON.stringify(m.errors)}`);
  }
  const market = m?.data?.market;
  if (!market) {
    console.log('  market not found via GraphQL');
  } else {
    console.log(`  title:    ${market.title}`);
    console.log(`  question: ${market.question}`);
    console.log(`  rewardTimings (${market.rewardTimings?.length ?? 0} entries):`);
    for (let i = 0; i < (market.rewardTimings?.length ?? 0); i++) {
      console.log(`    [${i}] ${JSON.stringify(market.rewardTimings[i])}`);
    }
    if (!market.rewardTimings?.length) console.log('    (empty array)');
  }

  // 3. REST single-market — what does it say about market status + rewards?
  console.log(`\n> REST /v1/markets/${marketId}`);
  try {
    const json = await fetchJson(`${config.restUrl}/markets/${encodeURIComponent(marketId)}`, {
      headers: restHeaders(),
      timeoutMs: 10_000,
      retries: 0,
    });
    const m = json?.data ?? json;
    console.log(`  status:        ${m?.status}`);
    console.log(`  tradingStatus: ${m?.tradingStatus}`);
    console.log(`  isResolved:    ${m?.isResolved}`);
    for (const f of ['endsAt', 'endTime', 'endsAtTimestamp', 'closeTime', 'resolvedAt', 'boostEndsAt']) {
      if (m?.[f] != null) console.log(`  ${f.padEnd(13)}: ${m[f]}`);
    }
    console.log(`  categorySlug:  ${m?.categorySlug}`);
    console.log(`  rewards (typeof ${typeof m?.rewards}):`);
    console.log(`    ${JSON.stringify(m?.rewards, null, 2).split('\n').join('\n    ')}`);
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }

  // 4. What does the bot actually compute? Three views: REST-only,
  //    GraphQL-only (if it returned), and the full merged path the
  //    monitor loop uses (getMarketRewardSummary).
  console.log(`\n> bot's extractHourlyRate calculation`);
  const { extractHourlyRate, isMarketTradeable, getMarketRewardSummary } = await import('../src/predict.js');

  // REST-only computation
  try {
    const json = await fetchJson(`${config.restUrl}/markets/${encodeURIComponent(marketId)}`, {
      headers: restHeaders(), timeoutMs: 10_000, retries: 0,
    });
    const rest = json?.data ?? json;
    console.log(`  REST only      → ${extractHourlyRate(rest).toFixed(2)} PP/h`);
    console.log(`  REST tradeable → ${isMarketTradeable(rest)}`);
  } catch (err) {
    console.log(`  REST only      → failed: ${err.message}`);
  }

  // GraphQL-only computation (if the market was returned)
  if (market) {
    console.log(`  GraphQL only   → ${extractHourlyRate(market).toFixed(2)} PP/h`);
    console.log(`  GraphQL tradeable → ${isMarketTradeable(market)}`);
  }

  // What the bot actually uses (GraphQL + REST merged)
  let summary = null;
  try {
    summary = await getMarketRewardSummary(marketId);
    console.log(`  bot's summary  → ${summary.totalHourlyRate.toFixed(2)} PP/h`);
    console.log(`  bot's title    → ${summary.title ?? '(none)'}`);
    console.log(`  bot's slug key → ${summary.orderbookKey}`);
  } catch (err) {
    console.log(`  bot's summary  → failed: ${err.message}`);
  }

  // 5. Per-market reward-zone thresholds (the values Predict.fun's UI
  //    shows under "激活积分": "最少份额" + "最大价差"). REST exposes
  //    them as spreadThreshold / shareThreshold; rewardZoneStatus uses
  //    them when set, falling back to the global defaults otherwise.
  console.log(`\n> per-market reward-zone thresholds`);
  const merged = summary?.market;
  if (!merged) {
    console.log('  no merged market data available (REST + GraphQL both empty)');
  } else {
    const spreadThreshold = Number.isFinite(merged.spreadThreshold) ? merged.spreadThreshold : null;
    const shareThreshold = Number.isFinite(merged.shareThreshold) ? merged.shareThreshold : null;
    const effectiveSpread = (spreadThreshold != null && spreadThreshold > 0) ? spreadThreshold : config.rewardZoneMaxDistance;
    const effectiveShare  = (shareThreshold  != null && shareThreshold  > 0) ? shareThreshold  : config.rewardZoneMinSize;
    console.log(`  market.spreadThreshold (max-distance):  ${spreadThreshold ?? '(unset)'}`);
    console.log(`  market.shareThreshold  (min-size):      ${shareThreshold ?? '(unset)'}`);
    console.log(`  global default REWARD_ZONE_MAX_DISTANCE: ${config.rewardZoneMaxDistance}`);
    console.log(`  global default REWARD_ZONE_MIN_SIZE:     ${config.rewardZoneMinSize}`);
    const usingMarket = spreadThreshold != null && spreadThreshold > 0;
    console.log(`  bot will use → maxDistance=${effectiveSpread} ${usingMarket ? '(from market)' : '(global default)'}, minSize=${effectiveShare}`);
  }

  // 6. Live orderbook + rewardZoneStatus the bot would compute right now.
  console.log(`\n> live orderbook + bot's rewardZoneStatus`);
  if (!summary?.orderbookKey) {
    console.log('  no orderbookKey from summary — skipping');
  } else {
    try {
      const { getOrderbook } = await import('../src/predict.js');
      const ob = await getOrderbook(summary.orderbookKey, { contextMarketId: marketId, market: merged });
      const bid = ob.bestBid ? `${ob.bestBid.price.toFixed(4)} × ${ob.bestBid.size}` : '空';
      const ask = ob.bestAsk ? `${ob.bestAsk.price.toFixed(4)} × ${ob.bestAsk.size}` : '空';
      console.log(`  bestBid: ${bid}`);
      console.log(`  bestAsk: ${ask}`);
      const zone = rewardZoneStatus(ob, merged, {
        maxDistance: config.rewardZoneMaxDistance,
        minSize: config.rewardZoneMinSize,
      });
      console.log(`  zone.maxDistance: ${zone.maxDistance}`);
      console.log(`  zone.minSize:     ${zone.minSize}`);
      console.log(`  bid activated:    ${zone.bidActivated}${zone.bidReason ? ` (${zone.bidReason})` : ''}`);
      console.log(`  ask activated:    ${zone.askActivated}${zone.askReason ? ` (${zone.askReason})` : ''}`);
    } catch (err) {
      console.log(`  orderbook fetch failed: ${err.message}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
