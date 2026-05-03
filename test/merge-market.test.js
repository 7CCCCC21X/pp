import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { mergeMarket } = await import('../src/predict.js');

test('mergeMarket: REST spreadThreshold beats GraphQL 0 (the bug fix)', () => {
  // Reproduction of the alert showing "(env)" for market #248666:
  // GraphQL returned spreadThreshold: 0 (default-tier), REST said
  // 0.03/200, and the old `combined[k] == null` check missed the
  // overwrite because 0 != null.
  const merged = mergeMarket(
    { id: '248666', title: 'X', spreadThreshold: 0, shareThreshold: 0 },
    { id: '248666', spreadThreshold: 0.03, shareThreshold: 200 },
    '248666',
  );
  assert.equal(merged.spreadThreshold, 0.03);
  assert.equal(merged.shareThreshold, 200);
});

test('mergeMarket: REST positive value also wins when GraphQL is missing', () => {
  const merged = mergeMarket(
    { id: '1', title: 'X' },               // no spreadThreshold from GraphQL
    { id: '1', spreadThreshold: 0.06, shareThreshold: 100 },
    '1',
  );
  assert.equal(merged.spreadThreshold, 0.06);
  assert.equal(merged.shareThreshold, 100);
});

test('mergeMarket: GraphQL value preserved if REST is 0/missing', () => {
  // Reverse direction: if REST returns 0 (unlikely but defensive),
  // we don't clobber a non-zero GraphQL value.
  const merged = mergeMarket(
    { id: '1', spreadThreshold: 0.05, shareThreshold: 150 },
    { id: '1', spreadThreshold: 0 },
    '1',
  );
  assert.equal(merged.spreadThreshold, 0.05);
  assert.equal(merged.shareThreshold, 150);
});

test('mergeMarket: title/question copy when GraphQL missing', () => {
  const merged = mergeMarket(
    { id: '1' },
    { id: '1', title: 'REST title', question: 'REST question' },
    '1',
  );
  assert.equal(merged.title, 'REST title');
  assert.equal(merged.question, 'REST question');
});

test('mergeMarket: GraphQL title kept (not overwritten by REST)', () => {
  const merged = mergeMarket(
    { id: '1', title: 'GraphQL title' },
    { id: '1', title: 'REST title' },
    '1',
  );
  assert.equal(merged.title, 'GraphQL title');
});

test('mergeMarket: REST runtime fields always win', () => {
  // rewards / tradingStatus / isResolved / endsAt are explicitly always-from-REST.
  const merged = mergeMarket(
    { id: '1', rewards: { current: { hourlyRate: 1 } }, tradingStatus: 'OLD', endsAt: '2020-01-01' },
    { id: '1', rewards: { current: { hourlyRate: 9999 } }, tradingStatus: 'NEW', endsAt: '2030-12-31', isResolved: false },
    '1',
  );
  assert.equal(merged.rewards.current.hourlyRate, 9999);
  assert.equal(merged.tradingStatus, 'NEW');
  assert.equal(merged.endsAt, '2030-12-31');
  assert.equal(merged.isResolved, false);
});

test('mergeMarket: handles null GraphQL (REST-only path)', () => {
  const merged = mergeMarket(
    null,
    { id: '1', title: 'X', spreadThreshold: 0.04, shareThreshold: 80 },
    '1',
  );
  assert.equal(merged.id, '1');
  assert.equal(merged.title, 'X');
  assert.equal(merged.spreadThreshold, 0.04);
  assert.equal(merged.shareThreshold, 80);
});

test('mergeMarket: handles null REST (GraphQL-only path)', () => {
  const merged = mergeMarket(
    { id: '1', title: 'X', spreadThreshold: 0.05 },
    null,
    '1',
  );
  assert.equal(merged.id, '1');
  assert.equal(merged.spreadThreshold, 0.05);
});
