import { config } from './config.js';

async function postGraphQL(query, variables, operationName) {
  const res = await fetch(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const MARKET_QUERY = `query GetMarket($marketId: ID!) {
  market(id: $marketId) {
    id
    title
    rewardTimings {
      hourlyRate
    }
  }
}`;

export async function getMarketRewardSummary(marketId) {
  const data = await postGraphQL(
    MARKET_QUERY,
    { marketId: String(marketId) },
    'GetMarket',
  );
  const market = data?.market;
  const rewardTimings = market?.rewardTimings ?? [];
  const hourlyRates = rewardTimings
    .map((x) => Number(x.hourlyRate))
    .filter(Number.isFinite);
  const totalHourlyRate = hourlyRates.reduce((a, b) => a + b, 0);
  return {
    marketId: String(marketId),
    title: market?.title ?? null,
    totalHourlyRate,
  };
}

function topOfBook(rows) {
  const r = rows?.[0];
  if (!r) return null;
  const price = Number(r[0]);
  const size = Number(r[1]);
  if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
  return { price, size };
}

export async function getOrderbook(marketId) {
  const headers = { Accept: 'application/json' };
  if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  const url = `${config.restUrl}/markets/${encodeURIComponent(marketId)}/orderbook`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Orderbook ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const data = json?.data ?? json;
  return {
    marketId: String(marketId),
    updatedAtMs: Number(data?.updateTimestampMs ?? Date.now()),
    bestBid: topOfBook(data?.bids),
    bestAsk: topOfBook(data?.asks),
  };
}
