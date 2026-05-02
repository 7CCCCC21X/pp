import { config } from './config.js';
import { fetchJson } from './http.js';

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

async function postGraphQL(query, variables, operationName, { timeoutMs, retries } = {}) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : (config.graphqlTimeoutMs ?? 30_000);
  const json = await fetchJson(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName }),
    timeoutMs: ms,
    retries: retries ?? 1,
  });
  if (json?.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json?.data;
}

// Build the markets() page query lazily, after introspecting which fields are
// actually exposed on Market and MarketFilterInput. This way we can include
// optional status/endsAt fields if present (for closed-market filtering), and
// pass isResolved:false at the source if the schema supports it - without
// hard-coding fields that may not exist on every deployment.
const REQUIRED_FIELDS = ['id', 'conditionId', 'title', 'question'];
const OPTIONAL_STATUS_FIELDS = [
  'status',
  'tradingStatus',
  'endsAt',
  'endTime',
  'endsAtTimestamp',
  'closeTime',
  'isResolved',
  'resolvedAt',
  // Reward zone parameters: max distance from mid for an order to qualify,
  // and the minimum order size that earns rewards. Predict.fun exposes
  // these as scalars on Market in REST; we include them when available
  // so the bot can use per-market rules instead of global env defaults.
  'spreadThreshold',
  'shareThreshold',
];
let _marketsQueryCache = null;
let _selectionCache = null;
let _filterFieldsCache = null;

async function getMarketSelection() {
  if (_selectionCache != null) {
    return { selection: _selectionCache, filterFields: _filterFieldsCache };
  }
  let scalarMarketFields = new Set();
  let filterFields = new Set();
  try {
    const intro = await postGraphQL(
      `query Introspect {
        market: __type(name: "Market") {
          fields {
            name
            type {
              kind name
              ofType { kind name ofType { kind name ofType { kind name } } }
            }
          }
        }
        filter: __type(name: "MarketFilterInput") { inputFields { name } }
      }`,
      {},
      'Introspect',
    );
    for (const f of intro?.market?.fields ?? []) {
      let t = f.type;
      while (t && (t.kind === 'NON_NULL' || t.kind === 'LIST')) t = t.ofType;
      if (!t) continue;
      if (t.kind === 'SCALAR' || t.kind === 'ENUM') {
        scalarMarketFields.add(f.name);
      }
    }
    filterFields = new Set((intro?.filter?.inputFields ?? []).map((f) => f.name));
  } catch {
    // Fall back to the minimal known-good query.
  }
  const fields = [];
  for (const f of REQUIRED_FIELDS) {
    if (!scalarMarketFields.size || scalarMarketFields.has(f)) fields.push(f);
  }
  fields.push('rewardTimings { hourlyRate }');
  for (const f of OPTIONAL_STATUS_FIELDS) {
    if (scalarMarketFields.has(f)) fields.push(f);
  }
  _selectionCache = fields.join('\n          ');
  _filterFieldsCache = filterFields;
  return { selection: _selectionCache, filterFields };
}

async function getMarketsPageQuery() {
  if (_marketsQueryCache) return _marketsQueryCache;
  const { selection, filterFields } = await getMarketSelection();
  const filterClause = filterFields.has('isResolved')
    ? 'filter: { isResolved: false }, '
    : '';
  _marketsQueryCache = `query AllMarkets($first: Int!, $after: String) {
    markets(${filterClause}pagination: { first: $first, after: $after }) {
      edges {
        node {
          ${selection}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  return _marketsQueryCache;
}

// Direct single-market lookup via GraphQL market(id:). Used when the cache
// hasn't been populated (e.g. /probe before any discovery, or markets in
// MARKET_IDS env that aren't on the auto-discover list).
export async function getMarketDirect(id) {
  const { selection } = await getMarketSelection();
  const query = `query GetSingleMarket($id: ID!) {
    market(id: $id) {
      ${selection}
    }
  }`;
  const data = await postGraphQL(query, { id: String(id) }, 'GetSingleMarket');
  return data?.market ?? null;
}

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
      const query = await getMarketsPageQuery();
      data = await postGraphQL(query, { first: pageSize, after }, 'AllMarkets');
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

// Look up a market without triggering a full list scan. Returns the cached
// entry if the cache is already populated, otherwise falls back to a
// direct GraphQL market(id:) call. Used by getMarketRewardSummary and the
// /probe handler — anywhere that wants one market without paying for
// loading thousands.
export async function getMarketByIdFast(id) {
  if (_cache.byId) {
    const hit = _cache.byId.get(String(id));
    if (hit) return hit;
  }
  return getMarketDirect(id);
}

// Resolve a Predict.fun URL or slug to the friendly numeric market id by
// scanning the cached GraphQL market list and matching slugify(title).
// Triggers cache load if cold. Returns null if no match.
export async function resolveSlugToId(slug, slugifier) {
  const all = await getAllMarketsCached();
  for (const m of all) {
    if (slugifier(m.title) === slug) return String(m.id);
    if (slugifier(m.question) === slug) return String(m.id);
  }
  return null;
}

const CLOSED_STATUSES = new Set([
  'CLOSED', 'RESOLVED', 'PAUSED', 'CANCELLED', 'CANCELED',
  'ARCHIVED', 'EXPIRED', 'SETTLED', 'INACTIVE',
]);

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Predict.fun's GraphQL Market type doesn't expose endsAt. For dated
// titles like "Bitcoin Up or Down - May 2, 11:45AM-12PM ET" or
// "BNB up or down (May 2 2026 2am ET)", parse the end time directly
// from the title text. This lets MIN_REMAINING_HOURS actually filter
// short-lived intraday markets.
export function parseEndFromTitle(title) {
  if (!title) return null;
  const monthMatch = title.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:[,\s]+(20\d{2}))?/i);
  if (!monthMatch) return null;
  const month = MONTHS[monthMatch[1].slice(0, 3).toLowerCase()];
  const day = Number(monthMatch[2]);
  const year = monthMatch[3] ? Number(monthMatch[3]) : new Date().getUTCFullYear();
  // Find the last time before "ET" — for "11:45AM-12PM ET" this is "12PM".
  const timeMatch = title.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? 0);
  const ampm = timeMatch[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  // ET offset: EDT (UTC-4) Mar-Nov, EST (UTC-5) Dec-Feb. Approximate
  // since exact DST boundaries vary by 1h once per year.
  const isEdt = month >= 2 && month <= 10;
  const utcHour = hour + (isEdt ? 4 : 5);
  return Date.UTC(year, month, day, utcHour, minute);
}

export function marketEndMs(m) {
  if (!m) return null;
  for (const f of ['endsAt', 'endTime', 'endsAtTimestamp', 'closeTime']) {
    const v = m[f];
    if (v == null || v === '') continue;
    const ts = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    if (Number.isFinite(ts)) return ts;
  }
  // Fallback: parse the end time from the title (Predict.fun GraphQL
  // doesn't expose a real end-time field for many markets).
  return parseEndFromTitle(m.title);
}

export function isMarketTradeable(m) {
  if (!m) return false;
  if (m.isResolved === true) return false;
  if (m.resolvedAt != null) return false;
  const status = String(m.tradingStatus ?? m.status ?? '').toUpperCase();
  if (status && CLOSED_STATUSES.has(status)) return false;
  const endMs = marketEndMs(m);
  if (endMs != null && endMs <= Date.now()) return false;
  return true;
}

// Reward + orderbook key lookup that the rest of the bot uses. Reads from
// the cached REST market list (no per-market GraphQL).
export async function getMarketRewardSummary(marketId) {
  let market = null;
  try {
    market = await getMarketByIdFast(marketId);
  } catch (err) {
    console.warn(new Date().toISOString(), '[predict] getMarketByIdFast failed:', err.message);
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
  try {
    const json = await fetchJson(url, {
      headers: restHeaders(),
      timeoutMs: config.orderbookTimeoutMs ?? 10_000,
      retries: 1,
    });
    return { kind: 'ok', url, json };
  } catch (err) {
    if (err.status === 404) return { kind: '404', url };
    return { kind: 'err', url, status: err.status, body: err.body ?? err.message };
  }
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
