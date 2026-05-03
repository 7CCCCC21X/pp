import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { buildWelcomeText } = await import('../src/commands.js');

test('buildWelcomeText embeds the bot username in /cmd@bot examples', () => {
  const text = buildWelcomeText('mybot');
  // /activate@mybot must appear so admin can copy-paste; same for the
  // example commands group members will use.
  assert.ok(text.includes('/activate@mybot'), 'missing /activate@mybot');
  assert.ok(text.includes('/status@mybot'), 'missing /status@mybot');
  assert.ok(text.includes('/help@mybot'), 'missing /help@mybot');
  assert.ok(text.includes('@mybot 后缀'), 'missing privacy-mode reminder');
});

test('buildWelcomeText falls back to a placeholder when username unknown', () => {
  // getMe might still be in flight when the first my_chat_member arrives.
  const text = buildWelcomeText(null);
  assert.ok(text.includes('&lt;botname&gt;'), 'missing escaped placeholder');
  assert.ok(!text.includes('@null'), 'must not embed literal "null"');
});
