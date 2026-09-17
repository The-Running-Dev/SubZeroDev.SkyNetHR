import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSessionManager } from '../../session-manager/index.js';
import type { Checkpoints, Config, Records, Store } from '../../contract/index.js';
import type { ProcessLedger, ProcessRecord } from './ledger.js';

test('Phase 3 ledger — manager boot uses the injected ledger, preserves foreign records, and tombstones before rehydrating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase3-manager-ledger-'));
  const calls: unknown[] = [];
  const stale = { pid: 2147483647, pgid: null, sessionId: 'old', turnId: 'old',
    hostname: hostname(), startedAt: '1970-01-01T00:00:00.000Z', image: 'node',
    osCreatedAt: null, exitedAt: null } as ProcessRecord;
  const foreign = { ...stale, pid: 2147483646, hostname: `${hostname()}-foreign` };
  const ledger: ProcessLedger = {
    async readOpenPids() { calls.push('read'); return [foreign, stale]; },
    async appendPid() { assert.fail('boot must not append a spawn'); },
    async tombstonePid(pid, exitedAt) {
      calls.push(['tombstone', pid]);
      assert.ok(Number.isFinite(Date.parse(exitedAt)));
      return { ok: true, value: undefined };
    },
  };
  const store = {
    async claimLock() { calls.push('claim'); return { ok: true, value: undefined }; },
    async readAllMeta() { calls.push('rehydrate'); return []; },
    async readOpenPids() { assert.fail('the session store is not the injected ledger'); },
    async tombstonePid() { assert.fail('the session store is not the injected ledger'); },
  } as unknown as Store;
  const manager = createSessionManager({ config: { storageRoot: root } as Config, store,
    processLedger: ledger, checkpoints: {} as Checkpoints, records: {} as Records });
  try {
    assert.ok((await manager.boot()).ok);
    assert.deepEqual(calls, ['claim', 'read', ['tombstone', stale.pid], 'rehydrate']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
