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

function fmtElapsedCompact(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '?';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

// One-hour pulse. Primary content is the **stall-alerts roll-up** —
// every market whose 订单簿停滞超过 N 小时 alert fired in the just-
// finished hour gets one compact row (id · title · stall · PP/h ·
// depth) so the user has a single "what's worth grabbing right now"
// list instead of N individual alert messages. New-market sightings
// + pool snapshot ride along as secondary context.
// Window is [previous UTC hour, current UTC hour).
export async function sendHourlyDigest(state) {
  const chatIds = broadcastChats(state);
  if (!chatIds.length) return;
  const now = new Date();
  const endMs = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  const startMs = endMs - 3600 * 1000;
  const records = await readHistorySince(startMs).then(
    (recs) => recs.filter((r) => r.ts < endMs),
  );

  // Collect stall alerts that fired in this hour. One row per market
  // (max elapsed if duplicates). Joined against live state.markets to
  // render current PP/h + depth + reward-zone status — fresher than
  // whatever the alert snapshot captured.
  const stallByMarket = new Map();
  for (const r of records) {
    if (r.event !== 'alert' || r.kind !== 'stall') continue;
    const id = String(r.marketId ?? '');
    if (!id) continue;
    const prev = stallByMarket.get(id);
    const elapsed = Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0;
    if (!prev || elapsed > prev.elapsedMs) {
      stallByMarket.set(id, {
        id,
        title: r.title ?? prev?.title ?? null,
        elapsedMs: elapsed,
        ts: r.ts,
      });
    }
  }
  // Enrich with live data — current PP/h, depth, gap status.
  const stallRows = [];
  for (const m of stallByMarket.values()) {
    const slot = state.markets?.[m.id] ?? null;
    const rate = Number.isFinite(slot?.lastHourlyRate) ? slot.lastHourlyRate : 0;
    const topUsd = Number.isFinite(slot?.lastTopUsd) && slot.lastTopUsd > 0 ? slot.lastTopUsd : null;
    const z = slot?.zoneStatus;
    const gaps = [];
    if (z) {
      if (!z.bidActivated) gaps.push('买');
      if (!z.askActivated) gaps.push('卖');
    }
    stallRows.push({
      id: m.id,
      title: m.title ?? slot?.title ?? null,
      elapsedMs: m.elapsedMs,
      rate,
      topUsd,
      gap: gaps.length ? gaps.join('/') : null,
    });
  }
  // Sort by PP/h desc so the most lucrative stalls float to the top —
  // this is the "go make markets HERE" triage signal.
  stallRows.sort((a, b) => (b.rate || 0) - (a.rate || 0));

  // Pool snapshot from live state.
  const ids = activeMarketIds(state);
  const slots = ids.map((id) => state.markets?.[id]).filter(Boolean);
  const live = slots.filter((s) => !s.lastError && !s.lastSkipReason);
  const totalRate = live.reduce(
    (acc, s) => acc + (Number.isFinite(s.lastHourlyRate) ? s.lastHourlyRate : 0),
    0,
  );
  const gapsCount = live.filter((s) => s.zoneStatus
    && (!s.zoneStatus.bidActivated || !s.zoneStatus.askActivated)).length;

  // New-rewarded sightings in this hour window.
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

  // Suppress no-op hours: nothing stalled, nothing new → skip the push.
  if (stallRows.length === 0 && newlySeen.length === 0) {
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

  // Compact pool snapshot line — context, not the main signal.
  const pool = [`池子 <b>${ids.length}</b>`];
  if (totalRate > 0) pool.push(`总 <b>${totalRate.toFixed(0)}</b> PP/h`);
  if (gapsCount > 0) pool.push(`空缺 ${gapsCount}`);
  lines.push(`📊 ${pool.join(' · ')}`);

  // Main section: stall alerts that fired this hour.
  if (stallRows.length) {
    lines.push('');
    lines.push(`🟡 <b>上小时新出停滞</b> (${stallRows.length} 个)`);
    const SHOW = 15;
    for (const r of stallRows.slice(0, SHOW)) {
      const title = r.title ? htmlEscape(shortTitle(r.title, 36)) : `Market ${r.id}`;
      const parts = [`停滞 ${fmtElapsedCompact(r.elapsedMs)}`];
      if (r.rate > 0) parts.push(`<b>${r.rate.toFixed(0)}/h</b>`);
      if (r.topUsd != null) parts.push(`top $${r.topUsd.toFixed(0)}`);
      if (r.gap) parts.push(`gap:${r.gap}`);
      lines.push(`<code>#${htmlEscape(r.id)}</code> ${title}`);
      lines.push(`   ${parts.join(' · ')}`);
    }
    if (stallRows.length > SHOW) {
      lines.push(`<i>……还有 ${stallRows.length - SHOW} 个,/stale 查看全部</i>`);
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
  log(`sent hourly digest (stalls=${stallRows.length} new=${newlySeen.length})`);
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
