import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFsProcessLedger } from './fs-ledger.js';
import type { ProcessRecord } from './ledger.js';
import type { IsoTimestamp, SessionId, TurnId } from '../contract/index.js';

const timestamp = '2026-09-17T00:00:00.000Z' as IsoTimestamp;
function record(pid: number): ProcessRecord {
  return { pid, pgid: null, sessionId: 'session' as SessionId, turnId: 'turn' as TurnId,
    hostname: 'host', startedAt: timestamp, image: 'node', osCreatedAt: timestamp, exitedAt: null };
}

test('Phase 3 ledger — unchanged spawn/tombstone bytes and latest-line-per-pid fold across reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase3-ledger-'));
  const ledger = createFsProcessLedger(root);
  try {
    assert.deepEqual(await ledger.readOpenPids(), []);
    const first = record(1), second = record(2), reused = { ...record(1), hostname: 'other-host' };
    assert.ok((await ledger.appendPid(first)).ok);
    assert.ok((await ledger.appendPid(second)).ok);
    assert.ok((await ledger.tombstonePid(1, timestamp)).ok);
    assert.deepEqual(await ledger.readOpenPids(), [second]);
    assert.ok((await ledger.appendPid(reused)).ok);
    const file = path.join(root, 'pids.ndjson');
    assert.equal(await readFile(file, 'utf8'), [first, second, { pid: 1, exitedAt: timestamp }, reused].map(value => JSON.stringify(value) + '\n').join(''));
    await ledger.close();
    await ledger.close();
    // Corrupt lines and missing ids are dropped; an absent exitedAt is never inferred live.
    await appendFile(file, '{}\nnull\n{"pid":3}\n{"pid":\n');
    const reopened = createFsProcessLedger(root);
    try { assert.deepEqual(await reopened.readOpenPids(), [reused, second]); }
    finally { await reopened.close(); }
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test('Phase 3 ledger — lazy handle retries failed opens, shares first appends and closes before cleanup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase3-ledger-'));
  const missing = path.join(root, 'missing');
  const ledger = createFsProcessLedger(missing);
  try {
    const failed = await ledger.appendPid(record(1));
    assert.equal(failed.ok, false);
    if (!failed.ok) { assert.equal(failed.error.code, 'io'); assert.equal(failed.error.path, path.join(missing, 'pids.ndjson')); }
    await mkdir(missing);
    assert.ok((await Promise.all([ledger.appendPid(record(1)), ledger.appendPid(record(2))])).every(result => result.ok));
    assert.deepEqual((await ledger.readOpenPids()).map(r => r.pid).sort(), [1, 2]);
    await ledger.close();
    await rm(missing, { recursive: true }); // Windows must not retain an open handle.
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});
