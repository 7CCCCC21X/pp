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
// Build the 8-part callback parts array a button would carry.
function parts(action, { cap = '110', kind = 'all', minSh = 0, sort = 'cost', ext = 'off', page = 0 } = {}) {
  return ['combo', action, String(cap), kind, String(minSh), sort, ext, String(page)];
}

test('parseComboFilter: defaults', () => {
  const f = parseComboFilter(parts('wizard'), {});
  assert.deepEqual(f, { cap: '110', kind: 'all', minSh: 0, sort: 'cost', ext: 'off', page: 0 });
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

test('parseComboFilter: ext accepts 排除/仅 tokens, junk → off, legacy 6-part → off', () => {
  assert.equal(parseComboFilter(parts('set', { ext: '85' }), {}).ext, '85');
  assert.equal(parseComboFilter(parts('set', { ext: 'i85' }), {}).ext, 'i85');
  assert.equal(parseComboFilter(parts('set', { ext: 'bogus' }), {}).ext, 'off');
  // Legacy pre-ext callback (6 parts) still parses with ext off.
  assert.equal(parseComboFilter(['combo', 'set', '110', 'all', '0', 'cost'], {}).ext, 'off');
});

test('parseComboFilter: page parses, junk/negative → 0', () => {
  assert.equal(parseComboFilter(parts('page', { page: 3 }), {}).page, 3);
  assert.equal(parseComboFilter(parts('page', { page: -2 }), {}).page, 0);
  assert.equal(parseComboFilter(['combo', 'run', '110', 'all', '0', 'cost', 'off'], {}).page, 0);
});

test('comboWizardKeyboard: callbacks stay within Telegram 64-byte limit', () => {
  const f = { cap: '107.5', kind: 'money', minSh: 50000, sort: 'usd', ext: 'i88' };
  for (const cb of callbacks(comboWizardKeyboard(f))) {
    assert.ok(Buffer.byteLength(cb, 'utf8') <= 64, `${cb} too long`);
  }
});

test('comboWizardKeyboard: active values are checkmarked, custom cap shows ✏ value', () => {
  const kb = comboWizardKeyboard({ cap: '107.5', kind: 'date', minSh: 0, sort: 'cost', ext: '85' });
  const texts = buttonTexts(kb);
  assert.ok(texts.includes('✅ 📅 日期阶梯'));
  assert.ok(texts.includes('✅ 不限'));
  assert.ok(texts.includes('✅ 组合价(低→高)'));
  // Custom (non-preset) cap renders as a checkmarked ✏ button.
  assert.ok(texts.includes('✅ ✏<107.5¢'));
  // Active 极端价 preset is checkmarked.
  assert.ok(texts.includes('✅ 排除≥85¢'));
});

test('comboWizardKeyboard: custom ext value gets a retained checkmarked button', () => {
  const kb = comboWizardKeyboard(
    { cap: '110', kind: 'all', minSh: 0, sort: 'cost', ext: 'i88' },
    ['80'],
  );
  const texts = buttonTexts(kb);
  assert.ok(texts.includes('✅ 仅≥88¢'));   // active custom value
  assert.ok(texts.includes('排除≥80¢'));    // remembered preset from state
  assert.ok(texts.includes('🗑 清空'));
});

test('parseComboFilter: stale sort accepted', () => {
  assert.equal(parseComboFilter(parts('set', { sort: 'stale' }), {}).sort, 'stale');
});

test('parseComboFilter + keyboard: 可对冲额度 sort', () => {
  assert.equal(parseComboFilter(parts('set', { sort: 'hedge' }), {}).sort, 'hedge');
  const f = { cap: '110', kind: 'all', minSh: 0, sort: 'hedge', ext: 'off' };
  const kb = comboWizardKeyboard(f);
  assert.ok(buttonTexts(kb).includes('✅ 可对冲额度'));
  const run = callbacks(kb).find((cb) => cb.startsWith('combo:run:'));
  assert.deepEqual(parseComboFilter(run.split(':'), {}), { ...f, page: 0 });
});

test('comboWizardKeyboard: 停滞时长 sort button present and round-trips', () => {
  const f = { cap: '110', kind: 'all', minSh: 0, sort: 'stale', ext: 'off' };
  const kb = comboWizardKeyboard(f);
  assert.ok(buttonTexts(kb).includes('✅ 停滞时长'));
  const run = callbacks(kb).find((cb) => cb.startsWith('combo:run:'));
  assert.deepEqual(parseComboFilter(run.split(':'), {}), { ...f, page: 0 });
});

test('comboWizardKeyboard: round-trips through parseComboFilter', () => {
  const f = { cap: '105', kind: 'money', minSh: 100, sort: 'size', ext: '85' };
  const kb = comboWizardKeyboard(f);
  const run = callbacks(kb).find((cb) => cb.startsWith('combo:run:'));
  assert.ok(run);
  const parsed = parseComboFilter(run.split(':'), {});
  assert.deepEqual(parsed, { ...f, page: 0 });
});
