import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDateThreshold,
  classifyDateDirection,
  buildComboLadders,
  classifyComboEntry,
  comboPairs,
  hedgeableWithinCap,
} from '../src/combo.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('parseDateThreshold: CJK full dates, with and without spaces', () => {
  assert.equal(parseDateThreshold('2026年9月30日')?.value, Date.UTC(2026, 8, 30));
  assert.equal(parseDateThreshold('2026 年 12 月 31 日')?.value, Date.UTC(2026, 11, 31));
});

test('parseDateThreshold: CJK without year uses defaultYear', () => {
  assert.equal(
    parseDateThreshold('9月30日', { defaultYear: 2026 })?.value,
    Date.UTC(2026, 8, 30),
  );
});

test('parseDateThreshold: CJK month-only → end of month', () => {
  assert.equal(parseDateThreshold('2026年9月')?.value, Date.UTC(2026, 9, 0));
});

test('parseDateThreshold: bare 月 without year or day is rejected', () => {
  assert.equal(parseDateThreshold('9月', { defaultYear: 2026 }), null);
});

test('parseDateThreshold: English month-day-year and month-year', () => {
  assert.equal(
    parseDateThreshold('launch by September 30, 2026?')?.value,
    Date.UTC(2026, 8, 30),
  );
  assert.equal(
    parseDateThreshold('by Dec 31', { defaultYear: 2026 })?.value,
    Date.UTC(2026, 11, 31),
  );
  // Month + year, no day → end of that month.
  assert.equal(parseDateThreshold('in March 2026')?.value, Date.UTC(2026, 2, 31));
});

test('parseDateThreshold: numeric dates', () => {
  assert.equal(parseDateThreshold('by 2026-09-30')?.value, Date.UTC(2026, 8, 30));
  assert.equal(parseDateThreshold('by 2026/9/30')?.value, Date.UTC(2026, 8, 30));
});

test('parseDateThreshold: intraday up-or-down titles are rejected', () => {
  assert.equal(parseDateThreshold('Bitcoin Up or Down - May 3, 5AM-5:15AM ET'), null);
  assert.equal(parseDateThreshold('BNB up or down (May 2 2026 2am ET)'), null);
});

test('parseDateThreshold: returns matched span for context blanking', () => {
  const text = 'Will Plasma launch by September 30, 2026?';
  const p = parseDateThreshold(text);
  assert.equal(text.slice(p.start, p.end), p.raw);
  assert.match(p.raw, /September 30, 2026/);
});

test('classifyDateDirection: by/before is down, after is up', () => {
  assert.equal(classifyDateDirection('launch by Sep 30, 2026'), 'down');
  assert.equal(classifyDateDirection('2026年9月30日'), 'down');
  assert.equal(classifyDateDirection('launch after Sep 30, 2026'), 'up');
  assert.equal(classifyDateDirection('9月30日之后发币'), 'up');
});

test('buildComboLadders: FDV bucket titles group into one money ladder', () => {
  const ladders = buildComboLadders([
    { id: '1', title: '5000万美元', question: 'Pump.fun FDV?' },
    { id: '2', title: '1亿美元', question: 'Pump.fun FDV?' },
  ]);
  assert.equal(ladders.length, 1);
  const l = ladders[0];
  assert.equal(l.kind, 'money');
  assert.equal(l.direction, 'up');
  assert.deepEqual(l.rungs.map((r) => r.id), ['1', '2']);
  assert.equal(l.rungs[0].value, 5e7);
  assert.equal(l.rungs[1].value, 1e8);
});

test('buildComboLadders: date bucket titles group into one date ladder', () => {
  const ladders = buildComboLadders([
    { id: '10', title: '2026年9月30日', question: 'Plasma 什么时候发币？' },
    { id: '11', title: '2026 年 12 月 31 日', question: 'Plasma 什么时候发币？' },
  ]);
  assert.equal(ladders.length, 1);
  const l = ladders[0];
  assert.equal(l.kind, 'date');
  assert.equal(l.direction, 'down');
  assert.deepEqual(l.rungs.map((r) => r.id), ['10', '11']);
});

test('buildComboLadders: same date titles under different events stay separate', () => {
  const ladders = buildComboLadders([
    { id: '10', title: '2026年9月30日', question: 'Plasma 什么时候发币？' },
    { id: '11', title: '2026年12月31日', question: 'Plasma 什么时候发币？' },
    { id: '20', title: '2026年9月30日', question: 'Monad 什么时候发币？' },
    { id: '21', title: '2026年12月31日', question: 'Monad 什么时候发币？' },
  ]);
  assert.equal(ladders.length, 2);
  const ids = ladders.map((l) => l.rungs.map((r) => r.id).join(','));
  assert.ok(ids.includes('10,11'));
  assert.ok(ids.includes('20,21'));
});

test('buildComboLadders: money wins when both money and date are present', () => {
  const ladders = buildComboLadders([
    { id: '1', title: null, question: 'Will COIN reach $3B by Dec 2026?' },
    { id: '2', title: null, question: 'Will COIN reach $4B by Dec 2026?' },
  ]);
  assert.equal(ladders.length, 1);
  assert.equal(ladders[0].kind, 'money');
});

// Screenshot numbers, FDV ('up') ladder: 5000万 YES ask 45.4¢,
// 1亿 YES bid 38.0¢ (→ NO ask 62.0¢). Combo = 107.4¢.
test('comboPairs: up ladder buys lower YES + higher NO', () => {
  const [ladder] = buildComboLadders([
    { id: '1', title: '5000万美元', question: 'Pump.fun FDV?' },
    { id: '2', title: '1亿美元', question: 'Pump.fun FDV?' },
  ]);
  const books = new Map([
    ['1', { bestBid: { price: 0.43, size: 900 }, bestAsk: { price: 0.454, size: 500 } }],
    ['2', { bestBid: { price: 0.38, size: 211 }, bestAsk: { price: 0.439, size: 100 } }],
  ]);
  const pairs = comboPairs(ladder, books);
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  assert.equal(p.easy.id, '1');
  assert.equal(p.hard.id, '2');
  approx(p.yesAskCents, 45.4);
  approx(p.noAskCents, 62.0);
  approx(p.costCents, 107.4);
  approx(p.bandWinCents, 92.6);
  approx(p.maxLossCents, 7.4);
  assert.equal(p.size, 211);
});

// Screenshot numbers, launch-date ('down') ladder: Sep 30 YES bid 73.0¢
// (→ NO ask 27.0¢), Dec 31 YES ask 91.8¢. Combo = 118.8¢.
test('comboPairs: down ladder buys earlier NO + later YES', () => {
  const [ladder] = buildComboLadders([
    { id: '10', title: '2026年9月30日', question: 'Plasma 什么时候发币？' },
    { id: '11', title: '2026年12月31日', question: 'Plasma 什么时候发币？' },
  ]);
  const books = new Map([
    ['10', { bestBid: { price: 0.73, size: 500 }, bestAsk: { price: 0.764, size: 211 } }],
    ['11', { bestBid: { price: 0.90, size: 50 }, bestAsk: { price: 0.918, size: 120 } }],
  ]);
  const pairs = comboPairs(ladder, books);
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  assert.equal(p.easy.id, '11');   // later date = easier = YES leg
  assert.equal(p.hard.id, '10');   // earlier date = harder = NO leg
  approx(p.yesAskCents, 91.8);
  approx(p.noAskCents, 27.0);
  approx(p.costCents, 118.8);
  assert.equal(p.size, 120);
});

test('comboPairs: missing book side drops the pair', () => {
  const [ladder] = buildComboLadders([
    { id: '1', title: '5000万美元', question: 'Pump.fun FDV?' },
    { id: '2', title: '1亿美元', question: 'Pump.fun FDV?' },
  ]);
  const books = new Map([
    ['1', { bestBid: { price: 0.43, size: 900 }, bestAsk: { price: 0.454, size: 500 } }],
    // id 2 book fetch failed
  ]);
  assert.equal(comboPairs(ladder, books).length, 0);
});

test('comboPairs: three rungs yield two adjacent pairs, pure arb detectable', () => {
  const [ladder] = buildComboLadders([
    { id: '1', title: '$50M', question: 'X FDV?' },
    { id: '2', title: '$100M', question: 'X FDV?' },
    { id: '3', title: '$200M', question: 'X FDV?' },
  ]);
  const books = new Map([
    ['1', { bestBid: { price: 0.60, size: 10 }, bestAsk: { price: 0.62, size: 10 } }],
    ['2', { bestBid: { price: 0.65, size: 10 }, bestAsk: { price: 0.66, size: 10 } }], // inverted vs rung 1
    ['3', { bestBid: { price: 0.20, size: 10 }, bestAsk: { price: 0.22, size: 10 } }],
  ]);
  const pairs = comboPairs(ladder, books);
  assert.equal(pairs.length, 2);
  // Pair 1-2: YES(1)@62 + NO(2)@35 = 97¢ → pure arb (below 100).
  approx(pairs[0].costCents, 97);
  // Pair 2-3: YES(2)@66 + NO(3)@80 = 146¢.
  approx(pairs[1].costCents, 146);
});

test('hedgeableWithinCap: walks depth cheapest-first until marginal cost hits the cap', () => {
  const easyAsks = [{ price: 0.40, size: 100 }, { price: 0.50, size: 100 }];
  const hardBids = [{ price: 0.65, size: 50 }, { price: 0.55, size: 200 }]; // NO asks 35¢/45¢
  // cap 90¢: 40+35=75 → 50 shares, then 40+45=85 → 50 shares, then 50+45=95 stops.
  const h = hedgeableWithinCap(easyAsks, hardBids, 0.90);
  assert.equal(h.shares, 100);
  approx(h.usd, 50 * 0.75 + 50 * 0.85);
  // Tighter cap 80¢: only the first 50-share match (75¢) qualifies.
  const h2 = hedgeableWithinCap(easyAsks, hardBids, 0.80);
  assert.equal(h2.shares, 50);
  approx(h2.usd, 50 * 0.75);
  // Cap below best combined price → nothing.
  assert.equal(hedgeableWithinCap(easyAsks, hardBids, 0.70).shares, 0);
});

test('hedgeableWithinCap: missing/empty books → zero', () => {
  assert.equal(hedgeableWithinCap([], [{ price: 0.5, size: 10 }], 1.1).shares, 0);
  assert.equal(hedgeableWithinCap(null, null, 1.1).shares, 0);
});

test('comboPairs: capCents attaches depth-aware hedge fields', () => {
  const [ladder] = buildComboLadders([
    { id: '1', title: '$200M', question: 'Betmoar FDV?' },
    { id: '2', title: '$400M', question: 'Betmoar FDV?' },
  ]);
  const books = new Map([
    ['1', {
      bestBid: { price: 0.073, size: 3324.6 },
      bestAsk: { price: 0.074, size: 3471.8 },
      asks: [{ price: 0.074, size: 3471.8 }, { price: 0.075, size: 1310.8 }],
      bids: [{ price: 0.073, size: 3324.6 }],
    }],
    ['2', {
      bestBid: { price: 0.075, size: 1460 },   // NO ask 92.5¢
      bestAsk: { price: 0.076, size: 500 },
      asks: [{ price: 0.076, size: 500 }],
      bids: [{ price: 0.075, size: 1460 }, { price: 0.074, size: 1812 }],
    }],
  ]);
  const pairs = comboPairs(ladder, books, { capCents: 110 });
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  approx(p.costCents, 99.9); // 7.4 + 92.5
  // Depth: 1460@(7.4+92.5) + 1812@(7.4+92.6) — then easy level 1 keeps matching
  // hard level 2 which doesn't exist → stops. 3471.8 covers 1460+1812=3272.
  assert.equal(p.hedgeShares, 3272);
  approx(p.hedgeUsd, 1460 * 0.999 + 1812 * 1.0);
  // Without capCents the fields stay null.
  const bare = comboPairs(ladder, books)[0];
  assert.equal(bare.hedgeShares, null);
  assert.equal(bare.hedgeUsd, null);
});

// Regression: a de-listed sibling market sharing a bucket (same question,
// same threshold) must not shadow the live market. Modeled on the Aligned /
// 01 screenshots: stale $20M book quoting 87¢ vs the live one at 22.2¢.
test('comboPairs: duplicate-value rungs pick the best executable leg', () => {
  const [ladder] = buildComboLadders([
    { id: 'stale20', title: null, question: 'Aligned FDV above $20M one day after launch?' },
    { id: 'live20', title: null, question: 'Aligned FDV above $20M one day after launch?' },
    { id: 'stale50', title: null, question: 'Aligned FDV above $50M one day after launch?' },
    { id: 'live50', title: null, question: 'Aligned FDV above $50M one day after launch?' },
  ]);
  assert.equal(ladder.rungs.length, 4); // two duplicated buckets
  const books = new Map([
    // Abandoned books with junk quotes still sitting on the venue.
    ['stale20', { bestBid: { price: 0.805, size: 818 }, bestAsk: { price: 0.87, size: 818 } }],
    ['stale50', { bestBid: { price: 0.805, size: 100 }, bestAsk: { price: 0.856, size: 100 } }],
    // Live books (screenshot quotes).
    ['live20', { bestBid: { price: 0.213, size: 400 }, bestAsk: { price: 0.222, size: 300 } }],
    ['live50', { bestBid: { price: 0.16, size: 250 }, bestAsk: { price: 0.169, size: 200 } }],
  ]);
  const pairs = comboPairs(ladder, books);
  assert.equal(pairs.length, 1); // one pair per adjacent VALUE, not per index
  const p = pairs[0];
  // Easy leg = cheapest $20M YES ask → the live market, not the stale twin.
  assert.equal(p.easy.id, 'live20');
  approx(p.yesAskCents, 22.2);
  // Hard leg = highest $50M YES bid → 80.5¢ stale bid wins here (it IS the
  // best executable NO price if that order is real) — but the live pair's
  // cost is what qualifies either way.
  assert.equal(p.hard.id, 'stale50');
  approx(p.noAskCents, 19.5);
});

test('comboPairs: duplicate rung with missing book falls back to the live one', () => {
  const [ladder] = buildComboLadders([
    { id: 'stale20', title: null, question: '01 FDV above $20M one day after launch?' },
    { id: 'live20', title: null, question: '01 FDV above $20M one day after launch?' },
    { id: 'live50', title: null, question: '01 FDV above $50M one day after launch?' },
  ]);
  const books = new Map([
    // stale20's book 404s → not in the map at all.
    ['live20', { bestBid: { price: 0.213, size: 400 }, bestAsk: { price: 0.222, size: 300 } }],
    ['live50', { bestBid: { price: 0.16, size: 250 }, bestAsk: { price: 0.169, size: 200 } }],
  ]);
  const pairs = comboPairs(ladder, books);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].easy.id, 'live20');
  assert.equal(pairs[0].hard.id, 'live50');
  // 22.2 + (100 − 16.0) = 106.2¢ — the combo the venue actually shows.
  approx(pairs[0].costCents, 106.2);
});

test('classifyComboEntry: exposes what the grouper sees for one market', () => {
  const money = classifyComboEntry({ id: '1', title: '5000万美元', question: 'Pump.fun FDV?' });
  assert.equal(money.kind, 'money');
  assert.equal(money.value, 5e7);
  assert.equal(money.raw, '5000万');
  const date = classifyComboEntry({ id: '2', title: '2026年9月30日', question: 'Plasma 什么时候发币？' });
  assert.equal(date.kind, 'date');
  assert.equal(date.direction, 'down');
  // No threshold anywhere → null (the /combo check '门槛识别 ❌' branch).
  assert.equal(classifyComboEntry({ id: '3', title: 'Yes', question: 'Will it rain tomorrow?' }), null);
  assert.equal(classifyComboEntry({ id: '4' }), null);
});
