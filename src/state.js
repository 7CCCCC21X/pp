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
    alertKinds: {},       // per-kind on/off override; missing = use config default
    snapshots: {},        // marketId -> { intervalMs, lastSentAt } (periodic orderbook snapshot)
    chatRouting: {},      // chatId -> { exclude: [kind, ...] } per-chat alert filter
    lastDiscoveryAt: 0,
    lastDigestSentAt: 0,
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
      alertKinds: json.alertKinds ?? {},
      snapshots: json.snapshots ?? {},
      chatRouting: json.chatRouting ?? {},
      filters: json.filters ?? {},
    };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function saveState(state) {
  const tmp = `${config.stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
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

export function activeMarketIds(state) {
  const set = new Set();
  for (const id of config.marketIds) set.add(String(id));
  for (const id of state.manualIds) set.add(String(id));
  for (const id of state.autoIds) set.add(String(id));
  for (const id of (state.watchedIds ?? [])) set.add(String(id));
  for (const id of state.removedIds) set.delete(String(id));
  return [...set];
}
