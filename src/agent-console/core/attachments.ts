import { randomUUID } from 'node:crypto';
import type { Caps, PrincipalId, Result, SessionError, SessionId } from './types.js';

export type UploadId = string & { readonly __upload: unique symbol };
export interface UploadMetadata { readonly filename: string; readonly mediaType: string; readonly sizeBytes: number; }
export interface AttachmentStaging {
  begin(sessionId: SessionId, principal: PrincipalId, metadata: UploadMetadata): Result<UploadId, SessionError>;
  write(sessionId: SessionId, principal: PrincipalId, id: UploadId, offset: number, bytes: Uint8Array): Result<number, SessionError>;
  commit(sessionId: SessionId, principal: PrincipalId, id: UploadId): Result<UploadId, SessionError>;
  abort(sessionId: SessionId, principal: PrincipalId, id: UploadId): Result<void, SessionError>;
}

export function createAttachmentStaging(caps: Caps, authorize: (id: SessionId, principal: PrincipalId) => Result<void, SessionError>, options: { ttlMs?: number; now?: () => number } = {}) {
  interface Upload { sessionId: SessionId; principal: PrincipalId; metadata: UploadMetadata; expires: number; chunks: Buffer[]; size: number; committed: boolean; }
  const uploads = new Map<UploadId, Upload>();
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 300_000;
  const ok = <T>(value: T): Result<T, SessionError> => ({ ok: true, value });
  const bad = (detail: string): Result<never, SessionError> => ({ ok: false, error: { code: 'bad_request', field: 'attachments', detail } });
  function purge() { for (const [id, upload] of uploads) if (upload.expires <= now()) uploads.delete(id); }
  function find(sessionId: SessionId, principal: PrincipalId, id: UploadId): Result<Upload, SessionError> {
    purge();
    const upload = uploads.get(id);
    if (!upload || upload.sessionId !== sessionId || upload.principal !== principal) return { ok: false, error: { code: 'not_found', sessionId } };
    const allowed = authorize(sessionId, principal);
    return allowed.ok ? ok(upload) : allowed;
  }
  const api: AttachmentStaging = {
    begin(sessionId, principal, metadata) {
      purge();
      const allowed = authorize(sessionId, principal);
      if (!allowed.ok) return allowed;
      if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0 || metadata.sizeBytes > caps.attachmentBytes) return bad('attachment exceeds byte cap');
      if ([...uploads.values()].filter(u => u.sessionId === sessionId).length >= caps.attachmentCount) return bad('attachment count exceeded');
      const id = randomUUID() as UploadId;
      // filename is display metadata. It never becomes a filesystem component.
      uploads.set(id, { sessionId, principal, metadata: { ...metadata }, expires: now() + ttl, chunks: [], size: 0, committed: false });
      return ok(id);
    },
    write(sessionId, principal, id, offset, bytes) {
      const found = find(sessionId, principal, id);
      if (!found.ok) return found;
      const u = found.value;
      if (u.committed || offset !== u.size || bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 || u.size + bytes.byteLength > u.metadata.sizeBytes) return bad('invalid upload chunk or offset');
      u.chunks.push(Buffer.from(bytes)); u.size += bytes.byteLength;
      return ok(u.size);
    },
    commit(sessionId, principal, id) {
      const found = find(sessionId, principal, id);
      if (!found.ok) return found;
      if (found.value.size !== found.value.metadata.sizeBytes) return bad('upload is incomplete');
      found.value.committed = true;
      return ok(id);
    },
    abort(sessionId, principal, id) {
      const found = find(sessionId, principal, id);
      if (!found.ok) return found;
      uploads.delete(id); return ok(undefined);
    },
  };
  return {
    api,
    take(sessionId: SessionId, principal: PrincipalId, ids: readonly UploadId[]): Result<readonly { upload: UploadMetadata; bytes: Buffer }[], SessionError> {
      if (ids.length > caps.attachmentCount || new Set(ids).size !== ids.length) return bad('invalid attachment count or duplicate upload');
      const selected: Upload[] = [];
      for (const id of ids) {
        const found = find(sessionId, principal, id);
        if (!found.ok) return found;
        if (!found.value.committed) return bad('upload is not committed');
        selected.push(found.value);
      }
      for (const id of ids) uploads.delete(id);
      return ok(selected.map(u => ({ upload: u.metadata, bytes: Buffer.concat(u.chunks, u.size) })));
    },
    discard(sessionId: SessionId) { for (const [id, u] of uploads) if (u.sessionId === sessionId) uploads.delete(id); },
  };
}
