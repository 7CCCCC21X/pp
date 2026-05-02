import { htmlEscape } from './telegram.js';

export function fmtSide(side) {
  if (!side) return '无';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${price} × ${size}`;
}

export function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export function marketLink(marketId, title) {
  const safeTitle = title ? htmlEscape(title) : `Market ${marketId}`;
  return `<a href="https://predict.fun/market/${encodeURIComponent(marketId)}">${safeTitle}</a>`;
}

export function midOf(orderbook) {
  const bid = orderbook.bestBid?.price;
  const ask = orderbook.bestAsk?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

export function spreadOf(orderbook) {
  const bid = orderbook.bestBid?.price;
  const ask = orderbook.bestAsk?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return ask - bid;
}
