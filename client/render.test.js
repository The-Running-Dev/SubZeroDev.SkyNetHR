import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coalesceKey, createCoalesceGroup, renderEvent } from './render.js';

// Brief item 19 — a burst of identical notices or errors is one transcript row carrying a
// repeat count, with every instance still listed and every instance still in the event log.
// `render.js` takes `doc` as an explicit parameter so it can be exercised without a browser
// (its own comment); this is the minimum of that surface these functions touch.

function fakeElement() {
  return {
    tagName: '',
    className: '',
    textContent: '',
    hidden: false,
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
}

function fakeDocument() {
  return {
    createElement(tag) {
      const node = fakeElement();
      node.tagName = tag;
      return node;
    },
  };
}

function find(node, className) {
  if (node.className === className) return node;
  for (const child of node.children) {
    const hit = find(child, className);
    if (hit !== null) return hit;
  }
  return null;
}

function notice(text, level = 'info', code = 'task_progress') {
  return { seq: 1, sessionId: 's', ts: '2026-09-19T00:00:00.000Z', kind: 'session.notice', data: { level, code, text } };
}

test('coalesceKey — identical notices share a key, and any differing rendered field splits them', () => {
  assert.equal(coalesceKey(notice('scanning')), coalesceKey(notice('scanning')));
  assert.notEqual(coalesceKey(notice('scanning')), coalesceKey(notice('scanned')));
  assert.notEqual(coalesceKey(notice('scanning')), coalesceKey(notice('scanning', 'warn')));
  assert.notEqual(coalesceKey(notice('scanning')), coalesceKey(notice('scanning', 'info', 'task_started')));
});

test('coalesceKey — identical errors share a key; fatal, kind and message each split them', () => {
  const error = (message, kind = 'adapter_unknown_record', fatal = false) => ({
    kind: 'error',
    data: { kind, message, fatal },
  });
  assert.equal(coalesceKey(error('boom')), coalesceKey(error('boom')));
  assert.notEqual(coalesceKey(error('boom')), coalesceKey(error('bang')));
  assert.notEqual(coalesceKey(error('boom')), coalesceKey(error('boom', 'adapter_bad_line')));
  assert.notEqual(coalesceKey(error('boom')), coalesceKey(error('boom', 'adapter_unknown_record', true)));
});

test('coalesceKey — a kind carrying content of its own never coalesces, however identical', () => {
  const message = { kind: 'message', data: { turnId: 't', role: 'assistant', text: 'same', attachments: [] } };
  assert.equal(coalesceKey(message), null);
  assert.equal(coalesceKey({ kind: 'tool.result', data: { turnId: 't', callId: 'c', ok: true, output: 'x', truncated: false, bytes: 1 } }), null);
  assert.equal(coalesceKey({ kind: 'thinking', data: { turnId: 't', text: 'same' } }), null);
  assert.equal(coalesceKey({ kind: 'turn.started', data: { turnId: 't' } }), null);
});

test('a notice that never repeats carries no count badge and no instance list', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, notice('scanning'), null);
  createCoalesceGroup(doc, node, '2026-09-19T00:00:00.000Z');
  assert.equal(find(node, 'event__count'), null);
  assert.equal(find(node, 'event__instances'), null);
});

test('seventeen identical notices fold into one row reading ×17, listing all seventeen instances', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, notice('scanning'), null);
  const group = createCoalesceGroup(doc, node, '2026-09-19T00:00:00.000Z');

  let count = 1;
  for (let i = 1; i < 17; i++) {
    count = group.bump(`2026-09-19T00:00:${String(i).padStart(2, '0')}.000Z`);
  }

  assert.equal(count, 17);
  assert.equal(find(node, 'event__count').textContent, '×17');
  // The first instance's timestamp is listed too: it is only added on the first bump, so a
  // list that grew from the second occurrence onward would silently be one short.
  const list = find(node, 'event__instances-list');
  assert.equal(list.children.length, 17);
  assert.equal(list.children[0].textContent, '2026-09-19T00:00:00.000Z');
  assert.equal(list.children[16].textContent, '2026-09-19T00:00:16.000Z');
  // The original row's own text is untouched — the collapse hides repetition, not content.
  assert.equal(find(node, 'notice__text').textContent, 'scanning');
});
