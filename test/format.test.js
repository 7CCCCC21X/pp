import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtSide,
  fmtElapsed,
  marketLink,
  midOf,
  spreadOf,
  rewardZoneStatus,
  slugify,
  formatOpportunitySummary,
  scoreSlot,
  priorityOf,
} from '../src/format.js';

test('fmtSide handles null', () => {
  assert.equal(fmtSide(null), '无');
});

test('fmtSide formats price and size', () => {
  const out = fmtSide({ price: 0.5, size: 100 });
  assert.match(out, /0\.5000/);
  assert.match(out, /100/);
});

test('fmtElapsed minutes', () => {
  assert.equal(fmtElapsed(45 * 60 * 1000), '45 分');
});

test('fmtElapsed hours and minutes', () => {
  assert.equal(fmtElapsed(2 * 3600 * 1000 + 30 * 60 * 1000), '2 小时 30 分');
});

test('fmtElapsed clamps negative', () => {
  assert.equal(fmtElapsed(-1000), '0 分');
});

test('marketLink: explicit slug wins (real categorySlug from REST)', () => {
  const link = marketLink('210562', 'Draw', 'whatever', 'english-premier-league-winner');
  assert.match(link, /href="https:\/\/predict\.fun\/zh-cn\/market\/english-premier-league-winner"/);
  assert.match(link, />Draw<\/a>/);
});

test('marketLink: question slugified when no explicit slug', () => {
  const link = marketLink('210562', 'Draw', 'Real Madrid vs Barcelona — Match Result');
  assert.match(link, /href="https:\/\/predict\.fun\/zh-cn\/market\/real-madrid-vs-barcelona-match-result"/);
});

test('marketLink: falls back to title slug when no question or explicit slug', () => {
  const link = marketLink('1', 'BNB up or down (May 2 2026 2am ET)');
  assert.match(link, /\/bnb-up-or-down-may-2-2026-2am-et/);
});

test('marketLink: id fallback when nothing else', () => {
  const link = marketLink('123', null);
  assert.match(link, /href="https:\/\/predict\.fun\/zh-cn\/market\/123"/);
  assert.match(link, /Market 123/);
});

test('marketLink escapes title text', () => {
  const link = marketLink('123', '<bad>');
  assert.match(link, /&lt;bad&gt;/);
});

test('slugify handles diacritics and quotes', () => {
  assert.equal(slugify("Bayer 04 Leverkusen"), 'bayer-04-leverkusen');
  assert.equal(slugify("Pistons vs. Magic"), 'pistons-vs-magic');
  assert.equal(slugify("Match Winner — 76ers vs Celtics"), 'match-winner-76ers-vs-celtics');
});

test('midOf and spreadOf', () => {
  const ob = { bestBid: { price: 0.49, size: 1 }, bestAsk: { price: 0.51, size: 1 } };
  assert.equal(midOf(ob), 0.5);
  assert.equal(Math.round(spreadOf(ob) * 1000) / 1000, 0.02);
});

test('midOf returns null when missing side', () => {
  assert.equal(midOf({ bestBid: null, bestAsk: { price: 0.5, size: 1 } }), null);
});

test('rewardZoneStatus activates both sides when tight', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 200 }, bestAsk: { price: 0.51, size: 200 } },
    {},
    { maxDistance: 0.06, minSize: 100 },
  );
  assert.equal(z.bidActivated, true);
  assert.equal(z.askActivated, true);
});

test('rewardZoneStatus rejects oversized spread', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.30, size: 200 }, bestAsk: { price: 0.70, size: 200 } },
    {},
    { maxDistance: 0.06, minSize: 100 },
  );
  assert.equal(z.bidActivated, false);
  assert.equal(z.askActivated, false);
  assert.match(z.bidReason, /离 mid/);
});

test('rewardZoneStatus rejects undersized', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 50 }, bestAsk: { price: 0.51, size: 200 } },
    {},
    { maxDistance: 0.06, minSize: 100 },
  );
  assert.equal(z.bidActivated, false);
  assert.equal(z.askActivated, true);
  assert.match(z.bidReason, /量 50 < 100/);
});

test('rewardZoneStatus uses per-market overrides', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 50 }, bestAsk: { price: 0.51, size: 50 } },
    { spreadThreshold: 0.005, shareThreshold: 30 },
    { maxDistance: 0.06, minSize: 100 },
  );
  assert.equal(z.maxDistance, 0.005);
  assert.equal(z.minSize, 30);
  assert.equal(z.bidActivated, false); // spread/2 = 1¢ > 0.5¢
});

test('rewardZoneStatus: source tags reflect precedence layer', () => {
  // env-only path: no override, no REST → defaults
  const z1 = rewardZoneStatus(
    { bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.51, size: 100 } },
    {}, { maxDistance: 0.06, minSize: 100 }, {},
  );
  assert.equal(z1.maxSource, 'env');
  assert.equal(z1.sizeSource, 'env');

  // REST path: market sets both
  const z2 = rewardZoneStatus(
    { bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.51, size: 100 } },
    { spreadThreshold: 0.03, shareThreshold: 200 },
    { maxDistance: 0.06, minSize: 100 }, {},
  );
  assert.equal(z2.maxSource, 'rest');
  assert.equal(z2.sizeSource, 'rest');

  // Override path: /setmarket beats REST
  const z3 = rewardZoneStatus(
    { bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.51, size: 100 } },
    { spreadThreshold: 0.03, shareThreshold: 200 },
    { maxDistance: 0.06, minSize: 100 },
    { maxDistance: 0.01, minSize: null },
  );
  assert.equal(z3.maxSource, 'override');
  assert.equal(z3.sizeSource, 'rest', 'mixed: override on max only, REST still wins for size');
});

test('rewardZoneStatus precedence: explicit override beats REST market value', () => {
  // Real-world scenario the audit caught: REST sets spreadThreshold=0.06
  // (loose), user wants tighter early-warning at 0.02 via /setmarket.
  // The override should win — without it the field was dead code.
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 200 }, bestAsk: { price: 0.51, size: 200 } },
    { spreadThreshold: 0.06, shareThreshold: 100 },     // REST
    { maxDistance: 0.10, minSize: 50 },                  // env default
    { maxDistance: 0.02, minSize: 150 },                 // /setmarket override
  );
  assert.equal(z.maxDistance, 0.02, 'override beats REST');
  assert.equal(z.minSize, 150, 'override beats REST');
});

test('rewardZoneStatus precedence: REST wins when no override set', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 200 }, bestAsk: { price: 0.51, size: 200 } },
    { spreadThreshold: 0.03, shareThreshold: 200 },
    { maxDistance: 0.06, minSize: 100 },
    { maxDistance: null, minSize: null },                // no override
  );
  assert.equal(z.maxDistance, 0.03);
  assert.equal(z.minSize, 200);
});

test('rewardZoneStatus precedence: env default when neither override nor REST set', () => {
  const z = rewardZoneStatus(
    { bestBid: { price: 0.49, size: 200 }, bestAsk: { price: 0.51, size: 200 } },
    {}, // no spreadThreshold/shareThreshold
    { maxDistance: 0.06, minSize: 100 },
    {},
  );
  assert.equal(z.maxDistance, 0.06);
  assert.equal(z.minSize, 100);
});

test('rewardZoneStatus handles empty book', () => {
  const z = rewardZoneStatus({ bestBid: null, bestAsk: null }, {}, { maxDistance: 0.06, minSize: 100 });
  assert.equal(z.bidActivated, false);
  assert.equal(z.askActivated, false);
  assert.equal(z.bidReason, '无买单');
});

test('formatOpportunitySummary: lists side gaps and PP forecast', () => {
  // 1h until end, 1200/h → ≈1200 PP. Bid side missing (zone gap).
  const text = formatOpportunitySummary({
    orderbook: {
      bestBid: { price: 0.30, size: 50 },
      bestAsk: { price: 0.40, size: 80 },
    },
    zone: { bidActivated: false, askActivated: true, bidReason: '量 50 < 100' },
    totalHourlyRate: 1200,
    endMs: Date.now() + 3600_000,
  });
  assert.ok(text.includes('🔥'), 'has opp emoji');
  assert.ok(text.includes('💰'), 'has earn emoji');
  assert.ok(text.includes('买侧'), 'mentions bid gap');
  assert.ok(text.includes('1200 PP/h'), 'shows hourly rate');
  assert.ok(/剩余 1\.0h/.test(text), 'shows remaining hours');
  // 1200 × 1h ≈ 1200 PP
  assert.ok(/≈ <b>1200 PP<\/b>/.test(text), 'shows total PP estimate');
  assert.ok(text.includes('spread 10.00¢'), 'shows spread');
});

test('formatOpportunitySummary: handles missing endMs and zone', () => {
  const text = formatOpportunitySummary({
    orderbook: { bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.51, size: 100 } },
    zone: null,
    totalHourlyRate: 500,
    endMs: null,
  });
  // No "剩余 Xh" when endMs unknown
  assert.ok(!text.includes('剩余'), 'no remaining-hours line without endMs');
  assert.ok(text.includes('500 PP/h'));
  // No zone → "奖励区双边正常" fallback
  assert.ok(text.includes('双边正常'));
});

test('formatOpportunitySummary: skips totalPP when endMs is past', () => {
  const text = formatOpportunitySummary({
    orderbook: { bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.51, size: 100 } },
    zone: null,
    totalHourlyRate: 1000,
    endMs: Date.now() - 1000,
  });
  assert.ok(!text.includes('剩余'));
});

test('scoreSlot: zero rate → zero score', () => {
  assert.equal(scoreSlot({ lastHourlyRate: 0 }), 0);
  assert.equal(scoreSlot({}), 0);
  assert.equal(scoreSlot(null), 0);
});

test('scoreSlot: gap multiplier doubles per missing side', () => {
  // No gap, no spread info → score = rate × 1
  assert.equal(scoreSlot({ lastHourlyRate: 100 }), 100);
  // Single-side gap → +1 mult (×2)
  assert.equal(scoreSlot({
    lastHourlyRate: 100,
    zoneStatus: { bidActivated: false, askActivated: true },
  }), 200);
  // Both sides gap → ×3
  assert.equal(scoreSlot({
    lastHourlyRate: 100,
    zoneStatus: { bidActivated: false, askActivated: false },
  }), 300);
});

test('scoreSlot: tighter spread bumps score', () => {
  // 0.05 spread → mult ≈ 1 + (0.5 - 0.05) = 1.45
  const score = scoreSlot({
    lastHourlyRate: 1000,
    baseline: { bidPrice: 0.50, askPrice: 0.55 },
  });
  assert.ok(score > 1000 * 1.4 && score < 1000 * 1.5);
});

test('priorityOf: bucketing with explicit thresholds', () => {
  const t = { highThreshold: 2000, mediumThreshold: 500 };
  assert.equal(priorityOf(0, t), 'low');
  assert.equal(priorityOf(499, t), 'low');
  assert.equal(priorityOf(500, t), 'medium');
  assert.equal(priorityOf(1999, t), 'medium');
  assert.equal(priorityOf(2000, t), 'high');
  assert.equal(priorityOf(99999, t), 'high');
});
