import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtElapsed, marketLink, formatOrderbookBlock, formatOpportunitySummary } from '../format.js';
import { effectiveOverride } from '../state.js';

export async function detectStall(ctx) {
  const { state, slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, log, zone } = ctx;
  if (!config.alertStall || isPaused || filtered) {
    const why = !config.alertStall ? 'stall alerts off' : isPaused ? 'paused' : 'filtered';
    log(`[${marketId}] unchanged ${fmtElapsed(now - slot.lastChangeAt)} (${why})`);
    return;
  }
  const staleHours = effectiveOverride(state, marketId, 'staleHours', config.staleHours);
  const elapsedMs = now - slot.lastChangeAt;
  const staleMs = staleHours * 3600 * 1000;
  if (elapsedMs < staleMs) {
    log(`[${marketId}] unchanged ${fmtElapsed(elapsedMs)} (alerted=${slot.alerted})`);
    return;
  }
  if (slot.alerted) return;
  const msg = [
    `🟡 <b>订单簿停滞超过 ${staleHours} 小时</b>`,
    `${marketLink(marketId, slot.title, slot.question, slot.slug)}`,
    `<code>#${htmlEscape(marketId)}</code> · 停滞 ${htmlEscape(fmtElapsed(elapsedMs))}`,
    formatOpportunitySummary({ orderbook, zone, totalHourlyRate, endMs: slot.endMs }),
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');
  if (await alert('stall', slot, marketId, msg, { elapsedMs })) {
    slot.alerted = true;
    log(`[${marketId}] alerted stall (${fmtElapsed(elapsedMs)})`);
  }
}
