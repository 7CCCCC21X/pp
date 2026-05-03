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
// markets). The URL slug comes from Predict.fun's REST `categorySlug`
// when we have it (passed as `slug`); otherwise we slugify question or
// title as a best-effort fallback. URL pattern keeps the /zh-cn/
// prefix the user confirmed works in browsers — predict.fun's no-lang
// path inconsistently 302s in some clients.
export function marketLink(marketId, title, question, slug) {
  const display = title || question || `Market ${marketId}`;
  const safeTitle = htmlEscape(shortTitle(display, 72));
  const urlSlug = slug
    || (question ? slugifyMarketTitle(question) : null)
    || (title ? slugifyMarketTitle(title) : null);
  const url = urlSlug
    ? `https://predict.fun/zh-cn/market/${urlSlug}`
    : `https://predict.fun/zh-cn/market/${encodeURIComponent(marketId)}`;
  return `<a href="${url}">${safeTitle}</a>`;
}

// Reward-zone evaluation. Predict.fun gives PP rewards to limit orders
// Reward zone activation = an order at price within ±maxDistance of mid
// with size ≥ minSize. Threshold precedence (high → low):
//   1. overrides.maxDistance / minSize  — explicit /setmarket value
//   2. market.spreadThreshold / shareThreshold — REST per-market values
//   3. defaults.maxDistance / minSize    — env REWARD_ZONE_* fallback
// Predict.fun ships per-market values for ~100% of markets today, so
// without (1) the overrides path is dead code; passing them as a
// fourth arg makes /setmarket actually take effect for power users
// who want a tighter early-warning rule than the platform's actual
// PP-eligibility window.
export function rewardZoneStatus(orderbook, market, defaults, overrides = {}) {
  const fromOverride = (v) => Number.isFinite(v) && v > 0 ? v : null;
  const fromMarket = (v) => Number.isFinite(v) && v > 0 ? v : null;
  // Track which layer of the precedence ladder each value came from so
  // formatOrderbookBlock / /probe can label "±6¢ (REST)" vs "(覆盖)" vs
  // "(env)" — otherwise users can't tell whether a threshold is what
  // Predict.fun actually rewards or just the global fallback.
  const overMax = fromOverride(overrides.maxDistance);
  const restMax = fromMarket(market?.spreadThreshold);
  const overSize = fromOverride(overrides.minSize);
  const restSize = fromMarket(market?.shareThreshold);
  const maxDistance = overMax ?? restMax ?? defaults.maxDistance;
  const minSize = overSize ?? restSize ?? defaults.minSize;
  const maxSource = overMax != null ? 'override' : restMax != null ? 'rest' : 'env';
  const sizeSource = overSize != null ? 'override' : restSize != null ? 'rest' : 'env';
  const bid = orderbook.bestBid;
  const ask = orderbook.bestAsk;
  if (!bid || !ask) {
    return { maxDistance, minSize, maxSource, sizeSource, mid: null, bidActivated: false, askActivated: false, bidReason: bid ? null : '无买单', askReason: ask ? null : '无卖单' };
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
    maxSource,
    sizeSource,
    mid,
    bidActivated: bidInZone && bidSizeOk,
    askActivated: askInZone && askSizeOk,
    bidReason: !bidInZone ? `离 mid ${(bidDist * 100).toFixed(2)}¢` : !bidSizeOk ? `量 ${bid.size} < ${minSize}` : null,
    askReason: !askInZone ? `离 mid ${(askDist * 100).toFixed(2)}¢` : !askSizeOk ? `量 ${ask.size} < ${minSize}` : null,
  };
}

function bookLine(label, row) {
  if (!row) return `${label.padEnd(4)} 空`;
  // Each row's $ value = price × size (USDC equivalent on Predict.fun).
  const total = row.price * row.size;
  return `${label.padEnd(4)} ${fmtPriceValue(row.price).padEnd(7)} × ${fmtSizeValue(row.size).padEnd(9)} = $${fmtSizeValue(total)}`;
}

function sideTotal(rows) {
  if (!rows?.length) return 0;
  return rows.reduce((acc, r) => acc + r.price * r.size, 0);
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

  const bidTotal = sideTotal(orderbook.bids);
  const askTotal = sideTotal(orderbook.asks);

  const tableRows = [
    bookLine('买1', bid1),
    bookLine('买2', bid2),
    bookLine('买3', bid3),
    `小计 买盘 = $${fmtSizeValue(bidTotal)}`,
    bookLine('卖1', ask1),
    bookLine('卖2', ask2),
    bookLine('卖3', ask3),
    `小计 卖盘 = $${fmtSizeValue(askTotal)}`,
  ];
  const table = tableRows.join('\n');

  const lines = [
    '📊 <b>盘口</b>',
    `<pre>${htmlEscape(table)}</pre>`,
  ];

  if (mid != null && spread != null) {
    const spreadIcon = spread <= 0.02 ? '🟢' : spread <= 0.05 ? '🟡' : '🔴';
    lines.push(
      `${spreadIcon} mid <code>${mid.toFixed(4)}</code> · spread <b>${(spread * 100).toFixed(2)}¢</b> · 总深度 $${fmtSizeValue(bidTotal + askTotal)}`,
    );
  }

  if (zone) {
    lines.push('');
    // Source tag clarifies whether the ±X¢ rule is Predict.fun's
    // platform value (REST), a /setmarket override, or the env
    // fallback that's almost never reached today.
    const srcLabel = (s) => s === 'override' ? '覆盖' : s === 'rest' ? 'REST' : 'env';
    const tag = (zone.maxSource === zone.sizeSource)
      ? srcLabel(zone.maxSource)
      : `${srcLabel(zone.maxSource)}/${srcLabel(zone.sizeSource)}`;
    lines.push(`🎯 <b>奖励区</b> ±${(zone.maxDistance * 100).toFixed(1)}¢ · size ≥ ${compactNumber(zone.minSize, 0)} <i>(${tag})</i>`);
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

// Two-line "why look at this" summary printed at the top of every
// alert message — answers "what's the opportunity" and "how much PP
// is on the table" so the recipient can decide without reading the
// full orderbook table beneath. Returns a multiline HTML string (no
// trailing newline). Falls back gracefully when zone / endMs are
// unknown.
export function formatOpportunitySummary({ orderbook, zone, totalHourlyRate, endMs }) {
  const bid = orderbook?.bestBid;
  const ask = orderbook?.bestAsk;
  const spread = (Number.isFinite(bid?.price) && Number.isFinite(ask?.price))
    ? ask.price - bid.price
    : null;
  const topUsd = (bid ? bid.price * bid.size : 0) + (ask ? ask.price * ask.size : 0);

  const gaps = [];
  if (zone) {
    if (!zone.bidActivated) gaps.push(`买侧 ${zone.bidReason ?? '未激活'}`);
    if (!zone.askActivated) gaps.push(`卖侧 ${zone.askReason ?? '未激活'}`);
  }
  const oppText = gaps.length ? gaps.join(' · ') : '奖励区双边正常';

  const oppParts = [`🔥 <b>机会</b>: ${htmlEscape(oppText)}`];
  if (spread != null) {
    oppParts.push(`spread ${(spread * 100).toFixed(2)}¢`);
  }
  if (topUsd > 0) {
    oppParts.push(`顶层 $${topUsd.toFixed(0)}`);
  }

  const remainH = (Number.isFinite(endMs) && endMs > Date.now())
    ? (endMs - Date.now()) / 3600000
    : null;
  const totalPp = (remainH != null && Number.isFinite(totalHourlyRate))
    ? totalHourlyRate * remainH
    : null;

  const earn = [`💰 <b>${(totalHourlyRate ?? 0).toFixed(0)} PP/h</b>`];
  if (remainH != null) {
    earn.push(`剩余 ${remainH.toFixed(1)}h`);
    if (totalPp != null) earn.push(`≈ <b>${totalPp.toFixed(0)} PP</b>`);
  }

  return [oppParts.join(' · '), earn.join(' · ')].join('\n');
}

// Single source of truth for "how attractive is this market right now".
// Used by /opp ranking AND by alert priority tiering. Higher = better.
//   rate × gap_mult (1 / 2 / 3)
//        × spread_mult (1..1.5; tighter spread = more friendly)
export function scoreSlot(slot) {
  const rate = slot?.lastHourlyRate ?? 0;
  if (!rate) return 0;
  const z = slot?.zoneStatus;
  let mult = 1;
  if (z) {
    if (!z.bidActivated) mult += 1;
    if (!z.askActivated) mult += 1;
  }
  const bid = slot?.baseline?.bidPrice;
  const ask = slot?.baseline?.askPrice;
  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    const spread = ask - bid;
    if (spread > 0 && spread < 0.5) mult *= (1 + (0.5 - spread));
  }
  return rate * mult;
}

// Bucket a score into 'low' | 'medium' | 'high'. highThreshold and
// mediumThreshold come from config so users can shift the cutoffs
// via env without code changes.
export function priorityOf(score, { highThreshold, mediumThreshold }) {
  if (score >= highThreshold) return 'high';
  if (score >= mediumThreshold) return 'medium';
  return 'low';
}
