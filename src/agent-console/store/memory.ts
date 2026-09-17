import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { auditRecordMatches, decodeAuditCursor, encodeAuditCursor } from './audit.js';
import { isSafePathSegment } from './paths.js';
import type { AuditRecord, Envelope, ProcessRecord, RuntimeOptions, SessionId, SessionRecord, SessionStore, StoreError, Result } from '../core/types.js';

// Copies at every storage boundary keep callers from changing persisted history
// through object references. The maps belong to one backend instance.
export function createMemorySessionStore(config: Pick<RuntimeOptions, 'caps'>): SessionStore {
  const meta = new Map<SessionId, SessionRecord>();
  const events = new Map<SessionId, Envelope[]>();
  const ring = new Map<SessionId, Envelope[]>();
  const output = new Map<string, Buffer>();
  const attachments = new Map<string, { bytes: Buffer; mediaType: string }>();
  const audit: AuditRecord[] = [];
  const pids = new Map<number, ProcessRecord>();
  const secret = randomBytes(32);
  const ok = <T>(value: T): Result<T, StoreError> => ({ ok: true, value });
  const missing = (path: string): Result<never, StoreError> => ({ ok: false, error: { code: 'not_found', path } });
  const invalid = (path: string): Result<never, StoreError> => ({ ok: false, error: { code: 'io', path, detail: 'not a safe path segment' } });
  const key = (...parts: string[]) => parts.join('/');
  return {
    lease: { async claim() { return ok(undefined); }, async release() {} },
    async createSession(record) { if (!isSafePathSegment(record.id)) return invalid(record.id); meta.set(record.id, structuredClone(record)); if (!events.has(record.id)) events.set(record.id, []); return ok(undefined); },
    async writeMeta(record) { if (!isSafePathSegment(record.id)) return invalid(record.id); if (!meta.has(record.id)) return missing(record.id); meta.set(record.id, structuredClone(record)); return ok(undefined); },
    async readAllMeta() { return [...meta].map(([sessionId, record]) => ({ sessionId, result: ok(structuredClone(record)) })); },
    async deleteSession(id) {
      if (!isSafePathSegment(id)) return invalid(id);
      meta.delete(id); events.delete(id); ring.delete(id);
      for (const map of [output, attachments]) for (const k of map.keys()) if (k.startsWith(id + '/')) map.delete(k);
      return ok(undefined);
    },
    async appendEvent(id, envelope) { if (!isSafePathSegment(id)) return invalid(id); const log = events.get(id); if (!log) return missing(id); log.push(structuredClone(envelope)); return ok(undefined); },
    async *readEventsAfter(id, after) { if (!isSafePathSegment(id)) { yield invalid(id); return; } for (const e of events.get(id) ?? []) if (e.seq > after) yield ok(structuredClone(e)); },
    async readLastSeq(id) { if (!isSafePathSegment(id)) return invalid(id); return ok(events.get(id)?.at(-1)?.seq ?? 0); },
    pushRing(id, envelope) { const r = ring.get(id) ?? []; r.push(structuredClone(envelope)); if (r.length > config.caps.ringCapacity) r.shift(); ring.set(id, r); },
    readRingAfter(id, after) {
      const r = ring.get(id);
      if (!r || r.length === 0 || after < r[0]!.seq - 1) return null;
      return structuredClone(r.filter(e => e.seq > after));
    },
    dropRing(id) { ring.delete(id); },
    async writeToolOutput(id, turn, call, bytes) {
      const k = key(id, turn, call);
      if (![id, turn, call].every(isSafePathSegment)) return invalid(k);
      const used = [...output].filter(([p]) => p.startsWith(id + '/')).reduce((n, [, b]) => n + b.length, 0);
      if (used + bytes.length > config.caps.sessionToolOutputBytes) return ok(undefined);
      output.set(k, Buffer.from(bytes)); return ok(undefined);
    },
    async openToolOutput(id, turn, call) {
      const k = key(id, turn, call), bytes = output.get(k);
      return ![id, turn, call].every(isSafePathSegment) || !bytes ? missing(k) : ok(Readable.from([Buffer.from(bytes)]));
    },
    async writeAttachment(id, turn, attachment, bytes, mediaType) {
      const k = key(id, turn, attachment);
      if (![id, turn, attachment].every(isSafePathSegment)) return invalid(k);
      attachments.set(k, { bytes: Buffer.from(bytes), mediaType }); return ok(undefined);
    },
    async openAttachment(id, turn, attachment) {
      const k = key(id, turn, attachment), value = attachments.get(k);
      return ![id, turn, attachment].every(isSafePathSegment) || !value ? missing(k) : ok({ stream: Readable.from([Buffer.from(value.bytes)]), mediaType: value.mediaType });
    },
    async removeAttachments(id, turn) {
      if (![id, turn].every(isSafePathSegment)) return invalid(key(id, turn));
      for (const k of attachments.keys()) if (k.startsWith(key(id, turn) + '/')) attachments.delete(k);
      return ok(undefined);
    },
    async appendAudit(record) { audit.push(structuredClone(record)); return ok(undefined); },
    async readAuditPage(query) {
      let before = query.before === null ? audit.length : decodeAuditCursor(query.before, secret);
      if (before === null || before > audit.length) return { ok: false, error: { code: 'corrupt', path: 'audit.ndjson', detail: 'invalid audit cursor' } };
      const limit = Math.min(config.caps.auditPageMax, Number.isFinite(query.limit) && query.limit > 0 ? Math.floor(query.limit) : config.caps.auditPageMax);
      const records: AuditRecord[] = [];
      let examined = 0;
      while (before > 0 && examined++ < config.caps.auditPageMax && records.length < limit) {
        const record = audit[--before]!;
        if (auditRecordMatches(record, query)) records.push(structuredClone(record));
      }
      return ok({ records, nextCursor: before > 0 ? encodeAuditCursor(before, secret) : null });
    },
    async appendPid(record) { pids.set(record.pid, structuredClone(record)); return ok(undefined); },
    async tombstonePid(pid, exitedAt) { const record = pids.get(pid); if (record) record.exitedAt = exitedAt; return ok(undefined); },
    async readOpenPids() { return [...pids.values()].filter(r => r.exitedAt === null).map(r => structuredClone(r)); },
    async close() {},
  };
}
