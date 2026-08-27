import fs from 'node:fs/promises';
import { config, validateConfig } from './config.js';
import { loadState, saveState, activeMarketIds, isSnoozed, broadcastChats, recordMarketFirstSeen, pruneMarketFirstSeen } from './state.js';
import { checkMarket, flushChatDigests, checkPriceSanity } from './monitor.js';
import { startCommandLoop } from './commands.js';
import { discoverRewardedMarkets, shouldRunDiscovery } from './discovery.js';
import { sendDailyDigest, shouldSendDigest, sendHourlyDigest, shouldSendHourlyDigest } from './digest.js';
import { broadcastTelegramMessage } from './telegram.js';

const log = (...args) => console.log(new Date().toISOString(), '[main]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[main]', ...args);

let pendingDiscovery = false;
let pendingDigest = false;
let pendingHourlyDigest = false;

// Serialize state writes so the command loop and the tick loop don't clobber.
// Each caller awaits its own save and sees its own failure (so command
// handlers can tell the user "actually didn't save"). The shared chain
// absorbs failures so the next caller still proceeds.
let saveChain = Promise.resolve();
function persist(state) {
  const next = saveChain.then(() => saveState(state));
  saveChain = next.catch(() => {}); // chain absorbs to keep going
  return next; // caller sees the original rejection
}

async function maybeDiscover(state) {
  if (!pendingDiscovery && !shouldRunDiscovery(state)) return;
  pendingDiscovery = false;
  try {
    const rewarded = await discoverRewardedMarkets();
    state.autoIds = rewarded.map((m) => String(m.id));
    const firstSeenDelta = recordMarketFirstSeen(state, rewarded);
    state.lastDiscoveryAt = Date.now();
    log(
      `discovery: ${rewarded.length} rewarded markets`,
      `(first-seen: +${firstSeenDelta.added} new, -${firstSeenDelta.pruned} pruned)`,
    );
    if (rewarded.length) {
      const preview = rewarded
        .slice(0, 10)
        .map((m) => `#${m.id} (${m.hourlyRate.toFixed(2)}/h)`)
        .join(', ');
      await broadcastTelegramMessage(
        `<b>自动发现</b>: ${rewarded.length} 个有奖励的市场\n${preview}${rewarded.length > 10 ? ' ...' : ''}`,
        { chatIds: broadcastChats(state) },
      ).catch(() => {});
    }
  } catch (err) {
    warn('discovery failed:', err.message);
  }
}

async function maybeDigest(state) {
  if (!pendingDigest && !shouldSendDigest(state)) return;
  pendingDigest = false;
  try {
    await sendDailyDigest(state);
    state.lastDigestSentAt = Date.now();
  } catch (err) {
    warn('digest failed:', err.message);
  }
}

async function maybeHourlyDigest(state) {
  if (!pendingHourlyDigest && !shouldSendHourlyDigest(state)) return;
  // Record the boundary BEFORE sending so a failed send still advances
  // the lastHourlyDigestAt cursor — otherwise a flaky push would cause
  // us to retry every tick until success, potentially spamming.
  const now = new Date();
  const boundary = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  pendingHourlyDigest = false;
  state.lastHourlyDigestAt = boundary;
  try {
    await sendHourlyDigest(state);
  } catch (err) {
    warn('hourly digest failed:', err.message);
  }
}

async function maybePruneHistory(state) {
  if (!config.historyEnabled || config.historyKeepDays <= 0) return;
  const ONE_DAY = 24 * 3600 * 1000;
  if (Date.now() - (state.lastHistoryPruneAt ?? 0) < ONE_DAY) return;
  try {
    const text = await fs.readFile(config.historyFile, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    if (!text) {
      state.lastHistoryPruneAt = Date.now();
      return;
    }
    const cutoff = Date.now() - config.historyKeepDays * ONE_DAY;
    const out = [];
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      total += 1;
      try {
        const rec = JSON.parse(line);
        if (Number.isFinite(rec?.ts) && rec.ts >= cutoff) out.push(line);
      } catch {
        // drop malformed
      }
    }
    if (out.length === total) {
      state.lastHistoryPruneAt = Date.now();
      return;
    }
    const tmp = `${config.historyFile}.tmp`;
    await fs.writeFile(tmp, out.length ? out.join('\n') + '\n' : '');
    await fs.rename(tmp, config.historyFile);
    state.lastHistoryPruneAt = Date.now();
    log(`pruned ${total - out.length} of ${total} history records (keep ${config.historyKeepDays}d)`);
  } catch (err) {
    warn('history prune failed:', err.message);
  }
}

async function tick(state) {
  await maybePruneHistory(state);
  await maybeDiscover(state);
  // First-seen map must shrink even when discovery is off or failing —
  // otherwise /new iterates an ever-growing map on every render.
  pruneMarketFirstSeen(state);
  const ids = activeMarketIds(state);
  if (!ids.length) {
    log('no markets to monitor (empty MARKET_IDS, no autodiscovered, nothing /add\'d). Idle tick.');
    await persist(state);
    return;
  }
  // Poll markets with a small worker pool — each checkMarket() is 2+ HTTP
  // round trips, so a large pool serialized would blow past the poll
  // interval. Each market only touches its own slot, so concurrent checks
  // don't contend on state.
  const pausedSet = new Set(state.pausedIds);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < ids.length) {
      const id = ids[nextIdx++];
      const isPaused = pausedSet.has(id) || isSnoozed(state, id);
      try {
        await checkMarket(id, state, { isPaused });
      } catch (err) {
        warn(`[${id}] tick error:`, err.message);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(config.monitorConcurrency, ids.length) }, worker),
  );
  const idSet = new Set(ids);
  for (const id of Object.keys(state.markets)) {
    if (!idSet.has(id)) delete state.markets[id];
  }
  // Cross-market ladder sanity check — needs every slot refreshed first.
  await checkPriceSanity(state).catch((err) => warn('price sanity check failed:', err.message));
  await maybeDigest(state);
  await maybeHourlyDigest(state);
  await flushChatDigests(state).catch((err) => warn('digest flush failed:', err.message));
  await persist(state);
}

async function main() {
  validateConfig();
  const once = process.argv.includes('--once');
  const state = await loadState();
  log(
    `starting; poll=${config.pollIntervalMs / 1000}s stale=${config.staleHours}h`,
    `priceEps=${config.priceEpsilon} trackSize=${config.trackSize} autodiscover=${config.autodiscover}`,
    `loaded ${Object.keys(state.markets).length} known market slots`,
  );

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`received ${sig}, exiting after current tick`);
      stop = true;
    });
  }

  const cmdLoop = startCommandLoop({
    getState: () => state,
    persist: () => persist(state),
    ctx: {
      requestDiscovery: () => {
        pendingDiscovery = true;
      },
      requestDigest: () => {
        pendingDigest = true;
      },
      requestHourlyDigest: () => {
        pendingHourlyDigest = true;
      },
    },
  });

  while (!stop) {
    const start = Date.now();
    try {
      await tick(state);
    } catch (err) {
      warn('tick failed:', err);
    }
    if (once) break;
    if (stop) break;
    const elapsed = Date.now() - start;
    const wait = Math.max(1000, config.pollIntervalMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }

  cmdLoop.stop();
  await saveChain;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
