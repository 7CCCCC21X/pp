import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtSide, fmtElapsed, marketLink } from '../format.js';
import { effectiveOverride } from '../state.js';

export async function detectStall(ctx) {
  const { state, slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, log } = ctx;
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
    `<b>订单簿停滞超过 ${staleHours} 小时</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
    `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
    `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
    `已停滞: ${htmlEscape(fmtElapsed(elapsedMs))}`,
    `起点: ${new Date(slot.lastChangeAt).toISOString()}`,
  ].join('\n');
  if (await alert('stall', slot, marketId, msg, { elapsedMs })) {
    slot.alerted = true;
    log(`[${marketId}] alerted stall (${fmtElapsed(elapsedMs)})`);
  }
}
