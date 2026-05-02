import { config } from './config.js';
import { sendLongTelegramMessage, htmlEscape } from './telegram.js';
import { readHistorySince, summarize24h } from './history.js';
import { fmtElapsed } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[digest]', ...args);

export async function sendDailyDigest() {
  const since = Date.now() - 24 * 3600 * 1000;
  const records = await readHistorySince(since);
  const summary = summarize24h(records);
  if (!summary.length) {
    await sendLongTelegramMessage('<b>过去 24 小时摘要</b>\n无任何事件。');
    return;
  }
  // Sort by PP earned descending — most productive markets first.
  summary.sort((a, b) => (b.ppEarned ?? 0) - (a.ppEarned ?? 0));
  const totalPP = summary.reduce((acc, m) => acc + (m.ppEarned ?? 0), 0);
  const totalAlerts = summary.reduce((acc, m) =>
    acc + m.stallAlerts + m.jumpAlerts + m.wideSpreadAlerts + m.emptyBookAlerts + m.rewardZoneAlerts, 0);
  const top = summary.slice(0, 15);
  const lines = [
    `<b>过去 24 小时摘要</b>`,
    `<b>累计 PP 产出: ${totalPP.toFixed(2)}</b> · ${summary.length} 个市场 · ${totalAlerts} 条提醒`,
    '',
  ];
  for (const m of top) {
    const title = m.title ? htmlEscape(m.title.slice(0, 40)) : `Market ${m.marketId}`;
    const rate = Number.isFinite(m.lastHourlyRate) ? m.lastHourlyRate.toFixed(0) : '?';
    const pp = (m.ppEarned ?? 0).toFixed(1);
    const stall = m.maxStallMs > 0 ? `最长停滞 ${fmtElapsed(m.maxStallMs)}` : '';
    const counts = [
      m.stallAlerts > 0 ? `停滞×${m.stallAlerts}` : '',
      m.jumpAlerts > 0 ? `跳变×${m.jumpAlerts}` : '',
      m.wideSpreadAlerts > 0 ? `阔差×${m.wideSpreadAlerts}` : '',
      m.emptyBookAlerts > 0 ? `空簿×${m.emptyBookAlerts}` : '',
      m.rewardZoneAlerts > 0 ? `区外×${m.rewardZoneAlerts}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`#${m.marketId} ${title} — ${pp} PP · ${rate}/h${counts ? ' · ' + counts : ''}${stall ? ' · ' + stall : ''}`);
  }
  await sendLongTelegramMessage(lines.join('\n'));
  log(`sent digest (24h PP=${totalPP.toFixed(2)})`);
}

export function shouldSendDigest(state) {
  if (!config.digestEnabled) return false;
  const now = new Date();
  const last = new Date(state.lastDigestSentAt ?? 0);
  // Trigger when: now is at or past digestHourUtc on a calendar day
  // we haven't yet sent for.
  const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  const lastKey = state.lastDigestSentAt
    ? `${last.getUTCFullYear()}-${last.getUTCMonth()}-${last.getUTCDate()}`
    : '';
  return now.getUTCHours() >= config.digestHourUtc && todayKey !== lastKey;
}
