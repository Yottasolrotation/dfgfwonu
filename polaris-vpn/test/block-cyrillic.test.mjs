import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../extension/content/block-cyrillic.js', import.meta.url), 'utf8');

class HTMLInputElement {}
class HTMLTextAreaElement {
  constructor(value, caret) {
    this.value = value;
    this.selectionStart = caret;
  }
  setSelectionRange(start) {
    this.selectionStart = start;
  }
}

function load() {
  const handlers = {};
  const toast = { style: {}, setAttribute() {}, remove() {} };
  vm.runInNewContext(SOURCE, {
    addEventListener: (type, handler, capture) => {
      assert.equal(capture, true);
      handlers[type] = handler;
    },
    document: { createElement: () => toast, documentElement: { append() {} } },
    setTimeout: () => 0,
    clearTimeout() {},
    HTMLInputElement,
    HTMLTextAreaElement,
  });
  return handlers;
}

function fire(handler, props) {
  const event = {
    cancelable: true,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    ...props,
  };
  handler(event);
  return event;
}

const transfer = (text) => ({ getData: (type) => (type === 'text/plain' ? text : '') });

test('rejects typed Cyrillic and lets other text through', () => {
  const { beforeinput } = load();
  for (const data of ['п', 'Ё', 'hello мир', 'ї']) {
    const event = fire(beforeinput, { data });
    assert.deepEqual([event.prevented, event.stopped], [true, true], data);
  }
  for (const data of ['p', 'héllo', '日本語', '🙂', null]) {
    assert.equal(fire(beforeinput, { data }).prevented, false, String(data));
  }
  assert.equal(fire(beforeinput, { data: null, dataTransfer: transfer('привет') }).prevented, true);
});

test('rejects pasted and dropped Cyrillic', () => {
  const { paste, drop } = load();
  assert.equal(fire(paste, { clipboardData: transfer('Привет') }).prevented, true);
  assert.equal(fire(paste, { clipboardData: transfer('Hello') }).prevented, false);
  assert.equal(fire(drop, { dataTransfer: transfer('текст') }).prevented, true);
  assert.equal(fire(drop, { dataTransfer: transfer('') }).prevented, false);
});

test('cleans text that arrives through an uncancellable input', () => {
  const { beforeinput, input } = load();
  assert.equal(fire(beforeinput, { data: 'п', cancelable: false }).prevented, false);
  const field = new HTMLTextAreaElement('abпрcd', 4);
  fire(input, { target: field });
  assert.deepEqual([field.value, field.selectionStart], ['abcd', 2]);
  const editor = { value: 'привет' };
  fire(input, { target: editor });
  assert.equal(editor.value, 'привет');
});
