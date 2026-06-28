import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const {
  parseTightFilter,
  tightWizardKeyboard,
} = await import('../src/commands.js');

function buttonTexts(kb) {
  return kb.inline_keyboard.flat().map((b) => b.text);
}
function callbacks(kb) {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}
// Build the 10-part callback parts array a button would carry.
function parts(action, { levels = 3, gap = 'auto', minSh = 0, both = 1, sort = 'shares', spread = 'inf', ext = 'off', page = 0 } = {}) {
  return ['tight', action, String(levels), String(gap), String(minSh), String(both), sort, String(spread), ext, String(page)];
}

test('parseTightFilter: accepts a custom gap value (decimal cents)', () => {
  const f = parseTightFilter(parts('set', { gap: '0.3' }));
  assert.equal(f.gap, '0.3');
});

test('parseTightFilter: trims trailing zeros on a custom gap', () => {
  const f = parseTightFilter(parts('set', { gap: '0.30' }));
  assert.equal(f.gap, '0.3');
});

test('parseTightFilter: junk / out-of-range gap falls back to 整格(auto)', () => {
  assert.equal(parseTightFilter(parts('set', { gap: 'abc' })).gap, 'auto');
  assert.equal(parseTightFilter(parts('set', { gap: '999' })).gap, 'auto'); // > 50¢ cap
  assert.equal(parseTightFilter(parts('set', { gap: '0' })).gap, 'auto');
});

test('parseTightFilter: accepts a custom 买1卖1价差 value, junk → 不限', () => {
  assert.equal(parseTightFilter(parts('set', { spread: '0.3' })).spread, '0.3');
  assert.equal(parseTightFilter(parts('set', { spread: 'xyz' })).spread, 'inf');
});

test('parseTightFilter: custom minSh and custom ext (仅 mode) round-trip', () => {
  const f = parseTightFilter(parts('set', { minSh: 2500, ext: 'i88' }));
  assert.equal(f.minSh, 2500);
  assert.equal(f.ext, 'i88');
});

test('tightWizardKeyboard: every knob row carries a ✏ custom affordance', () => {
  const f = parseTightFilter(parts('set'));
  const cbs = callbacks(tightWizardKeyboard(f));
  assert.ok(cbs.some((c) => c.startsWith('tight:cust-gap:')), 'gap ✏');
  assert.ok(cbs.some((c) => c.startsWith('tight:cust-minsh:')), 'minSh ✏');
  assert.ok(cbs.some((c) => c.startsWith('tight:cust-spread:')), 'spread ✏');
  assert.ok(cbs.some((c) => c.startsWith('tight:cust-ext:')), 'ext ✏');
});

test('tightWizardKeyboard: 极端价 offers both 排除 and 仅 modes', () => {
  const f = parseTightFilter(parts('set'));
  const texts = buttonTexts(tightWizardKeyboard(f));
  assert.ok(texts.includes('排除≥94¢'), 'exclude preset shown');
  assert.ok(texts.includes('仅≥94¢'), 'include preset shown');
  assert.ok(texts.some((t) => t.includes('关')), 'off shown'); // checkmarked by default → '✅ 关'
});

test('tightWizardKeyboard: active custom gap shows as a checkmarked ✏ button', () => {
  const f = parseTightFilter(parts('set', { gap: '0.3' }));
  const texts = buttonTexts(tightWizardKeyboard(f));
  assert.ok(texts.includes('✅ ✏0.3¢'), 'custom gap checkmarked');
});

test('tightWizardKeyboard: active custom minSh checkmarked, presets are not', () => {
  const f = parseTightFilter(parts('set', { minSh: 2500 }));
  const texts = buttonTexts(tightWizardKeyboard(f));
  assert.ok(texts.includes('✅ ✏≥2.5k'), 'custom minSh checkmarked');
});

test('tightWizardKeyboard: remembered custom ext values render as buttons + 清空', () => {
  const f = parseTightFilter(parts('set'));
  const texts = buttonTexts(tightWizardKeyboard(f, ['80', 'i70']));
  assert.ok(texts.includes('排除≥80¢'), 'custom exclude shown');
  assert.ok(texts.includes('仅≥70¢'), 'custom include shown');
  assert.ok(texts.includes('🗑 清空'), 'clear button shown');
});

test('tightWizardKeyboard: active custom ext appears even before it is stored', () => {
  const f = parseTightFilter(parts('set', { ext: '77' }));
  const texts = buttonTexts(tightWizardKeyboard(f, []));
  assert.ok(texts.includes('✅ 排除≥77¢'), 'active custom ext checkmarked');
  assert.ok(texts.includes('🗑 清空'), 'clear button present');
});

test('tightWizardKeyboard: no 清空 button when there are no custom ext values', () => {
  const f = parseTightFilter(parts('set'));
  const texts = buttonTexts(tightWizardKeyboard(f, []));
  assert.ok(!texts.includes('🗑 清空'), 'no clear button without customs');
});
