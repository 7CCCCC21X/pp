import { config } from './config.js';
import { broadcastTelegramMessage, htmlEscape } from './telegram.js';
import { broadcastChats } from './state.js';
import { readHistorySince, summarize24h } from './history.js';
import { fmtElapsed, shortTitle } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[digest]', ...args);

const MEDALS = ['🥇', '🥈', '🥉'];

function sumKey(summary, key) {
  return summary.reduce((acc, m) => acc + (m[key] ?? 0), 0);
}

export async function sendDailyDigest(state) {
  const chatIds = broadcastChats(state);
  const since = Date.now() - 24 * 3600 * 1000;
  const records = await readHistorySince(since);
  const summary = summarize24h(records);
  if (!summary.length) {
    await broadcastTelegramMessage('📈 <b>过去 24 小时摘要</b>\n无任何事件。', { chatIds });
    return;
  }
  summary.sort((a, b) => (b.ppEarned ?? 0) - (a.ppEarned ?? 0));
  const totalPP = sumKey(summary, 'ppEarned');
  const totalAlerts =
    sumKey(summary, 'stallAlerts') +
    sumKey(summary, 'jumpAlerts') +
    sumKey(summary, 'wideSpreadAlerts') +
    sumKey(summary, 'emptyBookAlerts') +
    sumKey(summary, 'rewardZoneAlerts');

  const lines = [
    '📈 <b>过去 24 小时摘要</b>',
    `累计 PP <b>${totalPP.toFixed(2)}</b> · 市场 <b>${summary.length}</b> · 提醒 <b>${totalAlerts}</b>`,
  ];

  const alertParts = [
    sumKey(summary, 'stallAlerts') > 0 ? `停滞×${sumKey(summary, 'stallAlerts')}` : '',
    sumKey(summary, 'jumpAlerts') > 0 ? `跳变×${sumKey(summary, 'jumpAlerts')}` : '',
    sumKey(summary, 'wideSpreadAlerts') > 0 ? `阔差×${sumKey(summary, 'wideSpreadAlerts')}` : '',
    sumKey(summary, 'emptyBookAlerts') > 0 ? `空簿×${sumKey(summary, 'emptyBookAlerts')}` : '',
    sumKey(summary, 'rewardZoneAlerts') > 0 ? `区外×${sumKey(summary, 'rewardZoneAlerts')}` : '',
  ].filter(Boolean);
  if (alertParts.length) {
    lines.push(`🔔 ${alertParts.join(' · ')}`);
  }
  lines.push('');
  lines.push('🏆 <b>PP 贡献 Top</b>');

  const top = summary.slice(0, 15);
  for (const [idx, m] of top.entries()) {
    const medal = idx < 3 ? MEDALS[idx] : `${idx + 1}.`;
    const title = m.title ? htmlEscape(shortTitle(m.title, 42)) : `Market ${m.marketId}`;
    const rate = Number.isFinite(m.lastHourlyRate) ? `${m.lastHourlyRate.toFixed(0)}/h` : '?/h';
    const pp = (m.ppEarned ?? 0).toFixed(1);
    const counts = [
      m.stallAlerts > 0 ? `停滞×${m.stallAlerts}` : '',
      m.jumpAlerts > 0 ? `跳变×${m.jumpAlerts}` : '',
      m.wideSpreadAlerts > 0 ? `阔差×${m.wideSpreadAlerts}` : '',
      m.emptyBookAlerts > 0 ? `空簿×${m.emptyBookAlerts}` : '',
      m.rewardZoneAlerts > 0 ? `区外×${m.rewardZoneAlerts}` : '',
    ].filter(Boolean).join(' · ');
    const stall = m.maxStallMs > 0 ? `停滞 ${fmtElapsed(m.maxStallMs)}` : '';
    lines.push(`${medal} <code>#${htmlEscape(m.marketId)}</code> ${title}`);
    lines.push(`   <b>${pp} PP</b> · ${rate}${counts ? ` · ${counts}` : ''}${stall ? ` · ${stall}` : ''}`);
  }
  await broadcastTelegramMessage(lines.join('\n'), { chatIds });
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
