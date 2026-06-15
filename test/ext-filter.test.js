import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const { passesExtFilter, extTopOfBook } = await import('../src/commands.js');

test('extTopOfBook: prefers the fresher of recentBook vs baseline', () => {
  // recentBook newer than the monitor baseline → use it.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 1000,
    recentBook: { bids: [{ price: 0.12, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.12, ask: 0.90 });
});

test('extTopOfBook: falls back to baseline when it is the fresher snapshot', () => {
  // Baseline polled after the last wizard refetch → trust the baseline.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 5000,
    recentBook: { bids: [{ price: 0.12, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.10, ask: 0.80 });
});

test('extTopOfBook: baseline-only slot', () => {
  const slot = { baseline: { bidPrice: 0.10, askPrice: 0.80 } };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.10, ask: 0.80 });
});

test('passesExtFilter: "仅 ≥85" judged on the refetched book, not stale baseline', () => {
  // Baseline says ask 0.80 (not extreme); the live refetch shows ask 0.90.
  // The filter must agree with the fresh book the user would open.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 1000,
    recentBook: { bids: [{ price: 0.10, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.equal(passesExtFilter(slot, 'i85'), true);  // include-only-extreme → kept
  assert.equal(passesExtFilter(slot, '85'), false);  // exclude-extreme → dropped
});

test('passesExtFilter: bid side counts as extreme too', () => {
  const slot = { baseline: { bidPrice: 0.05, askPrice: 0.40 } };
  // bid 0.05 ≤ (100-85)=15¢ → extreme.
  assert.equal(passesExtFilter(slot, 'i85'), true);
});

test('passesExtFilter: off mode keeps everything', () => {
  const slot = { baseline: { bidPrice: 0.50, askPrice: 0.52 } };
  assert.equal(passesExtFilter(slot, 'off'), true);
});
