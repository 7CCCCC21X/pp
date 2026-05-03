import { config } from './config.js';
import {
  sendTelegramMessage,
  sendLongTelegramMessage,
  editTelegramMessage,
  htmlEscape,
  getUpdates,
  setMyCommands,
  answerCallbackQuery,
  getMe,
} from './telegram.js';
import {
  activeMarketIds,
  isAdminUser,
  isPermittedChat,
  addAllowedChat,
  removeAllowedChat,
  broadcastChats,
} from './state.js';
import { fmtElapsed, rewardZoneStatus, midOf, spreadOf, shortTitle, marketLink } from './format.js';
import { effectiveFilters, formatFilters, FILTER_KEYS, FILTER_LABELS } from './filters.js';
import { getMarketRewardSummary, getOrderbook, resolveSlugToId, getCacheStats, refreshAllCaches } from './predict.js';
import { slugifyMarketTitle } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[commands]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[commands]', ...args);

// Telegram's blue "/" menu next to the input box. Two scopes so
// group members don't see admin-only management commands cluttering
// their autocomplete:
//   PRIVATE_MENU = full set, registered as all_private_chats + default.
//   GROUP_MENU   = subset, registered as all_group_chats. /activate stays
//                  here so admin can self-enroll the group; /whitelist
//                  is hidden because it's managed elsewhere.
const PRIVATE_MENU = [
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
  { command: 'snooze', description: '临时静音单市场 (用法: /snooze <id> 1h)' },
  { command: 'quiet', description: '全局静音所有提醒 (用法: /quiet 2h | /quiet off)' },
  { command: 'alerts', description: '按类型开关提醒（停滞/跳变/阔差/奖励区/空簿）' },
  { command: 'discover', description: '立即触发自动发现' },
  { command: 'refresh', description: '立即刷新 PP/h 缓存（显示耗时）' },
  { command: 'digest', description: '发送 24 小时摘要' },
  { command: 'config', description: '查看当前监控条件 / 阈值 / 过滤器' },
  { command: 'activate', description: '在群里激活机器人（仅 admin）' },
  { command: 'whitelist', description: '管理白名单（仅 admin）' },
  { command: 'help', description: '显示帮助（含进阶命令）' },
];

const GROUP_MENU = PRIVATE_MENU.filter((c) => c.command !== 'whitelist');

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
const WIZARD_TYPES = [
  ['any',   '不限'],
  ['gap',   '空缺'],
  ['thin',  '薄盘'],
  ['wide',  '宽差'],
  ['empty', '空簿'],
];
const WIZARD_MIDS = [
  ['any',  '不限'],
  ['low',  '低价'],   // mid < 0.20
  ['mid',  '中间'],   // 0.20 ≤ mid ≤ 0.80
  ['high', '高价'],   // mid > 0.80
];
const WIZARD_SORTS = [
  ['rate',   'PP/h'],
  ['total',  '总PP'],
  ['score',  '机会分'],
  ['spread', 'spread'],
  ['thin',   '薄盘'],
];

function fmtRateShort(r) {
  if (r >= 1000) return `${(r / 1000).toFixed(0)}k`;
  return String(r);
}

const WIZARD_DEFAULT = { rate: 0, rem: 12, limit: 50, type: 'any', mid: 'any', sort: 'rate' };

// Type/mid/sort other than the simple defaults need live slot data
// (zone, spread, depth) which is only available for monitored markets.
// Pure rate+rem+limit queries can still reach the GraphQL discovery
// pool — the function is called "advanced" otherwise.
function isAdvancedQuery(s) {
  return s.type !== 'any' || s.mid !== 'any' || (s.sort !== 'rate' && s.sort !== 'total');
}

function labelOf(pairs, key) {
  return (pairs.find((p) => p[0] === key) ?? [key, key])[1];
}

function findWizardText(s) {
  const advanced = isAdvancedQuery(s);
  return [
    '🔍 <b>自定义筛选</b>',
    '',
    `📊 PP/h ≥ <b>${s.rate}</b>`,
    `⏱ 剩余 ≥ <b>${s.rem}h</b>`,
    `🎯 类型: <b>${labelOf(WIZARD_TYPES, s.type)}</b>`,
    `💲 中价: <b>${labelOf(WIZARD_MIDS, s.mid)}</b>`,
    `↕️ 排序: <b>${labelOf(WIZARD_SORTS, s.sort)}</b>`,
    `📦 上限 <b>${s.limit}</b>`,
    '',
    advanced
      ? '⚠️ 高级筛选只看已监控市场（GraphQL 池没有盘口）。'
      : '点按钮调整 → 🚀 查询（不改 watchlist） / 🔄 应用监控',
  ].join('\n');
}

// Encode the full 6-dim wizard state into a callback string. Each
// button replaces ONE knob with the new value, leaving others as-is.
// Format: find:<action>:R:M:L:T:Mi:S
function encodeState(action, s) {
  return `find:${action}:${s.rate}:${s.rem}:${s.limit}:${s.type}:${s.mid}:${s.sort}`;
}

function findWizardKeyboard(s) {
  const mark = (active, label) => active ? `✅ ${label}` : label;
  return {
    inline_keyboard: [
      WIZARD_RATES.map((r) => ({
        text: mark(r === s.rate, fmtRateShort(r)),
        callback_data: encodeState('set', { ...s, rate: r }),
      })),
      WIZARD_REMS.map((m) => ({
        text: mark(m === s.rem, `${m}h`),
        callback_data: encodeState('set', { ...s, rem: m }),
      })),
      WIZARD_TYPES.map(([k, label]) => ({
        text: mark(k === s.type, label),
        callback_data: encodeState('set', { ...s, type: k }),
      })),
      WIZARD_MIDS.map(([k, label]) => ({
        text: mark(k === s.mid, label),
        callback_data: encodeState('set', { ...s, mid: k }),
      })),
      WIZARD_SORTS.map(([k, label]) => ({
        text: mark(k === s.sort, label),
        callback_data: encodeState('set', { ...s, sort: k }),
      })),
      WIZARD_LIMITS.map((l) => ({
        text: mark(l === s.limit, String(l)),
        callback_data: encodeState('set', { ...s, limit: l }),
      })),
      [
        { text: '🚀 查询', callback_data: encodeState('run', s) },
        { text: '🔄 应用监控', callback_data: encodeState('scan', s) },
      ],
    ],
  };
}

function midBucket(mid) {
  if (!Number.isFinite(mid)) return null;
  if (mid < 0.20) return 'low';
  if (mid > 0.80) return 'high';
  return 'mid';
}

// Apply the wizard's type/mid filters against a slot-derived row. Returns
// true if the row passes ALL set filters.
function passesAdvanced(row, s) {
  if (s.type !== 'any') {
    const z = row.slot?.zoneStatus;
    const hasGap = z && (!z.bidActivated || !z.askActivated);
    const isThin = Number.isFinite(row.slot?.lastTopUsd) && row.slot.lastTopUsd < (config.lowDepthThreshold ?? 100);
    const isWide = Number.isFinite(row.slot?.lastSpread) && row.slot.lastSpread > config.maxSpread;
    const isEmpty = row.slot?.baseline
      && (row.slot.baseline.bidPrice == null || row.slot.baseline.askPrice == null);
    if (s.type === 'gap'   && !hasGap)   return false;
    if (s.type === 'thin'  && !isThin)   return false;
    if (s.type === 'wide'  && !isWide)   return false;
    if (s.type === 'empty' && !isEmpty)  return false;
  }
  if (s.mid !== 'any') {
    const bid = row.slot?.baseline?.bidPrice;
    const ask = row.slot?.baseline?.askPrice;
    const mid = (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2 : null;
    if (midBucket(mid) !== s.mid) return false;
  }
  return true;
}

function sortRowsBy(rows, sortKey) {
  const key = (r) => {
    const rate = Number.isFinite(r.rate) ? r.rate : (r.slot?.lastHourlyRate ?? 0);
    const remH = (Number.isFinite(r.endMs) && r.endMs > Date.now())
      ? (r.endMs - Date.now()) / 3600000
      : null;
    if (sortKey === 'total')  return remH != null ? rate * remH : rate;
    if (sortKey === 'score')  return opportunityScore(r.slot ?? {});
    if (sortKey === 'spread') return Number.isFinite(r.slot?.lastSpread) ? r.slot.lastSpread : 0;
    if (sortKey === 'thin')   return -(Number.isFinite(r.slot?.lastTopUsd) ? r.slot.lastTopUsd : Infinity);
    return rate; // 'rate' default
  };
  return rows.sort((a, b) => key(b) - key(a));
}

// Run the actual filter query. Mode controls whether matches replace
// the watchlist (scan) or just print (run). When the wizard sets any
// advanced knob, source from state.markets (live monitored set);
// otherwise fall back to GraphQL discovery for the simple PP/h+rem path.
async function runFilterQuery(s, mode, state, ctx) {
  const { getAllMarketsCached, extractHourlyRate, isMarketTradeable, marketEndMs } =
    await import('./predict.js');
  const advanced = isAdvancedQuery(s);
  const cutoff = s.rem > 0 ? Date.now() + s.rem * 3600000 : null;

  let rows = [];
  if (advanced) {
    // Live slot data — only markets we've actually polled.
    for (const id of activeMarketIds(state)) {
      const slot = state.markets[id];
      if (!slot || slot.lastError || slot.lastSkipReason) continue;
      const rate = Number.isFinite(slot.lastHourlyRate) ? slot.lastHourlyRate : 0;
      if (rate < s.rate) continue;
      if (cutoff && Number.isFinite(slot.endMs) && slot.endMs < cutoff) continue;
      const row = {
        id, slot, rate,
        title: slot.title ?? slot.question ?? null,
        endMs: slot.endMs ?? null,
      };
      if (!passesAdvanced(row, s)) continue;
      rows.push(row);
    }
  } else {
    // Discovery via GraphQL — works for markets we don't yet monitor.
    let all;
    try { all = await getAllMarketsCached(); }
    catch (err) { return { text: `市场列表获取失败: ${htmlEscape(err.message)}` }; }
    for (const m of all) {
      if (!isMarketTradeable(m)) continue;
      const rate = extractHourlyRate(m);
      if (rate < s.rate) continue;
      const endMs = marketEndMs(m);
      if (cutoff && endMs != null && endMs < cutoff) continue;
      rows.push({
        id: String(m.id),
        slot: state.markets[String(m.id)] ?? null,  // for sortBy(score) etc
        rate,
        title: m.title ?? m.question ?? null,
        endMs,
      });
    }
  }

  rows = sortRowsBy(rows, s.sort);
  const top = rows.slice(0, s.limit);

  if (mode === 'scan') {
    state.autoIds = top.map((x) => x.id);
    state.lastDiscoveryAt = Date.now();
    if (ctx?.persist) await ctx.persist();
  }

  if (!rows.length) {
    const hint = advanced ? '（高级筛选只看已监控市场，看 /status）' : '试试 /find 0 1';
    return { text: `没有匹配的市场（PP/h ≥ ${s.rate}, 剩余 ≥ ${s.rem}h, 类型 ${s.type}）。${hint}` };
  }

  const verb = mode === 'scan'
    ? `🔄 已替换 watchlist (${top.length} 个)`
    : `🔍 找到 ${rows.length} 个`;
  const note = rows.length > top.length ? `，显示前 ${top.length}` : '';
  const condParts = [
    `PP/h ≥ <b>${s.rate}</b>`,
    `剩余 ≥ <b>${s.rem}h</b>`,
  ];
  if (s.type !== 'any') condParts.push(`类型 <b>${labelOf(WIZARD_TYPES, s.type)}</b>`);
  if (s.mid !== 'any')  condParts.push(`中价 <b>${labelOf(WIZARD_MIDS, s.mid)}</b>`);
  condParts.push(`排序 <b>${labelOf(WIZARD_SORTS, s.sort)}</b>`);
  const lines = [
    `${verb}${note}`,
    `条件: ${condParts.join(' · ')}`,
    '',
  ];
  for (const [idx, r] of top.entries()) {
    const medal = idx < 3 ? ['🥇', '🥈', '🥉'][idx] : `${idx + 1}.`;
    const title = htmlEscape(shortTitle(r.title ?? `Market ${r.id}`, 42));
    const remH = (Number.isFinite(r.endMs) && r.endMs > Date.now())
      ? (r.endMs - Date.now()) / 3600000
      : null;
    const ext = remH != null
      ? ` · ${remH < 24 ? remH.toFixed(1) + 'h' : (remH / 24).toFixed(1) + 'd'}≈${fmtBig(r.rate * remH)}PP`
      : '';
    lines.push(`${medal} <code>#${r.id}</code> ${title} — <b>${r.rate.toFixed(0)}/h</b>${ext}`);
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
  // data shape: find:<action>:R:M:L:T:Mi:S
  const parts = data.split(':');
  if (parts[0] !== 'find') return false;
  const [, action, rateStr, remStr, limitStr, type, mid, sort] = parts;
  const s = {
    rate: Number(rateStr ?? 0),
    rem: Number(remStr ?? 12),
    limit: Math.min(Number(limitStr ?? 50), 200),
    type: type ?? 'any',
    mid: mid ?? 'any',
    sort: sort ?? 'rate',
  };
  if (!Number.isFinite(s.rate) || !Number.isFinite(s.rem) || !Number.isFinite(s.limit)) return true;

  if (action === 'set') {
    // Re-render the wizard with updated highlight
    try {
      await editTelegramMessage(
        chatId,
        messageId,
        findWizardText(s),
        findWizardKeyboard(s),
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
    const result = await runFilterQuery(s, action, state, fullCtx);
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
  '/snooze &lt;id&gt; &lt;30m|2h|1d&gt; — 临时静音单市场',
  '/quiet [duration] — 全局静音所有提醒（默认 2h，/quiet off 取消）',
  '/alerts [on|off &lt;kind&gt;|reset] — 按类型开关：stall / mid_jump / wide_spread / reward_zone / empty_book',
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
  '过滤器字段: min/max + Bid/Ask + 1/2/3 + Price/Size，以及派生 mid/spread/topUsd/totalUsd 和 requireXRewardGap',
  '',
  '<b>权限 / 配置</b>',
  '/config — 查看当前监控条件（阈值 / 过滤器 / 覆盖 / 白名单）',
  '/activate — 在当前 chat 激活机器人（群里发 /activate@&lt;botname&gt;，仅 admin）',
  '/deactivate — 从白名单移除当前 chat（仅 admin）',
  '/whitelist [list|add &lt;id&gt;|remove &lt;id&gt;] — 管理可使用 / 接收广播的 chat（仅 admin）',
  '',
  '<b>群组使用</b>',
  '1. 把机器人加入群（自动收到欢迎消息）',
  '2. admin 在群里发 /activate@&lt;botname&gt;',
  '3. 群里所有命令必须带 @&lt;botname&gt; 后缀（Telegram 隐私模式）',
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

async function buildProbeMessage(marketId, state) {
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
  // Match monitor.js precedence so /probe reflects what alerts would use:
  //   /setmarket override > REST market.spreadThreshold > env default.
  const { effectiveOverride } = await import('./state.js');
  const zone = rewardZoneStatus(
    ob, m,
    { maxDistance: config.rewardZoneMaxDistance, minSize: config.rewardZoneMinSize },
    {
      maxDistance: effectiveOverride(state ?? {}, marketId, 'rewardZoneMaxDistance', null),
      minSize: effectiveOverride(state ?? {}, marketId, 'rewardZoneMinSize', null),
    },
  );
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

// Two-line opportunity row used by every list command. Top line is
// the comparable metric strip (PP/h, remaining, gap, spread, depth,
// per-list extra); second line is the clickable title. extra is an
// optional suffix appended to the metric strip — typically a list-
// specific value like "spread 5.20¢" for /wide.
function compactOpportunityRow(id, slot, extra = '') {
  const linked = marketLink(id, slot?.title, slot?.question, slot?.slug);
  const rate = Number.isFinite(slot?.lastHourlyRate) ? slot.lastHourlyRate : 0;

  const remainH = (Number.isFinite(slot?.endMs) && slot.endMs > Date.now())
    ? (slot.endMs - Date.now()) / 3600000
    : null;
  const totalPp = (remainH != null && rate > 0) ? rate * remainH : null;

  const z = slot?.zoneStatus;
  const gaps = [];
  if (z) {
    if (!z.bidActivated) gaps.push('买');
    if (!z.askActivated) gaps.push('卖');
  }

  const parts = [`<code>#${htmlEscape(id)}</code>`, `<b>${rate.toFixed(0)}/h</b>`];
  if (totalPp != null) parts.push(`${remainH.toFixed(1)}h≈${totalPp.toFixed(0)}PP`);
  if (gaps.length) parts.push(`gap:${gaps.join('/')}`);
  if (Number.isFinite(slot?.lastSpread)) parts.push(`spr ${(slot.lastSpread * 100).toFixed(1)}¢`);
  if (Number.isFinite(slot?.lastTopUsd) && slot.lastTopUsd > 0) parts.push(`top $${slot.lastTopUsd.toFixed(0)}`);
  if (extra) parts.push(htmlEscape(extra));

  return `${parts.join(' · ')}\n   ${linked}`;
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
  // Live = the last tick actually fetched + processed this market. Skip-stub
  // slots (expired 15-min markets, no-reward, etc.) keep their slot record
  // for /status reporting but must not appear in opportunity lists.
  const isLive = (slot) => slot && !slot.lastError && !slot.lastSkipReason;
  switch (cmd) {
    case 'top':
      rows = allRows
        .filter(({ slot }) => isLive(slot) && Number.isFinite(slot.lastHourlyRate) && slot.lastHourlyRate > 0)
        .sort((a, b) => b.slot.lastHourlyRate - a.slot.lastHourlyRate);
      header = '<b>🔥 PP/h Top</b>';
      break;
    case 'gaps':
      rows = allRows
        .filter(({ slot }) => isLive(slot) && slot.zoneStatus
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
        .filter(({ slot }) => isLive(slot))
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
      rows = allRows.filter(({ slot }) => isLive(slot) && slot.baseline
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
        .filter(({ slot }) => isLive(slot) && slot.baseline
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
        .filter(({ slot }) => isLive(slot))
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
    lines.push(compactOpportunityRow(row.id, row.slot, extra));
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
  const filterBlocked = rows.filter(({ slot }) => slot?.lastSkipReason?.startsWith('过滤器:'));
  const otherSkipped = rows.filter(({ slot }) =>
    slot?.lastSkipReason && !slot.lastSkipReason.startsWith('过滤器:')
  );
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
  const totalRate = ppRows.reduce((acc, { slot }) => acc + slot.lastHourlyRate, 0);
  const topRate = ppRows[0]?.slot?.lastHourlyRate ?? 0;
  // Live opportunity counts derived from per-tick slot metrics (set in
  // monitor.js). Same definitions as the /thin /wide /empty list filters.
  const thinCount = rows.filter(({ slot }) =>
    slot && !slot.lastError && !slot.lastSkipReason
    && Number.isFinite(slot.lastTopUsd) && slot.lastTopUsd > 0
    && slot.lastTopUsd <= (config.lowDepthThreshold ?? 100)
  ).length;
  const wideCount = rows.filter(({ slot }) =>
    slot && !slot.lastError && !slot.lastSkipReason
    && Number.isFinite(slot.lastSpread) && slot.lastSpread > config.maxSpread
  ).length;
  const emptyCount = rows.filter(({ slot }) =>
    slot && !slot.lastError && !slot.lastSkipReason && slot.baseline
    && (slot.baseline.bidPrice == null || slot.baseline.askPrice == null)
  ).length;

  let totalPP24h = null;
  try {
    const { readHistorySince, summarize24h } = await import('./history.js');
    const since = Date.now() - 24 * 3600 * 1000;
    const records = await readHistorySince(since);
    const summary = summarize24h(records);
    totalPP24h = summary.reduce((a, m) => a + (m.ppEarned ?? 0), 0);
  } catch {}

  // Top dashboard panel — at-a-glance "is everything working + what's
  // going on" without scrolling. Three grouped lines: market census,
  // PP throughput, opportunity census.
  const lines = ['📡 <b>监控看板</b>'];
  const census = [`市场 <b>${ids.length}</b>`, `有效 <b>${ppRows.length}</b>`];
  if (errors.length) census.push(`报错 ${errors.length}`);
  if (filterBlocked.length) census.push(`过滤 ${filterBlocked.length}`);
  if (otherSkipped.length) census.push(`跳过 ${otherSkipped.length}`);
  if (waiting.length) census.push(`等待 ${waiting.length}`);
  if (paused.length) census.push(`暂停 ${paused.length}`);
  lines.push(census.join(' · '));
  lines.push(`💰 总 <b>${totalRate.toFixed(0)}</b> PP/h · 顶 <b>${topRate.toFixed(0)}</b>/h${totalPP24h != null && totalPP24h > 0 ? ` · 24h <b>${totalPP24h.toFixed(0)} PP</b>` : ''}`);
  const oppParts = [`奖励区空缺 <b>${gaps.length}</b>`];
  if (thinCount > 0) oppParts.push(`薄盘 ${thinCount}`);
  if (wideCount > 0) oppParts.push(`宽差 ${wideCount}`);
  if (emptyCount > 0) oppParts.push(`空簿 ${emptyCount}`);
  if (watched.length) oppParts.push(`👁 追踪 ${watched.length}`);
  lines.push(`🎯 ${oppParts.join(' · ')}`);
  lines.push('');

  if (errors.length) {
    lines.push('⚠️ <b>错误</b>');
    for (const { id, slot } of errors.slice(0, 8)) {
      lines.push(compactOpportunityRow(id, slot, slot.lastError));
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
      lines.push(compactOpportunityRow(id, slot, sides.join(',')));
    }
    if (gaps.length > 10) lines.push(`……还有 ${gaps.length - 10} 个空缺市场`);
    lines.push('');
  }

  if (ppRows.length) {
    lines.push('🔥 <b>PP/h Top</b>');
    for (const { id, slot } of ppRows.slice(0, 10)) {
      const since = slot.lastChangeAt ? `停滞 ${fmtElapsed(Date.now() - slot.lastChangeAt)}` : '';
      lines.push(compactOpportunityRow(id, slot, since));
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

function formatWhitelist(state) {
  const lines = ['<b>👥 白名单</b>'];
  if (config.telegramChatId) {
    lines.push(`  admin (env): <code>${htmlEscape(config.telegramChatId)}</code>`);
  } else {
    lines.push('  admin (env): <i>未配置 TELEGRAM_CHAT_ID</i>');
  }
  if (config.telegramAllowedChats.length) {
    lines.push('  env extra (TELEGRAM_ALLOWED_CHATS):');
    for (const id of config.telegramAllowedChats) {
      lines.push(`    <code>${htmlEscape(id)}</code>`);
    }
  }
  const runtime = state.allowedChats ?? [];
  if (runtime.length) {
    lines.push('  state runtime:');
    for (const id of runtime) {
      lines.push(`    <code>${htmlEscape(id)}</code>`);
    }
  } else {
    lines.push('  state runtime: <i>(空) — 用 /whitelist add &lt;chatId&gt; 添加群组</i>');
  }
  lines.push('');
  lines.push(`广播目标共 <b>${broadcastChats(state).length}</b> 个 chat。`);
  return lines.join('\n');
}

async function buildConfigDump(state) {
  const eff = effectiveFilters(state);
  const lines = ['<b>🛠 监控条件</b>', ''];

  // Polling + discovery
  lines.push('<b>📡 轮询</b>');
  lines.push(`  POLL_INTERVAL_MS: ${(config.pollIntervalMs / 1000).toFixed(0)}s · MARKETS_CACHE_TTL_MS: ${(config.marketsCacheTtlMs / 60000).toFixed(0)}min`);
  lines.push('');
  lines.push('<b>🔍 自动发现</b>');
  if (config.autodiscover) {
    lines.push(`  AUTODISCOVER: on · MIN_HOURLY_RATE ≥ ${config.minHourlyRate} · MIN_REMAINING_HOURS ≥ ${config.minRemainingHours}h · 上限 ${config.discoveryMaxMarkets}`);
    lines.push(`  DISCOVERY_INTERVAL_MS: ${(config.discoveryIntervalMs / 60000).toFixed(0)}min · SKIP_NO_REWARD: ${config.skipNoReward ? 'on' : 'off'}`);
  } else {
    lines.push('  AUTODISCOVER: off');
  }
  lines.push('');

  // Alert toggles + thresholds
  lines.push('<b>🔔 提醒阈值</b>');
  lines.push(`  停滞 (stall): ${config.alertStall ? 'on' : 'off'} · ${config.staleHours}h`);
  lines.push(`  跳变 (midJump): ${config.alertMidJump ? 'on' : 'off'} · ≥ ${config.midJumpThreshold} · 冷却 ${(config.midJumpCooldownMs / 60000).toFixed(0)}min`);
  lines.push(`  阔差 (wideSpread): ${config.alertWideSpread ? 'on' : 'off'} · > ${(config.maxSpread * 100).toFixed(2)}¢ · 持续 ${config.wideSpreadMinMinutes}min`);
  lines.push(`  奖励区 (rewardZone): ${config.alertRewardZone ? 'on' : 'off'} · env 默认距 mid ≤ ${(config.rewardZoneMaxDistance * 100).toFixed(2)}¢ · 量 ≥ ${config.rewardZoneMinSize} · 持续 ${config.rewardZoneMinMinutes}min`);
  lines.push(`    实际值精度: /setmarket 覆盖 → REST market.spreadThreshold/shareThreshold → env 默认（绝大多数市场 REST 都会给值）`);
  lines.push(`  空簿 (emptyBook): ${config.alertEmptyBook ? 'on' : 'off'} · 持续 ${config.emptyBookMinMinutes}min`);
  lines.push(`  恢复提醒: ${config.alertRecovery ? 'on' : 'off'} · 跨类型冷却: ${(config.marketAlertCooldownMs / 60000).toFixed(0)}min`);
  lines.push('');

  // Filters in effect
  const activeFilters = FILTER_KEYS.filter((k) => eff[k] != null);
  if (activeFilters.length) {
    lines.push('<b>🔧 全局过滤器</b>');
    for (const k of activeFilters) {
      const tag = state?.filters?.[k] != null ? ' <i>(live)</i>' : ' <i>(env)</i>';
      lines.push(`  ${FILTER_LABELS[k]} ${eff[k]}${tag}`);
    }
    lines.push('');
  } else {
    lines.push('<b>🔧 全局过滤器</b>: 无');
    lines.push('');
  }

  // Per-market overrides
  const overrides = Object.entries(state.overrides ?? {});
  if (overrides.length) {
    lines.push(`<b>📋 每市场覆盖 (${overrides.length})</b>`);
    for (const [id, kv] of overrides) {
      const pairs = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`  #${htmlEscape(id)}: ${htmlEscape(pairs)}`);
    }
    lines.push('');
  }

  // Whitelist
  lines.push(formatWhitelist(state));
  return { text: lines.join('\n') };
}

async function handle(text, state, ctx, chatId, fromId) {
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
        const initial = { ...WIZARD_DEFAULT, rem: defaultRem };
        return {
          text: findWizardText(initial),
          replyMarkup: findWizardKeyboard(initial),
        };
      }
      const minRate = parts[0] != null ? Number(parts[0]) : 0;
      const minRem = parts[1] != null ? Number(parts[1]) : (config.minRemainingHours ?? 12);
      const limit = Math.min(parts[2] != null ? Number(parts[2]) : 50, 200);
      if (!Number.isFinite(minRate) || !Number.isFinite(minRem) || !Number.isFinite(limit)) {
        return '用法: /find [minRate] [minRem 小时] [limit]\n例: /find 500 12 30\n  /scan 同样参数，但会替换 watchlist\n  /find （无参数）= 交互式向导（含类型/中价/排序）';
      }
      const result = await runFilterQuery(
        { rate: minRate, rem: minRem, limit, type: 'any', mid: 'any', sort: 'rate' },
        cmd === '/scan' ? 'scan' : 'find',
        state, ctx,
      );
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

    // Global mute — silences ALL non-recovery alerts for a duration.
    // /quiet         → 2h default
    // /quiet 30m|1d  → custom
    // /quiet off|0   → cancel
    case '/quiet': {
      if (arg === 'off' || arg === '0' || arg === 'cancel') {
        state.quietUntil = 0;
        await ctx.persist();
        return '🔔 静音已取消，正常发送提醒。';
      }
      const ms = arg ? parseDuration(arg) : 2 * 3600 * 1000;
      if (!ms) return '用法：/quiet [duration]\n例：/quiet 30m / /quiet 2h / /quiet 1d / /quiet off';
      state.quietUntil = Date.now() + ms;
      await ctx.persist();
      const until = new Date(state.quietUntil);
      return `🔕 已全局静音 ${htmlEscape(arg || '2h')}\n恢复时间: ${until.toISOString()}\n（恢复提醒不受影响）`;
    }

    // Per-kind alert toggle — long-term "I never want to see midJump"
    // type silencing. State key controls only the alert delivery; the
    // detector still runs and updates baselines / history.
    //   /alerts                    → list current state
    //   /alerts off <kind>         → disable
    //   /alerts on  <kind>         → re-enable
    //   /alerts reset              → clear all overrides (back to env)
    case '/alerts': {
      const KINDS = ['stall', 'mid_jump', 'wide_spread', 'reward_zone', 'empty_book'];
      const [sub, kind] = arg.split(/\s+/);
      const action = (sub ?? '').toLowerCase();
      const cfgDefault = (k) => ({
        stall: config.alertStall,
        mid_jump: config.alertMidJump,
        wide_spread: config.alertWideSpread,
        reward_zone: config.alertRewardZone,
        empty_book: config.alertEmptyBook,
      })[k];
      if (!action || action === 'list' || action === 'ls') {
        const lines = ['🔔 <b>提醒类型开关</b>'];
        for (const k of KINDS) {
          const override = state.alertKinds?.[k];
          const enabled = override == null ? cfgDefault(k) : override;
          const tag = override == null ? '(env)' : '(live)';
          lines.push(`  ${enabled ? '🔔' : '🔕'} <code>${k}</code> ${tag}`);
        }
        const quietLeft = state.quietUntil > Date.now()
          ? Math.round((state.quietUntil - Date.now()) / 60000)
          : 0;
        if (quietLeft > 0) lines.push(`\n⏸ 全局静音剩余 ${quietLeft} 分钟（/quiet off 取消）`);
        lines.push('\n用法: /alerts [on|off] &lt;kind&gt; / /alerts reset');
        return lines.join('\n');
      }
      if (action === 'reset') {
        state.alertKinds = {};
        await ctx.persist();
        return '已清除全部 per-kind 覆盖（恢复 env 默认）。';
      }
      if (action !== 'on' && action !== 'off') {
        return `用法：/alerts [list|on &lt;kind&gt;|off &lt;kind&gt;|reset]\n可用 kind: ${KINDS.join(', ')}`;
      }
      if (!kind || !KINDS.includes(kind)) {
        return `未知 kind "${htmlEscape(kind ?? '')}"。可用: ${KINDS.join(', ')}`;
      }
      state.alertKinds = { ...(state.alertKinds ?? {}), [kind]: action === 'on' };
      await ctx.persist();
      return `${action === 'on' ? '🔔' : '🔕'} ${kind} 已${action === 'on' ? '开启' : '关闭'}。`;
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
      // Pass/block census across the live monitored set, plus a few
      // recent rejections so the user can see whether thresholds are
      // sane. Pulls from slot.lastSkipReason (set in monitor.js when
      // checkFilter returns a reason).
      const ids = activeMarketIds(state);
      let pass = 0, blocked = 0, noBook = 0;
      const rejections = [];
      for (const id of ids) {
        const slot = state.markets[id];
        if (!slot || slot.lastError || !slot.baseline) { noBook++; continue; }
        if (slot.lastSkipReason?.startsWith('过滤器:')) {
          blocked++;
          if (rejections.length < 5) {
            const reason = slot.lastSkipReason.replace(/^过滤器:\s*/, '');
            rejections.push({ id, slot, reason });
          }
        } else {
          pass++;
        }
      }
      const lines = [
        '🎚 <b>当前过滤器</b>',
        formatFilters(eff, state),
        '',
        '<b>效果</b>',
        `通过 <b>${pass}</b> / ${pass + blocked} · 被挡 <b>${blocked}</b>${noBook ? ` · 无盘口 ${noBook}` : ''}`,
      ];
      if (rejections.length) {
        lines.push('');
        lines.push('<b>最近被挡</b>');
        for (const r of rejections) {
          const title = htmlEscape(shortTitle(r.slot.title ?? r.slot.question ?? `Market ${r.id}`, 36));
          lines.push(`<code>#${htmlEscape(r.id)}</code> ${title} — ${htmlEscape(r.reason)}`);
        }
      }
      return lines.join('\n');
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
      return await buildProbeMessage(arg, state);
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

    // /activate (admin user only): one-tap enrollment from inside a
    // group. Admin types `/activate@<botname>` in the group; the
    // group's chatId gets added to state.allowedChats. Telegram group
    // privacy mode means the bot only sees commands addressed via
    // @<botname> in groups, so the suffix is required there.
    case '/activate': {
      if (!isAdminUser(fromId)) return null; // silent: don't leak command's existence
      if (chatId == null) return '无法识别当前 chat。';
      const id = String(chatId);
      const added = addAllowedChat(state, id);
      await ctx.persist();
      return added
        ? `✅ 已激活当前 chat <code>${htmlEscape(id)}</code>\n这里现在可以收提醒、digest 和命令了。`
        : `当前 chat <code>${htmlEscape(id)}</code> 已在白名单。`;
    }

    case '/deactivate': {
      if (!isAdminUser(fromId)) return null;
      if (chatId == null) return '无法识别当前 chat。';
      const id = String(chatId);
      if (id === String(config.telegramChatId)) {
        return '不能从白名单移除 admin 私聊（这是 env 配置的）。';
      }
      const removed = removeAllowedChat(state, id);
      await ctx.persist();
      return removed
        ? `已从白名单移除当前 chat <code>${htmlEscape(id)}</code>。`
        : `当前 chat 不在 state 白名单（env 白名单需改环境变量）。`;
    }

    // Whitelist management — admin user, can run from anywhere they're
    // present (private DM or any group they're in). Adds/removes chat
    // IDs that can both call commands AND receive broadcasts.
    case '/whitelist': {
      if (!isAdminUser(fromId)) return '仅 admin 可管理白名单。';
      const [sub, target] = arg.split(/\s+/);
      const action = (sub ?? '').toLowerCase();
      if (!action || action === 'list' || action === 'ls') {
        return formatWhitelist(state);
      }
      if (action === 'add') {
        if (!target) return '用法：/whitelist add &lt;chatId&gt;（或在群里发 /activate@&lt;botname&gt; 一键加）';
        if (!/^-?\d+$/.test(target)) return `无效 chat id "${htmlEscape(target)}"，必须是整数`;
        const added = addAllowedChat(state, target);
        await ctx.persist();
        return added
          ? `已加入白名单：${htmlEscape(target)}\n${formatWhitelist(state)}`
          : `${htmlEscape(target)} 已在白名单。`;
      }
      if (action === 'remove' || action === 'rm') {
        if (!target) return '用法：/whitelist remove &lt;chatId&gt;';
        const removed = removeAllowedChat(state, target);
        await ctx.persist();
        return removed
          ? `已从白名单移除：${htmlEscape(target)}\n${formatWhitelist(state)}`
          : `${htmlEscape(target)} 不在 state 白名单（env 白名单需改环境变量）。`;
      }
      return '用法：/whitelist [list|add &lt;id&gt;|remove &lt;id&gt;]';
    }

    case '/config': {
      // Read-only — anyone whitelisted can see it. (No secrets here:
      // bot token / API key are explicitly excluded.)
      return await buildConfigDump(state);
    }

    default:
      return null;
  }
}

// One-shot welcome posted to a group right after the bot is added.
// Embeds the bot's @username so all examples are paste-ready under
// Telegram's group privacy mode (which requires the @<botname> suffix
// for the bot to even see the message).
export function buildWelcomeText(botUsername) {
  const u = botUsername ? `@${botUsername}` : '@&lt;botname&gt;';
  return [
    '👋 你好！我是 Predict.fun 监控机器人。',
    '',
    `要启用本群的监控提醒，请由 admin 发送：`,
    `<code>/activate${u}</code>`,
    '',
    '激活后任意成员可用：',
    `<code>/status${u}</code> — 监控面板`,
    `<code>/top${u}</code> — PP/h 排行`,
    `<code>/gaps${u}</code> — 奖励区空缺`,
    `<code>/help${u}</code> — 完整命令`,
    '',
    `⚠️ Telegram 群里使用命令必须带 ${u} 后缀（隐私模式所致）。`,
  ].join('\n');
}

// True if the message starts with /activate (with or without an
// @<botname> suffix). Used as the pre-permission gate for
// admin-driven group enrollment.
function isActivateCommand(text) {
  if (typeof text !== 'string') return false;
  const first = text.trim().split(/\s+/)[0] ?? '';
  const cmd = first.replace(/@\w+$/, '').toLowerCase();
  return cmd === '/activate';
}

function normalizeReply(reply) {
  if (reply == null) return null;
  if (typeof reply === 'string') return { text: reply };
  return reply;
}

async function dispatchCommand(text, state, ctx, { chatId, fromId }) {
  let reply;
  try {
    reply = await handle(text, state, ctx, chatId, fromId);
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
  let botId = null;
  let botUsername = null;

  // Register commands per-scope (best-effort). Group members get a
  // trimmed menu; admin's private chat sees everything; default is the
  // catch-all fallback for any chat type with no explicit registration.
  setMyCommands(PRIVATE_MENU, { type: 'all_private_chats' }).catch((err) =>
    warn('setMyCommands(private) failed:', err.message),
  );
  setMyCommands(GROUP_MENU, { type: 'all_group_chats' }).catch((err) =>
    warn('setMyCommands(group) failed:', err.message),
  );
  setMyCommands(PRIVATE_MENU, { type: 'default' }).catch((err) =>
    warn('setMyCommands(default) failed:', err.message),
  );

  // Cache bot identity once so my_chat_member can recognise self-events
  // and welcome messages can embed @<botname>.
  getMe().then((me) => {
    botId = me?.id ?? null;
    botUsername = me?.username ?? null;
    log(`bot identity: @${botUsername} (id=${botId})`);
  }).catch((err) => warn('getMe failed:', err.message));

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
          if (u.my_chat_member) {
            // Bot was added/removed/promoted in some chat. Welcome on
            // the join transition (kicked/left → member/administrator)
            // for non-private chats. Bypasses whitelist gate because
            // it's a one-shot reply to the join event itself.
            const ev = u.my_chat_member;
            const targetUserId = ev.new_chat_member?.user?.id;
            if (botId != null && targetUserId === botId) {
              const fromStatus = ev.old_chat_member?.status;
              const toStatus = ev.new_chat_member?.status;
              const wasOut = fromStatus === 'left' || fromStatus === 'kicked';
              const nowIn = toStatus === 'member' || toStatus === 'administrator';
              const groupChat = ev.chat?.type === 'group' || ev.chat?.type === 'supergroup';
              if (wasOut && nowIn && groupChat && ev.chat?.id != null) {
                log(`my_chat_member: bot joined chat ${ev.chat.id} (${ev.chat.title ?? '?'})`);
                await sendTelegramMessage(buildWelcomeText(botUsername), { chatId: ev.chat.id })
                  .catch((err) => warn(`welcome to ${ev.chat.id} failed:`, err.message));
              }
            }
            continue;
          }
          if (u.message?.text) {
            const chatId = u.message.chat?.id;
            const fromId = u.message.from?.id;
            const text = u.message.text;
            // Pre-permission: admin can fire `/activate@<botname>` in
            // a brand-new group to enroll it without going to private
            // chat first. Anything else from an unenrolled chat is
            // silently ignored (logged for the admin's discovery).
            if (!isPermittedChat(state, chatId)) {
              if (isActivateCommand(text) && isAdminUser(fromId)) {
                await dispatchCommand(text, state, fullCtx, { chatId, fromId });
              } else {
                warn(`ignoring message from chat ${chatId} (from user ${fromId})`);
              }
              continue;
            }
            await dispatchCommand(text, state, fullCtx, { chatId, fromId });
          } else if (u.callback_query) {
            const cq = u.callback_query;
            const chatId = cq.message?.chat?.id;
            const fromId = cq.from?.id;
            const messageId = cq.message?.message_id;
            // Always answer the callback so Telegram dismisses the loading
            // spinner, even if the chat is not allowed.
            await answerCallbackQuery(cq.id).catch(() => {});
            if (!isPermittedChat(state, chatId)) {
              warn(`ignoring callback from chat ${chatId} (from user ${fromId})`);
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
              await dispatchCommand(data, state, fullCtx, { chatId, fromId });
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
