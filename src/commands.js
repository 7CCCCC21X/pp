import { config, isAllowedChat } from './config.js';
import {
  sendTelegramMessage,
  htmlEscape,
  getUpdates,
  setMyCommands,
  answerCallbackQuery,
} from './telegram.js';
import { activeMarketIds } from './state.js';
import { fmtElapsed, rewardZoneStatus, midOf, spreadOf } from './format.js';
import { effectiveFilters, formatFilters, FILTER_KEYS, FILTER_LABELS } from './filters.js';
import { getMarketRewardSummary, getOrderbook } from './predict.js';

const log = (...args) => console.log(new Date().toISOString(), '[commands]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[commands]', ...args);

// Commands shown in Telegram's blue "/" menu next to the input box.
const COMMAND_MENU = [
  { command: 'menu', description: '快捷菜单' },
  { command: 'status', description: '所有监控市场概览' },
  { command: 'list', description: '简要列出活跃市场' },
  { command: 'probe', description: '查看单个市场快照 (用法: /probe <id>)' },
  { command: 'watch', description: '密集追踪某市场 (用法: /watch <id>)' },
  { command: 'unwatch', description: '取消密集追踪' },
  { command: 'add', description: '加入监控 (用法: /add <id>)' },
  { command: 'remove', description: '永久移除' },
  { command: 'pause', description: '静音指定市场' },
  { command: 'resume', description: '恢复监控' },
  { command: 'discover', description: '立即触发自动发现' },
  { command: 'digest', description: '发送 24 小时摘要' },
  { command: 'filter', description: '查看当前过滤器' },
  { command: 'setfilter', description: '设置过滤器 (用法: /setfilter name value)' },
  { command: 'clearfilter', description: '清除过滤器' },
  { command: 'help', description: '显示帮助' },
];

// Inline keyboard for /menu — quick-tap buttons that issue commands via
// callback_data. Each button label is short to fit on mobile.
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '状态', callback_data: '/status' },
        { text: '列表', callback_data: '/list' },
      ],
      [
        { text: '立即发现', callback_data: '/discover' },
        { text: '24h 摘要', callback_data: '/digest' },
      ],
      [
        { text: '过滤器', callback_data: '/filter' },
        { text: '帮助', callback_data: '/help' },
      ],
    ],
  };
}

// Inline keyboard attached to alert messages so the user can act
// straight from the alert push without typing.
export function alertKeyboard(marketId) {
  return {
    inline_keyboard: [
      [
        { text: '静音此市场', callback_data: `/pause ${marketId}` },
        { text: '查看状态', callback_data: '/status' },
      ],
    ],
  };
}

const HELP = [
  '<b>命令列表</b>',
  '/menu — 快捷按钮菜单',
  '/status — 概览所有监控市场',
  '/list — 简要列出活跃市场',
  '/probe &lt;id&gt; — 单个市场快照（订单簿 + 奖励区）',
  '/watch &lt;id&gt; — 密集追踪（每次买1卖1变动就提醒）',
  '/unwatch &lt;id|all&gt; — 取消密集追踪',
  '/add &lt;id&gt; — 加入监控',
  '/remove &lt;id&gt; — 永久移除（含自动发现）',
  '/pause &lt;id&gt; — 静音该市场提醒',
  '/resume &lt;id&gt; — 取消静音',
  '/discover — 立即触发一次自动发现',
  '/digest — 立即发送 24 小时摘要',
  '',
  '<b>过滤器</b>（只有满足条件的市场才会触发提醒，支持 1-3 档）',
  '/filter — 查看当前过滤器',
  '/setfilter &lt;name&gt; &lt;value&gt; — 设置（如 /setfilter minBid1Price 0.05）',
  '/clearfilter &lt;name|all&gt; — 清除单项或全部覆盖',
  '字段命名: min/max + Bid/Ask + 1/2/3 + Price/Size',
  '示例: minBid1Price, maxBid1Price, minBid1Size, minAsk2Price ...',
  '',
  '/help — 本帮助',
].join('\n');

function uniq(arr) {
  return [...new Set(arr.map(String))];
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
  const lines = [
    `<b>${htmlEscape((m.title ?? m.question ?? '').slice(0, 60))}</b> (#${htmlEscape(marketId)})`,
    `PP/h: ${summary.totalHourlyRate.toFixed(2)}  ·  status: ${htmlEscape(String(m.status ?? m.tradingStatus ?? '?'))}`,
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

function statusLine(state, id) {
  const slot = state.markets[id];
  const paused = state.pausedIds.includes(id);
  const watched = (state.watchedIds ?? []).includes(id);
  const tags = [paused ? 'paused' : '', watched ? 'watch' : ''].filter(Boolean);
  const tag = tags.length ? ` [${tags.join(',')}]` : '';
  if (!slot) return `#${id}${tag} — 等待首次抓取`;
  const since = Date.now() - (slot.lastChangeAt ?? Date.now());
  const rate = Number.isFinite(slot.lastHourlyRate) ? slot.lastHourlyRate.toFixed(0) : '?';
  const title = slot.title ? slot.title.slice(0, 40) : `Market ${id}`;
  return `#${id}${tag} ${title} — 停滞 ${fmtElapsed(since)} · ${rate}/h${zoneTag(slot)}`;
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

    case '/status': {
      const ids = activeMarketIds(state);
      if (!ids.length) return '当前没有监控的市场。用 /add &lt;id&gt; 加一个。';
      // Compute 24h PP total from history (best-effort, async).
      let header = `<b>监控中 ${ids.length} 个市场</b>`;
      try {
        const { readHistorySince, summarize24h } = await import('./history.js');
        const since = Date.now() - 24 * 3600 * 1000;
        const records = await readHistorySince(since);
        const summary = summarize24h(records);
        const totalPP = summary.reduce((a, m) => a + (m.ppEarned ?? 0), 0);
        if (totalPP > 0) header += `\n过去 24h 累计 PP: <b>${totalPP.toFixed(2)}</b>`;
      } catch {}
      const lines = ids.map((id) => htmlEscape(statusLine(state, id)));
      return [header, ...lines].join('\n');
    }

    case '/list': {
      const ids = activeMarketIds(state);
      if (!ids.length) return '空。';
      return ids.map((id) => `#${id}${state.pausedIds.includes(id) ? ' (paused)' : ''}`).join('\n');
    }

    case '/add': {
      if (!arg) return '用法：/add &lt;marketId&gt;';
      state.manualIds = uniq([...state.manualIds, arg]);
      state.removedIds = state.removedIds.filter((x) => x !== arg);
      await ctx.persist();
      return `已加入 #${htmlEscape(arg)}`;
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

    case '/digest': {
      ctx.requestDigest();
      return '已触发 24 小时摘要。';
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
      if (!arg) return '用法：/watch &lt;marketId&gt;\n密集追踪：每次 tick 检测到买1卖1变动就立刻提醒（1 分钟冷却）。';
      state.watchedIds = uniq([...(state.watchedIds ?? []), arg]);
      state.removedIds = state.removedIds.filter((x) => x !== arg);
      await ctx.persist();
      return `已开启密集追踪 #${htmlEscape(arg)}（每次变动都会推送）。/unwatch 取消。`;
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
  await sendTelegramMessage(norm.text, { chatId, replyMarkup: norm.replyMarkup }).catch((err) => {
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
            // Always answer the callback so Telegram dismisses the loading
            // spinner, even if the chat is not allowed.
            await answerCallbackQuery(cq.id).catch(() => {});
            if (!isAllowedChat(chatId)) {
              warn(`ignoring callback from chat ${chatId}`);
              continue;
            }
            const data = String(cq.data ?? '').trim();
            if (data) await dispatchCommand(data, state, fullCtx, { chatId });
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
