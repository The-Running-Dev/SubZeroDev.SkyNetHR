import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuditCursor, AuditRecord, AuditQuery, Result, StoreError } from '../core/types.js';

export interface AuditSink { append(record: AuditRecord): Promise<Result<void, StoreError>>; }


// D86: `AuditCursor` is opaque and server-minted. It encodes a byte offset into
// `audit.ndjson` — where the next page resumes reading backward from — but no caller may
// construct or decode one, so it carries an HMAC over that offset, keyed on a secret this
// store mints once at boot and never persists. A cursor from a different process boot, or
// one a caller has altered, fails the check and is reported `corrupt` (S12.5).
export function encodeAuditCursor(offset: number, secret: Buffer): AuditCursor {
  const payload = String(offset);
  const mac = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}.${mac}`, 'utf8').toString('base64url') as AuditCursor;
}



// Constant-time in the same shape as `edge/http-common`'s `constantTimeEquals` — that
// module compares a caller-supplied secret and this one a caller-supplied MAC, and `store`
// cannot import from `edge/http-common` (nor the reverse: neither is the other's dependency
// per `10-design.md § Module boundaries`), so the technique is kept identical by hand rather
// than shared. Keep both in sync if either changes.
export function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const same = left.length === right.length;
  return timingSafeEqual(left, same ? right : left) && same;
}



export function decodeAuditCursor(cursor: AuditCursor, secret: Buffer): number | null {
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



export function auditRecordMatches(record: AuditRecord, query: AuditQuery): boolean {
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