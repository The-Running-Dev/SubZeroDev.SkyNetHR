import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createProviderRegistry } from './registry.js';
import { createRegisteredAdapter } from './legacy.js';
import { wrapAdapter } from './adapter-session.js';
import { defineCodexProvider } from './codex-cli/provider.js';
import { defineClaudeProvider } from './claude-cli/provider.js';
import { probeCommand } from './probe.js';
import type { Adapter, AdapterOptions, ProviderCapabilities, ProviderDefinition } from './types.js';

const capabilities: ProviderCapabilities = {
  workspace: 'required', permissions: 'interactive', attachments: { supported: true },
  usage: true, resume: true, streamingDeltas: true, needsProcess: true, conversationState: 'provider', models: 'free-form',
};
const cwd = process.cwd() as never;

test('Phase 2 — register a third provider and drive it through the host compatibility path without a dispatch switch', async () => {
  const registry = createProviderRegistry();
  assert.ok(registry.register(defineClaudeProvider()).ok);
  assert.ok(registry.register(defineCodexProvider()).ok);
  const events: unknown[] = [];
  let probed = 0;
  const third: ProviderDefinition = {
    id: 'third-fixture', label: 'Third fixture',
    async probe() { probed++; return { available: true, version: '1', capabilities }; },
    async create(context) {
      context.emit('session.notice', { level: 'info', code: 'compaction', text: 'fixture ready' });
      return { ok: true, value: {
        policy: { mode: 'interactive', sandbox: null, banner: null }, capabilities,
        startTurn(input, turn) {
          const started = Promise.resolve({ ok: true as const, value: undefined });
          const done = started.then(() => {
            turn.frame('message.delta', { role: 'assistant', text: input.text });
            turn.emit('message', { role: 'assistant', text: input.text, attachments: [] });
            turn.emit('turn.ended', { stopReason: 'completed', usage: null });
            return { stopReason: 'completed' as const, usage: null };
          });
          return { started, done, async interrupt() {}, respondToPermission: (_id, decision) => ({ ok: true, value: { reason: 'answered', decision } }) };
        },
        async close() {},
      } };
    },
  };
  assert.deepEqual(registry.register(third), { ok: true, value: undefined });
  assert.deepEqual(registry.register(third), { ok: false, error: { code: 'duplicate_provider', id: third.id } });
  assert.ok(registry.has(third.id));
  const statuses = await registry.list({ cwd });
  assert.deepEqual(statuses.find(p => p.id === third.id), { id: third.id, label: third.label, available: true, cliVersion: '1', capabilities });
  await registry.refresh({ cwd });
  assert.equal(probed, 2);
  const adapter = await createRegisteredAdapter(registry, third.id, { cwd, model: null, sandbox: null, streamDeltas: true, notify: n => events.push(n) });
  assert.ok(adapter.ok);
  assert.equal(adapter.value.acceptsAttachments, true);
  assert.ok((await adapter.value.send('hello', [], null, 'turn-1' as never)).ok);
  assert.equal(events.length, 4);
  const missing = await createRegisteredAdapter(registry, 'missing', { cwd, model: null, sandbox: null, streamDeltas: false, notify() {} });
  assert.deepEqual(missing, { ok: false, error: { code: 'unsupported_vendor', vendor: 'missing' } });
});

test('Phase 2 — turn handles preserve synchronous delivery outcomes, frame separation, model overrides and stale interrupts', async () => {
  let options!: AdapterOptions;
  let kills = 0;
  let sends = 0;
  let modelSeen: string | undefined;
  let failedWrite = false;
  const adapter: Adapter = {
    vendor: 'fixture', policy: { mode: 'interactive', sandbox: null, banner: null }, acceptsAttachments: true,
    async send(_text, _attachments, _resume, _turnId, model) { sends++; modelSeen = model; return { ok: true, value: undefined }; },
    respond: () => failedWrite ? { ok: false, error: { code: 'write_failed', detail: 'closed pipe' } } : { ok: true, value: undefined },
    async kill() { kills++; },
  };
  const session = await wrapAdapter(opts => { options = opts; return adapter; }, { cwd, notify() {}, emit() {} }, { model: 'default', sandbox: null, streamDeltas: true }, capabilities);
  assert.ok(session.ok);
  const emitted: string[] = [];
  const context = { turnId: 'turn-1' as never, emit: (kind: string) => { emitted.push(kind); }, frame: (kind: string) => { emitted.push(`frame:${kind}`); } };
  const first = session.value.startTurn({ text: 'one', attachments: [], resume: null, model: 'override' }, context);
  assert.ok((await first.started).ok);
  assert.equal(options.model, 'default');
  assert.equal(modelSeen, 'override');
  const answered = first.respondToPermission('request' as never, 'allow');
  assert.equal(answered instanceof Promise, false);
  assert.deepEqual(answered, { ok: true, value: { decision: 'allow', reason: 'answered' } });
  failedWrite = true;
  const cancelled = first.respondToPermission('request' as never, 'allow');
  assert.ok(cancelled.ok);
  assert.equal(cancelled.value.reason, 'cancelled_process_exit');
  options.notify({ kind: 'event', event: { kind: 'message.delta', data: { role: 'assistant', text: 'one' } } });
  options.notify({ kind: 'event', event: { kind: 'turn.ended', data: { stopReason: 'completed', usage: null } } });
  assert.deepEqual(await first.done, { stopReason: 'completed', usage: null });
  assert.deepEqual(emitted, ['frame:message.delta', 'turn.ended']);
  const second = session.value.startTurn({ text: 'two', attachments: [], resume: null }, { ...context, turnId: 'turn-2' as never });
  await first.interrupt();
  assert.equal(kills, 0);
  await second.interrupt();
  assert.equal(kills, 1);
  options.notify({ kind: 'event', event: { kind: 'turn.ended', data: { stopReason: 'interrupted', usage: null } } });
  const unsafe = session.value.startTurn({ text: 'bad', attachments: [], resume: null, model: 'x & whoami' }, context);
  assert.deepEqual(await unsafe.started, { ok: false, error: { code: 'invalid_model', model: 'x & whoami' } });
  assert.equal(sends, 2);
  await session.value.close();
  assert.deepEqual(await session.value.startTurn({ text: 'closed', attachments: [], resume: null }, context).started, { ok: false, error: { code: 'session_closed' } });
});

test('Phase 2 — concurrent Codex probes share one async result; refresh changes capabilities with the transport', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'probes');
  const mode = path.join(dir, 'mode');
  const cli = path.join(dir, 'cli.mjs');
  await writeFile(mode, 'app-server');
  await writeFile(cli, `import {appendFileSync,readFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},process.argv[2]+'\\n');\nsetTimeout(()=>process.exit(readFileSync(${JSON.stringify(mode)},'utf8') === process.argv[2] ? 0 : 1),80);\n`);
  const provider = defineCodexProvider(cli);
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 10);
  const statuses = await Promise.all([provider.probe({ cwd }), provider.probe({ cwd }), provider.probe({ cwd })]);
  clearTimeout(timer);
  assert.ok(timerFired, 'the event loop progresses while help runs');
  assert.equal(await readFile(log, 'utf8'), 'app-server\n');
  assert.ok(statuses.every(s => s.available && s.capabilities.usage && s.capabilities.streamingDeltas));
  assert.equal(statuses[0]!.capabilities.permissions, 'preauthorised');
  await writeFile(mode, 'exec');
  const fallback = await provider.probe({ cwd, refresh: true });
  assert.ok(fallback.available);
  assert.equal(fallback.capabilities.usage, false);
  assert.equal(fallback.capabilities.streamingDeltas, false);
  assert.equal(fallback.capabilities.attachments.supported, false);
  assert.equal(await readFile(log, 'utf8'), 'app-server\napp-server\nexec\n');
  await writeFile(mode, 'neither');
  assert.equal((await provider.probe({ cwd, refresh: true })).available, false);
  const before = await readFile(log, 'utf8');
  assert.equal((await provider.probe({ cwd })).available, false);
  assert.equal(await readFile(log, 'utf8'), before, 'negative results are cached too');
});

test('Phase 2 — a timed-out probe returns unavailable and leaves the event loop responsive', async () => {
  const result = await probeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), false, 60);
  assert.equal(result.ok, false);
});

function syncProbeImports(source: string): string[] {
  const found: string[] = [];
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'spawnSync') found.push('spawnSync');
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'spawnSync') found.push('spawnSync');
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
test('Phase 2 — production providers have no synchronous spawn probes; planted imports are detected', async () => {
  async function scan(dir: string): Promise<string[]> {
    const errors: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) errors.push(...await scan(file));
      else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) errors.push(...syncProbeImports(await readFile(file, 'utf8')));
    }
    return errors;
  }
  assert.deepEqual(await scan('src/agent-console/providers'), []);
  assert.equal(syncProbeImports("import { spawnSync as run } from 'node:child_process';").length, 1);
  assert.equal(syncProbeImports("import * as cp from 'node:child_process'; cp.spawnSync('x');").length, 1);
});
