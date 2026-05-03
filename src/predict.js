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

// A rewardTiming entry is "active" if now is within its [startsAt, endsAt]
// window. Predict.fun keeps historical timings in the array — once an
// event has ended the past window's hourlyRate is still listed but no
// longer pays out, so summing all entries blindly overcounts.
function isTimingActive(t, now) {
  if (!t || typeof t !== 'object') return false;
  const tsOf = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : null;
  };
  for (const k of ['startsAt', 'startTime', 'startAt']) {
    const ts = tsOf(t[k]);
    if (ts != null && ts > now) return false; // future
  }
  for (const k of ['endsAt', 'endTime', 'endAt']) {
    const ts = tsOf(t[k]);
    if (ts != null && ts <= now) return false; // ended
  }
  if (t.isActive === false) return false;
  return true;
}

export function extractHourlyRate(marketOrRewards) {
  if (marketOrRewards == null) return 0;
  // PRIMARY: REST `rewards.current.hourlyRate` is Predict.fun's authoritative
  // current rate (already accounts for time windows). Schedule entries
  // before/after `current` are past/future periods we shouldn't sum.
  const cur = marketOrRewards?.rewards?.current?.hourlyRate;
  if (cur != null) {
    const n = Number(cur);
    return Number.isFinite(n) ? n : 0;
  }
  // SECONDARY: REST `rewards.schedule[]` — pick the entry whose
  // [startsAt, endsAt] window contains now.
  if (Array.isArray(marketOrRewards?.rewards?.schedule)) {
    const now = Date.now();
    const active = marketOrRewards.rewards.schedule.find((s) => isTimingActive(s, now));
    if (active != null) {
      const n = Number(active.hourlyRate);
      return Number.isFinite(n) ? n : 0;
    }
    // No active schedule entry → 0 (e.g. between rewards or post-event).
    return 0;
  }
  // FALLBACK: GraphQL `rewardTimings` array. Predict.fun's GraphQL doesn't
  // expose start/end on these entries, so we apply isTimingActive
  // permissively (treats no-bound entries as active). Sum may overcount
  // for markets with multiple historical timings — REST is the safer
  // source when both are present.
  if (Array.isArray(marketOrRewards?.rewardTimings)) {
    const now = Date.now();
    // Belt to REST's suspenders: if the market itself has a parseable
    // end time in the past (from endsAt field or "Bitcoin Up or Down -
    // May 3, 5AM-5:15AM ET" style titles), the bound-less rewardTimings
    // are stale even if Predict.fun still returns them. Stops a
    // GraphQL-only fallback from hallucinating 3000/h on ended markets.
    const endMs = marketEndMs(marketOrRewards);
    if (endMs != null && endMs <= now) return 0;
    return marketOrRewards.rewardTimings
      .filter((r) => isTimingActive(r, now))
      .map((r) => Number(r?.hourlyRate))
      .filter(Number.isFinite)
      .reduce((a, b) => a + b, 0);
  }
  // If passed a market object with a generic `rewards` field, recurse.
  if (marketOrRewards && typeof marketOrRewards === 'object' && 'rewards' in marketOrRewards) {
    return sumHourlyRateRecursive(marketOrRewards.rewards);
  }
  // Raw value.
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

// Extra fields we'd like on each rewardTimings entry, gated by whether
// the RewardTiming GraphQL type actually exposes them.
const REWARD_TIMING_OPTIONAL = ['startsAt', 'endsAt', 'startTime', 'endTime', 'isActive'];

async function getMarketSelection() {
  if (_selectionCache != null) {
    return { selection: _selectionCache, filterFields: _filterFieldsCache };
  }
  let scalarMarketFields = new Set();
  let filterFields = new Set();
  let rewardTimingFields = new Set();
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
        rewardTiming: __type(name: "RewardTiming") { fields { name } }
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
    rewardTimingFields = new Set((intro?.rewardTiming?.fields ?? []).map((f) => f.name));
  } catch {
    // Fall back to the minimal known-good query.
  }
  const fields = [];
  for (const f of REQUIRED_FIELDS) {
    if (!scalarMarketFields.size || scalarMarketFields.has(f)) fields.push(f);
  }
  // rewardTimings: always pull hourlyRate; pull start/end fields when the
  // RewardTiming type exposes them so isTimingActive() can drop expired
  // entries (a market whose only timing already ended pays 0 PP/h now).
  const timingSelected = ['hourlyRate'];
  for (const f of REWARD_TIMING_OPTIONAL) {
    if (rewardTimingFields.has(f)) timingSelected.push(f);
  }
  fields.push(`rewardTimings { ${timingSelected.join(' ')} }`);
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

// Surface freshness for /status / list footers — when did each cache last
// successfully refresh? 0 = never.
export function getCacheStats() {
  return {
    marketsAt: _cache.at,
    marketsTtlMs: config.marketsCacheTtlMs,
    marketsCount: _cache.markets?.length ?? 0,
    slugAt: _slugCache.at,
    slugCount: _slugCache.byId?.size ?? 0,
  };
}

// Force-refresh the PP/h markets cache + slug cache. Returns timing
// metadata so the /refresh command can report elapsed time. If a refresh
// is already in flight, awaits it instead of starting a duplicate.
export async function refreshAllCaches() {
  const t0 = Date.now();
  _cache.at = 0;        // invalidate so getAllMarketsCached re-fetches
  _slugCache.at = 0;
  let markets = [];
  let slugCount = 0;
  let error = null;
  try {
    markets = await getAllMarketsCached();
  } catch (err) {
    error = err.message;
  }
  try {
    const map = await getSlugMapCached();
    slugCount = map.size;
  } catch (err) {
    if (!error) error = err.message;
  }
  // Also clear the per-market REST cache so fresh slug lookups don't
  // serve stale data on next tick.
  _restMarketCache.clear();
  return {
    elapsedMs: Date.now() - t0,
    marketsCount: markets.length,
    slugCount,
    error,
  };
}

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
// REST `/v1/markets` exposes a `categorySlug` field (and sometimes
// `slug` / `marketSlug`) that maps to the actual predict.fun URL path —
// the GraphQL Market type doesn't surface this, so we run a parallel
// REST scan and cache the id → slug mapping. Refreshed on the same
// MARKETS_CACHE_TTL_MS schedule as the main GraphQL list.
let _slugCache = { at: 0, byId: null, inFlight: null };

function pickSlug(m) {
  return m?.slug || m?.marketSlug || m?.categorySlug || m?.category_slug || null;
}

export async function getSlugMapCached() {
  const ttl = config.marketsCacheTtlMs;
  const now = Date.now();
  if (_slugCache.byId && now - _slugCache.at < ttl) return _slugCache.byId;
  if (_slugCache.inFlight) return _slugCache.inFlight;
  _slugCache.inFlight = (async () => {
    const map = new Map();
    let lastId = null;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ first: '100' });
      if (lastId != null) params.set('after', String(lastId));
      const url = `${config.restUrl}/markets?${params.toString()}`;
      let arr;
      try {
        const json = await fetchJson(url, {
          headers: restHeaders(),
          timeoutMs: config.orderbookTimeoutMs ?? 10_000,
          retries: 1,
        });
        arr = unwrapList(json);
      } catch {
        break;
      }
      if (!arr.length) break;
      let progress = 0;
      for (const m of arr) {
        if (m?.id == null || map.has(String(m.id))) continue;
        const slug = pickSlug(m);
        if (slug) map.set(String(m.id), String(slug));
        progress += 1;
      }
      if (!progress) break;
      if (arr.length < 100) break;
      const newLast = arr[arr.length - 1]?.id;
      if (newLast == null || newLast === lastId) break;
      lastId = newLast;
    }
    _slugCache.byId = map;
    _slugCache.at = Date.now();
    return map;
  })().finally(() => { _slugCache.inFlight = null; });
  return _slugCache.inFlight;
}

// Fetch a single market via REST `/v1/markets/<id>` to grab fields the
// GraphQL query doesn't expose — most importantly `categorySlug` which
// is Predict.fun's actual URL slug. Returns null on any error so callers
// can fall back to the bulk slug map / title slugify chain.
const _restMarketCache = new Map();   // id -> { market, at }
const _restMarketInflight = new Map(); // id -> Promise

export async function getMarketRestById(id) {
  const key = String(id);
  const cached = _restMarketCache.get(key);
  const ttl = config.marketsCacheTtlMs;
  if (cached && Date.now() - cached.at < ttl) return cached.market;
  if (_restMarketInflight.has(key)) return _restMarketInflight.get(key);
  const p = (async () => {
    const url = `${config.restUrl}/markets/${encodeURIComponent(key)}`;
    try {
      const json = await fetchJson(url, {
        headers: restHeaders(),
        timeoutMs: config.orderbookTimeoutMs ?? 10_000,
        retries: 1,
      });
      const data = json?.data ?? json;
      const market = Array.isArray(data) ? data[0] : data;
      if (market?.id != null) {
        _restMarketCache.set(key, { market, at: Date.now() });
        return market;
      }
    } catch {
      // swallow — caller has fallbacks
    }
    return null;
  })().finally(() => _restMarketInflight.delete(key));
  _restMarketInflight.set(key, p);
  return p;
}

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
  // Fallback: parse the end time from any text field that might encode it.
  // Outcome-name markets ("Yes"/"No"/"Draw") have a useless title — the
  // dated string lives in question, categorySlug, etc. Without this loop,
  // MIN_REMAINING_HOURS lets short-lived markets through.
  for (const s of [m.title, m.question, m.categorySlug, m.slug, m.marketSlug]) {
    const ts = parseEndFromTitle(s);
    if (ts != null) return ts;
  }
  return null;
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

// Combine GraphQL + REST views of a market into a single object the
// rest of the bot uses. Pure function — exported for testability so
// the merge precedence is verifiable without spinning up the network.
//
// Field-by-field rules:
//   - title / question / conditionId / status / categorySlug:
//       prefer GraphQL, fill from REST only if missing.
//   - spreadThreshold / shareThreshold:
//       GraphQL returns 0 for markets that haven't been explicitly tuned
//       (default-tier on Predict.fun's side). 0 is "unset" downstream —
//       rewardZoneStatus falls to env default and the alert shows
//       "±6.0¢ (env)" even though REST exposes the real per-market value.
//       Always prefer REST when REST has a positive number.
//   - rewards / tradingStatus / isResolved / endsAt:
//       always REST when present — these are time-sensitive runtime
//       fields GraphQL doesn't expose reliably.
export function mergeMarket(market, rest, marketId) {
  const combined = market ? { ...market } : { id: rest?.id ?? marketId };
  if (!rest) return combined;
  for (const k of ['title', 'question', 'conditionId', 'status', 'categorySlug']) {
    if (combined[k] == null && rest[k] != null) combined[k] = rest[k];
  }
  for (const k of ['spreadThreshold', 'shareThreshold']) {
    if (Number.isFinite(rest[k]) && rest[k] > 0) combined[k] = rest[k];
  }
  if (rest.rewards != null) combined.rewards = rest.rewards;
  if (rest.tradingStatus != null) combined.tradingStatus = rest.tradingStatus;
  if (rest.isResolved != null) combined.isResolved = rest.isResolved;
  if (rest.endsAt != null) combined.endsAt = rest.endsAt;
  return combined;
}

// Reward + orderbook key lookup that the rest of the bot uses. Reads from
// the cached REST market list (no per-market GraphQL).
export async function getMarketRewardSummary(marketId) {
  // Pull both GraphQL and REST in parallel. Either source alone is
  // enough to compute a result — Predict.fun's GraphQL `market(id:)`
  // sometimes returns null for markets that REST still serves (e.g.
  // ended-but-not-resolved games where the schedule still pays).
  // Cached lookups so this is O(1) after the first hit per TTL.
  const [graphRes, restRes] = await Promise.allSettled([
    getMarketByIdFast(marketId),
    getMarketRestById(marketId),
  ]);
  const market = graphRes.status === 'fulfilled' ? graphRes.value : null;
  const rest = restRes.status === 'fulfilled' ? restRes.value : null;
  if (graphRes.status === 'rejected') {
    console.warn(new Date().toISOString(), '[predict] getMarketByIdFast failed:', graphRes.reason?.message ?? graphRes.reason);
  }
  if (!market && !rest) {
    return {
      marketId: String(marketId),
      title: null,
      totalHourlyRate: 0,
      orderbookKey: String(marketId),
      market: null,
    };
  }

  const combined = mergeMarket(market, rest, marketId);

  const totalHourlyRate = extractHourlyRate(combined);
  const preferredKey = combined[config.orderbookKeyField];
  const orderbookKey = preferredKey != null && preferredKey !== ''
    ? String(preferredKey)
    : String(combined.conditionId ?? combined.id ?? marketId);
  return {
    marketId: String(combined.id ?? marketId),
    title: combined.title ?? combined.question ?? null,
    totalHourlyRate,
    orderbookKey,
    market: combined,
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
