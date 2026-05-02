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

function compactNumber(n, digits = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtPriceValue(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(4) : '-';
}

function fmtSizeValue(n) {
  return compactNumber(n, 0);
}

export function shortTitle(s, max = 72) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

// Mirrors predict.fun's title -> URL slug derivation: lowercase, strip
// diacritics + smart quotes, collapse non-alphanumerics into single dashes.
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’'"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

// Title is what we display (often short — "Draw", "Yes" for outcome
// markets), question is the full event-level prompt that Predict.fun uses
// to generate the URL slug. Prefer question for slug, fall back to title.
export function marketLink(marketId, title, question) {
  const display = title || question || `Market ${marketId}`;
  const safeTitle = htmlEscape(shortTitle(display, 72));
  const slugSource = question || title;
  const slug = slugSource ? slugifyMarketTitle(slugSource) : '';
  // predict.fun's canonical paths are /<lang>/market/<slug>. /zh-cn/ is a
  // safe default that 302s when needed; without it some clients land on
  // an empty page.
  const url = slug
    ? `https://predict.fun/zh-cn/market/${slug}`
    : `https://predict.fun/zh-cn/market/${encodeURIComponent(marketId)}`;
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

function bookLine(label, row) {
  if (!row) return `${label.padEnd(4)} 空`;
  return `${label.padEnd(4)} ${fmtPriceValue(row.price).padEnd(8)} × ${fmtSizeValue(row.size)}`;
}

function zoneLine(label, ok, reason) {
  if (ok) return `${label}: ✅ 已激活`;
  // Reason can contain "<" e.g. "量 12 < 100" — ALWAYS escape since
  // Telegram parses messages as HTML.
  return `${label}: ❌ ${htmlEscape(reason ?? '未激活')}`;
}

// Card-style orderbook block. Uses <pre> for monospace alignment of the
// price × size table and escapes every dynamic value going into HTML.
export function formatOrderbookBlock(orderbook, zone) {
  const bid1 = orderbook.bestBid ?? orderbook.bids?.[0] ?? null;
  const ask1 = orderbook.bestAsk ?? orderbook.asks?.[0] ?? null;
  const bid2 = orderbook.bids?.[1] ?? null;
  const ask2 = orderbook.asks?.[1] ?? null;
  const bid3 = orderbook.bids?.[2] ?? null;
  const ask3 = orderbook.asks?.[2] ?? null;

  const mid = midOf(orderbook);
  const spread = spreadOf(orderbook);

  const table = [
    bookLine('买1', bid1),
    bookLine('买2', bid2),
    bookLine('买3', bid3),
    bookLine('卖1', ask1),
    bookLine('卖2', ask2),
    bookLine('卖3', ask3),
  ].join('\n');

  const lines = [
    '📊 <b>盘口</b>',
    `<pre>${htmlEscape(table)}</pre>`,
  ];

  if (mid != null && spread != null) {
    const spreadIcon = spread <= 0.02 ? '🟢' : spread <= 0.05 ? '🟡' : '🔴';
    lines.push(
      `${spreadIcon} mid <code>${mid.toFixed(4)}</code> · spread <b>${(spread * 100).toFixed(2)}¢</b>`,
    );
  }

  if (zone) {
    lines.push('');
    lines.push(`🎯 <b>奖励区</b> ±${(zone.maxDistance * 100).toFixed(1)}¢ · size ≥ ${compactNumber(zone.minSize, 0)}`);
    lines.push(zoneLine('买侧', zone.bidActivated, zone.bidReason));
    lines.push(zoneLine('卖侧', zone.askActivated, zone.askReason));
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
