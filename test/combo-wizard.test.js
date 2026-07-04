import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const {
  parseComboFilter,
  comboWizardKeyboard,
} = await import('../src/commands.js');

function callbacks(kb) {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}
function buttonTexts(kb) {
  return kb.inline_keyboard.flat().map((b) => b.text);
}
// Build the 6-part callback parts array a button would carry.
function parts(action, { cap = '110', kind = 'all', minSh = 0, sort = 'cost' } = {}) {
  return ['combo', action, String(cap), kind, String(minSh), sort];
}

test('parseComboFilter: defaults', () => {
  const f = parseComboFilter(parts('wizard'), {});
  assert.deepEqual(f, { cap: '110', kind: 'all', minSh: 0, sort: 'cost' });
});

test('parseComboFilter: accepts a custom decimal cap and trims trailing zeros', () => {
  assert.equal(parseComboFilter(parts('set', { cap: '107.5' }), {}).cap, '107.5');
  assert.equal(parseComboFilter(parts('set', { cap: '105.0' }), {}).cap, '105');
});

test('parseComboFilter: junk / out-of-range cap falls back to persisted default', () => {
  const state = { comboMaxCents: 108 };
  assert.equal(parseComboFilter(parts('set', { cap: 'abc' }), state).cap, '108');
  assert.equal(parseComboFilter(parts('set', { cap: '300' }), state).cap, '108');
  assert.equal(parseComboFilter(parts('set', { cap: '10' }), state).cap, '108');
  // No persisted default → 110.
  assert.equal(parseComboFilter(parts('set', { cap: '300' }), {}).cap, '110');
});

test('parseComboFilter: kind / minSh / sort validation', () => {
  const f = parseComboFilter(parts('set', { kind: 'date', minSh: 500, sort: 'size' }), {});
  assert.equal(f.kind, 'date');
  assert.equal(f.minSh, 500);
  assert.equal(f.sort, 'size');
  const bad = parseComboFilter(parts('set', { kind: 'bogus', minSh: -5, sort: 'nope' }), {});
  assert.equal(bad.kind, 'all');
  assert.equal(bad.minSh, 0);
  assert.equal(bad.sort, 'cost');
});

test('comboWizardKeyboard: callbacks stay within Telegram 64-byte limit', () => {
  const f = { cap: '107.5', kind: 'money', minSh: 50000, sort: 'usd' };
  for (const cb of callbacks(comboWizardKeyboard(f))) {
    assert.ok(Buffer.byteLength(cb, 'utf8') <= 64, `${cb} too long`);
  }
});

test('comboWizardKeyboard: active values are checkmarked, custom cap shows ✏ value', () => {
  const kb = comboWizardKeyboard({ cap: '107.5', kind: 'date', minSh: 0, sort: 'cost' });
  const texts = buttonTexts(kb);
  assert.ok(texts.includes('✅ 📅 日期阶梯'));
  assert.ok(texts.includes('✅ 不限'));
  assert.ok(texts.includes('✅ 组合价(低→高)'));
  // Custom (non-preset) cap renders as a checkmarked ✏ button.
  assert.ok(texts.includes('✅ ✏<107.5¢'));
});

test('comboWizardKeyboard: round-trips through parseComboFilter', () => {
  const f = { cap: '105', kind: 'money', minSh: 100, sort: 'size' };
  const kb = comboWizardKeyboard(f);
  const run = callbacks(kb).find((cb) => cb.startsWith('combo:run:'));
  assert.ok(run);
  const parsed = parseComboFilter(run.split(':'), {});
  assert.deepEqual(parsed, f);
});
