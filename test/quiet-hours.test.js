// Tests for the quiet-hours window logic.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isWithinQuietHours, quietAction, isChannelMuted, parseTimeToMinutes, minutesToTime,
} = require('../quiet-hours.js');

const at = (h, m, day) => ({ minutesOfDay: h * 60 + (m || 0), day });

// ── enabled gate ──────────────────────────────────────────────────────────
test('disabled config is never quiet', () => {
  assert.equal(isWithinQuietHours(at(3, 0), { enabled: false, startMin: 0, endMin: 1439 }), false);
  assert.equal(isWithinQuietHours(at(3, 0), null), false);
});

// ── same-day window [start,end) ───────────────────────────────────────────
test('same-day window is half-open [start, end)', () => {
  const cfg = { enabled: true, startMin: 9 * 60, endMin: 17 * 60 }; // 09:00–17:00
  assert.equal(isWithinQuietHours(at(9, 0), cfg), true);   // start is inclusive
  assert.equal(isWithinQuietHours(at(12, 0), cfg), true);
  assert.equal(isWithinQuietHours(at(16, 59), cfg), true);
  assert.equal(isWithinQuietHours(at(17, 0), cfg), false); // end is exclusive
  assert.equal(isWithinQuietHours(at(8, 59), cfg), false);
  assert.equal(isWithinQuietHours(at(20, 0), cfg), false);
});

// ── midnight-wrapping window ──────────────────────────────────────────────
test('window wrapping midnight covers both sides', () => {
  const cfg = { enabled: true, startMin: 22 * 60, endMin: 7 * 60 }; // 22:00–07:00
  assert.equal(isWithinQuietHours(at(23, 0), cfg), true);
  assert.equal(isWithinQuietHours(at(0, 0), cfg), true);
  assert.equal(isWithinQuietHours(at(6, 59), cfg), true);
  assert.equal(isWithinQuietHours(at(7, 0), cfg), false);
  assert.equal(isWithinQuietHours(at(12, 0), cfg), false);
  assert.equal(isWithinQuietHours(at(21, 59), cfg), false);
});

test('a zero-width window (start === end) is disabled, not all-day', () => {
  const cfg = { enabled: true, startMin: 9 * 60, endMin: 9 * 60 };
  assert.equal(isWithinQuietHours(at(9, 0), cfg), false);
  assert.equal(isWithinQuietHours(at(15, 0), cfg), false);
});

// ── weekday filter ────────────────────────────────────────────────────────
test('days mask restricts the window to enabled weekdays', () => {
  // Quiet only on weekdays (Mon–Fri = idx 1..5), 09:00–17:00.
  const days = [false, true, true, true, true, true, false]; // Sun..Sat
  const cfg = { enabled: true, startMin: 9 * 60, endMin: 17 * 60, days };
  assert.equal(isWithinQuietHours(at(12, 0, 1), cfg), true);  // Monday
  assert.equal(isWithinQuietHours(at(12, 0, 0), cfg), false); // Sunday off
  assert.equal(isWithinQuietHours(at(12, 0, 6), cfg), false); // Saturday off
});

test('midnight-wrapping window attributes after-midnight minutes to the start day', () => {
  // Quiet Fri night only: Friday = idx 5 enabled, 22:00–07:00.
  const days = [false, false, false, false, false, true, false];
  const cfg = { enabled: true, startMin: 22 * 60, endMin: 7 * 60, days };
  assert.equal(isWithinQuietHours(at(23, 0, 5), cfg), true);  // Fri 23:00
  assert.equal(isWithinQuietHours(at(2, 0, 6), cfg), true);   // Sat 02:00 belongs to Fri window
  assert.equal(isWithinQuietHours(at(2, 0, 5), cfg), false);  // Fri 02:00 belongs to Thu window (off)
});

// ── Date instance support (service-worker call site) ──────────────────────
test('accepts a Date and reads local time', () => {
  const cfg = { enabled: true, startMin: 22 * 60, endMin: 7 * 60 };
  assert.equal(isWithinQuietHours(new Date(2026, 5, 18, 23, 30), cfg), true);
  assert.equal(isWithinQuietHours(new Date(2026, 5, 18, 12, 0), cfg), false);
});

// ── action + channel helpers ──────────────────────────────────────────────
test('quietAction returns mode when quiet, none otherwise', () => {
  const cfg = { enabled: true, startMin: 0, endMin: 1439, mode: 'pause' };
  assert.equal(quietAction(at(3, 0), cfg), 'pause');
  assert.equal(quietAction(at(3, 0), { ...cfg, enabled: false }), 'none');
  assert.equal(quietAction(at(3, 0), { ...cfg, mode: undefined }), 'suppress'); // default mode
});

test('isChannelMuted defaults to muting all channels in suppress mode', () => {
  const cfg = { enabled: true, startMin: 0, endMin: 1439, mode: 'suppress' };
  assert.equal(isChannelMuted(at(3, 0), cfg, 'sound'), true);
  assert.equal(isChannelMuted(at(3, 0), cfg, 'notify'), true);
});

test('isChannelMuted honors a per-channel allow', () => {
  const cfg = { enabled: true, startMin: 0, endMin: 1439, mode: 'suppress',
    channels: { sound: true, flash: false, notify: false } };
  assert.equal(isChannelMuted(at(3, 0), cfg, 'sound'), true);   // muted
  assert.equal(isChannelMuted(at(3, 0), cfg, 'flash'), false);  // allowed through
  assert.equal(isChannelMuted(at(3, 0), cfg, 'notify'), false);
});

test('pause mode reports no channel muting (cycle is skipped before delivery)', () => {
  const cfg = { enabled: true, startMin: 0, endMin: 1439, mode: 'pause' };
  assert.equal(isChannelMuted(at(3, 0), cfg, 'sound'), false);
});

// ── parsing helpers ───────────────────────────────────────────────────────
test('parseTimeToMinutes parses HH:MM and rejects garbage', () => {
  assert.equal(parseTimeToMinutes('00:00'), 0);
  assert.equal(parseTimeToMinutes('07:30'), 450);
  assert.equal(parseTimeToMinutes('23:59'), 1439);
  assert.equal(parseTimeToMinutes('24:00'), null);
  assert.equal(parseTimeToMinutes('9:99'), null);
  assert.equal(parseTimeToMinutes('nope'), null);
  assert.equal(parseTimeToMinutes(''), null);
});

test('minutesToTime is the inverse for valid values', () => {
  assert.equal(minutesToTime(0), '00:00');
  assert.equal(minutesToTime(450), '07:30');
  assert.equal(minutesToTime(1439), '23:59');
});
