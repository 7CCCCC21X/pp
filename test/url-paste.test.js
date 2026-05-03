import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

// Helpers used by the URL paste flow are not exported, but the URL/slug
// extraction logic is the one that breaks if regex changes; we copy
// the regex literal here and assert behaviour. The keyboard / action
// flow is covered by integration in the bot itself.

const PREDICT_URL_RE = /https?:\/\/predict\.fun\/[^\s]+/i;

function extractPredictFunUrl(text) {
  const m = text?.match?.(PREDICT_URL_RE);
  return m ? m[0] : null;
}
function slugFromPredictUrl(url) {
  const m = url.match(/\/market\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

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
