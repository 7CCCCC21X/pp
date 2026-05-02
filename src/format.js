import { htmlEscape } from './telegram.js';

export function fmtSide(side) {
  if (!side) return '无';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${price} × ${size}`;
}

export function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export function marketLink(marketId, title) {
  const safeTitle = title ? htmlEscape(title) : `Market ${marketId}`;
  return `<a href="https://predict.fun/market/${encodeURIComponent(marketId)}">${safeTitle}</a>`;
}

// Reward-zone evaluation. Predict.fun gives PP rewards to limit orders
// within ±maxDistance of mid with size ≥ minSize. Per-market
// spreadThreshold / shareThreshold in the market object override the
// global defaults.
export function rewardZoneStatus(orderbook, market, defaults) {
  const maxDistance = Number.isFinite(market?.spreadThreshold) && market.spreadThreshold > 0
    ? market.spreadThreshold
    : defaults.maxDistance;
  const minSize = Number.isFinite(market?.shareThreshold) && market.shareThreshold > 0
    ? market.shareThreshold
    : defaults.minSize;
  const bid = orderbook.bestBid;
  const ask = orderbook.bestAsk;
  if (!bid || !ask) {
    return { maxDistance, minSize, mid: null, bidActivated: false, askActivated: false, bidReason: bid ? null : '无买单', askReason: ask ? null : '无卖单' };
  }
  const mid = (bid.price + ask.price) / 2;
  const bidDist = mid - bid.price;
  const askDist = ask.price - mid;
  const bidInZone = bidDist <= maxDistance;
  const askInZone = askDist <= maxDistance;
  const bidSizeOk = bid.size >= minSize;
  const askSizeOk = ask.size >= minSize;
  return {
    maxDistance,
    minSize,
    mid,
    bidActivated: bidInZone && bidSizeOk,
    askActivated: askInZone && askSizeOk,
    bidReason: !bidInZone ? `离 mid ${(bidDist * 100).toFixed(2)}¢` : !bidSizeOk ? `量 ${bid.size} < ${minSize}` : null,
    askReason: !askInZone ? `离 mid ${(askDist * 100).toFixed(2)}¢` : !askSizeOk ? `量 ${ask.size} < ${minSize}` : null,
  };
}

export function midOf(orderbook) {
  const bid = orderbook.bestBid?.price;
  const ask = orderbook.bestAsk?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

export function spreadOf(orderbook) {
  const bid = orderbook.bestBid?.price;
  const ask = orderbook.bestAsk?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return ask - bid;
}
