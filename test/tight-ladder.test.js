import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const { analyzeLadderSide, evalTightMarket, inferTickProb, resolveGapProb } = await import('../src/commands.js');

// Prices are probabilities in [0,1]; 0.1¢ = 0.001. The screenshot ladder
// (9.6¢/9.7¢/9.8¢ one tick apart) → consecutive steps of 0.001.
const lvl = (p, s) => ({ price: p, size: s });

test('analyzeLadderSide: dense one-tick ladder passes at 0.1¢ gap', () => {
  const rows = [lvl(0.098, 3584), lvl(0.097, 6700), lvl(0.096, 5640)];
  const r = analyzeLadderSide(rows, 3, 0.001);
  assert.equal(r.dense, true);
  assert.equal(r.shares, 3584 + 6700 + 5640);
  assert.ok(Math.abs(r.maxStep - 0.001) < 1e-9);
});

test('analyzeLadderSide: a gap wider than threshold fails', () => {
  // 0.098 → 0.097 → 0.090: last step is 0.7¢, over a 0.1¢ threshold.
  const rows = [lvl(0.098, 100), lvl(0.097, 100), lvl(0.090, 100)];
  assert.equal(analyzeLadderSide(rows, 3, 0.001).dense, false);
  // …but loosening the gap to 1¢ accepts it.
  assert.equal(analyzeLadderSide(rows, 3, 0.01).dense, true);
});

test('analyzeLadderSide: fewer levels than required fails', () => {
  const rows = [lvl(0.098, 100), lvl(0.097, 100)];
  assert.equal(analyzeLadderSide(rows, 3, 0.001).dense, false);
});

test('analyzeLadderSide: only the first N levels matter', () => {
  // 4 dense levels; asking for 3 ignores the 4th (which has a big jump).
  const rows = [lvl(0.098, 10), lvl(0.097, 10), lvl(0.096, 10), lvl(0.050, 10)];
  const r = analyzeLadderSide(rows, 3, 0.001);
  assert.equal(r.dense, true);
  assert.equal(r.shares, 30);
});

test('evalTightMarket: both-sides mode requires both dense', () => {
  const slot = {
    recentBook: {
      bids: [lvl(0.098, 1000), lvl(0.097, 1000), lvl(0.096, 1000)],
      asks: [lvl(0.100, 500), lvl(0.101, 500), lvl(0.102, 500)],
    },
  };
  const both = evalTightMarket(slot, { levels: 3, gap: '0.1', both: true });
  assert.ok(both);
  assert.equal(both.shares, 4500); // 3000 bids + 1500 asks
  assert.ok(both.mid != null);

  // Break the ask side: 0.100 → 0.101 → 0.110 (0.9¢ step) fails both-mode.
  slot.recentBook.asks = [lvl(0.100, 500), lvl(0.101, 500), lvl(0.110, 500)];
  assert.equal(evalTightMarket(slot, { levels: 3, gap: '0.1', both: true }), null);

  // Either-side mode still qualifies on the dense bid side, and the depth
  // metric counts only the qualifying side.
  const either = evalTightMarket(slot, { levels: 3, gap: '0.1', both: false });
  assert.ok(either);
  assert.equal(either.shares, 3000);
});

test('evalTightMarket: no recentBook yields null', () => {
  assert.equal(evalTightMarket({}, { levels: 3, gap: '0.1', both: true }), null);
});

// --- tick detection / 整格(auto) mode: recognize 1¢-tick markets too ---

test('inferTickProb: whole-cent ladder is detected as a 1¢ tick', () => {
  const rows = [lvl(0.10, 1), lvl(0.11, 1), lvl(0.12, 1)];
  assert.equal(inferTickProb(rows, 3), 0.01);
});

test('inferTickProb: tenth-cent ladder is detected as a 0.1¢ tick', () => {
  const rows = [lvl(0.098, 1), lvl(0.097, 1), lvl(0.096, 1)];
  assert.equal(inferTickProb(rows, 3), 0.001);
});

test('resolveGapProb: auto follows the side tick, fixed value ignores it', () => {
  const cents = [lvl(0.10, 1), lvl(0.11, 1), lvl(0.12, 1)];
  assert.equal(resolveGapProb('auto', cents, 3), 0.01);
  assert.equal(resolveGapProb('1', cents, 3), 0.01);
  assert.equal(resolveGapProb('0.1', cents, 3), 0.001);
});

test('auto mode: a contiguous 1¢-tick market qualifies; a fixed 0.1¢ gap rejects it', () => {
  const slot = {
    recentBook: {
      bids: [lvl(0.12, 1000), lvl(0.11, 1000), lvl(0.10, 1000)],
      asks: [lvl(0.13, 800), lvl(0.14, 800), lvl(0.15, 800)],
    },
  };
  // 整格/auto: both sides are one whole cent apart → dense.
  const auto = evalTightMarket(slot, { levels: 3, gap: 'auto', both: true });
  assert.ok(auto, 'auto mode should recognize the 1¢-tick ladder');
  assert.equal(auto.shares, 5400);
  // Fixed 0.1¢ threshold: 1¢ steps are 10× too wide → rejected.
  assert.equal(evalTightMarket(slot, { levels: 3, gap: '0.1', both: true }), null);
});

test('auto mode: a 1¢-tick market with a skipped level is not dense', () => {
  const slot = {
    recentBook: {
      bids: [lvl(0.12, 1), lvl(0.11, 1), lvl(0.10, 1)],
      asks: [lvl(0.13, 1), lvl(0.15, 1), lvl(0.16, 1)], // 0.13→0.15 skips 0.14
    },
  };
  assert.equal(evalTightMarket(slot, { levels: 3, gap: 'auto', both: true }), null);
  // The bid side alone is still contiguous, so either-side mode passes.
  assert.ok(evalTightMarket(slot, { levels: 3, gap: 'auto', both: false }));
});
