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

function buildMarketQuery() {
  // The orderbook key field (e.g. id, conditionId, slug) is selected via env;
  // include it in the response so getOrderbook knows what to use.
  const extra = config.orderbookKeyField && config.orderbookKeyField !== 'id'
    ? `\n    ${config.orderbookKeyField}`
    : '';
  return `query GetMarket($marketId: ID!) {
  market(id: $marketId) {
    id${extra}
    title
    rewardTimings {
      hourlyRate
    }
  }
}`;
}

export async function getMarketRewardSummary(marketId) {
  const data = await postGraphQL(
    buildMarketQuery(),
    { marketId: String(marketId) },
    'GetMarket',
  );
  const market = data?.market;
  const rewardTimings = market?.rewardTimings ?? [];
  const hourlyRates = rewardTimings
    .map((x) => Number(x.hourlyRate))
    .filter(Number.isFinite);
  const totalHourlyRate = hourlyRates.reduce((a, b) => a + b, 0);
  const orderbookKey = market?.[config.orderbookKeyField] ?? market?.id ?? String(marketId);
  return {
    marketId: String(marketId),
    title: market?.title ?? null,
    totalHourlyRate,
    orderbookKey: String(orderbookKey),
  };
}

const ORDERBOOK_DEPTH = 3;

function topNOfBook(rows, n = ORDERBOOK_DEPTH) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (let i = 0; i < n && i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const price = Number(r[0]);
    const size = Number(r[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    out.push({ price, size });
  }
  return out;
}

function restHeaders() {
  const headers = { Accept: 'application/json' };
  if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  return headers;
}

export async function getOrderbook(orderbookKey, { contextMarketId } = {}) {
  const path = config.orderbookPathTemplate.replace('{key}', encodeURIComponent(orderbookKey));
  const url = `${config.restUrl}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) {
    throw new Error(`Orderbook ${res.status} for key=${orderbookKey} url=${url}: ${await res.text()}`);
  }
  const json = await res.json();
  const data = json?.data ?? json;
  const bids = topNOfBook(data?.bids);
  const asks = topNOfBook(data?.asks);
  return {
    marketId: String(contextMarketId ?? orderbookKey),
    orderbookKey: String(orderbookKey),
    updatedAtMs: Number(data?.updateTimestampMs ?? Date.now()),
    bids,
    asks,
    bestBid: bids[0] ?? null,
    bestAsk: asks[0] ?? null,
  };
}

function pickMarketId(node) {
  return String(node?.id ?? node?.marketId ?? '');
}

function pickMarketTitle(node) {
  return node?.title ?? node?.question ?? null;
}

export async function listMarketsPage(cursor) {
  const params = new URLSearchParams();
  params.set('first', '50');
  if (cursor) params.set('after', cursor);
  const url = `${config.restUrl}/markets?${params.toString()}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) {
    throw new Error(`listMarkets ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const data = json?.data ?? json;
  const items =
    data?.markets ??
    data?.edges?.map((e) => e?.node).filter(Boolean) ??
    (Array.isArray(data) ? data : []);
  const pageInfo = data?.pageInfo ?? json?.pageInfo ?? null;
  const nextCursor = pageInfo?.endCursor ?? data?.nextCursor ?? null;
  const hasNext = pageInfo?.hasNextPage ?? Boolean(nextCursor);
  return {
    markets: items.map((m) => ({
      id: pickMarketId(m),
      title: pickMarketTitle(m),
      status: m?.status ?? null,
    })).filter((m) => m.id),
    nextCursor,
    hasNext,
  };
}
