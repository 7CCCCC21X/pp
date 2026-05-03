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
