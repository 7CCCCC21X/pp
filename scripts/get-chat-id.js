import { config } from '../src/config.js';

async function main() {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required (set it in .env)');
  }
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${JSON.stringify(json)}`);
  const seen = new Set();
  for (const u of json.result) {
    const chat =
      u.message?.chat ?? u.channel_post?.chat ?? u.edited_message?.chat ?? u.my_chat_member?.chat;
    if (!chat || seen.has(chat.id)) continue;
    seen.add(chat.id);
    const label = chat.title ?? chat.username ?? `${chat.first_name ?? ''} ${chat.last_name ?? ''}`.trim();
    console.log(`chat_id=${chat.id}  type=${chat.type}  ${label}`);
  }
  if (!seen.size) {
    console.log('No updates yet. Send any message to your bot (or add it to the chat) and rerun.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
