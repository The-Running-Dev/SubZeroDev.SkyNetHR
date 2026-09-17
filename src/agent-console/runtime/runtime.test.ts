import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('Phase 4 first slice — every stdout line is JSON-RPC under a noisy provider', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/noisy-runtime.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  let stdout = '', stderr = '', sequence = 0;
  const messages: Record<string, unknown>[] = [];
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  child.stderr.on('data', data => { stderr += String(data); });
  child.stdout.on('data', data => {
    stdout += String(data);
    for (;;) {
      const lf = stdout.indexOf('\n'); if (lf < 0) break;
      const message = JSON.parse(stdout.slice(0, lf)) as Record<string, unknown>; stdout = stdout.slice(lf + 1);
      assert.equal(message.jsonrpc, '2.0'); messages.push(message);
      if (typeof message.id === 'number') { pending.get(message.id)?.(message); pending.delete(message.id); }
    }
  });
  const request = (method: string, params: unknown) => {
    const id = ++sequence;
    const response = new Promise<Record<string, unknown>>(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  };
  const hello = await request('runtime.hello', { version: '1.0.0', storage: { kind: 'memory', root }, workspaceRoots: [root] });
  assert.ok(hello.result);
  assert.ok((await request('providers.list', {})).result);
  const created = await request('sessions.create', { principal: 'a', provider: 'fixture', cwd: root });
  const { sessionId } = created.result as { sessionId: string };
  const subscribed = await request('events.subscribe', { principal: 'a', sessionId });
  const { subscriptionId } = subscribed.result as { subscriptionId: string };
  await request('events.credit', { principal: 'a', subscriptionId, count: 100 });
  const sent = await request('turns.send', { principal: 'a', sessionId, text: 'hello', model: 'test-model' });
  assert.ok(sent.result);
  const { turnId } = sent.result as { turnId: string };
  await request('turns.interrupt', { principal: 'a', sessionId, turnId });
  await request('sessions.end', { principal: 'a', sessionId });
  const ended = once(child, 'exit'); child.stdin.end(); await ended;
  assert.equal(stdout, '');
  assert.ok(messages.some(m => m.method === 'events.event'));
  const logs = stderr.trim().split('\n').map(line => JSON.parse(line) as { message: string });
  assert.ok(logs.some(log => log.message === 'send noise'));
  assert.ok(logs.some(log => log.message === 'provider module loaded'));
});

test('Phase 4 EOF — muted filesystem shutdown exits within five seconds and next boot closes the turn once', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-eof-'));
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => { for (const child of children) child.kill(); await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 20 }); });
  async function boot() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/noisy-runtime.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let buffer = '', id = 0; const pending = new Map<number, (value: any) => void>(); const messages: any[] = [];
    child.stderr!.resume();
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      for (;;) { const lf = buffer.indexOf('\n'); if (lf < 0) break; const value = JSON.parse(buffer.slice(0, lf)); buffer = buffer.slice(lf + 1); messages.push(value); if (typeof value.id === 'number') { pending.get(value.id)?.(value); pending.delete(value.id); } }
    });
    const request = (method: string, params: unknown) => { const requestId = ++id, result = new Promise<any>(resolve => pending.set(requestId, resolve)); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); return result; };
    assert.ok((await request('runtime.hello', { version: '1.0.0', storage: { kind: 'fs', root }, workspaceRoots: [root] })).result);
    const close = async () => { const exit = once(child, 'exit'), began = performance.now(); child.stdin!.end(); await exit; assert.ok(performance.now() - began < 5000); };
    return { request, close, messages };
  }
  const first = await boot(), sessionId = (await first.request('sessions.create', { principal: 'a', provider: 'fixture', cwd: root })).result.sessionId;
  const owner = { sessionId, principal: 'a' }, subscriptionId = (await first.request('events.subscribe', owner)).result.subscriptionId;
  await first.request('events.credit', { subscriptionId, principal: 'a', count: 100 });
  assert.ok((await first.request('turns.send', { ...owner, text: 'still running' })).result);
  await first.close();
  const persisted = (await readFile(path.join(root, 'sessions', sessionId, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(persisted.some(e => e.kind === 'turn.started'));
  assert.ok(persisted.every(e => e.kind !== 'turn.ended' && e.kind !== 'session.ended'));
  const second = await boot();
  assert.equal((await second.request('sessions.get', owner)).result.state, 'ended');
  const history = (await second.request('events.read', { ...owner, fromSeq: 0 })).result.events;
  assert.equal(history.filter((e: any) => e.kind === 'session.notice' && e.data.code === 'server_restart').length, 1);
  assert.equal(history.at(-1).data.stopReason, 'server_restart'); await second.close();
});
