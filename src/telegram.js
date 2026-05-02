import { config } from './config.js';

export function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export async function tgApi(method, payload, { signal } = {}) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram ${method} not ok: ${JSON.stringify(json)}`);
  }
  return json.result;
}

export async function sendTelegramMessage(text, { chatId } = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId ?? config.telegramChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function getUpdates({ offset, timeoutSec = 25, signal } = {}) {
  return tgApi(
    'getUpdates',
    {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message'],
    },
    { signal },
  );
}
