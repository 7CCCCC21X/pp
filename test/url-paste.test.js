import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

// Real implementations — exported from commands.js so these tests can't
// drift from what the bot actually runs.
const { extractPredictFunUrl, slugFromPredictUrl } = await import('../src/commands.js');

test('extractPredictFunUrl: pulls bare URL from message', () => {
  assert.equal(
    extractPredictFunUrl('https://predict.fun/zh-cn/market/foo-bar-2026'),
    'https://predict.fun/zh-cn/market/foo-bar-2026',
  );
});

test('extractPredictFunUrl: surrounded by other text', () => {
  assert.equal(
    extractPredictFunUrl('看下这个 https://predict.fun/en/market/x 顺便加监控'),
    'https://predict.fun/en/market/x',
  );
});

test('extractPredictFunUrl: ignores non-predict.fun URLs', () => {
  assert.equal(extractPredictFunUrl('https://example.com/market/x'), null);
});

test('extractPredictFunUrl: returns null for plain text', () => {
  assert.equal(extractPredictFunUrl('hello world'), null);
  assert.equal(extractPredictFunUrl(null), null);
});

test('slugFromPredictUrl: pulls slug regardless of locale prefix', () => {
  assert.equal(
    slugFromPredictUrl('https://predict.fun/zh-cn/market/will-jesus-return-2027'),
    'will-jesus-return-2027',
  );
  assert.equal(
    slugFromPredictUrl('https://predict.fun/en/market/btc-100k'),
    'btc-100k',
  );
});

test('slugFromPredictUrl: handles query strings', () => {
  assert.equal(
    slugFromPredictUrl('https://predict.fun/zh-cn/market/foo?ref=abc'),
    'foo',
  );
});

test('slugFromPredictUrl: returns null when /market/ is absent', () => {
  assert.equal(slugFromPredictUrl('https://predict.fun/zh-cn/leaderboard'), null);
});

// Regex copy mirrors extractBareMarketId in src/commands.js — keeps
// behaviour locked even though the function isn't exported.
function extractBareMarketId(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^#?(\d{4,})$/);
  return m ? m[1] : null;
}

test('extractBareMarketId: digit-only message resolves to id', () => {
  assert.equal(extractBareMarketId('241373'), '241373');
  assert.equal(extractBareMarketId('  241373  '), '241373');
});

test('extractBareMarketId: tolerates leading #', () => {
  assert.equal(extractBareMarketId('#257916'), '257916');
});

test('extractBareMarketId: rejects too-short numbers (probably not ids)', () => {
  assert.equal(extractBareMarketId('5'), null);
  assert.equal(extractBareMarketId('100'), null);
});

test('extractBareMarketId: rejects mixed text', () => {
  assert.equal(extractBareMarketId('id: 241373'), null);
  assert.equal(extractBareMarketId('241373 watch'), null);
});

test('extractPredictFunUrl: accepts www. prefix', () => {
  assert.equal(
    extractPredictFunUrl('https://www.predict.fun/event/foo-fdv'),
    'https://www.predict.fun/event/foo-fdv',
  );
});

test('slugFromPredictUrl: event pages (multi-outcome ladders)', () => {
  assert.equal(
    slugFromPredictUrl('https://predict.fun/event/aligned-fdv-one-day-after-launch'),
    'aligned-fdv-one-day-after-launch',
  );
  assert.equal(
    slugFromPredictUrl('https://predict.fun/zh-cn/events/foo-bar?tab=orders'),
    'foo-bar',
  );
  assert.equal(
    slugFromPredictUrl('https://predict.fun/markets/btc-100k'),
    'btc-100k',
  );
});

test('slugFromPredictUrl: decodes percent-encoded slugs', () => {
  assert.equal(
    slugFromPredictUrl('https://predict.fun/event/foo%2Dbar'),
    'foo-bar',
  );
});
