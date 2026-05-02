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

test('FILTER_KEYS has 18 entries (3 levels × 2 sides × 3 attrs)', () => {
  assert.equal(FILTER_KEYS.length, 18);
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
