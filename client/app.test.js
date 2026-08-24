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
      this.children.push(node);
      return node;
    },
    removeChild(node) {
      this.children = this.children.filter((c) => c !== node);
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

async function setUpApp() {
  const doc = makeFakeDocument();
  const sseInstances = [];
  const wsInstances = [];
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
  globalThis.fetch = fakeFetch([
    ['/api/sessions', () => ({ status: 200, payload: { sessions: [
      { id: 'sess-a', cwd: '/work/a', vendor: 'acme-agent', state: 'live' },
      { id: 'sess-b', cwd: '/work/b', vendor: 'acme-agent', state: 'live' },
    ] } })],
  ]);

  // `app.js` self-executes `start()` on import (no exports) — dynamic import with a
  // cache-busting query string so a second `setUpApp()` in a later test gets a fresh module
  // instance (and fresh `state`) against the fresh globals just installed above, rather than
  // Node's ESM cache handing back the first test's already-initialised module.
  await import(`./app.js?t=${Date.now()}-${Math.random()}`);
  await flush();

  const sessionsList = doc.getElementById('sessions');
  assert.equal(sessionsList.children.length, 2, 'setup: both fixture sessions rendered');
  const selectA = () => sessionsList.children[0].children[0].dispatch('click', {});
  const selectB = () => sessionsList.children[1].children[0].dispatch('click', {});

  return { doc, sseInstances, wsInstances, selectA, selectB };
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
