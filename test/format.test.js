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
