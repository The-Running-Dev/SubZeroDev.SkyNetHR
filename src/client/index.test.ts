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

async function loadIncidentGroupRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderIncidentGroups: (doc: unknown, records: unknown[]) => StubNode;
    groupAuditRecords: (records: unknown[]) => Array<{ sessionId: string; operators: Array<{ operator: string | null; records: unknown[] }> }>;
  };
  return mod;
}

async function loadRequisitionRowRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderRequisitionRow: (doc: unknown, requisition: unknown, onDecide?: unknown) => StubNode;
  };
  return mod.renderRequisitionRow;
}

async function loadReviewRowRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderReviewRow: (doc: unknown, review: unknown) => StubNode;
  };
  return mod.renderReviewRow;
}

async function loadPayrollSummaryRenderer() {
  const mod = (await import(pathToFileURL(path.join(CLIENT, 'render.js')).href)) as {
    renderPayrollSummary: (doc: unknown, view: unknown) => StubNode;
    formatDuration: (ms: number) => string;
  };
  return mod;
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

describe('S17.5 — the incident view groups the server\'s flat page by session and by operator, client-side', () => {
  it('groups records first by sessionId, then by operator within a session, preserving arrival order', async () => {
    const { groupAuditRecords } = await loadIncidentGroupRenderer();
    const records = [
      { sessionId: 's-1', operator: 'alice', ts: '1' },
      { sessionId: 's-1', operator: null, ts: '2' },
      { sessionId: 's-2', operator: 'alice', ts: '3' },
      { sessionId: 's-1', operator: 'alice', ts: '4' },
    ];
    const groups = groupAuditRecords(records);
    assert.equal(groups.length, 2, 'two sessions');
    assert.equal(groups[0]!.sessionId, 's-1');
    assert.equal(groups[0]!.operators.length, 2, 'alice and server, within s-1');
    assert.equal(groups[0]!.operators[0]!.operator, 'alice');
    assert.equal(groups[0]!.operators[0]!.records.length, 2, 'both s-1/alice records, including the later one');
    assert.equal(groups[0]!.operators[1]!.operator, null);
    assert.equal(groups[1]!.sessionId, 's-2');
  });

  it('renders every record from the flat page as a text node under its group, no grouped shape assumed beyond arrangement', async () => {
    const { renderIncidentGroups } = await loadIncidentGroupRenderer();
    const { doc, created } = makeDoc();
    const records = [
      {
        ts: 'x', operator: null, sessionId: 'sess-owned-by-nobody', vendor: 'x', sandbox: null,
        tool: XSS, input: { a: XSS }, decision: 'deny', scope: 'once', reason: 'cancelled_process_exit',
      },
      {
        ts: 'y', operator: 'alice', sessionId: 'sess-owned-by-alice', vendor: 'x', sandbox: null,
        tool: 'bash', input: {}, decision: 'allow', scope: 'standing', reason: 'rule',
      },
    ];
    const tree = renderIncidentGroups(doc, records);
    const rendered = allText(tree).join(' ');
    assert.ok(rendered.includes('sess-owned-by-nobody'));
    assert.ok(rendered.includes('sess-owned-by-alice'));
    assert.ok(rendered.includes('server'), 'operator: null renders as "server", same as the flat view');
    assert.ok(rendered.includes('alice'));
    assert.ok(rendered.includes(XSS), 'the exact XSS characters survive as text — never assembled markup');
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });
});

describe('S17.6 — the incident view reads records across owners and across deleted sessions, same as S12', () => {
  it('renders a record for a session the viewer does not own, and one for a session that no longer exists', async () => {
    const { renderIncidentGroups } = await loadIncidentGroupRenderer();
    const { doc } = makeDoc();
    const records = [
      { ts: 'x', operator: null, sessionId: 'sess-not-owned', vendor: 'x', sandbox: null, tool: 'bash', input: {}, decision: 'deny', scope: 'once', reason: 'cancelled_process_exit' },
      { ts: 'y', operator: null, sessionId: 'sess-deleted', vendor: 'x', sandbox: null, tool: 'bash', input: {}, decision: 'deny', scope: 'once', reason: 'cancelled_process_exit' },
    ];
    const tree = renderIncidentGroups(doc, records);
    const rendered = allText(tree).join(' ');
    assert.ok(rendered.includes('sess-not-owned'));
    assert.ok(rendered.includes('sess-deleted'));
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

describe("S15.13 — a review's body renders as literal characters, in a different operator's browser", () => {
  it('renders an XSS payload in body as literal characters, never as markup', async () => {
    const renderReviewRow = await loadReviewRowRenderer();
    const { doc, created } = makeDoc();
    const review = {
      reviewId: 'rev-1',
      subject: 'sess-1',
      snapshot: { sessionId: 'sess-1', owner: 'alice', vendor: 'claude', cwd: '/w', createdAt: 'x' },
      author: 'alice',
      state: 'final',
      rating: 'meets',
      pip: false,
      body: XSS,
      createdAt: 'x',
      updatedAt: 'x',
    };
    // `bob` reads a review `alice` authored — the review is final, so D70's open read
    // applies, exercised here as the "different operator's browser" the criterion names.
    const row = renderReviewRow(doc, review);
    const rendered = allText(row).join(' ');
    assert.ok(rendered.includes(XSS), 'the exact XSS characters survive as a text node');
    assert.ok(rendered.includes('alice'));
    assert.ok(!created.some((n) => n.tag.toLowerCase() === 'img'), 'no img element was ever created');
  });
});

describe('S16 — the payroll panel renders burn, remaining budget, idle time, and dropped intervals', () => {
  it('shows "no budget set" when remainingTokens is null and omits the dropped-interval row when there are none', async () => {
    const { renderPayrollSummary } = await loadPayrollSummaryRenderer();
    const { doc } = makeDoc();
    const view = {
      sessionId: 'sess-1',
      burn: { inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 5 },
      budgetTokens: null,
      remainingTokens: null,
      idleMs: 65000,
      droppedIntervals: 0,
    };
    const dl = renderPayrollSummary(doc, view);
    const rendered = allText(dl).join(' ');
    assert.ok(rendered.includes('165'), 'burn is the component-wise sum of the four fields (100+50+10+5)');
    assert.ok(rendered.includes('no budget set'));
    assert.ok(!rendered.includes('dropped'), 'no dropped-interval row when droppedIntervals is 0');
  });

  it('shows the dropped-interval count when there is one, and a numeric remaining budget when there is a budget', async () => {
    const { renderPayrollSummary } = await loadPayrollSummaryRenderer();
    const { doc } = makeDoc();
    const view = {
      sessionId: 'sess-1',
      burn: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 },
      budgetTokens: 1000,
      remainingTokens: 850,
      idleMs: 0,
      droppedIntervals: 2,
    };
    const dl = renderPayrollSummary(doc, view);
    const rendered = allText(dl).join(' ');
    assert.ok(rendered.includes('850'));
    assert.ok(rendered.includes('2 intervals dropped'));
  });

  it('formatDuration reads hours and minutes, and floors under a minute to "<1m"', async () => {
    const { formatDuration } = await loadPayrollSummaryRenderer();
    assert.equal(formatDuration(0), '<1m');
    assert.equal(formatDuration(59_000), '<1m');
    assert.equal(formatDuration(60_000), '1m');
    assert.equal(formatDuration(3_600_000 + 5 * 60_000), '1h 05m');
  });

  it('refetches the panel on usage, turn.ended and session.ended, not just at session selection', async () => {
    const { byId, streams, restore, fetchCalls } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      const countAfterSelect = fetchCalls.filter((u) => u.endsWith('/payroll')).length;
      assert.equal(countAfterSelect, 1, 'selecting a session fetches the panel once');

      deliver(streams[0]!, { seq: 1, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'usage', data: { turnId: 't1', usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 } } });
      assert.equal(fetchCalls.filter((u) => u.endsWith('/payroll')).length, countAfterSelect + 1, 'a usage event refetches burn — a live session must not show a stale count');

      deliver(streams[0]!, { seq: 2, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'turn.ended', data: { turnId: 't1', stopReason: 'completed', usage: null } });
      assert.equal(fetchCalls.filter((u) => u.endsWith('/payroll')).length, countAfterSelect + 2, 'turn.ended closes an idle boundary and refetches too');

      deliver(streams[0]!, { seq: 3, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'session.ended', data: { reason: 'operator', endedAt: '2026-08-09T00:00:00.000Z' } });
      assert.equal(fetchCalls.filter((u) => u.endsWith('/payroll')).length, countAfterSelect + 3, 'session.ended finalises the trailing idle gap and refetches once more');
    } finally {
      await restore();
    }
  });

  it('does not refetch for another session\'s usage event', async () => {
    const { byId, streams, restore, fetchCalls } = await runConsole([{ id: 's1', cwd: '/w/p', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      const before = fetchCalls.filter((u) => u.endsWith('/payroll')).length;

      deliver(streams[0]!, { seq: 1, sessionId: 'some-other-session', ts: '2026-08-09T00:00:00.000Z', kind: 'usage', data: { turnId: 't1', usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 } } });
      assert.equal(fetchCalls.filter((u) => u.endsWith('/payroll')).length, before, 'a usage event for a session that is not selected must not refetch this one');
    } finally {
      await restore();
    }
  });
});

// S18.1/D78: the token layer is four blocks, one per theme, each selected by
// `:root[data-theme="X"]` rather than a bare `:root` — this regex is the one place both
// S2.14 and S18's tests read the shape from, so it stays a single source between them.
const ROOT_BLOCK = /:root(?:\[data-theme="[A-Z]"\])?\s*\{[\s\S]*?\}/g;

describe('S2.14 — every rendered value is a CSS custom property', () => {
  it('declares its tokens in one stylesheet and uses literal colours nowhere else', async () => {
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');

    // The custom-property declarations are the one place a literal may appear.
    const declarationBlocks = [...css.matchAll(ROOT_BLOCK)].map((m) => m[0]);
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
    for (const block of [...css.matchAll(ROOT_BLOCK)].map((m) => m[0])) rest = rest.replace(block, '');

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
  checked: boolean;
  disabled: boolean;
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
  reset(): void;
}

function fakeEl(tag: string): FakeEl {
  const node: FakeEl = {
    tag,
    className: '',
    hidden: false,
    type: '',
    value: '',
    checked: false,
    disabled: false,
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
    // A `<form>`'s real `reset()` restores every field to its initial value — the stub
    // only needs the two fields `resetReviewForm` (client/app.js) actually reads back.
    reset() { node.value = ''; node.checked = false; },
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
    'payroll', 'payroll-summary',
    'policy-banner', 'audit', 'audit-open', 'audit-close', 'audit-filters', 'audit-filter-session',
    'audit-filter-operator', 'audit-filter-since', 'audit-filter-until', 'audit-rows', 'audit-empty',
    'audit-load-more', 'requisitions', 'requisitions-open', 'requisitions-close', 'raise-requisition',
    'requisition-title', 'requisition-justification', 'requisition-workspace', 'requisition-vendor',
    'requisition-rows', 'requisitions-empty',
    'reviews', 'review-rows', 'reviews-empty', 'pip-badge', 'review-form', 'review-rating',
    'review-pip', 'review-body', 'review-save', 'review-publish',
    'status-badge', 'theme-select', 'terminate-open', 'terminate', 'terminate-close',
    'terminate-summary', 'terminate-ended', 'terminate-confirm',
    'interrupt', 'end-session', 'turn-elapsed',
  ]) {
    byId.set(id, fakeEl('div'));
  }
  // `theme-select` is read and written as a `<select>` (`.value`) by `app.js`'s theme
  // switcher — `fakeEl` already carries a plain `value` field, so nothing more is needed.
  const streams: FakeStream[] = [];
  const fetchCalls: string[] = [];
  const fetchMethods: string[] = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals['document'],
    EventSource: globals['EventSource'],
    fetch: globals['fetch'],
    localStorage: globals['localStorage'],
  };

  // S18.1/S18.4: `documentElement` is what `theme.js` (before this module even loads, in
  // the real page) and `app.js`'s theme switcher both set `data-theme` on.
  const rootAttrs = new Map<string, string>();
  const documentElement = {
    getAttribute: (k: string) => (rootAttrs.has(k) ? rootAttrs.get(k)! : null),
    setAttribute: (k: string, v: string) => { rootAttrs.set(k, String(v)); },
  };
  globals['document'] = {
    documentElement,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => fakeEl(tag),
    // No `<meta name="skynet-edge">` in this fake document: `activeEdge()` reads that as
    // the SSE edge (S11.5's default), which is what every test here except S11's own
    // exercises.
    querySelector: () => null,
  };
  // S18.3: a plain in-memory stand-in for the browser storage the theme choice is read
  // from and written to — never fetched, never posted.
  const storageMap = new Map<string, string>();
  globals['localStorage'] = {
    getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
    setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
    removeItem: (k: string) => { storageMap.delete(k); },
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
  globals['fetch'] = async (input: string, options?: { method?: string }) => {
    fetchCalls.push(String(input));
    fetchMethods.push(options?.method ?? 'GET');
    return {
    status: 200,
    json: async () =>
      String(input).endsWith('/checkpoints')
        ? { checkpoints: [] }
        : String(input).endsWith('/checklist')
          ? { items: [] }
          : String(input).endsWith('/payroll')
            ? { sessionId: 's1', burn: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 }, budgetTokens: null, remainingTokens: null, idleMs: 0, droppedIntervals: 0 }
            : String(input) === '/api/sessions'
            ? { sessions }
            : String(input) === '/api/requisitions'
              ? { requisitions: [] }
              : String(input).startsWith('/api/reviews')
                ? { reviews: [] }
                : {},
    };
  };

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
    globals['localStorage'] = saved.localStorage;
  };
  return { byId, streams, restore, fetchCalls, fetchMethods, documentElement, storageMap };
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

// ---------------------------------------------------------------------------
// S18 — Four visual systems, and the badges over them.
// ---------------------------------------------------------------------------

function allFakeText(node: FakeEl): string[] {
  const out: string[] = [];
  if (node.textContent !== null) out.push(node.textContent);
  for (const c of node.children) out.push(...allFakeText(c));
  return out;
}

async function loadThemeBootstrap(storage: { getItem(key: string): string | null }) {
  const rootAttrs = new Map<string, string>();
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals['document'], localStorage: globals['localStorage'] };
  globals['document'] = {
    documentElement: {
      setAttribute: (k: string, v: string) => rootAttrs.set(k, String(v)),
      getAttribute: (k: string) => rootAttrs.get(k) ?? null,
    },
  };
  globals['localStorage'] = storage;
  try {
    // A distinct query per load: the script runs its IIFE on import, so a cached module
    // would set the attribute once and never again.
    await import(`${pathToFileURL(path.join(CLIENT, 'theme.js')).href}?t=${Math.random()}`);
  } finally {
    globals['document'] = saved.document;
    globals['localStorage'] = saved.localStorage;
  }
  return rootAttrs.get('data-theme') ?? null;
}

describe('S18.4 — theme.js sets data-theme before anything else runs', () => {
  it('defaults to B when nothing is stored', async () => {
    const attr = await loadThemeBootstrap({ getItem: () => null });
    assert.equal(attr, 'B');
  });

  it('uses a validly stored theme', async () => {
    const attr = await loadThemeBootstrap({ getItem: () => 'C' });
    assert.equal(attr, 'C');
  });

  it('falls back to the default on an invalid stored value, rather than leaving the document unthemed', async () => {
    const attr = await loadThemeBootstrap({ getItem: () => 'not-a-theme' });
    assert.equal(attr, 'B');
  });

  it('falls back to the default when storage itself throws (private browsing, quota)', async () => {
    const attr = await loadThemeBootstrap({
      getItem: () => {
        throw new Error('storage disabled');
      },
    });
    assert.equal(attr, 'B');
  });

  it('is a classic external script, loaded ahead of the stylesheet, so it blocks parsing until it runs', async () => {
    const html = await readFile(path.join(CLIENT, 'index.html'), 'utf8');
    const themeScript = html.match(/<script[^>]*src="\/theme\.js"[^>]*>/);
    assert.ok(themeScript, 'theme.js is loaded by a <script src="/theme.js"> tag');
    assert.doesNotMatch(themeScript![0], /type="module"/, 'a module script defers to after parsing — too late to avoid a flash of the unthemed document');
    assert.doesNotMatch(themeScript![0], /\b(defer|async)\b/, 'a deferred or async script is not guaranteed to run before first paint');
    const stylesheetIndex = html.indexOf('<link rel="stylesheet"');
    assert.ok(html.indexOf(themeScript![0]) < stylesheetIndex, 'theme.js is ordered ahead of the stylesheet link');
  });

  it('agrees with app.js on the storage key, the theme list and the default — the two copies this classic-script/module split forces', async () => {
    // theme.js can't be `import`ed by app.js (classic script vs. module), so the storage
    // key, theme list and default are hand-duplicated rather than shared — this is the
    // regression test for that duplication staying in sync, since nothing else does.
    const themeJs = await readFile(path.join(CLIENT, 'theme.js'), 'utf8');
    const appJs = await readFile(path.join(CLIENT, 'app.js'), 'utf8');

    const themeJsKey = themeJs.match(/var KEY = '([^']+)'/);
    const appJsKey = appJs.match(/const THEME_STORAGE_KEY = '([^']+)'/);
    assert.ok(themeJsKey && appJsKey, 'both files declare their storage key as expected');
    assert.equal(appJsKey![1], themeJsKey![1], 'app.js and theme.js use the same storage key');

    const themeJsList = themeJs.match(/var THEMES = (\[[^\]]+\])/);
    const appJsList = appJs.match(/const THEMES = (\[[^\]]+\])/);
    assert.ok(themeJsList && appJsList, 'both files declare a THEMES array as expected');
    assert.equal(appJsList![1], themeJsList![1], 'app.js and theme.js list the same themes in the same order');

    const themeJsDefault = themeJs.match(/var DEFAULT = '([^']+)'/);
    const appJsDefault = appJs.match(/select\.value = THEMES\.includes\(current\) \? current : '([^']+)'/);
    assert.ok(themeJsDefault && appJsDefault, 'both files fall back to a default theme as expected');
    assert.equal(appJsDefault![1], themeJsDefault![1], 'app.js\'s theme-select fallback matches theme.js\'s pre-paint default');
  });
});

describe('S18.1 — the four themes are one stylesheet, blocks selected by data-theme', () => {
  it('declares exactly four :root[data-theme] blocks, for A, B, C and D, and no bare :root', async () => {
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');
    assert.doesNotMatch(css, /:root\s*\{/, 'a bare :root would apply outside every theme selector — the drift this shape exists to forbid');
    for (const id of ['A', 'B', 'C', 'D']) {
      assert.match(css, new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`), `theme ${id} is declared`);
    }
    assert.equal([...css.matchAll(/:root\[data-theme="/g)].length, 4, 'exactly four theme blocks');
  });

  it('declares the same set of custom property names in every theme block, so no theme is missing a token another one has', async () => {
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');
    const blocks = [...css.matchAll(/:root\[data-theme="([A-Z])"\]\s*\{([\s\S]*?)\}/g)];
    assert.equal(blocks.length, 4);
    const namesByTheme = blocks.map((m) => [...m[2]!.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((p) => p[1]!).sort());
    for (let i = 1; i < namesByTheme.length; i++) {
      assert.deepEqual(namesByTheme[i], namesByTheme[0], `theme ${blocks[i]![1]} declares the same tokens as theme ${blocks[0]![1]}`);
    }
    assert.ok(namesByTheme[0]!.length >= 10, 'the block actually declares a non-trivial number of tokens');
  });

  it('gives the shared layout tokens — spacing, type sizes, line-height, border width, sidebar width — the same value in every theme block, not just the same name', async () => {
    // The previous test only compares property *names*; app.css's own comment claims the
    // four-block shape makes drift on these specific tokens "impossible to introduce by
    // accident" — that claim is only true if their values are actually checked, since they
    // carry no part of any theme's visual identity and have no reason to differ.
    const css = await readFile(path.join(CLIENT, 'app.css'), 'utf8');
    const blocks = [...css.matchAll(/:root\[data-theme="([A-Z])"\]\s*\{([\s\S]*?)\}/g)];
    assert.equal(blocks.length, 4);
    const SHARED = [
      '--space-0', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6',
      '--text-xs', '--text-sm', '--text-md', '--text-lg',
      '--border-width', '--sidebar-width', '--line-height',
    ];
    function valueOf(block: string, name: string): string {
      const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      assert.ok(match, `${name} is declared in the block`);
      return match![1]!.trim();
    }
    const valuesByTheme = blocks.map((m) => Object.fromEntries(SHARED.map((name) => [name, valueOf(m[2]!, name)])));
    for (let i = 1; i < valuesByTheme.length; i++) {
      assert.deepEqual(valuesByTheme[i], valuesByTheme[0], `theme ${blocks[i]![1]} gives the shared layout tokens the same values as theme ${blocks[0]![1]}`);
    }
  });

  it('carries no <style> and no inline style, and no CSS is generated in the client sources (already covered by S2.12, restated over the new files)', async () => {
    for (const { name, text: src } of await clientSources()) {
      if (!name.endsWith('.js')) continue;
      assert.doesNotMatch(src, /\.style\s*=/, `${name} sets an inline style property, generating style text at runtime`);
      assert.doesNotMatch(src, /<style/i, `${name} assembles a <style> block`);
    }
  });
});

describe('S18.2/S18.3 — switching issues no request, changes no markup, and never reaches the server', () => {
  it('changing the select sets the attribute and storage with zero fetch calls, and the DOM is untouched', async () => {
    const { byId, restore, fetchCalls, documentElement, storageMap } = await runConsole([]);
    try {
      const before = fetchCalls.length;
      const domBefore = JSON.stringify(byId.get('console'));
      const select = byId.get('theme-select')!;
      select.value = 'D';
      for (const fn of select.listeners.get('change') ?? []) fn({});

      assert.equal(documentElement.getAttribute('data-theme'), 'D');
      assert.equal(storageMap.get('skynet-hr-theme'), 'D');
      assert.equal(fetchCalls.length, before, 'switching issued no request');
      assert.equal(JSON.stringify(byId.get('console')), domBefore, 'switching changed no markup');
    } finally {
      await restore();
    }
  });

  it('the storage key never appears anywhere in the server sources', async () => {
    const roots = ['src', 'harness'];
    let found: string | null = null;
    for (const root of roots) {
      const base = path.join(process.cwd(), root);
      let entries: string[];
      try {
        entries = await readdir(base, { recursive: true });
      } catch {
        continue;
      }
      for (const rel of entries) {
        if (rel.startsWith(`client${path.sep}`) || rel.includes(`${path.sep}client${path.sep}`)) continue;
        const full = path.join(base, rel);
        let content: string;
        try {
          content = await readFile(full, 'utf8');
        } catch {
          continue; // a directory, or unreadable
        }
        if (content.includes('skynet-hr-theme')) {
          found = path.join(root, rel);
          break;
        }
      }
      if (found) break;
    }
    assert.equal(found, null, `the theme storage key must never reach the server, but was found in ${found}`);
  });
});

describe('S18.6 — the status badge is a projection over state, the live turn and outstanding permissions', () => {
  it('reads CLOCKED OUT for an ended session', async () => {
    const { byId, restore } = await runConsole([{ id: 's1', cwd: '/w', vendor: 'claude', state: 'ended' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      const badge = byId.get('status-badge')!;
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, 'CLOCKED OUT');
    } finally {
      await restore();
    }
  });

  it('drives one live session through IDLE, ON SHIFT, BLOCKED and back, reading the badge at each point', async () => {
    const { byId, streams, restore } = await runConsole([{ id: 's1', cwd: '/w', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      const badge = byId.get('status-badge')!;
      assert.equal(badge.textContent, 'IDLE', 'a live session with no turn and nothing outstanding is IDLE');

      deliver(streams[0]!, { seq: 1, sessionId: 's1', ts: 'x', kind: 'turn.started', data: { turnId: 't1' } });
      assert.equal(badge.textContent, 'ON SHIFT', 'a running turn is ON SHIFT');

      deliver(streams[0]!, {
        seq: 2, sessionId: 's1', ts: 'x', kind: 'permission.request',
        data: { turnId: 't1', requestId: 'r1', callId: 'c1', tool: 'bash', input: {}, suggestions: [] },
      });
      assert.equal(badge.textContent, 'BLOCKED', 'an unresolved permission.request is BLOCKED, even mid-turn');

      deliver(streams[0]!, {
        seq: 3, sessionId: 's1', ts: 'x', kind: 'permission.resolved',
        data: { requestId: 'r1', decision: 'allow', operator: 'ben', scope: 'once', reason: null },
      });
      assert.equal(badge.textContent, 'ON SHIFT', 'resolving the request returns to the turn already running');

      deliver(streams[0]!, { seq: 4, sessionId: 's1', ts: 'x', kind: 'turn.ended', data: { turnId: 't1', stopReason: 'completed', usage: null } });
      assert.equal(badge.textContent, 'IDLE', 'the turn ending with nothing outstanding returns to IDLE');

      deliver(streams[0]!, { seq: 5, sessionId: 's1', ts: 'x', kind: 'session.ended', data: { reason: 'operator', endedAt: 'x' } });
      assert.equal(badge.textContent, 'CLOCKED OUT', 'ending the session is CLOCKED OUT, from any prior state');
    } finally {
      await restore();
    }
  });

  it('hides the badge when no session is selected', async () => {
    const { byId, restore } = await runConsole([]);
    try {
      assert.equal(byId.get('status-badge')!.hidden, true);
    } finally {
      await restore();
    }
  });
});

describe('S18.8/S18.10 — PROBATION, Clone and the exit-interview transcript exist nowhere in the client', () => {
  it('no client source names PROBATION, Clone, or an exit interview', async () => {
    for (const { name, text: src } of await clientSources()) {
      assert.doesNotMatch(src, /PROBATION/, `${name} names PROBATION`);
      assert.doesNotMatch(src, /\bClone\b/, `${name} names a Clone action`);
      assert.doesNotMatch(src, /exit.interview/i, `${name} names an exit interview`);
    }
  });
});

describe('S18.9 — the termination screen is presentation over DELETE /api/sessions/:id and real session state', () => {
  it('renders the selected session\'s real id, owner, agent and folder as text, and offers Terminate', async () => {
    const { byId, restore } = await runConsole([
      { id: 's1', owner: 'ben', cwd: '/w/project', vendor: 'claude', model: 'sonnet', state: 'live' },
    ]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      for (const fn of byId.get('terminate-open')!.listeners.get('click') ?? []) fn({});

      assert.equal(byId.get('terminate')!.hidden, false);
      const rendered = allFakeText(byId.get('terminate-summary')!).join(' ');
      assert.ok(rendered.includes('s1'));
      assert.ok(rendered.includes('ben'));
      assert.ok(rendered.includes('/w/project'));
      assert.ok(rendered.includes('claude'));
      assert.equal(byId.get('terminate-confirm')!.hidden, false);
      assert.equal(byId.get('terminate-ended')!.hidden, true);
    } finally {
      await restore();
    }
  });

  it('confirming issues DELETE to the session\'s own route, then closes the panel and refreshes the list', async () => {
    const { byId, restore, fetchCalls, fetchMethods } = await runConsole([
      { id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'live' },
    ]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      for (const fn of byId.get('terminate-open')!.listeners.get('click') ?? []) fn({});
      const before = fetchCalls.filter((u) => u === '/api/sessions/s1').length;

      // `terminate-confirm`'s handler is wired `() => void confirmTerminate()` (fire-and-forget,
      // same as every other button in this client) — the listener itself returns nothing to
      // await, so the two ticks below are what let the underlying fetch actually resolve.
      for (const fn of byId.get('terminate-confirm')!.listeners.get('click') ?? []) fn({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const calls = fetchCalls
        .map((u, i) => ({ u, m: fetchMethods[i] }))
        .filter((c) => c.u === '/api/sessions/s1' && c.m === 'DELETE');
      assert.equal(calls.length, 1, 'exactly one DELETE to the session\'s own route');
      assert.ok(fetchCalls.filter((u) => u === '/api/sessions/s1').length > before, 'no accidental extra call to the same route');
      assert.equal(byId.get('terminate')!.hidden, true, 'the panel closes on success');
    } finally {
      await restore();
    }
  });

  it('an already-ended session offers no Terminate control and says why', async () => {
    const { byId, restore } = await runConsole([{ id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'ended' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      for (const fn of byId.get('terminate-open')!.listeners.get('click') ?? []) fn({});

      assert.equal(byId.get('terminate-confirm')!.hidden, true);
      assert.equal(byId.get('terminate-ended')!.hidden, false);
    } finally {
      await restore();
    }
  });
});

// ---------------------------------------------------------------------------
// #146 — Interrupt, End, and the elapsed-since-last-envelope indicator: the three
// operator controls the design promises against S5's already-tested server routes.
// ---------------------------------------------------------------------------

describe('#146 — interrupt, end and the hang indicator', () => {
  it('offers neither Interrupt nor the elapsed indicator while no turn is running, and offers End on a live session', async () => {
    const { byId, restore } = await runConsole([{ id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});

      assert.equal(byId.get('interrupt')!.hidden, true, 'nothing is running yet');
      assert.equal(byId.get('turn-elapsed')!.hidden, true, 'no envelope has arrived to measure silence from');
      assert.equal(byId.get('end-session')!.hidden, false, 'a live session can be ended');
    } finally {
      await restore();
    }
  });

  it('turn.started reveals Interrupt and the elapsed indicator; turn.ended withdraws both', async () => {
    const { byId, streams, restore } = await runConsole([{ id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});

      deliver(streams[0]!, { seq: 1, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'turn.started', data: { turnId: 't-1' } });
      assert.equal(byId.get('interrupt')!.hidden, false, 'a running turn offers Interrupt');
      assert.equal(byId.get('turn-elapsed')!.hidden, false, 'and the silence indicator');
      assert.match(byId.get('turn-elapsed')!.textContent ?? '', /no output for \d+ min/);

      deliver(streams[0]!, { seq: 2, sessionId: 's1', ts: '2026-08-09T00:00:01.000Z', kind: 'turn.ended', data: { turnId: 't-1' } });
      assert.equal(byId.get('interrupt')!.hidden, true, 'the turn ended — nothing left to interrupt');
      assert.equal(byId.get('turn-elapsed')!.hidden, true, 'and nothing left to measure silence on');
    } finally {
      await restore();
    }
  });

  it('Interrupt posts the running turn\'s id to the interrupt route', async () => {
    const { byId, streams, restore, fetchCalls, fetchMethods } = await runConsole([
      { id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'live' },
    ]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      deliver(streams[0]!, { seq: 1, sessionId: 's1', ts: '2026-08-09T00:00:00.000Z', kind: 'turn.started', data: { turnId: 't-1' } });

      for (const fn of byId.get('interrupt')!.listeners.get('click') ?? []) fn({});
      await new Promise((resolve) => setTimeout(resolve, 0));

      const call = fetchCalls
        .map((u, i) => ({ u, m: fetchMethods[i] }))
        .find((c) => c.u === '/api/sessions/s1/interrupt' && c.m === 'POST');
      assert.ok(call, 'exactly the interrupt route was posted to');
    } finally {
      await restore();
    }
  });

  it('End posts to the end route and refreshes the session list', async () => {
    const { byId, restore, fetchCalls, fetchMethods } = await runConsole([{ id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'live' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});
      const before = fetchCalls.filter((u) => u === '/api/sessions').length;

      for (const fn of byId.get('end-session')!.listeners.get('click') ?? []) fn({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const call = fetchCalls
        .map((u, i) => ({ u, m: fetchMethods[i] }))
        .find((c) => c.u === '/api/sessions/s1/end' && c.m === 'POST');
      assert.ok(call, 'the end route was posted to');
      assert.ok(fetchCalls.filter((u) => u === '/api/sessions').length > before, 'the session list is refreshed after ending');
    } finally {
      await restore();
    }
  });

  it('an already-ended session offers no End control', async () => {
    const { byId, restore } = await runConsole([{ id: 's1', owner: 'ben', cwd: '/w', vendor: 'claude', state: 'ended' }]);
    try {
      const button = byId.get('sessions')!.children[0]!.children[0]!;
      for (const fn of button.listeners.get('click') ?? []) fn({});

      assert.equal(byId.get('end-session')!.hidden, true);
    } finally {
      await restore();
    }
  });
});
