import { config } from './config.js';

function restHeaders() {
  const h = { Accept: 'application/json' };
  if (config.predictApiKey) h['x-api-key'] = config.predictApiKey;
  return h;
}

// Sum hourlyRate across both possible shapes:
//   GraphQL: market.rewardTimings = [{ hourlyRate }, ...]
//   REST:    market.rewards = arbitrary nested object (recursive find)
function sumHourlyRateRecursive(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += sumHourlyRateRecursive(item);
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'hourlyRate' || k === 'hourly_rate' || k === 'hourly' || k === 'rate') {
        const n = Number(v);
        if (Number.isFinite(n)) total += n;
      } else if (typeof v === 'object' && v !== null) {
        total += sumHourlyRateRecursive(v);
      }
    }
    return total;
  }
  return 0;
}

export function extractHourlyRate(marketOrRewards) {
  if (marketOrRewards == null) return 0;
  // If passed a market object, prefer the GraphQL `rewardTimings` array.
  if (Array.isArray(marketOrRewards?.rewardTimings)) {
    return marketOrRewards.rewardTimings
      .map((r) => Number(r?.hourlyRate))
      .filter(Number.isFinite)
      .reduce((a, b) => a + b, 0);
  }
  // If passed a market object with a `rewards` field, recurse into it.
  if (marketOrRewards && typeof marketOrRewards === 'object' && 'rewards' in marketOrRewards) {
    return sumHourlyRateRecursive(marketOrRewards.rewards);
  }
  // If passed a raw value, recurse directly.
  return sumHourlyRateRecursive(marketOrRewards);
}

function unwrapList(json) {
  const data = json?.data ?? json;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.markets)) return data.markets;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.nodes)) return data.nodes;
  if (Array.isArray(data?.edges)) return data.edges.map((e) => e?.node ?? e).filter(Boolean);
  return [];
}

async function postGraphQL(query, variables, operationName, { timeoutMs } = {}) {
  const ctrl = new AbortController();
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : (config.graphqlTimeoutMs ?? 30_000);
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(config.graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables, operationName }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    return json.data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GraphQL request timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const MARKETS_PAGE_QUERY = `query AllMarkets($first: Int!, $after: String) {
  markets(pagination: { first: $first, after: $after }) {
    edges {
      node {
        id
        conditionId
        title
        question
        rewardTimings { hourlyRate }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Paginate ALL markets via GraphQL markets(...) using cursor-based
// MarketConnection pagination. Returns an array of market objects with
// id / conditionId / title / question / rewardTimings.
//
// onProgress: optional callback fired after every page so callers (e.g.
// the rewards CLI) can stream feedback while the scan runs. On a fetch
// error the loop returns whatever has been collected so far instead of
// throwing — partial results are more useful than nothing.
export async function listAllMarkets({ pageSize = 100, maxPages = 100, onProgress } = {}) {
  const seen = new Map();
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    if (onProgress) onProgress({ phase: 'fetching', page, after, total: seen.size });
    let data;
    try {
      data = await postGraphQL(MARKETS_PAGE_QUERY, { first: pageSize, after }, 'AllMarkets');
    } catch (err) {
      if (onProgress) onProgress({ phase: 'error', page, error: err.message, total: seen.size });
      break;
    }
    const conn = data?.markets;
    const edges = conn?.edges ?? [];
    let progress = 0;
    for (const e of edges) {
      const node = e?.node;
      if (!node?.id || seen.has(node.id)) continue;
      seen.set(node.id, node);
      progress += 1;
    }
    const pageInfo = conn?.pageInfo;
    const hasNext = !!pageInfo?.hasNextPage && !!pageInfo?.endCursor;
    if (onProgress) {
      onProgress({
        phase: 'page',
        page,
        edges: edges.length,
        newMarkets: progress,
        total: seen.size,
        hasNext,
      });
    }
    if (!edges.length) break;
    if (!progress) break;
    if (!hasNext) break;
    after = pageInfo.endCursor;
  }
  return [...seen.values()];
}

// Cache the full market list so that a 5-min poll cycle doesn't refetch it
// for every market.
let _cache = { at: 0, markets: null, byId: null, inFlight: null };

export async function getAllMarketsCached() {
  const ttl = config.marketsCacheTtlMs;
  const now = Date.now();
  if (_cache.markets && now - _cache.at < ttl) return _cache.markets;
  if (_cache.inFlight) return _cache.inFlight;
  _cache.inFlight = (async () => {
    const list = await listAllMarkets();
    _cache.markets = list;
    _cache.byId = new Map(list.map((m) => [String(m.id), m]));
    _cache.at = Date.now();
    return list;
  })().finally(() => {
    _cache.inFlight = null;
  });
  return _cache.inFlight;
}

export async function getMarketById(id) {
  await getAllMarketsCached();
  return _cache.byId?.get(String(id)) ?? null;
}

export function isMarketTradeable(m) {
  const status = String(m?.tradingStatus ?? m?.status ?? '').toUpperCase();
  if (!status) return true;
  return !['CLOSED', 'RESOLVED', 'PAUSED', 'CANCELLED', 'CANCELED', 'ARCHIVED'].includes(status);
}

// Reward + orderbook key lookup that the rest of the bot uses. Reads from
// the cached REST market list (no per-market GraphQL).
export async function getMarketRewardSummary(marketId) {
  let market = null;
  try {
    market = await getMarketById(marketId);
  } catch (err) {
    console.warn(new Date().toISOString(), '[predict] getMarketById failed:', err.message);
  }
  if (!market) {
    return {
      marketId: String(marketId),
      title: null,
      totalHourlyRate: 0,
      orderbookKey: String(marketId),
      market: null,
    };
  }
  const totalHourlyRate = extractHourlyRate(market);
  const preferredKey = market[config.orderbookKeyField];
  const orderbookKey = preferredKey != null && preferredKey !== ''
    ? String(preferredKey)
    : String(market.conditionId ?? market.id ?? marketId);
  return {
    marketId: String(market.id),
    title: market.title ?? market.question ?? null,
    totalHourlyRate,
    orderbookKey,
    market,
  };
}

// Self-healing orderbook fetch. Tries the configured (path, key) first,
// then falls back through alternate templates and id-like fields drawn
// from the market object. Caches the working combination per market id
// in state so future ticks go straight to the right URL.
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

function buildOrderbookUrl(template, key) {
  const path = template.replace('{key}', encodeURIComponent(key));
  return `${config.restUrl}${path.startsWith('/') ? path : '/' + path}`;
}

const ID_FIELDS = ['conditionId', 'id', 'oracleQuestionId'];
const FALLBACK_TEMPLATES = ['/markets/{key}/orderbook', '/orderbook/{key}'];

async function tryFetchOrderbook(template, key) {
  const url = buildOrderbookUrl(template, key);
  const res = await fetch(url, { headers: restHeaders() });
  if (res.status === 404) return { kind: '404', url };
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { kind: 'err', url, status: res.status, body };
  }
  return { kind: 'ok', url, json: await res.json() };
}

export async function getOrderbook(orderbookKey, opts = {}) {
  const { contextMarketId, market, cache } = opts;
  const ctxId = String(contextMarketId ?? orderbookKey);

  // Attempt list: cached working combo (if any), then configured, then fallbacks.
  const attempts = [];
  if (cache?.template && cache?.key) attempts.push({ template: cache.template, key: cache.key });
  attempts.push({ template: config.orderbookPathTemplate, key: orderbookKey });
  if (market) {
    for (const tpl of [config.orderbookPathTemplate, ...FALLBACK_TEMPLATES]) {
      for (const f of ID_FIELDS) {
        const v = market[f];
        if (v == null || v === '') continue;
        attempts.push({ template: tpl, key: String(v) });
      }
    }
  }

  // Dedupe attempts
  const seen = new Set();
  const dedup = attempts.filter((a) => {
    const k = `${a.template}|${a.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let lastErr = null;
  for (const a of dedup) {
    try {
      const r = await tryFetchOrderbook(a.template, a.key);
      if (r.kind === 'ok') {
        const data = r.json?.data ?? r.json;
        const bids = topNOfBook(data?.bids);
        const asks = topNOfBook(data?.asks);
        return {
          marketId: ctxId,
          orderbookKey: a.key,
          template: a.template,
          updatedAtMs: Number(data?.updateTimestampMs ?? Date.now()),
          bids,
          asks,
          bestBid: bids[0] ?? null,
          bestAsk: asks[0] ?? null,
        };
      }
      lastErr = r.kind === '404' ? `404 ${r.url}` : `${r.status} ${r.url}: ${r.body}`;
    } catch (err) {
      lastErr = `${err.message} (${a.template} ${a.key})`;
    }
  }
  throw new Error(`Orderbook not found for market ${ctxId} (tried ${dedup.length} combos). Last: ${lastErr}`);
}

// Compatibility shim used by older code paths (rewards.js).
export async function listMarketsPage(cursor) {
  const params = new URLSearchParams({ first: '50' });
  if (cursor) params.set('after', String(cursor));
  const url = `${config.restUrl}/markets?${params.toString()}`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) throw new Error(`listMarkets ${res.status}: ${await res.text()}`);
  const arr = unwrapList(await res.json());
  const lastId = arr[arr.length - 1]?.id ?? null;
  return {
    markets: arr.map((m) => ({
      id: String(m.id),
      title: m.title ?? null,
      status: m.status ?? m.tradingStatus ?? null,
      raw: m,
    })),
    nextCursor: lastId,
    hasNext: arr.length === 50 && lastId != null,
  };
}
