import { config, isAllowedChat } from './config.js';
import {
  sendTelegramMessage,
  sendLongTelegramMessage,
  editTelegramMessage,
  htmlEscape,
  getUpdates,
  setMyCommands,
  answerCallbackQuery,
} from './telegram.js';
import { activeMarketIds } from './state.js';
import { fmtElapsed, rewardZoneStatus, midOf, spreadOf, shortTitle, marketLink } from './format.js';
import { effectiveFilters, formatFilters, FILTER_KEYS, FILTER_LABELS } from './filters.js';
import { getMarketRewardSummary, getOrderbook, resolveSlugToId, getCacheStats, refreshAllCaches } from './predict.js';
import { slugifyMarketTitle } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[commands]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[commands]', ...args);

// Commands shown in Telegram's blue "/" menu next to the input box.
// Main menu — kept tight (~18 commands) so the "/" autocomplete in
// Telegram is scannable. Advanced commands (setfilter / setmarket /
// scan / opportunities / list) still work but aren't surfaced here;
// /help lists everything.
const COMMAND_MENU = [
  { command: 'menu', description: '快捷菜单' },
  { command: 'status', description: '监控面板（市场数 + 总 PP/h + 空缺数）' },
  { command: 'find', description: '自定义筛选查询（卡片向导）' },
  { command: 'top', description: '当前所有有 PP 的市场（按 PP/h 排序）' },
  { command: 'gaps', description: '奖励区可激活（PP 待捡）' },
  { command: 'thin', description: '薄盘市场（买1+卖1 总额 < 阈值）' },
  { command: 'wide', description: '当前价差最大的市场' },
  { command: 'empty', description: '当前单边/空簿的市场' },
  { command: 'probe', description: '单个市场快照 (用法: /probe <id>)' },
  { command: 'watch', description: '密集追踪某市场 (用法: /watch <id>)' },
  { command: 'unwatch', description: '取消密集追踪' },
  { command: 'add', description: '加入监控 (用法: /add <id|slug|url>)' },
  { command: 'remove', description: '永久移除' },
  { command: 'pause', description: '静音指定市场' },
  { command: 'resume', description: '恢复监控' },
  { command: 'snooze', description: '临时静音 (用法: /snooze <id> 1h)' },
  { command: 'discover', description: '立即触发自动发现' },
  { command: 'refresh', description: '立即刷新 PP/h 缓存（显示耗时）' },
  { command: 'digest', description: '发送 24 小时摘要' },
  { command: 'help', description: '显示帮助（含进阶命令）' },
];

// Inline keyboard for /menu — quick-tap buttons that issue commands via
// callback_data. Each button label is short to fit on mobile.
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📡 状态', callback_data: '/status' },
        { text: '🔥 PP/h 榜', callback_data: '/top' },
      ],
      [
        { text: '🎯 空缺榜', callback_data: '/gaps' },
        { text: '💧 薄盘榜', callback_data: '/thin' },
      ],
      [
        { text: '📏 价差榜', callback_data: '/wide' },
        { text: '🌊 空簿榜', callback_data: '/empty' },
      ],
      [
        { text: '🔍 自定义筛选', callback_data: '/find' },
      ],
      [
        { text: '⚡ 刷新 PP', callback_data: '/refresh' },
        { text: '🔄 立即发现', callback_data: '/discover' },
        { text: '📈 24h 摘要', callback_data: '/digest' },
      ],
      [
        { text: '❓ 帮助', callback_data: '/help' },
      ],
    ],
  };
}

// Inline keyboard attached to alert messages so the user can act
// straight from the alert push without typing.
export function alertKeyboard(marketId) {
  const id = String(marketId);
  return {
    inline_keyboard: [
      [
        { text: '🔎 快照', callback_data: `/probe ${id}` },
        { text: '👁 追踪', callback_data: `/watch ${id}` },
      ],
      [
        { text: '😴 静音1h', callback_data: `/snooze ${id} 1h` },
        { text: '⏸ 永久静音', callback_data: `/pause ${id}` },
      ],
      [
        { text: '📊 状态', callback_data: '/status' },
        { text: '🎯 空缺榜', callback_data: '/gaps' },
      ],
    ],
  };
}

// --- /find wizard: card-style filter picker ---
const WIZARD_RATES = [0, 100, 500, 1000, 3000];
const WIZARD_REMS = [1, 4, 12, 24, 72];
const WIZARD_LIMITS = [20, 50, 100, 200];

function fmtRateShort(r) {
  if (r >= 1000) return `${(r / 1000).toFixed(0)}k`;
  return String(r);
}

function findWizardText(rate, rem, limit) {
  return [
    '🔍 <b>自定义筛选</b>',
    '',
    `📊 PP/h ≥ <b>${rate}</b>`,
    `⏱ 剩余 ≥ <b>${rem}h</b>`,
    `📦 上限 <b>${limit}</b>`,
    '',
    '点按钮调整 → 🚀 查询（不改 watchlist）',
    '或 🔄 应用监控（替换 watchlist）',
  ].join('\n');
}

function findWizardKeyboard(rate, rem, limit) {
  const mark = (active, label) => active ? `✅ ${label}` : label;
  return {
    inline_keyboard: [
      // PP/h row — short numeric labels (row context shown in message body)
      WIZARD_RATES.map((r) => ({
        text: mark(r === rate, fmtRateShort(r)),
        callback_data: `find:set:${r}:${rem}:${limit}`,
      })),
      // Remaining hours row
      WIZARD_REMS.map((m) => ({
        text: mark(m === rem, `${m}h`),
        callback_data: `find:set:${rate}:${m}:${limit}`,
      })),
      // Limit row
      WIZARD_LIMITS.map((l) => ({
        text: mark(l === limit, String(l)),
        callback_data: `find:set:${rate}:${rem}:${l}`,
      })),
      // Action row
      [
        { text: '🚀 查询', callback_data: `find:run:${rate}:${rem}:${limit}` },
        { text: '🔄 应用监控', callback_data: `find:scan:${rate}:${rem}:${limit}` },
      ],
    ],
  };
}

// Run the actual filter query against the cached market list. Used by
// both the /find wizard's "Run" button and the /find <args> CLI form.
async function runFilterQuery(minRate, minRem, limit, mode, state, ctx) {
  const { getAllMarketsCached, extractHourlyRate, isMarketTradeable, marketEndMs } =
    await import('./predict.js');
  let all;
  try {
    all = await getAllMarketsCached();
  } catch (err) {
    return { text: `市场列表获取失败: ${htmlEscape(err.message)}` };
  }
  const cutoff = minRem > 0 ? Date.now() + minRem * 3600000 : null;
  const matches = [];
  for (const m of all) {
    if (!isMarketTradeable(m)) continue;
    const rate = extractHourlyRate(m);
    if (rate < minRate) continue;
    if (cutoff) {
      const endMs = marketEndMs(m);
      if (endMs != null && endMs < cutoff) continue;
    }
    matches.push({
      id: String(m.id),
      title: m.title ?? m.question ?? null,
      rate,
      endMs: marketEndMs(m),
    });
  }
  matches.sort((a, b) => b.rate - a.rate);
  const top = matches.slice(0, limit);

  if (mode === 'scan') {
    state.autoIds = top.map((x) => x.id);
    state.lastDiscoveryAt = Date.now();
    if (ctx?.persist) await ctx.persist();
  }

  if (!matches.length) {
    return { text: `没有匹配的市场（PP/h ≥ ${minRate}, 剩余 ≥ ${minRem}h）。试试 /find 0 1` };
  }

  const verb = mode === 'scan'
    ? `🔄 已替换 watchlist (${top.length} 个)`
    : `🔍 找到 ${matches.length} 个`;
  const note = matches.length > top.length ? `，显示前 ${top.length}` : '';
  const lines = [
    `${verb}${note}`,
    `条件: PP/h ≥ <b>${minRate}</b> · 剩余 ≥ <b>${minRem}h</b>`,
    '',
  ];
  for (const [idx, m] of top.entries()) {
    const medal = idx < 3 ? ['🥇', '🥈', '🥉'][idx] : `${idx + 1}.`;
    const title = htmlEscape(shortTitle(m.title ?? `Market ${m.id}`, 42));
    const remH = m.endMs ? Math.max(0, (m.endMs - Date.now()) / 3600000) : null;
    const ext = remH != null
      ? ` · ${remH < 24 ? remH.toFixed(1) + 'h' : (remH / 24).toFixed(1) + 'd'}≈${fmtBig(m.rate * remH)}PP`
      : '';
    lines.push(`${medal} <code>#${m.id}</code> ${title} — <b>${m.rate.toFixed(0)}/h</b>${ext}`);
  }
  if (mode === 'find') {
    lines.push('');
    lines.push('用 /add &lt;id&gt; 单独加 · /scan 同参数 = 全部加入 watchlist');
  }
  return { text: lines.join('\n') };
}

// Handle find:set / find:run / find:scan callback_data from the wizard.
// Returns true if handled (so the dispatcher skips normal command routing).
export async function handleFindWizardCallback(data, { chatId, messageId, state, fullCtx }) {
  // data shape: find:<action>:<rate>:<rem>:<limit>
  const parts = data.split(':');
  if (parts[0] !== 'find') return false;
  const [, action, rateStr, remStr, limitStr] = parts;
  const rate = Number(rateStr ?? 0);
  const rem = Number(remStr ?? 12);
  const limit = Math.min(Number(limitStr ?? 50), 200);
  if (!Number.isFinite(rate) || !Number.isFinite(rem) || !Number.isFinite(limit)) return true;

  if (action === 'set') {
    // Re-render the wizard with updated highlight
    try {
      await editTelegramMessage(
        chatId,
        messageId,
        findWizardText(rate, rem, limit),
        findWizardKeyboard(rate, rem, limit),
      );
    } catch (err) {
      // Telegram returns 400 if the new content is identical; safe to ignore.
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn('wizard edit failed:', err.message);
      }
    }
    return true;
  }
  if (action === 'run' || action === 'scan') {
    const result = await runFilterQuery(rate, rem, limit, action, state, fullCtx);
    await sendLongTelegramMessage(result.text, { chatId });
    return true;
  }
  return true; // unknown find:* — swallow
}

const HELP = [
  '<b>核心</b>',
  '/menu — 快捷按钮菜单',
  '/status — 监控面板（市场数 + 总 PP/h + 空缺数）',
  '/find — 自定义筛选（卡片向导）',
  '/probe &lt;id&gt; — 单个市场快照',
  '',
  '<b>排行榜</b>（支持翻页）',
  '/top — 所有有 PP 的市场（按 PP/h 排序）',
  '/gaps — 奖励区可激活（PP 待捡）',
  '/thin — 薄盘市场（买1+卖1 总额 &lt; 阈值）',
  '/wide — 当前价差最大',
  '/empty — 单边/空簿',
  '',
  '<b>市场管理</b>',
  '/add &lt;id|slug|url&gt; — 加入监控',
  '/remove &lt;id&gt; — 永久移除',
  '/pause &lt;id&gt; — 静音',
  '/resume &lt;id&gt; — 取消静音',
  '/snooze &lt;id&gt; &lt;30m|2h|1d&gt; — 临时静音',
  '/watch &lt;id&gt; — 密集追踪',
  '/unwatch &lt;id|all&gt; — 取消密集追踪',
  '',
  '<b>批量 / 维护</b>',
  '/discover — 立即触发自动发现',
  '/refresh — 立即刷新 PP/h 缓存（显示耗时）',
  '/digest — 立即发送 24h 摘要',
  '/scan &lt;minRate&gt; &lt;minRem&gt; — 自定义筛选 + 替换 watchlist',
  '',
  '<b>进阶</b>',
  '/opportunities — 机会评分（实验）',
  '/setmarket &lt;id&gt; &lt;key&gt; &lt;value&gt; — 市场专属阈值',
  '/clearmarket &lt;id&gt; — 清除覆盖',
  '/filter — 查看当前过滤器',
  '/setfilter &lt;name&gt; &lt;value&gt; — 设置过滤器（如 minBid1Price 0.05）',
  '/clearfilter &lt;name|all&gt; — 清除过滤器',
  '过滤器字段: min/max + Bid/Ask + 1/2/3 + Price/Size',
  '',
  '/help — 本帮助',
].join('\n');

function uniq(arr) {
  return [...new Set(arr.map(String))];
}

// Accept a numeric id, a URL like https://predict.fun/<lang>/market/<slug>,
// or a bare slug. Returns { id, slug, kind } where kind is 'id' | 'slug'.
function parseMarketInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const urlMatch = s.match(/\/market\/([^/?#]+)/);
  if (urlMatch) s = urlMatch[1];
  if (/^\d+$/.test(s)) return { id: s, slug: null, kind: 'id' };
  // basic slug shape
  if (/^[a-z0-9][a-z0-9-]{1,120}$/i.test(s)) return { id: null, slug: s.toLowerCase(), kind: 'slug' };
  return null;
}

async function resolveMarketInput(raw) {
  const parsed = parseMarketInput(raw);
  if (!parsed) return { error: '无法识别为 marketId / slug / URL' };
  if (parsed.kind === 'id') return { id: parsed.id };
  // slug -> id (scans GraphQL market list and matches slugify(title))
  try {
    const id = await resolveSlugToId(parsed.slug, slugifyMarketTitle);
    if (!id) {
      return { error: `找不到 slug "${parsed.slug}"（市场可能不在 PP-rewarded 列表里，或已 resolve）。试试用数字 id 直接 /add。` };
    }
    return { id };
  } catch (err) {
    return { error: `slug 解析失败: ${err.message}` };
  }
}

// Parse a duration like "30m", "2h", "1d" into milliseconds.
function parseDuration(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  if (!mult) return null;
  return n * mult;
}

// Snapshot helpers — these read from state.markets which is updated each
// tick, so list/* commands return whatever the last poll captured.
function listMarketsSnapshot(state) {
  const ids = activeMarketIds(state);
  return ids
    .map((id) => ({ id, slot: state.markets[id] }))
    .filter((x) => !!x.slot);
}

function fmtMarketLine(id, slot, extra) {
  const title = slot.title ? slot.title.slice(0, 50) : `Market ${id}`;
  const rate = Number.isFinite(slot.lastHourlyRate) ? slot.lastHourlyRate.toFixed(0) : '?';
  const e = extra ? ` · ${extra}` : '';
  return `#${id} ${title} — ${rate}/h${e}`;
}

// Opportunity score = PP/h × zone-gap-multiplier × spread-friendliness.
// Higher = better target to make markets on.
function opportunityScore(slot) {
  const rate = slot.lastHourlyRate ?? 0;
  if (!rate) return 0;
  const z = slot.zoneStatus;
  let mult = 1;
  if (z) {
    if (!z.bidActivated) mult += 1;
    if (!z.askActivated) mult += 1;
  }
  // Tighter spread = more attractive (closer to picking up rewards).
  const bid = slot.baseline?.bidPrice;
  const ask = slot.baseline?.askPrice;
  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    const spread = ask - bid;
    if (spread > 0 && spread < 0.5) mult *= (1 + (0.5 - spread));
  }
  return rate * mult;
}

async function buildProbeMessage(marketId) {
  const summary = await getMarketRewardSummary(marketId);
  if (!summary.market) {
    return `未找到市场 #${htmlEscape(marketId)}（不在 REST 列表里，可能 id 错了或已 resolve）。`;
  }
  const m = summary.market;
  let ob;
  try {
    ob = await getOrderbook(summary.orderbookKey, { contextMarketId: marketId, market: m });
  } catch (err) {
    return `订单簿抓取失败: ${htmlEscape(err.message)}`;
  }
  const mid = midOf(ob);
  const spread = spreadOf(ob);
  const zone = rewardZoneStatus(ob, m, {
    maxDistance: config.rewardZoneMaxDistance,
    minSize: config.rewardZoneMinSize,
  });
  // Probe builds a fresh link from the live market — pull a real slug
  // from the same REST cache the monitor uses (best effort).
  let realSlug = null;
  try {
    const { getSlugMapCached } = await import('./predict.js');
    const slugMap = await getSlugMapCached();
    realSlug = slugMap?.get(String(marketId)) ?? null;
  } catch {}
  const lines = [
    marketLink(marketId, m.title, m.question, realSlug),
    `<code>#${htmlEscape(marketId)}</code> · PP/h: <b>${summary.totalHourlyRate.toFixed(2)}</b> · status: ${htmlEscape(String(m.status ?? m.tradingStatus ?? '?'))}`,
  ];
  lines.push('');
  lines.push('<b>买盘</b>');
  if (!ob.bids.length) lines.push('  (空)');
  for (let i = 0; i < ob.bids.length; i++) {
    const b = ob.bids[i];
    lines.push(`  买${i + 1}: ${b.price.toFixed(4)} × ${b.size}`);
  }
  lines.push('<b>卖盘</b>');
  if (!ob.asks.length) lines.push('  (空)');
  for (let i = 0; i < ob.asks.length; i++) {
    const a = ob.asks[i];
    lines.push(`  卖${i + 1}: ${a.price.toFixed(4)} × ${a.size}`);
  }
  lines.push('');
  lines.push(`mid: ${mid != null ? mid.toFixed(4) : 'n/a'}  ·  spread: ${spread != null ? `${(spread * 100).toFixed(2)}¢` : 'n/a'}`);
  lines.push(`奖励区: ±${(zone.maxDistance * 100).toFixed(1)}¢ / size ≥ ${zone.minSize}`);
  lines.push(`  买侧: ${zone.bidActivated ? '✓ 激活' : `✗ ${htmlEscape(zone.bidReason ?? '未激活')}`}`);
  lines.push(`  卖侧: ${zone.askActivated ? '✓ 激活' : `✗ ${htmlEscape(zone.askReason ?? '未激活')}`}`);
  return lines.join('\n');
}

function zoneTag(slot) {
  const z = slot?.zoneStatus;
  if (!z) return '';
  if (z.bidActivated && z.askActivated) return ' · 区内✓';
  const sides = [];
  if (!z.bidActivated) sides.push('买✗');
  if (!z.askActivated) sides.push('卖✗');
  return ` · 区外(${sides.join(',')})`;
}

// Format a number as "1.2k" / "12k" / "3.4M" for compact PP totals.
function fmtBig(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

function fmtRemaining(endMs) {
  if (!endMs) return null;
  const h = (endMs - Date.now()) / 3600000;
  if (h <= 0) return '已结束';
  if (h >= 48) return `${(h / 24).toFixed(1)}d`;
  return `${h.toFixed(1)}h`;
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  const remM = min % 60;
  return remM > 0 ? `${h} 小时 ${remM} 分前` : `${h} 小时前`;
}

function fmtIn(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '即将';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒后`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分后`;
  const h = Math.floor(min / 60);
  const remM = min % 60;
  return remM > 0 ? `${h} 小时 ${remM} 分后` : `${h} 小时后`;
}

// "Last refreshed" panel for /status and list views.
// Surfaces the three cadences a user should know about:
//   - PP/h cache (GraphQL markets list, MARKETS_CACHE_TTL_MS)
//   - autodiscover (DISCOVERY_INTERVAL_MS)
//   - last orderbook tick (POLL_INTERVAL_MS, max lastSeenAt across slots)
function freshnessLines(state, { compact = false } = {}) {
  const now = Date.now();
  const lines = [];
  let stats;
  try { stats = getCacheStats(); } catch { stats = null; }
  if (stats?.marketsAt) {
    const ago = now - stats.marketsAt;
    const next = stats.marketsTtlMs - ago;
    if (compact) {
      lines.push(`PP/h 缓存 ${fmtAgo(ago)} (下次 ${fmtIn(next)})`);
    } else {
      lines.push(`💰 <b>PP/h 缓存</b>: ${fmtAgo(ago)} · 下次 ${fmtIn(next)} · ${stats.marketsCount} 个市场`);
    }
  }
  const lastDisc = state.lastDiscoveryAt ?? 0;
  if (lastDisc) {
    const ago = now - lastDisc;
    const next = (config.discoveryIntervalMs ?? 0) - ago;
    if (compact) {
      lines.push(`自动发现 ${fmtAgo(ago)}`);
    } else {
      lines.push(`🔄 <b>自动发现</b>: ${fmtAgo(ago)} · 下次 ${fmtIn(next)}`);
    }
  }
  let maxSeen = 0;
  for (const slot of Object.values(state.markets ?? {})) {
    if (slot?.lastSeenAt > maxSeen) maxSeen = slot.lastSeenAt;
  }
  if (maxSeen) {
    const ago = now - maxSeen;
    if (compact) {
      lines.push(`最近 tick ${fmtAgo(ago)}`);
    } else {
      const interval = Math.round(config.pollIntervalMs / 60_000);
      lines.push(`📡 <b>最近 tick</b>: ${fmtAgo(ago)} · 每 ${interval} 分一次`);
    }
  }
  return lines;
}

function compactMarketRow(id, slot, extra = '') {
  // Always render as a link — even with no title/question the marketLink
  // helper falls back to "Market <id>" with a /market/<id> URL, so the
  // user can still click through.
  const linked = marketLink(id, slot?.title, slot?.question, slot?.slug);
  const rate = Number.isFinite(slot?.lastHourlyRate)
    ? `${slot.lastHourlyRate.toFixed(0)}/h`
    : '?/h';
  const suffix = extra ? ` · ${htmlEscape(extra)}` : '';
  return `<code>#${htmlEscape(id)}</code> ${linked} — <b>${rate}</b>${suffix}`;
}

// --- Pagination helpers for /top /gaps /wide /empty /opportunities ---
const PAGE_SIZE = 10;

function pageKeyboard(cmd, page, totalPages) {
  if (totalPages <= 1) return undefined;
  const buttons = [];
  if (page > 0) buttons.push({ text: '⬅️ 上一页', callback_data: `page:${cmd}:${page - 1}` });
  buttons.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'page:noop' });
  if (page < totalPages - 1) buttons.push({ text: '➡️ 下一页', callback_data: `page:${cmd}:${page + 1}` });
  return { inline_keyboard: [buttons] };
}

// Edit-in-place callback handler for page:* buttons.
export async function handlePageCallback(data, { chatId, messageId, state, fullCtx }) {
  if (!data.startsWith('page:')) return false;
  const [, cmd, pageStr] = data.split(':');
  if (cmd === 'noop') return true; // page indicator button
  const page = Number(pageStr);
  if (!Number.isFinite(page) || page < 0) return true;
  // Re-run the list command at the requested page and edit the message.
  const reply = await renderListPage(cmd, page, state);
  if (!reply) return true;
  try {
    await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
  } catch (err) {
    if (!/message is not modified/i.test(err.message ?? '')) {
      warn(`page edit failed for ${cmd}:`, err.message);
    }
  }
  return true;
}

function paginate(rows, page) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  return { items: rows.slice(start, start + PAGE_SIZE), page: safePage, totalPages };
}

function renderListPage(cmd, page, state) {
  const allRows = listMarketsSnapshot(state);
  let rows = [];
  let header = '';
  let extraFn = null;
  switch (cmd) {
    case 'top':
      rows = allRows
        .filter(({ slot }) => !slot.lastError && Number.isFinite(slot.lastHourlyRate) && slot.lastHourlyRate > 0)
        .sort((a, b) => b.slot.lastHourlyRate - a.slot.lastHourlyRate);
      header = '<b>🔥 PP/h Top</b>';
      break;
    case 'gaps':
      rows = allRows
        .filter(({ slot }) => !slot.lastError && slot.zoneStatus
          && (!slot.zoneStatus.bidActivated || !slot.zoneStatus.askActivated))
        .sort((a, b) => (b.slot.lastHourlyRate ?? 0) - (a.slot.lastHourlyRate ?? 0));
      header = '<b>🎯 奖励区有空缺（未激活）</b>';
      extraFn = (slot) => {
        const sides = [];
        if (!slot.zoneStatus.bidActivated) sides.push('买✗');
        if (!slot.zoneStatus.askActivated) sides.push('卖✗');
        return sides.join(',');
      };
      break;
    case 'wide':
      rows = allRows
        .filter(({ slot }) => !slot.lastError)
        .map(({ id, slot }) => {
          const bid = slot.baseline?.bidPrice;
          const ask = slot.baseline?.askPrice;
          const spread = (Number.isFinite(bid) && Number.isFinite(ask)) ? ask - bid : null;
          return { id, slot, spread };
        })
        .filter((x) => Number.isFinite(x.spread))
        .sort((a, b) => b.spread - a.spread);
      header = '<b>📏 价差最大</b>';
      extraFn = (_slot, row) => `spread ${(row.spread * 100).toFixed(2)}¢`;
      break;
    case 'empty':
      rows = allRows.filter(({ slot }) => !slot.lastError && slot.baseline
        && (slot.baseline.bidPrice == null || slot.baseline.askPrice == null));
      header = '<b>🌊 单边/空簿</b>';
      extraFn = (slot) => {
        const sides = [];
        if (slot.baseline?.bidPrice == null) sides.push('无买');
        if (slot.baseline?.askPrice == null) sides.push('无卖');
        return sides.join(',');
      };
      break;
    case 'thin': {
      // Markets where best-bid + best-ask top-of-book total $ value is
      // ≤ LOW_DEPTH_THRESHOLD. Sort thinnest first so the lowest-effort
      // opportunities float to the top of the list.
      const threshold = config.lowDepthThreshold;
      rows = allRows
        .filter(({ slot }) => !slot.lastError && slot.baseline
          && Number.isFinite(slot.baseline.bidPrice) && Number.isFinite(slot.baseline.bidSize)
          && Number.isFinite(slot.baseline.askPrice) && Number.isFinite(slot.baseline.askSize))
        .map(({ id, slot }) => {
          const bidVal = slot.baseline.bidPrice * slot.baseline.bidSize;
          const askVal = slot.baseline.askPrice * slot.baseline.askSize;
          const total = bidVal + askVal;
          return { id, slot, total, bidVal, askVal };
        })
        .filter((r) => r.total <= threshold)
        .sort((a, b) => a.total - b.total);
      header = `<b>💧 薄盘 (买1+卖1 总额 ≤ $${threshold})</b>`;
      extraFn = (_slot, row) => `$${row.total.toFixed(0)} (买$${row.bidVal.toFixed(0)} + 卖$${row.askVal.toFixed(0)})`;
      break;
    }
    case 'opp':
    case 'opportunities':
      rows = allRows
        .filter(({ slot }) => !slot.lastError)
        .map(({ id, slot }) => ({ id, slot, score: opportunityScore(slot) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      header = '<b>💎 机会评分</b> (PP × 缺口 × 价差)';
      extraFn = (_slot, row) => `score ${row.score.toFixed(0)}`;
      break;
    default:
      return null;
  }
  if (!rows.length) {
    return { text: `${header}\n\n暂无匹配市场。` };
  }
  const { items, page: safePage, totalPages } = paginate(rows, page);
  const lines = [`${header} <i>(${items.length} / ${rows.length})</i>`, ''];
  for (const row of items) {
    const extra = extraFn ? extraFn(row.slot, row) : '';
    lines.push(compactMarketRow(row.id, row.slot, extra));
  }
  // Compact freshness footer so the user knows how stale the data is.
  const fresh = freshnessLines(state, { compact: true });
  if (fresh.length) {
    lines.push('');
    lines.push(`<i>📅 ${fresh.join(' · ')}</i>`);
  }
  return {
    text: lines.join('\n'),
    replyMarkup: pageKeyboard(cmd, safePage, totalPages),
  };
}

async function buildStatusDashboard(state) {
  const ids = activeMarketIds(state);
  if (!ids.length) {
    return '当前没有监控的市场。用 /add &lt;id&gt; 加一个，或开启 AUTODISCOVER=true。';
  }
  const rows = ids.map((id) => ({ id, slot: state.markets[id] }));
  const errors = rows.filter(({ slot }) => slot?.lastError);
  const skipped = rows.filter(({ slot }) => slot?.lastSkipReason);
  const waiting = rows.filter(({ slot }) => !slot);
  const paused = rows.filter(({ id }) => state.pausedIds.includes(id));
  const watched = rows.filter(({ id }) => (state.watchedIds ?? []).includes(id));
  const gaps = rows.filter(({ slot }) =>
    slot?.zoneStatus
    && !slot.lastError
    && !slot.lastSkipReason
    && (!slot.zoneStatus.bidActivated || !slot.zoneStatus.askActivated)
  );
  const ppRows = rows
    .filter(({ slot }) => slot && !slot.lastError && !slot.lastSkipReason && Number.isFinite(slot.lastHourlyRate) && slot.lastHourlyRate > 0)
    .sort((a, b) => b.slot.lastHourlyRate - a.slot.lastHourlyRate);
  // PP/h sum across all rewarded markets currently in the watchlist —
  // this is the pool the user is collectively monitoring.
  const totalRate = ppRows.reduce((acc, { slot }) => acc + slot.lastHourlyRate, 0);

  let totalPP24h = null;
  try {
    const { readHistorySince, summarize24h } = await import('./history.js');
    const since = Date.now() - 24 * 3600 * 1000;
    const records = await readHistorySince(since);
    const summary = summarize24h(records);
    totalPP24h = summary.reduce((a, m) => a + (m.ppEarned ?? 0), 0);
  } catch {}

  const lines = [
    '📡 <b>监控面板</b>',
    `💰 <b>${ppRows.length}</b> 个有奖励市场 · 总 <b>${totalRate.toFixed(0)}</b> PP/h`,
    `🎯 <b>${gaps.length}</b> 个奖励区有空缺（未激活）`,
  ];
  // Smaller second line for everything else (only show non-zero buckets)
  const meta = [];
  if (errors.length) meta.push(`⚠ 错误 ${errors.length}`);
  if (skipped.length) meta.push(`⏭ 跳过 ${skipped.length}`);
  if (waiting.length) meta.push(`⏳ 等待 ${waiting.length}`);
  if (paused.length) meta.push(`⏸ 暂停 ${paused.length}`);
  if (watched.length) meta.push(`👁 追踪 ${watched.length}`);
  if (totalPP24h != null && totalPP24h > 0) meta.push(`📈 24h PP ${totalPP24h.toFixed(0)}`);
  if (meta.length) lines.push(meta.join(' · '));
  lines.push('');

  if (errors.length) {
    lines.push('⚠️ <b>错误</b>');
    for (const { id, slot } of errors.slice(0, 8)) {
      lines.push(compactMarketRow(id, slot, slot.lastError));
    }
    if (errors.length > 8) lines.push(`……还有 ${errors.length - 8} 个错误市场`);
    lines.push('');
  }

  if (gaps.length) {
    lines.push('🎯 <b>奖励区空缺 (PP 待捡)</b>');
    const sorted = gaps.sort((a, b) => (b.slot.lastHourlyRate ?? 0) - (a.slot.lastHourlyRate ?? 0));
    for (const { id, slot } of sorted.slice(0, 10)) {
      const sides = [];
      if (!slot.zoneStatus.bidActivated) sides.push('买✗');
      if (!slot.zoneStatus.askActivated) sides.push('卖✗');
      lines.push(compactMarketRow(id, slot, sides.join(',')));
    }
    if (gaps.length > 10) lines.push(`……还有 ${gaps.length - 10} 个空缺市场`);
    lines.push('');
  }

  if (ppRows.length) {
    lines.push('🔥 <b>PP/h Top</b>');
    for (const { id, slot } of ppRows.slice(0, 10)) {
      const since = slot.lastChangeAt ? `停滞 ${fmtElapsed(Date.now() - slot.lastChangeAt)}` : '';
      lines.push(compactMarketRow(id, slot, since));
    }
  }

  lines.push('');
  const fresh = freshnessLines(state, { compact: false });
  if (fresh.length) {
    lines.push('<b>📅 数据新鲜度</b>');
    for (const f of fresh) lines.push(f);
    lines.push('');
  }
  lines.push('更多: /top /gaps /thin /wide /empty');

  return lines.join('\n');
}

function statusLine(state, id) {
  const slot = state.markets[id];
  const paused = state.pausedIds.includes(id);
  const watched = (state.watchedIds ?? []).includes(id);
  const snoozeUntil = state.snoozes?.[id];
  const isSnoozed = snoozeUntil && snoozeUntil > Date.now();
  const tags = [
    paused ? 'paused' : '',
    isSnoozed ? 'snoozed' : '',
    watched ? 'watch' : '',
  ].filter(Boolean);
  const tag = tags.length ? ` [${tags.join(',')}]` : '';
  const title = slot?.title ? slot.title.slice(0, 40) : `Market ${id}`;
  if (!slot) return `#${id}${tag} ${title} — 等待首次抓取`;
  if (slot.lastError) return `#${id}${tag} ${title} — ⚠ ${slot.lastError}`;
  if (slot.lastSkipReason) return `#${id}${tag} ${title} — ⏭ ${slot.lastSkipReason}`;
  if (slot.lastChangeAt == null) return `#${id}${tag} ${title} — 等待首次抓取`;
  const since = Date.now() - slot.lastChangeAt;
  const rate = Number.isFinite(slot.lastHourlyRate) ? slot.lastHourlyRate.toFixed(0) : '?';

  // Remaining time + estimated total PP available for the rest of the market.
  let timeBadge = '';
  if (slot.endMs && Number.isFinite(slot.lastHourlyRate)) {
    const rem = fmtRemaining(slot.endMs);
    const remH = Math.max(0, (slot.endMs - Date.now()) / 3600000);
    const totalPP = slot.lastHourlyRate * remH;
    timeBadge = ` · 余${rem}≈${fmtBig(totalPP)}PP`;
  } else if (slot.endMs) {
    timeBadge = ` · 余${fmtRemaining(slot.endMs)}`;
  }

  return `#${id}${tag} ${title} — 停滞 ${fmtElapsed(since)} · ${rate}/h${timeBadge}${zoneTag(slot)}`;
}

async function handle(text, state, ctx) {
  const [raw, ...rest] = text.trim().split(/\s+/);
  if (!raw) return null;
  const cmd = raw.replace(/@\w+$/, '').toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start':
    case '/menu':
      return { text: '<b>快捷菜单</b> — 点按钮或直接输入命令', replyMarkup: menuKeyboard() };

    case '/help':
      return HELP;

    case '/status':
      return await buildStatusDashboard(state);

    case '/add': {
      if (!arg) return '用法：/add &lt;marketId | slug | URL&gt;\n例：/add 241373\n或：/add will-jesus-christ-return-before-2027\n或：/add https://predict.fun/zh-cn/market/...';
      const resolved = await resolveMarketInput(arg);
      if (resolved.error) return htmlEscape(resolved.error);
      const id = resolved.id;
      state.manualIds = uniq([...state.manualIds, id]);
      state.removedIds = state.removedIds.filter((x) => x !== id);
      await ctx.persist();
      return `已加入 #${htmlEscape(id)}`;
    }

    case '/remove': {
      if (!arg) return '用法：/remove &lt;marketId&gt;';
      state.manualIds = state.manualIds.filter((x) => x !== arg);
      state.autoIds = state.autoIds.filter((x) => x !== arg);
      state.removedIds = uniq([...state.removedIds, arg]);
      delete state.markets[arg];
      await ctx.persist();
      return `已移除 #${htmlEscape(arg)}`;
    }

    case '/pause': {
      if (!arg) return '用法：/pause &lt;marketId&gt;';
      state.pausedIds = uniq([...state.pausedIds, arg]);
      await ctx.persist();
      return `已静音 #${htmlEscape(arg)}`;
    }

    case '/resume': {
      if (!arg) return '用法：/resume &lt;marketId&gt;';
      state.pausedIds = state.pausedIds.filter((x) => x !== arg);
      await ctx.persist();
      return `已恢复 #${htmlEscape(arg)}`;
    }

    case '/discover': {
      ctx.requestDiscovery();
      return '已触发自动发现，几分钟内完成。';
    }

    case '/refresh': {
      // Force-invalidate the PP/h cache + slug cache + per-market REST
      // cache, then refetch. Reports elapsed time so the user knows
      // how long a full GraphQL/REST scan actually takes on their host.
      const result = await refreshAllCaches();
      const sec = (result.elapsedMs / 1000).toFixed(1);
      const lines = [
        `🔄 <b>缓存已刷新</b> (耗时 ${sec}s)`,
        `💰 PP/h 数据: ${result.marketsCount} 个市场`,
        `🔗 URL slug 缓存: ${result.slugCount} 个`,
      ];
      if (result.error) lines.push(`⚠ 部分失败: ${htmlEscape(result.error)}`);
      lines.push('');
      lines.push('下次 tick (5 分内) 将用最新数据。');
      return lines.join('\n');
    }

    case '/find':
    case '/scan': {
      const parts = arg.split(/\s+/).filter(Boolean);
      // No args + /find -> show interactive wizard with default state
      if (cmd === '/find' && parts.length === 0) {
        const defaultRem = Math.min(72, Math.max(1, config.minRemainingHours ?? 12));
        return {
          text: findWizardText(0, defaultRem, 50),
          replyMarkup: findWizardKeyboard(0, defaultRem, 50),
        };
      }
      const minRate = parts[0] != null ? Number(parts[0]) : 0;
      const minRem = parts[1] != null ? Number(parts[1]) : (config.minRemainingHours ?? 12);
      const limit = Math.min(parts[2] != null ? Number(parts[2]) : 50, 200);
      if (!Number.isFinite(minRate) || !Number.isFinite(minRem) || !Number.isFinite(limit)) {
        return '用法: /find [minRate] [minRem 小时] [limit]\n例: /find 500 12 30\n  /scan 同样参数，但会替换 watchlist\n  /find （无参数）= 交互式向导';
      }
      const result = await runFilterQuery(minRate, minRem, limit, cmd === '/scan' ? 'scan' : 'find', state, ctx);
      return result.text;
    }

    case '/digest': {
      ctx.requestDigest();
      return '已触发 24 小时摘要。';
    }

    case '/top':
    case '/gaps':
    case '/thin':
    case '/wide':
    case '/empty':
    case '/opportunities':
    case '/opp': {
      const cmdName = cmd === '/opportunities' ? 'opp' : cmd.slice(1);
      // Optional integer arg = page number (1-indexed for the user)
      const page = Math.max(1, Number(arg) || 1) - 1;
      const reply = renderListPage(cmdName, page, state);
      if (!reply) return '未知命令';
      return reply;
    }

    case '/snooze': {
      const [id, durStr] = arg.split(/\s+/);
      if (!id || !durStr) return '用法：/snooze &lt;id&gt; &lt;duration&gt;\n例：/snooze 257916 1h, /snooze 257916 30m';
      const ms = parseDuration(durStr);
      if (!ms) return `无法解析时长 "${htmlEscape(durStr)}"，支持 30m / 2h / 1d`;
      state.snoozes = { ...(state.snoozes ?? {}), [id]: Date.now() + ms };
      await ctx.persist();
      return `已临时静音 #${htmlEscape(id)} ${htmlEscape(durStr)}（到 ${new Date(state.snoozes[id]).toISOString()}）`;
    }

    case '/setmarket': {
      const [id, key, value] = arg.split(/\s+/);
      if (!id || !key || value == null || value === '') {
        return '用法：/setmarket &lt;id&gt; &lt;key&gt; &lt;value&gt;\n可用 key: staleHours, maxSpread, midJumpThreshold, rewardZoneMaxDistance, rewardZoneMinSize, wideSpreadMinMinutes, rewardZoneMinMinutes, emptyBookMinMinutes';
      }
      const allowed = new Set([
        'staleHours',
        'maxSpread',
        'midJumpThreshold',
        'rewardZoneMaxDistance',
        'rewardZoneMinSize',
        'wideSpreadMinMinutes',
        'rewardZoneMinMinutes',
        'emptyBookMinMinutes',
      ]);
      if (!allowed.has(key)) return `未知 key "${htmlEscape(key)}"，可用: ${[...allowed].join(', ')}`;
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return `值必须是正数，收到 "${htmlEscape(value)}"`;
      state.overrides = { ...(state.overrides ?? {}) };
      state.overrides[id] = { ...(state.overrides[id] ?? {}), [key]: v };
      await ctx.persist();
      return `已为 #${htmlEscape(id)} 设置 ${htmlEscape(key)}=${v}`;
    }

    case '/clearmarket': {
      if (!arg) return '用法：/clearmarket &lt;id&gt;';
      if (state.overrides) delete state.overrides[arg];
      await ctx.persist();
      return `已清除 #${htmlEscape(arg)} 的所有覆盖`;
    }

    case '/filter': {
      const eff = effectiveFilters(state);
      return `<b>当前过滤器</b>\n${formatFilters(eff, state)}`;
    }

    case '/setfilter': {
      const [name, ...rest] = arg.split(/\s+/);
      const valueStr = rest.join(' ').trim();
      if (!name || !valueStr) {
        return `用法：/setfilter &lt;name&gt; &lt;value&gt;\n字段: ${FILTER_KEYS.join(', ')}`;
      }
      if (!FILTER_KEYS.includes(name)) {
        return `未知字段 "${htmlEscape(name)}"。可用: ${FILTER_KEYS.join(', ')}`;
      }
      const v = Number(valueStr);
      if (!Number.isFinite(v)) return `值必须是数字，收到 "${htmlEscape(valueStr)}"`;
      state.filters = { ...(state.filters ?? {}), [name]: v };
      await ctx.persist();
      return `已设置 ${FILTER_LABELS[name]} ${v}`;
    }

    case '/probe': {
      if (!arg) return '用法：/probe &lt;marketId&gt;';
      return await buildProbeMessage(arg);
    }

    case '/watch': {
      if (!arg) return '用法：/watch &lt;marketId | slug | URL&gt;\n密集追踪：每次 tick 检测到买1卖1变动就立刻提醒（1 分钟冷却）。';
      const resolved = await resolveMarketInput(arg);
      if (resolved.error) return htmlEscape(resolved.error);
      const id = resolved.id;
      state.watchedIds = uniq([...(state.watchedIds ?? []), id]);
      state.removedIds = state.removedIds.filter((x) => x !== id);
      await ctx.persist();
      return `已开启密集追踪 #${htmlEscape(id)}（每次变动都会推送）。/unwatch 取消。`;
    }

    case '/unwatch': {
      if (!arg) return '用法：/unwatch &lt;marketId|all&gt;';
      if (arg === 'all') {
        state.watchedIds = [];
      } else {
        state.watchedIds = (state.watchedIds ?? []).filter((x) => x !== arg);
      }
      await ctx.persist();
      return arg === 'all' ? '已取消全部密集追踪。' : `已取消密集追踪 #${htmlEscape(arg)}。`;
    }

    case '/clearfilter': {
      if (!arg) return '用法：/clearfilter &lt;name|all&gt;';
      if (arg === 'all') {
        state.filters = {};
        await ctx.persist();
        return '已清除全部覆盖（恢复 env 默认）。';
      }
      if (!FILTER_KEYS.includes(arg)) {
        return `未知字段 "${htmlEscape(arg)}"。可用: ${FILTER_KEYS.join(', ')}, all`;
      }
      const next = { ...(state.filters ?? {}) };
      delete next[arg];
      state.filters = next;
      await ctx.persist();
      return `已清除覆盖 ${arg}（恢复 env 默认）。`;
    }

    default:
      return null;
  }
}

function normalizeReply(reply) {
  if (reply == null) return null;
  if (typeof reply === 'string') return { text: reply };
  return reply;
}

async function dispatchCommand(text, state, ctx, { chatId }) {
  let reply;
  try {
    reply = await handle(text, state, ctx);
  } catch (err) {
    warn('handler error:', err.message);
    await sendTelegramMessage(`错误: ${htmlEscape(err.message)}`, { chatId }).catch(() => {});
    return;
  }
  const norm = normalizeReply(reply);
  if (!norm) return;
  await sendLongTelegramMessage(norm.text, { chatId, replyMarkup: norm.replyMarkup }).catch((err) => {
    warn('send reply failed:', err.message);
  });
}

export function startCommandLoop({ getState, persist, ctx }) {
  if (!config.telegramCommandsEnabled) {
    log('disabled');
    return { stop: () => {} };
  }
  let stopped = false;
  const ctrl = new AbortController();
  const fullCtx = { ...ctx, persist };

  // Register commands with Telegram (best-effort; ignore failure).
  setMyCommands(COMMAND_MENU).catch((err) =>
    warn('setMyCommands failed:', err.message),
  );

  (async () => {
    log('listening for commands');
    while (!stopped) {
      try {
        const state = getState();
        const offset = (state.telegramOffset ?? 0) + 1 || undefined;
        const updates = await getUpdates({ offset, timeoutSec: 25, signal: ctrl.signal });
        if (!updates.length) continue;
        let maxId = state.telegramOffset ?? 0;
        for (const u of updates) {
          if (u.update_id > maxId) maxId = u.update_id;
          if (u.message?.text) {
            const chatId = u.message.chat?.id;
            if (!isAllowedChat(chatId)) {
              warn(`ignoring message from chat ${chatId}`);
              continue;
            }
            await dispatchCommand(u.message.text, state, fullCtx, { chatId });
          } else if (u.callback_query) {
            const cq = u.callback_query;
            const chatId = cq.message?.chat?.id;
            const messageId = cq.message?.message_id;
            // Always answer the callback so Telegram dismisses the loading
            // spinner, even if the chat is not allowed.
            await answerCallbackQuery(cq.id).catch(() => {});
            if (!isAllowedChat(chatId)) {
              warn(`ignoring callback from chat ${chatId}`);
              continue;
            }
            const data = String(cq.data ?? '').trim();
            if (!data) continue;
            // Wizard / pagination callbacks edit the originating message
            // in place instead of posting a new reply.
            if (data.startsWith('find:')) {
              await handleFindWizardCallback(data, { chatId, messageId, state, fullCtx }).catch((err) => {
                warn('find wizard error:', err.message);
              });
            } else if (data.startsWith('page:')) {
              await handlePageCallback(data, { chatId, messageId, state, fullCtx }).catch((err) => {
                warn('page callback error:', err.message);
              });
            } else {
              await dispatchCommand(data, state, fullCtx, { chatId });
            }
          }
        }
        state.telegramOffset = maxId;
        await persist();
      } catch (err) {
        if (stopped) break;
        if (err.name === 'AbortError') break;
        warn('poll error:', err.message);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    log('stopped');
  })();

  return {
    stop: () => {
      stopped = true;
      ctrl.abort();
    },
  };
}
