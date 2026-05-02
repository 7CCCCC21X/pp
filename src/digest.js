import { config } from './config.js';
import { sendTelegramMessage, htmlEscape } from './telegram.js';
import { readHistorySince, summarize24h } from './history.js';
import { fmtElapsed } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[digest]', ...args);

export async function sendDailyDigest() {
  const since = Date.now() - 24 * 3600 * 1000;
  const records = await readHistorySince(since);
  const summary = summarize24h(records);
  if (!summary.length) {
    await sendTelegramMessage('<b>过去 24 小时摘要</b>\n无任何事件。');
    return;
  }
  summary.sort((a, b) => b.maxStallMs - a.maxStallMs || (b.lastHourlyRate ?? 0) - (a.lastHourlyRate ?? 0));
  const top = summary.slice(0, 15);
  const lines = [`<b>过去 24 小时摘要 (${summary.length} 个市场)</b>`];
  for (const m of top) {
    const title = m.title ? htmlEscape(m.title.slice(0, 40)) : `Market ${m.marketId}`;
    const rate = Number.isFinite(m.lastHourlyRate) ? m.lastHourlyRate.toFixed(2) : '?';
    const stall = m.maxStallMs > 0 ? `最长停滞 ${fmtElapsed(m.maxStallMs)}` : '';
    const counts = [
      m.moves > 0 ? `${m.moves} 次变动` : '',
      m.stallAlerts > 0 ? `停滞×${m.stallAlerts}` : '',
      m.jumpAlerts > 0 ? `跳变×${m.jumpAlerts}` : '',
      m.wideSpreadAlerts > 0 ? `阔差×${m.wideSpreadAlerts}` : '',
      m.emptyBookAlerts > 0 ? `空簿×${m.emptyBookAlerts}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`#${m.marketId} ${title} — PP ${rate}/h · ${counts || '稳定'}${stall ? ' · ' + stall : ''}`);
  }
  await sendTelegramMessage(lines.join('\n'));
  log('sent digest');
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
