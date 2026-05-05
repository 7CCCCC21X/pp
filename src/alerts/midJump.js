import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { marketLink, midOf, fmtCents, formatOrderbookBlock, formatOpportunitySummary } from '../format.js';
import { effectiveOverride } from '../state.js';

export async function detectMidJump(ctx) {
  const { state, slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, zone } = ctx;
  const curMid = midOf(orderbook);
  if (
    config.alertMidJump &&
    !isPaused && !filtered &&
    Number.isFinite(curMid) &&
    Number.isFinite(slot.lastMid)
  ) {
    const jumpThreshold = effectiveOverride(state, marketId, 'midJumpThreshold', config.midJumpThreshold);
    const jump = Math.abs(curMid - slot.lastMid);
    const cooldownOk = now - (slot.midJumpAlertedAt ?? 0) >= config.midJumpCooldownMs;
    if (jump >= jumpThreshold && cooldownOk) {
      const direction = curMid > slot.lastMid ? '↑' : '↓';
      const msg = [
        `⚡ <b>中价跳变 ${direction} ${(jump * 100).toFixed(2)}¢</b>`,
        `${marketLink(marketId, slot.title, slot.question, slot.slug)}`,
        `<code>#${htmlEscape(marketId)}</code> · ${fmtCents(slot.lastMid)} → <b>${fmtCents(curMid)}</b>`,
        formatOpportunitySummary({ orderbook, zone, totalHourlyRate, endMs: slot.endMs }),
        '',
        formatOrderbookBlock(orderbook, zone),
      ].join('\n');
      if (await alert('mid_jump', slot, marketId, msg, { from: slot.lastMid, to: curMid, jump })) {
        slot.midJumpAlertedAt = now;
      }
    }
  }
  if (Number.isFinite(curMid)) slot.lastMid = curMid;
}
