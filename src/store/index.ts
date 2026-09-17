import { lazyHandle, appendToHandle, foldLatestById } from '../agent-console/process/append-log.js';
import { randomBytes } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type {
  Config,
  LockRenewal,
  Requisition,
  Review,
  ServerLock,
  StartupError,
  Store,
  StoreError,
  Result,
} from '../contract/index.js';

import { createFsSessionStore } from '../agent-console/store/fs.js';
// D194, D195, I62: declared together so their relation — the interval strictly below the
// window, with room to spare — is enforced by one file rather than requested of a second.
// Neither is a `Config` field: no correct value here depends on how an operator mounted
// anything, and promoting either to a deployment flag is a contract amendment.
const LOCK_OBSERVATION_WINDOW_MS = 10_000;
export const LOCK_RENEWAL_INTERVAL_MS = 2_000;



function ioError(filePath: string, detail: string): Result<never, StoreError> {
  return { ok: false, error: { code: 'io', path: filePath, detail } };
}


// Temp-file-then-atomic-rename, in the same directory so the rename is on one volume. A
// reader opening `targetPath` mid-write otherwise observes it after `writeFile`'s internal
// create/truncate but before the bytes land — this closes that window: `targetPath` only
// ever exists absent or complete.
async function atomicWrite(targetPath: string, contents: Buffer | string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, contents);
  await rename(tmpPath, targetPath);
}

function startupIoError(filePath: string, detail: string): Result<never, StartupError> {
  return { ok: false, error: { code: 'storage_unwritable', path: filePath, detail } };
}


function lockPath(storageRoot: string): string {
  return path.join(storageRoot, 'server.lock');
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


// A fresh open-read-close, never a handle held across the observation window (I50). Throws
// on any read failure other than absence, so a caller's own `try`/`catch` decides whether
// that is `StartupError.storage_unwritable`-shaped or `StoreError.io`.
type LockSample = { readonly kind: 'present'; readonly holder: ServerLock } | { readonly kind: 'absent' } | { readonly kind: 'corrupt'; readonly detail: string };


async function sampleLock(filePath: string): Promise<LockSample> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'corrupt', detail: (err as Error).message };
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'corrupt', detail: 'not a JSON object' };
  // A lock predating the lease parses cleanly and simply carries no `instanceId`/`renewals`
  // (I61) — not checked here, since that shape still reaches the ordinary reclaim rule.
  return { kind: 'present', holder: parsed as ServerLock };
}
export async function createStore(config: Config): Promise<Result<Store, StoreError>> {
  const created = await createFsSessionStore(config);
  if (!created.ok) return created;
  // The host is the only writer of its branded identities and provider ids.
  const sessionStore = created.value as unknown as Omit<Store, 'appendReview' | 'readAllReviews' | 'appendRequisition' | 'readAllRequisitions' | 'claimLock' | 'releaseLock' | 'renewLock'>;
  const storageRoot = config.storageRoot;
  const reviewsPath = path.join(storageRoot, 'reviews.ndjson');
  const requisitionsPath = path.join(storageRoot, 'requisitions.ndjson');
  const reviewsHandle = lazyHandle(reviewsPath);
  const requisitionsHandle = lazyHandle(requisitionsPath);
  let heldLock: ServerLock | null = null;
  return { ok: true, value: { ...sessionStore,

    async appendReview(record: Review) {
      // D128: durable — fsync'd before it returns, for every line, not only the
      // finalising one. Reviews are human-paced and kilobytes, so the cost that exempts
      // ordinary spill events does not apply here, and a torn tail must never revert an
      // acknowledged `final` review back to `draft` (I29).
      return appendToHandle(reviewsHandle.get, reviewsPath, JSON.stringify(record), true);
    },


    async readAllReviews(): Promise<readonly Review[]> {
      return foldLatestById<Review>(reviewsPath, 'reviewId', true);
    },


    async appendRequisition(record: Requisition) {
      return appendToHandle(requisitionsHandle.get, requisitionsPath, JSON.stringify(record), false);
    },


    async readAllRequisitions(): Promise<readonly Requisition[]> {
      return foldLatestById<Requisition>(requisitionsPath, 'requisitionId', false);
    },


    // D180: the decision table this implements is `20-contract.md § store, claimLock's
    // decision table` — absent → write `self`, no wait; present and (instanceId, renewals)
    // changed across one observation window → refuse storage_locked; present and unchanged
    // → reclaim, logged; present but unparseable → refuse storage_lock_corrupt (D196). No
    // process table is consulted and no wall clock is compared anywhere in this method (I50,
    // I57). The claim precedes `session-manager.boot`'s reap step, so a failed claim must not
    // have touched any server-wide file — this method only ever reads and (on success)
    // rewrites `server.lock` itself.
    //
    // The "absent" row is claimed via `tryClaimExclusive`, not a plain read-then-write: two
    // processes racing this method against the same absent/just-reclaimed lock must not both
    // observe "absent" and both succeed — that would silently defeat the one-server guarantee
    // this method exists to provide. The loop below only reclaims-and-retries; it never writes
    // `self` except through the exclusive claim or the reclaim's atomic rename (I61).
    async claimLock(self: ServerLock): Promise<Result<void, StartupError>> {
      const filePath = lockPath(storageRoot);
      const payload = JSON.stringify(self);

      for (;;) {
        let outcome: 'claimed' | 'exists';
        try {
          outcome = await tryClaimExclusive(filePath, payload);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        if (outcome === 'claimed') {
          heldLock = self;
          return { ok: true, value: undefined };
        }

        let first: LockSample;
        try {
          first = await sampleLock(filePath);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        if (first.kind === 'absent') continue; // released between the exists-check and our read — retry the exclusive claim
        if (first.kind === 'corrupt') {
          return { ok: false, error: { code: 'storage_lock_corrupt', path: filePath, detail: first.detail } };
        }

        // I50/D180: the observation itself, on this process's own monotonic clock. No wall
        // clock is compared, and nothing here reads a process table.
        await delay(LOCK_OBSERVATION_WINDOW_MS);

        let second: LockSample;
        try {
          second = await sampleLock(filePath);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        if (second.kind === 'absent') continue; // released mid-window — retry the exclusive claim
        if (second.kind === 'corrupt') {
          return { ok: false, error: { code: 'storage_lock_corrupt', path: filePath, detail: second.detail } };
        }

        const unchanged = first.holder.instanceId === second.holder.instanceId && first.holder.renewals === second.holder.renewals;
        if (!unchanged) {
          return { ok: false, error: { code: 'storage_locked', path: filePath, holder: second.holder } };
        }

        console.warn(
          `[store] reclaiming stale server.lock: pid ${second.holder.pid} on ${second.holder.hostname}, started ${second.holder.startedAt}, image ${second.holder.image}`,
        );
        try {
          await atomicWrite(filePath, payload);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }

        // D216: a reclaim is not a claim until the reclaimer has seen its own lock survive
        // one renewal interval — the rename above overwrites unconditionally, so it never
        // tells its author whether a second racing reclaimer won instead. This re-sample is
        // what confirms it, on this process's own monotonic clock, still never comparing a
        // wall clock (D180). No boot work happens before it returns.
        await delay(LOCK_RENEWAL_INTERVAL_MS);

        let confirm: LockSample;
        try {
          confirm = await sampleLock(filePath);
        } catch (err) {
          return startupIoError(filePath, (err as Error).message);
        }
        if (confirm.kind === 'corrupt') {
          return { ok: false, error: { code: 'storage_lock_corrupt', path: filePath, detail: confirm.detail } };
        }
        if (confirm.kind === 'absent') {
          return startupIoError(filePath, 'server.lock vanished after a reclaim overwrite it, before confirmation');
        }
        if (confirm.holder.instanceId !== self.instanceId) {
          return { ok: false, error: { code: 'storage_locked', path: filePath, holder: confirm.holder } };
        }

        heldLock = self;
        return { ok: true, value: undefined };
        // Loop back only on the "absent" rows above; a reclaim never retries.
      }
    },


    // D180, I56: ownership-checked. Removes the file only while it still carries this
    // process's own `instanceId` — an absent file, an unparseable one, or one naming another
    // instance means this process has already been displaced, and removing nothing is what
    // keeps a stalled-then-reclaimed holder's tidy shutdown from deleting its successor's
    // claim. Never fatal: the next boot's staleness path recovers from a lock nobody removed.
    async releaseLock(): Promise<Result<void, StoreError>> {
      const filePath = lockPath(storageRoot);
      if (heldLock === null) return { ok: true, value: undefined }; // nothing this process believes it holds

      let sample: LockSample;
      try {
        sample = await sampleLock(filePath);
      } catch (err) {
        console.warn(`[store] releaseLock: failed to read ${filePath}: ${(err as Error).message}`);
        return ioError(filePath, (err as Error).message);
      }
      if (sample.kind === 'absent') {
        heldLock = null;
        return { ok: true, value: undefined };
      }
      if (sample.kind === 'corrupt' || sample.holder.instanceId !== heldLock.instanceId) {
        console.warn(`[store] releaseLock: ${filePath} no longer names this instance; leaving it for its holder`);
        heldLock = null;
        return { ok: true, value: undefined };
      }

      try {
        await rm(filePath, { force: true });
      } catch (err) {
        console.warn(`[store] releaseLock: failed to remove ${filePath}: ${(err as Error).message}`);
        return ioError(filePath, (err as Error).message);
      }
      heldLock = null;
      return { ok: true, value: undefined };
    },


    // D195: one ownership-checked write, reporting which happened. `store` owns no clock —
    // `server.ts` drives `LOCK_RENEWAL_INTERVAL_MS`'s timer. `'displaced'` covers every case
    // this process no longer holds the root: absent, unparseable, or naming another
    // `instanceId` (I56) — a caller must stop rather than carry on writing state it no
    // longer owns. A `StoreError.io` means the renewal itself could not be attempted.
    async renewLock(): Promise<Result<LockRenewal, StoreError>> {
      const filePath = lockPath(storageRoot);
      if (heldLock === null) return { ok: true, value: 'displaced' };

      let sample: LockSample;
      try {
        sample = await sampleLock(filePath);
      } catch (err) {
        return ioError(filePath, (err as Error).message);
      }
      if (sample.kind === 'absent' || sample.kind === 'corrupt' || sample.holder.instanceId !== heldLock.instanceId) {
        heldLock = null;
        return { ok: true, value: 'displaced' };
      }

      const renewed: ServerLock = { ...heldLock, renewals: sample.holder.renewals + 1 };
      try {
        await atomicWrite(filePath, JSON.stringify(renewed));
      } catch (err) {
        return ioError(filePath, (err as Error).message);
      }
      heldLock = renewed;
      return { ok: true, value: 'renewed' };
    },
    async close() { await Promise.all([sessionStore.close(), reviewsHandle.close(), requisitionsHandle.close()]); },
  } };
}
