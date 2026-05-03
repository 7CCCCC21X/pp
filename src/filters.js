import { config } from './config.js';
import { midOf, spreadOf } from './format.js';

export const FILTER_DEPTH = 3; // 买1-3 / 卖1-3

// Derived metric filters: compute a single number from the orderbook,
// compare against expected bound. {key, label, op}.
const DERIVED_KEYS = [
  ['minMid', '中价 ≥', '>='],
  ['maxMid', '中价 ≤', '<='],
  ['minSpread', '价差 ≥', '>='],
  ['maxSpread', '价差 ≤', '<='],
  ['maxTopUsd', '买1+卖1$ ≤', '<='],
  ['maxTotalUsd', '买1-3+卖1-3$ ≤', '<='],
];

// Zone-gap filters: require at least one side of the reward zone to be
// unstaffed (truthy expected value = on; we only allow positive numbers
// through env so any non-null/positive value enables the check).
const ZONE_GAP_KEYS = [
  ['requireAnyRewardGap', '奖励区任一未激活'],
  ['requireBidRewardGap', '买侧奖励区未激活'],
  ['requireAskRewardGap', '卖侧奖励区未激活'],
];

function buildKeys() {
  const keys = [];
  const labels = {};
  for (const side of ['Bid', 'Ask']) {
    const sideCn = side === 'Bid' ? '买' : '卖';
    for (let lvl = 1; lvl <= FILTER_DEPTH; lvl++) {
      for (const op of ['min', 'max']) {
        for (const attr of ['Price', 'Size']) {
          const key = `${op}${side}${lvl}${attr}`;
          const cmp = op === 'min' ? '≥' : '≤';
          const attrCn = attr === 'Price' ? '价' : '量';
          keys.push(key);
          labels[key] = `${sideCn}${lvl}${attrCn} ${cmp}`;
        }
      }
    }
  }
  for (const [k, label] of DERIVED_KEYS) {
    keys.push(k);
    labels[k] = label;
  }
  for (const [k, label] of ZONE_GAP_KEYS) {
    keys.push(k);
    labels[k] = label;
  }
  return { keys, labels };
}

const built = buildKeys();
export const FILTER_KEYS = built.keys;
export const FILTER_LABELS = built.labels;

// minBid1Price -> FILTER_MIN_BID1_PRICE
export function envVarName(key) {
  return 'FILTER_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

export function effectiveFilters(state) {
  const out = {};
  for (const k of FILTER_KEYS) {
    const override = state?.filters?.[k];
    out[k] = override != null && Number.isFinite(override) ? override : config.filters[k] ?? null;
  }
  return out;
}

function levelOf(orderbook, side, lvl) {
  const arr = side === 'Bid' ? orderbook.bids : orderbook.asks;
  return arr?.[lvl - 1] ?? null;
}

function usd(row) {
  if (!row) return 0;
  const p = Number(row.price);
  const s = Number(row.size);
  return Number.isFinite(p) && Number.isFinite(s) ? p * s : 0;
}

function sideTotalUsd(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const r of rows) total += usd(r);
  return total;
}

// Bound check: returns reason string if it fails, null if OK.
function failBound(label, actual, op, expected) {
  if (!Number.isFinite(actual)) return `${label} 不可用`;
  if (op === '>=' && actual < expected) return `${label} ${actual.toFixed(4)} < ${expected}`;
  if (op === '<=' && actual > expected) return `${label} ${actual.toFixed(4)} > ${expected}`;
  return null;
}

// Returns null if all checks pass, otherwise the first failing reason.
//
// Optional `zone` (from rewardZoneStatus) lets the requireXRewardGap
// filters work — without it those filters are no-ops since the gate
// can't be evaluated.
export function checkFilter(orderbook, filters, { zone = null } = {}) {
  // 1) Derived metrics first — usually the cheapest gate that matches
  //    "find me薄盘/阔差/中价偏远" intent without per-level fiddling.
  const mid = midOf(orderbook);
  const spread = spreadOf(orderbook);
  const topUsd = usd(orderbook.bestBid) + usd(orderbook.bestAsk);
  const totalUsd = sideTotalUsd(orderbook.bids) + sideTotalUsd(orderbook.asks);
  const metricChecks = [
    ['minMid', '中价', mid, '>='],
    ['maxMid', '中价', mid, '<='],
    ['minSpread', '价差', spread, '>='],
    ['maxSpread', '价差', spread, '<='],
    ['maxTopUsd', '买1+卖1$', topUsd, '<='],
    ['maxTotalUsd', '买1-3+卖1-3$', totalUsd, '<='],
  ];
  for (const [key, label, actual, op] of metricChecks) {
    const expected = filters[key];
    if (expected == null) continue;
    const reason = failBound(label, actual, op, expected);
    if (reason) return reason;
  }

  // 2) Reward-zone gap requirements. Treat any positive value as "on".
  const wantAny = filters.requireAnyRewardGap;
  if (wantAny != null && wantAny > 0) {
    if (!zone) return '奖励区状态未知';
    if (zone.bidActivated && zone.askActivated) return '奖励区双边都已激活';
  }
  const wantBid = filters.requireBidRewardGap;
  if (wantBid != null && wantBid > 0) {
    if (!zone) return '奖励区状态未知';
    if (zone.bidActivated) return '买侧奖励区已激活';
  }
  const wantAsk = filters.requireAskRewardGap;
  if (wantAsk != null && wantAsk > 0) {
    if (!zone) return '奖励区状态未知';
    if (zone.askActivated) return '卖侧奖励区已激活';
  }

  // 3) Per-level price/size bounds. min* requires the level to exist;
  //    maxSize on a missing level is treated as 0 (薄盘 → pass).
  for (const side of ['Bid', 'Ask']) {
    const sideCn = side === 'Bid' ? '买' : '卖';
    for (let lvl = 1; lvl <= FILTER_DEPTH; lvl++) {
      const level = levelOf(orderbook, side, lvl);
      const checks = [
        [`min${side}${lvl}Price`, 'price', '>=', `${sideCn}${lvl}价`],
        [`max${side}${lvl}Price`, 'price', '<=', `${sideCn}${lvl}价`],
        [`min${side}${lvl}Size`, 'size', '>=', `${sideCn}${lvl}量`],
        [`max${side}${lvl}Size`, 'size', '<=', `${sideCn}${lvl}量`],
      ];
      for (const [key, attr, op, label] of checks) {
        const expected = filters[key];
        if (expected == null) continue;
        if (!level) {
          // Missing level + maxSize bound: treat as 0, passes (= 薄盘).
          if (op === '<=' && attr === 'size') continue;
          return `${label} 缺失`;
        }
        const reason = failBound(label, level[attr], op, expected);
        if (reason) return reason;
      }
    }
  }
  return null;
}

export function formatFilters(filters, state) {
  const lines = [];
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v == null) continue;
    const overridden = state?.filters?.[k] != null;
    const tag = overridden ? ' (live)' : ' (env)';
    lines.push(`${FILTER_LABELS[k]} ${v}${tag}`);
  }
  if (!lines.length) return '当前无过滤器（所有市场都会进入提醒）。';
  return lines.join('\n');
}
