import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PrincipalId, ResolvedPath, Result, SessionId, StoreError } from '../core/types.js';
import { isSafePathSegment } from './paths.js';

// Internal recovery state, separate from historical meta.json and public summaries.
// Presence means creation has not yet been durably published by this runtime. The
// host remains the authority for its outcome; this record never asserts an outcome.
export interface PendingCreate {
  readonly sessionId: SessionId;
  readonly principal: PrincipalId;
  readonly cwd: ResolvedPath;
}
export interface CreateAttemptStore {
  write(attempt: PendingCreate): Promise<Result<void, StoreError>>;
  readAll(): Promise<Result<readonly PendingCreate[], StoreError>>;
  remove(id: SessionId): Promise<Result<void, StoreError>>;
}
const ok = <T>(value: T): Result<T, StoreError> => ({ ok: true, value });
const io = (file: string, error: unknown): Result<never, StoreError> => ({ ok: false, error: { code: 'io', path: file, detail: String(error) } });

export function createMemoryAttemptStore(): CreateAttemptStore {
  const attempts = new Map<SessionId, PendingCreate>();
  return {
    async write(attempt) { attempts.set(attempt.sessionId, { ...attempt }); return ok(undefined); },
    async readAll() { return ok([...attempts.values()].map(a => ({ ...a }))); },
    async remove(id) { attempts.delete(id); return ok(undefined); },
  };
}

export function createFsAttemptStore(storageRoot: string): CreateAttemptStore {
  const directory = path.join(storageRoot, 'create-attempts');
  // Windows does not support opening directories for fsync. File contents are
  // flushed before atomic publication on both platforms; POSIX also flushes names.
  async function syncDirectory(dir: string) {
    if (process.platform === 'win32') return;
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return {
    async write(attempt) {
      if (!isSafePathSegment(attempt.sessionId)) return io(directory, 'invalid session id');
      const file = path.join(directory, attempt.sessionId + '.json');
      try {
        await mkdir(directory, { recursive: true });
        await syncDirectory(storageRoot);
        const temp = file + '.tmp';
        const handle = await open(temp, 'w');
        try { await handle.writeFile(JSON.stringify(attempt)); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
        await syncDirectory(directory);
        return ok(undefined);
      } catch (error) { return io(file, error); }
    },
    async readAll() {
      let files: string[];
      try { files = await readdir(directory); }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ok([]) : io(directory, error); }
      const attempts: PendingCreate[] = [];
      for (const name of files) {
        if (!name.endsWith('.json')) continue; // incomplete publication never reached a host callback
        const file = path.join(directory, name);
        try {
          const value = JSON.parse(await readFile(file, 'utf8')) as PendingCreate;
          if (!value || typeof value.sessionId !== 'string' || !isSafePathSegment(value.sessionId) ||
              name !== value.sessionId + '.json' || typeof value.principal !== 'string' ||
              typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) throw new Error('invalid pending create record');
          attempts.push(value);
        } catch (error) {
          // Losing this reservation is unsafe; never interpret unreadable as absent.
          return { ok: false, error: { code: 'corrupt', path: file, detail: String(error) } };
        }
      }
      return ok(attempts);
    },
    async remove(id) {
      if (!isSafePathSegment(id)) return io(directory, 'invalid session id');
      const file = path.join(directory, id + '.json');
      try { await rm(file, { force: true }); await syncDirectory(directory); return ok(undefined); }
      catch (error) { return io(file, error); }
    },
  };
}
