import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtElapsed, marketLink, formatOrderbookBlock } from '../format.js';

export async function detectEmptyBook(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, zone } = ctx;
  if (!config.alertEmptyBook || isPaused || filtered) return;
  const empty = orderbook.bestBid == null || orderbook.bestAsk == null;
  if (!empty) {
    if (config.alertRecovery && slot.emptyBookAlertedAt > 0 && !slot.emptyBookRecovered) {
      const msg = [
        `✅ <b>订单簿恢复双边</b>`,
        `${marketLink(marketId, slot.title, slot.question)}`,
        `<code>#${htmlEscape(marketId)}</code> · PP <b>${totalHourlyRate.toFixed(2)}/h</b>`,
        '',
        formatOrderbookBlock(orderbook, zone),
      ].join('\n');
      if (await alert('empty_book_recovered', slot, marketId, msg, {})) {
        slot.emptyBookRecovered = true;
      }
    }
    slot.emptyBookSince = null;
    return;
  }
  slot.emptyBookRecovered = false;
  if (!slot.emptyBookSince) slot.emptyBookSince = now;
  const elapsed = now - slot.emptyBookSince;
  const need = config.emptyBookMinMinutes * 60 * 1000;
  const cooldownOk = now - (slot.emptyBookAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const msg = [
    `🌊 <b>订单簿单边 / 空缺</b>`,
    `${marketLink(marketId, slot.title, slot.question)}`,
    `<code>#${htmlEscape(marketId)}</code> · PP <b>${totalHourlyRate.toFixed(2)}/h</b> · 持续 ${htmlEscape(fmtElapsed(elapsed))}`,
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');
  if (await alert('empty_book', slot, marketId, msg, { elapsedMs: elapsed })) {
    slot.emptyBookAlertedAt = now;
  }
}
