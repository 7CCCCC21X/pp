import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtElapsed, marketLink, spreadOf, formatOrderbookBlock } from '../format.js';

export async function detectWideSpread(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, zone } = ctx;
  if (!config.alertWideSpread || isPaused || filtered) return;
  const curSpread = spreadOf(orderbook);
  const wide = Number.isFinite(curSpread) && curSpread > config.maxSpread;
  if (!wide) {
    if (config.alertRecovery && slot.wideSpreadAlertedAt > 0 && !slot.wideSpreadRecovered) {
      const msg = [
        `<b>价差恢复正常 ${curSpread.toFixed(4)}</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        `阈值: ${config.maxSpread.toFixed(4)} · PP ${totalHourlyRate.toFixed(2)}/h`,
        '',
        formatOrderbookBlock(orderbook, zone),
      ].join('\n');
      if (await alert('wide_spread_recovered', slot, marketId, msg, { spread: curSpread })) {
        slot.wideSpreadRecovered = true;
      }
    }
    slot.wideSpreadSince = null;
    return;
  }
  slot.wideSpreadRecovered = false;
  if (!slot.wideSpreadSince) slot.wideSpreadSince = now;
  const elapsed = now - slot.wideSpreadSince;
  const need = config.wideSpreadMinMinutes * 60 * 1000;
  const cooldownOk = now - (slot.wideSpreadAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const msg = [
    `<b>价差走阔 ${curSpread.toFixed(4)} (持续 ${fmtElapsed(elapsed)})</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    `阈值: ${config.maxSpread.toFixed(4)} · PP ${totalHourlyRate.toFixed(2)}/h`,
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');
  if (await alert('wide_spread', slot, marketId, msg, { spread: curSpread, elapsedMs: elapsed })) {
    slot.wideSpreadAlertedAt = now;
  }
}
