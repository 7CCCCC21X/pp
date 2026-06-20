// Cross-market "price reasonableness" logic.
//
// Many predict.fun markets come in *ladders* over a single underlying
// number — e.g. "Will COIN reach a $3B market cap?", "... $4B?", "... $5B?".
// Such a ladder is monotonic: reaching a higher target is strictly harder,
// so the implied probability (mid price) MUST decrease as the threshold
// climbs. When the book prices a higher rung at the same (or higher!)
// probability as a lower rung — or barely below it — that's an arbitrage /
// mispricing worth flagging.
//
// This module is pure (no I/O) so it can be unit-tested in isolation. The
// monitor wires it up: it feeds in {id, text, mid} per active market, gets
// back the violating ladders, and renders/sends the alert.

// Scale multipliers, both Western (k/m/b/t + long words) and CJK (万/亿).
// 30亿 == $3B == 3e9, so cross-notation rungs in the same ladder compare
// correctly on a common numeric value.
const SCALE = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
  万: 1e4, 亿: 1e8, 万亿: 1e12,
};

// $-prefixed or long-word amounts: "$3B", "$4 billion", "$100M", "30 trillion".
const WEST_RE = /(\$)?\s*(\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mm|[kmbt])\b/ig;
// Chinese amounts: "30亿", "100万", "1万亿". 万亿 listed first so it wins over 万.
const CJK_RE = /(\$)?\s*(\d+(?:\.\d+)?)\s*(万亿|亿|万)/g;

// Pull the first monetary threshold out of a market's question/title.
// Returns { value, raw, start, end } or null when nothing cap-like is found.
//
// To avoid matching dates ("2026"), times ("12AM-1AM"), or bare ids we
// require a recognised scale token. Single-letter Western scales (3b, 5k)
// are only accepted when a "$" is present, so prose like "for 3 months"
// or "top 5 k" can't masquerade as a threshold.
export function parseCapThreshold(text) {
  if (!text) return null;
  const s = String(text);
  const candidates = [];

  WEST_RE.lastIndex = 0;
  for (let m; (m = WEST_RE.exec(s)); ) {
    const hasDollar = !!m[1];
    const scale = m[3].toLowerCase();
    // Reject single-letter scales without a "$" (too ambiguous in prose).
    if (!hasDollar && scale.length === 1) continue;
    const mult = SCALE[scale];
    if (!mult) continue;
    candidates.push({ index: m.index, full: m[0], value: parseFloat(m[2]) * mult });
  }

  CJK_RE.lastIndex = 0;
  for (let m; (m = CJK_RE.exec(s)); ) {
    const mult = SCALE[m[3]];
    if (!mult) continue;
    candidates.push({ index: m.index, full: m[0], value: parseFloat(m[2]) * mult });
  }

  if (!candidates.length) return null;
  // Earliest match wins; ties (same index) prefer the longer span so
  // "万亿" beats a "万" that started at the same place.
  candidates.sort((a, b) => a.index - b.index || b.full.length - a.full.length);
  const best = candidates[0];
  // Trim leading whitespace the regex may have swallowed via "\s*" so the
  // start/end span hugs the actual token.
  const lead = best.full.length - best.full.trimStart().length;
  const start = best.index + lead;
  const raw = best.full.trim();
  const end = start + raw.length;
  return { value: best.value, raw, start, end };
}

// The shared "shape" of a ladder: the market text with its threshold token
// blanked out. Two rungs of the same ladder ("reach $3B by Dec" / "reach
// $4B by Dec") collapse to the same key, so we can group them.
export function ladderContext(text, parsed) {
  const s = String(text);
  return s.slice(0, parsed.start) + '___' + s.slice(parsed.end);
}

export function ladderKey(context) {
  return context.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Which way does probability move with the threshold?
//   'up'   — higher target is HARDER (reach/hit/above/exceed/达到/突破/以上).
//            Probability should DECREASE as the number climbs. (default)
//   'down' — higher target is EASIER (below/under/低于/以下).
//            Probability should INCREASE as the number climbs.
const DOWN_RE = /\b(below|under|less than|lower than|beneath|fewer)\b|低于|以下|跌破|不到|不足|小于/i;
export function classifyDirection(text) {
  return DOWN_RE.test(String(text ?? '')) ? 'down' : 'up';
}

// Build ladders from a flat list of {id, text, mid}. Each entry must have a
// finite mid and a parseable threshold to participate. Returns an array of
// { key, context, direction, rungs } where rungs are sorted by ascending
// threshold value. Ladders with fewer than 2 rungs are dropped.
export function buildLadders(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e || !Number.isFinite(e.mid)) continue;
    const parsed = parseCapThreshold(e.text);
    if (!parsed) continue;
    const context = ladderContext(e.text, parsed);
    const key = ladderKey(context);
    if (!groups.has(key)) {
      groups.set(key, { key, context, direction: classifyDirection(e.text), rungs: [] });
    }
    groups.get(key).rungs.push({ id: e.id, value: parsed.value, raw: parsed.raw, mid: e.mid });
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.rungs.length < 2) continue;
    g.rungs.sort((a, b) => a.value - b.value);
    out.push(g);
  }
  return out;
}

// Adjacent-rung monotonicity check. For an 'up' ladder the lower rung's
// probability should exceed the next rung's by more than `margin`; a gap
// of `margin` or less (including equal or inverted) is a violation. 'down'
// ladders flip the comparison. Returns [{ lo, hi, gap }] where `gap` is the
// signed "expected-higher minus expected-lower" probability difference.
export function ladderViolations(ladder, margin) {
  const { rungs, direction } = ladder;
  const out = [];
  for (let i = 0; i + 1 < rungs.length; i++) {
    const a = rungs[i];       // lower threshold
    const b = rungs[i + 1];   // higher threshold
    if (a.value === b.value) continue;
    // gap = (probability that *should* be higher) - (the other one).
    const gap = direction === 'down' ? b.mid - a.mid : a.mid - b.mid;
    if (gap <= margin) out.push({ lo: a, hi: b, gap });
  }
  return out;
}

// Top-level: returns every ladder that has at least one violation, with its
// violations attached. `entries` = [{ id, text, mid }].
export function findPriceSanityIssues(entries, margin) {
  const issues = [];
  for (const ladder of buildLadders(entries)) {
    const violations = ladderViolations(ladder, margin);
    if (violations.length) issues.push({ ...ladder, violations });
  }
  return issues;
}
