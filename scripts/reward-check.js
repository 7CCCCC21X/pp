import { config } from '../src/config.js';
import { fetchJson } from '../src/http.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run reward-check <marketId>');
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

(async () => {
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
  console.log(`\n> fetching market ${arg} (selecting all RewardTiming fields)`);
  const q = `query M($id: ID!) {
    market(id: $id) {
      id title question
      rewardTimings { ${allFields} }
    }
  }`;
  const m = await postGraphQL(q, { id: String(arg) });
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
  console.log(`\n> REST /v1/markets/${arg}`);
  try {
    const json = await fetchJson(`${config.restUrl}/markets/${encodeURIComponent(arg)}`, {
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
    const json = await fetchJson(`${config.restUrl}/markets/${encodeURIComponent(arg)}`, {
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
  try {
    const summary = await getMarketRewardSummary(arg);
    console.log(`  bot's summary  → ${summary.totalHourlyRate.toFixed(2)} PP/h`);
    console.log(`  bot's title    → ${summary.title ?? '(none)'}`);
    console.log(`  bot's slug key → ${summary.orderbookKey}`);
  } catch (err) {
    console.log(`  bot's summary  → failed: ${err.message}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
