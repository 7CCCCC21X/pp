import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtElapsed, marketLink, spreadOf, formatOrderbookBlock, formatOpportunitySummary } from '../format.js';
import { effectiveOverride } from '../state.js';

export async function detectWideSpread(ctx) {
  const { state, slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, zone } = ctx;
  if (!config.alertWideSpread || isPaused || filtered) return;
  const maxSpread = effectiveOverride(state, marketId, 'maxSpread', config.maxSpread);
  const curSpread = spreadOf(orderbook);
  const wide = Number.isFinite(curSpread) && curSpread > maxSpread;
  if (!wide) {
    if (config.alertRecovery && slot.wideSpreadAlertedAt > 0 && !slot.wideSpreadRecovered) {
      const msg = [
        `✅ <b>价差恢复正常 ${(curSpread * 100).toFixed(2)}¢</b>`,
        `${marketLink(marketId, slot.title, slot.question, slot.slug)}`,
        `<code>#${htmlEscape(marketId)}</code> · PP <b>${totalHourlyRate.toFixed(2)}/h</b>`,
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
  const minMinutes = effectiveOverride(state, marketId, 'wideSpreadMinMinutes', config.wideSpreadMinMinutes);
  const need = minMinutes * 60 * 1000;
  const cooldownOk = now - (slot.wideSpreadAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const msg = [
    `🔴 <b>价差走阔 ${(curSpread * 100).toFixed(2)}¢</b>`,
    `${marketLink(marketId, slot.title, slot.question, slot.slug)}`,
    `<code>#${htmlEscape(marketId)}</code> · 持续 ${htmlEscape(fmtElapsed(elapsed))}`,
    formatOpportunitySummary({ orderbook, zone, totalHourlyRate, endMs: slot.endMs }),
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');
  if (await alert('wide_spread', slot, marketId, msg, { spread: curSpread, elapsedMs: elapsed })) {
    slot.wideSpreadAlertedAt = now;
  }
}
