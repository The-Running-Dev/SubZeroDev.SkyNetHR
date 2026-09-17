import type { IsoTimestamp, SessionId, TurnId, Result } from '../contract/index.js';

export interface ProcessRecord {
  readonly pid: number;
  readonly pgid: number | null; // null on Windows
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  // Load-bearing (D181): decides whether the reap guard runs at all. Always written as
  // `os.hostname()` at spawn; `null` only on a line written before this field existed,
  // which reads as this host's (S29.3) — a record naming a foreign host is neither
  // reaped nor tombstoned.
  readonly hostname: string | null;
  readonly startedAt: IsoTimestamp; // load-bearing: the pid-reuse guard reads it
  readonly image: string;
  // The OS's own reading of when this process was created, taken at spawn (D183, D186).
  // The reuse guard's fourth limb: exact equality against the live process's own reading,
  // never a tolerance window. `null` when the read failed at spawn (S29.7) or the guard's
  // live counterpart cannot be read at boot — either way the guard fails closed (I19).
  readonly osCreatedAt: IsoTimestamp | null;
  exitedAt: IsoTimestamp | null; // null while live; set by folding in the tombstone
}

// The exit line. `pids.ndjson` carries two line shapes and this is the second: a full
// `ProcessRecord` is written at spawn, and this narrower line at exit, because
// `tombstonePid` is given a pid and a timestamp and nothing else (D95).
//
// A reader folds the two shapes; it does not treat the latest line as a whole record.
// Liveness comes from the latest line for a `pid`; `hostname`, `startedAt`, `image`,
// `osCreatedAt`, `sessionId` and `turnId` come from that pid's most recent *spawn* line.
// The reuse guard reads `hostname`, `exitedAt`, `startedAt`, `image` and `osCreatedAt`
// (I19), and a reader that took them off the tombstone would find four of them missing
// and reap on a guard that never ran.
export interface ProcessTombstone {
  readonly pid: number;
  readonly exitedAt: IsoTimestamp;
}

export type ProcessLedgerIoError = { readonly code: 'io'; readonly path: string; readonly detail: string };

// Internal extraction seam. The host still supplies every fact and decides when to write.
export interface ProcessLedger<E = ProcessLedgerIoError> {
  appendPid(record: ProcessRecord): Promise<Result<void, E>>;
  tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, E>>;
  readOpenPids(): Promise<readonly ProcessRecord[]>;
}
