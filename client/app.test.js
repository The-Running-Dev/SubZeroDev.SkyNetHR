import assert from 'node:assert/strict';
import { test } from 'node:test';

// #204 — a delayed event from a superseded stream (a session switch, or a same-session
// reconnect after a gap) must be rejected before it renders or mutates any state, for both
// transports. `app.js` runs as a plain browser module with no exports (it self-executes
// `start()` at import time) and `render.js` takes `doc` as an explicit parameter specifically
// so it "can be exercised without a browser" (its own comment) — this file builds the
// minimal fake `document`/`EventSource`/`WebSocket`/`fetch` that lets `app.js` run headless
// under `node --test`, drives it exactly the way a browser would (constructing elements,
// firing DOM events), and never reaches into `app.js`'s internal state directly.

function fakeElement() {
  const listeners = new Map();
  return {
    tagName: '',
    className: '',
    textContent: '',
    hidden: false,
    value: '',
    checked: false,
    files: [],
    disabled: false,
    children: [],
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    insertBefore(node, reference) {
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = this.children.indexOf(reference);
      this.children.splice(index === -1 ? this.children.length : index, 0, node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      this.children = this.children.filter((c) => c !== node);
      node.parentNode = null;
      return node;
    },
    get firstChild() {
      return this.children.length > 0 ? this.children[0] : null;
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    getAttribute(name) {
      return this[`__attr_${name}`] ?? null;
    },
    setAttribute(name, value) {
      this[`__attr_${name}`] = value;
    },
    reset() {
      this.value = '';
    },
  };
}

// One shared registry, keyed by id, so every `$('same-id')` call across `app.js`'s many
// functions observes the same node — required for e.g. `refreshSessions` building `#sessions`
// in one function and this test reading it back in another.
function makeFakeDocument() {
  const byId = new Map();
  let metaEdge = 'sse';
  const documentElement = fakeElement();
  return {
    documentElement,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fakeElement());
      return byId.get(id);
    },
    createElement(tag) {
      const node = fakeElement();
      node.tagName = tag;
      return node;
    },
    querySelector(selector) {
      if (selector === 'meta[name="skynet-edge"]') return { content: metaEdge };
      return null;
    },
    // Test-only control, not part of the `Document` surface `app.js` uses.
    __setEdge(edge) {
      metaEdge = edge;
    },
  };
}

class FakeEventSource {
  constructor(url, registry) {
    this.url = url;
    this.closed = false;
    this._listeners = new Map();
    registry.push(this);
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  // Test-only: simulates a named SSE event arriving, whether or not `close()` was already
  // called — the browser gives no guarantee that an event already in flight is discarded
  // just because the JS side called `close()` (S27.3/#204's own premise).
  emit(kind, envelope) {
    for (const fn of this._listeners.get(kind) ?? []) fn({ data: JSON.stringify(envelope) });
  }
}

class FakeWebSocket {
  constructor(url, registry) {
    this.url = url;
    this.closed = false;
    this.sent = [];
    registry.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    if (this.onclose) this.onclose({ code: 1000 });
  }
  // Test-only: simulates a text frame arriving on this exact socket object, whether or not
  // `close()` was already called.
  emit(envelope) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(envelope) });
  }
}

function fakeFetch(routes) {
  return async (path) => {
    for (const [matcher, respond] of routes) {
      const matches = typeof matcher === 'string' ? path === matcher : matcher.test(path);
      if (matches) {
        const { status, payload } = respond();
        return { status, json: async () => payload };
      }
    }
    return { status: 404, json: async () => ({ error: { code: 'not_found', message: 'unrouted in test' } }) };
  };
}

async function flush(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function defaultPayrollView() {
  return {
    burn: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 },
    remainingTokens: null,
    idleMs: 0,
    droppedIntervals: 0,
    costCurrency: null,
    currency: null,
    turns: [],
  };
}

async function setUpApp({ sessions, extraRoutes = [], payrollCounter = null } = {}) {
  const doc = makeFakeDocument();
  const sseInstances = [];
  const wsInstances = [];
  const fetchCalls = [];
  globalThis.document = doc;
  globalThis.window = { location: { protocol: 'http:', host: 'skynet-hr.test' } };
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) {
      return this.store.has(k) ? this.store.get(k) : null;
    },
    setItem(k, v) {
      this.store.set(k, v);
    },
  };
  globalThis.EventSource = class extends FakeEventSource {
    constructor(url) {
      super(url, sseInstances);
    }
  };
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url) {
      super(url, wsInstances);
    }
  };
  // I20/S1.10: the vendor string is arbitrary and unchecked by anything this test exercises
  // — deliberately not a real vendor name, matching the client's own no-vendor-literal rule
  // (`src/client/index.test.ts`'s "carries no vendor string anywhere in the client sources").
  const fixtureSessions = sessions ?? [
    { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'live' },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live' },
  ];
  const routeFetch = fakeFetch([
    ['/api/sessions', () => ({ status: 200, payload: { sessions: fixtureSessions } })],
    [/^\/api\/sessions\/[^/]+\/payroll$/, () => {
      if (payrollCounter) payrollCounter.count += 1;
      return { status: 200, payload: defaultPayrollView() };
    }],
    ...extraRoutes,
  ]);
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args[0]);
    return routeFetch(...args);
  };

  // `app.js` self-executes `start()` on import (no exports) — dynamic import with a
  // cache-busting query string so a second `setUpApp()` in a later test gets a fresh module
  // instance (and fresh `state`) against the fresh globals just installed above, rather than
  // Node's ESM cache handing back the first test's already-initialised module.
  await import(`./app.js?t=${Date.now()}-${Math.random()}`);
  await flush();

  const sessionsList = doc.getElementById('sessions');
  assert.equal(sessionsList.children.length, fixtureSessions.length, 'setup: all fixture sessions rendered');
  const selectA = () => sessionsList.children[0].children[0].dispatch('click', {});
  const selectB = () => sessionsList.children[1].children[0].dispatch('click', {});

  return { doc, fetchCalls, sseInstances, wsInstances, selectA, selectB };
}

test('#204 SSE — a delayed event from a session switched away from does not render or move lastSeq, and the new session still renders normally', async () => {
  const { doc, sseInstances, selectA, selectB } = await setUpApp();
  doc.__setEdge('sse');

  selectA();
  await flush();
  assert.equal(sseInstances.length, 1, 'selecting a session opens one SSE stream');
  const streamA = sseInstances[0];

  const transcript = doc.getElementById('transcript');
  streamA.emit('session.notice', { seq: 5, sessionId: 'sess-a', kind: 'session.notice', data: { level: 'info', code: 'a-live', text: 'still on A' } });
  assert.equal(transcript.children.length, 1, "a live event on A's own stream renders while A is selected");

  selectB();
  await flush();
  assert.equal(sseInstances.length, 2, 'switching sessions opens a second, independent SSE stream');
  assert.equal(transcript.children.length, 0, 'switching sessions clears the transcript');

  // The stale delivery: session A's own (closed) stream still fires — the race #204 exists
  // to cover — carrying a `sessionId`/`seq` that, if rendered, would land in B's transcript.
  streamA.emit('session.notice', { seq: 999, sessionId: 'sess-a', kind: 'session.notice', data: { level: 'info', code: 'a-stale', text: 'late from A' } });
  await flush();
  assert.equal(transcript.children.length, 0, "a delayed event from A's superseded stream must not render into B's transcript");

  // The new session's own stream still renders normally — the fix must not have silenced it.
  const streamB = sseInstances[1];
  streamB.emit('session.notice', { seq: 1, sessionId: 'sess-b', kind: 'session.notice', data: { level: 'info', code: 'b-live', text: 'live on B' } });
  await flush();
  assert.equal(transcript.children.length, 1, "B's own live event still renders after the stale A event was rejected");
});

test('#204 WebSocket — a delayed frame from a session switched away from does not render, and the new session still renders normally', async () => {
  const { doc, wsInstances, selectA, selectB } = await setUpApp();
  doc.__setEdge('ws');

  selectA();
  await flush();
  assert.equal(wsInstances.length, 1, 'selecting a session opens one WebSocket');
  const socketA = wsInstances[0];

  const transcript = doc.getElementById('transcript');
  socketA.emit({ seq: 5, sessionId: 'sess-a', kind: 'session.notice', data: { level: 'info', code: 'a-live', text: 'still on A' } });
  assert.equal(transcript.children.length, 1, "a live frame on A's own socket renders while A is selected");

  selectB();
  await flush();
  assert.equal(wsInstances.length, 2, 'switching sessions opens a second, independent WebSocket');
  assert.equal(transcript.children.length, 0, 'switching sessions clears the transcript');

  socketA.emit({ seq: 999, sessionId: 'sess-a', kind: 'session.notice', data: { level: 'info', code: 'a-stale', text: 'late from A' } });
  await flush();
  assert.equal(transcript.children.length, 0, "a delayed frame from A's superseded socket must not render into B's transcript");

  const socketB = wsInstances[1];
  socketB.emit({ seq: 1, sessionId: 'sess-b', kind: 'session.notice', data: { level: 'info', code: 'b-live', text: 'live on B' } });
  await flush();
  assert.equal(transcript.children.length, 1, "B's own live frame still renders after the stale A frame was rejected");
});

// Brief item 19 — the transcript-level half of the collapse. `render.test.js` covers the key
// and the group node; this covers what `app.js` decides: that a run of identical notices is
// one row, and that adjacency is what bounds a run.
test('item 19 — a run of identical notices renders as one counted row, and an intervening event starts a new run', async () => {
  const { doc, sseInstances, selectA } = await setUpApp();
  doc.__setEdge('sse');

  selectA();
  await flush();
  const streamA = sseInstances[0];
  const transcript = doc.getElementById('transcript');

  const progress = (seq) => streamA.emit('session.notice', {
    seq,
    sessionId: 'sess-a',
    ts: `2026-09-19T00:00:0${seq}.000Z`,
    kind: 'session.notice',
    data: { level: 'info', code: 'task_progress', text: 'classifying artefacts' },
  });

  progress(1);
  progress(2);
  progress(3);
  assert.equal(transcript.children.length, 1, 'three identical notices are one transcript row, not three');

  const counted = transcript.children[0].children.find((c) => c.className === 'event__count');
  assert.equal(counted.textContent, '×3', 'the single row carries the repeat count');

  // A different kind between the runs breaks adjacency: the notice recurring after a turn
  // boundary is telling the operator something the earlier run did not.
  streamA.emit('turn.started', { seq: 4, sessionId: 'sess-a', ts: '2026-09-19T00:00:04.000Z', kind: 'turn.started', data: { turnId: 'turn-1' } });
  assert.equal(transcript.children.length, 2, 'an intervening event of another kind renders its own row');

  progress(5);
  assert.equal(transcript.children.length, 3, 'the same notice after an intervening event starts a new row rather than folding into the earlier run');
});

test('S37.3/S37.5 — compact hides narration losslessly and shows a counted placeholder without refetching', async () => {
  const { doc, fetchCalls, sseInstances, selectA } = await setUpApp();
  doc.__setEdge('sse');
  selectA();
  await flush();

  const stream = sseInstances[0];
  const transcript = doc.getElementById('transcript');
  stream.emit('message', {
    seq: 1,
    sessionId: 'sess-a',
    ts: '2026-09-20T00:00:00.000Z',
    kind: 'message',
    data: { turnId: 'turn-1', role: 'assistant', text: 'Working on it.', attachments: [] },
  });
  stream.emit('message', {
    seq: 2,
    sessionId: 'sess-a',
    ts: '2026-09-20T00:00:01.000Z',
    kind: 'message',
    data: { turnId: 'turn-1', role: 'assistant', text: "I'll run the focused tests next.", attachments: [] },
  });

  const assistants = transcript.children.filter((node) => node.className === 'event event--assistant');
  const assistant = assistants[0];
  const placeholder = transcript.children.find((node) => node.className === 'event event--assistant-hidden');
  assert.ok(assistant, 'the original assistant node is retained');
  assert.ok(placeholder, 'an entirely hidden assistant turn has a placeholder');
  assert.equal(assistant.hidden, false, 'normal starts with narration visible');
  assert.equal(placeholder.hidden, true, 'normal does not show the compact placeholder');

  const callsBeforeSwitches = fetchCalls.length;
  const select = doc.getElementById('verbosity-select');
  for (let i = 0; i < 20; i++) {
    select.value = i % 2 === 0 ? 'compact' : 'normal';
    select.dispatch('change', {});
  }

  assert.strictEqual(
    transcript.children.find((node) => node.className === 'event event--assistant'),
    assistant,
    'twenty switches preserve the exact stored render node',
  );
  assert.equal(assistant.hidden, false, 'the final normal switch restores narration immediately');
  assert.equal(placeholder.hidden, true);
  assert.equal(fetchCalls.length, callsBeforeSwitches, 'verbosity switches issue no refetch');

  select.value = 'compact';
  select.dispatch('change', {});
  assert.deepEqual(assistants.map((node) => node.hidden), [true, true]);
  assert.equal(placeholder.hidden, false);
  assert.equal(placeholder.children[1].textContent, '2 narration blocks hidden');
});

// S35 — the header always shows this session's identity and burn, and every sidebar row
// carries the same fields with the same null handling.

test('S35.2/S35.4 — the header and the sidebar row for the same session show identical name/vendor/model/state fields', async () => {
  const sessions = [
    { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'live', name: 'triage bot', model: 'opus' },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live', name: null, model: null },
  ];
  const { doc, selectA } = await setUpApp({ sessions });
  selectA();
  await flush();

  assert.equal(doc.getElementById('session-identity').hidden, false);
  assert.equal(doc.getElementById('session-name').textContent, 'triage bot');
  assert.equal(doc.getElementById('session-vendor').textContent, 'acme-agent');
  assert.equal(doc.getElementById('session-model').textContent, 'opus');
  assert.equal(doc.getElementById('session-state').textContent, 'live');

  const row = doc.getElementById('sessions').children[0];
  assert.equal(row.children[0].children[0].textContent, 'triage bot', 'sidebar row name matches the header');
  assert.equal(row.children[0].children[1].textContent, 'acme-agent · opus · live', 'sidebar row meta matches the header fields');
});

test('S35.2/S35.4 — a session with no name and no model falls back to cwd and an explicit default, in both surfaces', async () => {
  const sessions = [
    { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'live', name: null, model: null },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live', name: null, model: null },
  ];
  const { doc, selectA } = await setUpApp({ sessions });
  selectA();
  await flush();

  assert.equal(doc.getElementById('session-name').textContent, '/work/a', 'D249: falls back to cwd');
  assert.equal(doc.getElementById('session-model').textContent, 'default model', 'S35.2: an explicit default, not a blank');

  const row = doc.getElementById('sessions').children[0];
  assert.equal(row.children[0].children[0].textContent, '/work/a');
  assert.match(row.children[0].children[1].textContent, /default model/);
});

test('S35.5 — an ended session reads as "ended" in both surfaces and states nothing about why', async () => {
  const sessions = [
    { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'ended', name: null, model: null },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live', name: null, model: null },
  ];
  const { doc, selectA } = await setUpApp({ sessions });
  selectA();
  await flush();

  assert.equal(doc.getElementById('session-state').textContent, 'ended');
  const row = doc.getElementById('sessions').children[0];
  assert.match(row.children[0].children[1].textContent, /· ended$/);
  // SessionSummary carries no endReason field, so nothing rendered can name one.
  assert.equal(/reason/i.test(row.children[0].children[1].textContent), false);
});

test('S35.8 — a session name and folder carrying angle brackets and a quote render as literal text, not markup', async () => {
  const sessions = [
    { id: 'sess-a', cwd: '/work/<script>a', vendor: 'acme-agent', state: 'live', name: '<b>ops</b> & "prod"', model: null },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live', name: null, model: null },
  ];
  const { doc, selectA } = await setUpApp({ sessions });
  selectA();
  await flush();

  assert.equal(doc.getElementById('session-name').textContent, '<b>ops</b> & "prod"');
  assert.equal(doc.getElementById('session-name').children.length, 0, 'a text node carries no child elements');
  const row = doc.getElementById('sessions').children[0];
  assert.equal(row.children[0].children[0].textContent, '<b>ops</b> & "prod"');
  assert.equal(row.children[0].children[0].children.length, 0);
});

test('S35.3 — the header states "unpriced" rather than a zero cost when costCurrency is null', async () => {
  const { doc, selectA } = await setUpApp();
  selectA();
  await flush();

  const burn = doc.getElementById('session-burn').textContent;
  assert.match(burn, /unpriced/);
  assert.equal(/\$?0\.00/.test(burn), false);
});

test('S35.7 — a fifty-session list issues no payroll fetch at all', async () => {
  const sessions = Array.from({ length: 50 }, (_, i) => ({
    id: `sess-${i}`, cwd: `/work/${i}`, vendor: 'acme-agent', state: 'live', name: null, model: null,
  }));
  const payrollCounter = { count: 0 };
  const { doc } = await setUpApp({ sessions, payrollCounter });

  assert.equal(doc.getElementById('sessions').children.length, 50);
  assert.equal(payrollCounter.count, 0, 'refreshSessions/the initial list render must not fetch payroll');
});

test('S35.6 — the header burn figure is refetched once per turn end, not once per envelope', async () => {
  const sessions = [
    { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'live', name: null, model: null },
    { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live', name: null, model: null },
  ];
  const { doc, sseInstances, selectA } = await setUpApp({ sessions });
  doc.__setEdge('sse');

  // `refreshPayroll` (the panel) and `refreshHeaderBurn` (the header) hit the same route, so a
  // raw fetch count cannot tell them apart — instrumenting the one DOM write only
  // `refreshHeaderBurn` ever makes is what actually isolates "the header's own" fetch count,
  // which is the thing S35.6 constrains.
  const burnEl = doc.getElementById('session-burn');
  let burnWrites = 0;
  let burnValue = burnEl.textContent;
  Object.defineProperty(burnEl, 'textContent', {
    get() { return burnValue; },
    set(v) { burnValue = v; burnWrites += 1; },
  });

  selectA();
  await flush();
  const stream = sseInstances[0];
  const writesAfterSelect = burnWrites;

  // Three turns: started/ended pairs, plus a `usage` envelope per turn that must not, on its
  // own, trigger a second header refresh — the panel still answers to `usage` via
  // `refreshPayroll`, but the header's own fetch is narrower.
  for (let turn = 1; turn <= 3; turn += 1) {
    stream.emit('turn.started', { seq: turn * 10, sessionId: 'sess-a', kind: 'turn.started', data: { turnId: `turn-${turn}` } });
    await flush();
    stream.emit('usage', { seq: turn * 10 + 1, sessionId: 'sess-a', kind: 'usage', data: {} });
    await flush();
    stream.emit('turn.ended', { seq: turn * 10 + 2, sessionId: 'sess-a', kind: 'turn.ended', data: { turnId: `turn-${turn}` } });
    await flush();
  }

  assert.equal(burnWrites - writesAfterSelect, 3, 'exactly one header burn update per turn end across three turns, none from turn.started or usage alone');
});

// S36 — the circles panel is a read of already-rendered history; nothing about opening it
// may change what a `tool.call` does or how it renders (S36.4). Driving the identical
// envelope sequence with the panel open and with it never opened, and comparing the full
// rendered transcript tree, is what actually rules that out rather than asserting it.
function serializeNode(node) {
  if (!node) return null;
  return {
    tagName: node.tagName,
    className: node.className,
    textContent: node.textContent,
    hidden: node.hidden,
    disabled: node.disabled,
    children: node.children.map(serializeNode),
  };
}

test('S36.4 — the circles panel never affects whether or how a call runs: an identical envelope sequence renders an identical transcript whether the panel is open or never opened', async () => {
  // A repeating call — same tool, same input, twice — is deliberately the fixture: this is
  // exactly what the panel would report on, so if reading it changed anything, this is where
  // it would show.
  function buildEnvelopes() {
    const envelopes = [];
    for (let i = 0; i < 2; i += 1) {
      envelopes.push({ seq: i * 3 + 1, sessionId: 'sess-a', kind: 'tool.call', data: { turnId: 't1', callId: `call-${i}`, name: 'Bash', input: { command: 'git status' } } });
      // No `callId` here: sharing it with the `tool.call` above would take the D246 merge
      // path, which this fake DOM's `fakeElement` does not implement (`replaceChild`) —
      // irrelevant to what S36.4 checks, so the standalone rendering path is used instead.
      envelopes.push({ seq: i * 3 + 2, sessionId: 'sess-a', kind: 'permission.request', data: { turnId: 't1', requestId: `req-${i}`, tool: 'Bash', input: { command: 'git status' } } });
      envelopes.push({ seq: i * 3 + 3, sessionId: 'sess-a', kind: 'tool.result', data: { turnId: 't1', callId: `call-${i}`, ok: true, output: 'clean', truncated: false, bytes: 5 } });
    }
    return envelopes;
  }

  async function run(openPanel) {
    const { doc, sseInstances, selectA } = await setUpApp();
    doc.__setEdge('sse');
    selectA();
    await flush();
    if (openPanel) {
      doc.getElementById('circles-open').dispatch('click', {});
      await flush();
    }
    const stream = sseInstances[0];
    for (const envelope of buildEnvelopes()) {
      stream.emit(envelope.kind, envelope);
      await flush();
    }
    return serializeNode(doc.getElementById('transcript'));
  }

  const closed = await run(false);
  const open = await run(true);
  assert.deepEqual(open, closed, 'the rendered transcript — including the two Allow/Deny permission rows this repeating call produces — is byte-identical whether or not the circles panel is open');
});
