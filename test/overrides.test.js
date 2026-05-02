import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { detectWideSpread } = await import('../src/alerts/wideSpread.js');
const { detectRewardZone } = await import('../src/alerts/rewardZone.js');
const { detectEmptyBook } = await import('../src/alerts/emptyBook.js');
const { config } = await import('../src/config.js');

function makeCtx({ state, slot, orderbook, zone, now }) {
  const calls = [];
  return {
    calls,
    ctx: {
      state,
      slot,
      orderbook,
      marketId: '999',
      market: {},
      totalHourlyRate: 100,
      isPaused: false,
      filtered: false,
      filterReason: null,
      now,
      bidChanged: false,
      askChanged: false,
      zone,
      alert: async (kind, _slot, _id, _msg, extra) => {
        calls.push({ kind, extra });
        return true;
      },
      log: () => {},
    },
  };
}

test('wideSpreadMinMinutes override: gates alert for shorter window', async () => {
  const now = Date.now();
  // Slot has been "wide" for 10 minutes. Global default is 15 — would NOT
  // alert. Per-market override of 5 — SHOULD alert.
  const orderbook = {
    bestBid: { price: 0.30, size: 100 },
    bestAsk: { price: 0.70, size: 100 }, // 0.40 spread, well above default 0.04
  };
  const zone = { bidActivated: true, askActivated: true };
  const slotShared = {
    wideSpreadSince: now - 10 * 60 * 1000,
    wideSpreadAlertedAt: 0,
    wideSpreadRecovered: false,
  };

  const noOverride = makeCtx({
    state: { overrides: {} },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectWideSpread(noOverride.ctx);
  assert.equal(noOverride.calls.length, 0, 'global 15min: no alert at 10min');

  const withOverride = makeCtx({
    state: { overrides: { '999': { wideSpreadMinMinutes: 5 } } },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectWideSpread(withOverride.ctx);
  assert.equal(withOverride.calls.length, 1, 'override 5min: alerts at 10min');
  assert.equal(withOverride.calls[0].kind, 'wide_spread');
});

test('emptyBookMinMinutes override: gates alert for shorter window', async () => {
  const now = Date.now();
  // Half-empty book for 10 minutes. Default 30 — no alert. Override 5 — alerts.
  const orderbook = {
    bestBid: { price: 0.50, size: 100 },
    bestAsk: null,
  };
  const zone = { bidActivated: true, askActivated: false };
  const slotShared = {
    emptyBookSince: now - 10 * 60 * 1000,
    emptyBookAlertedAt: 0,
    emptyBookRecovered: false,
  };

  const noOverride = makeCtx({
    state: { overrides: {} },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectEmptyBook(noOverride.ctx);
  assert.equal(noOverride.calls.length, 0, 'global 30min: no alert at 10min');

  const withOverride = makeCtx({
    state: { overrides: { '999': { emptyBookMinMinutes: 5 } } },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectEmptyBook(withOverride.ctx);
  assert.equal(withOverride.calls.length, 1, 'override 5min: alerts at 10min');
  assert.equal(withOverride.calls[0].kind, 'empty_book');
});

test('rewardZoneMinMinutes override: gates alert for shorter window', async () => {
  const now = Date.now();
  // Zone unstaffed (askActivated=false) for 10 minutes. Default 15 — no alert. Override 5 — alerts.
  const orderbook = {
    bestBid: { price: 0.50, size: 100 },
    bestAsk: { price: 0.55, size: 100 },
  };
  const zone = { bidActivated: true, askActivated: false };
  const slotShared = {
    rewardZoneSince: now - 10 * 60 * 1000,
    rewardZoneAlertedAt: 0,
    rewardZoneRecovered: false,
  };

  const noOverride = makeCtx({
    state: { overrides: {} },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectRewardZone(noOverride.ctx);
  assert.equal(noOverride.calls.length, 0, 'global 15min: no alert at 10min');

  const withOverride = makeCtx({
    state: { overrides: { '999': { rewardZoneMinMinutes: 5 } } },
    slot: { ...slotShared },
    orderbook, zone, now,
  });
  await detectRewardZone(withOverride.ctx);
  assert.equal(withOverride.calls.length, 1, 'override 5min: alerts at 10min');
  assert.equal(withOverride.calls[0].kind, 'reward_zone');
});

test('config defaults are 15/30/15 minutes (sanity)', () => {
  // Locks down the defaults the tests above rely on; if you change them,
  // also update the override-shorter-than-default assertions.
  assert.equal(config.wideSpreadMinMinutes, 15);
  assert.equal(config.emptyBookMinMinutes, 30);
  assert.equal(config.rewardZoneMinMinutes, 15);
});
