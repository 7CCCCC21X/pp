import fs from 'node:fs/promises';
import { config } from './config.js';

function emptyState() {
  return {
    markets: {},
    manualIds: [],
    pausedIds: [],
    removedIds: [],
    autoIds: [],
    watchedIds: [],
    snoozes: {},          // marketId -> unix ms when snooze ends
    overrides: {},        // marketId -> partial config override
    allowedChats: [],     // runtime-managed whitelist (private chats / groups)
    quietUntil: 0,        // global silence until this unix ms (0 = off)
    botPausedUntil: 0,    // global bot pause: 0 = off, -1 = indefinite, >0 = until unix ms; while paused the tick loop makes no API calls
    alertKinds: {},       // per-kind on/off override; missing = use config default
    priceSanity: {},      // ladderKey -> { alertedAt } cooldown for cross-market定价异常 alerts
    priceSanityMuted: {}, // ladderToken -> { key, context, mutedAt } muted ladders (via alert button)
    priceSanityExtExclude: null, // cents; runtime override for extreme-price exclusion (null = use env default)
    comboMaxCents: null,  // cents; /combo adjacent-pair combined-cost cap (null = 110 default)
    snapshots: {},        // marketId -> { intervalMs, lastSentAt } (periodic orderbook snapshot)
    chatRouting: {},      // chatId -> { exclude: [kind, ...] } per-chat alert filter
    chatDigests: {},      // chatId -> { intervalMs, queue, lastFlushAt } batched-alert mode
    marketFirstSeen: {},  // marketId -> { ms, title, rate, endMs } — first time we saw it as rewarded (powers /new)
    hourlyDigestOnly: false,   // true = suppress per-alert sends, keep only the hourly summary
    hourlyDigestExtExclude: 94, // exclude markets with a side ≥N¢ (or ≤(100-N)¢) from the hourly digest; 0 = off
    customExtPresets: [],      // user-added 极端价 filter values (tokens like "80" / "i80") kept as wizard buttons
    lastDiscoveryAt: 0,
    lastDigestSentAt: 0,
    lastHourlyDigestAt: 0,
    lastHistoryPruneAt: 0,
    telegramOffset: 0,
    filters: {},
  };
}

export async function loadState() {
  try {
    const text = await fs.readFile(config.stateFile, 'utf8');
    const json = JSON.parse(text);
    const base = emptyState();
    if (!json || typeof json !== 'object') return base;
    return {
      ...base,
      ...json,
      markets: { ...base.markets, ...(json.markets ?? {}) },
      manualIds: json.manualIds ?? [],
      pausedIds: json.pausedIds ?? [],
      removedIds: json.removedIds ?? [],
      autoIds: json.autoIds ?? [],
      watchedIds: json.watchedIds ?? [],
      snoozes: json.snoozes ?? {},
      overrides: json.overrides ?? {},
      allowedChats: json.allowedChats ?? [],
      quietUntil: json.quietUntil ?? 0,
      botPausedUntil: Number.isFinite(json.botPausedUntil) ? json.botPausedUntil : 0,
      alertKinds: json.alertKinds ?? {},
      priceSanity: json.priceSanity ?? {},
      priceSanityMuted: json.priceSanityMuted ?? {},
      priceSanityExtExclude: Number.isFinite(json.priceSanityExtExclude) ? json.priceSanityExtExclude : null,
      comboMaxCents: Number.isFinite(json.comboMaxCents) ? json.comboMaxCents : null,
      snapshots: json.snapshots ?? {},
      chatRouting: json.chatRouting ?? {},
      chatDigests: json.chatDigests ?? {},
      marketFirstSeen: json.marketFirstSeen ?? {},
      customExtPresets: Array.isArray(json.customExtPresets) ? json.customExtPresets : [],
      filters: json.filters ?? {},
    };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function saveState(state) {
  const tmp = `${config.stateFile}.tmp`;
  // Compact JSON (no pretty-print) — the file is written every tick and
  // every command; with hundreds of market slots the indentation roughly
  // doubles both the stringify cost and the bytes written.
  // `recentBook` is deliberately dropped: it's the multi-level book from
  // the most recent wizard refetch, only meaningful for minutes, and at
  // ORDERBOOK_DEPTH×2 rows per market it dominates the file size. It
  // stays in memory; a restart just means depth filters wait for the
  // next 🚀 refetch, which they'd need for fresh prices anyway.
  const json = JSON.stringify(state, (key, value) => (
    key === 'recentBook' ? undefined : value
  ));
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, config.stateFile);
}

// Returns true if the market is currently snoozed (paused with an end time
// that hasn't elapsed). Cleans up the entry if it has expired.
export function isSnoozed(state, marketId) {
  const until = state.snoozes?.[marketId];
  if (!until) return false;
  if (Date.now() >= until) {
    delete state.snoozes[marketId];
    return false;
  }
  return true;
}

// Global bot pause (/pausebot). Unlike /quiet — which still polls and just
// suppresses alert delivery — a paused bot skips the whole tick: no market
// polls, no discovery, no digests, zero upstream API calls. The command
// loop keeps running so /resumebot can un-pause. Auto-clears an expired
// timed pause (mirrors isSnoozed).
export function isBotPaused(state, now = Date.now()) {
  const until = state?.botPausedUntil ?? 0;
  if (!until) return false;
  if (until === -1) return true;
  if (now >= until) {
    state.botPausedUntil = 0;
    return false;
  }
  return true;
}

// Gap-aware orderbook stall duration. Raw `now - lastChangeAt` over-counts
// because it folds in wall-clock time the monitor wasn't actually watching
// the book — bot downtime, fetch errors, restarts — and reports it as
// "stalled". The monitor instead accumulates `slot.stallMs` from the
// per-tick observed delta (capped at 2× the poll interval, the same guard
// the rate accounting uses), so only time we genuinely saw an unchanged
// book counts. Here we add the (also capped) sliver since the last
// successful observation so a between-ticks read stays live without
// inflating during a gap. Falls back to the legacy timestamp for slots
// persisted before stallMs existed.
export function stallDurationMs(slot, now = Date.now()) {
  if (!slot) return null;
  if (Number.isFinite(slot.stallMs)) {
    const since = Number.isFinite(slot.lastObservedAt)
      ? Math.min(Math.max(now - slot.lastObservedAt, 0), 2 * config.pollIntervalMs)
      : 0;
    return slot.stallMs + since;
  }
  return Number.isFinite(slot.lastChangeAt) ? Math.max(0, now - slot.lastChangeAt) : null;
}

// Per-market threshold override. Returns the effective value for a knob,
// preferring the per-market override if set, otherwise the global default.
export function effectiveOverride(state, marketId, key, fallback) {
  const v = state.overrides?.[marketId]?.[key];
  return v != null && Number.isFinite(v) ? v : fallback;
}

// Admin = the TELEGRAM_CHAT_ID env owner. Two flavours because chatId
// and userId only coincide in private chats:
//   isAdminChat: this conversation is the admin's private DM with bot.
//   isAdminUser: the message author is the admin (works in groups too).
// /activate / /whitelist gate on isAdminUser so admin can use them from
// any chat they're personally in.
export function isAdminChat(chatId) {
  if (chatId == null || chatId === '') return false;
  if (!config.telegramChatId) return false;
  return String(chatId) === String(config.telegramChatId);
}

export function isAdminUser(userId) {
  if (userId == null || userId === '') return false;
  if (!config.telegramChatId) return false;
  return String(userId) === String(config.telegramChatId);
}

// Permitted = admin OR runtime-whitelisted OR env-whitelisted. Used for
// command access AND broadcast targeting (alerts, digest, autodiscover).
export function isPermittedChat(state, chatId) {
  if (chatId == null || chatId === '') return false;
  const id = String(chatId);
  if (id === String(config.telegramChatId)) return true;
  if (config.telegramAllowedChats.includes(id)) return true;
  return (state?.allowedChats ?? []).includes(id);
}

// Deduped list of every chat that should receive broadcasts.
export function broadcastChats(state) {
  const out = new Set();
  if (config.telegramChatId) out.add(String(config.telegramChatId));
  for (const id of config.telegramAllowedChats) out.add(String(id));
  for (const id of (state?.allowedChats ?? [])) out.add(String(id));
  return [...out];
}

export function addAllowedChat(state, chatId) {
  const id = String(chatId);
  if (!state.allowedChats) state.allowedChats = [];
  if (state.allowedChats.includes(id)) return false;
  state.allowedChats.push(id);
  return true;
}

export function removeAllowedChat(state, chatId) {
  const id = String(chatId);
  if (!state.allowedChats?.length) return false;
  const idx = state.allowedChats.indexOf(id);
  if (idx < 0) return false;
  state.allowedChats.splice(idx, 1);
  return true;
}

// Record first-sighting timestamps for newly-discovered rewarded markets so
// /new can surface "what came online today". On the very first call (empty
// map) every market is tagged with ms=0 instead of now() — a fresh install
// would otherwise flag thousands of pre-existing markets as "new today".
// Prunes entries older than 14d (and not bootstrap=0) to keep the map lean.
export function recordMarketFirstSeen(state, markets) {
  if (!Array.isArray(markets) || !markets.length) return { added: 0, pruned: 0 };
  const map = state.marketFirstSeen ?? {};
  const bootstrap = Object.keys(map).length === 0;
  const now = Date.now();
  let added = 0;
  for (const m of markets) {
    const id = String(m?.id ?? '');
    if (!id) continue;
    if (map[id] != null) continue;
    map[id] = {
      ms: bootstrap ? 0 : now,
      title: m?.title ?? null,
      question: m?.question ?? null,
      rate: Number.isFinite(m?.hourlyRate) ? m.hourlyRate : null,
      endMs: Number.isFinite(m?.endMs) ? m.endMs : null,
    };
    if (!bootstrap) added += 1;
  }
  state.marketFirstSeen = map;
  const pruned = pruneMarketFirstSeen(state, now);
  return { added, pruned };
}

// Drop first-seen entries older than 14d (keeping the ms=0 bootstrap
// sentinels). Called both from recordMarketFirstSeen and from the tick
// loop directly — if discovery is disabled or keeps failing, the map
// must still shrink over time.
export function pruneMarketFirstSeen(state, now = Date.now()) {
  const map = state.marketFirstSeen;
  if (!map) return 0;
  const cutoff = now - 14 * 24 * 3600 * 1000;
  let pruned = 0;
  for (const [id, info] of Object.entries(map)) {
    const ms = typeof info === 'number' ? info : info?.ms;
    if (!Number.isFinite(ms) || ms === 0) continue; // keep bootstrap sentinels
    if (ms < cutoff) {
      delete map[id];
      pruned += 1;
    }
  }
  return pruned;
}

export function activeMarketIds(state) {
  const set = new Set();
  for (const id of config.marketIds) set.add(String(id));
  for (const id of state.manualIds) set.add(String(id));
  for (const id of state.autoIds) set.add(String(id));
  for (const id of (state.watchedIds ?? [])) set.add(String(id));
  for (const id of state.removedIds) set.delete(String(id));
  return [...set];
}
