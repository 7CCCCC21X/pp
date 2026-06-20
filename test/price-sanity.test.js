import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCapThreshold,
  ladderContext,
  ladderKey,
  classifyDirection,
  buildLadders,
  ladderViolations,
  findPriceSanityIssues,
} from '../src/priceSanity.js';

test('parseCapThreshold: dollar + single-letter scales', () => {
  assert.equal(parseCapThreshold('Will COIN reach $3B market cap?')?.value, 3e9);
  assert.equal(parseCapThreshold('... $4B ...')?.value, 4e9);
  assert.equal(parseCapThreshold('hit a $100M valuation')?.value, 1e8);
  assert.equal(parseCapThreshold('above $500K')?.value, 5e5);
  assert.equal(parseCapThreshold('reach $1T')?.value, 1e12);
});

test('parseCapThreshold: long words and CJK', () => {
  assert.equal(parseCapThreshold('reach $4 billion')?.value, 4e9);
  assert.equal(parseCapThreshold('30 trillion')?.value, 3e13);
  assert.equal(parseCapThreshold('市值达到30亿')?.value, 3e9);
  assert.equal(parseCapThreshold('突破100万')?.value, 1e6);
  assert.equal(parseCapThreshold('涨到1万亿')?.value, 1e12);
});

test('parseCapThreshold: 30亿 and $3B are the same value', () => {
  assert.equal(parseCapThreshold('30亿').value, parseCapThreshold('$3B').value);
});

test('parseCapThreshold: ignores dates, times, bare numbers', () => {
  assert.equal(parseCapThreshold('Bitcoin Up or Down - Jan 1, 2020, 12AM-1AM ET'), null);
  assert.equal(parseCapThreshold('no money here'), null);
  // Bare single-letter scale without "$" must NOT match (prose-safe).
  assert.equal(parseCapThreshold('for 3 months'), null);
  assert.equal(parseCapThreshold('top 5 k players'), null);
});

test('parseCapThreshold: returns matched span for context blanking', () => {
  const text = 'Will COIN reach $3B by Dec 2026?';
  const p = parseCapThreshold(text);
  assert.equal(p.raw, '$3B');
  assert.equal(text.slice(p.start, p.end), '$3B');
  assert.equal(ladderContext(text, p), 'Will COIN reach ___ by Dec 2026?');
});

test('ladderKey: $3B and $4 billion collapse to one ladder key', () => {
  const a = 'Will COIN reach $3B by Dec 2026?';
  const b = 'Will COIN reach $4 billion by Dec 2026?';
  const ka = ladderKey(ladderContext(a, parseCapThreshold(a)));
  const kb = ladderKey(ladderContext(b, parseCapThreshold(b)));
  assert.equal(ka, kb);
});

test('ladderKey: different coins stay separate', () => {
  const a = 'Will BTC reach $3B?';
  const b = 'Will ETH reach $3B?';
  assert.notEqual(
    ladderKey(ladderContext(a, parseCapThreshold(a))),
    ladderKey(ladderContext(b, parseCapThreshold(b))),
  );
});

test('classifyDirection', () => {
  assert.equal(classifyDirection('Will COIN reach $3B market cap?'), 'up');
  assert.equal(classifyDirection('市值达到30亿'), 'up');
  assert.equal(classifyDirection('Will price be below $3B?'), 'down');
  assert.equal(classifyDirection('低于30亿'), 'down');
});

const entry = (id, text, mid) => ({ id, text, mid });

test('buildLadders: groups rungs and sorts ascending by value', () => {
  const ladders = buildLadders([
    entry('a', 'Will COIN reach $5B cap?', 0.40),
    entry('b', 'Will COIN reach $3B cap?', 0.65),
    entry('c', 'Will COIN reach $4B cap?', 0.64),
    entry('z', 'unrelated market', 0.5),
  ]);
  assert.equal(ladders.length, 1);
  assert.deepEqual(ladders[0].rungs.map((r) => r.value), [3e9, 4e9, 5e9]);
});

test('ladderViolations: flags equal / inverted / within-margin (up ladder)', () => {
  // 3B=65¢, 4B=64¢ (gap 1¢ ≤ 3¢) → violation; 4B→5B gap 24¢ → fine.
  const ladders = buildLadders([
    entry('a', 'reach $3B', 0.65),
    entry('b', 'reach $4B', 0.64),
    entry('c', 'reach $5B', 0.40),
  ]);
  const v = ladderViolations(ladders[0], 0.03);
  assert.equal(v.length, 1);
  assert.equal(v[0].lo.value, 3e9);
  assert.equal(v[0].hi.value, 4e9);
  assert.ok(Math.abs(v[0].gap - 0.01) < 1e-9);
});

test('ladderViolations: inverted prices (lower cap cheaper) flagged', () => {
  const ladders = buildLadders([
    entry('a', 'reach $3B', 0.50),
    entry('b', 'reach $4B', 0.55), // higher cap MORE likely → arbitrage
  ]);
  const v = ladderViolations(ladders[0], 0.03);
  assert.equal(v.length, 1);
  assert.ok(v[0].gap < 0);
});

test('ladderViolations: healthy monotone ladder → no violation', () => {
  const ladders = buildLadders([
    entry('a', 'reach $3B', 0.70),
    entry('b', 'reach $4B', 0.50),
    entry('c', 'reach $5B', 0.30),
  ]);
  assert.deepEqual(ladderViolations(ladders[0], 0.03), []);
});

test('ladderViolations: down ladder flips the expectation', () => {
  // "below $X": higher X should be MORE likely. Here 4B priced ≤ 3B → bad.
  const ladders = buildLadders([
    entry('a', 'price below $3B', 0.40),
    entry('b', 'price below $4B', 0.41),
  ]);
  const v = ladderViolations(ladders[0], 0.03);
  assert.equal(v.length, 1);
});

test('findPriceSanityIssues: end-to-end with 30亿/40亿 wording', () => {
  const issues = findPriceSanityIssues([
    entry('m1', '某币市值达到30亿', 0.62),
    entry('m2', '某币市值达到40亿', 0.62), // equal probability → unreasonable
    entry('m3', '某币市值达到50亿', 0.30),
  ], 0.03);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].violations.length, 1);
  assert.equal(issues[0].violations[0].lo.value, 3e9);
  assert.equal(issues[0].violations[0].hi.value, 4e9);
});

test('findPriceSanityIssues: skips entries without mid or threshold', () => {
  const issues = findPriceSanityIssues([
    entry('m1', 'reach $3B', NaN),
    entry('m2', 'reach $4B', 0.5),
  ], 0.03);
  assert.deepEqual(issues, []);
});
