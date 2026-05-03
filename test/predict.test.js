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

test('extractHourlyRate skips expired rewardTimings (endsAt in past)', () => {
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.equal(extractHourlyRate({
    rewardTimings: [
      { hourlyRate: 1500, endsAt: past },     // ended an hour ago — drop
      { hourlyRate: 200, endsAt: future },    // still active — count
    ],
  }), 200);
});

test('extractHourlyRate skips not-yet-started rewardTimings', () => {
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.equal(extractHourlyRate({
    rewardTimings: [
      { hourlyRate: 500, startsAt: future },  // starts in 1h — drop
      { hourlyRate: 100 },                    // no time bounds — count
    ],
  }), 100);
});

test('extractHourlyRate respects isActive=false', () => {
  assert.equal(extractHourlyRate({
    rewardTimings: [
      { hourlyRate: 999, isActive: false },
      { hourlyRate: 50, isActive: true },
    ],
  }), 50);
});

test('extractHourlyRate: all expired -> 0 (resolved market case)', () => {
  const past = new Date(Date.now() - 86400 * 1000).toISOString();
  assert.equal(extractHourlyRate({
    rewardTimings: [
      { hourlyRate: 1700, endsAt: past },
    ],
  }), 0);
});

test('extractHourlyRate: REST rewards.current wins over GraphQL rewardTimings', () => {
  // 76ers vs Celtics case: GraphQL returns [1200, 9000] (sums to 10200)
  // but REST current.hourlyRate = 1200 is the only one actually paying now.
  assert.equal(extractHourlyRate({
    rewards: {
      current: { hourlyRate: 1200, startsAt: '2026-01-01T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' },
      schedule: [
        { hourlyRate: 1200, startsAt: '2026-01-01T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' },
        { hourlyRate: 9000, startsAt: '2030-01-01T00:00:00Z', endsAt: '2031-01-01T00:00:00Z' },
      ],
    },
    rewardTimings: [{ hourlyRate: 1200 }, { hourlyRate: 9000 }],
  }), 1200);
});

test('extractHourlyRate: rewards.current null with active schedule entry', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(extractHourlyRate({
    rewards: {
      current: null,
      schedule: [
        { hourlyRate: 1000, startsAt: past, endsAt: future },  // active
        { hourlyRate: 5000, startsAt: future, endsAt: future },  // future
      ],
    },
  }), 1000);
});

test('extractHourlyRate: schedule with no active entry -> 0', () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(extractHourlyRate({
    rewards: {
      current: null,
      schedule: [
        { hourlyRate: 1000, startsAt: past, endsAt: past },
      ],
    },
  }), 0);
});

test('extractHourlyRate: falls back to GraphQL when REST rewards absent', () => {
  assert.equal(extractHourlyRate({
    rewardTimings: [{ hourlyRate: 500 }],
  }), 500);
});

test('extractHourlyRate: GraphQL rewardTimings ignored when title parses to past end', () => {
  // 15-min Bitcoin markets: Predict.fun's GraphQL exposes hourlyRate but
  // not endsAt on RewardTiming, so without parseEndFromTitle backup the
  // bound-less entry would sum to 3000 even after the market ended.
  assert.equal(extractHourlyRate({
    title: 'Bitcoin Up or Down - Jan 1, 2020, 12AM-1AM ET',
    rewardTimings: [{ hourlyRate: 3000 }],
  }), 0);
});

test('extractHourlyRate: GraphQL rewardTimings still counted for future markets', () => {
  assert.equal(extractHourlyRate({
    title: 'Bitcoin Up or Down - Dec 31, 2099, 11AM-12PM ET',
    rewardTimings: [{ hourlyRate: 3000 }],
  }), 3000);
});

test('extractHourlyRate: REST current still wins when title parses to past', () => {
  // The parsed-title guard only kicks in for the GraphQL fallback path —
  // if REST explicitly says current is paying, that's the source of truth.
  assert.equal(extractHourlyRate({
    title: 'Bitcoin Up or Down - Jan 1, 2020, 12AM-1AM ET',
    rewards: { current: { hourlyRate: 1500 } },
    rewardTimings: [{ hourlyRate: 3000 }],
  }), 1500);
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
