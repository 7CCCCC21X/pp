import { config } from './config.js';
import { getMarketRewardSummary, getOrderbook, marketEndMs, getSlugMapCached, getMarketRestById } from './predict.js';
import { broadcastTelegramMessage, htmlEscape } from './telegram.js';
import { appendHistory } from './history.js';
import { fmtElapsed, midOf, spreadOf, rewardZoneStatus, scoreSlot, priorityOf } from './format.js';
import { effectiveFilters, checkFilter } from './filters.js';
import { effectiveOverride, broadcastChats } from './state.js';
import { alertKeyboard } from './commands.js';
import { detectStall } from './alerts/stall.js';
import { detectWatch } from './alerts/watch.js';
import { detectMidJump } from './alerts/midJump.js';
import { detectWideSpread } from './alerts/wideSpread.js';
import { detectRewardZone } from './alerts/rewardZone.js';
import { detectEmptyBook } from './alerts/emptyBook.js';
import { detectSnapshot } from './alerts/snapshot.js';

const log = (...args) => console.log(new Date().toISOString(), '[monitor]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[monitor]', ...args);

function priceMoved(prev, next) {
  if (prev == null && next == null) return false;
  if (prev == null || next == null) return true;
  return Math.abs(prev - next) >= config.priceEpsilon;
}

function sizeMoved(prev, next) {
  if (!config.trackSize) return false;
  if (prev == null && next == null) return false;
  if (prev == null || next == null) return true;
  const diff = Math.abs(prev - next);
  if (diff < config.sizeAbsoluteMin) return false;
  const base = Math.max(Math.abs(prev), Math.abs(next));
  if (base === 0) return false;
  return diff / base >= config.sizeRelativeEpsilon;
}

function topMoved(prevPrice, prevSize, nextSide) {
  const nextPrice = nextSide?.price ?? null;
  const nextSize = nextSide?.size ?? null;
  return priceMoved(prevPrice, nextPrice) || sizeMoved(prevSize, nextSize);
}

function ensureSlot(state, marketId, cur, now) {
  let slot = state.markets[marketId];
  if (!slot) {
    slot = {
      baseline: cur,
      lastChangeAt: now,
      lastSeenAt: now,
      alerted: false,
      lastMid: midOf({
        bestBid: cur.bidPrice != null ? { price: cur.bidPrice, size: cur.bidSize } : null,
        bestAsk: cur.askPrice != null ? { price: cur.askPrice, size: cur.askSize } : null,
      }),
      midJumpAlertedAt: 0,
      wideSpreadSince: null,
      wideSpreadAlertedAt: 0,
      emptyBookSince: cur.bidPrice == null || cur.askPrice == null ? now : null,
      emptyBookAlertedAt: 0,
      title: null,
      lastHourlyRate: null,
    };
    state.markets[marketId] = slot;
  }
  return slot;
}

// Stub slot for markets we can't fully process yet (resolved, fetch failed,
// no rewards). Lets /status surface a real reason instead of the misleading
// "等待首次抓取" forever. Also clears stale rate/zone snapshots from a
// previous successful tick — otherwise /top, /gaps, /opp keep listing
// expired 15-min markets at their last-known PP/h.
function ensureStubSlot(state, marketId, now) {
  let slot = state.markets[marketId];
  if (!slot) {
    slot = { lastSeenAt: now, title: null };
    state.markets[marketId] = slot;
  }
  slot.lastSeenAt = now;
  slot.lastHourlyRate = 0;
  slot.zoneStatus = null;
  return slot;
}

// Priority gate ordering: 'all' lets every priority through, 'high'
// only allows 🔥. Numeric ranks let comparisons stay readable.
const PRIORITY_RANK = { all: 0, low: 1, medium: 2, high: 3 };
const PRIORITY_BADGE = { high: '🔥', medium: '⭐', low: '' };

// Per-kind chat routing. "Per-market follow-the-action" alerts land
// only in admin's private chat — they're noise for groups since the
// market is something the admin specifically picked (e.g. /watch).
// Broad "is the market interesting" alerts broadcast to admin + every
// whitelisted group so multiple chats can watch the opportunity flow.
const ADMIN_ONLY_KINDS = new Set(['watch', 'snapshot']);

function chatsForKind(state, kind) {
  const baseKind = kind.replace(/_recovered$/, '');
  // Layer 1: kind-based default routing.
  let candidates;
  if (ADMIN_ONLY_KINDS.has(baseKind)) {
    candidates = config.telegramChatId ? [String(config.telegramChatId)] : [];
  } else {
    candidates = broadcastChats(state);
  }
  // Layer 2: per-chat exclude. /route off <kind> in a specific chat
  // takes that chat off the candidate list for this kind. Useful when
  // a group only wants reward_zone alerts but not noisy stall pings.
  const routing = state.chatRouting ?? {};
  return candidates.filter((cid) => {
    const route = routing[String(cid)];
    return !route?.exclude?.includes(baseKind);
  });
}

async function alert(state, kind, slot, marketId, message, extra = {}) {
  const isExempt = kind === 'watch' || kind === 'snapshot' || kind.endsWith('_recovered');

  // 1) Global temporary mute — /quiet sets state.quietUntil.
  //    Recoveries still land (they're "back to normal" pings, not noise).
  if (!isExempt) {
    if (state.quietUntil && Date.now() < state.quietUntil) {
      log(`[${marketId}] suppress ${kind} (quiet until ${new Date(state.quietUntil).toISOString()})`);
      return false;
    }
    // 2) Per-kind off-switch — /alerts off <kind>. Recovery uses its
    //    base kind's setting so disabling stall also disables stall_recovered.
    const baseKind = kind.replace(/_recovered$/, '');
    if (state.alertKinds && state.alertKinds[baseKind] === false) {
      log(`[${marketId}] suppress ${kind} (kind ${baseKind} disabled)`);
      return false;
    }
    // 3) PP/h alert floor — /find / /top still see low-rate markets,
    //    but proactive alerts only fire above ALERT_MIN_HOURLY_RATE.
    if (config.alertMinHourlyRate > 0
        && (slot.lastHourlyRate ?? 0) < config.alertMinHourlyRate) {
      log(`[${marketId}] suppress ${kind} (rate ${slot.lastHourlyRate ?? 0} < ${config.alertMinHourlyRate})`);
      return false;
    }
  }

  // Compute priority once — used both for the badge and the gate.
  // Watch/recovery skip the gate but still get a badge for visual
  // consistency in the chat history.
  const score = scoreSlot(slot);
  const priority = priorityOf(score, {
    highThreshold: config.alertPriorityHigh,
    mediumThreshold: config.alertPriorityMedium,
  });
  if (!isExempt) {
    const minRank = PRIORITY_RANK[config.alertPriorityMin] ?? 0;
    const myRank = PRIORITY_RANK[priority] ?? 1;
    if (myRank < minRank) {
      log(`[${marketId}] suppress ${kind} (priority ${priority} < min ${config.alertPriorityMin})`);
      return false;
    }
  }

  // 4) Per-market cross-type cooldown to keep one illiquid market from
  //    emitting wide_spread + reward_zone + empty_book back-to-back.
  if (!isExempt) {
    const sinceAny = Date.now() - (slot.lastAnyAlertAt ?? 0);
    if (sinceAny < config.marketAlertCooldownMs) {
      log(`[${marketId}] suppress ${kind} (per-market cooldown ${Math.round(sinceAny / 1000)}s)`);
      return false;
    }
  }
  // 5) Decorate: priority badge prepended to the title line, hashtag
  //    footer (#kind #market_id #priority) for in-app search.
  const badge = PRIORITY_BADGE[priority];
  const decorated = badge ? `${badge} ${message}` : message;
  const tagged = `${decorated}\n\n#${kind} #market_${marketId}${badge ? ` #${priority}` : ''}`;
  try {
    const chatIds = chatsForKind(state, kind);
    if (chatIds.length === 0) {
      log(`[${marketId}] suppress ${kind} (no eligible chats — admin chat unset?)`);
      return false;
    }
    // Split chats into "send now" vs "queue for digest". watch / snapshot
    // (ADMIN_ONLY_KINDS) are never digested — user explicitly registered
    // those for immediate per-market follow.
    const baseKind = kind.replace(/_recovered$/, '');
    const isDigestable = !ADMIN_ONLY_KINDS.has(baseKind);
    const immediate = [];
    if (isDigestable) {
      for (const cid of chatIds) {
        const d = state.chatDigests?.[cid];
        if (d?.intervalMs > 0) {
          if (!Array.isArray(d.queue)) d.queue = [];
          d.queue.push({
            kind, marketId,
            title: slot.title ?? null,
            rate: slot.lastHourlyRate ?? 0,
            priority,
            ts: Date.now(),
          });
          // Cap to avoid unbounded growth between flushes.
          if (d.queue.length > 100) d.queue = d.queue.slice(-100);
        } else {
          immediate.push(cid);
        }
      }
    } else {
      immediate.push(...chatIds);
    }
    if (immediate.length) {
      await broadcastTelegramMessage(tagged, { chatIds: immediate, replyMarkup: alertKeyboard(marketId) });
    }
  } catch (err) {
    warn(`[${marketId}] telegram send (${kind}) failed:`, err.message);
    return false;
  }
  await appendHistory({
    event: 'alert',
    kind,
    marketId,
    title: slot.title ?? null,
    question: slot.question ?? null,
    slug: slot.slug ?? null,
    totalHourlyRate: slot.lastHourlyRate,
    priority,
    score: Math.round(score),
    ...extra,
  }).catch(() => {});
  if (!isExempt) {
    slot.lastAnyAlertAt = Date.now();
  }
  return true;
}

const KIND_LABELS = {
  stall: '🟡 停滞',
  mid_jump: '⚡ 跳变',
  wide_spread: '🔴 阔差',
  reward_zone: '🎯 奖励区',
  empty_book: '🌊 空簿',
  stall_recovered: '✅ 停滞恢复',
  mid_jump_recovered: '✅ 跳变恢复',
  wide_spread_recovered: '✅ 阔差恢复',
  reward_zone_recovered: '✅ 奖励区恢复',
  empty_book_recovered: '✅ 空簿恢复',
};

// Render a queued list of digest items as a single message. Groups
// by kind, then collapses repeats per market so the same market
// firing 5 times doesn't bloat the summary.
export function formatDigestSummary(items) {
  if (!items.length) return '';
  const byKind = new Map();
  for (const i of items) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind).push(i);
  }
  const lines = [`📦 <b>提醒摘要 (${items.length} 条)</b>`, ''];
  for (const [kind, batch] of byKind) {
    const label = KIND_LABELS[kind] ?? kind;
    lines.push(`${label} <b>${batch.length}</b>`);
    const byMarket = new Map();
    for (const i of batch) byMarket.set(i.marketId, i); // last-wins
    for (const [id, i] of byMarket) {
      const title = i.title ? htmlEscape(String(i.title).slice(0, 40)) : `Market ${htmlEscape(id)}`;
      const rate = Number.isFinite(i.rate) && i.rate > 0 ? ` · ${i.rate.toFixed(0)}/h` : '';
      lines.push(`  <code>#${htmlEscape(id)}</code> ${title}${rate}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Called from the tick loop. For each chat in digest mode whose
// interval has elapsed, sends the queued items as one summary
// message and resets the queue. Failures are logged but not retried
// (re-queueing would loop on persistent send errors).
export async function flushChatDigests(state) {
  const now = Date.now();
  const digests = state.chatDigests ?? {};
  for (const [cid, d] of Object.entries(digests)) {
    if (!d.intervalMs || !Array.isArray(d.queue) || d.queue.length === 0) continue;
    if (now - (d.lastFlushAt ?? 0) < d.intervalMs) continue;
    const items = d.queue.slice();
    d.queue = [];
    d.lastFlushAt = now;
    try {
      const text = formatDigestSummary(items);
      const { sendLongTelegramMessage } = await import('./telegram.js');
      await sendLongTelegramMessage(text, { chatId: cid });
    } catch (err) {
      warn(`digest flush to ${cid} failed:`, err.message);
    }
  }
}

const DETECTORS = [
  detectWatch,        // fires on every detected change (watched markets only)
  detectMidJump,      // tick-to-tick mid drift; also updates slot.lastMid
  detectWideSpread,
  detectRewardZone,
  detectEmptyBook,
  detectSnapshot,     // periodic full-orderbook push for /snapshot markets
  // Stall is special — also resets on book move; runs last because it
  // depends on baseline state from the move-detection block.
];

export async function checkMarket(marketId, state, { isPaused }) {
  const tickStart = Date.now();
  let rewardSummary = null;
  try {
    rewardSummary = await getMarketRewardSummary(marketId);
  } catch (err) {
    warn(`[${marketId}] reward fetch failed:`, err.message);
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.lastError = `奖励查询失败: ${err.message.slice(0, 100)}`;
    return;
  }

  if (!rewardSummary?.market) {
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.lastError = '市场不存在（可能已 resolve 或 id 错误）';
    return;
  }

  const orderbookKey = rewardSummary.orderbookKey ?? marketId;
  const market = rewardSummary.market;
  const cache = state.markets[marketId]?.orderbookCache ?? null;

  const totalHourlyRate = rewardSummary?.totalHourlyRate ?? 0;
  if (config.skipNoReward && totalHourlyRate <= 0) {
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.title = rewardSummary.title ?? stub.title;
    stub.lastSkipReason = 'PP/h = 0 (已 resolve 或无奖励)';
    stub.lastError = null;
    log(`[${marketId}] skip: no PP reward`);
    return;
  }

  // Tick-level remaining-time guard — even if discovery added this market
  // when it had hours to go, skip alerting once it drops below the limit.
  // Stops 15-min Bitcoin markets from spamming once the autoIds list is
  // stale between discovery cycles.
  if (config.minRemainingHours > 0) {
    const endMs = marketEndMs(market);
    if (endMs != null && endMs < tickStart + config.minRemainingHours * 3600 * 1000) {
      const stub = ensureStubSlot(state, marketId, tickStart);
      stub.title = rewardSummary.title ?? stub.title;
      const remainingHours = Math.max(0, (endMs - tickStart) / 3600000);
      stub.lastSkipReason = `剩余 ${remainingHours.toFixed(1)}h < ${config.minRemainingHours}h，跳过`;
      stub.lastError = null;
      log(`[${marketId}] skip: remaining ${remainingHours.toFixed(1)}h`);
      return;
    }
  }

  let orderbook;
  try {
    orderbook = await getOrderbook(orderbookKey, {
      contextMarketId: marketId,
      market,
      cache,
    });
  } catch (err) {
    warn(`[${marketId}] orderbook fetch failed:`, err.message);
    const stub = ensureStubSlot(state, marketId, tickStart);
    stub.title = rewardSummary.title ?? stub.title;
    // Compact reason: keep the actionable bit, drop the URL.
    const m = err.message.match(/(404|403|401|5\d\d|timed out)/i);
    const code = m ? m[0] : 'fetch failed';
    const tries = err.message.match(/tried (\d+)/i)?.[1];
    stub.lastError = `订单簿 ${code}${tries ? ` (尝试 ${tries} 种组合)` : ''} — 市场可能已 resolve`;
    stub.lastSkipReason = null;
    stub.consecutiveOrderbookErrors = (stub.consecutiveOrderbookErrors ?? 0) + 1;
    return;
  }
  // Reset error counter on a successful fetch so a recovered market clears.

  const now = Date.now();
  const cur = {
    bidPrice: orderbook.bestBid?.price ?? null,
    bidSize: orderbook.bestBid?.size ?? null,
    askPrice: orderbook.bestAsk?.price ?? null,
    askSize: orderbook.bestAsk?.size ?? null,
  };
  const slot = ensureSlot(state, marketId, cur, now);
  // Persist the working (template, key) so future ticks skip the
  // self-heal probe loop — even on the very first tick for a market.
  slot.orderbookCache = {
    template: orderbook.template,
    key: orderbook.orderbookKey,
  };
  slot.lastError = null;
  slot.consecutiveOrderbookErrors = 0;
  // Reset only non-filter skip reasons; the filter result a few lines down
  // overwrites lastSkipReason itself with either the failing rule or null.
  if (!slot.lastSkipReason || !slot.lastSkipReason.startsWith('过滤器:')) {
    slot.lastSkipReason = null;
  }
  // Stash the parsed end time for /status to compute remaining hours +
  // total available PP without redoing the regex match each command.
  slot.endMs = marketEndMs(market);
  if (rewardSummary?.title) slot.title = rewardSummary.title;
  // question is the event-level prompt; for outcome-name markets ("Draw",
  // "Yes") only the question slugifies to the right predict.fun URL.
  if (rewardSummary?.market?.question) slot.question = rewardSummary.market.question;
  // Resolve the real URL slug (Predict.fun's `categorySlug`). Use the
  // bulk REST cache first (covers ~top 100 markets), then fall back to
  // a single-market REST GET for cache misses. Once persisted into
  // slot.slug it survives restarts via state.json — no need to refetch.
  if (!slot.slug) {
    try {
      const slugMap = await getSlugMapCached();
      let realSlug = slugMap?.get(String(marketId)) ?? null;
      if (!realSlug) {
        const restMarket = await getMarketRestById(marketId);
        const cs = restMarket?.categorySlug || restMarket?.slug || restMarket?.marketSlug;
        if (cs) realSlug = String(cs);
      }
      if (realSlug) slot.slug = realSlug;
    } catch {
      // Non-fatal — fall back to title/question slugify in marketLink.
    }
  }
  slot.lastHourlyRate = totalHourlyRate;
  // Per-tick book metrics for the unified row format used by every list
  // command (/top, /gaps, /thin, /wide, /empty, /opp). Computing once
  // here costs nothing and lets renderListPage skip recomputation.
  slot.lastSpread = (Number.isFinite(orderbook.bestBid?.price) && Number.isFinite(orderbook.bestAsk?.price))
    ? orderbook.bestAsk.price - orderbook.bestBid.price
    : null;
  const bidUsd = orderbook.bestBid ? orderbook.bestBid.price * orderbook.bestBid.size : 0;
  const askUsd = orderbook.bestAsk ? orderbook.bestAsk.price * orderbook.bestAsk.size : 0;
  slot.lastTopUsd = bidUsd + askUsd;
  const sumSide = (rows) => Array.isArray(rows)
    ? rows.reduce((acc, r) => acc + ((r?.price ?? 0) * (r?.size ?? 0)), 0)
    : 0;
  slot.lastTotalUsd = sumSide(orderbook.bids) + sumSide(orderbook.asks);
  const lastSeenAt = slot.lastSeenAt ?? now;
  slot.lastSeenAt = now;

  // Per-tick rate logging — used by /digest to compute 24h PP totals.
  if (totalHourlyRate > 0) {
    const dtMs = Math.min(now - lastSeenAt, 2 * config.pollIntervalMs);
    if (dtMs > 0) {
      appendHistory({
        event: 'rate',
        marketId,
        title: slot.title ?? null,
        hourlyRate: totalHourlyRate,
        dtMs,
        ppEarned: (totalHourlyRate * dtMs) / 3600000,
      }).catch(() => {});
    }
  }

  // Reward-zone evaluation per tick. Precedence inside rewardZoneStatus:
  //   /setmarket override → REST market.spreadThreshold/shareThreshold
  //   → env REWARD_ZONE_* default. Computed BEFORE checkFilter so
  //   requireXRewardGap filters can read it.
  const zone = rewardZoneStatus(
    orderbook,
    market,
    {
      maxDistance: config.rewardZoneMaxDistance,
      minSize: config.rewardZoneMinSize,
    },
    {
      maxDistance: effectiveOverride(state, marketId, 'rewardZoneMaxDistance', null),
      minSize: effectiveOverride(state, marketId, 'rewardZoneMinSize', null),
    },
  );
  slot.zoneStatus = {
    bidActivated: zone.bidActivated,
    askActivated: zone.askActivated,
    bidReason: zone.bidReason,
    askReason: zone.askReason,
    maxDistance: zone.maxDistance,
    minSize: zone.minSize,
  };

  // Filter is the LAST gate before alerting — record reason on the slot
  // so /status can tell "blocked by filter X" apart from "no data" / "no
  // reward" / "paused". Empty filterReason clears any stale 过滤器: tag.
  const filters = effectiveFilters(state);
  const filterReason = checkFilter(orderbook, filters, { zone });
  const filtered = filterReason !== null;
  slot.lastFilterReason = filterReason;
  if (filtered) {
    slot.lastSkipReason = `过滤器: ${filterReason}`;
  } else if (slot.lastSkipReason && slot.lastSkipReason.startsWith('过滤器:')) {
    slot.lastSkipReason = null;
  }

  const bidChanged = topMoved(slot.baseline.bidPrice, slot.baseline.bidSize, orderbook.bestBid);
  const askChanged = topMoved(slot.baseline.askPrice, slot.baseline.askSize, orderbook.bestAsk);

  const ctx = {
    state,
    slot,
    orderbook,
    marketId,
    market,
    totalHourlyRate,
    isPaused,
    filtered,
    filterReason,
    now,
    bidChanged,
    askChanged,
    zone,
    alert: (kind, slot, mid, msg, extra) => alert(state, kind, slot, mid, msg, extra),
    log,
  };

  for (const detect of DETECTORS) {
    try {
      await detect(ctx);
    } catch (err) {
      warn(`[${marketId}] detector ${detect.name} failed:`, err.message);
    }
  }

  // Stall detection lives here because of its baseline-reset coupling: a
  // book move resets the timer (and re-arms the alert), no move means the
  // standard stall check.
  if (bidChanged || askChanged) {
    log(
      `[${marketId}] book moved -> reset stall timer`,
      `bid ${slot.baseline.bidPrice}->${cur.bidPrice}`,
      `ask ${slot.baseline.askPrice}->${cur.askPrice}`,
    );
    appendHistory({
      event: 'move',
      marketId,
      title: slot.title,
      from: slot.baseline,
      to: cur,
      totalHourlyRate,
    }).catch(() => {});
    slot.baseline = cur;
    slot.lastChangeAt = now;
    slot.alerted = false;
    return;
  }

  await detectStall(ctx);
}
