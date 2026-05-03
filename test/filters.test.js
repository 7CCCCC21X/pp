import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { checkFilter, FILTER_KEYS, effectiveFilters } = await import('../src/filters.js');

const fullBook = {
  bestBid: { price: 0.50, size: 100 },
  bestAsk: { price: 0.51, size: 80 },
  bids: [{ price: 0.50, size: 100 }, { price: 0.49, size: 50 }, { price: 0.48, size: 30 }],
  asks: [{ price: 0.51, size: 80 }, { price: 0.52, size: 40 }, { price: 0.53, size: 20 }],
};

test('FILTER_KEYS: 24 per-level + 6 derived + 3 zone-gap = 33', () => {
  assert.equal(FILTER_KEYS.length, 33);
});

test('checkFilter passes empty filter set', () => {
  assert.equal(checkFilter(fullBook, {}), null);
});

test('checkFilter level-1 minBidPrice pass', () => {
  assert.equal(checkFilter(fullBook, { minBid1Price: 0.40 }), null);
});

test('checkFilter level-1 minBidPrice fail', () => {
  assert.notEqual(checkFilter(fullBook, { minBid1Price: 0.55 }), null);
});

test('checkFilter level-2 size', () => {
  assert.equal(checkFilter(fullBook, { minBid2Size: 30 }), null);
  assert.notEqual(checkFilter(fullBook, { minBid2Size: 100 }), null);
});

test('checkFilter level-3 size', () => {
  assert.notEqual(checkFilter(fullBook, { minAsk3Size: 100 }), null);
});

test('effectiveFilters: state override beats env', () => {
  const eff = effectiveFilters({ filters: { minBid1Price: 0.10 } });
  assert.equal(eff.minBid1Price, 0.10);
});

test('checkFilter maxBid1Size: thinness gate', () => {
  // Book has bestBid.size=100. maxBid1Size=50 → fails (book is too thick).
  assert.notEqual(checkFilter(fullBook, { maxBid1Size: 50 }), null);
  // maxBid1Size=200 → passes.
  assert.equal(checkFilter(fullBook, { maxBid1Size: 200 }), null);
});

test('checkFilter maxBid1Size on missing level: passes (薄盘 ≡ 0)', () => {
  // No bid at all → for max-size filter, treat as 0, passes.
  assert.equal(checkFilter({ bestAsk: { price: 0.5, size: 100 }, asks: [{ price: 0.5, size: 100 }] }, { maxBid1Size: 50 }), null);
});

test('checkFilter minBid1Size on missing level: fails', () => {
  assert.notEqual(checkFilter({ bestAsk: { price: 0.5, size: 100 }, asks: [{ price: 0.5, size: 100 }] }, { minBid1Size: 50 }), null);
});

test('checkFilter minMid / maxMid', () => {
  // mid = (0.50 + 0.51) / 2 = 0.505
  assert.equal(checkFilter(fullBook, { minMid: 0.40 }), null);
  assert.equal(checkFilter(fullBook, { maxMid: 0.60 }), null);
  assert.notEqual(checkFilter(fullBook, { minMid: 0.60 }), null);
  assert.notEqual(checkFilter(fullBook, { maxMid: 0.40 }), null);
});

test('checkFilter minSpread / maxSpread', () => {
  // spread = 0.51 - 0.50 = 0.01
  assert.equal(checkFilter(fullBook, { maxSpread: 0.05 }), null);
  assert.notEqual(checkFilter(fullBook, { minSpread: 0.05 }), null);
});

test('checkFilter maxTopUsd', () => {
  // top = 0.50*100 + 0.51*80 = 50 + 40.8 = 90.8
  assert.equal(checkFilter(fullBook, { maxTopUsd: 100 }), null);
  assert.notEqual(checkFilter(fullBook, { maxTopUsd: 50 }), null);
});

test('checkFilter maxTotalUsd: sums depth-3 both sides', () => {
  // bids: 50 + 24.5 + 14.4 = 88.9; asks: 40.8 + 20.8 + 10.6 = 72.2; total ≈ 161.1
  assert.equal(checkFilter(fullBook, { maxTotalUsd: 200 }), null);
  assert.notEqual(checkFilter(fullBook, { maxTotalUsd: 100 }), null);
});

test('checkFilter requireAnyRewardGap: needs zone, passes when one side unstaffed', () => {
  // No zone → unknown.
  assert.notEqual(checkFilter(fullBook, { requireAnyRewardGap: 1 }), null);
  // Both activated → blocks.
  assert.notEqual(
    checkFilter(fullBook, { requireAnyRewardGap: 1 }, { zone: { bidActivated: true, askActivated: true } }),
    null,
  );
  // One side gap → passes.
  assert.equal(
    checkFilter(fullBook, { requireAnyRewardGap: 1 }, { zone: { bidActivated: true, askActivated: false } }),
    null,
  );
});

test('checkFilter requireBidRewardGap / requireAskRewardGap', () => {
  const zone = { bidActivated: false, askActivated: true };
  assert.equal(checkFilter(fullBook, { requireBidRewardGap: 1 }, { zone }), null);
  assert.notEqual(checkFilter(fullBook, { requireAskRewardGap: 1 }, { zone }), null);
});
