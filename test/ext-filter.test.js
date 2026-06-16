import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'x';
process.env.TELEGRAM_CHAT_ID ??= '1';
process.env.MARKET_IDS ??= 'A,B,C';

const { passesExtFilter, extTopOfBook, rememberCustomExtPreset, listWizardKeyboard } = await import('../src/commands.js');

// Flatten an inline_keyboard to the list of button texts for easy assertions.
function buttonTexts(kb) {
  return kb.inline_keyboard.flat().map((b) => b.text);
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
