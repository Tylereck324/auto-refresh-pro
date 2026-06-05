// Regression test for the Settings-page stored DOM-XSS.
//
// Before the fix, options.js concatenated preset.label into innerHTML, so an
// imported preset label like  "><img src=x onerror=alert(1)>  executed script on
// the Settings page. buildPresetRow must instead place the label as inert string
// data (input.value) and never route it through innerHTML.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPresetRow } = require('../preset-row.js');

// Minimal DOM stub. innerHTML is a trap: any write to it fails the test, proving
// the builder never uses an HTML-parsing sink for attacker-controlled data.
function makeFakeDocument() {
  function makeNode(tag) {
    const node = {
      tagName: tag, className: '', _children: [],
      style: {}, textContent: '', value: '', type: '', id: '',
      placeholder: '', min: '',
      appendChild(c) { this._children.push(c); return c; },
    };
    Object.defineProperty(node, 'innerHTML', {
      set() { throw new Error('innerHTML must not be used to render preset rows'); },
      get() { return ''; },
    });
    return node;
  }
  return { createElement: (tag) => makeNode(tag) };
}

test('hostile preset label is stored as inert value, not parsed as HTML', () => {
  const doc = makeFakeDocument();
  const payload = '"><img src=x onerror=alert(1)>';
  let row;
  assert.doesNotThrow(() => { row = buildPresetRow(doc, { label: payload, ms: 5000 }, 0); });
  const labelInput = row._children.find(c => c.id === 'pLabel0');
  assert.ok(labelInput, 'label input exists');
  // The raw payload lives only as a DOM property value — never as markup.
  assert.equal(labelInput.value, payload);
  assert.equal(labelInput.type, 'text');
});

test('seconds field is derived numerically from ms', () => {
  const doc = makeFakeDocument();
  const row = buildPresetRow(doc, { label: 'ok', ms: 30000 }, 2);
  const secInput = row._children.find(c => c.id === 'pSec2');
  assert.equal(secInput.value, '30');
});

test('missing/garbage label does not throw and defaults sec', () => {
  const doc = makeFakeDocument();
  const row = buildPresetRow(doc, {}, 1);
  const labelInput = row._children.find(c => c.id === 'pLabel1');
  const secInput = row._children.find(c => c.id === 'pSec1');
  assert.equal(labelInput.value, '');
  assert.equal(secInput.value, '30');
});
