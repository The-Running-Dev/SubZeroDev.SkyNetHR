import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type {
  AttachmentId,
  AuditCursor,
  AuditPage,
  AuditQuery,
  AuditRecord,
  CallId,
  Config,
  Envelope,
  IsoTimestamp,
  LivenessProbe,
  LoadedMeta,
  ProcessRecord,
  ProcessTombstone,
  Requisition,
  Review,
  Seq,
  ServerLock,
  SessionId,
  SessionMetaFile,
  SessionRecord,
  StartupError,
  Store,
  StoreError,
  TurnId,
  Result,
} from '../contract/index.js';

function ioError(filePath: string, detail: string): Result<never, StoreError> {
  return { ok: false, error: { code: 'io', path: filePath, detail } };
}

function startupIoError(filePath: string, detail: string): Result<never, StartupError> {
  return { ok: false, error: { code: 'storage_unwritable', path: filePath, detail } };
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

function lockPath(storageRoot: string): string {
  return path.join(storageRoot, 'server.lock');
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

// (D162, S23) The tally is never held in memory — it is recomputed from the directory on
// every write, which is what makes it survive a restart with no rehydration step and rules
// out a second counter that could disagree with the directory it is meant to describe.
async function toolOutputBytesUsed(storageRoot: string, sessionId: SessionId): Promise<number> {
  const dir = path.join(sessionDir(storageRoot, sessionId), 'tool-output');
  let turnDirs: string[];
  try {
    turnDirs = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const turnDir of turnDirs) {
    let callFiles: string[];
    try {
      callFiles = await readdir(path.join(dir, turnDir));
    } catch {
      continue;
    }
    for (const callFile of callFiles) {
      try {
        total += (await stat(path.join(dir, turnDir, callFile))).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

// Temp-file-then-atomic-rename, in the same directory so the rename is on one volume.
async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, targetPath);
}

// A plain read-then-write against `targetPath` leaves a window between the read and the
// write where a second caller can make the same "absent" observation and also write —
// `rename` above overwrites unconditionally, so it cannot detect that. `link` closes the
// window: writing the full contents to a private temp file first means only a complete
// write is ever visible under `targetPath`, and `link` is an atomic, exclusive create that
// fails with `EEXIST` (never touching the target's content) when something already claimed
// it first. Returns `'claimed'` or `'exists'`; anything else throws.
async function tryClaimExclusive(targetPath: string, contents: string): Promise<'claimed' | 'exists'> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, contents, 'utf8');
  try {
    await link(tmpPath, targetPath);
    return 'claimed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw err;
  } finally {
    await rm(tmpPath, { force: true });
  }
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

// Open-write-fsync-close-in-`finally`, the same durability discipline `appendLine`'s
// `fsync: true` branch uses for an append — shared here because `writeAttachment` needs it
// twice (the blob, then its `.meta` sidecar) for an overwrite rather than an append.
async function writeSyncedFile(filePath: string, data: Buffer | string, encoding?: BufferEncoding): Promise<void> {
  const handle = await open(filePath, 'w');
  try {
    await handle.writeFile(data, encoding);
    await handle.sync();
  } finally {
    await handle.close();
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
// `requisitions.ndjson`. `reorderByLatestWrite` (only reviews needs it) returns the array
// ordered by each id's *winning* line rather than its first appearance: an id already seen
// is deleted before being re-set, which moves it to the end of Map iteration order — what
// D83 calls "the later line" for `records`' review-ordering tie-break (I35) to read off
// directly, with no second field or a second pass over the file. Requisitions and pids have
// no such reader and stay in first-appearance order, unaffected by this flag.
async function foldLatestById<T>(filePath: string, idField: keyof T, reorderByLatestWrite: boolean): Promise<readonly T[]> {
  const linesResult = await readAllLines(filePath);
  if (!linesResult.ok) {
    // I38/S15.12: an unreadable file (not merely absent — `readAllLines` already turns
    // ENOENT into an empty read) yields an empty registry, but never silently: the operator
    // needs a way to discover the whole log went missing.
    const detail = 'detail' in linesResult.error ? linesResult.error.detail : linesResult.error.code;
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

// D86: `AuditCursor` is opaque and server-minted. It encodes a byte offset into
// `audit.ndjson` — where the next page resumes reading backward from — but no caller may
// construct or decode one, so it carries an HMAC over that offset, keyed on a secret this
// store mints once at boot and never persists. A cursor from a different process boot, or
// one a caller has altered, fails the check and is reported `corrupt` (S12.5).
function encodeAuditCursor(offset: number, secret: Buffer): AuditCursor {
  const payload = String(offset);
  const mac = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}.${mac}`, 'utf8').toString('base64url') as AuditCursor;
}

// Constant-time in the same shape as `edge/http-common`'s `constantTimeEquals` — that
// module compares a caller-supplied secret and this one a caller-supplied MAC, and `store`
// cannot import from `edge/http-common` (nor the reverse: neither is the other's dependency
// per `10-design.md § Module boundaries`), so the technique is kept identical by hand rather
// than shared. Keep both in sync if either changes.
function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const same = left.length === right.length;
  return timingSafeEqual(left, same ? right : left) && same;
}

function decodeAuditCursor(cursor: AuditCursor, secret: Buffer): number | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expectedMac = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  if (!macEquals(mac, expectedMac)) return null;
  if (!/^\d+$/.test(payload)) return null;
  const offset = Number(payload);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return offset;
}

function auditRecordMatches(record: AuditRecord, query: AuditQuery): boolean {
  if (query.sessionId !== null && record.sessionId !== query.sessionId) return false;
  if (query.operator !== null && record.operator !== query.operator) return false;
  if (query.since !== null && record.ts < query.since) return false;
  if (query.until !== null && record.ts > query.until) return false;
  if (query.incidentsOnly) {
    const isIncident = record.decision === 'deny' || record.operator === null || record.scope === 'standing';
    if (!isIncident) return false;
  }
  return true;
}

// Bounded, cursor-resumed, never-a-whole-file read (S12.9, I39). `audit.ndjson` is
// append-only and every line ends `\n` (`appendLine` always adds it), so any offset this
// function has itself handed out as a cursor is guaranteed to land on a line boundary —
// which is what lets it read backward in fixed-size chunks from that offset instead of
// scanning from the start of the file on every page.
const AUDIT_READ_CHUNK_BYTES = 64 * 1024;

async function readAuditPageImpl(
  filePath: string,
  query: AuditQuery,
  auditPageMax: number,
  cursorSecret: Buffer,
): Promise<Result<AuditPage, StoreError>> {
  const requested = Number.isFinite(query.limit) && query.limit > 0 ? Math.floor(query.limit) : auditPageMax;
  const limit = Math.min(requested, auditPageMax);
  // I39 bounds the *read*, not merely the result: `Caps.auditPageMax` caps how many
  // records one call may examine, exactly as it caps how many it may return. Without this
  // a filtered query — `incidentsOnly`, a `sessionId`, a `since` — that matches fewer than
  // `limit` records walks back to byte 0, which is the whole-file scan D73 exists to
  // prevent and which grows with the deployment's lifetime rather than with the answer.
  // Hitting the budget is not the end of the log: the page comes back short with a
  // non-null `nextCursor`, and the caller pages on until that cursor is null.
  const scanBudget = auditPageMax;
  let examined = 0;

  // A missing file is an empty file for cursor-validation purposes — an altered cursor
  // must be refused the same way regardless of whether `audit.ndjson` happens to exist
  // yet, so this does not return before `decodeAuditCursor` runs (S12.5).
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return ioError(filePath, (err as Error).message);
    handle = null;
  }

  try {
    const fileSize = handle === null ? 0 : (await handle.stat()).size;

    let upperBound: number; // exclusive — bytes at [0, upperBound) remain unread
    if (query.before === null) {
      upperBound = fileSize;
    } else {
      const decoded = decodeAuditCursor(query.before, cursorSecret);
      if (decoded === null || decoded > fileSize) {
        return { ok: false, error: { code: 'corrupt', path: filePath, detail: 'invalid audit cursor' } };
      }
      upperBound = decoded;
    }

    if (handle === null || upperBound === 0) return { ok: true, value: { records: [], nextCursor: null } };

    const records: AuditRecord[] = [];
    let nextCursor: AuditCursor | null = null;
    let tailFragment: Buffer = Buffer.alloc(0); // an incomplete line, held until its start is read
    let cursor = upperBound;
    let stopped = false;

    while (cursor > 0 && !stopped) {
      const readLen = Math.min(AUDIT_READ_CHUNK_BYTES, cursor);
      const readStart = cursor - readLen;
      const raw = Buffer.alloc(readLen);
      const { bytesRead } = await handle.read(raw, 0, readLen, readStart);
      if (bytesRead !== readLen) {
        return ioError(filePath, `short read at offset ${readStart}: expected ${readLen} bytes, got ${bytesRead}`);
      }
      const buf = tailFragment.length > 0 ? Buffer.concat([raw, tailFragment]) : raw;
      tailFragment = Buffer.alloc(0);
      const isFileStart = readStart === 0;

      // Newline offsets within `buf`, ascending. `buf`'s own tail is a real line
      // boundary only when nothing has been carried forward yet — the first read of a
      // page always starts at a self-minted or file-length offset, both of which are
      // guaranteed to sit immediately after a `\n` (`AUDIT_READ_CHUNK_BYTES`'s comment).
      // Once a fragment is being carried, `buf`'s tail is just wherever the previous
      // chunk happened to be cut, so a trailing newline is checked for rather than
      // assumed, which is what keeps this correct on every later chunk of a deep page.
      const newlineIdx: number[] = [];
      {
        let searchFrom = 0;
        for (;;) {
          const nl = buf.indexOf(0x0a, searchFrom);
          if (nl === -1) break;
          newlineIdx.push(nl);
          searchFrom = nl + 1;
        }
      }
      const hasTrailingNewline = newlineIdx.length > 0 && newlineIdx[newlineIdx.length - 1] === buf.length - 1;
      const lineStarts: number[] = [0, ...newlineIdx.map((nl) => nl + 1).filter((s) => s < buf.length)];

      for (let i = lineStarts.length - 1; i >= 0; i--) {
        const start = lineStarts[i]!;
        if (i === 0 && !isFileStart) {
          const fragmentEnd = lineStarts.length > 1 ? lineStarts[1]! - 1 : buf.length;
          tailFragment = Buffer.from(buf.subarray(0, fragmentEnd));
          break;
        }
        const end = i + 1 < lineStarts.length ? lineStarts[i + 1]! - 1 : hasTrailingNewline ? buf.length - 1 : buf.length;
        if (end <= start) continue; // an empty line — nothing to parse
        const absoluteStart = readStart + start;
        const lineBuf = buf.subarray(start, end);
        let record: AuditRecord | null = null;
        try {
          record = JSON.parse(lineBuf.toString('utf8')) as AuditRecord;
        } catch {
          record = null; // a torn or corrupt line, dropped rather than surfaced as fatal
        }
        examined += 1;
        if (record !== null && auditRecordMatches(record, query)) {
          records.push(record);
          if (records.length >= limit) {
            nextCursor = absoluteStart === 0 ? null : encodeAuditCursor(absoluteStart, cursorSecret);
            stopped = true;
            break;
          }
        }
        // The scan budget stops the read at the same kind of boundary a full page does:
        // `absoluteStart` is where the next page resumes, and the line it names has already
        // been examined and rejected, so excluding it loses nothing.
        if (examined >= scanBudget) {
          nextCursor = absoluteStart === 0 ? null : encodeAuditCursor(absoluteStart, cursorSecret);
          stopped = true;
          break;
        }
      }

      if (!stopped) {
        if (isFileStart) break;
        cursor = readStart;
      }
    }

    return { ok: true, value: { records, nextCursor } };
  } finally {
    if (handle !== null) await handle.close();
  }
}

// Backward-chunked scan to find the byte offset where a replay should resume — S24.1
// (D163). `events.ndjson` is append-only NDJSON (`appendLine` always terminates a line
// with `\n`), so any newline this finds is a real line boundary. Reading backward in
// fixed-size chunks from the tail, parsing lines newest-first and stopping the moment a
// `seq <= after` line is found, keeps the cost proportional to how far `after` sits from
// the file's end (S24.2) rather than a scan from byte 0. The structure mirrors
// `readAuditPageImpl`'s backward chunk walk above, adapted from cursor-paging to
// locating one offset.
const EVENTS_READ_CHUNK_BYTES = 64 * 1024;

async function locateForwardStart(filePath: string, after: Seq | 0): Promise<number> {
  if (after === 0) return 0; // S24.3: a whole-session replay is still a full forward scan
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return 0; // missing/unreadable file: the forward stream reports the real error
  }
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize === 0) return 0;
    let tailFragment: Buffer = Buffer.alloc(0);
    let cursor = fileSize;
    while (cursor > 0) {
      const readLen = Math.min(EVENTS_READ_CHUNK_BYTES, cursor);
      const readStart = cursor - readLen;
      const raw = Buffer.alloc(readLen);
      const { bytesRead } = await handle.read(raw, 0, readLen, readStart);
      if (bytesRead !== readLen) return 0; // short read: fall back to a full forward scan
      const buf = tailFragment.length > 0 ? Buffer.concat([raw, tailFragment]) : raw;
      tailFragment = Buffer.alloc(0);
      const isFileStart = readStart === 0;

      const newlineIdx: number[] = [];
      for (let searchFrom = 0; ; ) {
        const nl = buf.indexOf(0x0a, searchFrom);
        if (nl === -1) break;
        newlineIdx.push(nl);
        searchFrom = nl + 1;
      }
      const hasTrailingNewline = newlineIdx.length > 0 && newlineIdx[newlineIdx.length - 1] === buf.length - 1;
      const lineStarts: number[] = [0, ...newlineIdx.map((nl) => nl + 1).filter((s) => s < buf.length)];

      for (let i = lineStarts.length - 1; i >= 0; i--) {
        const start = lineStarts[i]!;
        if (i === 0 && !isFileStart) {
          // This buffer's leading bytes are a line whose true start lies in the chunk
          // before this one (in file order) — carry it forward to prepend once that
          // earlier chunk is read, exactly as `readAuditPageImpl` does.
          const fragmentEnd = lineStarts.length > 1 ? lineStarts[1]! - 1 : buf.length;
          tailFragment = Buffer.from(buf.subarray(0, fragmentEnd));
          break;
        }
        const end = i + 1 < lineStarts.length ? lineStarts[i + 1]! - 1 : hasTrailingNewline ? buf.length - 1 : buf.length;
        if (end <= start) continue; // an empty line
        const nextLineStart = readStart + (i + 1 < lineStarts.length ? lineStarts[i + 1]! : buf.length);
        try {
          const envelope = JSON.parse(buf.subarray(start, end).toString('utf8')) as Envelope;
          if (envelope.seq <= after) return nextLineStart;
        } catch {
          // A torn trailing line, or mid-file corruption: not a match, keep scanning
          // backward — the forward pass drops it the same way it always has (S24.4).
        }
      }
      if (isFileStart) return 0;
      cursor = readStart;
    }
    return 0;
  } finally {
    await handle.close();
  }
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
  const auditCursorSecret = randomBytes(32);

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
      const dir = sessionDir(storageRoot, sessionId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        // `fs.rm` stops at the first entry it cannot remove and leaves the rest of the
        // subtree behind; `.path` on the thrown error names that entry, which is more
        // useful to an operator than the session directory it sits under (S5.11).
        const nodeErr = err as NodeJS.ErrnoException;
        return ioError(nodeErr.path ?? dir, nodeErr.message);
      }
      return { ok: true, value: undefined };
    },

    async appendEvent(sessionId: SessionId, envelope: Envelope) {
      return appendLine(eventsPath(storageRoot, sessionId), JSON.stringify(envelope), false);
    },

    readEventsAfter(sessionId: SessionId, after: Seq | 0): AsyncIterable<Result<Envelope, StoreError>> {
      const filePath = eventsPath(storageRoot, sessionId);
      async function* generator(): AsyncGenerator<Result<Envelope, StoreError>> {
        const forwardStart = await locateForwardStart(filePath, after);
        let stream;
        try {
          stream = createReadStream(filePath, { encoding: 'utf8', start: forwardStart });
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
        } finally {
          // A consumer that stops early — every `replay_gap` path in the session manager
          // breaks out of this loop — closes the generator here. `readline`'s own cleanup
          // closes the interface but leaves the input stream open, so without this the fd
          // stays open until the process exits, one per abandoned replay.
          rl.close();
          stream.destroy();
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
      // An empty ring knows nothing about the range asked for — including `after: 0`,
      // which it cannot answer merely because it holds nothing. Answering `[]` there
      // would serve a blank transcript for a session whose whole history is on disk:
      // a `ringCapacity` of 0 (accepted by config), a rehydrated session, or one whose
      // ring was dropped. `null` is what sends every one of those to the spill.
      if (!buf || buf.length === 0) return null;
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
      // (D162, S23) Past the session's tool-output budget the blob is withheld, not an
      // error: the caller's envelope is built independently of this write's outcome (S9.1),
      // and the absent blob is answered by the fetch route's existing `no_such_output` path
      // (S9.5) rather than a new one. Nothing already written is evicted to make room.
      const used = await toolOutputBytesUsed(storageRoot, sessionId);
      if (used + bytes.length > config.caps.sessionToolOutputBytes) {
        return { ok: true, value: undefined };
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

    // (D160, I49) Fsync'd, mirroring `writeToolOutput`'s shape but reversed: the caller
    // constructs the `message` envelope only after this resolves, so a written attachment
    // is durable before anything names it. `mediaType` is written to a sidecar file (never
    // appended, same as the blob) so the read route can echo it later without scanning the
    // session's spill for the `AttachmentRef` that named this id (S21.6).
    async writeAttachment(sessionId: SessionId, turnId: TurnId, attachmentId: AttachmentId, bytes: Buffer, mediaType: string) {
      const dir = path.join(sessionDir(storageRoot, sessionId), 'attachments', turnId);
      const filePath = path.join(dir, attachmentId);
      const metaPathAttachment = path.join(dir, `${attachmentId}.meta`);
      if (!isSafePathSegment(turnId) || !isSafePathSegment(attachmentId)) {
        return ioError(filePath, 'id is not a single path segment');
      }
      try {
        await mkdir(dir, { recursive: true });
        await writeSyncedFile(filePath, bytes);
      } catch (err) {
        return ioError(filePath, (err as Error).message);
      }
      try {
        await writeSyncedFile(metaPathAttachment, mediaType, 'utf8');
      } catch (err) {
        // (S21 fix) The blob above is already durable; if its `.meta` sidecar fails to
        // write, don't leave the blob behind as an orphan — no `AttachmentRef` will ever
        // be constructed to name it (the caller treats this whole call as a no-op), and
        // `openAttachment` can never serve it back without the sidecar anyway.
        await rm(filePath, { force: true }).catch(() => {});
        return ioError(metaPathAttachment, (err as Error).message);
      }
      return { ok: true, value: undefined };
    },

    async openAttachment(sessionId: SessionId, turnId: TurnId, attachmentId: AttachmentId) {
      const dir = path.join(sessionDir(storageRoot, sessionId), 'attachments', turnId);
      const filePath = path.join(dir, attachmentId);
      const metaPathAttachment = path.join(dir, `${attachmentId}.meta`);
      if (!isSafePathSegment(turnId) || !isSafePathSegment(attachmentId)) {
        return { ok: false, error: { code: 'not_found', path: filePath } };
      }
      let mediaType: string;
      try {
        mediaType = await readFile(metaPathAttachment, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: { code: 'not_found', path: filePath } };
        return ioError(metaPathAttachment, (err as Error).message);
      }
      try {
        const handle = await open(filePath, 'r');
        return { ok: true, value: { stream: handle.createReadStream(), mediaType } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: { code: 'not_found', path: filePath } };
        return ioError(filePath, (err as Error).message);
      }
    },

    // (#203) Removes every attachment staged under this turn — the whole directory
    // `writeAttachment` writes into, not one attachmentId at a time — so a partial
    // multi-attachment write failure rolls back the sibling(s) that already succeeded,
    // not just the one whose own write failed (that narrower case is `writeAttachment`'s
    // own cleanup, above). A turn that staged nothing (the directory was never created)
    // is a no-op, not a `not_found` error: the caller does not know in advance whether
    // any write reached disk before the failure that triggered this call.
    async removeAttachments(sessionId: SessionId, turnId: TurnId) {
      const dir = path.join(sessionDir(storageRoot, sessionId), 'attachments', turnId);
      if (!isSafePathSegment(turnId)) return ioError(dir, 'turnId is not a single path segment');
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        return ioError(nodeErr.path ?? dir, nodeErr.message);
      }
      return { ok: true, value: undefined };
    },

    async appendAudit(record: AuditRecord) {
      return appendLine(path.join(storageRoot, 'audit.ndjson'), JSON.stringify(record), true);
    },

    async readAuditPage(query: AuditQuery): Promise<Result<AuditPage, StoreError>> {
      return readAuditPageImpl(path.join(storageRoot, 'audit.ndjson'), query, config.caps.auditPageMax, auditCursorSecret);
    },

    async appendPid(record: ProcessRecord) {
      return appendLine(path.join(storageRoot, 'pids.ndjson'), JSON.stringify(record), false);
    },

    async tombstonePid(pid: number, exitedAt: IsoTimestamp) {
      // D95: a tombstone is the second of the file's two line shapes, not a partial record.
      // The latest line for a pid decides liveness; the spawn line carries everything else.
      return appendLine(path.join(storageRoot, 'pids.ndjson'), JSON.stringify({ pid, exitedAt } satisfies ProcessTombstone), false);
    },

    async readOpenPids(): Promise<readonly ProcessRecord[]> {
      const all = await foldLatestById<ProcessRecord>(path.join(storageRoot, 'pids.ndjson'), 'pid', false);
      return all.filter((r) => r.exitedAt === null);
    },

    async appendReview(record: Review) {
      // D128: durable — fsync'd before it returns, for every line, not only the
      // finalising one. Reviews are human-paced and kilobytes, so the cost that exempts
      // ordinary spill events does not apply here, and a torn tail must never revert an
      // acknowledged `final` review back to `draft` (I29).
      return appendLine(path.join(storageRoot, 'reviews.ndjson'), JSON.stringify(record), true);
    },

    async readAllReviews(): Promise<readonly Review[]> {
      return foldLatestById<Review>(path.join(storageRoot, 'reviews.ndjson'), 'reviewId', true);
    },

    async appendRequisition(record: Requisition) {
      return appendLine(path.join(storageRoot, 'requisitions.ndjson'), JSON.stringify(record), false);
    },

    async readAllRequisitions(): Promise<readonly Requisition[]> {
      return foldLatestById<Requisition>(path.join(storageRoot, 'requisitions.ndjson'), 'requisitionId', false);
    },

    // D161: the decision table this implements is `20-contract.md § store, claimLock's
    // decision table` — absent → write `self`; another host's holder → always refuse; this
    // host's live holder → refuse; this host's stale or unparseable holder → reclaim, logged.
    // The claim precedes `session-manager.boot`'s reap step, so a failed claim must not have
    // touched any server-wide file — this method only ever reads and (on success) rewrites
    // `server.lock` itself.
    //
    // The "absent" row is claimed via `tryClaimExclusive`, not a plain read-then-write: two
    // processes racing this method against the same absent/just-reclaimed lock must not both
    // observe "absent" and both succeed — that would silently defeat the one-server guarantee
    // this method exists to provide. The loop below only reclaims-and-retries; it never writes
    // `self` except through the exclusive claim, so the property holds on every iteration.
    async claimLock(self: ServerLock, isLive: LivenessProbe): Promise<Result<void, StartupError>> {
      const filePath = lockPath(storageRoot);
      const payload = JSON.stringify(self);

      for (;;) {
        let outcome: 'claimed' | 'exists';
        try {
          outcome = await tryClaimExclusive(filePath, payload);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        if (outcome === 'claimed') return { ok: true, value: undefined };

        let existingRaw: string;
        try {
          existingRaw = await readFile(filePath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // reclaimed out from under us — retry the exclusive claim
          return startupIoError(filePath, (err as Error).message);
        }

        let holder: ServerLock | null = null;
        try {
          holder = JSON.parse(existingRaw) as ServerLock;
        } catch {
          holder = null;
        }

        if (holder !== null) {
          // I50: the liveness test cannot see another machine's process table, so a lock
          // naming a different host is never reclaimed, whatever its pid says.
          if (holder.hostname !== self.hostname || (await isLive(holder))) {
            return { ok: false, error: { code: 'storage_locked', path: filePath, holder } };
          }
          console.warn(
            `[store] reclaiming stale server.lock: pid ${holder.pid} on ${holder.hostname}, started ${holder.startedAt}, image ${holder.image}`,
          );
        } else {
          // D161: a file nothing can read names no holder — refusing on it would make every
          // unclean shutdown need manual intervention.
          console.warn(`[store] server.lock at ${filePath} is unparseable; reclaiming it as a stale holder`);
        }

        try {
          await rm(filePath, { force: true });
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        // Loop back to retry the exclusive claim now that the stale/unparseable lock is
        // gone. A concurrent claimant racing this same window can only win one of the two
        // exclusive creates — the loser correctly re-reads and refuses.
      }
    },

    async releaseLock(): Promise<Result<void, StoreError>> {
      const filePath = lockPath(storageRoot);
      try {
        await rm(filePath, { force: true });
      } catch (err) {
        console.warn(`[store] releaseLock: failed to remove ${filePath}: ${(err as Error).message}`);
        return ioError(filePath, (err as Error).message);
      }
      return { ok: true, value: undefined };
    },
  };

  return { ok: true, value: store };
}
