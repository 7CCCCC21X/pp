import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtSide, fmtElapsed, marketLink } from '../format.js';

export async function detectEmptyBook(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert } = ctx;
  if (!config.alertEmptyBook || isPaused || filtered) return;
  const empty = orderbook.bestBid == null || orderbook.bestAsk == null;
  if (!empty) {
    slot.emptyBookSince = null;
    return;
  }
  if (!slot.emptyBookSince) slot.emptyBookSince = now;
  const elapsed = now - slot.emptyBookSince;
  const need = config.emptyBookMinMinutes * 60 * 1000;
  const cooldownOk = now - (slot.emptyBookAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const msg = [
    `<b>订单簿单边/空缺 (持续 ${fmtElapsed(elapsed)})</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
    `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
    `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
  ].join('\n');
  if (await alert('empty_book', slot, marketId, msg, { elapsedMs: elapsed })) {
    slot.emptyBookAlertedAt = now;
  }
}
