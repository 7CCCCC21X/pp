import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtSide, marketLink, midOf } from '../format.js';

export async function detectMidJump(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert } = ctx;
  const curMid = midOf(orderbook);
  if (
    config.alertMidJump &&
    !isPaused && !filtered &&
    Number.isFinite(curMid) &&
    Number.isFinite(slot.lastMid)
  ) {
    const jump = Math.abs(curMid - slot.lastMid);
    const cooldownOk = now - (slot.midJumpAlertedAt ?? 0) >= config.midJumpCooldownMs;
    if (jump >= config.midJumpThreshold && cooldownOk) {
      const direction = curMid > slot.lastMid ? '↑' : '↓';
      const msg = [
        `<b>中价跳变 ${direction} ${jump.toFixed(4)}</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        `中价: ${slot.lastMid.toFixed(4)} → ${curMid.toFixed(4)}`,
        `当前买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
        `当前卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
        `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
      ].join('\n');
      if (await alert('mid_jump', slot, marketId, msg, { from: slot.lastMid, to: curMid, jump })) {
        slot.midJumpAlertedAt = now;
      }
    }
  }
  if (Number.isFinite(curMid)) slot.lastMid = curMid;
}
