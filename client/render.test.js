import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyAssistantMessageVerbosity,
  classifyAssistantText,
  coalesceKey,
  createCoalesceGroup,
  DEFAULT_MODEL_LABEL,
  foldToolCallRepeats,
  formatHeaderBurn,
  renderEvent,
  renderPayrollSummary,
  renderRepeatFold,
  REPEAT_FOLD_TIME_BOUND_MS,
  sessionIdentityFields,
} from './render.js';

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

function findAll(node, className, out = []) {
  if (node.className === className) out.push(node);
  for (const child of node.children) findAll(child, className, out);
  return out;
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

// S37 — narration is classified and hidden only as a display decision. The fixture labels
// both sides of the boundary explicitly so widening a regex cannot silently convert an answer
// into status text.
const NARRATION_FIXTURE = [
  { label: 'ephemeral', text: 'Working on it.' },
  { label: 'ephemeral', text: 'I am checking the renderer now.' },
  { label: 'ephemeral', text: "I'm going to inspect the event order." },
  { label: 'ephemeral', text: 'Let me verify that quickly.' },
  { label: 'ephemeral', text: "I'll run the focused tests next." },
  { label: 'ephemeral', text: 'about to inspect <img src=x onerror=alert(1)>' },
  { label: 'substantive', text: 'The renderer keeps every stored envelope.' },
  { label: 'substantive', text: 'I will be available tomorrow.' },
  { label: 'substantive', text: 'Working agreements belong in the contract.' },
];

test('S37.1 — one data-driven classifier labels the narration fixture directly', () => {
  assert.deepEqual(
    NARRATION_FIXTURE.map(({ text }) => classifyAssistantText(text) === null ? 'substantive' : 'ephemeral'),
    NARRATION_FIXTURE.map(({ label }) => label),
  );
});

test('S37.2 — an ephemeral assistant block is hidden only at compact', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, {
    kind: 'message',
    data: { turnId: 'turn-1', role: 'assistant', text: 'Working on it.', attachments: [] },
  });

  assert.equal(applyAssistantMessageVerbosity(node, 'compact'), true);
  assert.equal(node.hidden, true);
  assert.equal(applyAssistantMessageVerbosity(node, 'normal'), false);
  assert.equal(node.hidden, false);
  assert.equal(applyAssistantMessageVerbosity(node, 'full'), false);
  assert.equal(node.hidden, false);
});

test('S37.4 — classifying a recorded session leaves its spill and full replay byte-for-byte unchanged', () => {
  const recorded = [
    { seq: 1, sessionId: 's', ts: '2026-09-20T00:00:00.000Z', kind: 'turn.started', data: { turnId: 'turn-1' } },
    { seq: 2, sessionId: 's', ts: '2026-09-20T00:00:01.000Z', kind: 'message', data: { turnId: 'turn-1', role: 'assistant', text: 'Working on it.', attachments: [] } },
    { seq: 3, sessionId: 's', ts: '2026-09-20T00:00:02.000Z', kind: 'message', data: { turnId: 'turn-1', role: 'assistant', text: 'Done.', attachments: [] } },
    { seq: 4, sessionId: 's', ts: '2026-09-20T00:00:03.000Z', kind: 'turn.ended', data: { turnId: 'turn-1', stopReason: 'completed', usage: null } },
  ];
  const spill = recorded.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n';
  const replay = () => spill.trimEnd().split('\n').map((line) => JSON.parse(line));
  const withoutClassifier = replay();
  const withClassifier = replay();

  for (const envelope of withClassifier) {
    if (envelope.kind === 'message' && envelope.data.role === 'assistant') classifyAssistantText(envelope.data.text);
  }

  assert.equal(recorded.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n', spill);
  assert.deepEqual(withClassifier, withoutClassifier);
});

test('S37.6 — the verbosity control says hiding changes display, not model context', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /changes only what is displayed/i);
  assert.match(html, /does not change what the agent was given/i);
});

test('S37.7 — an ephemeral block carrying angle brackets remains literal text', () => {
  const doc = fakeDocument();
  const value = 'about to inspect <img src=x onerror=alert(1)>';
  const node = renderEvent(doc, {
    kind: 'message',
    data: { turnId: 'turn-hostile', role: 'assistant', text: value, attachments: [] },
  });

  assert.notEqual(classifyAssistantText(value), null);
  assert.equal(find(node, 'message__text').textContent, value);
  assert.equal(find(node, 'message__text').children.length, 0);
});

// Brief item 21 — a session's burn broken down per turn, so a turn that cost thirty times
// what its neighbour did is visible without reading the transcript that produced it (D248).

function turnBurn(turnId, total, endedAt = '2026-09-19T00:00:10.000Z') {
  return {
    turnId,
    usage: { inputTokens: total, outputTokens: 0, cacheRead: 0, cacheCreate: 0 },
    startedAt: '2026-09-19T00:00:00.000Z',
    endedAt,
  };
}

function payrollView(turns) {
  return {
    sessionId: 's',
    burn: { inputTokens: 39674, outputTokens: 0, cacheRead: 0, cacheCreate: 0 },
    budgetTokens: null,
    remainingTokens: null,
    idleMs: 0,
    droppedIntervals: 0,
    costCurrency: null,
    currency: null,
    turns,
  };
}

function rowsOf(dl) {
  return dl.children.map((row) => [row.children[0].textContent, row.children[1].textContent]);
}

test('D248 — the payroll summary lists one row per turn, in the order the server sent them', () => {
  const doc = fakeDocument();
  const dl = renderPayrollSummary(doc, payrollView([turnBurn('t1', 8230), turnBurn('t2', 31444)]));
  const rows = rowsOf(dl);
  assert.deepEqual(rows.slice(-2), [
    ['Turn 1', '+8,230 tokens'],
    ['Turn 2', '+31,444 tokens'],
  ]);
});

test('D248 — a turn that reported nothing still gets a row, and one still running says so', () => {
  const doc = fakeDocument();
  const dl = renderPayrollSummary(doc, payrollView([turnBurn('t1', 0), turnBurn('t2', 120, null)]));
  const rows = rowsOf(dl);
  assert.deepEqual(rows.slice(-2), [
    ['Turn 1', '+0 tokens'],
    ['Turn 2', '+120 tokens — still running'],
  ]);
});

test('D248 — a session with no turns renders exactly the summary it rendered before turns existed', () => {
  const doc = fakeDocument();
  const withNone = rowsOf(renderPayrollSummary(doc, payrollView([])));
  assert.equal(withNone.some(([label]) => label.startsWith('Turn ')), false);
  assert.deepEqual(withNone.map(([label]) => label), ['Burn', 'Budget remaining', 'Idle time']);
});

// S34 — read the change the agent made, as a diff.

function toolResultEnvelope(diff, overrides = {}) {
  return {
    kind: 'tool.result',
    data: { turnId: 't', callId: 'c', ok: true, output: 'plain output', truncated: false, bytes: 12, diff, ...overrides },
  };
}

function twoHunkDiff() {
  return {
    hunks: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' context one', '-removed one', '+added one'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: ['+added two', ' context two'] },
    ],
  };
}

function tagNames(node, out = []) {
  out.push(node.tagName);
  for (const child of node.children) tagNames(child, out);
  return out;
}

test('S34.2 — a two-hunk diff renders one row per hunk header and one row per line, marked apart', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, toolResultEnvelope(twoHunkDiff()), { verbosity: 'full' });
  const headers = findAll(node, 'tool__diff-hunk-header');
  assert.deepEqual(headers.map((h) => h.textContent), ['@@ -1,2 +1,2 @@', '@@ -10,1 +10,2 @@']);
  const marked = [
    ...findAll(node, 'tool__diff-line tool__diff-line--context'),
    ...findAll(node, 'tool__diff-line tool__diff-line--removed'),
    ...findAll(node, 'tool__diff-line tool__diff-line--added'),
  ];
  assert.equal(marked.length, 5);
  assert.deepEqual(
    findAll(node, 'tool__diff-line tool__diff-line--added').map((l) => l.textContent),
    ['+added one', '+added two'],
  );
  assert.deepEqual(findAll(node, 'tool__diff-line tool__diff-line--removed').map((l) => l.textContent), ['-removed one']);
  assert.deepEqual(findAll(node, 'tool__diff-line tool__diff-line--context').map((l) => l.textContent), [' context one', ' context two']);
});

test('S34.3 — a hostile added line and a quote-carrying context line reach the page as text, never markup', () => {
  const doc = fakeDocument();
  const hostile = {
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [' path "quoted/here".txt', '+<script>alert(1)</script>'],
      },
    ],
  };
  const node = renderEvent(doc, toolResultEnvelope(hostile), { verbosity: 'full' });
  const rendered = findAll(node, 'tool__diff-line tool__diff-line--added');
  assert.equal(rendered[0].textContent, '+<script>alert(1)</script>');
  assert.equal(rendered[0].children.length, 0);
  const context = findAll(node, 'tool__diff-line tool__diff-line--context');
  assert.equal(context[0].textContent, ' path "quoted/here".txt');
});

test('#415 — orphan hook completion is visible and inert at every verbosity', () => {
  for (const verbosity of ['compact', 'normal', 'full']) {
    const node = renderEvent(fakeDocument(), { kind: 'hook', data: {
      turnId: 't', hookId: 'h', phase: 'completed', hookEvent: '<event>', hookName: '<script>alert(1)</script>',
      outcome: 'vendor-defined result', exitCode: 0,
    } }, { verbosity });
    const line = find(node, 'hook');
    assert.ok(line);
    assert.match(line.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(line.textContent, /vendor-defined result/);
    assert.match(line.textContent, /exit 0/);
    assert.equal(line.children.length, 0);
    assert.equal(find(node, 'fold'), null);
  }
});

test('S34.4 — a truncated result with a diff renders the diff it has and states it is partial', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, toolResultEnvelope(twoHunkDiff(), { truncated: true, bytes: 9001 }), { verbosity: 'full' });
  assert.notEqual(find(node, 'tool__diff'), null);
  assert.equal(find(node, 'tool__truncated').textContent, 'diff partial — 9001 bytes in full');
});

test('#458 — file labels group hunks and reach the diff view as inert text', () => {
  const hunks = twoHunkDiff().hunks;
  const hostile = '<img src=x onerror=alert(1)>';
  const node = renderEvent(fakeDocument(), toolResultEnvelope({ hunks: [
    { ...hunks[0], path: hostile }, { ...hunks[1], path: hostile }, { ...hunks[0], path: 'next.txt' },
  ] }), { verbosity: 'full' });
  const labels = findAll(node, 'tool__diff-path');
  assert.deepEqual(labels.map(label => label.textContent), [hostile, 'next.txt']);
  assert.ok(labels.every(label => label.children.length === 0));
});

test('S34.5 — a result with no recoverable change (Read/Bash) renders exactly as it did before diffs existed', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, toolResultEnvelope(null, { output: 'file contents' }), { verbosity: 'full' });
  assert.equal(find(node, 'tool__diff'), null);
  assert.equal(find(node, 'tool__output').textContent, 'file contents');
});

test('S34.6 — the diff is inert: no button, form or contenteditable element appears within a hunk', () => {
  const doc = fakeDocument();
  const node = renderEvent(doc, toolResultEnvelope(twoHunkDiff()), { verbosity: 'full' });
  const diffNode = find(node, 'tool__diff');
  const tags = tagNames(diffNode);
  assert.equal(tags.some((tag) => tag === 'button' || tag === 'form'), false);
  assert.equal(diffNode.contentEditable, undefined);
});

test('S34.7 — the diff fold obeys the three verbosity levels: closed at compact, open at normal and full', () => {
  const doc = fakeDocument();
  const closed = renderEvent(doc, toolResultEnvelope(twoHunkDiff()), { verbosity: 'compact' });
  assert.equal(find(closed, 'fold').open, false);
  const normal = renderEvent(doc, toolResultEnvelope(twoHunkDiff()), { verbosity: 'normal' });
  assert.equal(find(normal, 'fold').open, true);
  const full = renderEvent(doc, toolResultEnvelope(twoHunkDiff()), { verbosity: 'full' });
  assert.equal(find(full, 'fold').open, true);
});

function linesOfLength(n) {
  return Array.from({ length: n }, (_, i) => `+line ${i}`);
}

test('S34.8 — a diff past the renderer line bound shows the first N lines and states the remainder as a count', () => {
  const doc = fakeDocument();
  const N = 200;
  const diffOf = (count) => ({ hunks: [{ oldStart: 1, oldLines: count, newStart: 1, newLines: count, lines: linesOfLength(count) }] });

  const under = renderEvent(doc, toolResultEnvelope(diffOf(N - 1)), { verbosity: 'full' });
  assert.equal(findAll(under, 'tool__diff-line tool__diff-line--added').length, N - 1);
  assert.equal(find(under, 'tool__diff-more'), null);

  const exact = renderEvent(doc, toolResultEnvelope(diffOf(N)), { verbosity: 'full' });
  assert.equal(findAll(exact, 'tool__diff-line tool__diff-line--added').length, N);
  assert.equal(find(exact, 'tool__diff-more'), null);

  const over = renderEvent(doc, toolResultEnvelope(diffOf(N + 1)), { verbosity: 'full' });
  assert.equal(findAll(over, 'tool__diff-line tool__diff-line--added').length, N);
  assert.equal(find(over, 'tool__diff-more').textContent, '+1 more lines');
});

// S35 — the header and every sidebar row over the same `SessionSummary` fields.

function session(overrides = {}) {
  return {
    id: 'sess-1',
    owner: 'op',
    vendor: 'acme-cli',
    cwd: '/work/project',
    model: null,
    policy: null,
    sandbox: null,
    lastSeq: 0,
    state: 'live',
    createdAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    name: null,
    ...overrides,
  };
}

test('S35.2 — sessionIdentityFields falls back from name to cwd (D249) and states an explicit default model', () => {
  const noName = sessionIdentityFields(session());
  assert.equal(noName.name, '/work/project');
  assert.equal(noName.model, DEFAULT_MODEL_LABEL);

  const named = sessionIdentityFields(session({ name: 'triage bot', model: 'opus' }));
  assert.equal(named.name, 'triage bot');
  assert.equal(named.model, 'opus');
});

test('#461 — an ended session without a recorded reason remains simply ended', () => {
  const fields = sessionIdentityFields(session({ state: 'ended' }));
  assert.equal(fields.state, 'ended');
  assert.equal('endReason' in fields, false);
});

test('#461 — session identity shows a recorded end reason only for ended sessions', () => {
  for (const reason of ['operator', 'server_restart', 'storage_failure']) {
    assert.equal(sessionIdentityFields(session({ state: 'ended', endReason: reason })).state, `ended — ${reason.replaceAll('_', ' ')}`);
    assert.equal(sessionIdentityFields(session({ state: 'live', endReason: reason })).state, 'live');
  }
  assert.equal(sessionIdentityFields(session({ state: 'ended', endReason: null })).state, 'ended');
});

test('S35.8 — a name and a folder carrying markup-looking characters come back as the literal fields, not markup', () => {
  const fields = sessionIdentityFields(session({ name: '<b>ops</b> & "prod"', cwd: '/work/<script>' }));
  assert.equal(fields.name, '<b>ops</b> & "prod"');
});

test('S35.3 — formatHeaderBurn sums the four burn fields and states "unpriced" rather than a zero cost', () => {
  const unpriced = formatHeaderBurn(payrollView([]));
  assert.match(unpriced, /unpriced/);
  assert.equal(/\$?0\.00/.test(unpriced), false);

  const priced = formatHeaderBurn({ ...payrollView([]), costCurrency: 12.5, currency: 'USD' });
  assert.match(priced, /USD 12\.50/);
});

test('S35.3 — formatHeaderBurn never recomputes the total from turns, only from burn (I28)', () => {
  const view = payrollView([turnBurn('t1', 999999)]);
  const label = formatHeaderBurn(view);
  assert.match(label, /39,674 tokens/);
});

// S36 — a pure fold over the `tool.call` envelopes the client already holds, never a second
// call path and never adjacency-only like `coalesceKey` above.

test('S36.1 — an exact repeat needs both the same tool and the same input; a differing argument does not count', () => {
  const calls = [
    { name: 'Bash', input: { command: 'git status' } },
    { name: 'Bash', input: { command: 'git status' } },
    { name: 'Bash', input: { command: 'git log' } },
  ];
  const fold = foldToolCallRepeats(calls);
  assert.equal(fold.repeats.length, 1);
  assert.equal(fold.repeats[0].name, 'Bash');
  assert.equal(fold.repeats[0].count, 2);
});

test('S36.2 — a repeat is counted across the whole session, not only when adjacent', () => {
  const calls = [
    { name: 'Bash', input: { command: 'git status' } },
    { name: 'Read', input: { path: 'a.js' } },
    { name: 'Bash', input: { command: 'git status' } },
  ];
  const fold = foldToolCallRepeats(calls);
  assert.equal(fold.repeats.length, 1);
  assert.equal(fold.repeats[0].count, 2);
});

test('S36.3 — a repeated sequence is reported at three occurrences, and not at two', () => {
  const pair = () => [{ name: 'A', input: {} }, { name: 'B', input: {} }];
  const twoOccurrences = [...pair(), ...pair()];
  const threeOccurrences = [...pair(), ...pair(), ...pair()];

  assert.equal(foldToolCallRepeats(twoOccurrences).sequences.length, 0);

  const fold = foldToolCallRepeats(threeOccurrences);
  assert.equal(fold.sequences.length, 1);
  assert.equal(fold.sequences[0].count, 3);
  assert.deepEqual(fold.sequences[0].calls.map((c) => c.name), ['A', 'B']);
});

test('S36.5 — the panel states it is diagnostic and that nothing above was prevented', () => {
  const doc = fakeDocument();
  const node = renderRepeatFold(doc, foldToolCallRepeats([]));
  const text = find(node, 'circles__disclaimer').textContent;
  assert.match(text, /diagnostic/i);
  assert.match(text, /prevent|delay|alter/i);
});

test('S36.6 — a 20,000-call fold completes within the declared bound', () => {
  const calls = Array.from({ length: 20000 }, (_, i) => ({ name: 'Bash', input: { command: `cmd ${i % 50}` } }));
  // The fastest of three runs: a contended runner preempting the process only ever adds time,
  // so one sample can exceed the bound without the fold being slow (#382). The bound itself is
  // unchanged, and a fold that is genuinely too slow fails every run.
  let elapsed = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const start = Date.now();
    foldToolCallRepeats(calls);
    elapsed = Math.min(elapsed, Date.now() - start);
  }
  assert.ok(elapsed < REPEAT_FOLD_TIME_BOUND_MS, `fold took ${elapsed}ms, bound is ${REPEAT_FOLD_TIME_BOUND_MS}ms`);
});

test('S36.7 — a tool name and argument carrying markup reach the panel only as a text node', () => {
  const doc = fakeDocument();
  const hostile = { name: 'Bash', input: { command: '<script>"quoted"</script>' } };
  const fold = foldToolCallRepeats([hostile, hostile]);
  const node = renderRepeatFold(doc, fold);
  const pre = find(node, 'circles__repeat-input');
  assert.equal(pre.children.length, 0);
  assert.match(pre.textContent, /<script>/);
});

// D275/D276 — the deny control collects a reason, says it goes to the agent, and sends null (never '') when empty.
function permissionDoc() {
  const doc = {
    createElement(tag) {
      const node = fakeElement();
      node.tagName = tag;
      node.attrs = {};
      node.listeners = {};
      node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
      return node;
    },
  };
  return doc;
}

async function denyWith(typed, decision = 'deny') {
  const calls = [];
  const doc = permissionDoc();
  const envelope = { seq: 1, sessionId: 's', kind: 'permission.request', data: { turnId: 't', requestId: 'req-1', callId: 'c', tool: 'Bash', input: { command: 'ls' } } };
  const node = renderEvent(doc, envelope, { onAnswerPermission: async (...args) => { calls.push(args); return true; } });
  const input = find(node, 'permission__reason');
  input.value = typed;
  const btn = findAll(node, 'button button--deny')[0] ?? find(node, 'button button--deny');
  const target = decision === 'deny' ? btn : find(node, 'button button--allow');
  await target.listeners.click();
  return { calls, input };
}

test('D275 — the deny control\'s reason field states that the text goes to the agent', () => {
  const doc = permissionDoc();
  const envelope = { seq: 1, sessionId: 's', kind: 'permission.request', data: { turnId: 't', requestId: 'req-1', callId: 'c', tool: 'Bash', input: {} } };
  const input = find(renderEvent(doc, envelope, { onAnswerPermission: async () => true }), 'permission__reason');
  assert.ok(input, 'a reason field exists');
  assert.match(input.placeholder, /sent to the agent/);
  assert.match(input.title, /sent to the agent/);
});

test('D275/D276 — a typed reason is sent with the deny; an empty or blank field sends null, never the empty string', async () => {
  assert.deepEqual((await denyWith('use staging')).calls, [['req-1', 'deny', 'use staging']]);
  assert.deepEqual((await denyWith('')).calls, [['req-1', 'deny', null]]);
  assert.deepEqual((await denyWith('   ')).calls, [['req-1', 'deny', null]]);
  assert.deepEqual((await denyWith('ignored on allow', 'allow')).calls, [['req-1', 'allow', null]], 'an allow never carries a reason');
});

// S39.10: the budget notices render as warnings, as two different console-owned sentences
// chosen by `code`; the server's `text` is shown but never read.
test('S39.10 — budget_warning and budget_exhausted render as warnings with distinct sentences keyed on code, not text', () => {
  const doc = fakeDocument();
  const warning = renderEvent(doc, notice('This session has used 850 of its 1000-token budget.', 'warn', 'budget_warning'), null);
  const exhausted = renderEvent(doc, notice('This session has used 1000 tokens, its whole 1000-token budget.', 'warn', 'budget_exhausted'), null);
  for (const node of [warning, exhausted]) {
    assert.match(node.className, /event--notice-warn/);
    assert.doesNotMatch(node.className, /error/);
  }
  const headlineOf = (node) => find(node, 'notice__headline').textContent;
  assert.equal(headlineOf(warning), 'This session is nearing its token budget. Nothing has been stopped.');
  assert.equal(headlineOf(exhausted), 'This session has used its whole token budget. It keeps running and accepting messages.');
  assert.notEqual(headlineOf(warning), headlineOf(exhausted));
  assert.equal(find(warning, 'notice__text').textContent, 'This session has used 850 of its 1000-token budget.');

  // Swapping the texts leaves each sentence with its code: the branch reads `code` only.
  const swapped = renderEvent(doc, notice('This session has used 1000 tokens, its whole 1000-token budget.', 'warn', 'budget_warning'), null);
  assert.equal(headlineOf(swapped), headlineOf(warning));
  // An unrelated notice whose text mentions the budget gets no budget sentence.
  const unrelated = renderEvent(doc, notice('budget_exhausted', 'info', 'task_progress'), null);
  assert.equal(find(unrelated, 'notice__headline'), null);
  assert.match(unrelated.className, /event--notice-info/);
});
