'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

test('offscreen audio listener ignores non-target messages and acknowledges targeted beeps', () => {
  let listener;
  const played = [];
  const responses = [];
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
      },
    },
    AlertSounds: { playTone(...args) { played.push(args); } },
  });
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'offscreen.js'), 'utf8'), context, { filename: 'offscreen.js' });

  listener({ type: 'PLAY_BEEP' }, {}, (response) => responses.push(response));
  assert.deepEqual(played, []);
  assert.deepEqual(responses, []);

  listener({ target: 'offscreen', type: 'PLAY_BEEP', tone: 'chime', volume: 0.5, repeat: 2 }, {}, (response) => responses.push(response));
  assert.equal(played.length, 1);
  assert.equal(played[0][0], 'chime');
  assert.equal(played[0][1].volume, 0.5);
  assert.equal(played[0][1].repeat, 2);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
});

test('sound playback retains and mounts the media element while it plays', () => {
  const appended = [];
  class FakeAudio {
    constructor(uri) {
      this.src = uri;
      this.parentNode = null;
      this.listeners = {};
      this.playCalls = 0;
    }
    setAttribute() {}
    addEventListener(type, fn) { this.listeners[type] = fn; }
    play() { this.playCalls++; return Promise.resolve(); }
  }
  const body = {
    appendChild(node) { node.parentNode = body; appended.push(node); },
    removeChild(node) { node.parentNode = null; },
  };
  const context = vm.createContext({
    Audio: FakeAudio,
    document: { body },
    btoa: globalThis.btoa,
    console,
    setTimeout: () => ({ unref() {} }),
    ArrayBuffer,
    DataView,
    Uint8Array,
    Math,
    Number,
    String,
    Object,
    Promise,
  });
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'sounds.js'), 'utf8'), context, { filename: 'sounds.js' });
  context.AlertSounds.playTone('beep', { volume: 0.8, repeat: 1 });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].playCalls, 1);
  assert.equal(appended[0].volume, 0.8);
  assert.equal(appended[0].preload, 'auto');
});
