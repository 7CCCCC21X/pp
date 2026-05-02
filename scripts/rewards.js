import { config } from '../src/config.js';
import { listMarketsPage } from '../src/predict.js';

const REWARD_QUERY = `query GetMarket($marketId: ID!) {
  market(id: $marketId) {
    id
    title
    rewardTimings {
      hourlyRate
    }
  }
}`;

async function postGraphQL(query, variables) {
  const res = await fetch(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName: 'GetMarket' }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchReward(marketId) {
  const json = await postGraphQL(REWARD_QUERY, { marketId: String(marketId) });
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const m = json.data?.market;
  const rewards = m?.rewardTimings ?? [];
  const total = rewards
    .map((x) => Number(x.hourlyRate))
    .filter(Number.isFinite)
    .reduce((a, b) => a + b, 0);
  return { id: String(marketId), title: m?.title ?? null, totalHourlyRate: total };
}

async function listAllOpenMarkets(limit) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const resp = await listMarketsPage(cursor);
    for (const m of resp.markets) {
      const status = (m.status ?? '').toUpperCase();
      if (status && status !== 'OPEN' && status !== 'ACTIVE' && status !== 'REGISTERED') continue;
      out.push(m);
      if (out.length >= limit) return out;
    }
    if (!resp.hasNext || !resp.nextCursor) break;
    cursor = resp.nextCursor;
  }
  return out;
}

async function pmap(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const limit = Number(process.argv[2] ?? process.env.DISCOVERY_MAX_MARKETS ?? 200);
const minRate = Number(process.env.MIN_HOURLY_RATE ?? 0);
const concurrency = Number(process.env.CONCURRENCY ?? 5);

(async () => {
  console.log(`> listing up to ${limit} open markets via ${config.restUrl}/markets`);
  const markets = await listAllOpenMarkets(limit);
  console.log(`  got ${markets.length} markets, fetching rewards (concurrency=${concurrency})`);

  const t0 = Date.now();
  const results = await pmap(markets, async (m) => {
    const r = await fetchReward(m.id);
    return { ...m, ...r };
  }, concurrency);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  done in ${elapsed}s\n`);

  const ok = results.filter((r) => !r.error && Number.isFinite(r.totalHourlyRate));
  const errs = results.filter((r) => r.error);
  ok.sort((a, b) => b.totalHourlyRate - a.totalHourlyRate);

  const rewarded = ok.filter((r) => r.totalHourlyRate > minRate);
  const totalRate = rewarded.reduce((a, b) => a + b.totalHourlyRate, 0);

  console.log(`Markets with hourlyRate > ${minRate}: ${rewarded.length} / ${ok.length}`);
  console.log(`Total hourly PP across these markets: ${totalRate.toFixed(4)} / hour`);
  console.log('');

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${pad('marketId', 12)}  ${pad('PP/h', 10)}  title`);
  console.log('-'.repeat(80));
  for (const r of rewarded) {
    console.log(
      `${pad(r.id, 12)}  ${pad(r.totalHourlyRate.toFixed(4), 10)}  ${pad(r.title ?? '', 60)}`,
    );
  }

  if (errs.length) {
    console.log(`\n${errs.length} fetch error(s); first 3:`);
    for (const e of errs.slice(0, 3)) console.log('  -', e.error);
  }

  console.log('\nReady-to-paste env:');
  console.log(`  MARKET_IDS=${rewarded.map((r) => r.id).join(',')}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
