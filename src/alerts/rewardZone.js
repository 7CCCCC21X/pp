import { config } from '../config.js';
import { htmlEscape } from '../telegram.js';
import { fmtSide, fmtElapsed, marketLink } from '../format.js';

export async function detectRewardZone(ctx) {
  const { slot, orderbook, marketId, totalHourlyRate, isPaused, filtered, now, alert, zone } = ctx;
  if (!config.alertRewardZone || isPaused || filtered || totalHourlyRate <= 0) return;
  const unstaffed = !zone.bidActivated || !zone.askActivated;
  if (!unstaffed) {
    if (config.alertRecovery && slot.rewardZoneAlertedAt > 0 && !slot.rewardZoneRecovered) {
      const msg = [
        `<b>奖励区已重新激活</b>`,
        `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
        `买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
        `卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
        `规则: 离 mid ≤ ±${(zone.maxDistance * 100).toFixed(1)}¢，量 ≥ ${zone.minSize}`,
      ].join('\n');
      if (await alert('reward_zone_recovered', slot, marketId, msg, {})) {
        slot.rewardZoneRecovered = true;
      }
    }
    slot.rewardZoneSince = null;
    return;
  }
  slot.rewardZoneRecovered = false;
  if (!slot.rewardZoneSince) slot.rewardZoneSince = now;
  const elapsed = now - slot.rewardZoneSince;
  const need = config.rewardZoneMinMinutes * 60 * 1000;
  const cooldownOk = now - (slot.rewardZoneAlertedAt ?? 0) >= 60 * 60 * 1000;
  if (elapsed < need || !cooldownOk) return;

  const sides = [];
  if (!zone.bidActivated) sides.push(`买侧 (${zone.bidReason ?? '未激活'})`);
  if (!zone.askActivated) sides.push(`卖侧 (${zone.askReason ?? '未激活'})`);
  const msg = [
    `<b>奖励区可激活 (持续 ${fmtElapsed(elapsed)})</b>`,
    `${marketLink(marketId, slot.title)} (#${htmlEscape(marketId)})`,
    `规则: 离 mid ≤ ±${(zone.maxDistance * 100).toFixed(1)}¢，单边量 ≥ ${zone.minSize}`,
    `当前买1: ${htmlEscape(fmtSide(orderbook.bestBid))}`,
    `当前卖1: ${htmlEscape(fmtSide(orderbook.bestAsk))}`,
    `${htmlEscape(sides.join('，'))}`,
    `PP 奖励: ${totalHourlyRate.toFixed(4)} / 小时`,
  ].join('\n');
  if (await alert('reward_zone', slot, marketId, msg, { elapsedMs: elapsed, bidActivated: zone.bidActivated, askActivated: zone.askActivated })) {
    slot.rewardZoneAlertedAt = now;
  }
}
