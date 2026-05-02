import { config, isAllowedChat } from './config.js';
import { sendTelegramMessage, htmlEscape, getUpdates } from './telegram.js';
import { activeMarketIds } from './state.js';
import { fmtElapsed } from './format.js';

const log = (...args) => console.log(new Date().toISOString(), '[commands]', ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[commands]', ...args);

const HELP = [
  '<b>命令列表</b>',
  '/status — 概览所有监控市场',
  '/list — 简要列出活跃市场',
  '/add &lt;id&gt; — 加入监控',
  '/remove &lt;id&gt; — 永久移除（含自动发现）',
  '/pause &lt;id&gt; — 静音该市场提醒',
  '/resume &lt;id&gt; — 取消静音',
  '/discover — 立即触发一次自动发现',
  '/digest — 立即发送 24 小时摘要',
  '/help — 本帮助',
].join('\n');

function uniq(arr) {
  return [...new Set(arr.map(String))];
}

function statusLine(state, id) {
  const slot = state.markets[id];
  const paused = state.pausedIds.includes(id);
  const tag = paused ? ' [paused]' : '';
  if (!slot) return `#${id}${tag} — 等待首次抓取`;
  const since = Date.now() - (slot.lastChangeAt ?? Date.now());
  const rate = Number.isFinite(slot.lastHourlyRate) ? slot.lastHourlyRate.toFixed(4) : '?';
  const title = slot.title ? slot.title.slice(0, 50) : `Market ${id}`;
  return `#${id}${tag} ${title} — 停滞 ${fmtElapsed(since)} · PP ${rate}/h`;
}

async function handle(text, state, ctx) {
  const [raw, ...rest] = text.trim().split(/\s+/);
  if (!raw) return null;
  const cmd = raw.replace(/@\w+$/, '').toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start':
    case '/help':
      return HELP;

    case '/status': {
      const ids = activeMarketIds(state);
      if (!ids.length) return '当前没有监控的市场。用 /add &lt;id&gt; 加一个。';
      const lines = ids.map((id) => htmlEscape(statusLine(state, id)));
      return [`<b>监控中 ${ids.length} 个市场</b>`, ...lines].join('\n');
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

    default:
      return null;
  }
}

export function startCommandLoop({ getState, persist, ctx }) {
  if (!config.telegramCommandsEnabled) {
    log('disabled');
    return { stop: () => {} };
  }
  let stopped = false;
  const ctrl = new AbortController();
  const fullCtx = { ...ctx, persist };

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
          const msg = u.message;
          if (!msg || !msg.text) continue;
          const chatId = msg.chat?.id;
          if (!isAllowedChat(chatId)) {
            warn(`ignoring message from chat ${chatId}`);
            continue;
          }
          try {
            const reply = await handle(msg.text, state, fullCtx);
            if (reply) await sendTelegramMessage(reply, { chatId });
          } catch (err) {
            warn('handler error:', err.message);
            await sendTelegramMessage(`错误: ${htmlEscape(err.message)}`, { chatId }).catch(() => {});
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
