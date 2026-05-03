import { config } from './config.js';
import { getMarketRewardSummary, getOrderbook, marketEndMs, getSlugMapCached, getMarketRestById } from './predict.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';
import { appendHistory } from './history.js';
import { fmtElapsed, midOf, spreadOf, rewardZoneStatus } from './format.js';
import { effectiveFilters, checkFilter } from './filters.js';
import { effectiveOverride } from './state.js';
import { alertKeyboard } from './commands.js';
import { detectStall } from './alerts/stall.js';
import { detectWatch } from './alerts/watch.js';
import { detectMidJump } from './alerts/midJump.js';
import { detectWideSpread } from './alerts/wideSpread.js';
import { detectRewardZone } from './alerts/rewardZone.js';
import { detectEmptyBook } from './alerts/emptyBook.js';

const log = (...args) => console.log(new Date().toISOString(), '[monitor]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[monitor]', ...args);

function priceMoved(prev, next) {
  if (prev == null && next == null) return false;
  if (prev == null || next == null) return true;
  return Math.abs(prev - next) >= config.priceEpsilon;
}

function sizeMoved(prev, next) {
  if (!config.trackSize) return false;
  if (prev == null && next == null) return false;
  if (prev == null || next == null) return true;
  const diff = Math.abs(prev - next);
  if (diff < config.sizeAbsoluteMin) return false;
  const base = Math.max(Math.abs(prev), Math.abs(next));
  if (base === 0) return false;
  return diff / base >= config.sizeRelativeEpsilon;
}

function topMoved(prevPrice, prevSize, nextSide) {
  const nextPrice = nextSide?.price ?? null;
  const nextSize = nextSide?.size ?? null;
  return priceMoved(prevPrice, nextPrice) || sizeMoved(prevSize, nextSize);
}

function ensureSlot(state, marketId, cur, now) {
  let slot = state.markets[marketId];
  if (!slot) {
    slot = {
      baseline: cur,
      lastChangeAt: now,
      lastSeenAt: now,
      alerted: false,
      lastMid: midOf({
        bestBid: cur.bidPrice != null ? { price: cur.bidPrice, size: cur.bidSize } : null,
        bestAsk: cur.askPrice != null ? { price: cur.askPrice, size: cur.askSize } : null,
      }),
      midJumpAlertedAt: 0,
      wideSpreadSince: null,
      wideSpreadAlertedAt: 0,
      emptyBookSince: cur.bidPrice == null || cur.askPrice == null ? now : null,
      emptyBookAlertedAt: 0,
      title: null,
      lastHourlyRate: null,
    };
    state.markets[marketId] = slot;
  }
  return slot;
}

// Stub slot for markets we can't fully process yet (resolved, fetch failed,
// no rewards). Lets /status surface a real reason instead of the misleading
// "等待首次抓取" forever. Also clears stale rate/zone snapshots from a
// previous successful tick — otherwise /top, /gaps, /opp keep listing
// expired 15-min markets at their last-known PP/h.
function ensureStubSlot(state, marketId, now) {
  let slot = state.markets[marketId];
  if (!slot) {
    slot = { lastSeenAt: now, title: null };
    state.markets[marketId] = slot;
  }
  slot.lastSeenAt = now;
  slot.lastHourlyRate = 0;
  slot.zoneStatus = null;
  return slot;
}

async function alert(kind, slot, marketId, message, extra = {}) {
  // Per-market cross-type cooldown to keep one illiquid market from
  // emitting wide_spread + reward_zone + empty_book back-to-back. Watch
  // is exempt (its job is per-tick reporting) and so are recovery
  // notifications (they're terminal "back to normal" pings).
  const isWatchOrRecovery = kind === 'watch' || kind.endsWith('_recovered');
  if (!isWatchOrRecovery) {
    const sinceAny = Date.now() - (slot.lastAnyAlertAt ?? 0);
    if (sinceAny < config.marketAlertCooldownMs) {
      log(`[${marketId}] suppress ${kind} (per-market cooldown ${Math.round(sinceAny / 1000)}s)`);
      return false;
    }
  }
  try {
    await sendTelegramMessage(message, { replyMarkup: alertKeyboard(marketId) });
  } catch (err) {
    warn(`[${marketId}] telegram send (${kind}) failed:`, err.message);
    return false;
  }
  await appendHistory({
    event: 'alert',
    kind,
    marketId,
    title: slot.title ?? null,
    totalHourlyRate: slot.lastHourlyRate,
    ...extra,
  }).catch(() => {});
  if (!isWatchOrRecovery) {
    slot.lastAnyAlertAt = Date.now();
  }
  return true;
}

const DETECTORS = [
  detectWatch,        // fires on every detected change (watched markets only)
  detectMidJump,      // tick-to-tick mid drift; also updates slot.lastMid
  detectWideSpread,
  detectRewardZone,
  detectEmptyBook,
  // Stall is special — also resets on book move; runs last because it
  // depends on baseline state from the move-detection block.
];

export async function checkMarket(marketId, state, { isPaused }) {
  const tickStart = Date.now();
  let rewardSummary = null;
  try {
    rewardSummary = await getMarketRewardSummary(marketId);
  } catch (err) {
    warn(`[${marketId}] reward fetch failed:`, err.message);
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.lastError = `奖励查询失败: ${err.message.slice(0, 100)}`;
    return;
  }

  if (!rewardSummary?.market) {
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.lastError = '市场不存在（可能已 resolve 或 id 错误）';
    return;
  }

  const orderbookKey = rewardSummary.orderbookKey ?? marketId;
  const market = rewardSummary.market;
  const cache = state.markets[marketId]?.orderbookCache ?? null;

  const totalHourlyRate = rewardSummary?.totalHourlyRate ?? 0;
  if (config.skipNoReward && totalHourlyRate <= 0) {
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.title = rewardSummary.title ?? stub.title;
    stub.lastSkipReason = 'PP/h = 0 (已 resolve 或无奖励)';
    stub.lastError = null;
    log(`[${marketId}] skip: no PP reward`);
    return;
  }

  // Tick-level remaining-time guard — even if discovery added this market
  // when it had hours to go, skip alerting once it drops below the limit.
  // Stops 15-min Bitcoin markets from spamming once the autoIds list is
  // stale between discovery cycles.
  if (config.minRemainingHours > 0) {
    const endMs = marketEndMs(market);
    if (endMs != null && endMs < tickStart + config.minRemainingHours * 3600 * 1000) {
      const stub = ensureStubSlot(state, marketId, tickStart);
      stub.title = rewardSummary.title ?? stub.title;
      const remainingHours = Math.max(0, (endMs - tickStart) / 3600000);
      stub.lastSkipReason = `剩余 ${remainingHours.toFixed(1)}h < ${config.minRemainingHours}h，跳过`;
      stub.lastError = null;
      log(`[${marketId}] skip: remaining ${remainingHours.toFixed(1)}h`);
      return;
    }
  }

  let orderbook;
  try {
    orderbook = await getOrderbook(orderbookKey, {
      contextMarketId: marketId,
      market,
      cache,
    });
  } catch (err) {
    warn(`[${marketId}] orderbook fetch failed:`, err.message);
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.title = rewardSummary.title ?? stub.title;
    // Compact reason: keep the actionable bit, drop the URL.
    const m = err.message.match(/(404|403|401|5\d\d|timed out)/i);
    const code = m ? m[0] : 'fetch failed';
    const tries = err.message.match(/tried (\d+)/i)?.[1];
    stub.lastError = `订单簿 ${code}${tries ? ` (尝试 ${tries} 种组合)` : ''} — 市场可能已 resolve`;
    stub.lastSkipReason = null;
    stub.consecutiveOrderbookErrors = (stub.consecutiveOrderbookErrors ?? 0) + 1;
    return;
  }
  // Reset error counter on a successful fetch so a recovered market clears.

  const filters = effectiveFilters(state);
  const filterReason = checkFilter(orderbook, filters);
  const filtered = filterReason !== null;

  const now = Date.now();
  const cur = {
    bidPrice: orderbook.bestBid?.price ?? null,
    bidSize: orderbook.bestBid?.size ?? null,
    askPrice: orderbook.bestAsk?.price ?? null,
    askSize: orderbook.bestAsk?.size ?? null,
  };
  const slot = ensureSlot(state, marketId, cur, now);
  // Persist the working (template, key) so future ticks skip the
  // self-heal probe loop — even on the very first tick for a market.
  slot.orderbookCache = {
    template: orderbook.template,
    key: orderbook.orderbookKey,
  };
  slot.lastError = null;
  slot.lastSkipReason = null;
  slot.consecutiveOrderbookErrors = 0;
  // Stash the parsed end time for /status to compute remaining hours +
  // total available PP without redoing the regex match each command.
  slot.endMs = marketEndMs(market);
  if (rewardSummary?.title) slot.title = rewardSummary.title;
  // question is the event-level prompt; for outcome-name markets ("Draw",
  // "Yes") only the question slugifies to the right predict.fun URL.
  if (rewardSummary?.market?.question) slot.question = rewardSummary.market.question;
  // Resolve the real URL slug (Predict.fun's `categorySlug`). Use the
  // bulk REST cache first (covers ~top 100 markets), then fall back to
  // a single-market REST GET for cache misses. Once persisted into
  // slot.slug it survives restarts via state.json — no need to refetch.
  if (!slot.slug) {
    try {
      const slugMap = await getSlugMapCached();
      let realSlug = slugMap?.get(String(marketId)) ?? null;
      if (!realSlug) {
        const restMarket = await getMarketRestById(marketId);
        const cs = restMarket?.categorySlug || restMarket?.slug || restMarket?.marketSlug;
        if (cs) realSlug = String(cs);
      }
      if (realSlug) slot.slug = realSlug;
    } catch {
      // Non-fatal — fall back to title/question slugify in marketLink.
    }
  }
  slot.lastHourlyRate = totalHourlyRate;
  const lastSeenAt = slot.lastSeenAt ?? now;
  slot.lastSeenAt = now;

  // Per-tick rate logging — used by /digest to compute 24h PP totals.
  if (totalHourlyRate > 0) {
    const dtMs = Math.min(now - lastSeenAt, 2 * config.pollIntervalMs);
    if (dtMs > 0) {
      appendHistory({
        event: 'rate',
        marketId,
        title: slot.title ?? null,
        hourlyRate: totalHourlyRate,
        dtMs,
        ppEarned: (totalHourlyRate * dtMs) / 3600000,
      }).catch(() => {});
    }
  }

  // Reward-zone evaluation per tick. Per-market overrides via /setmarket
  // beat the global config; the market object's spreadThreshold /
  // shareThreshold (from Predict.fun's REST sample) win over either.
  const zone = rewardZoneStatus(orderbook, market, {
    maxDistance: effectiveOverride(state, marketId, 'rewardZoneMaxDistance', config.rewardZoneMaxDistance),
    minSize: effectiveOverride(state, marketId, 'rewardZoneMinSize', config.rewardZoneMinSize),
  });
  slot.zoneStatus = {
    bidActivated: zone.bidActivated,
    askActivated: zone.askActivated,
    bidReason: zone.bidReason,
    askReason: zone.askReason,
    maxDistance: zone.maxDistance,
    minSize: zone.minSize,
  };

  const bidChanged = topMoved(slot.baseline.bidPrice, slot.baseline.bidSize, orderbook.bestBid);
  const askChanged = topMoved(slot.baseline.askPrice, slot.baseline.askSize, orderbook.bestAsk);

  const ctx = {
    state,
    slot,
    orderbook,
    marketId,
    market,
    totalHourlyRate,
    isPaused,
    filtered,
    filterReason,
    now,
    bidChanged,
    askChanged,
    zone,
    alert,
    log,
  };

  for (const detect of DETECTORS) {
    try {
      await detect(ctx);
    } catch (err) {
      warn(`[${marketId}] detector ${detect.name} failed:`, err.message);
    }
  }

  // Stall detection lives here because of its baseline-reset coupling: a
  // book move resets the timer (and re-arms the alert), no move means the
  // standard stall check.
  if (bidChanged || askChanged) {
    log(
      `[${marketId}] book moved -> reset stall timer`,
      `bid ${slot.baseline.bidPrice}->${cur.bidPrice}`,
      `ask ${slot.baseline.askPrice}->${cur.askPrice}`,
    );
    appendHistory({
      event: 'move',
      marketId,
      title: slot.title,
      from: slot.baseline,
      to: cur,
      totalHourlyRate,
    }).catch(() => {});
    slot.baseline = cur;
    slot.lastChangeAt = now;
    slot.alerted = false;
    return;
  }

  await detectStall(ctx);
}
