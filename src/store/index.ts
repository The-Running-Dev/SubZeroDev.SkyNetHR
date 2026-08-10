import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type {
  AuditPage,
  AuditQuery,
  AuditRecord,
  CallId,
  Config,
  Envelope,
  IsoTimestamp,
  LoadedMeta,
  ProcessRecord,
  Requisition,
  Review,
  Seq,
  SessionId,
  SessionMetaFile,
  SessionRecord,
  Store,
  StoreError,
  TurnId,
  Result,
} from '../contract/index.js';

function ioError(filePath: string, detail: string): Result<never, StoreError> {
  return { ok: false, error: { code: 'io', path: filePath, detail } };
}

function notImplemented(filePath: string, ownedBySlice: string): Result<never, StoreError> {
  return {
    ok: false,
    error: { code: 'io', path: filePath, detail: `not implemented before ${ownedBySlice}` },
  };
}

function sessionDir(storageRoot: string, sessionId: SessionId): string {
  return path.join(storageRoot, 'sessions', sessionId);
}

function metaPath(storageRoot: string, sessionId: SessionId): string {
  return path.join(sessionDir(storageRoot, sessionId), 'meta.json');
}

function eventsPath(storageRoot: string, sessionId: SessionId): string {
  return path.join(sessionDir(storageRoot, sessionId), 'events.ndjson');
}

// Tool-output blob paths are built from a `turnId` the manager minted and a `callId`
// taken verbatim off the vendor's wire — the one store input an outside process
// authors. A single path segment (no separators, no `..`, no NUL) cannot escape the
// blob directory on either platform.
function isSafePathSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name === path.basename(name)
  );
}

// Temp-file-then-atomic-rename, in the same directory so the rename is on one volume.
async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, targetPath);
}

async function appendLine(filePath: string, line: string, fsync: boolean): Promise<Result<void, StoreError>> {
  try {
    if (fsync) {
      const handle = await open(filePath, 'a');
      try {
        await handle.appendFile(line + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      const handle = await open(filePath, 'a');
      try {
        await handle.appendFile(line + '\n', 'utf8');
      } finally {
        await handle.close();
      }
    }
    return { ok: true, value: undefined };
  } catch (err) {
    return ioError(filePath, (err as Error).message);
  }
}

async function readAllLines(filePath: string): Promise<Result<readonly string[], StoreError>> {
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
// `requisitions.ndjson`.
async function foldLatestById<T>(filePath: string, idField: keyof T): Promise<readonly T[]> {
  const linesResult = await readAllLines(filePath);
  if (!linesResult.ok) return [];
  const byId = new Map<string, T>();
  for (const line of linesResult.value) {
    try {
      const parsed = JSON.parse(line) as T;
      const id = String(parsed[idField]);
      byId.set(id, parsed);
    } catch {
      // Dropped: either a torn trailing line, or (mid-file) corrupt input we cannot trust.
    }
  }
  return Array.from(byId.values());
}

export async function createStore(config: Config): Promise<Result<Store, StoreError>> {
  const storageRoot = config.storageRoot;
  try {
    await mkdir(storageRoot, { recursive: true });
    await mkdir(path.join(storageRoot, 'sessions'), { recursive: true });
  } catch (err) {
    return ioError(storageRoot, (err as Error).message);
  }

  const ring = new Map<SessionId, Envelope[]>();

  const store: Store = {
    async createSession(record: SessionRecord) {
      const dir = sessionDir(storageRoot, record.id);
      try {
        await mkdir(dir, { recursive: true });
        await mkdir(path.join(dir, 'tool-output'), { recursive: true });
      } catch (err) {
        return ioError(dir, (err as Error).message);
      }
      const meta: SessionMetaFile = { schemaVersion: 1, session: record };
      try {
        await atomicWrite(metaPath(storageRoot, record.id), JSON.stringify(meta));
        await writeFile(eventsPath(storageRoot, record.id), '', { flag: 'a' });
      } catch (err) {
        return ioError(dir, (err as Error).message);
      }
      return { ok: true, value: undefined };
    },

    async writeMeta(record: SessionRecord) {
      const meta: SessionMetaFile = { schemaVersion: 1, session: record };
      try {
        await atomicWrite(metaPath(storageRoot, record.id), JSON.stringify(meta));
      } catch (err) {
        return ioError(metaPath(storageRoot, record.id), (err as Error).message);
      }
      return { ok: true, value: undefined };
    },

    async readAllMeta(): Promise<readonly LoadedMeta[]> {
      const sessionsDir = path.join(storageRoot, 'sessions');
      let entries: string[];
      try {
        entries = await readdir(sessionsDir);
      } catch {
        return [];
      }
      const results: LoadedMeta[] = [];
      for (const entry of entries) {
        const sessionId = entry as SessionId;
        const p = metaPath(storageRoot, sessionId);
        try {
          const raw = await readFile(p, 'utf8');
          const parsed = JSON.parse(raw) as SessionMetaFile;
          if (parsed.schemaVersion !== 1) {
            results.push({
              sessionId,
              result: { ok: false, error: { code: 'unsupported_schema_version', path: p, found: parsed.schemaVersion as number } },
            });
            continue;
          }
          results.push({ sessionId, result: { ok: true, value: parsed.session } });
        } catch (err) {
          results.push({ sessionId, result: { ok: false, error: { code: 'corrupt', path: p, detail: (err as Error).message } } } as LoadedMeta);
        }
      }
      return results;
    },

    async deleteSession(sessionId: SessionId) {
      try {
        await rm(sessionDir(storageRoot, sessionId), { recursive: true, force: true });
      } catch (err) {
        return ioError(sessionDir(storageRoot, sessionId), (err as Error).message);
      }
      return { ok: true, value: undefined };
    },

    async appendEvent(sessionId: SessionId, envelope: Envelope) {
      return appendLine(eventsPath(storageRoot, sessionId), JSON.stringify(envelope), false);
    },

    readEventsAfter(sessionId: SessionId, after: Seq | 0): AsyncIterable<Result<Envelope, StoreError>> {
      const filePath = eventsPath(storageRoot, sessionId);
      async function* generator(): AsyncGenerator<Result<Envelope, StoreError>> {
        let stream;
        try {
          stream = createReadStream(filePath, { encoding: 'utf8' });
        } catch (err) {
          yield ioError(filePath, (err as Error).message);
          return;
        }
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (line.length === 0) continue;
            let envelope: Envelope;
            try {
              envelope = JSON.parse(line) as Envelope;
            } catch {
              // A torn trailing line (or, mid-file, corruption): dropped, not surfaced
              // as fatal (S3.6). The session manager's replay watermark is what turns a
              // dropped *mid-file* line into a reported `replay_gap`; a dropped *trailing*
              // one has nothing after it to detect the gap against and stays silent here.
              console.warn(`[store] dropped an unparseable line in ${filePath}`);
              continue;
            }
            if (envelope.seq > after) yield { ok: true, value: envelope };
          }
        } catch (err) {
          yield ioError(filePath, (err as Error).message);
        }
      }
      return generator();
    },

    async readLastSeq(sessionId: SessionId) {
      const filePath = eventsPath(storageRoot, sessionId);
      const linesResult = await readAllLines(filePath);
      if (!linesResult.ok) return linesResult;
      for (let i = linesResult.value.length - 1; i >= 0; i--) {
        try {
          const envelope = JSON.parse(linesResult.value[i]!) as Envelope;
          return { ok: true, value: envelope.seq };
        } catch {
          continue; // torn trailing line; try the one before it
        }
      }
      return { ok: true, value: 0 };
    },

    pushRing(sessionId: SessionId, envelope: Envelope) {
      const capacity = config.caps.ringCapacity;
      if (capacity <= 0) return;
      let buf = ring.get(sessionId);
      if (!buf) {
        buf = [];
        ring.set(sessionId, buf);
      }
      buf.push(envelope);
      if (buf.length > capacity) buf.splice(0, buf.length - capacity);
    },

    readRingAfter(sessionId: SessionId, after: Seq | 0) {
      const buf = ring.get(sessionId);
      if (!buf || buf.length === 0) return after === 0 ? [] : null;
      const oldest = buf[0]!.seq;
      // `after === 0` asks for the whole history, which the ring can only answer once it
      // has trimmed nothing yet — i.e. it still holds seq 1. Folding that into the same
      // comparison as every other `after` (rather than special-casing 0 as always-servable)
      // is what makes a fresh page load against a long-running session fall through to the
      // spill instead of silently starting the transcript partway through.
      if (after < oldest - 1) return null; // cannot serve: gap before the ring's start
      return buf.filter((e) => e.seq > after);
    },

    dropRing(sessionId: SessionId) {
      ring.delete(sessionId);
    },

    async writeToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId, bytes: Buffer) {
      const dir = path.join(sessionDir(storageRoot, sessionId), 'tool-output', turnId);
      const filePath = path.join(dir, callId);
      if (!isSafePathSegment(turnId) || !isSafePathSegment(callId)) {
        return ioError(filePath, 'id is not a single path segment');
      }
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, bytes);
      } catch (err) {
        return ioError(filePath, (err as Error).message);
      }
      return { ok: true, value: undefined };
    },

    async openToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId) {
      const filePath = path.join(sessionDir(storageRoot, sessionId), 'tool-output', turnId, callId);
      // An id that is not a single path segment can only name something outside the
      // blob directory, and outside the blob directory nothing is found.
      if (!isSafePathSegment(turnId) || !isSafePathSegment(callId)) {
        return { ok: false, error: { code: 'not_found', path: filePath } };
      }
      // `createReadStream` alone never throws for a missing file — the open is lazy and
      // ENOENT arrives later as a stream 'error' event. Opening the handle first makes
      // `not_found` a real result instead of a dead branch.
      try {
        const handle = await open(filePath, 'r');
        return { ok: true, value: handle.createReadStream() };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: { code: 'not_found', path: filePath } };
        return ioError(filePath, (err as Error).message);
      }
    },

    async appendAudit(record: AuditRecord) {
      return appendLine(path.join(storageRoot, 'audit.ndjson'), JSON.stringify(record), true);
    },

    async readAuditPage(_query: AuditQuery): Promise<Result<AuditPage, StoreError>> {
      // Bounded, cursor-resumed, never-a-full-scan reads are S12's acceptance criteria
      // (S12.9, I39) and its route (`GET /api/audit`) does not exist before then. S1's
      // Touches names only `meta.json` and `events.ndjson`.
      return notImplemented(path.join(storageRoot, 'audit.ndjson'), 'S12');
    },

    async appendPid(record: ProcessRecord) {
      return appendLine(path.join(storageRoot, 'pids.ndjson'), JSON.stringify(record), false);
    },

    async tombstonePid(pid: number, exitedAt: IsoTimestamp) {
      // A tombstone is a second line for the same pid; the latest line wins on read.
      return appendLine(path.join(storageRoot, 'pids.ndjson'), JSON.stringify({ pid, exitedAt } satisfies Partial<ProcessRecord>), false);
    },

    async readOpenPids(): Promise<readonly ProcessRecord[]> {
      const all = await foldLatestById<ProcessRecord>(path.join(storageRoot, 'pids.ndjson'), 'pid');
      return all.filter((r) => r.exitedAt === null);
    },

    async appendReview(record: Review) {
      return appendLine(path.join(storageRoot, 'reviews.ndjson'), JSON.stringify(record), false);
    },

    async readAllReviews(): Promise<readonly Review[]> {
      return foldLatestById<Review>(path.join(storageRoot, 'reviews.ndjson'), 'reviewId');
    },

    async appendRequisition(record: Requisition) {
      return appendLine(path.join(storageRoot, 'requisitions.ndjson'), JSON.stringify(record), false);
    },

    async readAllRequisitions(): Promise<readonly Requisition[]> {
      return foldLatestById<Requisition>(path.join(storageRoot, 'requisitions.ndjson'), 'requisitionId');
    },
  };

  return { ok: true, value: store };
}
