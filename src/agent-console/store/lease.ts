import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProcessMetadata } from '../process/metadata.js';
import type { IsoTimestamp, Result, StoreError } from '../core/types.js';

export interface RuntimeLeaseHolder {
  readonly instanceId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: IsoTimestamp;
  readonly osCreatedAt: IsoTimestamp | null;
}
export type RuntimeLeaseError = StoreError | {
  readonly code: 'storage_locked'; readonly path: string;
  readonly holder: RuntimeLeaseHolder; readonly age: number;
};
export interface RuntimeLease {
  claim(): Promise<Result<void, RuntimeLeaseError>>;
  release(): Promise<void>;
}

// Each contender publishes a complete, uniquely named claim before enumerating
// claims. Two contenders can both refuse, but cannot both see themselves alone:
// the first successful observation necessarily precedes the other's publication.
// Never overwrite another generation. Stale generations are ignored only after
// local process death or a proven OS creation-time mismatch; remote/unknown lives
// fail closed. There is no observation window or fixed retry delay.
export function createFsRuntimeLease(storageRoot: string): RuntimeLease {
  const directory = path.join(storageRoot, 'runtime-leases');
  const instanceId = randomUUID();
  const filePath = path.join(directory, instanceId + '.json');
  const supervisor = createProcessMetadata();
  let held = false;
  let claiming: Promise<Result<void, RuntimeLeaseError>> | null = null;
  async function alive(holder: RuntimeLeaseHolder): Promise<boolean> {
    if (holder.hostname !== hostname()) return true;
    try { process.kill(holder.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (holder.osCreatedAt === null) return true;
    const created = await supervisor.getOsCreatedAt(holder.pid);
    return created === null || created === holder.osCreatedAt;
  }
  async function acquire(): Promise<Result<void, RuntimeLeaseError>> {
    const temp = filePath + '.tmp';
    try {
      await mkdir(directory, { recursive: true });
      const self: RuntimeLeaseHolder = {
        instanceId, pid: process.pid, hostname: hostname(),
        startedAt: new Date().toISOString() as IsoTimestamp,
        osCreatedAt: await supervisor.getOsCreatedAt(process.pid),
      };
      await writeFile(temp, JSON.stringify(self), { flag: 'wx' });
      await link(temp, filePath);
      for (const filename of await readdir(directory)) {
        if (!filename.endsWith('.json') || filename === instanceId + '.json') continue;
        const candidate = path.join(directory, filename);
        let holder: RuntimeLeaseHolder;
        try { holder = JSON.parse(await readFile(candidate, 'utf8')) as RuntimeLeaseHolder; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return { ok: false, error: { code: 'corrupt', path: candidate, detail: String(error) } };
        }
        if (!holder || typeof holder.instanceId !== 'string' || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 ||
            typeof holder.hostname !== 'string' || !Number.isFinite(Date.parse(holder.startedAt)) ||
            !(holder.osCreatedAt === null || typeof holder.osCreatedAt === 'string')) {
          return { ok: false, error: { code: 'corrupt', path: candidate, detail: 'invalid runtime lease' } };
        }
        if (await alive(holder)) return { ok: false, error: { code: 'storage_locked', path: candidate, holder, age: Math.max(0, Date.now() - Date.parse(holder.startedAt)) } };
      }
      held = true;
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: { code: 'io', path: directory, detail: String(error) } };
    } finally {
      await rm(temp, { force: true }).catch(() => {});
      if (!held) await rm(filePath, { force: true }).catch(() => {});
    }
  }
  return {
    claim() {
      if (held) return Promise.resolve({ ok: true, value: undefined });
      if (claiming) return claiming;
      claiming = acquire().finally(() => { claiming = null; });
      return claiming;
    },
    async release() {
      if (claiming) await claiming;
      if (!held) return;
      await rm(filePath, { force: true });
      held = false;
    },
  };
}
