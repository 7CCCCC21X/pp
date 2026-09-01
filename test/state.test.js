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

const { stallDurationMs } = await import('../src/state.js');
const POLL = 300000; // POLL_INTERVAL_MS default
const CAP = 2 * POLL;

test('stallDurationMs: uses the accumulator plus a capped live sliver', () => {
  const now = 10_000_000;
  // Observed 3h ago at this tick; one poll interval has elapsed since.
  const slot = { stallMs: 3 * 3600 * 1000, lastObservedAt: now - POLL };
  assert.equal(stallDurationMs(slot, now), 3 * 3600 * 1000 + POLL);
});

test('stallDurationMs: live sliver is capped so a gap does not inflate it', () => {
  const now = 10_000_000;
  // Bot has been dark for 6h since the last successful observation — the
  // displayed stall must only grow by the cap, not the whole 6h gap.
  const slot = { stallMs: 3600 * 1000, lastObservedAt: now - 6 * 3600 * 1000 };
  assert.equal(stallDurationMs(slot, now), 3600 * 1000 + CAP);
});

test('stallDurationMs: falls back to lastChangeAt for legacy slots', () => {
  const now = 10_000_000;
  const slot = { lastChangeAt: now - 2 * 3600 * 1000 };
  assert.equal(stallDurationMs(slot, now), 2 * 3600 * 1000);
});

test('stallDurationMs: null when there is nothing to measure', () => {
  assert.equal(stallDurationMs(null, 1), null);
  assert.equal(stallDurationMs({}, 1), null);
});

const { isAdminChat, isAdminUser, isPermittedChat, addAllowedChat, removeAllowedChat, broadcastChats } = await import('../src/state.js');

test('isAdminChat: matches TELEGRAM_CHAT_ID env', () => {
  // env stub above sets TELEGRAM_CHAT_ID=1
  assert.equal(isAdminChat('1'), true);
  assert.equal(isAdminChat(1), true); // string-coerced
  assert.equal(isAdminChat('2'), false);
  assert.equal(isAdminChat(null), false);
  assert.equal(isAdminChat(''), false);
});

test('isAdminUser: matches the admin user id (private chat id)', () => {
  // /activate uses this so admin can run from groups (where chat.id !== from.id).
  assert.equal(isAdminUser('1'), true);
  assert.equal(isAdminUser(1), true);
  assert.equal(isAdminUser('999'), false);
  assert.equal(isAdminUser(null), false);
});

test('isPermittedChat: admin OR runtime whitelist OR env whitelist', () => {
  const state = { allowedChats: ['-1001234567890'] };
  assert.equal(isPermittedChat(state, '1'), true);              // admin
  assert.equal(isPermittedChat(state, '-1001234567890'), true); // runtime
  assert.equal(isPermittedChat(state, '999'), false);           // unknown
  assert.equal(isPermittedChat(state, null), false);
});

test('addAllowedChat: dedupes and reports', () => {
  const state = { allowedChats: [] };
  assert.equal(addAllowedChat(state, '-100'), true);
  assert.equal(addAllowedChat(state, '-100'), false);
  assert.deepEqual(state.allowedChats, ['-100']);
});

test('removeAllowedChat: removes when present', () => {
  const state = { allowedChats: ['-100', '-200'] };
  assert.equal(removeAllowedChat(state, '-100'), true);
  assert.deepEqual(state.allowedChats, ['-200']);
  assert.equal(removeAllowedChat(state, '-100'), false);
});

test('broadcastChats: union of admin + env + runtime, deduped', () => {
  const state = { allowedChats: ['-100', '1'] };  // '1' duplicates env admin
  const out = broadcastChats(state);
  assert.ok(out.includes('1'));
  assert.ok(out.includes('-100'));
  // dedupe: admin + runtime '1' counts once
  assert.equal(out.length, new Set(out).size);
});

const { recordMarketFirstSeen } = await import('../src/state.js');

test('recordMarketFirstSeen: first call bootstraps existing markets at ms=0', () => {
  // On a fresh install with thousands of pre-existing rewarded markets we
  // must NOT flag them all as "new today". Empty map → all entries set to 0.
  const state = { marketFirstSeen: {} };
  const r = recordMarketFirstSeen(state, [
    { id: 'A', title: 'Alpha', hourlyRate: 100, endMs: 1000 },
    { id: 'B', title: 'Beta', hourlyRate: 200, endMs: 2000 },
  ]);
  assert.equal(r.added, 0);
  assert.equal(state.marketFirstSeen.A.ms, 0);
  assert.equal(state.marketFirstSeen.B.ms, 0);
  assert.equal(state.marketFirstSeen.A.title, 'Alpha');
  assert.equal(state.marketFirstSeen.A.rate, 100);
});

test('recordMarketFirstSeen: subsequent unseen ids get current timestamp', () => {
  // After bootstrap, a market id that wasn't previously seen counts as new.
  const state = {
    marketFirstSeen: {
      A: { ms: 0, title: 'Alpha', rate: 100, endMs: 1000 },
    },
  };
  const before = Date.now();
  const r = recordMarketFirstSeen(state, [
    { id: 'A', title: 'Alpha', hourlyRate: 100, endMs: 1000 },
    { id: 'C', title: 'Gamma', hourlyRate: 300, endMs: 3000 },
  ]);
  const after = Date.now();
  assert.equal(r.added, 1);
  assert.equal(state.marketFirstSeen.A.ms, 0); // unchanged
  assert.ok(state.marketFirstSeen.C.ms >= before);
  assert.ok(state.marketFirstSeen.C.ms <= after);
  assert.equal(state.marketFirstSeen.C.title, 'Gamma');
});

test('recordMarketFirstSeen: prunes entries older than 14d', () => {
  const old = Date.now() - 15 * 24 * 3600 * 1000;
  const recent = Date.now() - 3600 * 1000;
  const state = {
    marketFirstSeen: {
      OLD: { ms: old, title: 'old', rate: 1, endMs: 0 },
      RECENT: { ms: recent, title: 'recent', rate: 1, endMs: 0 },
      BOOTSTRAP: { ms: 0, title: 'pre-existing', rate: 1, endMs: 0 },
    },
  };
  const r = recordMarketFirstSeen(state, [{ id: 'NEW', title: 'new', hourlyRate: 1, endMs: 0 }]);
  assert.equal(r.added, 1);
  assert.equal(r.pruned, 1);
  assert.equal(state.marketFirstSeen.OLD, undefined);
  assert.ok(state.marketFirstSeen.RECENT);
  assert.ok(state.marketFirstSeen.BOOTSTRAP);
  assert.ok(state.marketFirstSeen.NEW);
});

const { isBotPaused } = await import('../src/state.js');

test('isBotPaused: 0 = not paused', () => {
  assert.equal(isBotPaused({ botPausedUntil: 0 }), false);
  assert.equal(isBotPaused({}), false);
});

test('isBotPaused: -1 = indefinite pause', () => {
  const state = { botPausedUntil: -1 };
  assert.equal(isBotPaused(state), true);
  assert.equal(state.botPausedUntil, -1); // stays paused
});

test('isBotPaused: timed pause active until deadline', () => {
  const state = { botPausedUntil: Date.now() + 60_000 };
  assert.equal(isBotPaused(state), true);
});

test('isBotPaused: expired timed pause auto-clears', () => {
  const state = { botPausedUntil: Date.now() - 1000 };
  assert.equal(isBotPaused(state), false);
  assert.equal(state.botPausedUntil, 0); // cleared so it persists as off
});
