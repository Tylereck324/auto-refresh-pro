// Characterization + regression tests for the shared job-settings constructor.
// composeJobSettings is the single source of truth that both the popup
// (gatherSettings) and the background (HOTKEY_TOGGLE) now call, so this pins the
// full field set and the merge/normalization rules that previously lived as two
// hand-maintained copies that drifted.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeJobSettings } = require('../compose-settings.js');

// A fully-specified popup state (what the popup's controls produce).
function popupState(over) {
  return Object.assign({
    selectedMs: 45000,
    random: false, randomMin: 5, randomMax: 60,
    stopOnClick: false, sound: false, monitor: false,
    noiseTolerant: false, collapseDigits: true, minChangedFraction: 0,
    keyword: '', kwCaseSensitive: false, kwWholeWord: false,
    kwRegex: false, kwInverse: false, stopOnKeyword: false, stopOnChange: false,
    beepUntilAck: false, flashOnKeyword: false,
  }, over || {});
}

function globals(over) {
  return Object.assign({
    hardRefresh: false, showCountdown: true, notify: false, preserveScroll: false,
    stopAfter: 0, soundVolume: 0.9, soundTone: 'beep', soundRepeat: 1,
    defaultInterval: 30,
  }, over || {});
}

// The exact field set the background's refresh loop consumes. A drift here is the
// whole class of bug this module exists to prevent.
const EXPECTED_KEYS = [
  'interval', 'hardRefresh', 'showCountdown', 'notify', 'preserveScroll',
  'stopAfter', 'soundVolume', 'soundTone', 'soundRepeat', 'randomTimer',
  'randomMin', 'randomMax', 'stopOnClick', 'sound', 'monitorMode', 'noiseTolerant',
  'collapseDigits', 'minChangedFraction', 'keyword', 'kwCaseSensitive',
  'kwWholeWord', 'kwRegex', 'kwInverse', 'stopOnKeyword', 'stopOnChange',
  'beepUntilAck', 'flashOnKeyword', 'watchSelector', 'adaptive', 'adaptiveMax',
  'webhookUrl', 'webhookFormat', 'quietHours', 'currentInterval',
].sort();

test('emits exactly the expected field set (no missing / extra keys)', () => {
  const out = composeJobSettings(popupState(), globals());
  assert.deepEqual(Object.keys(out).sort(), EXPECTED_KEYS);
});

test('interval comes from popup selectedMs; currentInterval mirrors it', () => {
  const out = composeJobSettings(popupState({ selectedMs: 12000 }), globals());
  assert.equal(out.interval, 12000);
  assert.equal(out.currentInterval, 12000);
});

test('interval falls back to the Settings default, then to 30s (hotkey path)', () => {
  // Hotkey path: popupSettings may have no selectedMs.
  assert.equal(composeJobSettings({}, globals({ defaultInterval: 20 })).interval, 20000);
  assert.equal(composeJobSettings({}, {}).interval, 30000);
});

test('preferences are pulled from globalSettings', () => {
  const out = composeJobSettings(popupState(), globals({
    hardRefresh: true, showCountdown: false, notify: true, preserveScroll: true,
    stopAfter: 7, soundVolume: 0.5, soundTone: 'chime', soundRepeat: 3,
  }));
  assert.equal(out.hardRefresh, true);
  assert.equal(out.showCountdown, false);
  assert.equal(out.notify, true);
  assert.equal(out.preserveScroll, true);
  assert.equal(out.stopAfter, 7);
  assert.equal(out.soundVolume, 0.5);
  assert.equal(out.soundTone, 'chime');
  assert.equal(out.soundRepeat, 3);
});

test('showCountdown defaults on; soundVolume defaults to 0.9; tone to beep', () => {
  const out = composeJobSettings(popupState(), {});
  assert.equal(out.showCountdown, true);   // only an explicit false disables it
  assert.equal(out.soundVolume, 0.9);
  assert.equal(out.soundTone, 'beep');
  assert.equal(out.soundRepeat, 1);
  assert.equal(out.stopAfter, 0);
});

test('per-launch flags map straight through from popup state', () => {
  const out = composeJobSettings(popupState({
    sound: true, monitor: true, noiseTolerant: true, stopOnKeyword: true,
    stopOnChange: true, beepUntilAck: true, flashOnKeyword: true, kwCaseSensitive: true,
    kwWholeWord: true, kwRegex: true, kwInverse: true, keyword: 'price',
  }), globals());
  assert.equal(out.sound, true);
  assert.equal(out.monitorMode, true);    // popup 'monitor' -> job 'monitorMode'
  assert.equal(out.noiseTolerant, true);
  assert.equal(out.stopOnKeyword, true);
  assert.equal(out.stopOnChange, true);
  assert.equal(out.beepUntilAck, true);
  assert.equal(out.flashOnKeyword, true);
  assert.equal(out.kwCaseSensitive, true);
  assert.equal(out.kwWholeWord, true);
  assert.equal(out.kwRegex, true);
  assert.equal(out.kwInverse, true);
  assert.equal(out.keyword, 'price');
});

test('flashOnKeyword defaults off when absent from popup state', () => {
  assert.equal(composeJobSettings({}, {}).flashOnKeyword, false);
  assert.equal(composeJobSettings(popupState(), globals()).flashOnKeyword, false);
});

test('collapseDigits defaults on; only an explicit false turns it off', () => {
  assert.equal(composeJobSettings(popupState({ collapseDigits: true }), globals()).collapseDigits, true);
  assert.equal(composeJobSettings(popupState({ collapseDigits: false }), globals()).collapseDigits, false);
  assert.equal(composeJobSettings({}, globals()).collapseDigits, true); // absent -> on
});

// ── Random range: floor at 2s, swap an inverted range, ms output ──────────────
test('random range is floored at 2s and converted to ms', () => {
  const out = composeJobSettings(popupState({ random: true, randomMin: 5, randomMax: 60 }), globals());
  assert.equal(out.randomTimer, true);
  assert.equal(out.randomMin, 5000);
  assert.equal(out.randomMax, 60000);
});

test('sub-2s random bounds are clamped up to the 2s floor', () => {
  const out = composeJobSettings(popupState({ random: true, randomMin: 1, randomMax: 0.5 }), globals());
  assert.equal(out.randomMin, 2000);
  assert.equal(out.randomMax, 2000);
});

test('an inverted random range is swapped, not sent negative-width', () => {
  const out = composeJobSettings(popupState({ random: true, randomMin: 60, randomMax: 5 }), globals());
  assert.equal(out.randomMin, 5000);
  assert.equal(out.randomMax, 60000);
});

// ── Moved-field fallback: random / stopOnClick used to live in Settings ───────
test('random/stopOnClick fall back to globalSettings when absent from popup state', () => {
  // Un-migrated config: popupSettings has neither field; globalSettings still does.
  const out = composeJobSettings({ selectedMs: 30000 }, globals({
    random: true, randomMin: 9, randomMax: 11, stopOnClick: true,
  }));
  assert.equal(out.randomTimer, true);
  assert.equal(out.stopOnClick, true);
  assert.equal(out.randomMin, 9000);
  assert.equal(out.randomMax, 11000);
});

test('popup state wins over the legacy globalSettings value', () => {
  const out = composeJobSettings(popupState({ random: false, stopOnClick: false }),
    globals({ random: true, stopOnClick: true }));
  assert.equal(out.randomTimer, false);
  assert.equal(out.stopOnClick, false);
});

// ── minChangedFraction is clamped to [0,1] ────────────────────────────────────
test('minChangedFraction is clamped into [0,1]', () => {
  assert.equal(composeJobSettings(popupState({ minChangedFraction: 0.3 }), globals()).minChangedFraction, 0.3);
  assert.equal(composeJobSettings(popupState({ minChangedFraction: 5 }), globals()).minChangedFraction, 1);
  assert.equal(composeJobSettings(popupState({ minChangedFraction: -1 }), globals()).minChangedFraction, 0);
  assert.equal(composeJobSettings(popupState({ minChangedFraction: 'x' }), globals()).minChangedFraction, 0);
});

// ── Robustness: empty / undefined inputs never throw and stay well-formed ─────
test('handles empty inputs without throwing and stays NaN-free', () => {
  const out = composeJobSettings(undefined, undefined);
  assert.equal(out.interval, 30000);
  assert.ok(Number.isFinite(out.randomMin) && Number.isFinite(out.randomMax));
  assert.equal(out.keyword, '');
  assert.equal(typeof out.stopOnClick, 'boolean');
});
