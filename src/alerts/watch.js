import { htmlEscape } from '../telegram.js';
import { fmtSide, marketLink } from '../format.js';

export async function detectWatch(ctx) {
  const {
    slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now,
    bidChanged, askChanged, alert, state,
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
  const msg = [
    `<b>盯盘变动</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    bidChanged ? htmlEscape(fmtMove('买1', prevBid, orderbook.bestBid)) : `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
    askChanged ? htmlEscape(fmtMove('卖1', prevAsk, orderbook.bestAsk)) : `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
    `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
  ].join('\n');
  if (await alert('watch', slot, marketId, msg, { bidChanged, askChanged })) {
    slot.watchAlertedAt = now;
  }
}
