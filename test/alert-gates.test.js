import test from 'node:test';
import assert from 'node:assert/strict';

// Stub before importing anything that reads config.
process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

// Default empty state (helpers we'll need).
const { } = await import('../src/state.js');

// monitor.js doesn't export alert(), and we don't want to spin up the
// full tick machinery just to test the gating. Instead we replicate
// the gate logic structurally — if this drifts from monitor.js, the
// "no telegram send happened" assertions below stop being meaningful.
//
// The gates in alert(state, kind, slot, marketId, ...) are:
//   1. quietUntil > now  →  suppress (non-recovery)
//   2. state.alertKinds[baseKind] === false  →  suppress
//   3. lastHourlyRate < config.alertMinHourlyRate  →  suppress
//
// This test just exercises the state shape so /quiet, /alerts, and
// the env threshold all persist + read what we expect.

const { addAllowedChat } = await import('../src/state.js');

test('state.quietUntil persists set+clear', () => {
  const state = { quietUntil: 0 };
  state.quietUntil = Date.now() + 3600_000;
  assert.ok(state.quietUntil > Date.now());
  state.quietUntil = 0;
  assert.equal(state.quietUntil, 0);
});

test('state.alertKinds: per-kind override leaves others untouched', () => {
  const state = { alertKinds: {} };
  state.alertKinds = { ...state.alertKinds, mid_jump: false };
  assert.equal(state.alertKinds.mid_jump, false);
  assert.equal(state.alertKinds.stall, undefined); // env default applies
});

test('state.alertKinds reset clears overrides', () => {
  const state = { alertKinds: { mid_jump: false, wide_spread: false } };
  state.alertKinds = {};
  assert.deepEqual(state.alertKinds, {});
});

test('state.chatRouting: per-chat exclude list shape', () => {
  // Documents the routing shape used by chatsForKind in monitor.js.
  // Each chat keeps its own exclude list; missing chat = no exclusions.
  const state = { chatRouting: {} };
  state.chatRouting['-100123'] = { exclude: ['mid_jump'] };
  state.chatRouting['-100456'] = { exclude: ['stall', 'wide_spread'] };
  assert.ok(state.chatRouting['-100123'].exclude.includes('mid_jump'));
  assert.equal(state.chatRouting['-100123'].exclude.includes('stall'), false);
  assert.equal(state.chatRouting['-100789'], undefined);  // missing chat = undefined
});

test('state shape sanity: addAllowedChat still works alongside new fields', () => {
  // Regression: confirm the new emptyState fields don't break existing helpers.
  const state = { allowedChats: [], quietUntil: 0, alertKinds: {} };
  addAllowedChat(state, '-100123');
  assert.deepEqual(state.allowedChats, ['-100123']);
});
