import { config, validateConfig } from './config.js';
import { getMarketRewardSummary, getOrderbook } from './predict.js';
import { loadState, saveState } from './state.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const warn = (...args) => console.warn(new Date().toISOString(), ...args);

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

function fmtSide(side) {
  if (!side) return '无';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${price} × ${size}`;
}

function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

async function checkMarket(marketId, state) {
  const [rewardResult, orderbookResult] = await Promise.allSettled([
    getMarketRewardSummary(marketId),
    getOrderbook(marketId),
  ]);

  if (orderbookResult.status === 'rejected') {
    warn(`[${marketId}] orderbook fetch failed:`, orderbookResult.reason?.message ?? orderbookResult.reason);
    return;
  }
  const orderbook = orderbookResult.value;

  let rewardSummary = null;
  if (rewardResult.status === 'fulfilled') {
    rewardSummary = rewardResult.value;
  } else {
    warn(`[${marketId}] reward fetch failed:`, rewardResult.reason?.message ?? rewardResult.reason);
  }

  const totalHourlyRate = rewardSummary?.totalHourlyRate ?? 0;
  if (config.skipNoReward && totalHourlyRate <= 0) {
    log(`[${marketId}] skip: no PP reward`);
    return;
  }

  const now = Date.now();
  const cur = {
    bidPrice: orderbook.bestBid?.price ?? null,
    bidSize: orderbook.bestBid?.size ?? null,
    askPrice: orderbook.bestAsk?.price ?? null,
    askSize: orderbook.bestAsk?.size ?? null,
  };
  const slot = state.markets[marketId];

  if (!slot) {
    state.markets[marketId] = {
      baseline: cur,
      lastChangeAt: now,
      lastSeenAt: now,
      alerted: false,
    };
    log(`[${marketId}] init baseline bid=${cur.bidPrice} ask=${cur.askPrice}`);
    return;
  }

  const bidChanged = topMoved(slot.baseline.bidPrice, slot.baseline.bidSize, orderbook.bestBid);
  const askChanged = topMoved(slot.baseline.askPrice, slot.baseline.askSize, orderbook.bestAsk);

  slot.lastSeenAt = now;
  if (bidChanged || askChanged) {
    log(
      `[${marketId}] book moved -> reset timer`,
      `bid ${slot.baseline.bidPrice}->${cur.bidPrice}`,
      `ask ${slot.baseline.askPrice}->${cur.askPrice}`,
    );
    slot.baseline = cur;
    slot.lastChangeAt = now;
    slot.alerted = false;
    return;
  }

  const elapsedMs = now - slot.lastChangeAt;
  const staleMs = config.staleHours * 3600 * 1000;
  if (elapsedMs >= staleMs && !slot.alerted) {
    const title = rewardSummary?.title ? htmlEscape(rewardSummary.title) : `Market ${marketId}`;
    const link = `https://predict.fun/market/${encodeURIComponent(marketId)}`;
    const lines = [
      `<b>订单簿停滞超过 ${config.staleHours} 小时</b>`,
      `<a href="${link}">${title}</a> (#${htmlEscape(marketId)})`,
      `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
      `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
      `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
      `已停滞: ${htmlEscape(fmtElapsed(elapsedMs))}`,
      `起点: ${new Date(slot.lastChangeAt).toISOString()}`,
    ];
    try {
      await sendTelegramMessage(lines.join('\n'));
      slot.alerted = true;
      log(`[${marketId}] alerted (stale ${fmtElapsed(elapsedMs)})`);
    } catch (err) {
      warn(`[${marketId}] telegram send failed:`, err.message);
    }
  } else {
    log(`[${marketId}] unchanged ${fmtElapsed(elapsedMs)} (alerted=${slot.alerted})`);
  }
}

async function tick() {
  const state = await loadState();
  for (const id of config.marketIds) {
    try {
      await checkMarket(id, state);
    } catch (err) {
      warn(`[${id}] tick error:`, err.message);
    }
  }
  for (const id of Object.keys(state.markets)) {
    if (!config.marketIds.includes(id)) delete state.markets[id];
  }
  await saveState(state);
}

async function main() {
  validateConfig();
  const once = process.argv.includes('--once');
  log(
    `monitoring ${config.marketIds.length} market(s);`,
    `poll=${config.pollIntervalMs / 1000}s stale=${config.staleHours}h`,
    `priceEps=${config.priceEpsilon} trackSize=${config.trackSize}`,
  );

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`received ${sig}, exiting after current tick`);
      stop = true;
    });
  }

  while (!stop) {
    const start = Date.now();
    try {
      await tick();
    } catch (err) {
      warn('tick failed:', err);
    }
    if (once) break;
    if (stop) break;
    const elapsed = Date.now() - start;
    const wait = Math.max(1000, config.pollIntervalMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
