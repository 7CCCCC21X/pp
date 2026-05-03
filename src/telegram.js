import { config } from './config.js';
import { fetchJson } from './http.js';

export function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TELEGRAM_MAX = 3900; // Telegram caps at 4096; leave headroom for HTML.

function tgUrl(method) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

// Standard short-lived API call: timeout + retry via fetchJson.
export async function tgApi(method, payload, { timeoutMs = 15_000, retries = 2 } = {}) {
  const json = await fetchJson(tgUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
    retries,
  });
  if (!json?.ok) throw new Error(`Telegram ${method} not ok: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

// getUpdates uses long polling and needs the orchestrator's AbortController
// for graceful shutdown, so we keep it on raw fetch instead of fetchJson.
// my_chat_member tells us when the bot is added to / removed from / promoted
// in a chat — needed for the auto-welcome on group join.
export async function getUpdates({ offset, timeoutSec = 25, signal } = {}) {
  const res = await fetch(tgUrl('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Telegram getUpdates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (!json?.ok) throw new Error(`Telegram getUpdates not ok: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

export async function sendTelegramMessage(text, { chatId, replyMarkup } = {}) {
  const payload = {
    chat_id: chatId ?? config.telegramChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApi('sendMessage', payload);
}

// Splits long text on line boundaries into chunks ≤ TELEGRAM_MAX. Sends them
// sequentially with a small delay so we don't hit Telegram's per-chat rate
// limit. Only the LAST chunk gets the reply_markup (keyboard) so action
// buttons appear once at the bottom.
export async function sendLongTelegramMessage(text, opts = {}) {
  if (text.length <= TELEGRAM_MAX) {
    return [await sendTelegramMessage(text, opts)];
  }
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > TELEGRAM_MAX && cur.length > 0) {
      chunks.push(cur);
      cur = line;
    } else if (line.length > TELEGRAM_MAX) {
      // Single line too long — hard split.
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += TELEGRAM_MAX) {
        chunks.push(line.slice(i, i + TELEGRAM_MAX));
      }
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkOpts = isLast ? opts : { chatId: opts.chatId };
    results.push(await sendTelegramMessage(chunks[i], chunkOpts));
    if (!isLast) await new Promise((r) => setTimeout(r, 350));
  }
  return results;
}

// Fans out a single text + reply_markup to every chatId in the list.
// Each chat is independent — a failed send is logged and skipped so one
// bad group doesn't cancel the broadcast to admin's private chat. Empty
// list returns immediately.
export async function broadcastTelegramMessage(text, { chatIds, replyMarkup } = {}) {
  if (!Array.isArray(chatIds) || chatIds.length === 0) return [];
  const results = [];
  for (const id of chatIds) {
    try {
      const r = await sendLongTelegramMessage(text, { chatId: id, replyMarkup });
      results.push(r);
    } catch (err) {
      console.warn(new Date().toISOString(), '[telegram] broadcast to', id, 'failed:', err.message);
      results.push(null);
    }
  }
  return results;
}

export async function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApi('editMessageText', payload);
}

// scope: optional Telegram BotCommandScope object, e.g.
// { type: 'all_private_chats' } / { type: 'all_group_chats' } /
// { type: 'default' }. Without it, sets the default scope (fallback
// for every chat type that has no more-specific scope).
export async function setMyCommands(commands, scope) {
  const payload = { commands };
  if (scope) payload.scope = scope;
  return tgApi('setMyCommands', payload);
}

// One-shot bot identity lookup, cached for the process lifetime so the
// my_chat_member handler can recognise events about itself ("am I the
// chat member that was just added?") and so welcome messages can embed
// the bot's @username for /cmd@<botname> instructions in groups.
let cachedMe = null;
export async function getMe() {
  if (!cachedMe) cachedMe = await tgApi('getMe', {});
  return cachedMe;
}

export async function answerCallbackQuery(callbackQueryId, { text, showAlert } = {}) {
  return tgApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ?? '',
    show_alert: !!showAlert,
  });
}
