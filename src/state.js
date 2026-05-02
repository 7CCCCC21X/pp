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

export function activeMarketIds(state) {
  const set = new Set();
  for (const id of config.marketIds) set.add(String(id));
  for (const id of state.manualIds) set.add(String(id));
  for (const id of state.autoIds) set.add(String(id));
  for (const id of (state.watchedIds ?? [])) set.add(String(id));
  for (const id of state.removedIds) set.delete(String(id));
  return [...set];
}
