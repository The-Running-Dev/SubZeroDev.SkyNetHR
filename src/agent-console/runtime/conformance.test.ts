import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { runRuntime } from './server.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { defineClaudeProvider } from '../providers/claude-cli/provider.js';
import { defineCodexProvider } from '../providers/codex-cli/provider.js';
import { createHostAttempts } from '../core/create-attempts.js';
import type { Checkpoints } from '../core/types.js';
import type { ProviderDefinition, TurnContext, TurnInput } from '../providers/types.js';

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: any; error?: {code: number; data?: {code: string; detail?: string}} };
const ok = <T>(value: T) => ({ ok: true as const, value });
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
const hostMethods = ['host.create.prepare', 'host.create.commit', 'host.create.abort', 'host.create.status'];
const capabilities = { workspace: 'required', permissions: 'interactive', attachments: { supported: true }, usage: true, resume: false, streamingDeltas: true, needsProcess: false, conversationState: 'provider' } as const;
const schema = JSON.parse(await readFile('src/agent-console/protocol/schemas/wire.schema.json', 'utf8'));
const ajv = new Ajv2020({ strict: true }); addFormats.default(ajv); ajv.addSchema(schema);

async function fixture(t: TestContext, settings: { root?: string; rootAlias?: boolean; fs?: boolean; budget?: number; stdoutCap?: number; version?: string; expectHelloError?: string; sendError?: boolean; registry?: ProviderRegistry; host?: (message: Message) => Promise<unknown>; checkpoints?: Partial<Checkpoints>; start?: (input: TurnInput, turn: TurnContext) => Promise<void> } = {}) {
  const root = settings.root ?? await mkdtemp(path.join(os.tmpdir(), 'protocol-conformance-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd, { recursive: true });
  const workspaceRoot = settings.rootAlias ? path.join(root, 'workspace-alias') : cwd;
  if (settings.rootAlias) await symlink(cwd, workspaceRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const input = new PassThrough(), output = new PassThrough(), messages: Message[] = [], pending = new Map<number, (m: Message) => void>(), methods = new Map<number, string>();
  let sequence = 0, active: TurnContext | undefined, kills = 0;
  const registry = settings.registry ?? createProviderRegistry();
  const provider: ProviderDefinition = { id: 'fixture', label: 'Fixture', probe: async () => ({ available: true, capabilities }),
    async create() { return ok({ policy: { mode: 'interactive', sandbox: null, banner: null }, capabilities,
      startTurn(turnInput, turn) {
        active = turn; let ended = false; const done = gate<{stopReason: 'interrupted'; usage: null}>();
        return { started: (settings.start?.(turnInput, turn) ?? Promise.resolve()).then(() => settings.sendError ? { ok: false as const, error: { code: 'write_failed' as const, detail: 'fixture' } } : ok(undefined)), done: done.promise,
          respondToPermission: () => ok({ decision: 'deny', reason: 'cancelled_process_exit', cause: { code: 'no_child' } }),
          async interrupt() { if (ended) return; ended = true; kills++;
            // A failed start is paired by the core, not by the provider fixture.
            if (!settings.sendError) turn.emit('turn.ended', { stopReason: 'interrupted', usage: null });
            done.resolve({ stopReason: 'interrupted', usage: null }); } };
      }, close: async () => {} }); },
  };
  registry.register(provider);
  const checkpoints: Checkpoints = { init: async () => ok(undefined), destroy: async () => ok(undefined),
    commit: async () => ({ ok: false, error: { code: 'commit_failed', detail: 'fixture' } }), list: async () => ok([]),
    restore: async () => ({ ok: false, error: { code: 'no_such_checkpoint', sha: 'a'.repeat(40) as never } }), ...settings.checkpoints };
  const runtime = runRuntime(input, output, { registry, checkpoints });
  const close = async () => { runtime.close(); await runtime.closed; };
  t.after(async () => { await close(); if (!settings.root) await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }); });
  output.on('data', data => {
    const message = JSON.parse(String(data)) as Message; messages.push(message);
    const valid = ajv.getSchema(schema.$id)!; assert.ok(valid(message), JSON.stringify(valid.errors));
    if (typeof message.id === 'number' && 'result' in message) {
      const resultSchema = ajv.getSchema(schema.$id + '#/$defs/' + methods.get(message.id) + '.result');
      if (resultSchema) assert.ok(resultSchema(message.result), JSON.stringify(resultSchema.errors));
    }
    if (typeof message.id === 'number') { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (typeof message.id === 'string' && message.method) {
      void settings.host?.(message).then(result => input.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? null }) + '\n'), error => {
        input.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error), data: { code: 'host_failed' } } }) + '\n');
      });
    }
  });
  const request = (method: string, params: unknown = {}): Promise<Message> => {
    const id = ++sequence, result = new Promise<Message>(resolve => pending.set(id, resolve));
    methods.set(id, method);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return result;
  };
  const hello = await request('runtime.hello', { version: settings.version ?? '1.0.0', storage: { kind: settings.fs ? 'fs' : 'memory', root }, workspaceRoots: [workspaceRoot],
    hostMethods: settings.host ? hostMethods : [], options: { hostAttemptTimeoutMs: 200, providerStdoutLineBytes: settings.stdoutCap ?? 64 * 1024 * 1024, caps: { subscriberQueueHighWater: settings.budget ?? 256 } } });
  if (settings.expectHelloError) assert.equal(hello.error?.data?.code, settings.expectHelloError);
  else assert.ok(hello.result, JSON.stringify(hello));
  const create = () => request('sessions.create', { principal: 'alice', provider: 'fixture', cwd });
  return { root, cwd, request, create, close, messages, input, hello, active: () => active!, kills: () => kills };
}

test('Phase 4 hello resolves workspace aliases with the same normalization as session creation', async t => {
  const f = await fixture(t, { rootAlias: true });
  const made = await f.create();
  assert.ok(made.result, JSON.stringify(made));
  const outside = await f.request('sessions.create', { principal: 'alice', provider: 'fixture', cwd: f.root });
  assert.equal(outside.error?.data?.code, 'jail');
});

test('Phase 4 ownership, handles, chunking, extension append and privileged administration', async t => {
  const f = await fixture(t), made = await f.create(), sessionId = made.result.sessionId;
  const owner = { sessionId, principal: 'alice' };
  assert.equal((await f.request('sessions.get', { ...owner, principal: 'bob' })).error?.data?.code, 'not_found');
  assert.deepEqual((await f.request('sessions.list', { principal: 'bob' })).result.items, []);
  const begun = await f.request('attachments.begin', { ...owner, name: 'a.txt', size: 3 }), uploadId = begun.result.uploadId;
  assert.equal((await f.request('attachments.write', { uploadId, principal: 'bob', offset: 0, data: 'YWJj' })).error?.data?.code, 'not_found');
  assert.ok((await f.request('attachments.write', { uploadId, principal: 'alice', offset: 0, data: 'YWJj' })).result);
  const committed = await f.request('attachments.commit', { uploadId, principal: 'alice' }); assert.equal(committed.result.committedUploadId, uploadId);
  const appended = await f.request('events.append', { ...owner, kind: 'x-fixture.note', data: { answer: 42 } });
  assert.equal(appended.result.kind, 'x-fixture.note');
  const sent = await f.request('turns.send', { ...owner, text: 'hello', uploads: [uploadId] }), turnId = sent.result.turnId;
  const history = (await f.request('events.read', { ...owner, fromSeq: 0, limit: 100 })).result.events;
  const attachmentId = history.find((event: any) => event.kind === 'message').data.attachments[0].attachmentId;
  assert.equal((await f.request('attachments.read', { ...owner, turnId, attachmentId, offset: 1, length: 2 })).result.data, 'YmM=');
  assert.equal((await f.request('attachments.read', { ...owner, principal: 'bob', turnId, attachmentId, offset: 0, length: 2 })).error?.data?.code, 'not_found');
  assert.equal((await f.request('sessions.end', owner)).error?.data?.code, 'turn_in_flight');
  await f.request('turns.interrupt', { ...owner, turnId: 'stale' }); assert.equal(f.kills(), 0);
  await f.request('turns.interrupt', { ...owner, turnId }); assert.equal(f.kills(), 1);
  await f.request('sessions.end', owner); await f.request('sessions.end', owner);
  const ended = (await f.request('events.read', { ...owner, fromSeq: 0 })).result.events;
  assert.equal(ended.filter((event: any) => event.kind === 'session.ended').length, 1);
  assert.equal((await f.request('events.append', { ...owner, kind: 'x-fixture.note', data: {} })).error?.data?.code, 'session_ended');
  await f.request('admin.sessions.reassignPrincipal', { sessionId, principal: 'bob' });
  assert.equal((await f.request('sessions.get', owner)).error?.data?.code, 'not_found');
  assert.ok((await f.request('sessions.get', { sessionId, principal: 'bob' })).result);
  assert.equal((await f.request('admin.sessions.list')).result.items.length, 1);
  await f.request('admin.sessions.remove', { sessionId });
  assert.equal((await f.request('admin.sessions.snapshot', { sessionId })).error?.data?.code, 'not_found');
});

for (const transport of ['claude', 'codex-app', 'codex-exec'] as const) {
  for (const overflow of [false, true]) test(`Phase 4 adapter boundary — ${transport}, ${overflow ? 'stdout overflow' : 'normal mapping'}`, async t => {
    const saved = process.env.SKYNET_CODEX_NO_APP_SERVER;
    if (transport === 'codex-exec') process.env.SKYNET_CODEX_NO_APP_SERVER = '1'; else delete process.env.SKYNET_CODEX_NO_APP_SERVER;
    t.after(() => { if (saved === undefined) delete process.env.SKYNET_CODEX_NO_APP_SERVER; else process.env.SKYNET_CODEX_NO_APP_SERVER = saved; });
    const registry = createProviderRegistry();
    registry.register(transport === 'claude' ? defineClaudeProvider(path.resolve('src/agent-console/providers/claude-cli/fixtures/fake-claude-cli.mjs'))
      : defineCodexProvider(path.resolve('src/agent-console/providers/codex-cli/fixtures/fake-codex-cli.mjs')));
    const f = await fixture(t, { registry, stdoutCap: overflow ? 32 : 64 * 1024 * 1024 });
    const created = await f.request('sessions.create', { principal: 'alice', provider: transport === 'claude' ? 'claude' : 'codex', cwd: f.cwd, sandbox: transport === 'claude' ? null : 'workspace-write' });
    assert.ok(created.result, JSON.stringify(created));
    const owner = { sessionId: created.result.sessionId, principal: 'alice' }, subscriptionId = (await f.request('events.subscribe', owner)).result.subscriptionId;
    await f.request('events.credit', { subscriptionId, principal: 'alice', count: 1000 });
    const sent = f.request('turns.send', { ...owner, text: 'hello' });
    const answered = new Set<string>();
    const deadline = Date.now() + 8000;
    const events = () => f.messages.filter(m => m.method === 'events.event').map(m => m.params!.event as any);
    while (!events().some(e => e.kind === 'turn.ended')) {
      assert.ok(Date.now() < deadline, JSON.stringify(events()));
      for (const e of events().filter(e => e.kind === 'permission.request')) if (!answered.has(e.data.requestId)) {
        answered.add(e.data.requestId); await f.request('permissions.respond', { ...owner, requestId: e.data.requestId, decision: 'allow' });
      }
      await delay(10);
    }
    await sent;
    const output = events(), end = output.findIndex(e => e.kind === 'turn.ended');
    assert.ok(output.some(e => e.kind === 'turn.started'));
    if (overflow) {
      const error = output.findIndex(e => e.kind === 'error' && e.data.kind === 'adapter_output_overflow');
      assert.ok(error >= 0 && error < end); assert.equal(output[end].data.stopReason, 'error');
      assert.equal(output.filter(e => e.kind === 'turn.ended').length, 1);
    } else {
      assert.equal(output[end].data.stopReason, 'completed');
      assert.ok(output.some(e => e.kind === 'message' && e.data.role === 'assistant'));
      if (transport === 'claude') assert.equal(answered.size, 1);
      else assert.equal(answered.size, 0);
    }
  });
}

test('Phase 4 credits — one exhausted subscriber gaps once while a credited peer continues', async t => {
  const f = await fixture(t, { budget: 4 }), sessionId = (await f.create()).result.sessionId, owner = { sessionId, principal: 'alice' };
  const slow = (await f.request('events.subscribe', owner)).result.subscriptionId, fast = (await f.request('events.subscribe', owner)).result.subscriptionId;
  assert.equal((await f.request('events.credit', { subscriptionId: slow, principal: 'bob', count: 1 })).error?.data?.code, 'not_found');
  await f.request('events.credit', { subscriptionId: fast, principal: 'alice', count: 100 });
  for (let n = 0; n < 12; n++) await f.request('events.append', { ...owner, kind: 'x-fixture.tick', data: { n } });
  await delay(10);
  const forId = (id: string) => f.messages.filter(m => m.method === 'events.event' && m.params?.subscriptionId === id).map(m => m.params!.event as any);
  assert.equal(forId(slow).length, 1); assert.equal(forId(slow)[0].data.kind, 'replay_gap'); assert.equal(forId(slow)[0].seq, 0);
  assert.equal(forId(fast).length, 12); assert.ok(forId(fast).every(e => e.kind === 'x-fixture.tick'));
  await f.request('events.unsubscribe', { subscriptionId: slow, principal: 'alice' });
  const resumed = (await f.request('events.subscribe', { ...owner, fromSeq: 12 })).result.subscriptionId;
  await f.request('events.credit', { subscriptionId: resumed, principal: 'alice', count: 1 });
  await f.request('events.append', { ...owner, kind: 'x-fixture.tick', data: { n: 12 } }); await delay(10);
  assert.equal(forId(resumed)[0].seq, 13);
});

test('Phase 4 A19 — turn events may precede send response; cancellation never interrupts the turn', async t => {
  const started = gate<void>(), entered = gate<void>();
  const f = await fixture(t, { start: async (_input, turn) => { turn.emit('message', { role: 'assistant', text: 'early', attachments: [] }); entered.resolve(); await started.promise; } });
  const owner = { sessionId: (await f.create()).result.sessionId, principal: 'alice' };
  const subscriptionId = (await f.request('events.subscribe', owner)).result.subscriptionId;
  await f.request('events.credit', { subscriptionId, principal: 'alice', count: 100 });
  const sent = f.request('turns.send', { ...owner, text: 'hello' }); await entered.promise;
  await delay(10); assert.ok(f.messages.some(m => m.method === 'events.event' && (m.params?.event as any).kind === 'turn.started'));
  f.input.write('{"jsonrpc":"2.0","method":"$/cancel","params":{"id":5}}\n');
  started.resolve(); assert.ok((await sent).result); assert.equal(f.kills(), 0);
});

test('Phase 4 checkpoint restore keeps the existing send/end/remove/restore exclusion', async t => {
  const entered = gate<void>(), restored = gate<any>();
  const f = await fixture(t, { checkpoints: { restore: async () => { entered.resolve(); return restored.promise; } } });
  const owner = { sessionId: (await f.create()).result.sessionId, principal: 'alice' };
  const restore = f.request('checkpoints.restore', { ...owner, sha: 'a'.repeat(40) }); await entered.promise;
  for (const method of ['turns.send', 'sessions.end', 'sessions.remove', 'checkpoints.restore']) {
    const result = await f.request(method, { ...owner, text: 'hello', sha: 'a'.repeat(40) }); assert.equal(result.error?.data?.code, 'turn_in_flight');
  }
  restored.resolve({ ok: false, error: { code: 'restore_incomplete', detail: 'fixture' } }); await restore;
  assert.ok((await f.request('checkpoints.list', owner)).result);
});

for (const outcome of ['committing', 'committed', 'aborted'] as const) {
  test(`Phase 4 A5 — filesystem restart reconciles ${outcome} across the duplex boundary`, async t => {
    let state: string = 'committing', attemptId = '', aborts = 0;
    const host = async (m: Message) => {
      attemptId = String(m.params?.createAttemptId);
      if (m.method === 'host.create.prepare') return null;
      if (m.method === 'host.create.status') return { state };
      if (m.method === 'host.create.abort') { aborts++; return { state }; }
      throw new Error('lost commit response');
    };
    const first = await fixture(t, { fs: true, host });
    const created = await first.create(); assert.equal(created.error?.data?.code, 'create_outcome_unknown');
    await first.close(); state = outcome;
    const second = await fixture(t, { root: first.root, fs: true, host });
    const listed = await second.request('sessions.list', { principal: 'alice' });
    assert.equal(listed.result.items.length, outcome === 'committed' ? 1 : 0);
    const read = await second.request('sessions.get', { principal: 'alice', sessionId: attemptId });
    if (outcome === 'committed') assert.equal(read.result.state, 'ended');
    else assert.equal(read.error?.data?.code, 'not_found');
    if (outcome === 'committing') {
      assert.equal((await second.create()).error?.data?.code, 'workspace_busy');
      assert.equal((await second.request('sessions.remove', { sessionId: attemptId, principal: 'alice' })).error?.data?.code, 'turn_in_flight');
    } else if (outcome === 'aborted') {
      assert.equal((await second.request('admin.sessions.snapshot', { sessionId: attemptId })).error?.data?.code, 'not_found');
      assert.notEqual((await second.create()).error?.data?.code, 'workspace_busy');
    }
    assert.equal(aborts, outcome === 'aborted' ? 1 : 0);
    await second.close();
  });
}

test('Phase 4 A5 — late prepare sees abort; actual retry can spend the resource', async t => {
  const prepared = gate<void>(); let claims = 0, commits = 0, first = true;
  const helper = createHostAttempts({ prepare: async (_id, _principal, _input, signal) => {
    if (first) { first = false; await prepared.promise; }
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    claims++; return ok(undefined);
  }, commit: async () => { commits++; return ok(undefined); }, abort: () => {} });
  const f = await fixture(t, { host: async m => {
    const id = String(m.params?.createAttemptId) as never;
    if (m.method === 'host.create.prepare') { const r = await helper.prepare(id, 'alice', null); if (!r.ok) throw new Error('aborted'); return null; }
    if (m.method === 'host.create.commit') { const r = await helper.commit(id); if (!r.ok) throw new Error('aborted'); return null; }
    if (m.method === 'host.create.abort') return helper.abort(id);
    return { state: await helper.status(id) };
  } });
  const failed = await f.create(); assert.equal(failed.error?.data?.code, 'host_create');
  assert.ok(f.messages.some(m => m.method === '$/cancel' && typeof m.params?.id === 'string'));
  prepared.resolve(); await delay(10); assert.equal(claims, 0);
  assert.ok((await f.create()).result); assert.equal(claims, 1); assert.equal(commits, 1);
});

test('Phase 4 uploads — filesystem staging, incomplete commit refusal, abort, and bound bytes', async t => {
  const f = await fixture(t, { fs: true }), sessionId = (await f.create()).result.sessionId, owner = { sessionId, principal: 'alice' };
  const uploadId = (await f.request('attachments.begin', { ...owner, name: '../../display-name', size: 3 })).result.uploadId;
  const file = path.join(f.root, 'sessions', sessionId, 'uploads', uploadId);
  assert.equal((await readFile(file)).length, 0);
  assert.equal((await f.request('attachments.commit', { principal: 'alice', uploadId })).error?.data?.code, 'bad_request');
  await f.request('attachments.write', { principal: 'alice', uploadId, offset: 0, data: 'YWJj' });
  assert.equal(await readFile(file, 'utf8'), 'abc');
  await f.request('attachments.commit', { principal: 'alice', uploadId });
  assert.ok((await f.request('turns.send', { ...owner, text: 'bind', uploads: [uploadId] })).result);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('Phase 4 A5 — slow commit and a lost commit reply reconcile without abort', async t => {
  let commits = 0, aborts = 0, state = 'prepared';
  const accepted = gate<void>(), release = gate<void>();
  const f = await fixture(t, { host: async m => {
    if (m.method === 'host.create.prepare') return null;
    if (m.method === 'host.create.status') return { state };
    if (m.method === 'host.create.abort') { aborts++; return { state }; }
    commits++;
    if (commits === 1) { state = 'committing'; accepted.resolve(); await release.promise; state = 'committed'; throw new Error('reply lost after durable commit'); }
    await release.promise; state = 'committed'; return null;
  } });
  const creating = f.create(); await accepted.promise;
  assert.equal((await f.request('sessions.list', { principal: 'alice' })).result.items.length, 0);
  assert.equal((await f.create()).error?.data?.code, 'workspace_busy');
  // Wait for the bounded coordinator's retry, rather than racing a fixed fsync delay.
  const deadline = Date.now() + 3000; while (commits < 2) { assert.ok(Date.now() < deadline); await delay(5); }
  release.resolve(); assert.ok((await creating).result); assert.equal(aborts, 0);
});

test('Phase 4 permission response retains cancelled_process_exit resolution', async t => {
  const f = await fixture(t, { start: async (_input, turn) => { turn.emit('permission.request', { requestId: 'r' as never, callId: 'c' as never, tool: 'run', input: {}, matchTarget: null, suggestions: [] }); } });
  const owner = { sessionId: (await f.create()).result.sessionId, principal: 'alice' };
  await f.request('turns.send', { ...owner, text: 'permission' });
  const response = await f.request('permissions.respond', { ...owner, requestId: 'r', decision: 'allow' });
  assert.equal(response.result.resolution.reason, 'cancelled_process_exit');
});

test('Phase 4 versions and leases — same-major versions share one runtime lease, separate from server.lock', async t => {
  const first = await fixture(t, { fs: true }); await first.create();
  const legacy = path.join(first.root, 'server.lock'); await writeFile(legacy, 'legacy host lease sentinel');
  const second = await fixture(t, { fs: true, root: first.root, version: '1.9.0', expectHelloError: 'storage_locked' });
  const detail = JSON.parse(second.hello.error!.data!.detail!);
  assert.ok(detail.holder.instanceId); assert.ok(detail.age >= 0); await second.close();
  assert.equal(await readFile(legacy, 'utf8'), 'legacy host lease sentinel');
  await first.close();
  const third = await fixture(t, { fs: true, root: first.root, version: '1.9.0' });
  assert.equal((await third.request('sessions.list', { principal: 'alice' })).result.items.length, 1); await third.close();
  const incompatible = await fixture(t, { version: '2.0.0', expectHelloError: 'protocol_version_mismatch' }); await incompatible.close();
});

test('Phase 4 A5 — host abort racing an accepted commit waits for the terminal result', async t => {
  const accepted = gate<void>(), release = gate<void>(); let aborts = 0, id = '';
  const helper = createHostAttempts({ prepare: () => ok(undefined), commit: async () => { accepted.resolve(); await release.promise; return ok(undefined); }, abort: () => { aborts++; } });
  const f = await fixture(t, { host: async m => {
    id = String(m.params?.createAttemptId); const key = id as never;
    if (m.method === 'host.create.prepare') { await helper.prepare(key, 'alice', null); return null; }
    if (m.method === 'host.create.commit') { await helper.commit(key); return null; }
    if (m.method === 'host.create.abort') { await helper.abort(key); return { state: await helper.status(key) }; }
    return { state: await helper.status(key) };
  } });
  const creating = f.create(); await accepted.promise;
  let aborted = false; const abort = helper.abort(id as never).then(() => { aborted = true; });
  await f.request('sessions.list', { principal: 'alice' }); assert.equal(aborted, false); assert.equal(aborts, 0);
  release.resolve(); assert.ok((await creating).result); await abort; assert.equal(aborts, 0); assert.equal(await helper.status(id as never), 'committed');
});

test('Phase 4 A19 — a failed send retains its already-started turn and paired end in history', async t => {
  const f = await fixture(t, { sendError: true }), owner = { sessionId: (await f.create()).result.sessionId, principal: 'alice' };
  assert.equal((await f.request('turns.send', { ...owner, text: 'fail after start' })).error?.data?.code, 'adapter');
  const history = (await f.request('events.read', { ...owner, fromSeq: 0 })).result.events;
  assert.equal(history.filter((e: any) => e.kind === 'turn.started').length, 1);
  assert.equal(history.filter((e: any) => e.kind === 'turn.ended').length, 1);
  assert.equal(history.at(-1).data.stopReason, 'error');
});

test('Phase 4 A5 — runtime loss after prepare recovers only after host abort, then a real retry succeeds', async t => {
  const entered = gate<void>(), release = gate<void>(); let id = '', held: string | null = null;
  const helper = createHostAttempts({ prepare: key => { if (held) return { ok: false, error: 'claimed' }; held = key; return ok(undefined); }, commit: async () => ok(undefined), abort: key => { if (held === key) held = null; } });
  const host = async (m: Message) => {
    id = String(m.params?.createAttemptId); const key = id as never;
    if (m.method === 'host.create.prepare') { const r = await helper.prepare(key, 'alice', null); if (!r.ok) throw new Error('claimed'); return null; }
    if (m.method === 'host.create.commit') { await helper.commit(key); return null; }
    if (m.method === 'host.create.abort') await helper.abort(key);
    return { state: await helper.status(key) };
  };
  const registry = createProviderRegistry(); registry.register({ id: 'blocked', label: 'Blocked create', probe: async () => ({ available: true, capabilities }),
    create: async () => { entered.resolve(); await release.promise; return { ok: false, error: { code: 'agent_unavailable', image: 'fixture', detail: 'stopped during create' } }; } });
  const first = await fixture(t, { fs: true, host, registry });
  void first.request('sessions.create', { principal: 'alice', provider: 'blocked', cwd: first.cwd });
  await entered.promise; const attempt = id; assert.equal(await helper.status(attempt as never), 'prepared'); await first.close();
  // Recovery belongs to the host: prepared can safely abort; committing cannot.
  await helper.abort(attempt as never); release.resolve();
  const second = await fixture(t, { fs: true, root: first.root, host });
  assert.deepEqual((await second.request('sessions.list', { principal: 'alice' })).result.items, []);
  assert.ok((await second.create()).result); await second.close();
});
