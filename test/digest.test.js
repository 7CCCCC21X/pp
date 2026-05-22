import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { formatDigestSummary, flushChatDigests } = await import('../src/monitor.js');

test('formatDigestSummary: empty queue → empty string', () => {
  assert.equal(formatDigestSummary([]), '');
});

test('formatDigestSummary: groups by kind, collapses repeats by market', () => {
  const items = [
    { kind: 'stall', marketId: '1', title: 'A', rate: 100, ts: 1 },
    { kind: 'stall', marketId: '1', title: 'A', rate: 100, ts: 2 }, // same market, collapse
    { kind: 'stall', marketId: '2', title: 'B', rate: 200, ts: 3 },
    { kind: 'reward_zone', marketId: '3', title: 'C', rate: 300, ts: 4 },
  ];
  const text = formatDigestSummary(items);
  assert.ok(text.includes('提醒摘要 (4 条)'), 'shows total raw count');
  assert.ok(text.includes('停滞 <b>3</b>'), 'stall count');
  assert.ok(text.includes('奖励区 <b>1</b>'), 'reward_zone count');
  assert.ok(text.includes('#1') && text.includes('#2') && text.includes('#3'));
  // Market #1 should appear once not twice (collapsed)
  const occurrences = (text.match(/#1\b/g) ?? []).length;
  assert.equal(occurrences, 1, 'same market not duplicated');
});

test('formatDigestSummary: includes recovered kinds with their own labels', () => {
  const text = formatDigestSummary([
    { kind: 'reward_zone_recovered', marketId: '1', title: 'X', rate: 100, ts: 1 },
  ]);
  assert.ok(text.includes('奖励区恢复'), 'recovered kinds get labeled separately');
});

test('flushChatDigests: skips chats without intervalMs / empty queue', async () => {
  // No-throw smoke test — actual send is mocked-out by lack of real telegram.
  const state = {
    chatDigests: {
      '111': { intervalMs: 0, queue: [], lastFlushAt: 0 },                  // no interval → skip
      '222': { intervalMs: 5 * 60_000, queue: [], lastFlushAt: 0 },          // empty queue → skip
      '333': { intervalMs: 5 * 60_000, queue: [{ kind: 'stall', marketId: '1', title: 'A', rate: 100 }], lastFlushAt: Date.now() }, // not yet elapsed → skip
    },
  };
  // No exception expected; specifically the never-flushed chat should still have its queued item.
  await flushChatDigests(state).catch(() => {});
  assert.equal(state.chatDigests['111'].queue.length, 0);
  assert.equal(state.chatDigests['222'].queue.length, 0);
  assert.equal(state.chatDigests['333'].queue.length, 1, 'recent flush → leave queue alone');
});

const { shouldSendHourlyDigest } = await import('../src/digest.js');

test('shouldSendHourlyDigest: fires when lastHourlyDigestAt is older than current hour boundary', () => {
  // Fresh state (lastHourlyDigestAt=0) → always due, regardless of clock.
  assert.equal(shouldSendHourlyDigest({ lastHourlyDigestAt: 0 }), true);
});

test('shouldSendHourlyDigest: suppressed if already sent for this hour', () => {
  // Pin lastHourlyDigestAt to the current UTC hour boundary → no second send.
  const now = new Date();
  const boundary = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  assert.equal(shouldSendHourlyDigest({ lastHourlyDigestAt: boundary }), false);
});

test('shouldSendHourlyDigest: fires when last send was an hour ago', () => {
  const now = new Date();
  const prevBoundary = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours() - 1, 0, 0, 0,
  );
  assert.equal(shouldSendHourlyDigest({ lastHourlyDigestAt: prevBoundary }), true);
});

const { rateMovers } = await import('../src/history.js');

test('rateMovers: detects rises, drops, and drop-to-zero via live override', () => {
  const now = Date.now();
  const records = [
    { ts: now - 50 * 60000, event: 'rate', marketId: 'A', title: 'Alpha', hourlyRate: 200 },
    { ts: now - 5 * 60000, event: 'rate', marketId: 'A', title: 'Alpha', hourlyRate: 500 },
    { ts: now - 50 * 60000, event: 'rate', marketId: 'B', title: 'Beta', hourlyRate: 500 },
    { ts: now - 40 * 60000, event: 'rate', marketId: 'B', title: 'Beta', hourlyRate: 500 },
    { ts: now - 50 * 60000, event: 'rate', marketId: 'C', title: 'Gamma', hourlyRate: 100 },
    { ts: now - 5 * 60000, event: 'rate', marketId: 'C', title: 'Gamma', hourlyRate: 100 },
  ];
  // B's reward window ended → live rate is 0 (history's last sample is 500).
  const liveRate = { A: 500, B: 0, C: 100 };
  const movers = rateMovers(records, (id) => liveRate[id]);
  const byId = Object.fromEntries(movers.map((m) => [m.id, m]));
  // A rose 200→500
  assert.equal(byId.A.baseline, 200);
  assert.equal(byId.A.current, 500);
  assert.equal(byId.A.delta, 300);
  // B dropped 500→0 (detected via live override, not history)
  assert.equal(byId.B.baseline, 500);
  assert.equal(byId.B.current, 0);
  assert.equal(byId.B.delta, -500);
  // C unchanged → excluded
  assert.equal(byId.C, undefined);
  // Sorted by |delta| desc → B (500) before A (300)
  assert.deepEqual(movers.map((m) => m.id), ['B', 'A']);
});

test('rateMovers: ignores non-rate events and empty input', () => {
  assert.deepEqual(rateMovers([], () => null), []);
  assert.deepEqual(
    rateMovers([{ ts: 1, event: 'alert', marketId: 'X', kind: 'stall' }], () => null),
    [],
  );
});
