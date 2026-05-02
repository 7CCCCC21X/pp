import test from 'node:test';
import assert from 'node:assert/strict';

// Stub env so config.js doesn't throw on import.
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { extractHourlyRate, isMarketTradeable, marketEndMs } =
  await import('../src/predict.js');

test('extractHourlyRate prefers GraphQL rewardTimings array', () => {
  assert.equal(extractHourlyRate({ rewardTimings: [{ hourlyRate: 1.5 }] }), 1.5);
  assert.equal(
    extractHourlyRate({ rewardTimings: [{ hourlyRate: 5 }, { hourlyRate: 0.5 }] }),
    5.5,
  );
  assert.equal(extractHourlyRate({ rewardTimings: [] }), 0);
});

test('extractHourlyRate falls back to recursive REST rewards', () => {
  assert.equal(extractHourlyRate({ rewards: { schedule: { hourlyRate: 0.7 } } }), 0.7);
  assert.equal(extractHourlyRate({ rewards: [{ hourlyRate: 1 }, { hourlyRate: 2 }] }), 3);
});

test('extractHourlyRate handles null/empty', () => {
  assert.equal(extractHourlyRate(null), 0);
  assert.equal(extractHourlyRate({}), 0);
  assert.equal(extractHourlyRate({ rewards: null }), 0);
});

test('marketEndMs accepts ISO string', () => {
  const iso = '2030-01-01T00:00:00.000Z';
  const ts = Date.parse(iso);
  assert.equal(marketEndMs({ endsAt: iso }), ts);
});

test('marketEndMs accepts millisecond epoch', () => {
  const ts = Date.now() + 60_000;
  assert.equal(marketEndMs({ endsAt: ts }), ts);
});

test('marketEndMs accepts second epoch', () => {
  const sec = Math.floor(Date.now() / 1000) + 60;
  const got = marketEndMs({ endsAt: sec });
  assert.equal(got, sec * 1000);
});

test('marketEndMs returns null when missing', () => {
  assert.equal(marketEndMs({}), null);
  assert.equal(marketEndMs(null), null);
});

test('isMarketTradeable: active market', () => {
  assert.equal(isMarketTradeable({
    isResolved: false,
    status: 'OPEN',
    endsAt: new Date(Date.now() + 3600_000).toISOString(),
  }), true);
});

test('isMarketTradeable: resolved by isResolved', () => {
  assert.equal(isMarketTradeable({ isResolved: true }), false);
});

test('isMarketTradeable: resolved by status', () => {
  assert.equal(isMarketTradeable({ status: 'RESOLVED' }), false);
  assert.equal(isMarketTradeable({ tradingStatus: 'CLOSED' }), false);
});

test('isMarketTradeable: past endsAt', () => {
  assert.equal(isMarketTradeable({
    endsAt: new Date(Date.now() - 1000).toISOString(),
  }), false);
});

test('isMarketTradeable: no info defaults true', () => {
  assert.equal(isMarketTradeable({ id: '1' }), true);
});

test('isMarketTradeable: null is false', () => {
  assert.equal(isMarketTradeable(null), false);
});
