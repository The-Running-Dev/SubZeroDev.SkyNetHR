import { open, readFile, type FileHandle } from 'node:fs/promises';
import type { Result } from '../contract/index.js';
import type { ProcessLedgerIoError } from './ledger.js';

function ioError(filePath: string, detail: string): Result<never, ProcessLedgerIoError> {
  return { ok: false, error: { code: 'io', path: filePath, detail } };
}

// `10-design.md § Concurrency` rests audit.ndjson/pids.ndjson/reviews.ndjson/
// requisitions.ndjson's no-lock argument on each being opened once, as a single append
// stream owned by `store` — this is that stream: opened on first use and reused by every
// append after, rather than `appendLine`'s per-call open/close (#57). Concurrent first
// calls share one in-flight open via the cached promise, so only one handle is ever opened
// for a given path.
interface LazyHandle {
  get(): Promise<Result<FileHandle, ProcessLedgerIoError>>;
  // Closes the handle if one was ever opened; a no-op otherwise. Best-effort (D202): a
  // failure closing the underlying fd is not this method's to surface, and it never rejects.
  close(): Promise<void>;
}

export function lazyHandle(filePath: string): LazyHandle {
  let cached: Promise<Result<FileHandle, ProcessLedgerIoError>> | null = null;
  return {
    get(): Promise<Result<FileHandle, ProcessLedgerIoError>> {
      if (cached === null) {
        cached = open(filePath, 'a').then(
          (handle) => ({ ok: true, value: handle }) as const,
          (err: unknown) => {
            cached = null; // a failed open holds nothing worth caching; the next call may retry
            return ioError(filePath, (err as Error).message) as Result<FileHandle, ProcessLedgerIoError>;
          },
        );
      }
      return cached;
    },
    async close(): Promise<void> {
      // Cleared up front, synchronously, so a second `close()` — or a `get()` racing it — is
      // never handed the same in-flight close twice: idempotent by construction, not by
      // remembering that it already ran.
      const pending = cached;
      cached = null;
      if (pending === null) return;
      const result = await pending;
      if (!result.ok) return; // never opened; nothing to close
      try {
        await result.value.close();
      } catch (err) {
        console.warn(`[store] close: failed to close handle on ${filePath}: ${(err as Error).message}`);
      }
    },
  };
}

export async function appendToHandle(getHandle: () => Promise<Result<FileHandle, ProcessLedgerIoError>>, filePath: string, line: string, fsync: boolean): Promise<Result<void, ProcessLedgerIoError>> {
  const handleResult = await getHandle();
  if (!handleResult.ok) return handleResult;
  try {
    await handleResult.value.appendFile(line + '\n', 'utf8');
    if (fsync) await handleResult.value.sync();
    return { ok: true, value: undefined };
  } catch (err) {
    return ioError(filePath, (err as Error).message);
  }
}

export async function readAllLines(filePath: string): Promise<Result<readonly string[], ProcessLedgerIoError>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: [] };
    return ioError(filePath, (err as Error).message);
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  return { ok: true, value: lines };
}

// Reads a `{id-field}`-keyed append-only log where the latest line for an id wins,
// dropping an unparseable trailing line (a torn write) and any line missing the id
// field, as `20-contract.md § Persisted schemas` requires for `reviews.ndjson` and
// `requisitions.ndjson`. `reorderByLatestWrite` (only reviews needs it) returns the array
// ordered by each id's *winning* line rather than its first appearance: an id already seen
// is deleted before being re-set, which moves it to the end of Map iteration order — what
// D83 calls "the later line" for `records`' review-ordering tie-break (I35) to read off
// directly, with no second field or a second pass over the file. Requisitions and pids have
// no such reader and stay in first-appearance order, unaffected by this flag.
export async function foldLatestById<T>(filePath: string, idField: keyof T, reorderByLatestWrite: boolean): Promise<readonly T[]> {
  const linesResult = await readAllLines(filePath);
  if (!linesResult.ok) {
    // I38/S15.12: an unreadable file (not merely absent — `readAllLines` already turns
    // ENOENT into an empty read) yields an empty registry, but never silently: the operator
    // needs a way to discover the whole log went missing.
    const detail = linesResult.error.detail;
    console.warn(`[store] dropped ${filePath}: ${detail}`);
    return [];
  }
  const byId = new Map<string, T>();
  for (const line of linesResult.value) {
    try {
      const parsed = JSON.parse(line) as T;
      const id = parsed[idField];
      if (id === undefined || id === null) continue; // missing id field: cannot trust this line
      const key = String(id);
      if (reorderByLatestWrite) byId.delete(key);
      byId.set(key, parsed);
    } catch {
      // Dropped: either a torn trailing line, or (mid-file) corrupt input we cannot trust.
    }
  }
  return Array.from(byId.values());
}
