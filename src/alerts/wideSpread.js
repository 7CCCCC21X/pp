import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtSide, fmtElapsed, marketLink, spreadOf } from '../format.js';

export async function detectWideSpread(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert } = ctx;
  if (!config.alertWideSpread || isPaused || filtered) return;
  const curSpread = spreadOf(orderbook);
  const wide = Number.isFinite(curSpread) && curSpread > config.maxSpread;
  if (!wide) {
    // Recovery: if we previously alerted on this market and now the
    // spread is back inside the threshold, send one "back to normal" ping.
    if (config.alertRecovery && slot.wideSpreadAlertedAt > 0 && !slot.wideSpreadRecovered) {
      const msg = [
        `<b>价差恢复正常 ${curSpread.toFixed(4)}</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        `阈值: ${config.maxSpread.toFixed(4)}`,
        `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
        `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
      ].join('\n');
      if (await alert('wide_spread_recovered', slot, marketId, msg, { spread: curSpread })) {
        slot.wideSpreadRecovered = true;
      }
    }
    slot.wideSpreadSince = null;
    return;
  }
  // Wide condition is on; clear the recovered flag so a future return-to-normal
  // re-arms the recovery alert.
  slot.wideSpreadRecovered = false;
  if (!slot.wideSpreadSince) slot.wideSpreadSince = now;
  const elapsed = now - slot.wideSpreadSince;
  const need = config.wideSpreadMinMinutes * 60 * 1000;
  const cooldownOk = now - (slot.wideSpreadAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const msg = [
    `<b>价差走阔 ${curSpread.toFixed(4)} (持续 ${fmtElapsed(elapsed)})</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
    `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
    `阈值: ${config.maxSpread.toFixed(4)}`,
    `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
  ].join('\n');
  if (await alert('wide_spread', slot, marketId, msg, { spread: curSpread, elapsedMs: elapsed })) {
    slot.wideSpreadAlertedAt = now;
  }
}
