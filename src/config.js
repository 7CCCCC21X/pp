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

function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(v);
}

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  predictApiKey: process.env.PREDICT_API_KEY ?? '',
  marketIds: (process.env.MARKET_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  pollIntervalMs: num('POLL_INTERVAL_MS', 5 * 60 * 1000),
  staleHours: num('STALE_HOURS', 6),
  priceEpsilon: num('PRICE_EPSILON', 0.001),
  trackSize: bool('TRACK_SIZE', false),
  sizeRelativeEpsilon: num('SIZE_RELATIVE_EPSILON', 0.10),
  sizeAbsoluteMin: num('SIZE_ABSOLUTE_MIN', 10),
  skipNoReward: bool('SKIP_NO_REWARD', true),
  stateFile: process.env.STATE_FILE ?? './state.json',
  graphqlUrl: process.env.GRAPHQL_URL ?? 'https://graphql.predict.fun/graphql',
  restUrl: (process.env.REST_URL ?? 'https://api.predict.fun/v1').replace(/\/$/, ''),
};

export function validateConfig() {
  const errors = [];
  if (!config.telegramBotToken) errors.push('TELEGRAM_BOT_TOKEN is required');
  if (!config.telegramChatId) errors.push('TELEGRAM_CHAT_ID is required');
  if (!config.marketIds.length) errors.push('MARKET_IDS is required (comma-separated)');
  if (config.staleHours <= 0) errors.push('STALE_HOURS must be > 0');
  if (config.pollIntervalMs < 5_000) errors.push('POLL_INTERVAL_MS must be >= 5000');
  if (errors.length) {
    throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
  }
}
