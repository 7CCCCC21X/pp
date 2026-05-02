import { config } from './config.js';

function restHeaders() {
  const h = { Accept: 'application/json' };
  if (config.predictApiKey) h['x-api-key'] = config.predictApiKey;
  return h;
}

// Recursively pull every numeric `hourlyRate` (or alias) out of an
// arbitrary REST `rewards` payload and sum them. Handles arrays, nested
// objects, and absent fields.
export function extractHourlyRate(rewards) {
  if (rewards == null) return 0;
  if (typeof rewards === 'number') return Number.isFinite(rewards) ? rewards : 0;
  if (Array.isArray(rewards)) {
    let total = 0;
    for (const item of rewards) total += extractHourlyRate(item);
    return total;
  }
  if (typeof rewards === 'object') {
    let total = 0;
    for (const [k, v] of Object.entries(rewards)) {
      if (k === 'hourlyRate' || k === 'hourly_rate' || k === 'hourly' || k === 'rate') {
        const n = Number(v);
        if (Number.isFinite(n)) total += n;
      } else if (typeof v === 'object' && v !== null) {
        total += extractHourlyRate(v);
      }
    }
    return total;
  }
  return 0;
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

// Paginate the REST /v1/markets endpoint using the last item's id as the
// `after` cursor (matches the docs `?first=&after=`).
export async function listAllMarkets({ pageSize = 100, maxPages = 50 } = {}) {
  const seen = new Map();
  let lastId = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ first: String(pageSize) });
    if (lastId != null) params.set('after', String(lastId));
    const url = `${config.restUrl}/markets?${params.toString()}`;
    const res = await fetch(url, { headers: restHeaders() });
    if (!res.ok) {
      throw new Error(`listMarkets ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const arr = unwrapList(await res.json());
    if (!arr.length) break;
    let progress = 0;
    for (const m of arr) {
      const id = m?.id;
      if (id == null || seen.has(id)) continue;
      seen.set(id, m);
      progress += 1;
    }
    if (!progress) break;
    if (arr.length < pageSize) break;
    const newLast = arr[arr.length - 1]?.id;
    if (newLast == null || newLast === lastId) break;
    lastId = newLast;
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
  const totalHourlyRate = extractHourlyRate(market.rewards);
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
