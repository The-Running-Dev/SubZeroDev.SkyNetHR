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
