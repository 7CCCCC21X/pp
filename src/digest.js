import { config } from './config.js';
import { broadcastTelegramMessage, htmlEscape } from './telegram.js';
import { broadcastChats, activeMarketIds } from './state.js';
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

// One-hour pulse. Compact "what just happened" message so the user
// doesn't have to flip through /top, /gaps, /new manually every hour.
// Triggered on the wall-clock hour boundary (top of hour, UTC). Window
// is [previous hour, current hour) so each pulse covers exactly 1h
// without overlap and aligns nicely with "the hour just ending".
export async function sendHourlyDigest(state) {
  const chatIds = broadcastChats(state);
  if (!chatIds.length) return;
  const now = new Date();
  // Window end = current top-of-hour, start = 1h before.
  const endMs = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  const startMs = endMs - 3600 * 1000;
  const records = await readHistorySince(startMs).then(
    (recs) => recs.filter((r) => r.ts < endMs),
  );
  const summary = summarize24h(records);
  summary.sort((a, b) => (b.ppEarned ?? 0) - (a.ppEarned ?? 0));

  // Pool snapshot from live state.
  const ids = activeMarketIds(state);
  const slots = ids.map((id) => state.markets?.[id]).filter(Boolean);
  const live = slots.filter((s) => !s.lastError && !s.lastSkipReason);
  const totalRate = live.reduce((acc, s) => acc + (Number.isFinite(s.lastHourlyRate) ? s.lastHourlyRate : 0), 0);
  const gapsCount = live.filter((s) => s.zoneStatus
    && (!s.zoneStatus.bidActivated || !s.zoneStatus.askActivated)).length;

  // New-rewarded sightings in this hour window (firstSeenMs falls inside [start, end)).
  const firstSeen = state.marketFirstSeen ?? {};
  const newlySeen = [];
  for (const [id, info] of Object.entries(firstSeen)) {
    const ms = typeof info === 'number' ? info : info?.ms;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms >= startMs && ms < endMs) {
      newlySeen.push({
        id, ms,
        title: (typeof info === 'object' ? info.title : null) ?? state.markets?.[id]?.title ?? null,
        rate: (typeof info === 'object' ? info.rate : null) ?? state.markets?.[id]?.lastHourlyRate ?? null,
      });
    }
  }
  newlySeen.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));

  const totalPP = sumKey(summary, 'ppEarned');
  const alertCounts = {
    stall: sumKey(summary, 'stallAlerts'),
    jump: sumKey(summary, 'jumpAlerts'),
    wide: sumKey(summary, 'wideSpreadAlerts'),
    empty: sumKey(summary, 'emptyBookAlerts'),
    zone: sumKey(summary, 'rewardZoneAlerts'),
  };
  const totalAlerts = Object.values(alertCounts).reduce((a, b) => a + b, 0);

  // Suppress no-op hours — if nothing happened (no PP, no alerts, no new
  // markets), skip the push. Avoids spamming idle channels every hour.
  if (totalPP === 0 && totalAlerts === 0 && newlySeen.length === 0) {
    log(`skipped hourly digest (idle hour ${new Date(startMs).toISOString()})`);
    return;
  }

  const fmtHourUTC = (ms) => {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  };

  const lines = [
    `⏱ <b>整点摘要</b> ${fmtHourUTC(startMs)} – ${fmtHourUTC(endMs)} UTC`,
  ];

  const pool = [`池子 <b>${ids.length}</b>`];
  if (totalRate > 0) pool.push(`总 <b>${totalRate.toFixed(0)}</b> PP/h`);
  if (gapsCount > 0) pool.push(`空缺 <b>${gapsCount}</b>`);
  if (newlySeen.length > 0) pool.push(`新上 <b>${newlySeen.length}</b>`);
  lines.push(`📊 ${pool.join(' · ')}`);

  if (totalPP > 0) {
    lines.push(`💰 上小时入账 <b>${totalPP.toFixed(0)} PP</b>`);
  }

  if (totalAlerts > 0) {
    const alertParts = [
      alertCounts.stall > 0 ? `停滞×${alertCounts.stall}` : '',
      alertCounts.jump > 0 ? `跳变×${alertCounts.jump}` : '',
      alertCounts.wide > 0 ? `阔差×${alertCounts.wide}` : '',
      alertCounts.empty > 0 ? `空簿×${alertCounts.empty}` : '',
      alertCounts.zone > 0 ? `区外×${alertCounts.zone}` : '',
    ].filter(Boolean);
    lines.push(`🔔 ${alertParts.join(' · ')}`);
  }

  // Top PP earners in this hour.
  const topPP = summary.filter((m) => (m.ppEarned ?? 0) > 0).slice(0, 5);
  if (topPP.length) {
    lines.push('');
    lines.push('🏆 <b>上小时 PP 贡献</b>');
    for (const [i, m] of topPP.entries()) {
      const medal = i < 3 ? MEDALS[i] : `${i + 1}.`;
      const title = m.title ? htmlEscape(shortTitle(m.title, 36)) : `Market ${m.marketId}`;
      const rate = Number.isFinite(m.lastHourlyRate) ? ` · ${m.lastHourlyRate.toFixed(0)}/h` : '';
      lines.push(`${medal} <code>#${htmlEscape(m.marketId)}</code> ${title} — <b>${(m.ppEarned ?? 0).toFixed(0)} PP</b>${rate}`);
    }
  }

  // Newly-rewarded markets that arrived this hour.
  if (newlySeen.length) {
    lines.push('');
    lines.push(`🆕 <b>新上奖励 (本小时 ${newlySeen.length})</b>`);
    for (const m of newlySeen.slice(0, 5)) {
      const title = m.title ? htmlEscape(shortTitle(m.title, 40)) : `Market ${m.id}`;
      const rate = Number.isFinite(m.rate) && m.rate > 0 ? ` — ${m.rate.toFixed(0)}/h` : '';
      lines.push(`• <code>#${htmlEscape(m.id)}</code> ${title}${rate}`);
    }
    if (newlySeen.length > 5) {
      lines.push(`<i>……还有 ${newlySeen.length - 5} 个,/new 查看全部</i>`);
    }
  }

  await broadcastTelegramMessage(lines.join('\n'), { chatIds });
  log(`sent hourly digest (PP=${totalPP.toFixed(0)} alerts=${totalAlerts} new=${newlySeen.length})`);
}

// Fire on each wall-clock-hour boundary. State.lastHourlyDigestAt tracks
// the *boundary timestamp* of the most recently sent hour so we send at
// most once per UTC hour even if the tick runs multiple times after the
// boundary is crossed.
export function shouldSendHourlyDigest(state) {
  if (!config.hourlyDigestEnabled) return false;
  const now = new Date();
  const currentBoundary = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  return (state.lastHourlyDigestAt ?? 0) < currentBoundary;
}
