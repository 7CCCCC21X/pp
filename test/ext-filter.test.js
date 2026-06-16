import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const {
  passesExtFilter,
  extTopOfBook,
  rememberCustomExtPreset,
  listWizardKeyboard,
  extPickerKeyboard,
  threshPickerKeyboard,
} = await import('../src/commands.js');

// Flatten an inline_keyboard to the list of button texts for easy assertions.
function buttonTexts(kb) {
  return kb.inline_keyboard.flat().map((b) => b.text);
}
// All callback_data strings on a keyboard.
function callbacks(kb) {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}

test('extTopOfBook: prefers the fresher of recentBook vs baseline', () => {
  // recentBook newer than the monitor baseline → use it.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 1000,
    recentBook: { bids: [{ price: 0.12, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.12, ask: 0.90 });
});

test('extTopOfBook: falls back to baseline when it is the fresher snapshot', () => {
  // Baseline polled after the last wizard refetch → trust the baseline.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 5000,
    recentBook: { bids: [{ price: 0.12, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.10, ask: 0.80 });
});

test('extTopOfBook: baseline-only slot', () => {
  const slot = { baseline: { bidPrice: 0.10, askPrice: 0.80 } };
  assert.deepEqual(extTopOfBook(slot), { bid: 0.10, ask: 0.80 });
});

test('passesExtFilter: "仅 ≥85" judged on the refetched book, not stale baseline', () => {
  // Baseline says ask 0.80 (not extreme); the live refetch shows ask 0.90.
  // The filter must agree with the fresh book the user would open.
  const slot = {
    baseline: { bidPrice: 0.10, askPrice: 0.80 },
    lastObservedAt: 1000,
    recentBook: { bids: [{ price: 0.10, size: 1 }], asks: [{ price: 0.90, size: 1 }], fetchedAt: 2000 },
  };
  assert.equal(passesExtFilter(slot, 'i85'), true);  // include-only-extreme → kept
  assert.equal(passesExtFilter(slot, '85'), false);  // exclude-extreme → dropped
});

test('passesExtFilter: bid side counts as extreme too', () => {
  const slot = { baseline: { bidPrice: 0.05, askPrice: 0.40 } };
  // bid 0.05 ≤ (100-85)=15¢ → extreme.
  assert.equal(passesExtFilter(slot, 'i85'), true);
});

test('passesExtFilter: off mode keeps everything', () => {
  const slot = { baseline: { bidPrice: 0.50, askPrice: 0.52 } };
  assert.equal(passesExtFilter(slot, 'off'), true);
});

test('rememberCustomExtPreset: stores genuinely-custom values, skips presets', () => {
  const state = { customExtPresets: [] };
  rememberCustomExtPreset(state, '80');   // custom exclude
  rememberCustomExtPreset(state, 'i70');  // custom include
  rememberCustomExtPreset(state, '85');   // preset → ignored
  rememberCustomExtPreset(state, 'off');  // off → ignored
  assert.deepEqual(state.customExtPresets, ['i70', '80']); // most-recent first
});

test('rememberCustomExtPreset: dedupes (move-to-front) and caps the list', () => {
  const state = { customExtPresets: [] };
  for (const v of ['81', '82', '83', '84', '85custom', '86']) {
    // 85custom is invalid token → ignored; the rest are kept, capped at 4.
    rememberCustomExtPreset(state, v);
  }
  assert.equal(state.customExtPresets.length, 4);
  assert.equal(state.customExtPresets[0], '86'); // newest first
  // Re-adding an existing value moves it to the front without growing the list.
  rememberCustomExtPreset(state, '83');
  assert.equal(state.customExtPresets[0], '83');
  assert.equal(state.customExtPresets.length, 4);
});

test('listWizardKeyboard: renders retained custom presets + clear button', () => {
  const kb = listWizardKeyboard('all', '100100', 'inf', 'p', 'le', 'off', ['80', 'i70']);
  const texts = buttonTexts(kb);
  assert.ok(texts.includes('排除≥80¢'), 'custom exclude button shown');
  assert.ok(texts.includes('仅≥70¢'), 'custom include button shown');
  assert.ok(texts.includes('🗑 清空'), 'clear button shown');
});

test('listWizardKeyboard: active custom value appears as a checkmarked button', () => {
  // Active ext is a custom value not yet in the stored list → still rendered.
  const kb = listWizardKeyboard('all', '100100', 'inf', 'p', 'le', '77', []);
  const texts = buttonTexts(kb);
  assert.ok(texts.includes('✅ 排除≥77¢'), 'active custom value checkmarked');
});

test('listWizardKeyboard: no custom row when there are none', () => {
  const kb = listWizardKeyboard('all', '100100', 'inf', 'p', 'le', 'off', []);
  const texts = buttonTexts(kb);
  assert.ok(!texts.includes('🗑 清空'), 'no clear button without customs');
});

test('listWizardKeyboard: ✏ buttons open picker cards (not direct reply prompt)', () => {
  const cbs = callbacks(listWizardKeyboard('all', '100100', 'inf', 'p', 'le', 'off', []));
  assert.ok(cbs.includes('all:ext-pick:100100:inf:p:le:off:0'), '极端价 ✏ opens ext picker');
  assert.ok(cbs.includes('all:thresh-pick:100100:inf:p:le:off:0'), '阈值 ✏ opens thresh picker');
});

test('extPickerKeyboard: tap-to-choose values + manual input + back', () => {
  const kb = extPickerKeyboard('all', '100100', 'inf', 'p', 'le', 'off');
  const texts = buttonTexts(kb);
  const cbs = callbacks(kb);
  assert.ok(texts.includes('排除≥80¢'), 'exclude preset shown');
  assert.ok(texts.includes('仅≥92¢'), 'include preset shown');
  assert.ok(texts.includes('✏ 手动输入数字'), 'manual input fallback shown');
  assert.ok(texts.includes('⬅ 返回'), 'back button shown');
  // Value buttons select via 'set'; manual input drops to the reply flow.
  assert.ok(cbs.includes('all:set:100100:inf:p:le:80:0'), 'tapping a value selects it');
  assert.ok(cbs.includes('all:custom-ext:100100:inf:p:le:off:0'), 'manual input → reply flow');
});

test('extPickerKeyboard: marks the active value', () => {
  const texts = buttonTexts(extPickerKeyboard('all', '100100', 'inf', 'p', 'le', '80'));
  assert.ok(texts.includes('✅ 排除≥80¢'), 'active custom value checkmarked in picker');
});

test('threshPickerKeyboard: value buttons respect dir and offer manual input', () => {
  const kb = threshPickerKeyboard('all', '100100', 'inf', 'p', 'ge', 'off');
  const texts = buttonTexts(kb);
  const cbs = callbacks(kb);
  assert.ok(texts.includes('≥$1500'), 'value label respects ge direction');
  assert.ok(texts.includes('✏ 手动输入数字'), 'manual input fallback shown');
  assert.ok(cbs.includes('all:set:100100:1500:p:ge:off:0'), 'tapping a value selects it');
  assert.ok(cbs.includes('all:custom:100100:inf:p:ge:off:0'), 'manual input → reply flow');
});
