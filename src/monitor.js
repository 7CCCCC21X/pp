import { config } from './config.js';
import { getMarketRewardSummary, getOrderbook } from './predict.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';
import { appendHistory } from './history.js';
import { fmtSide, fmtElapsed, marketLink, midOf, spreadOf } from './format.js';
import { effectiveFilters, checkFilter } from './filters.js';

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
    await sendTelegramMessage(message);
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
  slot.lastSeenAt = now;

  const bidChanged = topMoved(slot.baseline.bidPrice, slot.baseline.bidSize, orderbook.bestBid);
  const askChanged = topMoved(slot.baseline.askPrice, slot.baseline.askSize, orderbook.bestAsk);

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
