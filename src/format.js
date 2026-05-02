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

// Mirrors predict.fun's title -> URL slug derivation: lowercase, strip
// diacritics + smart quotes, collapse non-alphanumerics into single dashes.
// Used by marketLink so the alert title actually opens the market page
// (predict.fun routes by slug, not numeric id).
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’'"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function marketLink(marketId, title) {
  const safeTitle = title ? htmlEscape(title) : `Market ${marketId}`;
  const slug = title ? slugify(title) : '';
  // predict.fun uses /market/<slug>. Fall back to id-based URL if we
  // haven't seen the title yet (the page should still resolve).
  const url = slug
    ? `https://predict.fun/market/${slug}`
    : `https://predict.fun/market/${encodeURIComponent(marketId)}`;
  return `<a href="${url}">${safeTitle}</a>`;
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
