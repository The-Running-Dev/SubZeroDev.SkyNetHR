import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const CLIENT = path.join(process.cwd(), 'client');

async function clientSources(): Promise<Array<{ name: string; text: string }>> {
  const names = await readdir(CLIENT);
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(CLIENT, name), 'utf8') })));
}

// ---------------------------------------------------------------------------
// A DOM stub that records exactly which primitives the renderer used. Assigning
// innerHTML throws, so a renderer that reaches for it fails loudly rather than
// silently passing a string-equality check.
// ---------------------------------------------------------------------------

interface StubNode {
  tag: string;
  text: string | null;
  attrs: Record<string, string>;
  children: StubNode[];
  className: string;
}

function makeDoc() {
  const created: StubNode[] = [];
  function createElement(tag: string): StubNode {
    const node: StubNode = { tag, text: null, attrs: {}, children: [], className: '' };
    const proxied = new Proxy(node, {
      set(target, prop, value) {
        if (prop === 'innerHTML' || prop === 'outerHTML') throw new Error(`renderer assigned ${String(prop)}`);
        if (prop === 'textContent') { target.text = String(value); return true; }
        (target as unknown as Record<string, unknown>)[prop as string] = value;
        return true;
      },
      get(target, prop) {
        if (prop === 'appendChild') return (child: StubNode) => { target.children.push(child); return child; };
        if (prop === 'setAttribute') return (k: string, v: string) => { target.attrs[k] = String(v); };
        if (prop === 'addEventListener') return () => {}; // renderers wire click handlers; not exercised here
        if (prop === 'textContent') return target.text;
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });
    created.push(node);
    return proxied as StubNode;
  }
  return { doc: { createElement }, created };
}

function allText(node: StubNode): string[] {
  const out: string[] = [];
  if (node.text !== null) out.push(node.text);
  for (const c of node.children) out.push(...allText(c));
  return out;
}

function findAll(node: StubNode, tag: string): StubNode[] {
  const out: StubNode[] = [];
  if (node.tag.toLowerCase() === tag) out.push(node);
  for (const c of node.children) out.push(...findAll(c, tag));
  return out;
}

async function loadRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderEvent: (doc: unknown, envelope: unknown, handlers?: unknown) => StubNode | null;
  };
  return mod.renderEvent;
}

async function loadAuditRowRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderAuditRow: (doc: unknown, record: unknown) => StubNode;
  };
  return mod.renderAuditRow;
}

async function loadRequisitionRowRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderRequisitionRow: (doc: unknown, requisition: unknown, onDecide?: unknown) => StubNode;
  };
  return mod.renderRequisitionRow;
}

const XSS = '<img src=x onerror=alert(1)>';

describe('S2.11 — the client renders normalised events only', () => {
  it('renders message, thinking and tool.call', async () => {
    const renderEvent = await loadRenderer();
    const cases = [
      { kind: 'message', data: { turnId: 't', role: 'assistant', text: 'hello there' } },
      { kind: 'thinking', data: { turnId: 't', text: 'considering' } },
      { kind: 'tool.call', data: { turnId: 't', callId: 'c1', name: 'Bash', input: { command: 'ls' }, summary: 'ls' } },
      { kind: 'checkpoint.created', data: { turnId: 't', sha: 'a'.repeat(40), label: 'before turn t' } },
      { kind: 'checkpoint.created', data: { turnId: null, sha: 'b'.repeat(40), label: `before restore to ${'a'.repeat(40)}` } },
    ];
    for (const c of cases) {
      const { doc } = makeDoc();
      const node = renderEvent(doc, { seq: 1, sessionId: 's', ts: '2026-08-09T00:00:00.000Z', ...c });
      assert.ok(node, `${c.kind} rendered a node`);
      assert.ok(allText(node!).join(' ').length > 0, `${c.kind} rendered some text`);
    }
  });

  it('carries no vendor string anywhere in the client sources', async () => {
    for (const { name, text } of await clientSources()) {
      assert.doesNotMatch(text, /claude/i, `${name} names a vendor`);
      assert.doesNotMatch(text, /codex/i, `${name} names a vendor`);
    }
  });

  it('renders an unknown event kind as nothing rather than throwing', async () => {
    const renderEvent = await loadRenderer();
    const { doc } = makeDoc();
    assert.equal(renderEvent(doc, { seq: 1, sessionId: 's', ts: 'x', kind: 'nonesuch', data: {} }), null);
  });
});

describe('S9.2 — a truncated tool.result offers its full output one click away', () => {
  it('renders a download link to the tool-output route when truncated, and none when it is not', async () => {
    const renderEvent = await loadRenderer();
    const envelope = {
      seq: 1, sessionId: 's', ts: 'x', kind: 'tool.result',
      data: { turnId: 't-1', callId: 'call-1', ok: true, output: 'partial', truncated: true, bytes: 99999 },
    };
    const { doc: doc1 } = makeDoc();
    const truncated = renderEvent(doc1, envelope, { sessionId: 'sess-abc' })!;
    const links = findAll(truncated, 'a');
    assert.equal(links.length, 1, 'a truncated result renders exactly one link');
    assert.equal(links[0]!.attrs['href'], '/api/sessions/sess-abc/tool-output/t-1/call-1');

    const { doc: doc2 } = makeDoc();
    const untruncated = renderEvent(doc2, { ...envelope, data: { ...envelope.data, truncated: false } }, { sessionId: 'sess-abc' })!;
    assert.equal(findAll(untruncated, 'a').length, 0, 'an untruncated result has nothing to fetch');
  });
});

describe('S2.12 — untrusted content is text, never markup', () => {
  it('renders message text containing HTML as literal characters', async () => {
    const renderEvent = await loadRenderer();
    const { doc, created } = makeDoc();
    const node = renderEvent(doc, { seq: 1, sessionId: 's', ts: 'x', kind: 'message', data: { turnId: 't', role: 'assistant', text: XSS } })!;
    assert.ok(allText(node).includes(XSS), 'the exact characters survive as a text node');
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });

  it('renders a tool name containing HTML as literal characters', async () => {
    const renderEvent = await loadRenderer();
    const { doc, created } = makeDoc();
    const node = renderEvent(doc, {
      seq: 1, sessionId: 's', ts: 'x', kind: 'tool.call',
      data: { turnId: 't', callId: 'c1', name: XSS, input: {}, summary: XSS },
    })!;
    assert.ok(allText(node).some((t) => t.includes(XSS)), 'the exact characters survive as a text node');
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });

  it('uses no markup-parsing primitive anywhere in the client sources', async () => {
    // Comments are stripped first: the rule is about what the code does, and a comment
    // explaining why a primitive is not used must not read as using it.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const forbidden = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write\b/, /\beval\s*\(/, /new\s+Function\s*\(/];
    for (const { name, text } of await clientSources()) {
      if (!name.endsWith('.js')) continue;
      const code = stripComments(text);
      for (const pattern of forbidden) assert.doesNotMatch(code, pattern, `${name} uses ${pattern}`);
    }
  });

  it('has no inline script or style in the document', async () => {
    const html = await readFile(path.join(CLIENT, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'a <script> without src is inline');
    assert.doesNotMatch(html, /<style/i, 'an inline <style> block');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'an inline event-handler attribute');
    assert.doesNotMatch(html, /style\s*=/i, 'an inline style attribute');
    assert.match(html, /<script[^>]+type="module"[^>]+src="\/app\.js"/, 'the script is external');
    assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="\/app\.css"/, 'the stylesheet is external');
  });
});

describe('S12.10 — the audit screen renders every field as a text node', () => {
  it('renders operator, tool, input, decision and ts as literal text, including an XSS payload in input', async () => {
    const renderAuditRow = await loadAuditRowRenderer();
    const { doc, created } = makeDoc();
    const record = {
      ts: '2026-08-13T00:00:00.000Z',
      operator: 'ben',
      sessionId: 's-1',
      vendor: 'x',
      sandbox: null,
      tool: XSS,
      input: { command: XSS },
      decision: 'allow',
      scope: 'once',
      reason: null,
    };
    const row = renderAuditRow(doc, record);
    const rendered = allText(row).join(' ');
    assert.ok(rendered.includes('2026-08-13T00:00:00.000Z'), 'ts');
    assert.ok(rendered.includes('ben'), 'operator');
    assert.ok(rendered.includes('allow'), 'decision');
    assert.ok(rendered.includes(XSS), 'the exact XSS characters survive as text — in both the tool name and the input');
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });

  it('renders "server" for a server-forced decision (operator: null)', async () => {
    const renderAuditRow = await loadAuditRowRenderer();
    const { doc } = makeDoc();
    const record = {
      ts: 'x', operator: null, sessionId: 's-1', vendor: 'x', sandbox: null,
      tool: 'bash', input: {}, decision: 'deny', scope: 'standing', reason: 'no matching rule',
    };
    const row = renderAuditRow(doc, record);
    assert.ok(allText(row).includes('server'));
  });
});

describe('S13.15 — a requisition\'s title, justification and workspace render as text nodes', () => {
  it('renders an XSS payload in justification as literal characters, in a different operator\'s browser', async () => {
    const renderRequisitionRow = await loadRequisitionRowRenderer();
    const { doc, created } = makeDoc();
    const requisition = {
      requisitionId: 'req-1',
      raisedBy: 'alice',
      title: 'a workspace',
      justification: XSS,
      workspace: '/w',
      vendor: 'claude',
      state: 'open',
      decidedBy: null,
      decidedAt: null,
      sessionId: null,
      raisedAt: 'x',
    };
    // `bob` reads a requisition `alice` raised — D70's open read, exercised here as the
    // "different operator's browser" the criterion names.
    const row = renderRequisitionRow(doc, requisition);
    const rendered = allText(row).join(' ');
    assert.ok(rendered.includes(XSS), 'the exact XSS characters survive as a text node');
    assert.ok(rendered.includes('alice'));
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });

  it('offers Approve/Reject only while state is open', async () => {
    const renderRequisitionRow = await loadRequisitionRowRenderer();
    const base = {
      requisitionId: 'req-1', raisedBy: 'alice', title: 't', justification: 'j', workspace: '/w',
      vendor: 'claude', decidedBy: null, decidedAt: null, sessionId: null, raisedAt: 'x',
    };
    const { doc: doc1 } = makeDoc();
    const open = renderRequisitionRow(doc1, { ...base, state: 'open' }, () => {});
    assert.equal(findAll(open, 'button').length, 2);

    const { doc: doc2 } = makeDoc();
    const approved = renderRequisitionRow(doc2, { ...base, state: 'approved', decidedBy: 'bob' }, () => {});
    assert.equal(findAll(approved, 'button').length, 0);
  });
});

describe('S2.14 — every rendered value is a CSS custom property', () => {
  it('declares its tokens in one stylesheet and uses literal colours nowhere else', async () => {
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');

    // The custom-property declarations are the one place a literal may appear.
    const declarationBlocks = [...css.matchAll(/:root\s*\{[\s\S]*?\}/g)].map((m) => m[0]);
    assert.ok(declarationBlocks.length >= 1, 'there is a :root token block');
    let rest = css;
    for (const block of declarationBlocks) rest = rest.replace(block, '');

    const named = ['red', 'blue', 'green', 'white', 'black', 'gray', 'grey', 'orange', 'purple', 'yellow', 'pink', 'brown', 'cyan', 'magenta', 'silver', 'navy', 'teal', 'olive', 'lime', 'aqua', 'fuchsia', 'maroon'];
    const literals: Array<[string, RegExp]> = [
      ['hex', /#[0-9a-fA-F]{3,8}\b/],
      ['rgb(', /\brgba?\s*\(/],
      ['hsl(', /\bhsla?\s*\(/],
      ['named colour', new RegExp(`:\\s*(${named.join('|')})\\s*[;}]`, 'i')],
    ];
    for (const [label, pattern] of literals) {
      const hit = rest.match(pattern);
      assert.equal(hit, null, `a ${label} literal outside the token block: ${hit?.[0]}`);
    }
  });

  it('sets every colour, spacing, radius and font-size declaration from a var()', async () => {
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');
    let rest = css;
    for (const block of [...css.matchAll(/:root\s*\{[\s\S]*?\}/g)].map((m) => m[0])) rest = rest.replace(block, '');

    const properties = /(^|[;{]\s*)(color|background|background-color|border-color|border-radius|padding|margin|gap|font-size|font-family|box-shadow)\s*:\s*([^;}]+)/gi;
    let match: RegExpExecArray | null;
    let checked = 0;
    while ((match = properties.exec(rest)) !== null) {
      const [, , property, value] = match;
      const v = value!.trim();
      // `0`, `inherit`, `none`, `transparent` and `currentColor` are not values a token layer owns.
      if (/^(0|none|inherit|initial|unset|transparent|currentColor|auto)$/i.test(v)) continue;
      assert.match(v, /var\(--/, `${property}: ${v} is a literal, not a token`);
      checked++;
    }
    assert.ok(checked >= 10, `the sweep actually examined declarations (saw ${checked})`);
  });
});

// ---------------------------------------------------------------------------
// S3.3 (client half) — a browser stub thin enough to run `app.js` end to end.
//
// The renderer above is exercised against a document stub; the reconnect behaviour
// cannot be, because it lives in the module that owns the `EventSource`. This stub is
// the smallest thing that lets that module run: elements that record their listeners,
// an `EventSource` that records its constructions, and a `fetch` that answers the one
// route the console calls on start.
// ---------------------------------------------------------------------------

interface FakeEl {
  tag: string;
  className: string;
  hidden: boolean;
  type: string;
  value: string;
  scrollTop: number;
  scrollHeight: number;
  textContent: string | null;
  children: FakeEl[];
  listeners: Map<string, Array<(event: unknown) => void>>;
  appendChild(child: FakeEl): FakeEl;
  removeChild(child: FakeEl): FakeEl;
  firstChild: FakeEl | null;
  addEventListener(kind: string, fn: (event: unknown) => void): void;
  querySelector(): null;
}

function fakeEl(tag: string): FakeEl {
  const node: FakeEl = {
    tag,
    className: '',
    hidden: false,
    type: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    textContent: null,
    children: [],
    listeners: new Map(),
    appendChild(child) { node.children.push(child); return child; },
    removeChild(child) { node.children = node.children.filter((c) => c !== child); return child; },
    get firstChild() { return node.children[0] ?? null; },
    addEventListener(kind, fn) {
      const existing = node.listeners.get(kind) ?? [];
      existing.push(fn);
      node.listeners.set(kind, existing);
    },
    querySelector: () => null,
  };
  return node;
}

interface FakeStream {
  url: string;
  closed: boolean;
  listeners: Map<string, Array<(event: { data: string }) => void>>;
}

async function runConsole(sessions: ReadonlyArray<Record<string, unknown>>) {
  const byId = new Map<string, FakeEl>();
  for (const id of [
    'status', 'login', 'console', 'sessions', 'transcript', 'compose', 'new-session', 'login-form',
    'refresh', 'cwd', 'vendor', 'model', 'sandbox', 'requisition-id', 'text', 'secret', 'checkpoints', 'checkpoint-list',
    'checklist', 'checklist-list',
    'policy-banner', 'audit', 'audit-open', 'audit-close', 'audit-filters', 'audit-filter-session',
    'audit-filter-operator', 'audit-filter-since', 'audit-filter-until', 'audit-rows', 'audit-empty',
    'audit-load-more', 'requisitions', 'requisitions-open', 'requisitions-close', 'raise-requisition',
    'requisition-title', 'requisition-justification', 'requisition-workspace', 'requisition-vendor',
    'requisition-rows', 'requisitions-empty',
  ]) {
    byId.set(id, fakeEl('div'));
  }
  const streams: FakeStream[] = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals['document'], EventSource: globals['EventSource'], fetch: globals['fetch'] };

  globals['document'] = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => fakeEl(tag),
    // No `<meta name="skynet-edge">` in this fake document: `activeEdge()` reads that as
    // the SSE edge (S11.5's default), which is what every test here except S11's own
    // exercises.
    querySelector: () => null,
  };
  globals['EventSource'] = class {
    url: string;
    closed = false;
    listeners = new Map<string, Array<(event: { data: string }) => void>>();
    onopen: unknown = null;
    onerror: unknown = null;
    constructor(url: string) {
      this.url = url;
      streams.push(this as unknown as FakeStream);
    }
    addEventListener(kind: string, fn: (event: { data: string }) => void): void {
      const existing = this.listeners.get(kind) ?? [];
      existing.push(fn);
      this.listeners.set(kind, existing);
    }
    close(): void { this.closed = true; }
  };
  globals['fetch'] = async (input: string) => ({
    status: 200,
    json: async () =>
      String(input).endsWith('/checkpoints')
        ? { checkpoints: [] }
        : String(input).endsWith('/checklist')
          ? { items: [] }
          : String(input) === '/api/sessions'
            ? { sessions }
            : String(input) === '/api/requisitions'
              ? { requisitions: [] }
              : {},
  });

  // A distinct query per load: `app.js` runs its bootstrap on import, so a cached module
  // would replay nothing.
  await import(`${pathToFileURL(path.join(CLIENT, 'app.js')).href}?t=${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Selecting a session kicks off a session-list refresh the console does not await.
  // Putting the real globals back while that is still in flight would fail it against a
  // `document` that no longer exists, so the drain happens first.
  const restore = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    globals['document'] = saved.document;
    globals['EventSource'] = saved.EventSource;
    globals['fetch'] = saved.fetch;
  };
  return { byId, streams, restore };
}

function deliver(stream: FakeStream, envelope: Record<string, unknown>): void {
  for (const fn of stream.listeners.get(String(envelope['kind'])) ?? []) fn({ data: JSON.stringify(envelope) });
}

const GAP = { seq: 0, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'error', data: { kind: 'replay_gap', message: 'the spill could not serve this range', fatal: false } };

describe('S3.3 — a reported replay_gap makes the client refetch the transcript', () => {
  it('reopens the stream once, from the start, and drops the transcript it knows is short', async () => {
    const { byId, streams, restore } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'live' }]);
    try {
      const list = byId.get('sessions')!;
      const button = list.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      assert.equal(streams.length, 1, 'selecting a session opens one stream');

      const transcript = byId.get('transcript')!;
      deliver(streams[0]!, { seq: 1, sessionId: 's1', ts: GAP.ts, kind: 'message', data: { turnId: 't', role: 'assistant', text: 'partial history' } });
      assert.equal(transcript.children.length, 1);

      deliver(streams[0]!, GAP);
      assert.equal(streams.length, 2, 'the gap reopens the stream');
      assert.equal(streams[0]!.closed, true, 'the gapped stream is closed, not left running alongside');
      // A fresh EventSource carries no Last-Event-ID, so the reopen asks from seq 1 — and
      // the short transcript is dropped rather than having the refetch appended to it.
      assert.equal(streams[1]!.url, streams[0]!.url);
      assert.equal(transcript.children.length, 0, 'the transcript known to be short is cleared');
      assert.equal(transcript.children.some((c) => JSON.stringify(c).includes('replay_gap')), false);
    } finally {
      await restore();
    }
  });

  it('refetches once only, so an unreadable spill does not become a reconnect loop', async () => {
    const { byId, streams, restore } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});

      deliver(streams[0]!, GAP);
      assert.equal(streams.length, 2);
      deliver(streams[1]!, GAP);
      assert.equal(streams.length, 2, 'the second gap does not reopen again');

      const status = byId.get('status')!;
      const shown = status.children.map((c) => c.textContent).join(' ');
      assert.match(shown, /history unavailable/, 'and the operator is told the transcript is incomplete');
      // The second gap is rendered rather than swallowed: the run on screen is not the run.
      assert.equal(byId.get('transcript')!.children.length, 1);
    } finally {
      await restore();
    }
  });
});

describe('S7.2 — an ended session offers no compose box', () => {
  it('a session listed as ended is selected read-only, and says why', async () => {
    const { byId, restore } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'ended' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});

      assert.equal(byId.get('compose')!.hidden, true, 'a rehydrated session refuses every message with 409 session_ended (D20)');
      // Everything else stays readable: D20 keeps the transcript and the checkpoints.
      assert.equal(byId.get('checkpoints')!.hidden, false);
      const shown = byId.get('status')!.children.map((c) => c.textContent).join(' ');
      assert.match(shown, /ended/, 'a box that vanishes with no reason given is a bug report');
    } finally {
      await restore();
    }
  });

  it('a live session withdraws the box the moment session.ended arrives', async () => {
    const { byId, streams, restore } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      assert.equal(byId.get('compose')!.hidden, false, 'a live session composes normally');

      // Ended from somewhere this client did not act: another tab, or a storage failure.
      deliver(streams[0]!, {
        seq: 7,
        sessionId: 's1',
        ts: '2026-08-09T00:00:00.000Z',
        kind: 'session.ended',
        data: { reason: 'operator', endedAt: '2026-08-09T00:00:00.000Z' },
      });

      assert.equal(byId.get('compose')!.hidden, true, 'the box goes at the event, not at the next refresh');
      // The event is still drawn: the status bar is transient, the transcript is the record.
      assert.equal(byId.get('transcript')!.children.length, 1);
    } finally {
      await restore();
    }
  });
});
