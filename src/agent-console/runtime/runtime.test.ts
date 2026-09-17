import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
