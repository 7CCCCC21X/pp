import { config } from './config.js';
import { getMarketRewardSummary, getOrderbook } from './predict.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';
import { appendHistory } from './history.js';
import { fmtSide, fmtElapsed, marketLink, midOf, spreadOf, rewardZoneStatus } from './format.js';
import { effectiveFilters, checkFilter } from './filters.js';
import { alertKeyboard } from './commands.js';

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
      lastMid: midOf({ bestBid: cur.bidPrice != null ? { price: cur.bidPrice, size: cur.bidSize } : null, bestAsk: cur.askPrice != null ? { price: cur.askPrice, size: cur.askSize } : null }),
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
    // Persist the working (template, key) so future ticks skip retries.
    if (state.markets[marketId]) {
      state.markets[marketId].orderbookCache = {
        template: orderbook.template,
        key: orderbook.orderbookKey,
      };
    }
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
  if (rewardSummary?.title) slot.title = rewardSummary.title;
  slot.lastHourlyRate = totalHourlyRate;
  const lastSeenAt = slot.lastSeenAt ?? now;
  slot.lastSeenAt = now;

  // Per-tick rate logging — used by /digest to compute 24h PP totals.
  // Cap dt at 2 × poll interval so a long offline gap doesn't attribute
  // phantom PP to a window we weren't actually watching.
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

  // --- Watch mode: market is in state.watchedIds, fire on every detected
  // change (with a 1-min cooldown so a flapping book doesn't spam).
  const isWatched = (state.watchedIds ?? []).includes(marketId);
  if (isWatched && (bidChanged || askChanged) && !isPaused && !filtered) {
    const cooldownOk = now - (slot.watchAlertedAt ?? 0) >= 60_000;
    if (cooldownOk) {
      const fmtMove = (label, prev, next) => {
        const prevPart = prev?.price != null ? `${prev.price.toFixed(4)} × ${prev.size}` : '空';
        const nextPart = next?.price != null ? `${next.price.toFixed(4)} × ${next.size}` : '空';
        return `${label}: ${prevPart} → ${nextPart}`;
      };
      const prevBid = slot.baseline.bidPrice != null ? { price: slot.baseline.bidPrice, size: slot.baseline.bidSize } : null;
      const prevAsk = slot.baseline.askPrice != null ? { price: slot.baseline.askPrice, size: slot.baseline.askSize } : null;
      const msg = [
        `<b>盯盘变动</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        bidChanged ? htmlEscape(fmtMove('买1', prevBid, orderbook.bestBid)) : `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
        askChanged ? htmlEscape(fmtMove('卖1', prevAsk, orderbook.bestAsk)) : `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
        `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
      ].join('\n');
      if (await alert('watch', slot, marketId, msg, { bidChanged, askChanged })) {
        slot.watchAlertedAt = now;
      }
    }
  }

  // --- Mid-jump: compare against previous tick's mid (not baseline)
  const curMid = midOf(orderbook);
  const curSpread = spreadOf(orderbook);
  if (
    config.alertMidJump &&
    !isPaused && !filtered &&
    Number.isFinite(curMid) &&
    Number.isFinite(slot.lastMid)
  ) {
    const jump = Math.abs(curMid - slot.lastMid);
    const cooldownOk = now - (slot.midJumpAlertedAt ?? 0) >= config.midJumpCooldownMs;
    if (jump >= config.midJumpThreshold && cooldownOk) {
      const direction = curMid > slot.lastMid ? '↑' : '↓';
      const msg = [
        `<b>中价跳变 ${direction} ${jump.toFixed(4)}</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        `中价: ${slot.lastMid.toFixed(4)} → ${curMid.toFixed(4)}`,
        `当前买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
        `当前卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
        `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
      ].join('\n');
      if (await alert('mid_jump', slot, marketId, msg, { from: slot.lastMid, to: curMid, jump })) {
        slot.midJumpAlertedAt = now;
      }
    }
  }
  if (Number.isFinite(curMid)) slot.lastMid = curMid;

  // --- Wide-spread: alert if spread > MAX_SPREAD continuously for WIDE_SPREAD_MIN_MINUTES
  if (config.alertWideSpread && !isPaused && !filtered) {
    if (Number.isFinite(curSpread) && curSpread > config.maxSpread) {
      if (!slot.wideSpreadSince) slot.wideSpreadSince = now;
      const elapsed = now - slot.wideSpreadSince;
      const need = config.wideSpreadMinMinutes * 60 * 1000;
      const cooldownOk = now - (slot.wideSpreadAlertedAt ?? 0) >= 60 * 60 * 1000;
      if (elapsed >= need && cooldownOk) {
        const msg = [
          `<b>价差走阔 ${curSpread.toFixed(4)} (持续 ${fmtElapsed(elapsed)})</b>`,
          `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
          `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
          `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
          `阈值: ${config.maxSpread.toFixed(4)}`,
          `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
        ].join('\n');
        if (await alert('wide_spread', slot, marketId, msg, { spread: curSpread, elapsedMs: elapsed })) {
          slot.wideSpreadAlertedAt = now;
        }
      }
    } else {
      slot.wideSpreadSince = null;
    }
  }

  // --- Reward zone unstaffed: bid or ask side outside Predict.fun's
  // reward parameters (price too far from mid OR size below threshold)
  // sustained for REWARD_ZONE_MIN_MINUTES. Means PP is sitting unclaimed.
  if (config.alertRewardZone && !isPaused && !filtered && totalHourlyRate > 0) {
    const unstaffed = !zone.bidActivated || !zone.askActivated;
    if (unstaffed) {
      if (!slot.rewardZoneSince) slot.rewardZoneSince = now;
      const elapsed = now - slot.rewardZoneSince;
      const need = config.rewardZoneMinMinutes * 60 * 1000;
      const cooldownOk = now - (slot.rewardZoneAlertedAt ?? 0) >= 60 * 60 * 1000;
      if (elapsed >= need && cooldownOk) {
        const sides = [];
        if (!zone.bidActivated) sides.push(`买侧 (${zone.bidReason ?? '未激活'})`);
        if (!zone.askActivated) sides.push(`卖侧 (${zone.askReason ?? '未激活'})`);
        const msg = [
          `<b>奖励区可激活 (持续 ${fmtElapsed(elapsed)})</b>`,
          `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
          `规则: 离 mid ≤ ±${(zone.maxDistance * 100).toFixed(1)}¢，单边量 ≥ ${zone.minSize}`,
          `当前买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
          `当前卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
          `${htmlEscape(sides.join('，'))}`,
          `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
        ].join('\n');
        if (await alert('reward_zone', slot, marketId, msg, { elapsedMs: elapsed, bidActivated: zone.bidActivated, askActivated: zone.askActivated })) {
          slot.rewardZoneAlertedAt = now;
        }
      }
    } else {
      slot.rewardZoneSince = null;
    }
  }

  // --- Empty book
  if (config.alertEmptyBook && !isPaused && !filtered) {
    const empty = orderbook.bestBid == null || orderbook.bestAsk == null;
    if (empty) {
      if (!slot.emptyBookSince) slot.emptyBookSince = now;
      const elapsed = now - slot.emptyBookSince;
      const need = config.emptyBookMinMinutes * 60 * 1000;
      const cooldownOk = now - (slot.emptyBookAlertedAt ?? 0) >= 60 * 60 * 1000;
      if (elapsed >= need && cooldownOk) {
        const msg = [
          `<b>订单簿单边/空缺 (持续 ${fmtElapsed(elapsed)})</b>`,
          `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
          `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
          `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
          `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
        ].join('\n');
        if (await alert('empty_book', slot, marketId, msg, { elapsedMs: elapsed })) {
          slot.emptyBookAlertedAt = now;
        }
      }
    } else {
      slot.emptyBookSince = null;
    }
  }

  // --- Stall: top of book unchanged for STALE_HOURS
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

  if (!config.alertStall || isPaused || filtered) {
    const why = !config.alertStall ? 'stall alerts off' : isPaused ? 'paused' : `filtered: ${filterReason}`;
    log(`[${marketId}] unchanged ${fmtElapsed(now - slot.lastChangeAt)} (${why})`);
    return;
  }

  const elapsedMs = now - slot.lastChangeAt;
  const staleMs = config.staleHours * 3600 * 1000;
  if (elapsedMs >= staleMs && !slot.alerted) {
    const msg = [
      `<b>订单簿停滞超过 ${config.staleHours} 小时</b>`,
      `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
      `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
      `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
      `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
      `已停滞: ${htmlEscape(fmtElapsed(elapsedMs))}`,
      `起点: ${new Date(slot.lastChangeAt).toISOString()}`,
    ].join('\n');
    if (await alert('stall', slot, marketId, msg, { elapsedMs })) {
      slot.alerted = true;
      log(`[${marketId}] alerted stall (${fmtElapsed(elapsedMs)})`);
    }
  } else {
    log(`[${marketId}] unchanged ${fmtElapsed(elapsedMs)} (alerted=${slot.alerted})`);
  }
}
