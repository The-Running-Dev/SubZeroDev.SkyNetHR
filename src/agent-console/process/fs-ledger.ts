import path from 'node:path';
import type { IsoTimestamp } from '../contract/index.js';
import type { ProcessLedger, ProcessRecord, ProcessTombstone } from './ledger.js';
import { lazyHandle, appendToHandle, foldLatestById } from './append-log.js';

// Same file, two line shapes, lazy append handle, and latest-line-per-pid fold.
// The host owns this resource's lifetime; supervision never closes session storage.
export function createFsProcessLedger(storageRoot: string): ProcessLedger & { close(): Promise<void> } {
  const pidsPath = path.join(storageRoot, 'pids.ndjson');
  const pidsHandle = lazyHandle(pidsPath);
  return {
    async appendPid(record: ProcessRecord) {
      return appendToHandle(pidsHandle.get, pidsPath, JSON.stringify(record), false);
    },

    async tombstonePid(pid: number, exitedAt: IsoTimestamp) {
      // D95: a tombstone is the second of the file's two line shapes, not a partial record.
      // The latest line for a pid decides liveness; the spawn line carries everything else.
      return appendToHandle(pidsHandle.get, pidsPath, JSON.stringify({ pid, exitedAt } satisfies ProcessTombstone), false);
    },

    async readOpenPids(): Promise<readonly ProcessRecord[]> {
      const all = await foldLatestById<ProcessRecord>(pidsPath, 'pid', false);
      return all.filter((r) => r.exitedAt === null);
    },

    close: pidsHandle.close,
  };
}
