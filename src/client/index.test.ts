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

async function loadRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderEvent: (doc: unknown, envelope: unknown) => StubNode | null;
  };
  return mod.renderEvent;
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
  for (const id of ['status', 'login', 'console', 'sessions', 'transcript', 'compose', 'new-session', 'login-form', 'refresh', 'cwd', 'vendor', 'model', 'text', 'secret', 'checkpoints', 'checkpoint-list']) {
    byId.set(id, fakeEl('div'));
  }
  const streams: FakeStream[] = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals['document'], EventSource: globals['EventSource'], fetch: globals['fetch'] };

  globals['document'] = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => fakeEl(tag),
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
    json: async () => (String(input).endsWith('/checkpoints') ? { checkpoints: [] } : String(input) === '/api/sessions' ? { sessions } : {}),
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
