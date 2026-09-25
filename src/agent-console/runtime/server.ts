import type { Readable, Writable } from 'node:stream';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { stripExtendedPrefix } from '../core/workspaces/jail.js';
import { createSessionCore } from '../core/index.js';
import { createHostAttempts, type HostCreateCallbacks, type CreateAttemptState } from '../core/create-attempts.js';
import type { SessionCore, SessionStore, RuntimeOptions, Result, SessionId, Seq, TurnId, CallId, AttachmentId, RequestId,
  GitSha, AuditQuery, EventKind, EventPayloadMap, Checkpoints } from '../core/types.js';
import type { UploadId } from '../core/attachments.js';
import { createFsSessionStore } from '../store/fs.js';
import { createMemorySessionStore } from '../store/memory.js';
import { createCheckpoints } from '../extensions/checkpoints/index.js';
import { createRegisteredAdapter } from '../providers/legacy.js';
import { createBuiltinRegistry } from '../providers/builtins/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RpcPeer, RpcError, applicationError } from './protocol/peer.js';
import { Subscriptions } from './protocol/subscriptions.js';
import { object, text, optionalText, integer, strings, bool, choice } from './protocol/params.js';
import { wireEvent } from './protocol/events.js';
import { UploadFiles } from './uploads.js';

export const PROTOCOL_VERSION = '1.0.0';
const HOST_METHODS = ['host.create.prepare', 'host.create.commit', 'host.create.abort', 'host.create.status'] as const;
export function unwrap<T>(result: Result<T, unknown>): T {
  if (result.ok) return result.value;
  const error = result.error;
  const detail = JSON.stringify(error);
  throw applicationError(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'host_create', detail);
}

export interface RuntimeDependencies {
  readonly registry?: ProviderRegistry;
  readonly checkpoints?: Checkpoints;
  readonly onExit?: (reason: string) => void;
  readonly heartbeat?: { intervalMs: number; timeoutMs: number };
}

export function runRuntime(input: Readable, output: Writable, dependencies: RuntimeDependencies = {}) {
  let core: SessionCore | undefined, store: SessionStore | undefined, subscriptions: Subscriptions | undefined;
  let options: RuntimeOptions | undefined;
  let hello = false, ready = false, stopped = false;
  const registry = dependencies.registry ?? createBuiltinRegistry();
  const uploads = new Map<string, { sessionId: SessionId; principal: string; expires: number; busy: boolean }>();
  let uploadFiles = new UploadFiles(undefined);
  const expiry = setInterval(() => {
    for (const [id, handle] of uploads) if (!handle.busy && handle.expires <= Date.now()) {
      uploads.delete(id); void uploadFiles.remove(handle.sessionId, id);
    }
  }, 30_000);
  expiry.unref();
  const peer = new RpcPeer(input, output, dispatch, reason => { void shutdown(reason); }, dependencies.heartbeat);
  let done!: () => void;
  const closed = new Promise<void>(resolve => { done = resolve; });

  async function shutdown(reason: string) {
    if (stopped) return;
    stopped = true; ready = false; subscriptions?.close(); input.pause(); clearInterval(expiry);
    const deadline = setTimeout(() => { dependencies.onExit?.(reason); done(); }, 4900);
    deadline.unref();
    try {
      await core?.shutdown().catch(error => console.warn('shutdown', error));
      await core?.flush().catch(error => console.warn('flush', error));
      await Promise.all([...uploads].map(([id, handle]) => uploadFiles.remove(handle.sessionId, id)));
      uploads.clear();
      await store?.close().catch(error => console.warn('store close', error));
      await store?.lease.release().catch(error => console.warn('lease release', error));
    } finally { clearTimeout(deadline); dependencies.onExit?.(reason); done(); }
  }
  function hostCallbacks(methods: string[], timeoutMs: number): HostCreateCallbacks {
    if (!HOST_METHODS.some(method => methods.includes(method))) return createHostAttempts({ prepare: () => ({ ok: true, value: undefined }),
      commit: async () => ({ ok: true, value: undefined }), abort: () => {} });
    if (HOST_METHODS.some(m => !methods.includes(m))) throw new RpcError(-32602, 'Declare all four host create methods together');
    const preparing = new Map<string, string>();
    async function invoke(method: string, params: unknown) {
      if (!methods.includes(method)) throw applicationError('host_method_unavailable');
      return peer.call(method, params, timeoutMs).result;
    }
    return {
      async prepare(id, principal, data) {
        const request = peer.call('host.create.prepare', { createAttemptId: id, principal, input: data ?? null });
        preparing.set(id, request.id);
        try { await request.result; return { ok: true, value: undefined }; }
        catch (error) { return { ok: false, error }; }
        finally { preparing.delete(id); }
      },
      async commit(id) { await invoke('host.create.commit', { createAttemptId: id, sessionId: id }); return { ok: true, value: undefined }; },
      async abort(id) { await invoke('host.create.abort', { createAttemptId: id, reason: 'create_failed' }); },
      async status(id) {
        const result = object(await invoke('host.create.status', { createAttemptId: id }));
        return choice(result, 'state', ['new', 'prepared', 'committing', 'committed', 'aborted']) as CreateAttemptState;
      },
      cancel(id) { const request = preparing.get(id); if (request) peer.cancel(request); },
    };
  }
  async function handshake(params: unknown) {
    if (hello) throw applicationError('already_initialized');
    const p = object(params), version = text(p, 'version');
    if (!/^1\.[0-9]+(?:\.[0-9]+)?$/.test(version)) throw applicationError('protocol_version_mismatch');
    const storage = object(p.storage), kind = choice(storage, 'kind', ['fs', 'memory']);
    const root = text(storage, 'root'), roots = strings(p, 'workspaceRoots');
    if (!path.isAbsolute(root) || !roots.length || roots.some(r => !path.isAbsolute(r))) throw new RpcError(-32602, 'Absolute storage root and workspace roots required');
    // Match host configuration and the jail, including Windows 8.3 names and junctions.
    let resolvedRoots: RuntimeOptions['workspaceRoots'];
    try { resolvedRoots = roots.map(r => stripExtendedPrefix(realpathSync.native(r))) as unknown as RuntimeOptions['workspaceRoots']; }
    catch { throw new RpcError(-32602, 'Workspace roots must resolve to existing paths'); }
    const settings = object(p.options ?? {}), caps = object(settings.caps ?? {});
    options = { storageRoot: root as RuntimeOptions['storageRoot'], workspaceRoots: resolvedRoots,
      includeRaw: bool(settings, 'includeRaw'), streamDeltas: bool(settings, 'streamDeltas'),
      maxLiveSessionsPerWorkspace: integer(settings, 'maxLiveSessionsPerWorkspace', 1, 1000, 1),
      caps: { ringCapacity: integer(caps, 'ringCapacity', 2000, 1_000_000, 1), toolResultBytes: integer(caps, 'toolResultBytes', 16_384, 1024 * 1024, 1),
        subscriberQueueHighWater: integer(caps, 'subscriberQueueHighWater', 256, 100_000, 1), auditPageMax: integer(caps, 'auditPageMax', 1000, 10_000, 1),
        standingRuleBytes: integer(caps, 'standingRuleBytes', 4096, 1_000_000, 1), attachmentBytes: integer(caps, 'attachmentBytes', 10 * 1024 * 1024, 1024 ** 3, 1),
        attachmentCount: integer(caps, 'attachmentCount', 10, 1000, 1), sessionToolOutputBytes: integer(caps, 'sessionToolOutputBytes', 256 * 1024 * 1024, Number.MAX_SAFE_INTEGER, 1) } };
    const timeoutMs = integer(settings, 'hostAttemptTimeoutMs', 30_000, 300_000, 1);
    const callbacks = hostCallbacks(strings(p, 'hostMethods', []), timeoutMs);
    const stdoutLineBytes = integer(settings, 'providerStdoutLineBytes', 64 * 1024 * 1024, 1024 ** 3, 1);
    hello = true;
    store = kind === 'fs' ? unwrap(await createFsSessionStore(options, () => null)) : createMemorySessionStore(options);
    core = createSessionCore({ config: options, store, hostCreate: callbacks, hostAttemptTimeoutMs: timeoutMs,
      checkpoints: dependencies.checkpoints ?? createCheckpoints(options, { name: 'AgentConsole', email: 'agentconsole@localhost' }),
      createAdapter: (id, adapterOptions) => createRegisteredAdapter(registry, id, { ...adapterOptions, stdoutLineBytes }) });
    if (stopped) { await core.shutdown(); await store.close(); throw applicationError('RuntimeTerminated'); }
    unwrap(await core.boot());
    if (stopped) { await core.shutdown(); await store.lease.release(); await store.close(); throw applicationError('RuntimeTerminated'); }
    uploadFiles = new UploadFiles(kind === 'fs' ? root : undefined);
    await uploadFiles.recover((await store.readAllMeta()).map(m => m.sessionId));
    subscriptions = new Subscriptions(core, peer.writer, options.caps.subscriberQueueHighWater);
    ready = true;
    return { version: PROTOCOL_VERSION, storage: kind, extensions: core.extensions.operations };
  }
  function upload(id: string, principal: string) {
    const handle = uploads.get(id);
    if (!handle || handle.principal !== principal || handle.expires <= Date.now()) { if (handle?.expires && handle.expires <= Date.now()) uploads.delete(id); throw applicationError('not_found'); }
    unwrap(core!.get(handle.sessionId, principal));
    if (handle.busy) throw applicationError('bad_request', 'upload operation in progress');
    return handle;
  }
  async function bytes(stream: NodeJS.ReadableStream, offset: number, length: number) {
    const source = stream as Readable;
    let skipped = 0, count = 0, eof = true;
    const chunks: Buffer[] = [];
    try {
      for await (const value of source) {
        const chunk = Buffer.from(value as Uint8Array), start = Math.max(0, offset - skipped); skipped += chunk.length;
        if (start >= chunk.length) continue;
        const take = chunk.subarray(start, start + length - count); chunks.push(take); count += take.length;
        if (count === length) { eof = false; break; }
      }
    } finally { source.destroy(); }
    return { data: Buffer.concat(chunks, count).toString('base64'), nextOffset: offset + count, eof };
  }
  async function dispatch(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === 'runtime.hello') return handshake(params);
    if (!ready || !core || !store || !subscriptions || !options) throw applicationError('not_initialized');
    const p = object(params);
    if (signal.aborted) throw applicationError('cancelled');
    const sessionId = () => text(p, 'sessionId') as SessionId, principal = () => text(p, 'principal');
    switch (method) {
      case 'providers.list': case 'providers.refresh': return registry[method === 'providers.list' ? 'list' : 'refresh']({ cwd: options.workspaceRoots[0]! });
      case 'sessions.create': return unwrap(await core.create(principal(), { vendor: text(p, 'provider'), cwd: text(p, 'cwd'), model: optionalText(p, 'model'),
        sandbox: p.sandbox == null ? null : choice(p, 'sandbox', ['read-only', 'workspace-write', 'unrestricted'] as const), hostData: p.input ?? null }));
      case 'sessions.list': return core.listPage(principal(), optionalText(p, 'cursor') as SessionId | null, integer(p, 'limit', 100, 1000, 1));
      case 'sessions.get': return unwrap(core.get(sessionId(), principal()));
      case 'sessions.end': return unwrap(await core.end(sessionId(), principal()));
      case 'sessions.remove': return unwrap(await core.remove(sessionId(), principal()));
      case 'turns.send': {
        const id = sessionId(), owner = principal(), handles = strings(p, 'uploads', []) as UploadId[];
        for (const handle of handles) if (upload(handle, owner).sessionId !== id) throw applicationError('not_found');
        const result = await core.send(id, owner, text(p, 'text'), handles, optionalText(p, 'model') ?? undefined);
        if (result.ok) for (const handle of handles) { uploads.delete(handle); await uploadFiles.remove(id, handle); }
        return unwrap(result);
      }
      case 'turns.interrupt': return unwrap(await core.interrupt(sessionId(), principal(), text(p, 'turnId') as TurnId));
      case 'permissions.respond': return unwrap(await core.answerPermission(sessionId(), principal(), { requestId: text(p, 'requestId') as RequestId,
        decision: choice(p, 'decision', ['allow', 'deny']), scope: choice(p, 'scope', ['once', 'always'], 'once'),
        rule: optionalText(p, 'rule') as never, reason: optionalText(p, 'reason') }));
      case 'events.subscribe': return unwrap(await subscriptions.subscribe(sessionId(), principal(), integer(p, 'fromSeq', 0)));
      case 'events.unsubscribe': return subscriptions.unsubscribe(text(p, 'subscriptionId'), principal());
      case 'events.credit': return subscriptions.credit(text(p, 'subscriptionId'), principal(), integer(p, 'count', undefined, Number.MAX_SAFE_INTEGER, 1));
      case 'events.read': {
        const id = sessionId(); unwrap(core.get(id, principal()));
        const events = [], limit = integer(p, 'limit', 100, 1000, 1);
        for await (const result of core.admin.readEvents(id, integer(p, 'fromSeq', 0) as Seq | 0)) { if (signal.aborted) throw applicationError('cancelled'); events.push(wireEvent(unwrap(result))); if (events.length >= limit) break; }
        return { events, nextSeq: events.at(-1)?.seq ?? integer(p, 'fromSeq', 0) };
      }
      case 'events.append': {
        const kind = text(p, 'kind');
        if (!/^x-[a-z][a-z0-9-]*\.[a-zA-Z0-9_.-]+$/.test(kind)) throw new RpcError(-32602, 'Host event kind must use x-namespace.name');
        // A6 extension payloads are opaque JSON. The core's typed host augmentation
        // cannot enumerate namespaces belonging to another trusted embedder.
        return wireEvent(unwrap(await core.events.append(sessionId(), principal(), kind as EventKind, object(p.data) as unknown as EventPayloadMap[EventKind])));
      }
      case 'attachments.begin': {
        const id = sessionId(), owner = principal();
        const handle = unwrap(core.attachments.begin(id, owner, { filename: text(p, 'name'), sizeBytes: integer(p, 'size'), mediaType: text(p, 'contentType', 'application/octet-stream') }));
        try { await uploadFiles.begin(id, handle); }
        catch (error) { core.attachments.abort(id, owner, handle); throw error; }
        uploads.set(handle, { sessionId: id, principal: owner, expires: Date.now() + 300_000, busy: false }); return { uploadId: handle };
      }
      case 'attachments.write': {
        const id = text(p, 'uploadId') as UploadId, owner = principal(), handle = upload(id, owner), data = text(p, 'data');
        if (data.length > Math.ceil(256 * 1024 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new RpcError(-32602, 'Invalid base64 chunk');
        const content = Buffer.from(data, 'base64'); if (content.length > 256 * 1024) throw new RpcError(-32602, 'Chunk exceeds 256 KiB');
        handle.busy = true;
        try {
          const offset = integer(p, 'offset'), nextOffset = unwrap(core.attachments.write(handle.sessionId, owner, id, offset, content));
          await uploadFiles.write(handle.sessionId, id, offset, content); return { nextOffset };
        } finally { handle.busy = false; }
      }
      case 'attachments.commit': case 'attachments.abort': {
        const id = text(p, 'uploadId') as UploadId, owner = principal(), handle = upload(id, owner);
        if (method === 'attachments.commit') return { committedUploadId: unwrap(core.attachments.commit(handle.sessionId, owner, id)) };
        unwrap(core.attachments.abort(handle.sessionId, owner, id)); uploads.delete(id); await uploadFiles.remove(handle.sessionId, id); return null;
      }
      case 'toolOutput.read': case 'attachments.read': {
        const id = sessionId(), owner = principal(), turn = text(p, 'turnId') as TurnId;
        const offset = integer(p, 'offset'), length = integer(p, 'length', undefined, 256 * 1024, 1);
        if (method === 'toolOutput.read') return bytes(unwrap(await core.openToolOutput(id, owner, turn, text(p, 'callId') as CallId)), offset, length);
        const found = unwrap(await core.openAttachment(id, owner, turn, text(p, 'attachmentId') as AttachmentId));
        return { ...await bytes(found.stream, offset, length), contentType: found.mediaType };
      }
      case 'checkpoints.list': return unwrap(await core.listCheckpoints(sessionId(), principal()));
      case 'checkpoints.restore': return unwrap(await core.restore(sessionId(), principal(), text(p, 'sha') as GitSha));
      case 'admin.sessions.snapshot': { const value = core.admin.snapshot(sessionId()); if (!value) throw applicationError('not_found'); return value; }
      case 'admin.sessions.remove': return unwrap(await core.admin.remove(sessionId()));
      case 'admin.sessions.reassignPrincipal': return unwrap(await core.admin.reassignPrincipal(sessionId(), principal()));
      case 'admin.sessions.list': {
        const owner = optionalText(p, 'principal'), after = optionalText(p, 'cursor'), limit = integer(p, 'limit', 100, 1000, 1);
        const all = (await store.readAllMeta()).map(m => core!.admin.snapshot(m.sessionId)).filter(r => r !== null && (owner === null || r.owner === owner)).sort((a, b) => a!.id.localeCompare(b!.id));
        const start = after === null ? 0 : all.findIndex(s => s!.id === after) + 1, items = all.slice(start, start + limit);
        return { items, next: start + items.length < all.length ? items.at(-1)!.id : null };
      }
      case 'admin.audit.read': {
        const query = object(p.query ?? {});
        return unwrap(await core.admin.readAudit({ before: optionalText(p, 'cursor'), limit: integer(p, 'limit', 100, 1000, 1),
          sessionId: optionalText(query, 'sessionId'), operator: optionalText(query, 'principal'), since: optionalText(query, 'since'), until: optionalText(query, 'until'), incidentsOnly: bool(query, 'incidentsOnly') } as AuditQuery));
      }
      default: throw new RpcError(-32601, 'Method not found');
    }
  }
  return { peer, closed, close: () => peer.stop('host_close') };
}
