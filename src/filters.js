import { config } from './config.js';

export const FILTER_DEPTH = 3; // 买1-3 / 卖1-3

function buildKeys() {
  const keys = [];
  const labels = {};
  for (const side of ['Bid', 'Ask']) {
    const sideCn = side === 'Bid' ? '买' : '卖';
    for (let lvl = 1; lvl <= FILTER_DEPTH; lvl++) {
      const minP = `min${side}${lvl}Price`;
      const maxP = `max${side}${lvl}Price`;
      const minS = `min${side}${lvl}Size`;
      keys.push(minP, maxP, minS);
      labels[minP] = `${sideCn}${lvl}价 ≥`;
      labels[maxP] = `${sideCn}${lvl}价 ≤`;
      labels[minS] = `${sideCn}${lvl}量 ≥`;
    }
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

// Returns null if all checks pass, otherwise the first failing reason.
export function checkFilter(orderbook, filters) {
  for (const side of ['Bid', 'Ask']) {
    const sideCn = side === 'Bid' ? '买' : '卖';
    for (let lvl = 1; lvl <= FILTER_DEPTH; lvl++) {
      const level = levelOf(orderbook, side, lvl);
      const minP = filters[`min${side}${lvl}Price`];
      const maxP = filters[`max${side}${lvl}Price`];
      const minS = filters[`min${side}${lvl}Size`];
      if (minP != null) {
        if (!level || level.price < minP) return `${sideCn}${lvl}价 < ${minP}`;
      }
      if (maxP != null) {
        if (!level || level.price > maxP) return `${sideCn}${lvl}价 > ${maxP}`;
      }
      if (minS != null) {
        if (!level || level.size < minS) return `${sideCn}${lvl}量 < ${minS}`;
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
