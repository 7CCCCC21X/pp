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
  const slug = title ? slugifyMarketTitle(title) : '';
  // predict.fun uses /<lang>/market/<slug>. We use the no-lang form which
  // 302s to the user's locale. Fall back to id-based path when there's
  // no title yet.
  const url = slug
    ? `https://predict.fun/market/${slug}`
    : `https://predict.fun/market/${encodeURIComponent(marketId)}`;
  return `<a href="${url}">${safeTitle}</a>`;
}

// Predict.fun's URL slug includes the year for dated markets (e.g.
// "BNB up or down (May 2 2026 2am ET)" -> "bnb-up-or-down-may-2-2026-2am-et").
// API titles often omit the year ("Bitcoin Up or Down - May 2, 11:45AM-12PM ET"),
// so we inject the current year after the date before slugifying.
export function slugifyMarketTitle(title) {
  if (!title) return '';
  let s = title;
  if (!/\b20\d{2}\b/.test(s)) {
    const m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i);
    if (m) {
      const year = new Date().getUTCFullYear();
      const idx = s.indexOf(m[0]) + m[0].length;
      s = s.slice(0, idx) + ' ' + year + s.slice(idx);
    }
  }
  return slugify(s);
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

// Compact orderbook block matching the `npm run probe` output style:
// top-3 bids/asks with size, then mid + spread + reward-zone status.
// Used by every alert so the user gets the full picture without
// jumping to /probe.
export function formatOrderbookBlock(orderbook, zone) {
  const lines = [];
  lines.push('<b>买盘 (top 3)</b>');
  if (!orderbook.bids?.length) lines.push('  (空)');
  for (let i = 0; i < orderbook.bids.length; i++) {
    const b = orderbook.bids[i];
    lines.push(`  买${i + 1}: ${b.price.toFixed(4)} × ${b.size.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }
  lines.push('<b>卖盘 (top 3)</b>');
  if (!orderbook.asks?.length) lines.push('  (空)');
  for (let i = 0; i < orderbook.asks.length; i++) {
    const a = orderbook.asks[i];
    lines.push(`  卖${i + 1}: ${a.price.toFixed(4)} × ${a.size.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }
  const mid = midOf(orderbook);
  const spread = spreadOf(orderbook);
  lines.push('');
  if (mid != null && spread != null) {
    lines.push(`mid: ${mid.toFixed(4)} · spread: ${(spread * 100).toFixed(2)}¢`);
  }
  if (zone) {
    lines.push(`奖励区: 离 mid ≤ ±${(zone.maxDistance * 100).toFixed(1)}¢ 且 size ≥ ${zone.minSize}`);
    lines.push(`  买侧: ${zone.bidActivated ? '✓ 已激活' : `✗ ${zone.bidReason ?? '未激活'}`}`);
    lines.push(`  卖侧: ${zone.askActivated ? '✓ 已激活' : `✗ ${zone.askReason ?? '未激活'}`}`);
  }
  return lines.join('\n');
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
