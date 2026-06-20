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
  effectiveOverride,
  stallDurationMs,
} from './state.js';
import { fmtElapsed, fmtCents, rewardZoneStatus, midOf, spreadOf, shortTitle, marketLink, marketUrl } from './format.js';
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
  { command: 'stale', description: '停滞时长排名（含未到阈值的）' },
  { command: 'all', description: '全部监控市场（含暂停/跳过/错误,可筛+排序）' },
  { command: 'new', description: '今日新上的有奖励市场（默认 24h；底部按钮可调窗口/PP/h/剩余/排序）' },
  { command: 'movers', description: 'PP/h 变动的市场（默认近 1h；底部可调时间窗口）' },
  { command: 'sanity', description: '定价异常的阈值阶梯（门槛越高概率却没更低；按套利金额排序）' },
  { command: 'ladders', description: '全部识别到的阈值阶梯（含定价正常的，便于核对分组）' },
  { command: 'probe', description: '单个市场快照 (用法: /probe <id>)' },
  { command: 'watch', description: '密集追踪某市场 (用法: /watch <id>)' },
  { command: 'watched', description: '列出当前所有 /watch 追踪的市场' },
  { command: 'unwatch', description: '取消密集追踪' },
  { command: 'add', description: '加入监控 (用法: /add <id|slug|url>)' },
  { command: 'remove', description: '永久移除' },
  { command: 'pause', description: '静音指定市场' },
  { command: 'resume', description: '恢复监控' },
  { command: 'snooze', description: '临时静音单市场 (用法: /snooze <id> 1h)' },
  { command: 'snapshot', description: '定时盘口快照（admin 私聊，用法: /snapshot <id> 5m）' },
  { command: 'quiet', description: '全局静音所有提醒 (用法: /quiet 2h | /quiet off)' },
  { command: 'alerts', description: '按类型开关提醒（停滞/跳变/阔差/奖励区/空簿）' },
  { command: 'route', description: '当前 chat 的路由（每个 chat 独立排除某些 kind）' },
  { command: 'discover', description: '立即触发自动发现' },
  { command: 'diagdiscover', description: '对比 REST/GraphQL 两个发现源的数量' },
  { command: 'refresh', description: '立即刷新 PP/h 缓存（显示耗时）' },
  { command: 'digest', description: '发送 24 小时摘要' },
  { command: 'hourly', description: '整点摘要设置面板(只收摘要/排除极端价/立即发送;群里点按钮)' },
  { command: 'config', description: '查看当前监控条件 / 阈值 / 过滤器' },
  { command: 'activate', description: '在群里激活机器人（仅 admin）' },
  { command: 'whitelist', description: '管理白名单（仅 admin）' },
  { command: 'help', description: '显示帮助（含进阶命令）' },
];

const GROUP_MENU = PRIVATE_MENU.filter((c) => c.command !== 'whitelist');

// Inline keyboard for /menu. Two layouts:
//   - private: full grouped layout (机会找寻 / 监控管理 / 单市场 / 设置)
//   - group:   read-only browsing buttons only — admin actions like
//              /refresh, /discover, /alerts, /filter, /snapshot are
//              hidden so group members aren't tempted to flip global
//              config; everything they CAN do lands on this keyboard
//              so they don't have to remember slash-command names.
function menuKeyboard({ isPrivate = true } = {}) {
  if (!isPrivate) {
    return {
      inline_keyboard: [
        [
          { text: '🔥 PP/h 榜', callback_data: '/top' },
          { text: '🎯 空缺榜', callback_data: '/gaps' },
          { text: '💧 薄盘榜', callback_data: '/thin' },
        ],
        [
          { text: '📏 价差榜', callback_data: '/wide' },
          { text: '🌊 空簿榜', callback_data: '/empty' },
          { text: '⏱ 停滞榜', callback_data: '/stale' },
        ],
        [
          { text: '📋 全部市场', callback_data: '/all' },
          { text: '🆕 新上市', callback_data: '/new' },
          { text: '🔍 自定义筛', callback_data: '/find' },
        ],
        [
          { text: '📈 PP 变动', callback_data: '/movers' },
          { text: '⚠️ 定价异常', callback_data: '/sanity' },
          { text: '⏱ 摘要设置', callback_data: '/hourly' },
        ],
        [
          { text: '📡 状态', callback_data: '/status' },
          { text: '📈 24h 摘要', callback_data: '/digest' },
          { text: '❓ 帮助', callback_data: '/help' },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      // 🔍 机会找寻
      [
        { text: '🔥 PP/h 榜', callback_data: '/top' },
        { text: '🎯 空缺榜', callback_data: '/gaps' },
        { text: '💧 薄盘榜', callback_data: '/thin' },
      ],
      [
        { text: '📏 价差榜', callback_data: '/wide' },
        { text: '🌊 空簿榜', callback_data: '/empty' },
        { text: '⏱ 停滞榜', callback_data: '/stale' },
      ],
      [
        { text: '📋 全部市场', callback_data: '/all' },
        { text: '🆕 新上市', callback_data: '/new' },
        { text: '🔍 自定义筛', callback_data: '/find' },
      ],
      [
        { text: '📈 PP 变动', callback_data: '/movers' },
        { text: '⚠️ 定价异常', callback_data: '/sanity' },
        { text: '🪜 阶梯', callback_data: '/ladders' },
      ],
      [
        { text: '⏱ 摘要设置', callback_data: '/hourly' },
      ],
      // 👁 监控管理
      [
        { text: '📡 状态', callback_data: '/status' },
        { text: '⚡ 刷新缓存', callback_data: '/refresh' },
        { text: '🔄 自动发现', callback_data: '/discover' },
      ],
      // 📸 单市场（粘 URL / id 也直接吃）
      [
        { text: '📸 快照列表', callback_data: '/snapshot' },
        { text: '📈 24h 摘要', callback_data: '/digest' },
      ],
      // ⚙️ 设置
      [
        { text: '🔔 提醒类型', callback_data: '/alerts' },
        { text: '🎚 过滤器', callback_data: '/filter' },
      ],
      [
        { text: '📋 当前配置', callback_data: '/config' },
        { text: '❓ 帮助', callback_data: '/help' },
      ],
    ],
  };
}

// Header text for /menu — labels each button group so the layout is
// scannable. Embedded URL/id paste hint reduces friction for the
// most common admin flow.
function menuText({ isPrivate = true } = {}) {
  if (!isPrivate) {
    return [
      '<b>快捷菜单</b>',
      '',
      '🔍 <b>找机会</b>: PP榜 / 空缺 / 薄盘 / 阔差 / 空簿 / 停滞 / 全部 / 自定义筛',
      '📡 <b>查看</b>: 状态 / 24h 摘要 / 当前配置',
      '<i>群里按钮只放只读浏览。改阈值/订阅请去私聊。</i>',
    ].join('\n');
  }
  return [
    '<b>快捷菜单</b>',
    '',
    '🔍 <b>机会找寻</b>: PP榜 / 空缺 / 薄盘 / 阔差 / 空簿 / 停滞 / 全部 / 自定义筛',
    '👁 <b>监控管理</b>: 状态 / 刷新 / 自动发现',
    '📸 <b>单市场</b>: 直接粘 URL 或 #id 进来 → 出操作菜单',
    '⚙️ <b>设置</b>: 提醒类型 / 过滤器 / 配置',
  ].join('\n');
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

// --- URL paste flow: admin pastes a Predict.fun URL → bot resolves and
//     offers a card-style picker (multi-outcome events) or an action
//     menu (single market) for /watch / /snapshot / /add. ---

const PREDICT_URL_RE = /https?:\/\/predict\.fun\/[^\s]+/i;
function extractPredictFunUrl(text) {
  const m = text?.match?.(PREDICT_URL_RE);
  return m ? m[0] : null;
}

function slugFromPredictUrl(url) {
  // /<lang>/market/<slug>[?...] or /market/<slug>
  const m = url.match(/\/market\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Card-style picker: one button per matching market, showing the
// bucket title + PP/h to make the choice obvious. Telegram caps
// inline_keyboard buttons per row; we use 1 per row so titles like
// "$200M" / "100-200 推特" stay readable on mobile.
function pickerKeyboard(matches) {
  const rows = matches.slice(0, 12).map((m) => [{
    text: `${shortTitle(m.title || `Market ${m.id}`, 28)} · ${(m.rate ?? 0).toFixed(0)}/h`,
    callback_data: `pick:${m.id}`,
  }]);
  rows.push([{ text: '✖️ 取消', callback_data: 'do:cancel' }]);
  return { inline_keyboard: rows };
}

function pickerText(matches, slug) {
  const lines = [
    `🔍 <b>找到 ${matches.length} 个匹配市场</b>`,
    `slug: <code>${htmlEscape(slug)}</code>`,
    '',
    '点一个进入操作菜单（追踪 / 快照 / 加监控）。',
  ];
  if (matches.length > 12) {
    lines.push('');
    lines.push(`(只显示前 12 个，按 PP/h 排序)`);
  }
  return lines.join('\n');
}

function actionKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '👁 追踪', callback_data: `do:watch:${id}` },
        { text: '➕ 加入监控', callback_data: `do:add:${id}` },
      ],
      [
        { text: '📸 5min 快照', callback_data: `do:snap:${id}:5m` },
        { text: '📸 15min 快照', callback_data: `do:snap:${id}:15m` },
      ],
      [
        { text: '📊 当前盘口', callback_data: `do:probe:${id}` },
        { text: '✖️ 取消', callback_data: 'do:cancel' },
      ],
    ],
  };
}

function actionText(market) {
  const title = htmlEscape(shortTitle(market.title || `Market ${market.id}`, 50));
  const remH = (Number.isFinite(market.endMs) && market.endMs > Date.now())
    ? (market.endMs - Date.now()) / 3600000
    : null;
  const totalPp = remH != null ? (market.rate ?? 0) * remH : null;
  const lines = [
    `📌 <code>#${htmlEscape(market.id)}</code> ${title}`,
    `<b>${(market.rate ?? 0).toFixed(0)}</b> PP/h${remH != null ? ` · 剩余 ${remH.toFixed(1)}h ≈ ${totalPp.toFixed(0)} PP` : ''}`,
    '',
    '想做什么？',
  ];
  return lines.join('\n');
}

// Detects "<digits>" or "#<digits>" sent as a bare message — admin-DM
// paste shortcut equivalent to /probe <id> + the action card. Returns
// the id string or null. Length check (≥4) avoids triggering on plain
// numbers like "5" that the user might be typing for an interval.
function extractBareMarketId(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^#?(\d{4,})$/);
  return m ? m[1] : null;
}

// Looks up a single market id and shows the action card. Used by both
// the bare-id paste flow and the singleton URL match path.
async function showActionCardForId(id, state, ctx, chatId) {
  const { getMarketRewardSummary, marketEndMs } = await import('./predict.js');
  let summary;
  try {
    summary = await getMarketRewardSummary(id);
  } catch (err) {
    await sendTelegramMessage(`查询失败: ${htmlEscape(err.message)}`, { chatId });
    return;
  }
  if (!summary?.market) {
    await sendTelegramMessage(`未找到市场 #${htmlEscape(id)}（不在 PP 列表里、id 错了或已 resolve）。`, { chatId });
    return;
  }
  const market = {
    id: String(id),
    title: summary.market.title ?? summary.market.question ?? null,
    rate: summary.totalHourlyRate ?? 0,
    endMs: marketEndMs(summary.market),
  };
  await sendTelegramMessage(actionText(market), { chatId, replyMarkup: actionKeyboard(market.id) });
}

async function handleUrlPaste(url, state, ctx, { chatId }) {
  const slug = slugFromPredictUrl(url);
  if (!slug) {
    await sendTelegramMessage(`未能从 URL 提取 slug:\n<code>${htmlEscape(url)}</code>`, { chatId });
    return;
  }
  const { resolveUrlSlugToMarkets } = await import('./predict.js');
  let matches = [];
  try {
    matches = await resolveUrlSlugToMarkets(slug, slugifyMarketTitle);
  } catch (err) {
    await sendTelegramMessage(`解析失败: ${htmlEscape(err.message)}`, { chatId });
    return;
  }
  if (matches.length === 0) {
    await sendLongTelegramMessage(
      [
        '⚠️ 没在 PP-rewarded 列表里找到匹配市场。',
        `slug: <code>${htmlEscape(slug)}</code>`,
        '',
        '可能：',
        '• 这个市场不奖励 PP（autodiscover 不会抓）',
        '• 已经 resolve',
        '• Slug 不在已缓存的市场里',
        '',
        '手动方案：在浏览器 DevTools → Network 找 /v1/markets/&lt;数字&gt;，然后用 /add &lt;数字&gt;。',
      ].join('\n'),
      { chatId },
    );
    return;
  }
  if (matches.length === 1) {
    await sendTelegramMessage(actionText(matches[0]), {
      chatId,
      replyMarkup: actionKeyboard(matches[0].id),
    });
    return;
  }
  await sendTelegramMessage(pickerText(matches, slug), {
    chatId,
    replyMarkup: pickerKeyboard(matches),
  });
}

// Callback handler for both pick:<id> (user picked from event list) and
// do:<action>:<id>[:<arg>] (user chose what to do with the picked market).
export async function handlePickCallback(data, { chatId, messageId, state, fullCtx }) {
  if (data.startsWith('pick:')) {
    const id = data.slice('pick:'.length);
    if (!id) return;
    // Look up market metadata for the action card.
    const { getMarketRewardSummary } = await import('./predict.js');
    let market = { id };
    try {
      const summary = await getMarketRewardSummary(id);
      const m = summary?.market;
      if (m) {
        market = {
          id,
          title: m.title ?? m.question ?? null,
          rate: summary.totalHourlyRate ?? 0,
          endMs: (await import('./predict.js')).marketEndMs(m),
        };
      }
    } catch { /* fall back to id-only display */ }
    await editTelegramMessage(chatId, messageId, actionText(market), actionKeyboard(id))
      .catch((err) => { if (!/message is not modified/i.test(err.message)) throw err; });
    return;
  }

  if (!data.startsWith('do:')) return;
  const parts = data.slice('do:'.length).split(':');
  const action = parts[0];
  const id = parts[1];

  if (action === 'cancel') {
    await editTelegramMessage(chatId, messageId, '已取消。', undefined).catch(() => {});
    return;
  }
  if (!id) return;

  // All do:* actions write to state and persist; piggyback on existing
  // handle() logic by synthesizing the equivalent text command. Keeps
  // the response copy / validation / persist behavior consistent.
  let cmd = null;
  if (action === 'watch') cmd = `/watch ${id}`;
  else if (action === 'add') cmd = `/add ${id}`;
  else if (action === 'probe') cmd = `/probe ${id}`;
  else if (action === 'snap') {
    const interval = parts[2] ?? '5m';
    cmd = `/snapshot ${id} ${interval}`;
  }
  if (!cmd) return;
  await dispatchCommand(cmd, state, fullCtx, { chatId, fromId: chatId });
  // Replace the picker card with a confirmation footer so the chat
  // doesn't accumulate stale "want to do X?" cards.
  await editTelegramMessage(
    chatId, messageId,
    `✅ 已执行: <code>${htmlEscape(cmd)}</code>`,
    undefined,
  ).catch(() => {});
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

// ---------- /stale filter wizard ----------
//
// ---------- shared filter wizard (used by /stale and /all) ----------
//
// Lets the user filter a market leaderboard by "sum of selected orderbook
// levels ≤ threshold" plus pick a sort order. The user toggles which
// depth-3 levels (买1/买2/买3 for bid, 卖1/卖2/卖3 for ask) participate in
// the sum, picks a dollar threshold, and the bot re-fetches each active
// market's orderbook fresh (no cache) with a live progress bar before
// applying the filter.
//
// Two list "kinds" share this wizard:
//   - stale: only live (not skipped/errored) markets, default sort by
//            stall duration desc.
//   - all:   every monitored market (incl. paused / skipped / errored),
//            default sort by PP/h desc; used to browse the full pool.
//
// State encoding in callback_data: <kind>:<action>:<bits>:<thresh>:<sort>:<dir>:<page>
//   kind   = stale | all (also serves as callback prefix for routing).
//   bits   = 6-char "b1b2b3a1a2a3" (1=selected). Default "100100".
//   thresh = inf | <number> (e.g. 50, 100, 1000, 23456). Default "inf".
//            Custom values entered via "✏ 自定义" button get stored as
//            integers; presets are also strings of integers — same shape.
//   sort   = t | p (t=stall duration, p=PP/h).
//   dir    = le | ge (le = sum ≤ thresh = thin filter; ge = sum ≥ thresh
//            = thick filter). Default "le".
//   page   = int (only used by action=page).
//   actions = wizard | set | run | page | cancel | custom
//
// Telegram callback_data limit is 64 bytes; this scheme fits in ~35.
// Legacy callback shapes:
//   5-part (pre-sort, pre-dir): stale:<action>:<bits>:<thresh>:<page>
//   6-part (pre-dir):           <kind>:<action>:<bits>:<thresh>:<sort>:<page>
// Both still parse — sort defaults to kind's default, dir defaults to "le".

const LIST_THRESHOLDS = ['inf', '50', '100', '200', '500', '1000', '5000'];
const LIST_LEVELS = ['b1', 'b2', 'b3', 'a1', 'a2', 'a3'];
const LIST_LEVEL_LABELS = { b1: '买1', b2: '买2', b3: '买3', a1: '卖1', a2: '卖2', a3: '卖3' };
const LIST_SORTS = ['t', 'p'];
const LIST_SORT_LABELS = { t: '停滞时长', p: 'PP/h' };
const LIST_DIRS = ['le', 'ge'];
const LIST_DIR_LABELS = { le: '≤ (薄)', ge: '≥ (厚)' };
const LIST_DIR_OP = { le: '≤', ge: '≥' };

// "极端价" filter — a market is "extreme" iff one side of the binary is
// already near a boundary (best-ask >= N¢ OR best-bid <= (100-N)¢, so the
// market is effectively decided). Two modes:
//   '94'   → 排除 ≥94¢ — drop extreme markets (default mode)
//   'i94'  → 仅 ≥94¢   — show ONLY extreme markets (the "find decided
//                        markets I can market-make on" use case)
//   'off'  → no filter
// Single-sided / empty books pass through either way (/empty handles those).
const LIST_EXT_VALUES = ['94', '90', '85']; // numeric presets, mode-agnostic

function parseExtRaw(e) {
  if (e == null || e === '' || e === 'off') return { mode: 'off', val: null };
  const m = String(e).match(/^(i)?(\d{1,2})$/);
  if (!m) return { mode: 'off', val: null };
  const val = Number(m[2]);
  if (!Number.isFinite(val) || val < 1 || val > 99) return { mode: 'off', val: null };
  return { mode: m[1] ? 'in' : 'ex', val };
}

function formatExt(mode, val) {
  if (mode === 'off' || val == null) return 'off';
  return mode === 'in' ? `i${val}` : String(val);
}

function normalizeExt(e) {
  const p = parseExtRaw(e);
  return p.mode === 'off' ? 'off' : formatExt(p.mode, p.val);
}

function isCustomExt(e) {
  const p = parseExtRaw(e);
  if (p.mode === 'off') return false;
  return !LIST_EXT_VALUES.includes(String(p.val));
}

function extLabel(e) {
  const p = parseExtRaw(e);
  if (p.mode === 'off') return '不限';
  return p.mode === 'in' ? `仅 ≥${p.val}¢` : `排除 ≥${p.val}¢`;
}

function extFilterActive(e) {
  return parseExtRaw(e).mode !== 'off';
}

// Compact button label for an ext token (no space, matches the preset buttons).
function extBtnLabel(e) {
  const p = parseExtRaw(e);
  if (p.mode === 'off') return '关';
  return p.mode === 'in' ? `仅≥${p.val}¢` : `排除≥${p.val}¢`;
}

// Max custom 极端价 values kept as buttons (most-recent first).
const CUSTOM_EXT_PRESET_CAP = 4;

// Remember a user-entered custom 极端价 value so it stays available as a button
// in the wizard. Only stores genuinely custom values (not the 94/90/85 presets);
// dedupes (move-to-front) and caps the list so it can't grow unbounded.
export function rememberCustomExtPreset(state, ext) {
  const token = normalizeExt(ext);
  if (token === 'off' || !isCustomExt(token)) return;
  const prev = Array.isArray(state.customExtPresets) ? state.customExtPresets : [];
  state.customExtPresets = [token, ...prev.filter((t) => normalizeExt(t) !== token)]
    .slice(0, CUSTOM_EXT_PRESET_CAP);
}

// Freshest known top-of-book for a slot. The 极端价 filter must agree with
// the orderbook the user opens (buildProbeMessage fetches live), so prefer
// the wizard-refetched book (slot.recentBook, seconds old) over the monitor
// baseline (up to a poll interval stale). lastObservedAt dates the baseline;
// recentBook carries its own fetchedAt — newest wins.
export function extTopOfBook(slot) {
  if (!slot) return { bid: null, ask: null };
  const rb = slot.recentBook;
  const rbAt = Number.isFinite(rb?.fetchedAt) ? rb.fetchedAt : -Infinity;
  const baseAt = Number.isFinite(slot.lastObservedAt) ? slot.lastObservedAt : -Infinity;
  const finite = (v) => (Number.isFinite(v) ? v : null);
  if (rb && rbAt >= baseAt) {
    return { bid: finite(rb.bids?.[0]?.price), ask: finite(rb.asks?.[0]?.price) };
  }
  return { bid: finite(slot.baseline?.bidPrice), ask: finite(slot.baseline?.askPrice) };
}

export function passesExtFilter(slot, ext) {
  const p = parseExtRaw(ext);
  if (p.mode === 'off') return true;
  const hi = p.val / 100;
  const lo = (100 - p.val) / 100;
  const { bid, ask } = extTopOfBook(slot);
  const askExt = Number.isFinite(ask) && ask >= hi;
  const bidExt = Number.isFinite(bid) && bid <= lo;
  const isExtreme = askExt || bidExt;
  // 'in' = only show extreme markets; 'ex' = exclude extreme markets.
  return p.mode === 'in' ? isExtreme : !isExtreme;
}

const LIST_KINDS = {
  stale: { title: '⏱ 停滞排名', defaultSort: 't' },
  all:   { title: '📋 全部市场', defaultSort: 'p' },
  new:   { title: '🆕 新上市场', defaultSort: 't' },
};

// /new wizard knobs (shares LIST_LEVELS / LIST_THRESHOLDS / LIST_DIRS with
// /stale + /all for the depth filter):
//   winH    — time window (hours) for "first seen within last N hours"
//   minRate — PP/h floor; markets paying less are hidden
//   minRem  — minimum remaining lifetime (hours); 0 = no limit
//   bits    — 6-char mask of selected b1/b2/b3 + a1/a2/a3 levels
//   thresh  — sum threshold (USD) for selected levels; 'inf' = off
//   dir     — 'le' (≤, 薄盘) or 'ge' (≥, 厚盘)
//   sort    — 't' (上榜时间 desc), 'p' (PP/h desc)
// When (bits has 1 selected) AND (thresh ≠ 'inf'), the depth filter is
// active and 🚀 triggers a parallel orderbook refetch — same flow as
// /stale and /all use. Other knobs work off cached PP/h + endMs alone.
const NEW_WIN_PRESETS = ['24', '72', '168', '336', '720'];   // hours
const NEW_RATE_PRESETS = ['0', '100', '500', '1000', '5000']; // PP/h
const NEW_REM_PRESETS = ['0', '6', '24', '72', '168'];        // hours
const NEW_SORTS = ['t', 'p'];
const NEW_SORT_LABELS = { t: '上榜时间', p: 'PP/h' };
const NEW_DEFAULT = {
  winH: 24, minRate: 0, minRem: 0,
  bits: '100100', thresh: 'inf', dir: 'le',
  sort: 't',
  noUpDown: true, // hide "Bitcoin/ETH Up or Down" recurring intraday spam by default
};

// "Up or Down" intraday markets (Bitcoin/ETH/SOL ...) are auto-generated
// every few minutes and flood /new — match them by title/question text so
// the noUpDown filter can drop them.
function isUpOrDownMarket(slot) {
  const t = `${slot?.title ?? ''} ${slot?.question ?? ''}`;
  return /up or down/i.test(t);
}

function fmtHoursLabel(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return '不限';
  if (n < 24) return `${n}h`;
  if (n % 24 === 0) return `${n / 24}d`;
  return `${n}h`;
}

function fmtRateLabel(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return '不限';
  if (n >= 1000) return `≥${n / 1000}k/h`;
  return `≥${n}/h`;
}

function isPositiveIntStr(s) {
  return typeof s === 'string' && /^\d+$/.test(s) && Number(s) >= 0;
}

function parseNewFilter(parts) {
  // parts: [winH, minRate, minRem, bits, thresh, dir, sort, noUpDown]
  const winH = isPositiveIntStr(parts[0]) ? Number(parts[0]) : NEW_DEFAULT.winH;
  const minRate = isPositiveIntStr(parts[1]) ? Number(parts[1]) : NEW_DEFAULT.minRate;
  const minRem = isPositiveIntStr(parts[2]) ? Number(parts[2]) : NEW_DEFAULT.minRem;
  const bits = /^[01]{6}$/.test(parts[3]) ? parts[3] : NEW_DEFAULT.bits;
  const thresh = (LIST_THRESHOLDS.includes(parts[4]) || isCustomThresh(parts[4]))
    ? parts[4] : NEW_DEFAULT.thresh;
  const dir = LIST_DIRS.includes(parts[5]) ? parts[5] : NEW_DEFAULT.dir;
  const sort = NEW_SORTS.includes(parts[6]) ? parts[6] : NEW_DEFAULT.sort;
  // noUpDown: '1'/'0'. Absent (old callbacks) → default (hide).
  const noUpDown = parts[7] == null ? NEW_DEFAULT.noUpDown : parts[7] === '1';
  return {
    winH: Math.min(720 * 24, Math.max(1, winH)),
    minRate, minRem, bits, thresh, dir, sort, noUpDown,
  };
}

function newFilterToCbParts(f) {
  return [
    String(f.winH), String(f.minRate), String(f.minRem),
    f.bits, f.thresh, f.dir, f.sort, f.noUpDown ? '1' : '0',
  ];
}

function newDepthFilterActive(f) {
  // Depth filter triggers the orderbook refetch path. "Active" means at
  // least one level is selected AND a threshold is set.
  return f.thresh !== 'inf' && /1/.test(f.bits)
    && (LIST_THRESHOLDS.includes(f.thresh) || isCustomThresh(f.thresh));
}

function newWizardText(f) {
  const sel = parseStaleBits(f.bits);
  const picked = LIST_LEVELS.filter((k) => sel[k]).map((k) => LIST_LEVEL_LABELS[k]);
  const dirOp = LIST_DIR_OP[f.dir] ?? '≤';
  const threshLabel = f.thresh === 'inf' ? '不限' : `${dirOp}$${f.thresh}`;
  const customThreshTag = isCustomThresh(f.thresh) ? ' <i>(自定义)</i>' : '';
  const lines = [
    `<b>🆕 新上市场 · 过滤设置</b>`,
    '',
    `⏰ 窗口: <b>${fmtHoursLabel(f.winH)}</b>`,
    `💰 最低 PP/h: <b>${fmtRateLabel(f.minRate)}</b>`,
    `⌛ 最短剩余: <b>${fmtHoursLabel(f.minRem)}</b>`,
    `📐 累加层级: ${picked.length ? `<b>${picked.join(' + ')}</b>` : '<i>未选 (=不过滤盘口)</i>'}`,
    `💵 盘口总额: <b>${threshLabel}</b>${customThreshTag}`,
    `🪙 比特币涨跌类: <b>${f.noUpDown ? '隐藏' : '显示'}</b>`,
    `📊 排序: <b>${NEW_SORT_LABELS[f.sort]}</b>`,
    '',
    '<i>盘口过滤 (层级 + 总额) 开启时 🚀 会重抓 orderbook,可能耗时几十秒;</i>',
    '<i>不开盘口过滤时 🚀 瞬间返回。✏ 后回复一个数字设置自定义值。</i>',
  ];
  return lines.join('\n');
}

function newWizardKeyboard(f) {
  const cb = (action, override = {}) => {
    const merged = { ...f, ...override };
    return `new:${action}:${newFilterToCbParts(merged).join(':')}:0`;
  };
  const sel = parseStaleBits(f.bits);
  const winMark = (h) => Number(h) === f.winH ? `✅ ${fmtHoursLabel(h)}` : fmtHoursLabel(h);
  const rateMark = (r) => Number(r) === f.minRate ? `✅ ${fmtRateLabel(r)}` : fmtRateLabel(r);
  const remMark = (h) => Number(h) === f.minRem ? `✅ ${fmtHoursLabel(h)}` : fmtHoursLabel(h);
  const sortMark = (s) => s === f.sort ? `✅ ${NEW_SORT_LABELS[s]}` : NEW_SORT_LABELS[s];
  const mark = (on, label) => on ? `✅ ${label}` : `⬜ ${label}`;
  const threshMark = (t) => t === f.thresh
    ? `✅ ${staleThreshLabel(t, f.dir)}`
    : staleThreshLabel(t, f.dir);
  const dirMark = (d) => d === f.dir ? `✅ ${LIST_DIR_LABELS[d]}` : LIST_DIR_LABELS[d];
  const isCustomWin = !NEW_WIN_PRESETS.includes(String(f.winH));
  const isCustomRate = !NEW_RATE_PRESETS.includes(String(f.minRate));
  const isCustomRem = !NEW_REM_PRESETS.includes(String(f.minRem));
  return {
    inline_keyboard: [
      [{ text: '— ⏰ 窗口 —', callback_data: 'page:noop' }],
      NEW_WIN_PRESETS.slice(0, 3).map((h) => ({
        text: winMark(h), callback_data: cb('set', { winH: Number(h) }),
      })),
      [
        ...NEW_WIN_PRESETS.slice(3).map((h) => ({
          text: winMark(h), callback_data: cb('set', { winH: Number(h) }),
        })),
        {
          text: isCustomWin ? `✅ ✏ (${fmtHoursLabel(f.winH)})` : '✏ 自定义…',
          callback_data: cb('custom-win'),
        },
      ],
      [{ text: '— 💰 最低 PP/h · ⌛ 最短剩余 —', callback_data: 'page:noop' }],
      NEW_RATE_PRESETS.slice(0, 3).map((r) => ({
        text: rateMark(r), callback_data: cb('set', { minRate: Number(r) }),
      })),
      [
        ...NEW_RATE_PRESETS.slice(3).map((r) => ({
          text: rateMark(r), callback_data: cb('set', { minRate: Number(r) }),
        })),
        {
          text: isCustomRate ? `✅ ✏ (${fmtRateLabel(f.minRate)})` : '✏ 自定义…',
          callback_data: cb('custom-rate'),
        },
      ],
      NEW_REM_PRESETS.slice(0, 3).map((h) => ({
        text: remMark(h), callback_data: cb('set', { minRem: Number(h) }),
      })),
      [
        ...NEW_REM_PRESETS.slice(3).map((h) => ({
          text: remMark(h), callback_data: cb('set', { minRem: Number(h) }),
        })),
        {
          text: isCustomRem ? `✅ ✏ (${fmtHoursLabel(f.minRem)})` : '✏ 自定义…',
          callback_data: cb('custom-rem'),
        },
      ],
      [{ text: '— 📐 盘口层级 (会触发 orderbook 重抓) —', callback_data: 'page:noop' }],
      [
        { text: mark(sel.b1, '买1'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'b1') }) },
        { text: mark(sel.b2, '买2'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'b2') }) },
        { text: mark(sel.b3, '买3'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'b3') }) },
      ],
      [
        { text: mark(sel.a1, '卖1'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'a1') }) },
        { text: mark(sel.a2, '卖2'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'a2') }) },
        { text: mark(sel.a3, '卖3'), callback_data: cb('set', { bits: flipStaleBit(f.bits, 'a3') }) },
      ],
      [
        { text: threshMark('inf'), callback_data: cb('set', { thresh: 'inf' }) },
        { text: threshMark('50'), callback_data: cb('set', { thresh: '50' }) },
        { text: threshMark('100'), callback_data: cb('set', { thresh: '100' }) },
        { text: threshMark('200'), callback_data: cb('set', { thresh: '200' }) },
      ],
      [
        { text: threshMark('500'), callback_data: cb('set', { thresh: '500' }) },
        { text: threshMark('1000'), callback_data: cb('set', { thresh: '1000' }) },
        { text: threshMark('5000'), callback_data: cb('set', { thresh: '5000' }) },
        {
          text: isCustomThresh(f.thresh) ? `✅ ✏ ($${f.thresh})` : '✏ 自定义…',
          callback_data: cb('custom-thresh'),
        },
      ],
      LIST_DIRS.map((d) => ({ text: dirMark(d), callback_data: cb('set', { dir: d }) })),
      [{ text: '— 🪙 比特币涨跌 · 📊 排序 —', callback_data: 'page:noop' }],
      [{
        text: f.noUpDown ? '✅ 隐藏 比特币涨跌类' : '⬜ 隐藏 比特币涨跌类',
        callback_data: cb('set', { noUpDown: !f.noUpDown }),
      }],
      NEW_SORTS.map((s) => ({ text: sortMark(s), callback_data: cb('set', { sort: s }) })),
      [
        { text: '🚀 应用', callback_data: cb('run') },
        { text: '✖ 取消', callback_data: cb('cancel') },
      ],
    ],
  };
}

function newFilterIsActive(f) {
  return f.winH !== NEW_DEFAULT.winH
    || f.minRate !== NEW_DEFAULT.minRate
    || f.minRem !== NEW_DEFAULT.minRem
    || f.bits !== NEW_DEFAULT.bits
    || f.thresh !== NEW_DEFAULT.thresh
    || f.dir !== NEW_DEFAULT.dir
    || f.sort !== NEW_DEFAULT.sort
    || f.noUpDown !== NEW_DEFAULT.noUpDown;
}

// Back-compat aliases for code that still imports the stale-prefixed names.
const STALE_THRESHOLDS = LIST_THRESHOLDS;
const STALE_LEVELS = LIST_LEVELS;
const STALE_LEVEL_LABELS = LIST_LEVEL_LABELS;
const STALE_SORTS = LIST_SORTS;
const STALE_SORT_LABELS = LIST_SORT_LABELS;

function parseStaleBits(bits) {
  const safe = (typeof bits === 'string' && /^[01]{6}$/.test(bits)) ? bits : '100100';
  const sel = {};
  LIST_LEVELS.forEach((k, i) => { sel[k] = safe[i] === '1'; });
  return sel;
}

function flipStaleBit(bits, key) {
  const arr = parseStaleBits(bits);
  arr[key] = !arr[key];
  return LIST_LEVELS.map((k) => arr[k] ? '1' : '0').join('');
}

// Threshold values are now arbitrary numeric strings (presets + custom).
// Treat anything parseable as a positive integer as a valid thresh.
function isCustomThresh(t) {
  return typeof t === 'string' && t !== 'inf' && !LIST_THRESHOLDS.includes(t)
    && /^\d+$/.test(t);
}

function staleThreshLabel(t, dir = 'le') {
  if (t === 'inf') return '不限';
  const op = LIST_DIR_OP[dir] ?? '≤';
  return `${op}$${t}`;
}

function staleFilterIsActive(bits, thresh) {
  return thresh !== 'inf' && /1/.test(bits)
    && (LIST_THRESHOLDS.includes(thresh) || isCustomThresh(thresh));
}

function sumLevels(book, sel) {
  // book = { bids: [{price,size}, ...], asks: [...] }, max 3 each.
  // sel from parseStaleBits — picks which levels participate.
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const lvl = (row) => Number.isFinite(row?.price) && Number.isFinite(row?.size)
    ? row.price * row.size : 0;
  let sum = 0;
  if (sel.b1) sum += lvl(bids[0]);
  if (sel.b2) sum += lvl(bids[1]);
  if (sel.b3) sum += lvl(bids[2]);
  if (sel.a1) sum += lvl(asks[0]);
  if (sel.a2) sum += lvl(asks[1]);
  if (sel.a3) sum += lvl(asks[2]);
  return sum;
}

function listWizardText(kind, bits, thresh, sort, dir, ext = 'off') {
  const meta = LIST_KINDS[kind] ?? LIST_KINDS.stale;
  const sel = parseStaleBits(bits);
  const picked = LIST_LEVELS.filter((k) => sel[k]).map((k) => LIST_LEVEL_LABELS[k]);
  const sortKey = LIST_SORTS.includes(sort) ? sort : meta.defaultSort;
  const dirKey = LIST_DIRS.includes(dir) ? dir : 'le';
  const customTag = isCustomThresh(thresh) ? ' <i>(自定义)</i>' : '';
  const extTag = isCustomExt(ext) ? ' <i>(自定义)</i>' : '';
  const lines = [
    `<b>${meta.title} · 过滤设置</b>`,
    '',
    `📐 累加层级: ${picked.length ? `<b>${picked.join(' + ')}</b>` : '<i>未选 (=不过滤)</i>'}`,
    `💵 总额阈值: <b>${staleThreshLabel(thresh, dirKey)}</b>${customTag}`,
    `📈 极端价: <b>${extLabel(ext)}</b>${extTag}`,
    `📊 排序: <b>${LIST_SORT_LABELS[sortKey]}</b>`,
    '',
    '<i>点 🚀 后:有盘口过滤 → 重抓 orderbook 实时数据再筛+排序;</i>',
    '<i>没盘口过滤(默认) → 直接用现有数据排序,瞬间完成。</i>',
    '<i>极端价: 一边 ≥N¢ 或 ≤(100-N)¢ 的市场基本已决断。"排除" 隐藏 / "仅" 只显示这类。</i>',
    '<i>自定义: 点 ✏ 后回复数字(总额 USD / 极端价 1-99)。</i>',
  ];
  return lines.join('\n');
}

export function listWizardKeyboard(kind, bits, thresh, sort, dir, ext = 'off', customPresets = []) {
  const meta = LIST_KINDS[kind] ?? LIST_KINDS.stale;
  const sel = parseStaleBits(bits);
  const sortKey = LIST_SORTS.includes(sort) ? sort : meta.defaultSort;
  const dirKey = LIST_DIRS.includes(dir) ? dir : 'le';
  const extKey = normalizeExt(ext);
  const mark = (on, label) => on ? `✅ ${label}` : `⬜ ${label}`;
  const threshMark = (t) => t === thresh ? `✅ ${staleThreshLabel(t, dirKey)}` : staleThreshLabel(t, dirKey);
  const sortMark = (s) => s === sortKey ? `✅ ${LIST_SORT_LABELS[s]}` : LIST_SORT_LABELS[s];
  const dirMark = (d) => d === dirKey ? `✅ ${LIST_DIR_LABELS[d]}` : LIST_DIR_LABELS[d];
  const extMark = (e, label) => e === extKey ? `✅ ${label}` : label;
  // 8-part callback: kind:action:bits:thresh:sort:dir:ext:page
  const cb = (action, b = bits, t = thresh, s = sortKey, d = dirKey, e = extKey) =>
    `${kind}:${action}:${b}:${t}:${s}:${d}:${e}:0`;
  // Threshold row gets the "✏ 自定义" affordance + the current custom value
  // (if any) shown as a checkmarked button so the user can see what's set.
  const threshButtons = LIST_THRESHOLDS.map((t) => ({
    text: threshMark(t),
    callback_data: cb('set', bits, t),
  }));
  const customButton = {
    text: isCustomThresh(thresh) ? `✅ ✏自定义 ($${thresh})` : '✏ 自定义…',
    callback_data: cb('thresh-pick'),
  };
  // Split threshold buttons into two rows so they fit comfortably on mobile.
  const threshRow1 = threshButtons.slice(0, 4);
  const threshRow2 = [...threshButtons.slice(4), customButton];
  // Extreme-price filter: two rows, one per mode.
  // Row 1: off + exclude presets ("排除≥N¢" — hide near-resolved markets).
  // Row 2: include presets + custom ("仅≥N¢" — show ONLY near-resolved).
  const extExcludeRow = [
    { text: extMark('off', '关'), callback_data: cb('set', bits, thresh, sortKey, dirKey, 'off') },
    ...LIST_EXT_VALUES.map((v) => ({
      text: extMark(v, `排除≥${v}¢`),
      callback_data: cb('set', bits, thresh, sortKey, dirKey, v),
    })),
  ];
  const extIncludeRow = [
    ...LIST_EXT_VALUES.map((v) => ({
      text: extMark(`i${v}`, `仅≥${v}¢`),
      callback_data: cb('set', bits, thresh, sortKey, dirKey, `i${v}`),
    })),
    {
      // The "✏ 自定义…" button opens a value-picker card; the active custom
      // value (if any) shows up as its own checkmarked button in the custom row.
      text: '✏ 自定义…',
      callback_data: cb('ext-pick'),
    },
  ];
  // Custom 极端价 values the user added stay as buttons (union with the active
  // one so a just-applied value always has a visible, checkmarked button even
  // before it's persisted). Trailing 🗑 clears the whole custom list.
  const customTokens = [];
  const seenCustom = new Set();
  const pushCustom = (tok) => {
    const n = normalizeExt(tok);
    if (n === 'off' || !isCustomExt(n) || seenCustom.has(n)) return;
    seenCustom.add(n);
    customTokens.push(n);
  };
  if (isCustomExt(extKey)) pushCustom(extKey);
  for (const t of (customPresets ?? [])) pushCustom(t);
  const extCustomRow = customTokens.slice(0, CUSTOM_EXT_PRESET_CAP).map((tok) => ({
    text: extMark(tok, extBtnLabel(tok)),
    callback_data: cb('set', bits, thresh, sortKey, dirKey, tok),
  }));
  if (extCustomRow.length) {
    extCustomRow.push({ text: '🗑 清空', callback_data: cb('ext-clear') });
  }
  return {
    inline_keyboard: [
      [
        { text: mark(sel.b1, '买1'), callback_data: cb('set', flipStaleBit(bits, 'b1')) },
        { text: mark(sel.b2, '买2'), callback_data: cb('set', flipStaleBit(bits, 'b2')) },
        { text: mark(sel.b3, '买3'), callback_data: cb('set', flipStaleBit(bits, 'b3')) },
      ],
      [
        { text: mark(sel.a1, '卖1'), callback_data: cb('set', flipStaleBit(bits, 'a1')) },
        { text: mark(sel.a2, '卖2'), callback_data: cb('set', flipStaleBit(bits, 'a2')) },
        { text: mark(sel.a3, '卖3'), callback_data: cb('set', flipStaleBit(bits, 'a3')) },
      ],
      threshRow1,
      threshRow2,
      LIST_DIRS.map((d) => ({
        text: dirMark(d),
        callback_data: cb('set', bits, thresh, sortKey, d),
      })),
      extExcludeRow,
      extIncludeRow,
      ...(extCustomRow.length ? [extCustomRow] : []),
      LIST_SORTS.map((s) => ({
        text: sortMark(s),
        callback_data: cb('set', bits, thresh, s),
      })),
      [
        { text: '🚀 应用', callback_data: cb('run') },
        { text: '✖ 取消', callback_data: cb('cancel') },
      ],
    ],
  };
}

// Custom-value picker cards. Tapping "✏ 自定义" opens one of these instead of
// only prompting for a typed number — on desktop the reply box doesn't reliably
// pop, so a tap-to-choose card is the dependable path. Each value button reuses
// action 'set' (selects + re-renders the full wizard); "✏ 手动输入" drops to the
// reply-a-number flow for an arbitrary value; "⬅ 返回" goes back to the wizard.
const EXT_PICK_EXCLUDE = ['98', '96', '92', '88', '80', '75']; // 排除 ≥N¢ presets
const EXT_PICK_INCLUDE = ['98', '92', '80'];                   // 仅 ≥N¢ presets
const THRESH_PICK_VALUES = ['150', '300', '750', '1500', '3000', '10000'];

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function extPickerKeyboard(kind, bits, thresh, sort, dir, ext) {
  const extKey = normalizeExt(ext);
  const cb = (action, e = extKey) => `${kind}:${action}:${bits}:${thresh}:${sort}:${dir}:${e}:0`;
  const mark = (token, label) => token === extKey ? `✅ ${label}` : label;
  const excludeRows = chunk(EXT_PICK_EXCLUDE, 3).map((row) =>
    row.map((v) => ({ text: mark(v, `排除≥${v}¢`), callback_data: cb('set', v) })));
  const includeRow = EXT_PICK_INCLUDE.map((v) => ({
    text: mark(`i${v}`, `仅≥${v}¢`), callback_data: cb('set', `i${v}`),
  }));
  return {
    inline_keyboard: [
      ...excludeRows,
      includeRow,
      [
        { text: '✏ 手动输入数字', callback_data: cb('custom-ext') },
        { text: '⬅ 返回', callback_data: cb('wizard') },
      ],
    ],
  };
}

export function threshPickerKeyboard(kind, bits, thresh, sort, dir, ext) {
  const dirKey = LIST_DIRS.includes(dir) ? dir : 'le';
  const cb = (action, t = thresh) => `${kind}:${action}:${bits}:${t}:${sort}:${dirKey}:${normalizeExt(ext)}:0`;
  const mark = (t, label) => t === thresh ? `✅ ${label}` : label;
  const valueRows = chunk(THRESH_PICK_VALUES, 3).map((row) =>
    row.map((t) => ({ text: mark(t, staleThreshLabel(t, dirKey)), callback_data: cb('set', t) })));
  return {
    inline_keyboard: [
      ...valueRows,
      [
        { text: '✏ 手动输入数字', callback_data: cb('custom') },
        { text: '⬅ 返回', callback_data: cb('wizard') },
      ],
    ],
  };
}

function pickerCardText(kind, field) {
  const meta = LIST_KINDS[kind] ?? LIST_KINDS.stale;
  const title = field === 'ext' ? '极端价' : '盘口总额阈值';
  const hint = field === 'ext'
    ? '一边 ≥N¢ (或 ≤(100-N)¢) 的市场基本已决断。点下面任意值直接选,或「手动输入」填 1-99。'
    : '盘口总额上/下限 (USD)。点下面任意值直接选,或「手动输入」填任意金额。';
  return [`<b>${meta.title} · 自定义${title}</b>`, '', `<i>${hint}</i>`].join('\n');
}

// Parallel orderbook re-fetch with live progress bar. Edits the wizard
// message every PROGRESS_EDIT_EVERY completions (and at finish), throttled
// so we don't trip Telegram's edit rate limit. Returns a Map<id, book>.
//
// Hard caps: each market gets at most STALE_PER_MARKET_TIMEOUT_MS to
// finish; if it doesn't, we count it as a timeout and move on. Without
// this cap, a market with no working URL combo cascades through every
// fallback (5-10 attempts × 10s orderbookTimeoutMs each) — easily 60+
// seconds per market — and a few of those at the tail leave the bar
// pinned at 99% for minutes. The whole refetch also hits a global
// deadline to bound worst case.
const STALE_REFETCH_CONCURRENCY = 3;
// Progress-bar edit throttle. Telegram throttles repeated editMessageText on
// the same message hard (429 with retry_after up to ~30s once you burst), so
// we keep edits sparse: at least STALE_PROGRESS_EDIT_MIN_MS apart AND at
// least STALE_PROGRESS_EDIT_EVERY completions apart. The progress bar is
// cosmetic — missing an intermediate frame is fine, the final render always
// fires (force=true).
const STALE_PROGRESS_EDIT_EVERY = 20;
const STALE_PROGRESS_EDIT_MIN_MS = 4_000;
const STALE_PER_MARKET_TIMEOUT_MS = 20_000;
const STALE_REFETCH_DEADLINE_MS = 5 * 60 * 1000;

async function refetchOrderbooksWithProgress({ ids, state, chatId, messageId, kind = 'stale', bits, thresh, cancelCb }) {
  const { getOrderbook } = await import('./predict.js');
  const meta = LIST_KINDS[kind] ?? LIST_KINDS.stale;
  const total = ids.length;
  const results = new Map();
  const startedAt = Date.now();
  let done = 0;
  let timedOut = 0;
  let failed = 0;
  let lastEditAt = 0;
  let lastEditedDone = -1;
  let lastEditText = '';

  const renderProgress = (extraNote = '') => {
    const filled = Math.round((done / Math.max(1, total)) * 20);
    const bar = '▰'.repeat(filled) + '▱'.repeat(20 - filled);
    const pct = ((done / Math.max(1, total)) * 100).toFixed(0);
    const stuckTags = [];
    if (timedOut) stuckTags.push(`超时跳过 ${timedOut}`);
    if (failed) stuckTags.push(`其他错误 ${failed}`);
    const stuckLine = stuckTags.length ? ` · ${stuckTags.join(' · ')}` : '';
    return [
      `<b>${meta.title} · 重抓中…</b>`,
      '',
      `<code>${bar}</code> ${pct}%`,
      `进度 <b>${done}</b> / ${total}${stuckLine}${extraNote ? ` · ${extraNote}` : ''}`,
      '',
      `📐 ${LIST_LEVELS.filter((k) => parseStaleBits(bits)[k]).map((k) => LIST_LEVEL_LABELS[k]).join('+') || '未选层级'} · 💵 ${staleThreshLabel(thresh)}`,
    ].join('\n');
  };

  const cancelKb = {
    inline_keyboard: [[{
      text: '⏳ 取消（完成后忽略）',
      callback_data: cancelCb ?? `${kind}:cancel:${bits}:${thresh}:0`,
    }]],
  };

  // Initial paint so user sees the bar immediately
  try {
    const text0 = renderProgress();
    await editTelegramMessage(chatId, messageId, text0, cancelKb);
    lastEditAt = Date.now();
    lastEditText = text0;
  } catch {}

  const maybeEditProgress = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastEditAt < STALE_PROGRESS_EDIT_MIN_MS)) return;
    if (!force && done - lastEditedDone < STALE_PROGRESS_EDIT_EVERY) return;
    const text = renderProgress();
    // Don't burn an API call (and risk a 429) re-sending identical text.
    if (text === lastEditText) return;
    lastEditedDone = done;
    lastEditAt = now;
    try {
      // retries:0 — progress frames are disposable; if Telegram throttles
      // this edit, skip it rather than blocking the refetch loop for the
      // full retry_after window. The next throttled frame (or the forced
      // final edit) carries the latest state anyway.
      await editTelegramMessage(chatId, messageId, text, cancelKb, { retries: 0 });
      lastEditText = text;
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn('stale progress edit failed:', err.message);
      }
    }
  };

  // Wrap getOrderbook in a per-market hard timeout so a single misbehaving
  // market can't pin the whole batch at 99%.
  const fetchOne = async (id, slot) => {
    const orderbookKey = slot?.orderbookCache?.key ?? id;
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`per-market timeout (${STALE_PER_MARKET_TIMEOUT_MS / 1000}s)`)),
        STALE_PER_MARKET_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        getOrderbook(orderbookKey, {
          contextMarketId: id,
          cache: slot?.orderbookCache ?? null,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Simple "next index" worker pool. Stops feeding new markets once we
  // hit the global deadline; in-flight ones still finish (capped by the
  // per-market timeout above), so the worst-case finish is roughly
  // deadline + per-market timeout.
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < total) {
      if (Date.now() - startedAt > STALE_REFETCH_DEADLINE_MS) break;
      const i = nextIdx++;
      const id = ids[i];
      const slot = state.markets[id];
      try {
        const book = await fetchOne(id, slot);
        results.set(id, book);
        if (slot) {
          slot.recentBook = {
            bids: book.bids ?? [],
            asks: book.asks ?? [],
            fetchedAt: Date.now(),
          };
        }
      } catch (err) {
        if (/timeout/i.test(err.message ?? '')) timedOut += 1;
        else failed += 1;
        log(`[${id}] refetch failed: ${err.message}`);
      }
      done += 1;
      await maybeEditProgress();
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(STALE_REFETCH_CONCURRENCY, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  await maybeEditProgress(true);
  return { results, timedOut, failed, abandoned: total - done };
}

// Pending-input map: chatId-userId → { kind, bits, thresh, sort, dir, messageId, expiresAt }
// When user clicks "✏ 自定义" we stash this and the next plain message in
// the same chat (within 5 min) gets parsed as the custom threshold.
const PENDING_FILTER_INPUT_MS = 5 * 60 * 1000;
const pendingFilterInput = new Map();
const pendingKey = (chatId, userId) => `${chatId}-${userId}`;

function setPendingFilterInput(chatId, userId, payload) {
  pendingFilterInput.set(pendingKey(chatId, userId), {
    ...payload,
    expiresAt: Date.now() + PENDING_FILTER_INPUT_MS,
  });
}
function consumePendingFilterInput(chatId, userId) {
  const k = pendingKey(chatId, userId);
  const v = pendingFilterInput.get(k);
  if (!v) return null;
  pendingFilterInput.delete(k);
  if (v.expiresAt < Date.now()) return null;
  return v;
}

export async function handleListFilterCallback(data, { chatId, messageId, fromId, state, fullCtx }) {
  // data shape: <kind>:<action>:<bits>:<thresh>:<sort>:<dir>:<ext>:<page>
  // Back-compat:
  //   7-part (pre-ext): <kind>:<action>:<bits>:<thresh>:<sort>:<dir>:<page>
  //   6-part (pre-dir): <kind>:<action>:<bits>:<thresh>:<sort>:<page>
  //   5-part (pre-sort/pre-dir): stale:<action>:<bits>:<thresh>:<page>
  const parts = data.split(':');
  const kind = parts[0];
  if (!(kind in LIST_KINDS)) return false;
  const meta = LIST_KINDS[kind];
  let action, bits, thresh, sort, dir, ext, pageStr;
  if (parts.length >= 8) {
    [, action, bits, thresh, sort, dir, ext, pageStr] = parts;
  } else if (parts.length >= 7) {
    [, action, bits, thresh, sort, dir, pageStr] = parts;
    ext = 'off';
  } else if (parts.length >= 6) {
    [, action, bits, thresh, sort, pageStr] = parts;
    dir = 'le';
    ext = 'off';
  } else {
    [, action, bits, thresh, pageStr] = parts;
    sort = meta.defaultSort;
    dir = 'le';
    ext = 'off';
  }
  const safeBits = /^[01]{6}$/.test(bits) ? bits : '100100';
  // Accept preset OR custom (positive integer string).
  const safeThresh = (LIST_THRESHOLDS.includes(thresh) || isCustomThresh(thresh))
    ? thresh : 'inf';
  const safeSort = LIST_SORTS.includes(sort) ? sort : meta.defaultSort;
  const safeDir = LIST_DIRS.includes(dir) ? dir : 'le';
  const safeExt = normalizeExt(ext);
  const page = Math.max(0, Number(pageStr) || 0);
  const filter = { bits: safeBits, thresh: safeThresh, sort: safeSort, dir: safeDir, ext: safeExt };

  if (action === 'wizard' || action === 'set') {
    // Selecting a custom 极端价 value (from the picker card or its retained
    // button) keeps it available as a button next time.
    if (action === 'set' && isCustomExt(safeExt)) {
      rememberCustomExtPreset(state, safeExt);
      if (fullCtx?.persist) fullCtx.persist().catch((err) => warn('ext preset persist failed:', err.message));
    }
    try {
      await editTelegramMessage(
        chatId,
        messageId,
        listWizardText(kind, safeBits, safeThresh, safeSort, safeDir, safeExt),
        listWizardKeyboard(kind, safeBits, safeThresh, safeSort, safeDir, safeExt, state.customExtPresets),
      );
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn(`${kind} wizard edit failed:`, err.message);
      }
    }
    return true;
  }

  if (action === 'ext-clear') {
    // Drop all remembered custom 极端价 values and re-render the wizard.
    if (Array.isArray(state.customExtPresets) && state.customExtPresets.length) {
      state.customExtPresets = [];
      if (fullCtx?.persist) fullCtx.persist().catch((err) => warn('ext-clear persist failed:', err.message));
    }
    // If the active filter was one of the cleared customs, fall back to "off".
    const nextExt = isCustomExt(safeExt) ? 'off' : safeExt;
    try {
      await editTelegramMessage(
        chatId,
        messageId,
        listWizardText(kind, safeBits, safeThresh, safeSort, safeDir, nextExt),
        listWizardKeyboard(kind, safeBits, safeThresh, safeSort, safeDir, nextExt, state.customExtPresets),
      );
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn(`${kind} ext-clear edit failed:`, err.message);
      }
    }
    return true;
  }

  if (action === 'ext-pick' || action === 'thresh-pick') {
    // Open a tap-to-choose value card instead of forcing a typed reply.
    const field = action === 'ext-pick' ? 'ext' : 'thresh';
    const kb = field === 'ext'
      ? extPickerKeyboard(kind, safeBits, safeThresh, safeSort, safeDir, safeExt)
      : threshPickerKeyboard(kind, safeBits, safeThresh, safeSort, safeDir, safeExt);
    try {
      await editTelegramMessage(chatId, messageId, pickerCardText(kind, field), kb);
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn(`${kind} ${field}-pick edit failed:`, err.message);
      }
    }
    return true;
  }

  if (action === 'custom' || action === 'custom-ext') {
    // Stash pending-input state and edit wizard with a "waiting for input" hint.
    // Next plain message in this chat from this user gets treated as the new
    // value (parsed as a positive integer). field=thresh for the $ knob,
    // field=ext for the 极端价 knob.
    const field = action === 'custom-ext' ? 'ext' : 'thresh';
    setPendingFilterInput(chatId, fromId, {
      kind, field, bits: safeBits, thresh: safeThresh, sort: safeSort, dir: safeDir, ext: safeExt, messageId,
    });
    try {
      const meta2 = LIST_KINDS[kind] ?? LIST_KINDS.stale;
      const promptUnit = field === 'ext'
        ? '极端价百分位(1-99,例如 94 = 排除 ≥94¢ 或 ≤6¢ 的市场)'
        : 'USD 金额,例如 350';
      const hint = [
        `<b>${meta2.title} · 等待自定义${field === 'ext' ? '极端价' : '阈值'}…</b>`,
        '',
        `请直接在这个 chat <b>回复一个数字</b>(${promptUnit})。`,
        '',
        `当前选: 📐 ${LIST_LEVELS.filter((k) => parseStaleBits(safeBits)[k]).map((k) => LIST_LEVEL_LABELS[k]).join('+') || '未选层级'} · 💵 ${staleThreshLabel(safeThresh, safeDir)} · 📈 ${extLabel(safeExt)} · 📊 ${LIST_SORT_LABELS[safeSort]}`,
        '',
        '<i>5 分钟内有效。想取消就发任何非数字。</i>',
      ].join('\n');
      const cancelKb = {
        inline_keyboard: [[{
          text: '✖ 取消(回到向导)',
          callback_data: `${kind}:wizard:${safeBits}:${safeThresh}:${safeSort}:${safeDir}:${safeExt}:0`,
        }]],
      };
      await editTelegramMessage(chatId, messageId, hint, cancelKb);
    } catch {}
    return true;
  }

  if (action === 'cancel') {
    // Restore the plain leaderboard without filter.
    const reply = renderListPage(kind, 0, state);
    if (reply) {
      try {
        await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
      } catch {}
    }
    return true;
  }

  if (action === 'page') {
    const reply = renderListPage(kind, page, state, filter);
    if (reply) {
      try {
        await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
      } catch (err) {
        if (!/message is not modified/i.test(err.message ?? '')) {
          warn(`${kind} page edit failed:`, err.message);
        }
      }
    }
    return true;
  }

  if (action === 'run') {
    // Refetch the orderbook when a filter that depends on live book data is
    // active: the depth-sum filter (needs every level) OR the 极端价 filter
    // (its bid/ask must match the orderbook the user opens, which is fetched
    // live). Pure sort changes stay a 1-tap instant re-render off the cache.
    const needsRefetch = staleFilterIsActive(safeBits, safeThresh) || extFilterActive(safeExt);
    if (!needsRefetch) {
      const reply = renderListPage(kind, 0, state, filter);
      if (reply) {
        try {
          await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
        } catch (err) {
          if (!/message is not modified/i.test(err.message ?? '')) {
            warn(`${kind} sort-only render failed:`, err.message);
          }
        }
      }
      return true;
    }
    const ids = activeMarketIds(state);
    if (!ids.length) {
      try {
        await editTelegramMessage(chatId, messageId, '当前没有监控的市场。', undefined);
      } catch {}
      return true;
    }
    const refetch = await refetchOrderbooksWithProgress({
      ids, state, chatId, messageId,
      kind, bits: safeBits, thresh: safeThresh,
    });
    // Intermediate "refetch done, rendering" state. Without this, if
    // renderListPage or the final edit hangs, the user sees "重抓中…"
    // forever and can't tell whether the workers are still going or
    // we're just stuck rendering. Best-effort — failures here are
    // ignored, the final edit below is what matters.
    try {
      const tagsMid = [];
      if (refetch.timedOut) tagsMid.push(`${refetch.timedOut} 超时`);
      if (refetch.failed) tagsMid.push(`${refetch.failed} 错误`);
      const tail = tagsMid.length ? ` · ${tagsMid.join(' · ')} 跳过` : '';
      await editTelegramMessage(
        chatId, messageId,
        `<b>${(LIST_KINDS[kind] ?? LIST_KINDS.stale).title} · 重抓完成</b>\n\n进度 ${refetch.results.size + (refetch.timedOut ?? 0) + (refetch.failed ?? 0)} / ${ids.length}${tail}\n\n<i>正在筛选 + 排序 + 渲染…</i>`,
        undefined,
      );
    } catch {}
    // Persist runs in the background — don't block the render path on
    // disk I/O. If the state file is large (1k+ markets × recentBook
    // each), JSON.stringify + fs.write can take a while, but it's not
    // worth pinning the UI on it.
    if (fullCtx?.persist) {
      fullCtx.persist().catch((err) => warn(`${kind} persist failed:`, err.message));
    }
    let reply;
    try {
      reply = renderListPage(kind, 0, state, filter);
    } catch (err) {
      warn(`${kind} renderListPage threw:`, err.message);
      try {
        await editTelegramMessage(
          chatId, messageId,
          `<b>⚠ 渲染失败</b>\n\n重抓本身完成 (${ids.length} 个市场),但生成列表时报错: <code>${htmlEscape(err.message)}</code>\n\n请直接发 /${kind} 查看(数据已存)。`,
          undefined,
        );
      } catch {}
      return true;
    }
    if (reply) {
      const tags = [];
      if (refetch.timedOut) tags.push(`${refetch.timedOut} 超时`);
      if (refetch.failed) tags.push(`${refetch.failed} 错误`);
      const prefix = tags.length
        ? `<i>⚠ 重抓: ${tags.join(' · ')} 跳过 (这些市场不会出现在筛选结果里)</i>\n\n`
        : '';
      // Hard timeout on the final edit itself so a hung Telegram call
      // can't lock the UI in "渲染中" state forever.
      const editPromise = editTelegramMessage(chatId, messageId, prefix + reply.text, reply.replyMarkup);
      const timeoutPromise = new Promise((_, rej) => setTimeout(
        () => rej(new Error('post-refetch edit timeout (30s)')),
        30_000,
      ));
      try {
        await Promise.race([editPromise, timeoutPromise]);
      } catch (err) {
        warn(`${kind} post-refetch render failed:`, err.message);
        try {
          await editTelegramMessage(
            chatId, messageId,
            `<b>⚠ 渲染超时</b>\n\n重抓完成 (${ids.length} 个),但 Telegram edit 失败: <code>${htmlEscape(err.message)}</code>\n\n请直接发 /${kind} 查看。`,
            undefined,
          );
        } catch {}
      }
    } else {
      // renderListPage returned null — shouldn't happen for known kinds
      try {
        await editTelegramMessage(
          chatId, messageId,
          `重抓完成,但 renderListPage 返回空。请发 /${kind} 重看。`,
          undefined,
        );
      } catch {}
    }
    return true;
  }

  return true;
}

// ---------- /movers: PP/h rate-change view ----------
// Reads history 'rate' events over a window, computes baseline (earliest
// rate in window) vs current (live state, catches drops to 0), and lists
// markets whose PP/h moved. Window is user-customizable.
const MOVERS_WIN_PRESETS = [30, 60, 180, 360, 720, 1440]; // minutes
const MOVERS_DEFAULT_MIN = 60;
const MOVERS_PAGE_SIZE = 10;

function moversWinLabel(min) {
  if (min < 60) return `${min}m`;
  if (min % 60 === 0) {
    const h = min / 60;
    return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
  }
  return `${(min / 60).toFixed(1)}h`;
}

async function buildMoversRows(state, windowMin) {
  const { readHistorySince, rateMovers } = await import('./history.js');
  const since = Date.now() - windowMin * 60_000;
  const records = await readHistorySince(since);
  const movers = rateMovers(records, (id) => state.markets?.[id]?.lastHourlyRate);
  // Enrich with title/question/slug from live state for rendering links.
  return movers.map((m) => ({
    ...m,
    title: m.title ?? state.markets?.[m.id]?.title ?? null,
    question: state.markets?.[m.id]?.question ?? null,
    slug: state.markets?.[m.id]?.slug ?? null,
  }));
}

function moversKeyboard(windowMin, page, totalPages, openUrls) {
  const rows = [];
  // Window preset row.
  rows.push(MOVERS_WIN_PRESETS.map((m) => ({
    text: m === windowMin ? `✅ ${moversWinLabel(m)}` : moversWinLabel(m),
    callback_data: `mv:win:${m}`,
  })));
  // Pagination row.
  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ 上一页', callback_data: `mv:page:${windowMin}:${page - 1}` });
    nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'page:noop' });
    if (page < totalPages - 1) nav.push({ text: '➡️ 下一页', callback_data: `mv:page:${windowMin}:${page + 1}` });
    rows.push(nav);
  }
  // Open-in-browser buttons.
  if (Array.isArray(openUrls) && openUrls.length) {
    const CHUNK = 5;
    for (let i = 0; i < openUrls.length; i += CHUNK) {
      rows.push(openUrls.slice(i, i + CHUNK).map((u, j) => ({ text: `🌐 ${i + j + 1}`, url: u })));
    }
  }
  return { inline_keyboard: rows };
}

async function renderMoversPage(state, windowMin, page = 0) {
  const allRows = await buildMoversRows(state, windowMin);
  const winLabel = moversWinLabel(windowMin);
  if (!allRows.length) {
    return {
      text: `📈 <b>近 ${winLabel} PP/h 变动</b>\n\n<i>这段时间没有费率变动的市场。换个时间窗口试试。</i>`,
      replyMarkup: moversKeyboard(windowMin, 0, 1, null),
    };
  }
  const totalPages = Math.max(1, Math.ceil(allRows.length / MOVERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * MOVERS_PAGE_SIZE;
  const items = allRows.slice(start, start + MOVERS_PAGE_SIZE);
  const pageTag = totalPages > 1 ? ` · 第 ${safePage + 1}/${totalPages} 页` : '';
  const lines = [`📈 <b>近 ${winLabel} PP/h 变动</b> <i>(${items.length} / ${allRows.length}${pageTag})</i>`, ''];
  for (const r of items) {
    const arrow = r.delta > 0 ? '📈' : '📉';
    const sign = r.delta > 0 ? '+' : '';
    const display = r.title || r.question || `Market ${r.id}`;
    const safeTitle = htmlEscape(shortTitle(display, 40));
    const url = marketUrl(r.id, r.title, r.question, r.slug);
    lines.push(`<code>#${htmlEscape(r.id)}</code> ${arrow} <b>${r.baseline.toFixed(0)}→${r.current.toFixed(0)}</b>/h (${sign}${r.delta.toFixed(0)})`);
    lines.push(`   <a href="${url}">${safeTitle}</a>`);
    // Parent event question for outcome-name markets ("$50M" / "Up").
    if (r.question && r.question !== r.title) {
      lines.push(`   <i>${htmlEscape(shortTitle(r.question, 56))}</i>`);
    }
  }
  const openUrls = items.map((r) => marketUrl(r.id, r.title, r.question, r.slug));
  return { text: lines.join('\n'), replyMarkup: moversKeyboard(windowMin, safePage, totalPages, openUrls) };
}

// "🔇 静音此阶梯" button on a price_sanity alert. The button carries the
// ladder's short token; we resolve its current context for a friendly
// confirmation, then persist the mute so checkPriceSanity skips it.
export async function handlePriceSanityMuteCallback(data, { chatId, state, fullCtx }) {
  if (!data.startsWith('psmute:')) return false;
  const token = data.slice('psmute:'.length).trim();
  if (!token) return true;
  state.priceSanityMuted = state.priceSanityMuted ?? {};
  const entry = { mutedAt: Date.now(), context: null };
  try {
    const { collectLadders } = await import('./monitor.js');
    const l = collectLadders(state).find((x) => x.token === token);
    if (l) {
      entry.key = l.key;
      entry.context = l.context.replace(/\s+/g, ' ').trim();
    }
  } catch {}
  state.priceSanityMuted[token] = entry;
  await fullCtx.persist().catch(() => {});
  const label = entry.context
    ? `「${htmlEscape(shortTitle(entry.context, 40))}」`
    : `token <code>${htmlEscape(token)}</code>`;
  await sendTelegramMessage(
    `🔇 已静音此阶梯 ${label}。\n不再推送其定价异常提醒；/sanity 仍可查看，<code>/sanity unmute ${htmlEscape(token)}</code> 恢复。`,
    { chatId },
  ).catch(() => {});
  return true;
}

export async function handleMoversCallback(data, { chatId, messageId, state }) {
  if (!data.startsWith('mv:')) return false;
  const [, action, a, b] = data.split(':');
  let windowMin = MOVERS_DEFAULT_MIN;
  let page = 0;
  if (action === 'win') {
    windowMin = Number(a) || MOVERS_DEFAULT_MIN;
  } else if (action === 'page') {
    windowMin = Number(a) || MOVERS_DEFAULT_MIN;
    page = Math.max(0, Number(b) || 0);
  } else {
    return true;
  }
  const reply = await renderMoversPage(state, windowMin, page);
  try {
    await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
  } catch (err) {
    if (!/message is not modified/i.test(err.message ?? '')) {
      warn('movers callback edit failed:', err.message);
    }
  }
  return true;
}

// Back-compat export — index.js dispatcher imported handleStaleFilterCallback
// before /all existed. Keep this alias so the old import keeps working.
export const handleStaleFilterCallback = handleListFilterCallback;

// Settings panel for the hourly digest — rendered by /hourly (no arg) and
// edited in place by the hd:only / hd:ext toggles. Button-driven so it works
// in groups (callbacks bypass Telegram's group privacy mode, which would
// otherwise swallow plain "/hourly only on" text without an @botname).
function hourlySettingsText(state) {
  const onlyOn = !!state.hourlyDigestOnly;
  const ext = Number.isFinite(state.hourlyDigestExtExclude) ? state.hourlyDigestExtExclude : 94;
  return [
    '⏱ <b>整点摘要设置</b>',
    '',
    `🔕 只收摘要(屏蔽逐条提醒): <b>${onlyOn ? '开' : '关'}</b>`,
    `📈 排除极端价(一边 ≥N¢): <b>${ext > 0 ? `≥${ext}¢` : '关'}</b>`,
    '',
    '<i>每 UTC 整点自动汇总一次。下面按钮可调,群里也能点。</i>',
  ].join('\n');
}

function hourlySettingsKeyboard(state) {
  const onlyOn = !!state.hourlyDigestOnly;
  const ext = Number.isFinite(state.hourlyDigestExtExclude) ? state.hourlyDigestExtExclude : 94;
  const extMark = (n) => `${n === ext ? '✅ ' : ''}${n === 0 ? '关' : `≥${n}¢`}`;
  return {
    inline_keyboard: [
      [{
        text: onlyOn ? '✅ 只收摘要(不收逐条)' : '⬜ 只收摘要(不收逐条)',
        callback_data: `hd:only:${onlyOn ? 0 : 1}`,
      }],
      [
        { text: extMark(0), callback_data: 'hd:ext:0' },
        { text: extMark(94), callback_data: 'hd:ext:94' },
        { text: extMark(90), callback_data: 'hd:ext:90' },
        { text: extMark(85), callback_data: 'hd:ext:85' },
      ],
      [{ text: '🚀 立即发送一次', callback_data: 'hd:send' }],
    ],
  };
}

// Callbacks for the hourly digest:
//   hd:p:<startMsBase36>:<page>  — pagination of an already-sent digest
//   hd:only:<0|1>                — toggle digest-only mode
//   hd:ext:<N>                   — set extreme-price exclusion (0 = off)
//   hd:send                      — trigger a manual pulse now
export async function handleHourlyDigestCallback(data, { chatId, messageId, state, fullCtx }) {
  if (!data.startsWith('hd:')) return false;
  const [, action, a, b] = data.split(':');

  if (action === 'only' || action === 'ext') {
    if (action === 'only') {
      state.hourlyDigestOnly = a === '1';
    } else {
      const n = Number(a);
      state.hourlyDigestExtExclude = Number.isFinite(n) ? n : 0;
    }
    if (fullCtx?.persist) await fullCtx.persist().catch(() => {});
    try {
      await editTelegramMessage(chatId, messageId, hourlySettingsText(state), hourlySettingsKeyboard(state));
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn('hourly settings edit failed:', err.message);
      }
    }
    return true;
  }

  if (action === 'send') {
    if (typeof fullCtx?.requestHourlyDigest === 'function') fullCtx.requestHourlyDigest();
    try {
      await editTelegramMessage(
        chatId, messageId,
        `${hourlySettingsText(state)}\n\n<i>已触发,下一 tick 发出整点摘要。</i>`,
        hourlySettingsKeyboard(state),
      );
    } catch {}
    return true;
  }

  // Default: pagination (hd:p:<startMsBase36>:<page>).
  if (action !== 'p') return true;
  const startMs = parseInt(a, 36);
  const page = Math.max(0, Number(b) || 0);
  if (!Number.isFinite(startMs) || startMs <= 0) return true;
  const endMs = startMs + 3600 * 1000;
  const { buildHourlyDigest } = await import('./digest.js');
  const built = await buildHourlyDigest(state, startMs, endMs, page);
  if (built.text == null) return true;
  try {
    await editTelegramMessage(chatId, messageId, built.text, built.replyMarkup);
  } catch (err) {
    if (!/message is not modified/i.test(err.message ?? '')) {
      warn('hourly digest page edit failed:', err.message);
    }
  }
  return true;
}

// Edit-in-place callback handler for the /new wizard. Callback shape:
//   new:<action>:<winH>:<minRate>:<minRem>:<sort>:<page>
// Actions: wizard / set / custom-win / custom-rate / custom-rem / page /
//          run / cancel.
export async function handleNewWizardCallback(data, { chatId, messageId, fromId, state, fullCtx }) {
  if (!data.startsWith('new:')) return false;
  // Callback shape:
  //   new:<action>:<winH>:<minRate>:<minRem>:<bits>:<thresh>:<dir>:<sort>:<noUpDown>:<page>
  // (11 parts). Older callbacks with fewer fields still parse via
  // parseNewFilter's default fallbacks; the page is always the LAST part.
  const parts = data.split(':');
  if (parts.length < 3) return true;
  const action = parts[1];
  // Filter fields are everything between the action and the trailing page.
  const f = parseNewFilter(parts.slice(2, parts.length - 1));
  const page = Math.max(0, Number(parts[parts.length - 1]) || 0);

  if (action === 'wizard' || action === 'set') {
    try {
      await editTelegramMessage(chatId, messageId, newWizardText(f), newWizardKeyboard(f));
    } catch (err) {
      if (!/message is not modified/i.test(err.message ?? '')) {
        warn('new wizard edit failed:', err.message);
      }
    }
    return true;
  }

  if (action === 'custom-win' || action === 'custom-rate' || action === 'custom-rem' || action === 'custom-thresh') {
    // Stash pending-input state; next plain message from this user in this
    // chat is parsed as the value. Field tells the input handler which knob
    // to update.
    const field = action.replace('custom-', ''); // 'win' | 'rate' | 'rem' | 'thresh'
    setPendingFilterInput(chatId, fromId, {
      kind: 'new', field, messageId,
      winH: f.winH, minRate: f.minRate, minRem: f.minRem,
      bits: f.bits, thresh: f.thresh, dir: f.dir, sort: f.sort,
    });
    let unit;
    if (field === 'rate') unit = 'PP/h 数值(如 750)';
    else if (field === 'thresh') unit = 'USD 金额(如 350)';
    else unit = '小时(如 36, 最长 720)';
    try {
      const dirOp = LIST_DIR_OP[f.dir] ?? '≤';
      const threshLabel = f.thresh === 'inf' ? '不限' : `${dirOp}$${f.thresh}`;
      const hint = [
        '<b>🆕 新上市场 · 等待自定义值…</b>',
        '',
        `请在这个 chat <b>回复一个数字</b>(${unit})。`,
        '',
        `当前: ⏰ ${fmtHoursLabel(f.winH)} · 💰 ${fmtRateLabel(f.minRate)} · ⌛ ${fmtHoursLabel(f.minRem)} · 💵 ${threshLabel} · 📊 ${NEW_SORT_LABELS[f.sort]}`,
        '',
        '<i>5 分钟内有效。想取消就发任何非数字。</i>',
      ].join('\n');
      const [w, r, m, b, t, d, s] = newFilterToCbParts(f);
      const cancelKb = {
        inline_keyboard: [[{
          text: '✖ 取消(回到向导)',
          callback_data: `new:wizard:${w}:${r}:${m}:${b}:${t}:${d}:${s}:0`,
        }]],
      };
      await editTelegramMessage(chatId, messageId, hint, cancelKb);
    } catch {}
    return true;
  }

  if (action === 'cancel') {
    const reply = renderListPage('new', 0, state);
    if (reply) {
      try {
        await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
      } catch {}
    }
    return true;
  }

  if (action === 'page') {
    const reply = renderListPage('new', page, state, f);
    if (reply) {
      try {
        await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
      } catch (err) {
        if (!/message is not modified/i.test(err.message ?? '')) {
          warn('new page edit failed:', err.message);
        }
      }
    }
    return true;
  }

  if (action === 'run') {
    // No depth filter → render straight from cached data. Window + minRate
    // + minRem + sort all work off firstSeen snapshot + slot, no refetch.
    if (!newDepthFilterActive(f)) {
      const reply = renderListPage('new', 0, state, f);
      if (reply) {
        try {
          await editTelegramMessage(chatId, messageId, reply.text, reply.replyMarkup);
        } catch (err) {
          if (!/message is not modified/i.test(err.message ?? '')) {
            warn('new sort-only render failed:', err.message);
          }
        }
      }
      return true;
    }
    // Depth filter active — refetch orderbooks for markets in the time
    // window only (narrower than /stale which refetches everything). Then
    // render with the depth filter applied via renderListPage.
    const cutoff = Date.now() - f.winH * 3600 * 1000;
    const firstSeen = state.marketFirstSeen ?? {};
    const ids = Object.entries(firstSeen)
      .filter(([, info]) => {
        const ms = typeof info === 'number' ? info : info?.ms;
        return Number.isFinite(ms) && ms > 0 && ms >= cutoff;
      })
      .map(([id]) => id)
      .filter((id) => state.markets[id] != null); // need slot for orderbookCache
    if (!ids.length) {
      try {
        await editTelegramMessage(
          chatId, messageId,
          `<b>🆕 新上市场</b>\n\n近 ${fmtHoursLabel(f.winH)} 没有可重抓的新市场(可能都还在等首抓)。`,
          undefined,
        );
      } catch {}
      return true;
    }
    const [w, r, m, b, t, d, s] = newFilterToCbParts(f);
    const refetch = await refetchOrderbooksWithProgress({
      ids, state, chatId, messageId,
      kind: 'new', bits: f.bits, thresh: f.thresh,
      cancelCb: `new:cancel:${w}:${r}:${m}:${b}:${t}:${d}:${s}:0`,
    });
    try {
      const tagsMid = [];
      if (refetch.timedOut) tagsMid.push(`${refetch.timedOut} 超时`);
      if (refetch.failed) tagsMid.push(`${refetch.failed} 错误`);
      const tail = tagsMid.length ? ` · ${tagsMid.join(' · ')} 跳过` : '';
      await editTelegramMessage(
        chatId, messageId,
        `<b>🆕 新上市场 · 重抓完成</b>\n\n进度 ${refetch.results.size + (refetch.timedOut ?? 0) + (refetch.failed ?? 0)} / ${ids.length}${tail}\n\n<i>正在筛选 + 排序 + 渲染…</i>`,
        undefined,
      );
    } catch {}
    if (fullCtx?.persist) {
      fullCtx.persist().catch((err) => warn(`new persist failed:`, err.message));
    }
    let reply;
    try {
      reply = renderListPage('new', 0, state, f);
    } catch (err) {
      warn(`new renderListPage threw:`, err.message);
      try {
        await editTelegramMessage(
          chatId, messageId,
          `<b>⚠ 渲染失败</b>\n\n重抓本身完成 (${ids.length} 个),但生成列表时报错: <code>${htmlEscape(err.message)}</code>\n\n请直接发 /new 查看(数据已存)。`,
          undefined,
        );
      } catch {}
      return true;
    }
    if (reply) {
      const tags = [];
      if (refetch.timedOut) tags.push(`${refetch.timedOut} 超时`);
      if (refetch.failed) tags.push(`${refetch.failed} 错误`);
      const prefix = tags.length
        ? `<i>⚠ 重抓: ${tags.join(' · ')} 跳过 (这些市场不会出现在筛选结果里)</i>\n\n`
        : '';
      const editPromise = editTelegramMessage(chatId, messageId, prefix + reply.text, reply.replyMarkup);
      const timeoutPromise = new Promise((_, rej) => setTimeout(
        () => rej(new Error('post-refetch edit timeout (30s)')),
        30_000,
      ));
      try {
        await Promise.race([editPromise, timeoutPromise]);
      } catch (err) {
        warn(`new post-refetch render failed:`, err.message);
        try {
          await editTelegramMessage(
            chatId, messageId,
            `<b>⚠ 渲染超时</b>\n\n重抓完成 (${ids.length} 个),但 Telegram edit 失败: <code>${htmlEscape(err.message)}</code>\n\n请直接发 /new 查看。`,
            undefined,
          );
        } catch {}
      }
    }
    return true;
  }

  return true;
}

const HELP = [
  '<b>📊 核心</b>',
  '/menu — 快捷按钮菜单',
  '/help — 本帮助（你正在看的就是）',
  '/status — 监控面板（市场数 + 总 PP/h + 机会数）',
  '/config — 当前阈值 / 过滤器 / 覆盖 / 白名单',
  '',
  '<b>🔍 找机会</b>（榜单支持翻页）',
  '/find — 自定义筛选向导（PP/h × 剩余 × 类型 × 中价 × 排序 × 上限）',
  '/top — PP/h 排行',
  '/gaps — 奖励区可激活（PP 待捡）',
  '/thin — 薄盘市场（买1+卖1 总额 &lt; 阈值）',
  '/wide — 当前价差最大',
  '/empty — 单边/空簿',
  '/stale — 停滞时长排名（含未到 staleHours 阈值的；底部 🎚 过滤 = 重抓 orderbook + 按 sum 阈值筛）',
  '/all — 全部监控市场（包括暂停/跳过/错误的；同款过滤+排序向导）',
  '/new — 今日新上的有奖励市场（默认 24h；底部 🎚 可调窗口/最低 PP/h/最短剩余/盘口层级×总额/排序；开盘口过滤会重抓 orderbook；只显示当前有 PP 的）',
  '/movers — PP/h 变动的市场（默认近 1h；底部按钮切换 30m/1h/3h/6h/12h/1d；显示 旧→新 费率 + 涨跌）',
  '/sanity（/arb）— 定价异常的阈值阶梯（如市值 30亿/40亿/50亿；相邻档差 ≤ PRICE_SANITY_MARGIN 即列出，按锁定套利金额排序，全部展开）。/sanity ext 94 排除已决极端价 · /sanity ext off 关闭 · /sanity unmute all 解除静音',
  '/ladders — 全部识别到的阈值阶梯（含定价正常的，便于核对自动分组是否准确）',
  '/opportunities — 机会评分（实验）',
  '',
  '<b>🎯 单市场操作</b>',
  '<i>admin 私聊里粘 URL 或数字 id 直接出操作菜单</i>',
  '/probe &lt;id&gt; — 单市场详情卡片 + 动作按钮',
  '/add &lt;id|slug|url&gt; — 加入监控',
  '/remove &lt;id&gt; — 永久移除',
  '/watch &lt;id&gt; — 密集追踪（任何变动都推到 admin DM）',
  '/watched — 列出所有追踪中的市场',
  '/unwatch &lt;id|all&gt; — 取消追踪',
  '/snapshot [id interval | id off | (空)] — 定时盘口快照（仅 admin DM）',
  '',
  '<b>🔇 静音 / 降噪</b>',
  '/snooze &lt;id&gt; &lt;30m|2h|1d&gt; — 单市场临时静',
  '/pause &lt;id&gt; · /resume &lt;id&gt; — 单市场静音 / 恢复',
  '/quiet [duration | off] — 全局临时静音（默认 2h）',
  '/alerts [on|off|only &lt;kind&gt;|reset] — 全局类型开关（only = 只看这一种）',
  '/route [on|off|only &lt;kind&gt;|reset] — 当前 chat 独立路由',
  '/digest-mode [interval | off] — 当前 chat 改批量摘要',
  '<i>kind: stall / mid_jump / wide_spread / reward_zone / empty_book</i>',
  '',
  '<b>⚙️ 阈值 / 过滤器</b>',
  '/setmarket &lt;id&gt; &lt;key&gt; &lt;value&gt; — 市场专属阈值（覆盖 REST）',
  '/clearmarket &lt;id&gt; — 清除覆盖',
  '/filter — 当前过滤器 + 命中效果（通过 / 被挡）',
  '/setfilter &lt;name&gt; &lt;value&gt; — 设置过滤器',
  '/clearfilter &lt;name|all&gt; — 清除过滤器',
  '<i>过滤器字段: min/max + Bid/Ask + 1/2/3 + Price/Size，派生 mid/spread/topUsd/totalUsd 和 requireXRewardGap</i>',
  '',
  '<b>🔄 维护 / 批量</b>',
  '/discover — 立即触发自动发现',
  '/diagdiscover — 对比 REST/GraphQL 两个发现源（监控数量看着不对时用）',
  '/refresh — 立即刷新 PP/h 缓存',
  '/digest — 立即发送 24h 摘要',
  '/hourly — 整点摘要设置面板(按钮:只收摘要开关 / 排除极端价 / 立即发送)；群里也能点。文字快捷:/hourly only on|off · /hourly ext 94|off · /hourly now',
  '/scan &lt;minRate&gt; &lt;minRem&gt; — 自定义筛选 + 替换 watchlist',
  '',
  '<b>👥 权限 / 群组</b>',
  '<i>以下仅 admin 用</i>',
  '/activate — 在当前 chat 激活机器人（群里发 /activate@&lt;botname&gt;）',
  '/deactivate — 从白名单移除当前 chat',
  '/whitelist [list|add &lt;id&gt;|remove &lt;id&gt;] — 管理白名单',
  '',
  '<b>群组使用</b>',
  '1. 把机器人加入群（自动收到欢迎消息）',
  '2. admin 在群里发 /activate@&lt;botname&gt;',
  '3. 群里所有命令必须带 @&lt;botname&gt; 后缀（Telegram 隐私模式）',
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
    lines.push(`  买${i + 1}: ${fmtCents(b.price)} × ${b.size}`);
  }
  lines.push('<b>卖盘</b>');
  if (!ob.asks.length) lines.push('  (空)');
  for (let i = 0; i < ob.asks.length; i++) {
    const a = ob.asks[i];
    lines.push(`  卖${i + 1}: ${fmtCents(a.price)} × ${a.size}`);
  }
  lines.push('');
  lines.push(`mid: ${mid != null ? fmtCents(mid) : 'n/a'}  ·  spread: ${spread != null ? `${(spread * 100).toFixed(2)}¢` : 'n/a'}`);
  const srcLabel = (s) => s === 'override' ? '覆盖' : s === 'rest' ? 'REST' : 'env';
  lines.push(`奖励区: ±${(zone.maxDistance * 100).toFixed(1)}¢ / size ≥ ${zone.minSize}  (距离: ${srcLabel(zone.maxSource)}, size: ${srcLabel(zone.sizeSource)})`);
  lines.push(`  买侧: ${zone.bidActivated ? '✓ 激活' : `✗ ${htmlEscape(zone.bidReason ?? '未激活')}`}`);
  lines.push(`  卖侧: ${zone.askActivated ? '✓ 激活' : `✗ ${htmlEscape(zone.askReason ?? '未激活')}`}`);
  // If this market is one rung of a detected threshold ladder, show the whole
  // curve + any mispricing so the user sees it in the context of its siblings.
  try {
    const { collectLadders, formatPriceSanityLadder } = await import('./monitor.js');
    const ladder = collectLadders(state ?? {})
      .find((l) => l.rungs.some((r) => r.id === String(marketId)));
    if (ladder) {
      lines.push('');
      lines.push(ladder.violations.length
        ? `⚠️ <b>所在阶梯（定价异常，差 ${(ladder.minGap * 100).toFixed(1)}¢${ladder.arbUsd > 0 ? ` · 套利≈$${ladder.arbUsd.toFixed(0)}` : ''}）</b>`
        : '🪜 <b>所在阶梯（定价正常）</b>');
      lines.push(formatPriceSanityLadder(ladder, config.priceSanityMargin));
    }
  } catch {}
  // Same action menu shown after URL paste — one tap to /watch /
  // /snapshot / /add this market.
  return { text: lines.join('\n'), replyMarkup: actionKeyboard(marketId) };
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

// Two-/three-line opportunity row used by every list command. Top line is
// the comparable metric strip (PP/h, remaining, gap, spread, depth,
// per-list extra); second line is the clickable option title; third line
// (when question differs from title) is the parent event question in
// italic — for outcome-name markets like "NVIDIA" / "Argentina" the
// option alone doesn't tell the user what the bet is actually about.
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

  const titleRaw = slot?.title ?? '';
  const questionRaw = slot?.question ?? '';
  // Suppress the event line when it's the same as the title or empty —
  // otherwise it's just visual noise.
  const showQuestion = questionRaw && questionRaw !== titleRaw;
  const lines = [parts.join(' · '), `   ${linked}`];
  if (showQuestion) {
    lines.push(`   <i>${htmlEscape(shortTitle(questionRaw, 80))}</i>`);
  }
  return lines.join('\n');
}

// --- Pagination helpers for /top /gaps /wide /empty /opportunities ---
const PAGE_SIZE = 10;

function pageKeyboard(cmd, page, totalPages, opts = {}) {
  // /stale and /all both use a filter-aware callback shape so pagination
  // preserves the active filter (<kind>:page:bits:thresh:sort:dir:N). The
  // wizard button appended as a second row lets the user re-open filter
  // settings.
  const isWizardCmd = cmd === 'stale' || cmd === 'all';
  const bits = opts.bits ?? '100100';
  const thresh = opts.thresh ?? 'inf';
  const defaultSort = LIST_KINDS[cmd]?.defaultSort ?? 't';
  const sort = LIST_SORTS.includes(opts.sort) ? opts.sort : defaultSort;
  const dir = LIST_DIRS.includes(opts.dir) ? opts.dir : 'le';
  const ext = normalizeExt(opts.ext);
  // /new encodes its full filter (winH, minRate, minRem, bits, thresh, dir,
  // sort) so pagination preserves the active filter without per-message
  // state.
  const isNewCmd = cmd === 'new';
  const newF = {
    winH: Number.isFinite(opts.winH) ? opts.winH : NEW_DEFAULT.winH,
    minRate: Number.isFinite(opts.minRate) ? opts.minRate : NEW_DEFAULT.minRate,
    minRem: Number.isFinite(opts.minRem) ? opts.minRem : NEW_DEFAULT.minRem,
    bits: /^[01]{6}$/.test(opts.bits) ? opts.bits : NEW_DEFAULT.bits,
    thresh: (LIST_THRESHOLDS.includes(opts.thresh) || isCustomThresh(opts.thresh))
      ? opts.thresh : NEW_DEFAULT.thresh,
    dir: LIST_DIRS.includes(opts.dir) ? opts.dir : NEW_DEFAULT.dir,
    sort: NEW_SORTS.includes(opts.sort) ? opts.sort : NEW_DEFAULT.sort,
    noUpDown: typeof opts.noUpDown === 'boolean' ? opts.noUpDown : NEW_DEFAULT.noUpDown,
  };
  const pageCb = (p) => {
    if (isWizardCmd) return `${cmd}:page:${bits}:${thresh}:${sort}:${dir}:${ext}:${p}`;
    if (isNewCmd) {
      return `new:page:${newFilterToCbParts(newF).join(':')}:${p}`;
    }
    return `page:${cmd}:${p}`;
  };
  const rows = [];
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️ 上一页', callback_data: pageCb(page - 1) });
    navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'page:noop' });
    if (page < totalPages - 1) navRow.push({ text: '➡️ 下一页', callback_data: pageCb(page + 1) });
    rows.push(navRow);
  }
  if (isWizardCmd) {
    const filterActive = staleFilterIsActive(bits, thresh);
    const extActive = extFilterActive(ext);
    const tagParts = [];
    if (filterActive) tagParts.push(staleThreshLabel(thresh, dir));
    if (extActive) tagParts.push(extLabel(ext));
    if (sort !== defaultSort) tagParts.push(`排序 ${LIST_SORT_LABELS[sort]}`);
    rows.push([{
      text: tagParts.length
        ? `🎚 调整 (${tagParts.join(' · ')})`
        : `🎚 过滤 / 排序`,
      callback_data: `${cmd}:wizard:${bits}:${thresh}:${sort}:${dir}:${ext}:0`,
    }]);
  }
  if (isNewCmd) {
    const active = newFilterIsActive(newF);
    const tagBits = [];
    if (newF.winH !== NEW_DEFAULT.winH) tagBits.push(fmtHoursLabel(newF.winH));
    if (newF.minRate > 0) tagBits.push(fmtRateLabel(newF.minRate));
    if (newF.minRem > 0) tagBits.push(`剩${fmtHoursLabel(newF.minRem)}`);
    if (newDepthFilterActive(newF)) {
      const sel = parseStaleBits(newF.bits);
      const picked = LIST_LEVELS.filter((k) => sel[k]).map((k) => LIST_LEVEL_LABELS[k]).join('+');
      const op = LIST_DIR_OP[newF.dir] ?? '≤';
      tagBits.push(`${picked} ${op} $${newF.thresh}`);
    }
    if (newF.sort !== NEW_DEFAULT.sort) tagBits.push(NEW_SORT_LABELS[newF.sort]);
    if (!newF.noUpDown) tagBits.push('含涨跌类');
    rows.push([{
      text: active ? `🎚 调整 (${tagBits.join(' · ')})` : '🎚 过滤 / 排序',
      callback_data: `new:wizard:${newFilterToCbParts(newF).join(':')}:0`,
    }]);
  }
  // "🌐 N" url buttons — one per market on the current page. Each is a
  // direct-URL button so a single tap opens that market in the browser
  // without going through the inline title link in the text (much easier
  // to hit on mobile, where tapping a small inline <a> is fiddly).
  // Telegram has no multi-URL button, so true "one tap → 10 tabs" isn't
  // possible; this is the next-best approximation.
  if (Array.isArray(opts.openUrls) && opts.openUrls.length) {
    const CHUNK = 5;
    for (let i = 0; i < opts.openUrls.length; i += CHUNK) {
      const chunk = opts.openUrls.slice(i, i + CHUNK);
      rows.push(chunk.map((u, j) => ({
        text: `🌐 ${i + j + 1}`,
        url: u,
      })));
    }
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
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

function renderListPage(cmd, page, state, filter = null) {
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
    case 'new': {
      // Markets first seen (as rewarded) within [now - winH, now]. Slot
      // may be null for markets discovered after the most recent tick — we
      // synthesize one from the firstSeen snapshot so they still render.
      // Knobs:
      //   winH / minRate / minRem    — pure metadata filters, no refetch
      //   bits + thresh + dir        — depth-sum filter; requires recentBook
      //                                (populated by the wizard's refetch)
      //   sort                       — 't' firstSeen desc / 'p' PP/h desc
      const f = {
        winH: Number.isFinite(filter?.winH) ? filter.winH : NEW_DEFAULT.winH,
        minRate: Number.isFinite(filter?.minRate) ? filter.minRate : NEW_DEFAULT.minRate,
        minRem: Number.isFinite(filter?.minRem) ? filter.minRem : NEW_DEFAULT.minRem,
        bits: typeof filter?.bits === 'string' && /^[01]{6}$/.test(filter.bits)
          ? filter.bits : NEW_DEFAULT.bits,
        thresh: (LIST_THRESHOLDS.includes(filter?.thresh) || isCustomThresh(filter?.thresh))
          ? filter.thresh : NEW_DEFAULT.thresh,
        dir: LIST_DIRS.includes(filter?.dir) ? filter.dir : NEW_DEFAULT.dir,
        sort: NEW_SORTS.includes(filter?.sort) ? filter.sort : NEW_DEFAULT.sort,
        noUpDown: typeof filter?.noUpDown === 'boolean' ? filter.noUpDown : NEW_DEFAULT.noUpDown,
      };
      const cutoff = Date.now() - f.winH * 3600 * 1000;
      const remCutoff = f.minRem > 0 ? Date.now() + f.minRem * 3600 * 1000 : null;
      const depthOn = newDepthFilterActive(f);
      const sel = depthOn ? parseStaleBits(f.bits) : null;
      const threshUsd = depthOn && f.thresh !== 'inf' ? Number(f.thresh) : null;
      const firstSeen = state.marketFirstSeen ?? {};
      rows = [];
      for (const [id, info] of Object.entries(firstSeen)) {
        const ms = typeof info === 'number' ? info : info?.ms;
        if (!Number.isFinite(ms) || ms <= 0 || ms < cutoff) continue;
        const slot = state.markets[id] ?? null;
        const synthSlot = slot ?? {
          title: info?.title ?? null,
          question: info?.question ?? null,
          lastHourlyRate: info?.rate ?? null,
          endMs: info?.endMs ?? null,
        };
        // Drop "Bitcoin/ETH Up or Down" recurring intraday markets when the
        // noUpDown filter is on (default) — they're auto-generated every few
        // minutes and otherwise flood the feed.
        if (f.noUpDown && isUpOrDownMarket(synthSlot)) continue;
        const rate = Number.isFinite(synthSlot.lastHourlyRate) ? synthSlot.lastHourlyRate : 0;
        // /new = "新上奖励市场" — only show markets that ACTUALLY pay PP
        // right now. Short-lived markets (e.g. "Bitcoin Up or Down" 5-min
        // intervals) were rewarded when first discovered but their reward
        // window has since expired (rate → 0); hide them as noise.
        if (rate <= 0) continue;
        if (f.minRate > 0 && rate < f.minRate) continue;
        if (remCutoff != null) {
          const endMs = Number.isFinite(synthSlot.endMs) ? synthSlot.endMs : null;
          // No endMs means we can't verify — drop conservatively so the
          // filter doesn't lie. (Most rewarded markets have an endMs.)
          if (endMs == null || endMs < remCutoff) continue;
        }
        let sumUsd = null;
        if (depthOn) {
          // Need recentBook — populated by the wizard's refetch. Markets
          // discovered after the most recent refetch (or that errored out
          // mid-refetch) drop here so the result list always reflects the
          // chosen threshold honestly.
          if (!slot?.recentBook) continue;
          sumUsd = sumLevels(slot.recentBook, sel);
          if (sumUsd == null) continue;
          const passes = f.dir === 'ge' ? sumUsd >= threshUsd : sumUsd <= threshUsd;
          if (!passes) continue;
        }
        rows.push({ id, slot: synthSlot, firstSeenMs: ms, hasSlot: !!slot, sumUsd });
      }
      if (f.sort === 'p') {
        const rateOf = (r) => Number.isFinite(r.slot?.lastHourlyRate) ? r.slot.lastHourlyRate : 0;
        rows.sort((a, b) => (rateOf(b) - rateOf(a)) || (b.firstSeenMs - a.firstSeenMs));
      } else {
        rows.sort((a, b) => b.firstSeenMs - a.firstSeenMs);
      }
      const headerParts = [`<b>🆕 近 ${fmtHoursLabel(f.winH)} 新上奖励市场</b>`];
      const filterTags = [];
      if (f.minRate > 0) filterTags.push(`💰 ${fmtRateLabel(f.minRate)}`);
      if (f.minRem > 0) filterTags.push(`⌛ ≥${fmtHoursLabel(f.minRem)}`);
      if (depthOn) {
        const picked = LIST_LEVELS.filter((k) => sel[k]).map((k) => LIST_LEVEL_LABELS[k]).join('+');
        const op = LIST_DIR_OP[f.dir] ?? '≤';
        filterTags.push(`📐 ${picked} ${op} $${f.thresh}`);
      }
      if (f.sort !== NEW_DEFAULT.sort) filterTags.push(`📊 ${NEW_SORT_LABELS[f.sort]}`);
      if (filterTags.length) headerParts.push(`<i>· ${filterTags.join(' · ')}</i>`);
      header = headerParts.join(' ');
      extraFn = (_slot, row) => {
        const ago = fmtAgo(Date.now() - row.firstSeenMs);
        const tag = row.hasSlot ? `🆕 ${ago}` : `🆕 ${ago} · ⏳ 等首抓`;
        if (depthOn && row.sumUsd != null) return `${tag} · sum $${row.sumUsd.toFixed(0)}`;
        return tag;
      };
      break;
    }
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
    case 'stale': {
      // Stall-duration leaderboard. Includes markets that haven't yet
      // crossed the (per-market) staleHours alert threshold so the user
      // can see what's "approaching alert" alongside what's already fired.
      // Optional filter (from the wizard): keep markets whose sum of
      // selected bid/ask levels (from slot.recentBook, populated by the
      // refetch flow) is ≤ a dollar threshold.
      const filterBits = filter?.bits ?? null;
      const filterThresh = filter?.thresh ?? null;
      const filterDir = LIST_DIRS.includes(filter?.dir) ? filter.dir : 'le';
      const filterExt = filter?.ext ?? 'off';
      const filterOn = filterBits && filterThresh && staleFilterIsActive(filterBits, filterThresh);
      const extOn = extFilterActive(filterExt);
      const sel = filterBits ? parseStaleBits(filterBits) : null;
      const threshUsd = filterThresh && filterThresh !== 'inf' ? Number(filterThresh) : null;
      const passesThresh = (sumUsd) => {
        if (sumUsd == null || threshUsd == null) return false;
        return filterDir === 'ge' ? sumUsd >= threshUsd : sumUsd <= threshUsd;
      };
      rows = allRows
        .filter(({ slot }) => isLive(slot) && Number.isFinite(slot.lastChangeAt))
        .map(({ id, slot }) => {
          const sinceMs = stallDurationMs(slot) ?? 0;
          const thresholdH = effectiveOverride(state, id, 'staleHours', config.staleHours);
          const sumUsd = sel ? sumLevels(slot.recentBook, sel) : null;
          return { id, slot, sinceMs, thresholdH, sumUsd };
        })
        .filter((r) => {
          if (extOn && !passesExtFilter(r.slot, filterExt)) return false;
          if (!filterOn) return true;
          // Drop markets that haven't been refetched in this session — without
          // recentBook we can't honor the level-sum filter.
          if (!r.slot.recentBook) return false;
          return passesThresh(r.sumUsd);
        });
      const sortKey = STALE_SORTS.includes(filter?.sort) ? filter.sort : 't';
      const rateOf = (r) => Number.isFinite(r.slot?.lastHourlyRate) ? r.slot.lastHourlyRate : 0;
      if (sortKey === 'p') {
        // PP/h descending; stall duration as tiebreaker so equal-rate markets
        // stay in stall order.
        rows.sort((a, b) => (rateOf(b) - rateOf(a)) || (b.sinceMs - a.sinceMs));
      } else {
        rows.sort((a, b) => b.sinceMs - a.sinceMs);
      }
      const headerLabel = sortKey === 'p' ? '⏱ 停滞排名 · 按 PP/h' : '⏱ 停滞时长排名';
      const headerParts = [`<b>${headerLabel}</b>`];
      const tagBits = [];
      if (filterOn) {
        const picked = STALE_LEVELS.filter((k) => sel[k]).map((k) => STALE_LEVEL_LABELS[k]).join('+');
        const op = LIST_DIR_OP[filterDir] ?? '≤';
        tagBits.push(`${picked} ${op} $${threshUsd}`);
      }
      if (extOn) tagBits.push(extLabel(filterExt));
      if (tagBits.length) headerParts.push(`<i>· 过滤: ${tagBits.join(' · ')}</i>`);
      header = headerParts.join(' ');
      extraFn = (slot, row) => {
        const elapsed = fmtElapsed(row.sinceMs);
        const thresholdMs = row.thresholdH * 3600 * 1000;
        const tag = slot.alerted
          ? `${elapsed} · 🟡 已告警 (≥${row.thresholdH}h)`
          : row.sinceMs >= thresholdMs
            ? `${elapsed} · 🟡 待告警 (≥${row.thresholdH}h)`
            : `${elapsed} / ${row.thresholdH}h`;
        if (filterOn && row.sumUsd != null) {
          return `${tag} · sum $${row.sumUsd.toFixed(0)}`;
        }
        return tag;
      };
      break;
    }
    case 'all': {
      // Full monitored-market browser. Unlike /top /stale etc. this does
      // NOT drop skipped/errored/paused markets — the whole point is to
      // surface the "what else is in my pool" set so the user can see
      // every id they've subscribed to. Per-market status is appended as
      // a tag via extraFn.
      const filterBits = filter?.bits ?? null;
      const filterThresh = filter?.thresh ?? null;
      const filterDir = LIST_DIRS.includes(filter?.dir) ? filter.dir : 'le';
      const filterExt = filter?.ext ?? 'off';
      const filterOn = filterBits && filterThresh && staleFilterIsActive(filterBits, filterThresh);
      const extOn = extFilterActive(filterExt);
      const sel = filterBits ? parseStaleBits(filterBits) : null;
      const threshUsd = filterThresh && filterThresh !== 'inf' ? Number(filterThresh) : null;
      const passesThresh = (sumUsd) => {
        if (sumUsd == null || threshUsd == null) return false;
        return filterDir === 'ge' ? sumUsd >= threshUsd : sumUsd <= threshUsd;
      };
      const pausedSet = new Set(state.pausedIds ?? []);
      rows = allRows
        .map(({ id, slot }) => {
          const sinceMs = Number.isFinite(slot?.lastChangeAt)
            ? stallDurationMs(slot)
            : null;
          const sumUsd = sel ? sumLevels(slot?.recentBook, sel) : null;
          let status = 'alive';
          let statusTag = '';
          if (!slot) { status = 'wait'; statusTag = '⏳ 等待首抓'; }
          else if (slot.lastError) { status = 'error'; statusTag = `⚠ ${slot.lastError.slice(0, 40)}`; }
          else if (slot.lastSkipReason) { status = 'skip'; statusTag = `⏭ ${slot.lastSkipReason.slice(0, 40)}`; }
          if (pausedSet.has(id)) { status = 'paused'; statusTag = `⏸ 已暂停${statusTag ? ' · ' + statusTag : ''}`; }
          return { id, slot: slot ?? {}, sinceMs, sumUsd, status, statusTag };
        })
        .filter((r) => {
          // 没有积分（PP/h = 0 / 已 resolve 或无奖励）的市场是噪音，直接去掉。
          if (typeof r.slot.lastSkipReason === 'string' && r.slot.lastSkipReason.startsWith('PP/h = 0')) return false;
          if (extOn && !passesExtFilter(r.slot, filterExt)) return false;
          if (!filterOn) return true;
          if (!r.slot.recentBook) return false;
          return passesThresh(r.sumUsd);
        });
      const sortKey = LIST_SORTS.includes(filter?.sort) ? filter.sort : 'p';
      const rateOf = (r) => Number.isFinite(r.slot?.lastHourlyRate) ? r.slot.lastHourlyRate : 0;
      if (sortKey === 't') {
        // Stall desc; markets without lastChangeAt sink to the bottom
        // (they haven't reported orderbook activity yet, so "stall" is undefined).
        rows.sort((a, b) => (b.sinceMs ?? -1) - (a.sinceMs ?? -1));
      } else {
        // PP/h desc; stall as tiebreaker
        rows.sort((a, b) => (rateOf(b) - rateOf(a)) || ((b.sinceMs ?? 0) - (a.sinceMs ?? 0)));
      }
      const headerLabel = sortKey === 't' ? '📋 全部市场 · 按停滞时长' : '📋 全部市场 · 按 PP/h';
      const headerParts = [`<b>${headerLabel}</b>`];
      const tagBits = [];
      if (filterOn) {
        const picked = LIST_LEVELS.filter((k) => sel[k]).map((k) => LIST_LEVEL_LABELS[k]).join('+');
        const op = LIST_DIR_OP[filterDir] ?? '≤';
        tagBits.push(`${picked} ${op} $${threshUsd}`);
      }
      if (extOn) tagBits.push(extLabel(filterExt));
      if (tagBits.length) headerParts.push(`<i>· 过滤: ${tagBits.join(' · ')}</i>`);
      header = headerParts.join(' ');
      extraFn = (_slot, row) => {
        const parts = [];
        if (row.sinceMs != null) parts.push(`停滞 ${fmtElapsed(row.sinceMs)}`);
        if (row.statusTag) parts.push(row.statusTag);
        if (filterOn && row.sumUsd != null) parts.push(`sum $${row.sumUsd.toFixed(0)}`);
        return parts.join(' · ');
      };
      break;
    }
    default:
      return null;
  }
  // For /stale and /all we always want the wizard button visible (even
  // with 0 rows and a single page), so build the keyboard before the
  // empty-rows shortcut.
  let kbOpts = {};
  if ((cmd === 'stale' || cmd === 'all') && filter) {
    kbOpts = {
      bits: filter.bits ?? '100100',
      thresh: filter.thresh ?? 'inf',
      sort: filter.sort ?? (LIST_KINDS[cmd]?.defaultSort ?? 't'),
      dir: filter.dir ?? 'le',
      ext: normalizeExt(filter.ext),
    };
  } else if (cmd === 'new') {
    kbOpts = {
      winH: Number.isFinite(filter?.winH) ? filter.winH : NEW_DEFAULT.winH,
      minRate: Number.isFinite(filter?.minRate) ? filter.minRate : NEW_DEFAULT.minRate,
      minRem: Number.isFinite(filter?.minRem) ? filter.minRem : NEW_DEFAULT.minRem,
      bits: /^[01]{6}$/.test(filter?.bits) ? filter.bits : NEW_DEFAULT.bits,
      thresh: (LIST_THRESHOLDS.includes(filter?.thresh) || isCustomThresh(filter?.thresh))
        ? filter.thresh : NEW_DEFAULT.thresh,
      dir: LIST_DIRS.includes(filter?.dir) ? filter.dir : NEW_DEFAULT.dir,
      sort: NEW_SORTS.includes(filter?.sort) ? filter.sort : NEW_DEFAULT.sort,
      noUpDown: typeof filter?.noUpDown === 'boolean' ? filter.noUpDown : NEW_DEFAULT.noUpDown,
    };
  }
  if (!rows.length) {
    const kb = pageKeyboard(cmd, 0, 1, kbOpts);
    const hint = cmd === 'new'
      ? `\n\n<i>这段时间没有新上线的有奖励市场。试试更长的窗口，比如 /new 7d。</i>`
      : '\n\n暂无匹配市场。';
    return { text: `${header}${hint}`, replyMarkup: kb };
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
  // One-tap-per-market open buttons under the keyboard. The position in
  // `items` matches the visible row number in the message, so 🌐 3 opens
  // the third row.
  const openUrls = items.map((row) => marketUrl(
    row.id, row.slot?.title, row.slot?.question, row.slot?.slug,
  ));
  return {
    text: lines.join('\n'),
    replyMarkup: pageKeyboard(cmd, safePage, totalPages, { ...kbOpts, openUrls }),
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

  // Cross-market ladder-mispricing count (same signal as /sanity).
  let sanityCount = 0;
  try {
    const { collectPriceSanityIssues } = await import('./monitor.js');
    sanityCount = collectPriceSanityIssues(state).length;
  } catch {}

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
  if (sanityCount > 0) oppParts.push(`⚠️ 定价异常 ${sanityCount}`);
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
      const since = slot.lastChangeAt ? `停滞 ${fmtElapsed(stallDurationMs(slot) ?? 0)}` : '';
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
  lines.push('更多: /top /gaps /thin /wide /empty' + (sanityCount > 0 ? ' /sanity' : ''));

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
  const since = stallDurationMs(slot) ?? 0;
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
    case '/menu': {
      // Private chat = admin DM (chatId === fromId for personal accounts).
      // Group chats see the trimmed menu without the admin-flavored buttons.
      const isPrivate = isAdminUser(fromId);
      return { text: menuText({ isPrivate }), replyMarkup: menuKeyboard({ isPrivate }) };
    }

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

    case '/diagdiscover': {
      // Side-by-side count of REST vs GraphQL discovery sources, plus
      // breakdown of which post-fetch filter eats which markets. Useful
      // when /status shows fewer monitored markets than expected — points
      // at whether REST returned fewer items, GraphQL did, or local
      // filters (minRate, minRemaining) are dropping them.
      const { compareDiscoverySources } = await import('./discovery.js');
      const r = await compareDiscoverySources();
      const fmtBd = (b) => b
        ? `raw <b>${b.raw}</b> · 不可交易 ${b.notTradeable} · 低于 minRate ${b.belowMin} · 剩余太少 ${b.tooSoon} · 留 <b>${b.kept}</b>`
        : 'n/a';
      const fmtSample = (sample) => sample.length
        ? sample.map((s) => `  <code>#${s.id}</code> · ${s.rate.toFixed(0)}/h · ${htmlEscape(shortTitle(s.title, 50))}`).join('\n')
        : '  <i>(无)</i>';
      const lines = [
        `🔍 <b>发现源对比</b>  <i>(耗时 ${(r.elapsedMs / 1000).toFixed(1)}s)</i>`,
        '',
        r.rest.err
          ? `🌐 REST hasActiveRewards: ❌ ${htmlEscape(r.rest.err)}`
          : `🌐 REST hasActiveRewards: <b>${r.rest.count}</b> 个`,
        r.rest.err ? null : `   ${fmtBd(r.rest.breakdown)}`,
        '',
        r.gql.err
          ? `📡 GraphQL rate&gt;0:        ❌ ${htmlEscape(r.gql.err)}`
          : `📡 GraphQL rate&gt;0:        <b>${r.gql.count}</b> 个`,
        r.gql.err ? null : `   ${fmtBd(r.gql.breakdown)}`,
        '',
        `🔁 交集 <b>${r.bothCount}</b> · REST 独有 <b>${r.onlyRest.count}</b> · GraphQL 独有 <b>${r.onlyGql.count}</b>`,
      ].filter((l) => l != null);
      if (r.onlyGql.count) {
        lines.push('');
        lines.push(`<b>GraphQL 有但 REST 没的 (前 ${r.onlyGql.sample.length}):</b>`);
        lines.push(fmtSample(r.onlyGql.sample));
      }
      if (r.onlyRest.count) {
        lines.push('');
        lines.push(`<b>REST 有但 GraphQL 没的 (前 ${r.onlyRest.sample.length}):</b>`);
        lines.push(fmtSample(r.onlyRest.sample));
      }
      lines.push('');
      lines.push(`<i>当前 minRate=${r.config.minRate} · minRemainingHours=${r.config.minRemainingHours}h · discoveryMaxMarkets=${r.config.discoveryMaxMarkets}</i>`);
      return lines.join('\n');
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

    case '/hourly': {
      const parts = arg.split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();
      // /hourly only on|off  — digest-only mode (mute per-alert sends)
      // /hourly ext <N>|off  — exclude markets with a side ≥N¢ from digest
      // /hourly cfg          — show current settings
      // /hourly (no arg)     — trigger one now
      if (sub === 'only') {
        const v = (parts[1] ?? '').toLowerCase();
        if (v === 'on' || v === 'off') {
          state.hourlyDigestOnly = v === 'on';
          await ctx.persist();
          return state.hourlyDigestOnly
            ? '🔕 已开启<b>只收整点摘要</b>模式:逐条提醒不再推送,仍按小时汇总。\n(watch / snapshot / 恢复提醒不受影响)'
            : '🔔 已关闭只收整点摘要模式,恢复逐条实时提醒。';
        }
        return '用法:/hourly only on  开启只收摘要\n     /hourly only off 关闭';
      }
      if (sub === 'ext') {
        const v = (parts[1] ?? '').toLowerCase();
        if (v === 'off' || v === '0') {
          state.hourlyDigestExtExclude = 0;
          await ctx.persist();
          return '📈 整点摘要:已关闭极端价排除(显示全部)。';
        }
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1 && n <= 99) {
          state.hourlyDigestExtExclude = Math.round(n);
          await ctx.persist();
          return `📈 整点摘要:已设为排除 一边 ≥${Math.round(n)}¢ 或 ≤${100 - Math.round(n)}¢ 的市场。`;
        }
        return '用法:/hourly ext 94  (排除 ≥94¢ 的)\n     /hourly ext off (不排除)';
      }
      if (sub === 'now' || sub === 'send') {
        // Manual trigger (text shortcut; the panel has a button too).
        if (typeof ctx.requestHourlyDigest === 'function') {
          ctx.requestHourlyDigest();
          return '已触发整点摘要(下一 tick 发出)。';
        }
        return '当前进程不支持手动触发整点摘要。';
      }
      // No (recognised) arg → settings panel with toggle buttons. Buttons
      // work in groups even under Telegram privacy mode (callbacks always
      // reach the bot), unlike plain "/hourly only on" text.
      return {
        text: hourlySettingsText(state),
        replyMarkup: hourlySettingsKeyboard(state),
      };
    }

    case '/movers': {
      // PP/h rate-change view. /movers [duration] — default 1h.
      // Bottom buttons let the user switch window without retyping.
      let windowMin = MOVERS_DEFAULT_MIN;
      if (arg) {
        const dur = parseDuration(arg);
        if (dur != null && dur > 0) {
          windowMin = Math.max(5, Math.min(7 * 24 * 60, Math.round(dur / 60_000)));
        } else if (/^\d+$/.test(arg.trim())) {
          // Bare number = minutes.
          windowMin = Math.max(5, Math.min(7 * 24 * 60, Number(arg.trim())));
        }
      }
      return await renderMoversPage(state, windowMin, 0);
    }

    case '/sanity':
    case '/arb': {
      // On-demand view of current threshold-ladder mispricings (the same
      // signal price_sanity alerts push, but listed live, most-severe first,
      // and ignoring the per-ladder alert cooldown). `/sanity unmute [all|token]`
      // clears ladder mutes set via the alert button.
      const { collectPriceSanityIssues, formatPriceSanityLadder, priceSanityExtCents } = await import('./monitor.js');
      const sub = arg.trim().toLowerCase();
      if (sub.startsWith('unmute') || sub === 'reset') {
        const rest = sub.replace(/^unmute|^reset/, '').trim();
        state.priceSanityMuted = state.priceSanityMuted ?? {};
        const muted = state.priceSanityMuted;
        const n = Object.keys(muted).length;
        if (!n) return '当前没有被静音的阶梯。';
        if (!rest || rest === 'all') {
          state.priceSanityMuted = {};
          await ctx.persist();
          return `✅ 已恢复 ${n} 个被静音的阶梯。`;
        }
        if (muted[rest]) {
          delete muted[rest];
          await ctx.persist();
          return `✅ 已恢复阶梯 <code>${htmlEscape(rest)}</code>。`;
        }
        return `未找到 token <code>${htmlEscape(rest)}</code>。用 /sanity unmute all 全部恢复。`;
      }
      // /sanity ext <N|off> — exclude near-decided extreme-price rungs (one
      // side ≥N¢ / ≤(100-N)¢) from the check. Mirrors the hourly digest's 94¢.
      if (sub.startsWith('ext')) {
        const val = sub.replace(/^ext/, '').trim();
        if (!val) {
          const cur = priceSanityExtCents(state);
          return `当前极端价排除：${cur > 0 ? `≥${cur}¢ 或 ≤${100 - cur}¢ 的已决市场不参与检测` : '关闭（所有档位都参与）'}\n用法：/sanity ext 94 · /sanity ext 80 · /sanity ext off`;
        }
        if (val === 'off' || val === '0') {
          state.priceSanityExtExclude = 0;
          await ctx.persist();
          return '✅ 已关闭极端价排除——所有档位都参与定价异常检测。';
        }
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 50 || n >= 100) {
          return '阈值需在 (50, 100)，例如 94 = 排除 ≥94¢ 或 ≤6¢ 的已决市场。/sanity ext off 关闭。';
        }
        state.priceSanityExtExclude = n;
        await ctx.persist();
        return `✅ 已设置极端价排除 ≥${n}¢ / ≤${100 - n}¢（接近决出的市场不参与检测）。`;
      }
      const issues = collectPriceSanityIssues(state);
      const muted = state.priceSanityMuted ?? {};
      const mutedN = Object.keys(muted).length;
      const extCents = priceSanityExtCents(state);
      const extTag = extCents > 0 ? ` · 排除 ≥${extCents}¢` : '';
      if (!issues.length) {
        return `✅ 暂无定价异常的阈值阶梯（相邻档位概率差都 &gt; ${(config.priceSanityMargin * 100).toFixed(0)}¢${extTag}）。`
          + (mutedN ? `\n<i>（${mutedN} 个阶梯已静音，/sanity unmute all 恢复）</i>` : '');
      }
      const totalArb = issues.reduce((a, i) => a + (i.arbUsd ?? 0), 0);
      const head = `⚠️ <b>定价异常阶梯 (${issues.length})</b> · 相邻档位差 ≤ ${(config.priceSanityMargin * 100).toFixed(0)}¢${extTag}`
        + (totalArb > 0 ? ` · 锁定套利≈<b>$${totalArb.toFixed(0)}</b>` : '');
      const lines = [head, ''];
      for (const issue of issues) {
        if (muted[issue.token]) lines.push(`🔇 <i>已静音（/sanity unmute ${issue.token} 恢复）</i>`);
        lines.push(formatPriceSanityLadder(issue, config.priceSanityMargin));
        lines.push('');
      }
      if (mutedN) lines.push(`<i>🔇 ${mutedN} 个阶梯已静音 · /sanity unmute all 恢复</i>`);
      return lines.join('\n').trim();
    }

    case '/ladders':
    case '/ladder': {
      // Browse every detected threshold ladder, sound or not — useful to
      // verify the auto-grouping and to eyeball the whole curve at once.
      const { collectLadders, priceSanityExtCents } = await import('./monitor.js');
      const ladders = collectLadders(state);
      if (!ladders.length) {
        return '未识别到任何阈值阶梯（需同一标的 ≥2 个不同门槛的市场，且都有盘口中价）。';
      }
      ladders.sort((a, b) =>
        ((b.violations.length > 0) - (a.violations.length > 0))
        || (b.arbUsd - a.arbUsd)
        || (b.rungs.length - a.rungs.length));
      const badCount = ladders.filter((l) => l.violations.length).length;
      const extCents = priceSanityExtCents(state);
      const extTag = extCents > 0 ? ` · 排除 ≥${extCents}¢` : '';
      const lines = [`🪜 <b>识别到的阈值阶梯 (${ladders.length})</b>${badCount ? ` · 异常 <b>${badCount}</b>` : ''}${extTag}`, ''];
      for (const l of ladders) {
        const bad = l.violations.length > 0;
        const ctxText = htmlEscape(shortTitle(l.context.replace(/\s+/g, ' ').trim(), 50));
        const rungStr = l.rungs
          .map((r) => `${htmlEscape(r.raw)} ${(r.mid * 100).toFixed(0)}`)
          .join(' · ');
        const status = bad
          ? `⚠️ 异常(差${(l.minGap * 100).toFixed(1)}¢${l.arbUsd > 0 ? ` 套利≈$${l.arbUsd.toFixed(0)}` : ''})`
          : '✅ 正常';
        lines.push(`${bad ? '⚠️' : '·'} <i>${ctxText}</i> — ${l.rungs.length}档 · ${status}`);
        lines.push(`   ${rungStr}`);
      }
      return lines.join('\n').trim();
    }

    case '/top':
    case '/gaps':
    case '/thin':
    case '/wide':
    case '/empty':
    case '/stale':
    case '/all':
    case '/opportunities':
    case '/opp': {
      const cmdName = cmd === '/opportunities' ? 'opp' : cmd.slice(1);
      // Optional integer arg = page number (1-indexed for the user)
      const page = Math.max(1, Number(arg) || 1) - 1;
      const reply = renderListPage(cmdName, page, state);
      if (!reply) return '未知命令';
      return reply;
    }

    case '/new': {
      // /new                 → result list with default filter (底部 🎚 进向导)
      // /new 24h             → window arg (parses 30m / 2h / 7d, max 30d)
      // /new 24h 500         → window + minRate
      // /new 24h 500 6h      → window + minRate + minRem
      // Bare numeric arg (no unit) = page index (1-indexed) for back-compat
      // with the original /new release.
      const parts = arg.split(/\s+/).filter(Boolean);
      const f = { ...NEW_DEFAULT };
      let page = 0;
      const numericFields = ['winH', 'minRate', 'minRem'];
      let fieldIdx = 0;
      for (const p of parts) {
        const dur = parseDuration(p);
        if (/^\d+$/.test(p) && p === parts[parts.length - 1] && parts.length > 1) {
          // Trailing bare integer = page index when other args precede it.
          page = Math.max(0, Number(p) - 1);
          continue;
        }
        if (dur != null && dur > 0) {
          const hours = Math.round(dur / 3600000);
          const key = numericFields[fieldIdx];
          if (key === 'winH') f.winH = Math.min(720 * 24, Math.max(1, hours));
          else if (key === 'minRem') f.minRem = Math.min(720 * 24, hours);
          fieldIdx += 1;
        } else if (/^\d+$/.test(p)) {
          // Bare number — could be minRate (if we've already parsed window)
          // or a page index (if it's the only arg).
          if (fieldIdx === 0 && parts.length === 1) {
            page = Math.max(0, Number(p) - 1);
          } else {
            const key = numericFields[fieldIdx];
            if (key === 'winH') f.winH = Math.min(720 * 24, Math.max(1, Number(p)));
            else if (key === 'minRate') f.minRate = Math.max(0, Number(p));
            else if (key === 'minRem') f.minRem = Math.min(720 * 24, Number(p));
            fieldIdx += 1;
          }
        }
      }
      const reply = renderListPage('new', page, state, f);
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

    // /snapshot: periodic full-orderbook push for a specific market.
    // Goes to admin DM only (kind-routed). Bypasses all volume gates
    // (cooldown / quiet / priority floor) since user explicitly wants
    // it. Auto-adds to manualIds so the tick loop polls the market.
    //   /snapshot                  → list registrations
    //   /snapshot <id> <interval>  → set / replace
    //   /snapshot <id> off         → clear
    case '/snapshot': {
      if (!arg) {
        const entries = Object.entries(state.snapshots ?? {});
        if (!entries.length) {
          return '当前无定时快照。\n用 /snapshot &lt;id&gt; &lt;interval&gt; 添加（如 /snapshot 257916 5m）\n推送只到 admin 私聊。';
        }
        const lines = ['<b>📸 定时快照</b>'];
        for (const [id, s] of entries) {
          const slot = state.markets[id];
          const title = slot?.title ? htmlEscape(shortTitle(slot.title, 40)) : `Market ${id}`;
          const intervalMin = Math.max(1, Math.round(s.intervalMs / 60000));
          const lastSent = s.lastSentAt
            ? `${fmtElapsed(Date.now() - s.lastSentAt)} 前`
            : '从未';
          lines.push(`<code>#${htmlEscape(id)}</code> ${title} — 每 ${intervalMin}min · 上次 ${lastSent}`);
        }
        lines.push('');
        lines.push('关掉用 /snapshot &lt;id&gt; off');
        return lines.join('\n');
      }
      const [idArg, intervalArg] = arg.split(/\s+/);
      if (!idArg || !intervalArg) {
        return '用法：\n/snapshot &lt;id&gt; &lt;interval&gt;  设置（如 /snapshot 257916 5m）\n/snapshot &lt;id&gt; off          关闭\n/snapshot                 列出';
      }
      const id = String(idArg);
      if (intervalArg === 'off' || intervalArg === '0') {
        if (state.snapshots?.[id]) {
          const next = { ...state.snapshots };
          delete next[id];
          state.snapshots = next;
          await ctx.persist();
          return `已关闭 #${htmlEscape(id)} 的定时快照。`;
        }
        return `#${htmlEscape(id)} 没有定时快照在跑。`;
      }
      const ms = parseDuration(intervalArg);
      if (!ms) return `无法解析时长 "${htmlEscape(intervalArg)}"，支持 5m / 30m / 2h / 1d`;
      if (ms < 60_000) return '间隔太短（&lt; 1 分钟）— 太频繁会被 Telegram 限流，最少 1m';
      state.snapshots = { ...(state.snapshots ?? {}), [id]: { intervalMs: ms, lastSentAt: 0 } };
      // Auto-add to manualIds so checkMarket actually polls this market.
      // Skip if it's already in env / autoIds / manualIds — activeMarketIds
      // dedupes on read.
      if (!state.manualIds.includes(id) && !state.removedIds.includes(id)) {
        state.manualIds = [...state.manualIds, id];
      }
      await ctx.persist();
      return `📸 #${htmlEscape(id)} 已注册定时快照，每 ${htmlEscape(intervalArg)} 推一次到 admin 私聊。\n（已自动加入监控池，下次 tick 起算）`;
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
    // Per-chat digest mode: queue alerts and flush as one summary
    // every N minutes. Trades immediacy for less disruption — useful
    // for groups where you want alert volume but not alert pings every
    // few minutes. watch / snapshot are NOT digested (those are
    // explicit per-market follows that should arrive in real time).
    //   /digest-mode               → show current chat's setting
    //   /digest-mode 5m | 30m | 1d → enable
    //   /digest-mode off           → disable + flush remaining queue
    case '/digest-mode': {
      const cid = String(chatId ?? '');
      if (!cid) return '无法识别当前 chat。';
      if (!arg) {
        const d = state.chatDigests?.[cid];
        if (!d?.intervalMs) {
          return '当前 chat 没有 digest 模式（实时推送）。\n用法：/digest-mode 5m  →  开启 5 分钟摘要';
        }
        const mins = Math.round(d.intervalMs / 60000);
        const queued = d.queue?.length ?? 0;
        const last = d.lastFlushAt
          ? `${fmtElapsed(Date.now() - d.lastFlushAt)} 前`
          : '未推过';
        return `📦 <b>当前 chat digest 模式</b>\n每 ${mins} 分钟一次摘要 · 队列里 ${queued} 条等待 · 上次 ${last}\n\n关闭：/digest-mode off`;
      }
      if (arg === 'off' || arg === '0' || arg === 'cancel') {
        const d = state.chatDigests?.[cid];
        if (!d) return '当前 chat 不在 digest 模式。';
        // Flush any pending items immediately so user doesn't lose them.
        if (Array.isArray(d.queue) && d.queue.length) {
          const { formatDigestSummary } = await import('./monitor.js');
          await sendLongTelegramMessage(formatDigestSummary(d.queue), { chatId: cid }).catch(() => {});
        }
        const next = { ...state.chatDigests };
        delete next[cid];
        state.chatDigests = next;
        await ctx.persist();
        return '已关闭 digest 模式（恢复实时推送）。';
      }
      const ms = parseDuration(arg);
      if (!ms) return '用法：/digest-mode 5m / 30m / 2h / 1d / off';
      if (ms < 60_000) return '最少 1 分钟（避免频繁刷屏）。';
      state.chatDigests = { ...(state.chatDigests ?? {}) };
      state.chatDigests[cid] = { intervalMs: ms, queue: [], lastFlushAt: 0 };
      await ctx.persist();
      const mins = Math.round(ms / 60000);
      return `📦 digest 模式开启 — 每 ${mins} 分钟推一次摘要\n（实时推送暂停；watch / snapshot 不受影响）`;
    }

    // Per-CHAT alert routing (vs /alerts which is global). Each chat
    // can independently exclude alert kinds — admin DM keeps all,
    // group A only takes reward_zone, group B only stall etc.
    //   /route                  → list current chat's exclusions
    //   /route off <kind>       → exclude this kind from this chat
    //   /route on <kind>        → re-include
    //   /route reset            → drop chat-specific routing (back to default)
    case '/route': {
      const KINDS = ['stall', 'mid_jump', 'wide_spread', 'reward_zone', 'empty_book'];
      const cid = String(chatId ?? '');
      if (!cid) return '无法识别当前 chat。';
      const [sub, kindArg] = arg.split(/\s+/);
      const action = (sub ?? '').toLowerCase();
      if (!action || action === 'list' || action === 'ls') {
        const route = state.chatRouting?.[cid];
        const excluded = route?.exclude ?? [];
        const lines = [
          `🚦 <b>当前 chat 路由</b>`,
          `chat: <code>${htmlEscape(cid)}</code>`,
          '',
        ];
        for (const k of KINDS) {
          const off = excluded.includes(k);
          lines.push(`  ${off ? '🚫' : '✅'} ${k}`);
        }
        if (excluded.length === 0) {
          lines.push('');
          lines.push('<i>(默认 — 所有 kind 都会送达此 chat)</i>');
        }
        lines.push('');
        lines.push('用法：/route off &lt;kind&gt; · /route on &lt;kind&gt; · /route reset');
        return lines.join('\n');
      }
      if (action === 'reset') {
        if (state.chatRouting?.[cid]) {
          const next = { ...state.chatRouting };
          delete next[cid];
          state.chatRouting = next;
          await ctx.persist();
          return `已重置 <code>${htmlEscape(cid)}</code> 的路由（恢复默认）。`;
        }
        return '当前 chat 没有自定义路由。';
      }
      // Shortcut: /route only <kind>  →  exclude every other kind
      // from this chat. Mirrors /alerts only but per-chat scoped.
      if (action === 'only') {
        if (!kindArg || !KINDS.includes(kindArg)) {
          return `用法：/route only &lt;kind&gt;\n可用 kind: ${KINDS.join(', ')}`;
        }
        state.chatRouting = { ...(state.chatRouting ?? {}) };
        state.chatRouting[cid] = { exclude: KINDS.filter((k) => k !== kindArg) };
        await ctx.persist();
        return `🎯 当前 chat 设为只看 <code>${kindArg}</code>（其它 ${KINDS.length - 1} 类已 mute）。`;
      }
      if (action !== 'on' && action !== 'off') {
        return `用法：/route [list|on &lt;kind&gt;|off &lt;kind&gt;|only &lt;kind&gt;|reset]\n可用 kind: ${KINDS.join(', ')}`;
      }
      if (!kindArg || !KINDS.includes(kindArg)) {
        return `未知 kind "${htmlEscape(kindArg ?? '')}"。可用: ${KINDS.join(', ')}`;
      }
      state.chatRouting = { ...(state.chatRouting ?? {}) };
      const cur = state.chatRouting[cid] ?? {};
      const exclude = new Set(cur.exclude ?? []);
      if (action === 'off') exclude.add(kindArg);
      else exclude.delete(kindArg);
      state.chatRouting[cid] = { ...cur, exclude: [...exclude] };
      await ctx.persist();
      return `${action === 'off' ? '🚫' : '✅'} 当前 chat 的 <code>${kindArg}</code> 已${action === 'off' ? '关闭' : '开启'}。`;
    }

    //   /alerts on  <kind>         → re-enable
    //   /alerts reset              → clear all overrides (back to env)
    case '/alerts': {
      const KINDS = ['stall', 'mid_jump', 'wide_spread', 'reward_zone', 'empty_book', 'price_sanity'];
      const [sub, kind] = arg.split(/\s+/);
      const action = (sub ?? '').toLowerCase();
      const cfgDefault = (k) => ({
        stall: config.alertStall,
        mid_jump: config.alertMidJump,
        wide_spread: config.alertWideSpread,
        reward_zone: config.alertRewardZone,
        empty_book: config.alertEmptyBook,
        price_sanity: config.alertPriceSanity,
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
      // Shortcut: /alerts only <kind>  →  enable that kind, disable
      // every other. Saves typing 4 separate `off` commands when the
      // user wants e.g. "just stall alerts, nothing else".
      if (action === 'only') {
        if (!kind || !KINDS.includes(kind)) {
          return `用法：/alerts only &lt;kind&gt;\n可用 kind: ${KINDS.join(', ')}`;
        }
        const next = {};
        for (const k of KINDS) next[k] = (k === kind);
        state.alertKinds = next;
        await ctx.persist();
        return `🎯 已设为只看 <code>${kind}</code>（其它 ${KINDS.length - 1} 类已关）。`;
      }
      if (action !== 'on' && action !== 'off') {
        return `用法：/alerts [list|on &lt;kind&gt;|off &lt;kind&gt;|only &lt;kind&gt;|reset]\n可用 kind: ${KINDS.join(', ')}`;
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

    case '/watched': {
      // List markets registered via /watch. Mirrors /snapshot's no-arg
      // listing so users have a uniform "what am I tracking" view.
      const ids = state.watchedIds ?? [];
      if (!ids.length) {
        return '当前无 /watch 追踪。\n用 /watch &lt;id&gt; 添加，或在 admin 私聊粘 URL/id 进入操作菜单。';
      }
      const lines = [`<b>👁 追踪中的市场 (${ids.length})</b>`];
      for (const id of ids) {
        const slot = state.markets[id];
        const title = slot?.title
          ? htmlEscape(shortTitle(slot.title, 40))
          : `Market ${htmlEscape(id)}`;
        const rate = Number.isFinite(slot?.lastHourlyRate)
          ? `${slot.lastHourlyRate.toFixed(0)}/h`
          : '?/h';
        const since = slot?.lastChangeAt
          ? `停滞 ${fmtElapsed(stallDurationMs(slot) ?? 0)}`
          : '';
        lines.push(`<code>#${htmlEscape(id)}</code> ${title} — ${rate}${since ? ` · ${since}` : ''}`);
      }
      lines.push('');
      lines.push('用 /unwatch &lt;id&gt; 单个取消 · /unwatch all 全部取消');
      return lines.join('\n');
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
      if (!arg) return '用法：/unwatch &lt;marketId|all&gt;\n（无参数列表已追踪：/watched）';
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
            // Pending custom-threshold input: if the user just clicked
            // "✏ 自定义" in a wizard, the next plain message in this chat
            // from this user is interpreted as the value. Routes back to
            // whichever wizard set the pending entry (kind field).
            const pending = consumePendingFilterInput(chatId, fromId);
            if (pending) {
              const trimmed = text.trim();
              const num = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
              if (pending.kind === 'new') {
                // /new wizard: pending.field tells us which knob to update.
                // Non-numeric / 0 → revert that field to its default.
                const next = {
                  winH: pending.winH, minRate: pending.minRate, minRem: pending.minRem,
                  bits: pending.bits ?? NEW_DEFAULT.bits,
                  thresh: pending.thresh ?? NEW_DEFAULT.thresh,
                  dir: pending.dir ?? NEW_DEFAULT.dir,
                  sort: pending.sort,
                };
                if (pending.field === 'win') {
                  next.winH = (num != null && num > 0) ? Math.min(720 * 24, num) : NEW_DEFAULT.winH;
                } else if (pending.field === 'rate') {
                  next.minRate = (num != null && num > 0) ? num : NEW_DEFAULT.minRate;
                } else if (pending.field === 'rem') {
                  next.minRem = (num != null && num > 0) ? Math.min(720 * 24, num) : NEW_DEFAULT.minRem;
                } else if (pending.field === 'thresh') {
                  next.thresh = (num != null && num > 0) ? String(num) : NEW_DEFAULT.thresh;
                }
                try {
                  await editTelegramMessage(
                    chatId, pending.messageId,
                    newWizardText(next), newWizardKeyboard(next),
                  );
                } catch (err) {
                  warn(`new custom-input apply edit failed: ${err.message}`);
                }
              } else {
                // /stale or /all wizard. pending.field tells us which knob —
                // 'thresh' for sum threshold ($), 'ext' for 极端价 (1-99).
                // 'thresh' is the legacy default for callbacks that didn't
                // populate field (the wizard's only custom input pre-ext).
                const field = pending.field === 'ext' ? 'ext' : 'thresh';
                let nextThresh = pending.thresh ?? 'inf';
                let nextExt = pending.ext ?? 'off';
                if (field === 'thresh') {
                  nextThresh = num != null && num > 0 ? String(num) : 'inf';
                } else {
                  // ext: clamp 1-99 and preserve the current mode (ex/in),
                  // so ✏ while in "仅显示" mode stays in "仅显示".
                  if (num != null && num >= 1 && num <= 99) {
                    const currentMode = parseExtRaw(pending.ext).mode === 'in' ? 'in' : 'ex';
                    nextExt = formatExt(currentMode, num);
                    // Keep a genuinely-custom value as a button for next time.
                    rememberCustomExtPreset(state, nextExt);
                  } else {
                    nextExt = 'off';
                  }
                }
                try {
                  await editTelegramMessage(
                    chatId,
                    pending.messageId,
                    listWizardText(pending.kind, pending.bits, nextThresh, pending.sort, pending.dir, nextExt),
                    listWizardKeyboard(pending.kind, pending.bits, nextThresh, pending.sort, pending.dir, nextExt, state.customExtPresets),
                  );
                } catch (err) {
                  warn(`custom-thresh apply edit failed: ${err.message}`);
                }
              }
              continue;
            }
            // Smart paste shortcut for admin DM: bare URLs / market ids
            // skip /command parsing and go straight to the action card.
            // Group chats are excluded so member-shared URLs don't expand
            // unintentionally.
            if (!text.startsWith('/') && isAdminUser(fromId)) {
              const url = extractPredictFunUrl(text);
              if (url) {
                await handleUrlPaste(url, state, fullCtx, { chatId }).catch((err) => {
                  warn('url paste error:', err.message);
                });
                continue;
              }
              const bareId = extractBareMarketId(text);
              if (bareId) {
                await showActionCardForId(bareId, state, fullCtx, chatId).catch((err) => {
                  warn('bare-id paste error:', err.message);
                });
                continue;
              }
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
            } else if (data.startsWith('stale:') || data.startsWith('all:')) {
              await handleListFilterCallback(data, { chatId, messageId, fromId, state, fullCtx }).catch((err) => {
                warn('list filter error:', err.message);
              });
            } else if (data.startsWith('new:')) {
              await handleNewWizardCallback(data, { chatId, messageId, fromId, state, fullCtx }).catch((err) => {
                warn('new wizard error:', err.message);
              });
            } else if (data.startsWith('hd:')) {
              await handleHourlyDigestCallback(data, { chatId, messageId, state, fullCtx }).catch((err) => {
                warn('hourly digest callback error:', err.message);
              });
            } else if (data.startsWith('mv:')) {
              await handleMoversCallback(data, { chatId, messageId, state }).catch((err) => {
                warn('movers callback error:', err.message);
              });
            } else if (data.startsWith('psmute:')) {
              await handlePriceSanityMuteCallback(data, { chatId, state, fullCtx }).catch((err) => {
                warn('price sanity mute error:', err.message);
              });
            } else if (data.startsWith('page:')) {
              await handlePageCallback(data, { chatId, messageId, state, fullCtx }).catch((err) => {
                warn('page callback error:', err.message);
              });
            } else if (data.startsWith('pick:') || data.startsWith('do:')) {
              await handlePickCallback(data, { chatId, messageId, state, fullCtx }).catch((err) => {
                warn('pick callback error:', err.message);
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
