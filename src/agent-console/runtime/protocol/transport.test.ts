import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { RpcReader } from './reader.js';
import { RpcPeer, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from './peer.js';
import { LINE_BYTES, RpcWriter } from './writer.js';

test('Phase 4 framing — UTF-8 boundaries and terminal overflow without dispatching trailing requests', async () => {
  const lines: string[] = [], errors: string[] = [];
  const reader = new RpcReader(line => lines.push(line), reason => errors.push(reason), 10);
  for (const byte of Buffer.from('"😀"\n')) reader.push(Buffer.from([byte]));
  reader.push(Buffer.from('12345678901')); reader.push(Buffer.from('rest\n{}\n'));
  await Promise.resolve();
  assert.deepEqual(lines, ['"😀"']); assert.deepEqual(errors, ['line_too_large']);
  new RpcReader(() => assert.fail('invalid UTF-8 dispatched'), reason => errors.push(reason)).push(Buffer.from([255, 10]));
  assert.equal(errors.at(-1), 'invalid_utf8');
});

// Waits on the fault, not on a fixed sleep. Four hops separate the write from the assertion —
// the 8 MiB allocation and copy, the splitter's overflow microtask, the writer's `setImmediate`
// and the fault's own — and `node --test` runs files in parallel, so a loaded event loop pushes
// them past any constant: the observed flake was `JSON.parse('')` on a wire nothing had reached
// yet. The fault is the last hop, since `stop` is scheduled after the protocolError is written,
// so waiting on it also asserts the ordering this test is named for rather than assuming it.
// Bounded, because `node --test` applies no per-test timeout and an unbounded wait would hang
// the suite instead of failing it.
test('Phase 4 framing — actual 8 MiB cap emits protocolError before faulting', async () => {
  const input = new PassThrough(), output = new PassThrough(); let wire = '';
  output.on('data', chunk => { wire += String(chunk); });
  let faulted!: (reason: string) => void, gaveUp!: (error: Error) => void;
  const fault = new Promise<string>((resolve, reject) => { faulted = resolve; gaveUp = reject; });
  const timer = setTimeout(() => gaveUp(new Error(`timed out waiting for the link to fault; wire so far: ${JSON.stringify(wire)}`)), 10_000);
  new RpcPeer(input, output, async () => null, reason => faulted(reason));
  input.write(Buffer.alloc(LINE_BYTES + 1, 120));
  try { assert.equal(await fault, 'line_too_large'); } finally { clearTimeout(timer); }
  assert.equal(JSON.parse(wire).method, 'runtime.protocolError');
});

test('Phase 4 duplex — host replies are consumed while request handler awaits, with disjoint ids', async () => {
  const input = new PassThrough(), output = new PassThrough(); const lines: Record<string, unknown>[] = [];
  let peer: RpcPeer;
  peer = new RpcPeer(input, output, async () => peer.call('host.create.status', { createAttemptId: 'a' }).result, () => {});
  output.on('data', chunk => {
    const value = JSON.parse(String(chunk)) as Record<string, unknown>; lines.push(value);
    if (value.method) { assert.equal(value.id, 'r:1'); input.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { state: 'committed' } }) + '\n'); }
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"create"}\n');
  await delay(10); assert.deepEqual(lines.at(-1)?.result, { state: 'committed' }); peer.stop('test');
});

test('Phase 4 cancellation — cooperative signal does not suppress a completed operation', async () => {
  const input = new PassThrough(), output = new PassThrough(); let cancelled = false, wire = '';
  output.on('data', chunk => { wire += String(chunk); });
  let complete!: () => void; const gate = new Promise<void>(resolve => { complete = resolve; });
  const peer = new RpcPeer(input, output, async (_method, _params, signal) => { await gate; cancelled = signal.aborted; return 'committed'; }, () => {});
  input.write('{"jsonrpc":"2.0","id":1,"method":"create"}\n{"jsonrpc":"2.0","method":"$/cancel","params":{"id":1}}\n');
  complete(); await delay(10); assert.equal(cancelled, true); assert.equal(JSON.parse(wire).result, 'committed'); peer.stop('test');
});

test('Phase 4 writer — control priority and round-robin delivery across subscriptions', async () => {
  const output = new PassThrough(), lines: string[] = []; output.on('data', chunk => lines.push(String(chunk)));
  const writer = new RpcWriter(output, reason => assert.fail(reason));
  for (const id of ['a', 'b']) {
    let count = 0;
    writer.add(id, { next: () => ++count <= 2 ? writer.encode({ id, count }) : undefined });
  }
  writer.control({ response: true }); await delay(10);
  assert.deepEqual(lines.map(line => JSON.parse(line).id ?? 'control'), ['control', 'a', 'b', 'a', 'b']); writer.close();
});

test('Phase 4 writer — stalled global pipe faults the link instead of manufacturing gaps', async () => {
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const faults: string[] = []; const writer = new RpcWriter(output, reason => faults.push(reason), 1024, 2);
  writer.control({ first: true }); await delay(10);
  writer.control({ second: true }); writer.control({ third: true }); writer.control({ fourth: true });
  assert.deepEqual(faults, ['writer_budget_exhausted']); output.destroy();
});

test('Phase 4 heartbeat — peer silence faults on every OS; traffic resets the deadline', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  let finish!: (reason: string) => void; const fault = new Promise<string>(resolve => { finish = resolve; });
  assert.equal(HEARTBEAT_INTERVAL_MS, 10_000); assert.equal(HEARTBEAT_TIMEOUT_MS, 30_000);
  let now = 0, ended = false;
  const peer = new RpcPeer(input, output, async () => null, reason => { ended = true; finish(reason); }, { intervalMs: 10, timeoutMs: 60, now: () => now });
  now = 50; input.write('{"jsonrpc":"2.0","method":"runtime.heartbeat"}\n');
  now = 100; await delay(30); assert.equal(ended, false);
  now = 111;
  assert.equal(await Promise.race([fault, delay(1000).then(() => 'test_timeout')]), 'heartbeat_timeout'); peer.stop('test');
});
