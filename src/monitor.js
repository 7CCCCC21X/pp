import { config } from './config.js';
import { getMarketRewardSummary, getOrderbook } from './predict.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';
import { appendHistory } from './history.js';
import { fmtElapsed, midOf, spreadOf, rewardZoneStatus } from './format.js';
import { effectiveFilters, checkFilter } from './filters.js';
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

async function alert(kind, slot, marketId, message, extra = {}) {
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
  let rewardSummary = null;
  try {
    rewardSummary = await getMarketRewardSummary(marketId);
  } catch (err) {
    warn(`[${marketId}] reward fetch failed:`, err.message);
  }
  const orderbookKey = rewardSummary?.orderbookKey ?? marketId;
  const market = rewardSummary?.market ?? null;
  const cache = state.markets[marketId]?.orderbookCache ?? null;

  let orderbook;
  try {
    orderbook = await getOrderbook(orderbookKey, {
      contextMarketId: marketId,
      market,
      cache,
    });
  } catch (err) {
    warn(`[${marketId}] orderbook fetch failed:`, err.message);
    return;
  }

  const totalHourlyRate = rewardSummary?.totalHourlyRate ?? 0;
  if (config.skipNoReward && totalHourlyRate <= 0) {
    log(`[${marketId}] skip: no PP reward`);
    return;
  }

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
  if (rewardSummary?.title) slot.title = rewardSummary.title;
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

  // Reward-zone evaluation per tick.
  const zone = rewardZoneStatus(orderbook, market, {
    maxDistance: config.rewardZoneMaxDistance,
    minSize: config.rewardZoneMinSize,
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
