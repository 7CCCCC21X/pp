// Adjacent-rung "combo cost" screening.
//
// Threshold ladders come in two flavors on predict.fun:
//   - Monetary ('money'): "FDV above $50M?" / "$100M?" — a higher cap is
//     strictly harder, so the $100M YES implies the $50M YES.
//   - Date ('date'): "token launches by Sep 30?" / "by Dec 31?" — a later
//     deadline is strictly easier, so the Sep 30 YES implies the Dec 31 YES.
//
// For any adjacent pair, buying YES on the *easier* rung plus NO on the
// *harder* rung pays out at least $1 (exactly one leg wins outside the band),
// and $2 when the outcome lands between the two thresholds (both legs win).
// So a combined entry cost under ~110¢ risks at most (cost−100)¢ per share
// for a (200−cost)¢ payoff if the middle band hits. This module finds those
// pairs. Pure (no I/O) — the /combo command feeds it slot texts and freshly
// fetched orderbooks.

import { parseCapThreshold, ladderContext, ladderKey, classifyDirection } from './priceSanity.js';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Intraday "Bitcoin Up or Down - May 3, 5AM-5:15AM ET" markets carry dates
// too, but consecutive days are independent coin-flips, not a cumulative
// ladder — grouping them would fabricate combos between unrelated events.
const INTRADAY_RE = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b|\bup or down\b|涨还是跌|涨跌/i;

const EN_MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
// "September 30, 2026" / "Sep 30 2026" / "Dec 31" (year inferred).
// (?!\d) keeps the day from eating the front of a 4-digit year.
const EN_MD_RE = new RegExp(`\\b${EN_MONTH}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?\\b`, 'ig');
// "March 2026" — month + year, no day.
const EN_MY_RE = new RegExp(`\\b${EN_MONTH}\\.?\\s+(20\\d{2})\\b`, 'ig');
// "2026年9月30日" / "2026 年 12 月 31 日" / "9月30日" / "2026年9月".
const CJK_DATE_RE = /(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/g;
// "2026-09-30" / "2026/9/30".
const NUM_DATE_RE = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;

function utcOrNull(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 0 || month > 11) return null;
  // day == null → month-only granularity; use the last day of the month so
  // "September 2026" sorts as "by end of September".
  if (day == null) return Date.UTC(year, month + 1, 0);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return Date.UTC(year, month, day);
}

// Pull the first calendar-date threshold out of a market's title/question.
// Returns { value: msUTC, raw, start, end } or null. `defaultYear` fills
// year-less dates ("Dec 31", "9月30日"); defaults to the current UTC year,
// same convention as parseEndFromTitle in predict.js.
export function parseDateThreshold(text, { defaultYear } = {}) {
  if (!text) return null;
  const s = String(text);
  if (INTRADAY_RE.test(s)) return null;
  const yearFallback = Number.isFinite(defaultYear) ? defaultYear : new Date().getUTCFullYear();
  const candidates = [];
  const push = (m, value) => {
    if (value == null) return;
    candidates.push({ index: m.index, full: m[0], value });
  };

  NUM_DATE_RE.lastIndex = 0;
  for (let m; (m = NUM_DATE_RE.exec(s)); ) {
    push(m, utcOrNull(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  CJK_DATE_RE.lastIndex = 0;
  for (let m; (m = CJK_DATE_RE.exec(s)); ) {
    // Bare "9月" (no year, no day) is too weak a signal — skip it.
    if (m[1] == null && m[3] == null) continue;
    const year = m[1] != null ? Number(m[1]) : yearFallback;
    push(m, utcOrNull(year, Number(m[2]) - 1, m[3] != null ? Number(m[3]) : null));
  }
  EN_MD_RE.lastIndex = 0;
  for (let m; (m = EN_MD_RE.exec(s)); ) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const year = m[3] != null ? Number(m[3]) : yearFallback;
    push(m, utcOrNull(year, month, Number(m[2])));
  }
  EN_MY_RE.lastIndex = 0;
  for (let m; (m = EN_MY_RE.exec(s)); ) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    push(m, utcOrNull(Number(m[2]), month, null));
  }

  if (!candidates.length) return null;
  // Earliest match wins; ties prefer the longer span ("Sep 30, 2026" over
  // the year-less "Sep 30" the shorter regex also found there).
  candidates.sort((a, b) => a.index - b.index || b.full.length - a.full.length);
  const best = candidates[0];
  const lead = best.full.length - best.full.trimStart().length;
  const start = best.index + lead;
  const raw = best.full.trim();
  return { value: best.value, raw, start, end: start + raw.length };
}

// "by/before <date>" markets get easier as the deadline moves out →
// probability rises with the date ('down' in ladder terms). "after <date>"
// flips it. Cumulative by-date markets are the overwhelming default.
const AFTER_RE = /\bafter\b|之后|以后|晚于/i;
export function classifyDateDirection(text) {
  return AFTER_RE.test(String(text ?? '')) ? 'up' : 'down';
}

const PARSERS = [
  { kind: 'money', parse: (t) => parseCapThreshold(t), directionOf: classifyDirection },
  { kind: 'date', parse: (t) => parseDateThreshold(t), directionOf: classifyDateDirection },
];

// Build combo ladders from [{ id, title, question, mid? }]. Unlike the
// price-sanity ladders this tries BOTH the question and the title (buckets
// like "2026年9月30日" often live only in the title while the question is
// the shared event text), and groups date ladders alongside monetary ones.
//
// Context disambiguation: when the threshold parses out of one field, the
// *other* field is appended to the grouping context iff it doesn't itself
// contain a same-kind threshold. So date-only titles ("2026年9月30日" → "___")
// stay separated per event by their shared question, while per-rung bucket
// titles ("$50M" vs "$100M") don't split a ladder whose question already
// carries the threshold.
export function buildComboLadders(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e || e.id == null) continue;
    const texts = [];
    if (e.question) texts.push(String(e.question));
    if (e.title && String(e.title) !== String(e.question ?? '')) texts.push(String(e.title));
    if (!texts.length) continue;
    let placed = null;
    for (const { kind, parse, directionOf } of PARSERS) {
      for (const t of texts) {
        const parsed = parse(t);
        if (!parsed) continue;
        let context = ladderContext(t, parsed);
        const other = texts.find((x) => x !== t);
        if (other && !parse(other)) context += ` § ${other}`;
        placed = { kind, context, direction: directionOf(t), value: parsed.value, raw: parsed.raw };
        break;
      }
      if (placed) break;
    }
    if (!placed) continue;
    const key = `${placed.kind}|${ladderKey(placed.context)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: placed.kind,
        context: placed.context,
        direction: placed.direction,
        rungs: [],
      });
    }
    groups.get(key).rungs.push({
      id: String(e.id),
      value: placed.value,
      raw: placed.raw,
      mid: Number.isFinite(e.mid) ? e.mid : null,
    });
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.rungs.length < 2) continue;
    g.rungs.sort((a, b) => a.value - b.value);
    out.push(g);
  }
  return out;
}

// Depth-aware hedgeable volume: walk BOTH legs' books cheapest-first and
// match shares while the marginal combined cost stays under `capProb`.
// easyAsks = the easy rung's YES asks (best/lowest price first);
// hardBids = the hard rung's YES bids (best/highest first) — buying NO at
// level j costs (1 − bid_j). Returns { shares, usd } where usd is the total
// spend across both legs for those shares. This is the "可对冲额度": how much
// you can actually put on at ≤ the screen's cap, not just top-of-book.
export function hedgeableWithinCap(easyAsks, hardBids, capProb) {
  const a = Array.isArray(easyAsks) ? easyAsks : [];
  const b = Array.isArray(hardBids) ? hardBids : [];
  let i = 0;
  let j = 0;
  let remA = a[0]?.size ?? 0;
  let remB = b[0]?.size ?? 0;
  let shares = 0;
  let usd = 0;
  while (i < a.length && j < b.length) {
    const yes = a[i]?.price;
    const no = Number.isFinite(b[j]?.price) ? 1 - b[j].price : NaN;
    if (!Number.isFinite(yes) || !Number.isFinite(no)) break;
    // Strict < cap, matching the hit filter; epsilon absorbs float noise so
    // an exactly-at-cap level doesn't flicker in and out.
    if (yes + no >= capProb - 1e-9) break;
    const q = Math.min(remA, remB);
    if (!(q > 0)) break;
    shares += q;
    usd += q * (yes + no);
    remA -= q;
    remB -= q;
    if (remA <= 1e-9) { i += 1; remA = a[i]?.size ?? 0; }
    if (remB <= 1e-9) { j += 1; remB = b[j]?.size ?? 0; }
  }
  return { shares, usd };
}

// Compute every adjacent-pair combo in a ladder against fresh books.
// `books`: Map(id → { bestBid: {price,size}, bestAsk: {price,size},
// bids?: [{price,size}...], asks?: [...] }). When multi-level arrays and
// `opts.capCents` are present, each pair also carries hedgeShares/hedgeUsd —
// the depth-aware volume executable under the cap (see hedgeableWithinCap).
//
// Legs: buy YES on the easier rung at its ask; buy NO on the harder rung,
// which on a single-book CLOB executes as selling YES to the harder rung's
// best bid — NO ask = 100 − YES bid. costCents < 100 is a pure arb;
// 100..maxCents risks (cost−100)¢ for a (200−cost)¢ middle-band payoff.
export function comboPairs(ladder, books, opts = {}) {
  const out = [];
  for (let i = 0; i + 1 < ladder.rungs.length; i++) {
    const a = ladder.rungs[i];      // lower threshold value
    const b = ladder.rungs[i + 1];  // higher threshold value
    if (a.value === b.value) continue;
    // 'up' (money "above X"): higher value harder → easy = a.
    // 'down' (date "by X"): higher value (later date) easier → easy = b.
    const easy = ladder.direction === 'down' ? b : a;
    const hard = easy === a ? b : a;
    const easyBook = books.get(String(easy.id));
    const hardBook = books.get(String(hard.id));
    const yesAsk = easyBook?.bestAsk?.price;
    const hardBid = hardBook?.bestBid?.price;
    if (!Number.isFinite(yesAsk) || !Number.isFinite(hardBid)) continue;
    const noAsk = 1 - hardBid;
    const costCents = (yesAsk + noAsk) * 100;
    const size = Math.min(easyBook.bestAsk?.size ?? 0, hardBook.bestBid?.size ?? 0);
    let hedgeShares = null;
    let hedgeUsd = null;
    if (Number.isFinite(opts.capCents)) {
      const h = hedgeableWithinCap(easyBook.asks, hardBook.bids, opts.capCents / 100);
      hedgeShares = h.shares;
      hedgeUsd = h.usd;
    }
    out.push({
      kind: ladder.kind,
      context: ladder.context,
      direction: ladder.direction,
      easy,
      hard,
      yesAskCents: yesAsk * 100,
      noAskCents: noAsk * 100,
      costCents,
      size,
      hedgeShares,
      hedgeUsd,
      bandWinCents: 200 - costCents,
      maxLossCents: costCents - 100,
    });
  }
  return out;
}
