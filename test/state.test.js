import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const { activeMarketIds } = await import('../src/state.js');

test('activeMarketIds: env + manual + auto, minus removed', () => {
  const ids = activeMarketIds({
    manualIds: ['D'],
    autoIds: ['E', 'F'],
    removedIds: ['B'],
    watchedIds: ['G'],
  });
  ids.sort();
  assert.deepEqual(ids, ['A', 'C', 'D', 'E', 'F', 'G']);
});

test('activeMarketIds dedupes', () => {
  const ids = activeMarketIds({
    manualIds: ['A'],
    autoIds: ['A', 'B'],
    removedIds: [],
    watchedIds: ['B'],
  });
  ids.sort();
  assert.deepEqual(ids, ['A', 'B', 'C']);
});

test('activeMarketIds: removed wins', () => {
  const ids = activeMarketIds({
    manualIds: ['A'],
    autoIds: ['A'],
    removedIds: ['A'],
    watchedIds: ['A'],
  });
  // A removed, B and C still in MARKET_IDS env
  ids.sort();
  assert.deepEqual(ids, ['B', 'C']);
});

const { effectiveOverride, isSnoozed } = await import('../src/state.js');

test('effectiveOverride: per-market value wins over fallback', () => {
  const state = { overrides: { '999': { maxSpread: 0.02, staleHours: 2 } } };
  assert.equal(effectiveOverride(state, '999', 'maxSpread', 0.04), 0.02);
  assert.equal(effectiveOverride(state, '999', 'staleHours', 6), 2);
});

test('effectiveOverride: falls back when market has no entry', () => {
  const state = { overrides: { '999': { maxSpread: 0.02 } } };
  assert.equal(effectiveOverride(state, '888', 'maxSpread', 0.04), 0.04);
});

test('effectiveOverride: falls back when key is missing on the market', () => {
  const state = { overrides: { '999': { staleHours: 2 } } };
  assert.equal(effectiveOverride(state, '999', 'maxSpread', 0.04), 0.04);
});

test('effectiveOverride: ignores non-numeric overrides', () => {
  const state = { overrides: { '999': { maxSpread: 'oops' } } };
  assert.equal(effectiveOverride(state, '999', 'maxSpread', 0.04), 0.04);
});

test('isSnoozed: cleans expired entry', () => {
  const state = { snoozes: { '999': Date.now() - 1000 } };
  assert.equal(isSnoozed(state, '999'), false);
  assert.equal(state.snoozes['999'], undefined);
});
