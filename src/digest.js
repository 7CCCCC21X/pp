import { config } from './config.js';
import { broadcastTelegramMessage, htmlEscape } from './telegram.js';
import { broadcastChats, activeMarketIds } from './state.js';
import { readHistorySince, summarize24h, rateMovers } from './history.js';
import { fmtElapsed, shortTitle, marketUrl } from './format.js';

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

// "Extreme price" check for the digest's exclude filter: one side of the
// binary already locked near a boundary (best-ask ≥ N¢ OR best-bid ≤
// (100-N)¢) → the market is effectively decided. cents<=0 disables.
function isExtremePriceSlot(slot, cents) {
  if (!Number.isFinite(cents) || cents <= 0) return false;
  const hi = cents / 100;
  const lo = (100 - cents) / 100;
  const bid = slot?.baseline?.bidPrice;
  const ask = slot?.baseline?.askPrice;
  if (Number.isFinite(ask) && ask >= hi) return true;
  if (Number.isFinite(bid) && bid <= lo) return true;
  return false;
}

// One-hour pulse. Primary content is the **stall-alerts roll-up** —
// every market whose 订单簿停滞超过 N 小时 alert fired in the just-
// finished hour gets one compact row (id · title · stall · PP/h ·
// depth) so the user has a single "what's worth grabbing right now"
// list instead of N individual alert messages. New-market sightings
// + pool snapshot ride along as secondary context.
// Window is [previous UTC hour, current UTC hour).
// 10 stalls per page = compact but still requires scroll; matches the
// list-command page size for consistency.
const HOURLY_PAGE_SIZE = 10;

// Hour boundary used by both the auto-send path and the pagination
// callback. Returns [startMs, endMs) for the most recently completed
// UTC hour.
export function currentHourWindow() {
  const now = new Date();
  const endMs = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0,
  );
  return { startMs: endMs - 3600 * 1000, endMs };
}

function fmtHourUTC(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

// Collect + enrich stall alerts that fired inside [startMs, endMs).
// Pure function — caller supplies records (from history) + state for the
// live-data join. Sorted by PP/h desc.
function collectStallRows(records, state) {
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
        question: r.question ?? prev?.question ?? null,
        elapsedMs: elapsed,
        ts: r.ts,
      });
    }
  }
  const rows = [];
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
    rows.push({
      id: m.id,
      title: m.title ?? slot?.title ?? null,
      question: m.question ?? slot?.question ?? null,
      slug: slot?.slug ?? null,
      elapsedMs: m.elapsedMs,
      rate,
      topUsd,
      gap: gaps.length ? gaps.join('/') : null,
    });
  }
  rows.sort((a, b) => (b.rate || 0) - (a.rate || 0));
  return rows;
}

function collectNewlySeen(state, startMs, endMs) {
  const firstSeen = state.marketFirstSeen ?? {};
  const out = [];
  for (const [id, info] of Object.entries(firstSeen)) {
    const ms = typeof info === 'number' ? info : info?.ms;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms >= startMs && ms < endMs) {
      out.push({
        id, ms,
        title: (typeof info === 'object' ? info.title : null) ?? state.markets?.[id]?.title ?? null,
        question: state.markets?.[id]?.question ?? null,
        slug: state.markets?.[id]?.slug ?? null,
        rate: (typeof info === 'object' ? info.rate : null) ?? state.markets?.[id]?.lastHourlyRate ?? null,
      });
    }
  }
  out.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
  return out;
}

// Build the page text + keyboard for a specific [startMs, endMs) window.
// Page index is over the stall list only — newlySeen is always shown on
// page 0 (it's short, won't repeat across pages).
export async function buildHourlyDigest(state, startMs, endMs, page = 0) {
  const records = await readHistorySince(startMs).then(
    (recs) => recs.filter((r) => r.ts < endMs),
  );
  let stallRows = collectStallRows(records, state);
  let newlySeen = collectNewlySeen(state, startMs, endMs);
  // PP/h movers this hour — same logic as /movers but scoped to the hour
  // window's records. Live rate override catches reward windows that ended.
  let moverRows = rateMovers(records, (id) => state.markets?.[id]?.lastHourlyRate);

  // Extreme-price exclusion (default ≥94¢ on). Drops markets where one side
  // is already locked near a boundary — they're effectively decided and not
  // worth surfacing in the hourly triage. 0 disables.
  const extCents = Number.isFinite(state.hourlyDigestExtExclude) ? state.hourlyDigestExtExclude : 94;
  if (extCents > 0) {
    const keep = (id) => !isExtremePriceSlot(state.markets?.[id], extCents);
    stallRows = stallRows.filter((r) => keep(r.id));
    moverRows = moverRows.filter((r) => keep(r.id));
    newlySeen = newlySeen.filter((m) => keep(m.id));
  }

  if (stallRows.length === 0 && newlySeen.length === 0 && moverRows.length === 0) {
    return { text: null, replyMarkup: undefined, stallCount: 0, newCount: 0, moverCount: 0 };
  }

  const ids = activeMarketIds(state);
  const slots = ids.map((id) => state.markets?.[id]).filter(Boolean);
  const live = slots.filter((s) => !s.lastError && !s.lastSkipReason);
  const totalRate = live.reduce(
    (acc, s) => acc + (Number.isFinite(s.lastHourlyRate) ? s.lastHourlyRate : 0),
    0,
  );
  const gapsCount = live.filter((s) => s.zoneStatus
    && (!s.zoneStatus.bidActivated || !s.zoneStatus.askActivated)).length;

  const totalPages = Math.max(1, Math.ceil(stallRows.length / HOURLY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * HOURLY_PAGE_SIZE;
  const pageRows = stallRows.slice(start, start + HOURLY_PAGE_SIZE);

  const lines = [
    `⏱ <b>整点摘要</b> ${fmtHourUTC(startMs)} – ${fmtHourUTC(endMs)} UTC`,
  ];
  const pool = [`池子 <b>${ids.length}</b>`];
  if (totalRate > 0) pool.push(`总 <b>${totalRate.toFixed(0)}</b> PP/h`);
  if (gapsCount > 0) pool.push(`空缺 ${gapsCount}`);
  lines.push(`📊 ${pool.join(' · ')}`);

  if (stallRows.length) {
    lines.push('');
    const pageTag = totalPages > 1 ? ` · 第 ${safePage + 1}/${totalPages} 页` : '';
    lines.push(`🟡 <b>上小时新出停滞</b> (${stallRows.length} 个${pageTag})`);
    for (const r of pageRows) {
      const display = r.title || r.question || `Market ${r.id}`;
      const safeTitle = htmlEscape(shortTitle(display, 40));
      const url = marketUrl(r.id, r.title, r.question, r.slug);
      const titleLink = `<a href="${url}">${safeTitle}</a>`;
      const parts = [`停滞 ${fmtElapsedCompact(r.elapsedMs)}`];
      if (r.rate > 0) parts.push(`<b>${r.rate.toFixed(0)}/h</b>`);
      if (r.topUsd != null) parts.push(`top $${r.topUsd.toFixed(0)}`);
      if (r.gap) parts.push(`gap:${r.gap}`);
      lines.push(`<code>#${htmlEscape(r.id)}</code> ${titleLink}`);
      // Surface the parent event question on outcome-name markets
      // ("$50M" / "Cleveland Cavaliers") so the user can tell what
      // the bet is actually about. Suppress when title already is
      // the question.
      if (r.question && r.question !== r.title) {
        lines.push(`   <i>${htmlEscape(shortTitle(r.question, 60))}</i>`);
      }
      lines.push(`   ${parts.join(' · ')}`);
    }
  }

  // New-rewarded section only on the first page — short, doesn't paginate.
  if (newlySeen.length && safePage === 0) {
    lines.push('');
    lines.push(`🆕 <b>新上奖励 (本小时 ${newlySeen.length})</b>`);
    for (const m of newlySeen.slice(0, 5)) {
      const display = m.title || `Market ${m.id}`;
      const safeTitle = htmlEscape(shortTitle(display, 40));
      const url = marketUrl(m.id, m.title, m.question, m.slug);
      const titleLink = `<a href="${url}">${safeTitle}</a>`;
      const rate = Number.isFinite(m.rate) && m.rate > 0 ? ` — ${m.rate.toFixed(0)}/h` : '';
      lines.push(`• <code>#${htmlEscape(m.id)}</code> ${titleLink}${rate}`);
    }
    if (newlySeen.length > 5) {
      lines.push(`<i>……还有 ${newlySeen.length - 5} 个,/new 查看全部</i>`);
    }
  }

  // PP/h movers this hour — page 1 only (short list, doesn't paginate).
  if (moverRows.length && safePage === 0) {
    lines.push('');
    lines.push(`📈 <b>上小时 PP/h 变动 (${moverRows.length})</b>`);
    for (const m of moverRows.slice(0, 8)) {
      const arrow = m.delta > 0 ? '📈' : '📉';
      const sign = m.delta > 0 ? '+' : '';
      const slot = state.markets?.[m.id] ?? null;
      const display = m.title || slot?.question || `Market ${m.id}`;
      const safeTitle = htmlEscape(shortTitle(display, 32));
      const url = marketUrl(m.id, m.title, slot?.question, slot?.slug);
      lines.push(`${arrow} <code>#${htmlEscape(m.id)}</code> <a href="${url}">${safeTitle}</a> <b>${m.baseline.toFixed(0)}→${m.current.toFixed(0)}</b>/h (${sign}${m.delta.toFixed(0)})`);
    }
    if (moverRows.length > 8) {
      lines.push(`<i>……还有 ${moverRows.length - 8} 个,/movers 查看全部</i>`);
    }
  }

  // Pagination keyboard — only when there's more than one page.
  let replyMarkup;
  if (totalPages > 1) {
    // Encode startMs in base36 to keep the callback short; we only need
    // 1h granularity but the full ms gives an unambiguous re-derivation
    // of the window inside the callback handler.
    const startB36 = startMs.toString(36);
    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: '⬅️ 上一页', callback_data: `hd:p:${startB36}:${safePage - 1}` });
    }
    navRow.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'page:noop' });
    if (safePage < totalPages - 1) {
      navRow.push({ text: '➡️ 下一页', callback_data: `hd:p:${startB36}:${safePage + 1}` });
    }
    replyMarkup = { inline_keyboard: [navRow] };
  }

  return {
    text: lines.join('\n'),
    replyMarkup,
    stallCount: stallRows.length,
    newCount: newlySeen.length,
    moverCount: moverRows.length,
    totalPages,
  };
}

// One-hour pulse. Primary content is the **stall-alerts roll-up** —
// every market whose 订单簿停滞超过 N 小时 alert fired in the just-
// finished hour gets one compact row (id · title · stall · PP/h ·
// depth) so the user has a single "what's worth grabbing right now"
// list instead of N individual alert messages. New-market sightings
// + pool snapshot ride along as secondary context.
export async function sendHourlyDigest(state) {
  const chatIds = broadcastChats(state);
  if (!chatIds.length) return;
  const { startMs, endMs } = currentHourWindow();
  const page = await buildHourlyDigest(state, startMs, endMs, 0);
  if (page.text == null) {
    log(`skipped hourly digest (idle hour ${new Date(startMs).toISOString()})`);
    return;
  }
  await broadcastTelegramMessage(page.text, { chatIds, replyMarkup: page.replyMarkup });
  log(`sent hourly digest (stalls=${page.stallCount} new=${page.newCount} movers=${page.moverCount} pages=${page.totalPages})`);
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
