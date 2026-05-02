import { htmlEscape } from '../telegram.js';
import { fmtSide, marketLink, formatOrderbookBlock } from '../format.js';

export async function detectWatch(ctx) {
  const {
    slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now,
    bidChanged, askChanged, alert, state, zone,
  } = ctx;
  const isWatched = (state.watchedIds ?? []).includes(marketId);
  if (!isWatched || isPaused || filtered) return;
  if (!bidChanged && !askChanged) return;
  const cooldownOk = now - (slot.watchAlertedAt ?? 0) >= 60_000;
  if (!cooldownOk) return;

  const fmtMove = (label, prev, next) => {
    const prevPart = prev?.price != null ? `${prev.price.toFixed(4)} × ${prev.size}` : '空';
    const nextPart = next?.price != null ? `${next.price.toFixed(4)} × ${next.size}` : '空';
    return `${label}: ${prevPart} → ${nextPart}`;
  };
  const prevBid = slot.baseline.bidPrice != null ? { price: slot.baseline.bidPrice, size: slot.baseline.bidSize } : null;
  const prevAsk = slot.baseline.askPrice != null ? { price: slot.baseline.askPrice, size: slot.baseline.askSize } : null;
  const moves = [];
  if (bidChanged) moves.push(htmlEscape(fmtMove('买1', prevBid, orderbook.bestBid)));
  if (askChanged) moves.push(htmlEscape(fmtMove('卖1', prevAsk, orderbook.bestAsk)));
  const msg = [
    `👁 <b>盯盘变动</b>`,
    `${marketLink(marketId, slot.title, slot.question)}`,
    `<code>#${htmlEscape(marketId)}</code> · PP <b>${totalHourlyRate.toFixed(2)}/h</b>`,
    ...moves,
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');
  if (await alert('watch', slot, marketId, msg, { bidChanged, askChanged })) {
    slot.watchAlertedAt = now;
  }
}
