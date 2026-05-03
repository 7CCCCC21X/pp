import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { detectSnapshot } = await import('../src/alerts/snapshot.js');

function makeCtx({ state, slot, intervalMs, lastSentAt, now }) {
  const calls = [];
  return {
    calls,
    ctx: {
      state,
      slot,
      orderbook: {
        bestBid: { price: 0.50, size: 100 },
        bestAsk: { price: 0.51, size: 100 },
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.51, size: 100 }],
      },
      marketId: '999',
      market: {},
      totalHourlyRate: 1000,
      zone: { bidActivated: true, askActivated: true, maxDistance: 0.06, minSize: 100, maxSource: 'rest', sizeSource: 'rest' },
      now,
      alert: async (kind, _slot, _id, _msg, extra) => {
        calls.push({ kind, extra });
        return true;
      },
    },
  };
}

test('detectSnapshot: fires once interval has elapsed', async () => {
  const now = Date.now();
  const state = { snapshots: { '999': { intervalMs: 5 * 60_000, lastSentAt: now - 6 * 60_000 } } };
  const slot = { title: 'Test', endMs: now + 3600_000 };
  const { ctx, calls } = makeCtx({ state, slot, now });
  await detectSnapshot(ctx);
  assert.equal(calls.length, 1, '6min elapsed > 5min interval → fires');
  assert.equal(calls[0].kind, 'snapshot');
  // alert mock returns true; detectSnapshot should also stamp lastSentAt
  assert.ok(state.snapshots['999'].lastSentAt >= now);
});

test('detectSnapshot: stays silent before interval elapses', async () => {
  const now = Date.now();
  const state = { snapshots: { '999': { intervalMs: 10 * 60_000, lastSentAt: now - 2 * 60_000 } } };
  const slot = { title: 'Test', endMs: now + 3600_000 };
  const { ctx, calls } = makeCtx({ state, slot, now });
  await detectSnapshot(ctx);
  assert.equal(calls.length, 0, '2min elapsed < 10min interval → silent');
});

test('detectSnapshot: no-op when market not registered', async () => {
  const now = Date.now();
  const state = { snapshots: {} };
  const slot = { title: 'Test' };
  const { ctx, calls } = makeCtx({ state, slot, now });
  await detectSnapshot(ctx);
  assert.equal(calls.length, 0);
});

test('detectSnapshot: first run (lastSentAt=0) fires immediately', async () => {
  const now = Date.now();
  const state = { snapshots: { '999': { intervalMs: 5 * 60_000, lastSentAt: 0 } } };
  const slot = { title: 'Test' };
  const { ctx, calls } = makeCtx({ state, slot, now });
  await detectSnapshot(ctx);
  assert.equal(calls.length, 1, 'lastSentAt=0 means "never sent" — fires on first tick');
});
