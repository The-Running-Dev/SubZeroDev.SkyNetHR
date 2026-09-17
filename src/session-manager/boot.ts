import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProcessSupervisor } from '../agent-console/process/index.js';
import type { Config, Store, Result, StartupError, ServerLock, IsoTimestamp } from '../contract/index.js';
const nowIso = () => new Date().toISOString() as IsoTimestamp;

// S7.10: proves the storage root is actually writable right now, not merely that it
// existed when `createStore` last touched it (permissions can change, a mount can go
// read-only, in between).
async function probeStorageWritable(storageRoot: string): Promise<Result<void, StartupError>> {
  const marker = path.join(storageRoot, `.boot-write-check-${randomUUID()}`);
  try {
    await writeFile(marker, '');
    await rm(marker, { force: true });
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: { code: 'storage_unwritable', path: storageRoot, detail: (err as Error).message } };
  }
}
export async function claimHostLease(config: Config, store: Store): Promise<Result<void, StartupError>> {
  const { getProcessImage } = createProcessSupervisor(store);

  // S7.10: a storage root that exists but cannot be written (permissions revoked,
  // mounted read-only, since `createStore` last touched it) is refused here rather
  // than discovered mid-rehydration. Run alongside the image probe below — neither
  // depends on the other's result, and only `writable.ok` has to be checked before
  // `claimLock` is called (S22.6).
  const [writable, selfImage] = await Promise.all([probeStorageWritable(config.storageRoot), getProcessImage(process.pid)]);
  if (!writable.ok) return writable;

  // `pid`, `hostname`, `startedAt` and `image` are informational only (I57): no
  // reclaim, release or renewal decision reads any of them, so an unresolved image
  // probe costs this lock nothing beyond what a `storage_locked` refusal prints.
  if (selfImage === null) {
    console.warn(
      "[session-manager] boot: could not determine this process's own image; server.lock will carry " +
        "image: 'unknown', which a later storage_locked refusal would print for this holder",
    );
  }

  // Step 0 (D180): claim `<storage>/server.lock` before the reap step below, not
  // merely before `listen` — reaping kills process trees it believes are orphans and
  // cannot tell another server's live agents from its own dead ones, so a second server
  // must be refused before that first destructive act rather than after it. `instanceId`
  // is minted fresh for this run; `renewals` starts at zero and `server.ts` drives it
  // from here.
  const self: ServerLock = {
    instanceId: randomUUID(),
    renewals: 0,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: nowIso(),
    image: selfImage ?? 'unknown',
  };
  const claimed = await store.claimLock(self);
  if (!claimed.ok) return claimed;

  return { ok: true, value: undefined };
}
