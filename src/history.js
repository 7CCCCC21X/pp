import fs from 'node:fs/promises';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { config } from './config.js';

export async function appendHistory(record) {
  if (!config.historyEnabled) return;
  const line = JSON.stringify({ ts: Date.now(), ...record }) + '\n';
  await fs.appendFile(config.historyFile, line);
}

export async function readHistorySince(sinceMs) {
  if (!config.historyEnabled) return [];
  try {
    await fs.access(config.historyFile);
  } catch {
    return [];
  }
  const out = [];
  const stream = createReadStream(config.historyFile, 'utf8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.ts >= sinceMs) out.push(rec);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function summarize24h(records) {
  const byMarket = new Map();
  for (const r of records) {
    const id = r.marketId;
    if (!id) continue;
    const slot = byMarket.get(id) ?? {
      marketId: id,
      title: r.title ?? null,
      moves: 0,
      stallAlerts: 0,
      jumpAlerts: 0,
      wideSpreadAlerts: 0,
      emptyBookAlerts: 0,
      rewardZoneAlerts: 0,
      lastHourlyRate: null,
      maxStallMs: 0,
      ppEarned: 0,
      observedMs: 0,
    };
    if (r.title && !slot.title) slot.title = r.title;
    if (r.event === 'move') slot.moves += 1;
    if (r.event === 'rate') {
      if (Number.isFinite(r.ppEarned)) slot.ppEarned += r.ppEarned;
      if (Number.isFinite(r.dtMs)) slot.observedMs += r.dtMs;
      if (Number.isFinite(r.hourlyRate)) slot.lastHourlyRate = r.hourlyRate;
    }
    if (r.event === 'alert') {
      if (r.kind === 'stall') slot.stallAlerts += 1;
      if (r.kind === 'mid_jump') slot.jumpAlerts += 1;
      if (r.kind === 'wide_spread') slot.wideSpreadAlerts += 1;
      if (r.kind === 'empty_book') slot.emptyBookAlerts += 1;
      if (r.kind === 'reward_zone') slot.rewardZoneAlerts += 1;
      if (r.kind === 'stall' && Number.isFinite(r.elapsedMs)) {
        slot.maxStallMs = Math.max(slot.maxStallMs, r.elapsedMs);
      }
    }
    if (Number.isFinite(r.totalHourlyRate) && slot.lastHourlyRate == null) {
      slot.lastHourlyRate = r.totalHourlyRate;
    }
    byMarket.set(id, slot);
  }
  return [...byMarket.values()];
}
