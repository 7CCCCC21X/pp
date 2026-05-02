import fs from 'node:fs';

function loadDotEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadDotEnv();

function num(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric, got "${v}"`);
  return n;
}

function numOrNull(name) {
  const v = process.env[name];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  if (/^(1|true|yes|y|on)$/i.test(v)) return true;
  if (/^(0|false|no|n|off)$/i.test(v)) return false;
  throw new Error(`${name} must be a boolean (true/false/1/0/yes/no), got "${v}"`);
}

function buildFilterDefaults() {
  const out = {};
  const depth = 3;
  for (const side of ['Bid', 'Ask']) {
    for (let lvl = 1; lvl <= depth; lvl++) {
      for (const op of ['min', 'max']) {
        for (const attr of ['Price', 'Size']) {
          if (op === 'max' && attr === 'Size') continue;
          const key = `${op}${side}${lvl}${attr}`;
          const env = 'FILTER_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
          out[key] = numOrNull(env);
        }
      }
    }
  }
  return out;
}

function csv(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  telegramAllowedChats: csv('TELEGRAM_ALLOWED_CHATS'),
  telegramCommandsEnabled: bool('TELEGRAM_COMMANDS', true),

  predictApiKey: process.env.PREDICT_API_KEY ?? '',
  marketIds: csv('MARKET_IDS'),

  pollIntervalMs: num('POLL_INTERVAL_MS', 5 * 60 * 1000),

  // Stall alert
  alertStall: bool('ALERT_STALL', true),
  staleHours: num('STALE_HOURS', 6),
  priceEpsilon: num('PRICE_EPSILON', 0.001),
  trackSize: bool('TRACK_SIZE', false),
  sizeRelativeEpsilon: num('SIZE_RELATIVE_EPSILON', 0.10),
  sizeAbsoluteMin: num('SIZE_ABSOLUTE_MIN', 10),

  // Wide-spread alert (reward zone health)
  alertWideSpread: bool('ALERT_WIDE_SPREAD', true),
  maxSpread: num('MAX_SPREAD', 0.04),
  wideSpreadMinMinutes: num('WIDE_SPREAD_MIN_MINUTES', 15),

  // Mid-jump alert
  alertMidJump: bool('ALERT_MID_JUMP', true),
  midJumpThreshold: num('MID_JUMP_THRESHOLD', 0.05),
  midJumpCooldownMs: num('MID_JUMP_COOLDOWN_MS', 15 * 60 * 1000),

  // Empty-book alert
  alertEmptyBook: bool('ALERT_EMPTY_BOOK', true),
  emptyBookMinMinutes: num('EMPTY_BOOK_MIN_MINUTES', 30),

  // Reward-zone alert: detect markets where the top of book sits outside
  // Predict.fun's reward zone (orders too far from mid OR too small) so PP
  // is up for grabs. Per-market spreadThreshold / shareThreshold from the
  // market object override these defaults when present.
  alertRewardZone: bool('ALERT_REWARD_ZONE', true),
  rewardZoneMaxDistance: num('REWARD_ZONE_MAX_DISTANCE', 0.06),
  rewardZoneMinSize: num('REWARD_ZONE_MIN_SIZE', 100),
  rewardZoneMinMinutes: num('REWARD_ZONE_MIN_MINUTES', 15),

  // Recovery alerts: when a previously-alerted condition clears, send a
  // short "back to normal" message so you know it resolved without having
  // to check /status manually.
  alertRecovery: bool('ALERT_RECOVERY', true),

  // Per-market cross-type alert cooldown. After ANY non-watch alert fires
  // on a market, suppress further alerts on the same market for this
  // many ms. Stops the same illiquid market from triggering wide_spread +
  // reward_zone + empty_book back-to-back.
  marketAlertCooldownMs: num('MARKET_ALERT_COOLDOWN_MS', 10 * 60 * 1000),

  // /thin command: list markets where best bid + best ask total $ value
  // is at or below this threshold. "Thin" = nobody has serious money on
  // top of book, easy to dominate by placing your own orders. USD.
  lowDepthThreshold: num('LOW_DEPTH_THRESHOLD', 100),

  skipNoReward: bool('SKIP_NO_REWARD', true),

  // Filters: a market only emits alerts when its top-N book passes ALL set
  // filters. null/empty = no filter on that dimension. Env names follow
  // FILTER_<MIN|MAX>_<BID|ASK><1..3>_<PRICE|SIZE>, e.g. FILTER_MIN_BID1_PRICE.
  // Live overrides via /setfilter live in state.filters.
  filters: buildFilterDefaults(),

  // Auto-discovery
  autodiscover: bool('AUTODISCOVER', false),
  discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 60 * 60 * 1000),
  discoveryMaxMarkets: num('DISCOVERY_MAX_MARKETS', 200),
  // Skip auto-discovered markets whose total hourlyRate is below this. Useful
  // for filtering out short-lived high-frequency markets (like 15-min Bitcoin
  // up/down) that clutter the watchlist but never trigger stall alerts.
  minHourlyRate: num('MIN_HOURLY_RATE', 0),
  // Skip auto-discovered markets ending within this many hours from now.
  // Useful for filtering out 15-min Bitcoin Up/Down markets that resolve
  // before STALE_HOURS could ever fire. Default = STALE_HOURS so a stall
  // alert at least has a chance of firing before the market closes.
  minRemainingHours: num('MIN_REMAINING_HOURS', num('STALE_HOURS', 6)),

  // History + daily digest
  historyEnabled: bool('HISTORY_ENABLED', true),
  historyFile: process.env.HISTORY_FILE ?? './history.jsonl',
  // Auto-prune history older than this many days. 0 disables.
  historyKeepDays: num('HISTORY_KEEP_DAYS', 14),
  digestEnabled: bool('DAILY_DIGEST_ENABLED', true),
  digestHourUtc: num('DAILY_DIGEST_HOUR_UTC', 12),

  stateFile: process.env.STATE_FILE ?? './state.json',
  graphqlUrl: process.env.GRAPHQL_URL ?? 'https://graphql.predict.fun/graphql',
  restUrl: (process.env.REST_URL ?? 'https://api.predict.fun/v1').replace(/\/$/, ''),

  // Orderbook URL shape. {key} is replaced with market[ORDERBOOK_KEY_FIELD].
  // Default `conditionId` matches predict.fun's REST API. The bot self-heals
  // by trying alternate (path, field) combinations on 404 and caching the
  // working combo per market in state.json.
  orderbookPathTemplate: process.env.ORDERBOOK_PATH_TEMPLATE ?? '/markets/{key}/orderbook',
  orderbookKeyField: process.env.ORDERBOOK_KEY_FIELD ?? 'conditionId',

  // How long to cache the REST market list (used by both auto-discovery
  // and per-market reward lookup). Default 10 minutes.
  marketsCacheTtlMs: num('MARKETS_CACHE_TTL_MS', 10 * 60 * 1000),

  // Per-page GraphQL request timeout. Hangs in pagination get aborted
  // after this many ms; the loop returns whatever has already been
  // collected.
  graphqlTimeoutMs: num('GRAPHQL_TIMEOUT_MS', 30_000),
  // Per-orderbook-fetch timeout (REST). Lower than GraphQL because the
  // bot fetches one per market per tick.
  orderbookTimeoutMs: num('ORDERBOOK_TIMEOUT_MS', 10_000),
};

// HTTP headers + URLs are ASCII-only. If the user pasted a token with
// fullwidth Chinese punctuation (e.g. （ instead of ( ) the resulting
// fetch throws a cryptic "Cannot convert argument to a ByteString" per
// request. Catch it at startup with a clear message instead.
function ensureAsciiOnly(name, value) {
  if (!value) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      const ch = value[i];
      return `${name} contains non-ASCII character "${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')}) at position ${i}. Most likely a fullwidth Chinese punctuation - re-paste the value from the original source (not from a chat app).`;
    }
  }
  return null;
}

export function validateConfig() {
  const errors = [];
  const warnings = [];
  if (!config.telegramBotToken) errors.push('TELEGRAM_BOT_TOKEN is required');
  if (!config.telegramChatId) errors.push('TELEGRAM_CHAT_ID is required');
  for (const [name, value] of [
    ['TELEGRAM_BOT_TOKEN', config.telegramBotToken],
    ['TELEGRAM_CHAT_ID', String(config.telegramChatId ?? '')],
    ['PREDICT_API_KEY', config.predictApiKey],
  ]) {
    const issue = ensureAsciiOnly(name, value);
    if (issue) errors.push(issue);
  }
  if (!config.marketIds.length && !config.autodiscover) {
    // Soft warning — bot can still serve /add and other commands.
    warnings.push('No MARKET_IDS and AUTODISCOVER=false. Bot will idle until you /add a market or set AUTODISCOVER=true.');
  }
  if (config.staleHours <= 0) errors.push('STALE_HOURS must be > 0');
  if (config.pollIntervalMs < 5_000) errors.push('POLL_INTERVAL_MS must be >= 5000');
  if (config.digestHourUtc < 0 || config.digestHourUtc > 23) {
    errors.push('DAILY_DIGEST_HOUR_UTC must be 0..23');
  }
  if (config.priceEpsilon <= 0) errors.push('PRICE_EPSILON must be > 0');
  if (config.maxSpread <= 0 || config.maxSpread >= 1) {
    errors.push('MAX_SPREAD must be in (0, 1)');
  }
  if (config.midJumpThreshold <= 0 || config.midJumpThreshold >= 1) {
    errors.push('MID_JUMP_THRESHOLD must be in (0, 1)');
  }
  if (config.rewardZoneMaxDistance <= 0 || config.rewardZoneMaxDistance >= 1) {
    errors.push('REWARD_ZONE_MAX_DISTANCE must be in (0, 1)');
  }
  if (config.rewardZoneMinSize < 0) errors.push('REWARD_ZONE_MIN_SIZE must be >= 0');
  if (config.discoveryMaxMarkets < 0) errors.push('DISCOVERY_MAX_MARKETS must be >= 0');
  if (config.discoveryIntervalMs < 60_000) errors.push('DISCOVERY_INTERVAL_MS must be >= 60000');
  if (config.marketsCacheTtlMs < 10_000) errors.push('MARKETS_CACHE_TTL_MS must be >= 10000');
  if (config.graphqlTimeoutMs < 1_000) errors.push('GRAPHQL_TIMEOUT_MS must be >= 1000');
  if (config.orderbookTimeoutMs < 1_000) errors.push('ORDERBOOK_TIMEOUT_MS must be >= 1000');
  if (config.minHourlyRate < 0) errors.push('MIN_HOURLY_RATE must be >= 0');
  if (config.minRemainingHours < 0) errors.push('MIN_REMAINING_HOURS must be >= 0');
  if (config.historyKeepDays < 0) errors.push('HISTORY_KEEP_DAYS must be >= 0');
  for (const k of Object.keys(config.filters)) {
    const v = config.filters[k];
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      errors.push(`FILTER ${k} must be a non-negative number`);
    }
  }
  if (errors.length) {
    throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
  }
  for (const w of warnings) {
    console.warn(new Date().toISOString(), '[config] WARN:', w);
  }
}

export function isAllowedChat(chatId) {
  const id = String(chatId);
  if (id === String(config.telegramChatId)) return true;
  return config.telegramAllowedChats.includes(id);
}
