import { createSessionCore, match, parseStandingRule } from '../agent-console/core/index.js';
import { createFsRuntimeLease } from '../agent-console/store/lease.js';
import { createFsAttemptStore } from '../agent-console/store/create-attempts.js';
import { createHostAttempts } from '../agent-console/core/create-attempts.js';
import type { SessionError as RuntimeError, SessionStore, SessionCore } from '../agent-console/core/types.js';
import type { ProcessLedger } from '../agent-console/process/ledger.js';
import { createConfiguredAdapter } from '../config/providers.js';
import { claimHostLease } from './boot.js';
import { createPayrollFold } from './payroll.js';
import type {
  Adapter, AdapterError, AdapterOptions, Checkpoints, ChecklistItemId, Config,
  IsoTimestamp, OperatorId, Records, RecordsError, RequisitionId, Result, SessionError,
  SessionId, SessionManager, SessionRecord, Store, StoreError, Vendor,
} from '../contract/index.js';

export { match, parseStandingRule };
export type { GitSha, ChecklistItemId } from '../contract/index.js';

// Runtime principals and provider ids are opaque strings. The HR boundary maps
// those values to its own branded identity and configured provider vocabulary.
function hostError(error: RuntimeError): SessionError {
  if (error.code === 'not_found') return { code: 'no_such_session', sessionId: error.sessionId };
  if (error.code === 'host_create') return { code: 'records', cause: error.cause as RecordsError };
  if (error.code === 'create_outcome_unknown') return { code: 'storage', cause: { code: 'io', path: error.sessionId, detail: 'create_outcome_unknown; workspace quarantined' } };
  return error as SessionError;
}
function mapped<T>(result: Result<T, RuntimeError>): Result<T, SessionError> {
  return result.ok ? result : { ok: false, error: hostError(result.error) };
}

export function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly processLedger?: ProcessLedger<StoreError>;
  readonly checkpoints: Checkpoints;
  readonly records: Records;
  readonly createAdapter?: (id: Vendor, options: AdapterOptions) => Result<Adapter, AdapterError> | Promise<Result<Adapter, AdapterError>>;
  readonly getOsCreatedAt?: (pid: number) => Promise<IsoTimestamp | null>;
}): SessionManager {
  const { config, store, records } = deps;
  const claimed = new Map<SessionId, RequisitionId>();
  const hostCreate = createHostAttempts({
    prepare(id, _principal, data) {
      const requisitionId = data as RequisitionId | null;
      if (requisitionId === null) return { ok: true, value: undefined };
      const result = records.claim(requisitionId);
      if (result.ok) claimed.set(id, requisitionId);
      return result;
    },
    async commit(id) {
      const requisitionId = claimed.get(id);
      if (requisitionId === undefined) return { ok: true, value: undefined };
      const result = await records.attachSession(requisitionId, id);
      if (result.ok) claimed.delete(id);
      return result;
    },
    abort(id) {
      const requisitionId = claimed.get(id);
      if (requisitionId !== undefined) { records.release(requisitionId); claimed.delete(id); }
    },
  });
  const runtime = createSessionCore({
    config: { ...config, maxLiveSessionsPerWorkspace: 1 },
    // Legacy Store injections predate the runtime lease and recovery journal.
    // Supply both durable facilities at this compatibility boundary when absent.
    store: { ...store,
      lease: (store as unknown as Partial<SessionStore>).lease ?? createFsRuntimeLease(config.storageRoot),
      createAttempts: (store as unknown as Partial<SessionStore>).createAttempts ?? createFsAttemptStore(config.storageRoot),
    } as unknown as SessionStore,
    checkpoints: deps.checkpoints,
    hostCreate,
    createAdapter: (id, options) => (deps.createAdapter ?? createConfiguredAdapter)(id as Vendor, options),
    ...(deps.processLedger ? { processLedger: deps.processLedger } : {}),
    ...(deps.getOsCreatedAt ? { getOsCreatedAt: deps.getOsCreatedAt } : {}),
  });
  const foldPayroll = createPayrollFold(config, {
    readEventsAfter: runtime.admin.readEvents as Store['readEventsAfter'],
  });
  async function completed(sessionId: SessionId) {
    const items = new Map<ChecklistItemId, { by: OperatorId; completedAt: IsoTimestamp }>();
    for await (const result of runtime.admin.readEvents(sessionId)) {
      if (!result.ok) break;
      const e = result.value;
      if (e.kind === 'checklist.item.completed' || e.kind === 'x-skynet.checklist.item.completed') {
        items.set(e.data.itemId, { by: e.data.by, completedAt: e.ts });
      }
    }
    return items;
  }
  const ticks = new Map<SessionId, Map<ChecklistItemId, Promise<Result<void, SessionError>>>>();
  const manager: SessionManager = {
    async boot() {
      const lease = await claimHostLease(config, store);
      if (!lease.ok) return lease;
      const booted = await runtime.boot();
      if (booted.ok) return booted;
      if (booted.error.code === 'storage_locked') return { ok: false, error: { code: 'storage_locked', path: booted.error.path, holder: { ...booted.error.holder, renewals: 0, image: 'runtime' } } };
      return { ok: false, error: { code: 'storage_unwritable', path: booted.error.path, detail: 'detail' in booted.error ? booted.error.detail : booted.error.code } };
    },
    shutdown: () => runtime.shutdown(),
    async create(owner, input) { return mapped(await runtime.create(owner, { ...input, hostData: input.requisitionId })); },
    list: owner => runtime.list(owner) as ReturnType<SessionManager['list']>,
    get: (id, owner) => mapped(runtime.get(id, owner)) as ReturnType<SessionManager['get']>,
    async message(id, owner, text, attachments) {
      // Stage in the same tick as send's busy-slot claim; no host I/O or callbacks
      // intervene. Inline HTTP uploads remain a host compatibility format.
      const handles: import('../agent-console/core/attachments.js').UploadId[] = [];
      try {
        for (const upload of attachments) {
          const bytes = Buffer.from(upload.dataBase64, 'base64');
          const begun = runtime.attachments.begin(id, owner, { filename: upload.filename, mediaType: upload.mediaType, sizeBytes: bytes.length });
          if (!begun.ok) return mapped(begun);
          handles.push(begun.value);
          for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
            const written = runtime.attachments.write(id, owner, begun.value, offset, bytes.subarray(offset, offset + 256 * 1024));
            if (!written.ok) return mapped(written);
          }
          const committed = runtime.attachments.commit(id, owner, begun.value);
          if (!committed.ok) return mapped(committed);
        }
        return mapped(await runtime.send(id, owner, text, handles));
      } finally {
        for (const handle of handles) runtime.attachments.abort(id, owner, handle);
      }
    },
    answerPermission: async (...args) => {
      const result = mapped(await runtime.answerPermission(...args));
      return result.ok ? { ok: true, value: { accepted: result.value.accepted } } : result;
    },
    interrupt: async (...args) => mapped(await runtime.interrupt(...args)),
    end: async (...args) => mapped(await runtime.end(...args)),
    remove: async (...args) => {
      const result = mapped(await runtime.remove(...args));
      if (result.ok) ticks.delete(args[0]);
      return result;
    },
    rename: async (...args) => mapped(await runtime.rename(...args)),
    listCheckpoints: async (...args) => mapped(await runtime.listCheckpoints(...args)),
    restore: async (...args) => mapped(await runtime.restore(...args)),
    openToolOutput: async (...args) => mapped(await runtime.openToolOutput(...args)),
    openAttachment: async (...args) => mapped(await runtime.openAttachment(...args)),
    subscribe: async (id, owner, after, sink) => mapped(await runtime.subscribe(id, owner, after, sink as Parameters<SessionCore['subscribe']>[3])),
    readAudit: query => runtime.admin.readAudit(query) as ReturnType<SessionManager['readAudit']>,
    getSnapshotForReview(id) {
      const record = runtime.admin.snapshot(id);
      return record ? { sessionId: id, owner: record.owner as OperatorId, vendor: record.vendor as Vendor, cwd: record.cwd, createdAt: record.createdAt } : null;
    },
    async payroll(id, owner) {
      const found = runtime.get(id, owner);
      if (!found.ok) return mapped(found);
      return foldPayroll(id, runtime.admin.snapshot(id)! as SessionRecord);
    },
    async checklist(id, owner) {
      const found = runtime.get(id, owner);
      if (!found.ok) return mapped(found);
      const items = await completed(id);
      return { ok: true, value: config.checklist.map(item => ({ ...item, completedBy: items.get(item.id)?.by ?? null, completedAt: items.get(item.id)?.completedAt ?? null })) };
    },
    tickChecklistItem(id, owner, itemId) {
      const found = runtime.get(id, owner);
      if (!found.ok) return Promise.resolve({ ok: false, error: hostError(found.error) });
      if (found.value.state === 'ended') return Promise.resolve({ ok: false, error: { code: 'session_ended', sessionId: id } });
      if (!config.checklist.some(item => item.id === itemId)) return Promise.resolve({ ok: false, error: { code: 'no_such_item', itemId } });
      let claims = ticks.get(id);
      if (!claims) { claims = new Map(); ticks.set(id, claims); }
      const existing = claims.get(itemId);
      if (existing) return existing;
      // Install one promise before any await. Every duplicate observes the same
      // durable outcome; a placeholder is never reported as a successful append.
      const writing = (async (): Promise<Result<void, SessionError>> => {
        if ((await completed(id)).has(itemId)) return { ok: true, value: undefined };
        const result = await runtime.events.append(id, owner, 'x-skynet.checklist.item.completed', { itemId, by: owner });
        if (!result.ok) {
          claims!.delete(itemId);
          if (result.error.code === 'storage') return { ok: false, error: { code: 'session_ended', sessionId: id } };
          return { ok: false, error: hostError(result.error) };
        }
        return { ok: true, value: undefined };
      })();
      claims.set(itemId, writing);
      return writing;
    },
  };
  return manager;
}
