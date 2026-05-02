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
