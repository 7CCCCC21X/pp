import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= '1';

const { rebalanceHtmlChunks } = await import('../src/telegram.js');

test('rebalance: closes <pre> dangling at end of chunk[0]', () => {
  const chunks = ['hello <pre>line1\nline2', 'line3</pre> tail'];
  rebalanceHtmlChunks(chunks);
  assert.equal(chunks[0], 'hello <pre>line1\nline2</pre>');
  assert.equal(chunks[1], '<pre>line3</pre> tail');
});

test('rebalance: handles balanced chunks (no-op)', () => {
  const chunks = ['<b>hi</b>', '<i>there</i>'];
  const before = [...chunks];
  rebalanceHtmlChunks(chunks);
  assert.deepEqual(chunks, before);
});

test('rebalance: closes nested <pre><code>', () => {
  // Both opened, neither closed at split.
  const chunks = ['<pre><code>foo', 'bar</code></pre>'];
  rebalanceHtmlChunks(chunks);
  // code closed first, then pre — order matters
  assert.equal(chunks[0], '<pre><code>foo</code></pre>');
  assert.equal(chunks[1], '<pre><code>bar</code></pre>');
});

test('rebalance: ignores stray close tags (negative balance clamps to 0)', () => {
  const chunks = ['hello </pre> oops', 'next'];
  const before = [...chunks];
  rebalanceHtmlChunks(chunks);
  assert.deepEqual(chunks, before, 'must not invent <pre> when no opening exists');
});

test('rebalance: <code attr="x"> open tag with attributes is detected', () => {
  // We don't generate this today but be defensive.
  const chunks = ['<code class="t">stuff', 'more</code>'];
  rebalanceHtmlChunks(chunks);
  assert.ok(chunks[0].endsWith('</code>'));
  assert.ok(chunks[1].startsWith('<code>'));
});
