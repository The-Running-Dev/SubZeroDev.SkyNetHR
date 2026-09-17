import { createProcessSupervisor } from '../process/index.js';
import type { ProcessLedger } from '../process/ledger.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { resolveInsideRoot } from './workspaces/jail.js';
import type {
  Adapter,
  AdapterOptions,
  ProviderId,
  AdapterError,
  AdapterNotification,
  AttachmentId,
  AttachmentPayload,
  AuditRecord,
  CallId,
  Caps,
  Checkpoint,
  CheckpointError,
  RuntimeOptions,
  Envelope,
  EventKind,
  EventPayloadMap,
  Frame,
  FrameKind,
  GitSha,
  IsoTimestamp,
  LiveSession,
  PrincipalId,
  PermissionAnswer,
  PermissionDecision,
  PermissionRequest,
  PermissionResolvedReason,
  ProcessRecord,
  RequestId,
  ResolvedScope,
  Result,
  Seq,
  SessionError,
  SessionId,
  SessionCore,
  SessionRecord,
  SessionSummary,
  StandingRuleExpression,
  SessionStore,
  StoreError,
  Subscription,
  SubscriberSink,
  Turn,
  TurnId,
} from './types.js';
import { isFrame } from './types.js';

import type { Checkpoints } from './types.js';
import type { HostCreateCallbacks } from './create-attempts.js';
import { coordinateHostAttempts, recoverHostAttempt } from './create-attempts.js';
import { createLane } from './lane.js';
import { createWorkspaceAllocator } from './workspaces/allocator.js';
import { createAttachmentStaging } from './attachments.js';
import type { AuditSink } from '../store/audit.js';
import { createCheckpointExtension } from '../extensions/checkpoints/extension.js';

// Every `CheckpointError` variant but `no_such_checkpoint` carries `detail`; that one
// carries `sha` instead. Centralised so every notice/error text built from a
// `CheckpointError` reads the same way regardless of which variant it is.
function checkpointErrorDetail(e: CheckpointError): string {
  return e.code === 'no_such_checkpoint' ? `no such checkpoint: ${e.sha}` : e.detail;
}

// The live turn is the contract's own `Turn` (20-contract.md § Turn), not a private
// look-alike: `PendingPermission.matchTarget` is what I43's validation reads, and it is
// declared there rather than shadowed here so that the invariant and the field it is
// stated over are the same object.

// The grammar, owned by session-manager per D35 — pure and total, no I/O, no state, no
// tool knowledge, no vendor knowledge (20-contract.md § session-manager).
const STANDING_RULE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^\r\n]+$/;

export function parseStandingRule(text: string, caps: Caps): StandingRuleExpression | null {
  if (Buffer.byteLength(text, 'utf8') > caps.standingRuleBytes) return null;
  if (!STANDING_RULE_PATTERN.test(text)) return null;
  return text as StandingRuleExpression;
}

// `*` matches any run of characters, including the empty run, except the shell
// metacharacters below — so a rule's wildcard can never be stretched, by an unreviewed
// request, across a character it was never shown matching. There is no escape: no rule
// ever matches a literal `*`.
const STANDING_RULE_WILDCARD_FORBIDS = new Set([';', '&', '|', '<', '>', '`', '$', '\r', '\n']);

function matchesPattern(pattern: string, target: string): boolean {
  let pi = 0;
  let ti = 0;
  let starAt = -1;
  let starTi = 0;
  while (ti < target.length) {
    if (pi < pattern.length && pattern[pi] === target[ti]) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starAt = pi;
      starTi = ti;
      pi++;
    } else if (starAt !== -1) {
      // Backtrack: the `*` at `starAt` stretches one character further, provided that
      // character is not one it is forbidden to cross.
      if (STANDING_RULE_WILDCARD_FORBIDS.has(target[starTi]!)) return false;
      starTi++;
      pi = starAt + 1;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

export function match(rule: StandingRuleExpression, request: PermissionRequest): boolean {
  if (request.matchTarget === null) return false;
  const colon = rule.indexOf(':');
  const tool = rule.slice(0, colon);
  const pattern = rule.slice(colon + 1);
  if (tool !== request.tool) return false;
  return matchesPattern(pattern, request.matchTarget);
}

// `LiveSession` is the pair the contract's invariants are stated over — `record` and
// `turn`, and I8 names them. Everything below it is scheduling state that crosses no
// module boundary, which is why the contract declares the pair and not this shape.
interface SessionEntry extends LiveSession {
  readonly lane: ReturnType<typeof createLane>;
  creating: boolean;
  operation: TurnId | null;
  record: SessionRecord;
  // `null` for a session rehydrated at boot (S7.2): no `--resume` is ever attempted on
  // one (D20), so it never needs a child process, and every route that would reach the
  // adapter for a live session already refuses first on `state === 'ended'` or on there
  // being no live turn.
  adapter: Adapter | null;
  turn: Turn | null;
  seq: number;
  firstTurnAnnounced: boolean;
  // S4.15: whether a turn has ever been started on this session, tracked independently
  // of `record.cliSessionId` — the two can diverge when the CLI died before reporting
  // `system/init` on its first turn, which is exactly the case the resume_unavailable
  // notice exists to name.
  hasRunATurn: boolean;
  // S6.8: set false when `checkpoints.init` failed at create — the operator was already
  // told once, so every later turn skips the doomed commit attempt rather than repeating
  // the same `checkpoints_unavailable` story as a `checkpoint_skipped` notice each time.
  checkpointsAvailable: boolean;
  // D41/D100: set once, the first time a spill append fails. Every later append on a dead
  // spill fails too, and without this the session would re-end itself per envelope —
  // walking `endedAt` forward and rewriting `meta.json` for a transition that already
  // happened.
  storageFailed: boolean;
  // D110: in-memory, session-scoped, allow-only, and dies with the process — no field on
  // `SessionRecord`, no line in any file, no entry in `meta.json`. A session rehydrated
  // at boot holds none (I45).
  readonly standingRules: StandingRuleExpression[];
  readonly subscribers: Set<SubscriberSink>;
  // I27: the lane protects short synchronous transitions. `emit` assigns seq and
  // pushes the ring there, then delivers subscribers outside the lane in the same tick.
  // The durable spill write
  // is asynchronous I/O and, left unqueued, can *complete* out of the order its seq was
  // assigned in — this chain is what keeps `events.ndjson` written in seq order despite
  // that.
  writeQueue: Promise<void>;
  // D178: the pid `spawned` recorded for the turn currently held, non-null only while
  // both a turn is live and its child has actually spawned. `shutdown` reads this to
  // tombstone the child it kills without reading `pids.ndjson` (S27.13) — cleared
  // everywhere `turn` is cleared, so the two stay in lockstep.
  livePid: number | null;
  // #200: `writeToolOutput` below is fire-and-forget (I27 — it must not delay `emit`'s
  // synchronous seq assignment), so a write can still be in flight after the turn that
  // started it has already ended. `remove()` only refuses while a turn is live; it does
  // not otherwise know a write is outstanding. Each entry removes itself once its own
  // write settles, success or failure alike, so this set's size is exactly the count of
  // writes `remove()` still needs to wait out before it may delete storage.
  readonly pendingToolOutputWrites: Set<Promise<void>>;
}

const KINDS_CARRYING_TURN_ID = new Set<EventKind>([
  'message',
  'message.delta',
  'thinking',
  'tool.call',
  'tool.result',
  'permission.request',
  'permission.resolved',
  'turn.started',
  'turn.ended',
  'usage',
]);

function nowIso(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

// S9.1: truncates to at most `maxBytes` UTF-8 bytes, backing up over a partial
// multi-byte code point at the boundary rather than splitting it — 0x80-0xBF are UTF-8
// continuation bytes, so trimming while the byte at `end` is one never cuts a character
// in half. Takes the already-encoded bytes rather than re-encoding the string, since the
// one caller also needs those same bytes for the untruncated blob.
function truncateUtf8(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function createSessionCore(deps: {
  readonly config: RuntimeOptions;
  readonly store: SessionStore;
  readonly processLedger?: ProcessLedger<StoreError>;
  readonly checkpoints: Checkpoints;
  readonly hostCreate: HostCreateCallbacks;
  readonly hostAttemptTimeoutMs?: number;
  readonly auditSink?: AuditSink;
  // Test seam only, the same reason `adapters/*`'s own executable-override options
  // exist: a real deployment always gets the real `createAdapter` (the default).
  // S28.11 needs an `Adapter` that is neither shipped vendor's own — one that reports
  // its turn ended and deliberately does not kill its own child — to show that the
  // tree-kill obligation is this manager's to enforce and not an accident of one
  // vendor's own close handler.
  readonly createAdapter: (id: ProviderId, options: AdapterOptions) => Result<Adapter, AdapterError> | Promise<Result<Adapter, AdapterError>>;
  // Test seam only, for the same reason as `createAdapter` above: S29.5's second
  // fail-closed case (the live counterpart's own creation time cannot be read) has no
  // other way to force deterministically — a real live process's own read practically
  // never fails on the platforms this manager runs the guard against.
  readonly getOsCreatedAt?: (pid: number) => Promise<IsoTimestamp | null>;
}): SessionCore {
  const { config, store, checkpoints, createAdapter: adapterFactory, getOsCreatedAt: getOsCreatedAtOverride } = deps;
  const hostCreate = coordinateHostAttempts(deps.hostCreate, deps.hostAttemptTimeoutMs);
  const audit = deps.auditSink ?? { append: (record: AuditRecord) => store.appendAudit(record) };
  const checkpointExtension = createCheckpointExtension(checkpoints);
  const supervisor = createProcessSupervisor(deps.processLedger ?? store);
  const { getProcessImage, imagesMatch, killProcessTree } = supervisor;
  const getOsCreatedAt = getOsCreatedAtOverride ?? supervisor.getOsCreatedAt;
  const sessions = new Map<SessionId, SessionEntry>();
  // D178, I55: one-way, and `shutdown` is its only setter. Checked at `handleNotification`,
  // the one function every `AdapterNotification` already passes through (it is what an
  // adapter is handed as `notify` at create), so this covers all four kinds — `event`,
  // `cli-session`, `spawned`, `exited` — with one conditional rather than one per kind.
  let notifyMuted = false;

  const allocation = createWorkspaceAllocator(config.maxLiveSessionsPerWorkspace ?? 1);
  const staging = createAttachmentStaging(config.caps, (sessionId, principal) => {
    const entry = sessions.get(sessionId);
    if (!entry || entry.record.owner !== principal) return { ok: false, error: { code: 'not_found', sessionId } };
    if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
    if (entry.creating || entry.operation || entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn?.turnId ?? entry.operation ?? sessionId as unknown as TurnId } };
    return { ok: true, value: undefined };
  });


  // S6.10: `checkpoints.destroy` before `store.deleteSession`, not concurrently — `ckpt.git`
  // sits inside the very directory `store.deleteSession` recursively removes, and two
  // concurrent `fs.rm({recursive: true})` calls over overlapping trees can trip each other
  // (an `ENOTEMPTY` mid-walk, on the loser). Shared by `remove()` and `create()`'s
  // requisition-attach unwind — the only two places a session's storage is torn down —
  // so this ordering lives in one place rather than two comments pointing at each other.
  async function destroySessionStorage(sessionId: SessionId): Promise<{
    readonly destroyed: Result<void, CheckpointError>;
    readonly deleted: Result<void, StoreError>;
  }> {
    const destroyed = await checkpoints.destroy(sessionId);
    const deleted = await store.deleteSession(sessionId);
    return { destroyed, deleted };
  }

  async function releaseCreateAttempt(sessionId: SessionId): Promise<Result<void, StoreError>> {
    const removed = await store.createAttempts.remove(sessionId);
    if (removed.ok) allocation.release(sessionId);
    return removed;
  }

  // `raw` is attached under the one rule both `emit` and `emitFrame` share: only when
  // `config.includeRaw` is on and the caller actually passed one.
  function optionalRaw(raw: unknown): { raw: unknown } | Record<string, never> {
    return config.includeRaw && raw !== undefined ? { raw } : {};
  }

  // Subscriber callbacks run outside the lane. A callback may append another event;
  // finish this fan-out before delivering that event to any subscriber.
  const deliveries = new WeakMap<SessionEntry, (Envelope | Frame)[]>();
  function deliverToAll(entry: SessionEntry, envelope: Envelope | Frame): void {
    const active = deliveries.get(entry);
    if (active) { active.push(envelope); return; }
    const queue = [envelope];
    deliveries.set(entry, queue);
    try {
      for (let index = 0; index < queue.length; index++) {
        for (const sub of entry.subscribers) sub.deliver(queue[index]!);
      }
    } finally { deliveries.delete(entry); }
  }

  // S9.8: delivers a completion envelope live-only, bypassing the ring and the spill —
  // both belong to `emit`, and by the time this is called the spill has already failed
  // to hold the envelope that triggered the failure. Pushing these to the ring anyway
  // would put something in it the spill does not hold (D41); the same reasoning as
  // `remove()`'s post-registry notice, which has nothing left to replay it from either.
  function deliverDirect<K extends EventKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K]): void {
    const envelope = entry.lane.run(() => {
      entry.seq += 1;
      const envelope = { seq: entry.seq as Seq, sessionId: entry.record.id, ts: nowIso(), kind, data } as Envelope;
      // `entry.record.lastSeq` is what `subscribe`'s reconnect-gap check compares an
      // incoming `Last-Event-ID` against (I1). The edge writes this envelope's `seq` as
      // that SSE `id:`, so a later reconnect must find it already accounted for here —
      // otherwise a client that saw this envelope live gets told it is past the end of
      // history it already has.
      entry.record.lastSeq = envelope.seq;
      return envelope;
    });
    deliverToAll(entry, envelope);
  }

  // Returns the envelope it built (so a caller like `tickChecklistItem` can read back the
  // `ts` it was actually stamped with), or `null` when `storageFailed` made this a no-op —
  // every other caller already ignores the return value, as it did before this returned one.
  async function emit<K extends EventKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K], raw?: unknown): Promise<Envelope<K> | null> {
    // S9.8: once the spill has failed the session is already ended, and no further
    // envelope may reach the ring it can no longer back — the completion envelopes for
    // the failure itself go out through `deliverDirect` instead, not this path.
    if (entry.storageFailed) return null;
    const envelope = entry.lane.run(() => {
      entry.seq += 1;
      const envelope = {
        seq: entry.seq as Seq,
        sessionId: entry.record.id,
        ts: nowIso(),
        kind,
        data,
        ...optionalRaw(raw),
      } as Envelope<K>;
      entry.record.lastSeq = envelope.seq;
      store.pushRing(entry.record.id, envelope as Envelope);
      return envelope;
    });
    // The durable spill write is I/O and does not resolve in call order on its own;
    // chaining it onto the session's write queue is what keeps `events.ndjson` written
    // in seq order despite that (I1, I27).
    //
    // A spill-append failure is fatal to the session (D41), and D100 splits the handling
    // in two. The first half restores the invariants the rest of the server reads as
    // unconditional: `state` moves to `ended` *and the turn slot is cleared with it*,
    // because I8 says `ended` implies `turn === null` and every consumer of that
    // implication assumes no child is running; `meta.json` is rewritten because a `state`
    // transition is one of the three occasions I16 names. The second half (S9.8) kills
    // the turn's child, resolves each outstanding `permission.request`
    // `cancelled_process_exit` (I9), and emits `turn.ended { storage_failure }`,
    // `session.ended` and `session.notice / error` — live-only, via `deliverDirect`,
    // since the spill that just failed cannot hold these either.
    //
    // Nothing here may call `emit`: this callback *is* the write queue, so an `emit`
    // inside it would await a promise that cannot settle until it returns.
    entry.writeQueue = entry.writeQueue.then(async () => {
      const appended = await store.appendEvent(entry.record.id, envelope as Envelope);
      if (appended.ok || entry.storageFailed) return;
      entry.storageFailed = true;
      // I2: the ring is a strict suffix of the spill, and this envelope is the one the
      // spill will never hold — it was pushed synchronously, before this append was even
      // issued. Dropping the ring is what keeps a later reconnect from being served an
      // envelope no read of the durable transcript can reproduce; `readRingAfter` then
      // answers `null` and every replay goes to the spill, which is the authority (D40).
      store.dropRing(entry.record.id);
      const turn = entry.turn;
      entry.turn = null;
      entry.livePid = null;
      entry.record.state = 'ended';
      entry.record.endedAt = nowIso();
      entry.record.endReason = 'storage_failure';
      allocation.release(entry.record.id);
      console.error(
        `[session-manager] session ${entry.record.id}: the event spill could not be written ` +
          `(${appended.error.code}); the session is ended. ${JSON.stringify(appended.error)}`,
      );
      // Best-effort, like `end()`'s: the storage that just failed may be the same storage
      // this writes to, and the in-memory record — which `findLiveOverlap` reads, and which
      // therefore frees the workspace — is already `ended` regardless.
      await store.writeMeta(entry.record);

      if (turn) {
        // `turn.started` is only durable once `phase` leaves 'starting' (`message`, just
        // above `entry.turn.phase = 'running'`). A failure struck before that point means
        // no subscriber was ever told this turn began, so `turn.ended` must not claim one
        // ended either (I14) — and with no `turn.started`, no `permission.request` could
        // have arrived yet, so `turn.pending` is empty regardless.
        if (turn.phase !== 'starting') {
          const cancelled = [...turn.pending];
          for (const [requestId] of cancelled) {
            deliverDirect(entry, 'permission.resolved', {
              turnId: turn.turnId,
              requestId,
              decision: 'deny',
              scope: 'once',
              operator: null,
              reason: 'cancelled_process_exit',
            });
          }
          // Best-effort, like every other write in this branch (I11 still owes one
          // `AuditRecord` per resolution, but the decision above is already final — an
          // append failure here has nothing left to deny). Parallel, not sequential: every
          // `seq` above was already assigned synchronously by `deliverDirect`, so — unlike
          // the `'exited'` handler's equivalent cleanup, which serializes deliberately to
          // protect seq order — nothing here depends on these awaits interleaving.
          await Promise.all(
            cancelled.map(([, pending]) =>
              audit.append({
                ts: nowIso(),
                operator: null,
                sessionId: entry.record.id,
                vendor: entry.record.vendor,
                sandbox: entry.record.sandbox,
                tool: pending.tool,
                input: pending.input,
                decision: 'deny',
                scope: 'once',
                reason: 'cancelled_process_exit',
              }),
            ),
          );
          deliverDirect(entry, 'turn.ended', { turnId: turn.turnId, stopReason: 'storage_failure', usage: null });
        }
        // A live turn (the only case this branch had one to clear) always has a real
        // adapter — a rehydrated session's `turn` is always null and never reaches here.
        await entry.adapter!.kill();
      }

      deliverDirect(entry, 'session.ended', { reason: 'storage_failure', endedAt: entry.record.endedAt });
      deliverDirect(entry, 'session.notice', {
        level: 'error',
        code: 'storage_failure',
        text: 'The event log could not be written; this session has ended.',
      });
    });
    const written = entry.writeQueue;
    // Register the spill before invoking subscribers: a subscriber may synchronously
    // append another event. It must queue behind the seq it has just received.
    deliverToAll(entry, envelope as Envelope);
    await written;
    return envelope;
  }

  // (D168, I51) A `message.delta` is a frame, not an envelope: no `seq` is assigned, the
  // ring and the spill are never touched, and delivery goes only to subscribers already
  // registered — never to `entry.record.lastSeq`, which is what a reconnect's
  // `Last-Event-ID` is checked against (I1). That is what makes a delta invisible to a
  // subscriber that has to replay: it was never a position in the stream to replay from.
  function emitFrame<K extends FrameKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K], raw?: unknown): void {
    const frame = {
      sessionId: entry.record.id,
      ts: nowIso(),
      kind,
      data,
      ...optionalRaw(raw),
    } as Frame<K>;
    deliverToAll(entry, frame);
  }

  // S29 (D181, D183, D186, I19): the pid-reuse guard, now five limbs and its own — the
  // lock no longer shares it (S30/D180 deleted the lock's own liveness probe; the lease
  // decides by watching a counter, never a process table). A record naming another host is
  // skipped entirely: not reaped, not tombstoned,
  // because an exit record for a child this server never saw would be a lie in the file
  // boot trusts most (D181). Everything else is reaped — tree killed, then tombstoned —
  // only when it has no `exitedAt` (guaranteed by `readOpenPids`), its `startedAt` is
  // later than the host's last boot, the live image still matches, *and* the live
  // process's own creation time is exactly the recorded `osCreatedAt`. The guard fails
  // closed at both new-limb ends: a `null` recorded or live `osCreatedAt` tombstones
  // without killing, the same as a stale or mismatched record always has.
  async function reapOne(record: ProcessRecord, hostBootAt: number): Promise<void> {
    const recordedHost = record.hostname ?? null;
    if (recordedHost !== null && recordedHost !== os.hostname()) {
      console.warn(`[session-manager] boot: pid ${record.pid} (${record.image}) was recorded by host ${recordedHost}, not this host; leaving it alone`);
      return;
    }

    const startedAfterBoot = new Date(record.startedAt).getTime() > hostBootAt;
    const actualImage = startedAfterBoot ? await getProcessImage(record.pid) : null;
    const imageMatches = actualImage !== null && imagesMatch(record.image, actualImage);

    let reap = false;
    let reason = '';
    if (!startedAfterBoot) {
      reason = "recorded startedAt predates this host's last boot";
    } else if (!imageMatches) {
      reason = `live image is ${actualImage ?? 'unknown'}, not ${record.image}`;
    } else if (record.osCreatedAt === null) {
      reason = 'recorded osCreatedAt is absent';
    } else {
      const liveCreatedAt = await getOsCreatedAt(record.pid);
      if (liveCreatedAt === null) {
        reason = "the live process's creation time could not be read";
      } else if (liveCreatedAt !== record.osCreatedAt) {
        reason = `live creation time is ${liveCreatedAt}, not the recorded ${record.osCreatedAt} — same pid and image, a different process`;
      } else {
        reap = true;
      }
    }

    if (reap) {
      await killProcessTree(record.pid, record.pgid);
    } else {
      console.warn(`[session-manager] boot: not reaping pid ${record.pid} (${record.image}): ${reason}`);
    }
    await supervisor.ledger.tombstonePid(record.pid, nowIso());
  }

  // S7.4/S7.9 (D39): a spill ending on an unpaired `turn.started` is closed on disk —
  // every request still in `pending` when the log ran out resolved
  // `cancelled_process_exit`, then `turn.ended { stopReason: 'server_restart' }` — before
  // boot returns, using the same `emit` a live turn would, so the appended envelopes get
  // real, spill-durable `seq` values continuing from wherever rehydration left off (S7.3).
  async function closeUnterminatedTurn(entry: SessionEntry): Promise<void> {
    let openTurnId: TurnId | null = null;
    const pending = new Map<RequestId, { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }>();

    for await (const result of store.readEventsAfter(entry.record.id, 0)) {
      if (!result.ok) break; // best-effort: an unreadable spill is reported elsewhere, not here
      const envelope = result.value;
      switch (envelope.kind) {
        case 'turn.started':
          openTurnId = (envelope.data as EventPayloadMap['turn.started']).turnId;
          pending.clear();
          break;
        case 'turn.ended':
          openTurnId = null;
          pending.clear();
          break;
        case 'permission.request': {
          const d = envelope.data as EventPayloadMap['permission.request'];
          pending.set(d.requestId, { tool: d.tool, input: d.input });
          break;
        }
        case 'permission.resolved': {
          const d = envelope.data as EventPayloadMap['permission.resolved'];
          pending.delete(d.requestId);
          break;
        }
        default:
          break;
      }
    }

    if (openTurnId === null) return;
    const turnId = openTurnId;

    let anyAuditFailed = false;
    for (const [requestId, p] of pending) {
      await emit(entry, 'permission.resolved', {
        turnId,
        requestId,
        decision: 'deny',
        scope: 'once',
        operator: null,
        reason: 'cancelled_process_exit',
      });
      const appended = await audit.append({
        ts: nowIso(),
        operator: null,
        sessionId: entry.record.id,
        vendor: entry.record.vendor,
        sandbox: entry.record.sandbox,
        tool: p.tool,
        input: p.input,
        decision: 'deny',
        scope: 'once',
        reason: 'cancelled_process_exit',
      });
      if (!appended.ok) anyAuditFailed = true;
    }
    if (anyAuditFailed) {
      await emit(entry, 'session.notice', {
        level: 'error',
        code: 'audit_unavailable',
        text: 'The audit record for one or more cancelled permissions could not be written.',
      });
    }

    await emit(entry, 'turn.ended', { turnId, stopReason: 'server_restart', usage: null });
  }

  const manager: SessionCore = {
    extensions: {
      operations: Object.entries(checkpointExtension.operations).map(([name, { schema, mutates }]) => ({ name, schema, mutates })),
      async invoke(name, id, principal, input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: { code: 'bad_request', field: 'input', detail: 'expected an object' } };
        if (name === 'checkpoints.list' && Object.keys(input).length === 0) return manager.listCheckpoints(id, principal);
        if (name === 'checkpoints.restore' && Object.keys(input).length === 1 && 'sha' in input && typeof input.sha === 'string' && /^[0-9a-f]{40}$/.test(input.sha)) return manager.restore(id, principal, input.sha as GitSha);
        return { ok: false, error: { code: 'bad_request', field: 'operation', detail: 'unknown operation or invalid arguments' } };
      },
    },
    attachments: staging.api,
    async boot() {
      const leased = await store.lease.claim();
      if (!leased.ok) return leased;
      const hostBootAt = Date.now() - os.uptime() * 1000;
      // Step 1 (D23, D38): reap orphaned children before anything is rehydrated, so no
      // rehydrated session can be adopted by an orphan still holding its workspace.
      const openPids = await supervisor.ledger.readOpenPids();
      for (const record of openPids) {
        await reapOne(record, hostBootAt);
      }

      // A5: restore every reservation before callbacks. An unfinished create is
      // not ordinary ended history, even when its session metadata already exists.
      const recovered = await store.createAttempts.readAll();
      if (!recovered.ok) return recovered;
      const pending = new Set(recovered.value.map(a => a.sessionId));
      const committed = new Set<SessionId>();
      for (const attempt of recovered.value) allocation.recoverPending(attempt.sessionId, attempt.cwd, attempt.principal);
      for (const attempt of recovered.value) {
        const state = await recoverHostAttempt(deps.hostCreate, attempt.sessionId, deps.hostAttemptTimeoutMs);
        if (state === 'committed') committed.add(attempt.sessionId);
        else if (state === 'aborted') {
          const cleanup = await destroySessionStorage(attempt.sessionId);
          if (cleanup.destroyed.ok && cleanup.deleted.ok) {
            const released = await releaseCreateAttempt(attempt.sessionId);
            if (released.ok) pending.delete(attempt.sessionId);
          }
        }
        // new/prepared/committing/unavailable are not terminal proof. In
        // particular, a fresh host helper's "new" must never release this claim.
      }

      // D130: which sessions were still `live` on disk when the process went down. Boot
      // marks exactly those with one `session.notice / server_restart` in step 3 — never a
      // session already `ended`, which would append to every dead session's spill on every
      // restart. Local to `boot` rather than a field on the entry: it is true once, here,
      // and a field would invite a later reader to treat it as durable state.
      const liveAtShutdown = new Set<SessionId>();

      // Step 2 (D20, D37, D49): every session comes back `ended`; `lastSeq` is derived
      // from the spill's tail, never trusted off `meta.json`.
      const loaded = await store.readAllMeta();
      for (const { sessionId, result } of loaded) {
        if (!result.ok) {
          // S7.7: a corrupt or newer-than-known meta.json is skipped, logged, and left
          // untouched — one broken session must not deny every other one.
          console.warn(`[session-manager] boot: skipping session ${sessionId}: ${JSON.stringify(result.error)}`);
          continue;
        }
        const record = result.value;
        const quarantined = pending.has(sessionId) && !committed.has(sessionId);
        if (!quarantined && record.state === 'live') liveAtShutdown.add(sessionId);
        const lastSeqResult = await store.readLastSeq(sessionId);
        if (!lastSeqResult.ok) {
          console.warn(`[session-manager] boot: skipping session ${sessionId}: ${JSON.stringify(lastSeqResult.error)}`);
          continue;
        }
        // A session already `ended` on disk keeps its own recorded reason (or `null` if it
        // predates this field). One still `live` on disk never chose to end — boot's
        // `endedAt` for it is synthesised, and #115 wants that told apart from a real end:
        // `'server_restart'` records that the reason is boot itself, not a fabrication of
        // one the session never had.
        const rehydrated: SessionRecord = quarantined ? record : {
          ...record,
          state: 'ended',
          endedAt: record.endedAt ?? nowIso(),
          endReason: record.endedAt === null ? 'server_restart' : (record.endReason ?? null),
          lastSeq: lastSeqResult.value,
        };
        const entry: SessionEntry = {
          record: rehydrated,
          adapter: null,
          turn: null,
          seq: rehydrated.lastSeq as number,
          firstTurnAnnounced: true,
          hasRunATurn: true,
          checkpointsAvailable: false,
          storageFailed: false,
          standingRules: [],
          lane: createLane(), creating: pending.has(sessionId), operation: null,
          subscribers: new Set(),
          writeQueue: Promise.resolve(),
          livePid: null,
          pendingToolOutputWrites: new Set(),
        };
        sessions.set(sessionId, entry);
        // One of the three occasions `store`'s table names: a `state` transition.
        if (!quarantined && record.state === 'live') {
          const written = await store.writeMeta(rehydrated);
          if (!written.ok && pending.has(sessionId)) committed.delete(sessionId);
        }
      }

      // Step 3 (D39): a spill left on an unpaired `turn.started` is closed on disk —
      // every outstanding `permission.request` resolved `cancelled_process_exit`, then
      // `turn.ended { stopReason: 'server_restart' }` — before anything is served, so the
      // ordering guarantees in `20-contract.md § Rules the renderer may rely on` hold
      // unconditionally rather than acquiring a "the transcript might just stop" case.
      for (const entry of sessions.values()) {
        if (entry.creating && !committed.has(entry.record.id)) continue;
        // D130: the restart notice goes in *before* the synthetic close, and the order is
        // the whole of why one rule covers both cases. Where the spill ends on an unpaired
        // `turn.started`, the notice lands inside that still-open turn — so the payroll
        // fold sees no idle interval to drop and attributes the outage to the turn; where
        // the session was idle, it lands after the last `turn.ended` and closes the
        // interval that was genuinely open. A `session.notice` carries no `turnId` and is
        // expressly allowed to fall between a `turn.started` and its `turn.ended`
        // (`20-contract.md § Rules the renderer may rely on`), so this costs the renderer
        // nothing.
        if (liveAtShutdown.has(entry.record.id)) {
          await emit(entry, 'session.notice', {
            level: 'warn',
            code: 'server_restart',
            text: 'The server restarted while this session was live; the session has ended and accepts no new turn.',
          });
        }
        await closeUnterminatedTurn(entry);
        if (entry.creating && !entry.storageFailed) {
          const released = await releaseCreateAttempt(entry.record.id);
          if (released.ok) entry.lane.run(() => { entry.creating = false; });
        }
      }

      return { ok: true, value: undefined };
    },

    events: {
      async append(sessionId, owner, kind, data) {
        const entry = sessions.get(sessionId);
        if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
        if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
        if (entry.creating || entry.operation) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.operation ?? sessionId as unknown as TurnId } };
        const envelope = await emit(entry, kind, data);
        if (!envelope || entry.storageFailed) return { ok: false, error: { code: 'storage', cause: { code: 'io', path: sessionId, detail: 'event append failed' } } };
        return { ok: true, value: envelope };
      },
    },
    admin: {
      readEvents: (id, after = 0) => store.readEventsAfter(id, after),
      readAudit: query => store.readAuditPage(query),
      snapshot: id => { const e = sessions.get(id); return e ? { ...e.record } : null; },
      remove: id => { const e = sessions.get(id); return e ? manager.remove(id, e.record.owner) : Promise.resolve({ ok: false, error: { code: 'not_found', sessionId: id } }); },
      async reassignPrincipal(id, principal) {
        const e = sessions.get(id);
        if (!e) return { ok: false, error: { code: 'not_found', sessionId: id } };
        if (e.turn || e.operation || e.creating) return { ok: false, error: { code: 'turn_in_flight', sessionId: id, turnId: e.turn?.turnId ?? e.operation ?? id as unknown as TurnId } };
        e.lane.run(() => { e.operation = randomUUID() as TurnId; });
        try {
          const record = { ...e.record, owner: principal };
          const written = await store.writeMeta(record);
          if (!written.ok) return { ok: false, error: { code: 'storage', cause: written.error } };
          e.lane.run(() => { e.record = record; });
          allocation.reassign(id, principal);
          staging.discard(id);
          for (const subscriber of e.subscribers) subscriber.close();
          e.subscribers.clear();
          return { ok: true, value: undefined };
        } finally { e.lane.run(() => { e.operation = null; }); }
      },
    },
    listPage(owner, after, limit) {
      const all = manager.list(owner);
      const start = after === null ? 0 : all.findIndex(s => s.id === after) + 1;
      const items = all.slice(start, start + (Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100));
      return { items, next: start + items.length < all.length ? items.at(-1)!.id : null };
    },

    async shutdown(): Promise<void> {
      // D178, I55: set before anything below runs — every notification `handleNotification`
      // would otherwise dispatch, for every session, is dropped from this point on. One-way;
      // nothing clears it, because this manager keeps running no longer than the process does.
      notifyMuted = true;

      // D177: every *live turn's* child tree, not every session — a rehydrated session has
      // `turn: null` and no adapter to kill. `adapter.kill()` reaches the real child through
      // the adapter's own closure state regardless of whether `spawned` ever recorded its pid,
      // so this is never routed through `pids.ndjson` (S27.13).
      //
      // This is one pass over a snapshot, and deliberately so — waiting for every in-flight
      // `message()` to settle is the wait D174-D176 spent the drain bound refusing. The turn
      // that claimed its slot but has not yet reached `adapter.send()` therefore meets a
      // `kill()` with no child to kill; its child is caught at the sink instead, when the
      // `spawned` it would have recorded arrives behind the mute (D198, S27.9).
      //
      // Each session is caught on its own, which is what "best-effort" has to mean once
      // there is more than one of them: an unguarded `Promise.all` rejects on the first
      // failure, so one session's throwing `kill()` would abandon every other session's
      // tombstone *and* reject a method that carries no error union — and `server.ts` runs
      // the lock release behind this await (D175). S27.11 covers a `tombstonePid` returning
      // `{ ok: false }`; this covers the throw it cannot express.
      await Promise.all(
        [...sessions.values()]
          .filter((entry) => entry.turn !== null)
          .map(async (entry) => {
            try {
              // D178: the pid this server recorded for the turn at `spawned` — `null` when
              // no child had spawned yet, in which case `kill()` is a no-op and nothing is
              // owed.
              const pid = entry.livePid;
              await entry.adapter!.kill();
              if (pid === null) return;
              // Best-effort like the lock release: a lost tombstone leaves `pids.ndjson`
              // recording a dead pid as live, and D23's reuse guard tombstones it at the next
              // boot instead (S27.11) — logged rather than raised, since shutdown gains no
              // error union.
              const tombstoned = await supervisor.ledger.tombstonePid(pid, nowIso());
              if (!tombstoned.ok) {
                console.warn(`[session-manager] shutdown: failed to tombstone pid ${pid}: ${JSON.stringify(tombstoned.error)}`);
              }
            } catch (err) {
              console.warn(`[session-manager] shutdown: session ${entry.record.id} could not be torn down: ${String(err)}`);
            }
          }),
      );
    },

    async create(owner, input) {
      // The model string lands on the vendor argv, which Windows may pass through a
      // shell; a shell never sees anything outside this charset, so refusal here keeps
      // metacharacters out of every adapter rather than each escaping them itself.
      if (input.model !== null && !/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/.test(input.model)) {
        return { ok: false, error: { code: 'bad_request', field: 'model', detail: 'model may contain only letters, digits, and . : / _ -' } };
      }

      const jailed = await resolveInsideRoot(input.cwd, config.workspaceRoots);
      if (!jailed.ok) return { ok: false, error: { code: 'jail', cause: jailed.error } };
      const cwd = jailed.value;

      const sessionId = randomUUID() as SessionId;
      const overlap = allocation.reserve(sessionId, cwd, owner);
      if (overlap) return { ok: false, error: { code: 'workspace_busy', holder: { cwd: overlap.cwd, owner: overlap.principal } } };
      // A5's internal recovery record is durable before any host side effect.
      // No allocation guard is held while this I/O or the host callbacks run.
      const savedAttempt = await store.createAttempts.write({ sessionId, principal: owner, cwd });
      if (!savedAttempt.ok) { allocation.release(sessionId); return { ok: false, error: { code: 'storage', cause: savedAttempt.error } }; }
      // Host code runs after the allocation guard has released.
      checkpointExtension.hooks.beforeCreate();
      const prepared = await hostCreate.prepare(sessionId, owner, input.hostData);
      if (!prepared.ok) { await hostCreate.abort(sessionId); await releaseCreateAttempt(sessionId); return { ok: false, error: { code: 'host_create', cause: prepared.error } }; }
      const pendingNotifications: AdapterNotification[] = [];
      let registered = false;
      let adapterResult: Result<Adapter, AdapterError>;
      try {
        adapterResult = await adapterFactory(input.vendor, {
          cwd,
          model: input.model,
          sandbox: input.sandbox,
          notify: (n) => {
            if (registered) handleNotification(sessionId, n);
            else pendingNotifications.push(n);
          },
          streamDeltas: config.streamDeltas,
        });
      } catch (error) {
        adapterResult = { ok: false, error: { code: 'agent_unavailable', image: input.vendor, detail: String(error) } };
      }
      if (notifyMuted && adapterResult.ok) {
        await adapterResult.value.kill();
        await hostCreate.abort(sessionId);
        await releaseCreateAttempt(sessionId);
        return { ok: false, error: { code: 'adapter', cause: { code: 'agent_unavailable', image: input.vendor, detail: 'server is shutting down' } } };
      }
      if (!adapterResult.ok) {
        // S13.9: any failure after the claim releases it — the requisition reads
        // `approved` again and a retry can spend it.
        await hostCreate.abort(sessionId);
        await releaseCreateAttempt(sessionId);
        return { ok: false, error: { code: 'adapter', cause: adapterResult.error } };
      }

      const record: SessionRecord = {
        id: sessionId,
        owner,
        vendor: input.vendor,
        cwd,
        model: input.model,
        policy: adapterResult.value.policy,
        sandbox: input.sandbox,
        cliSessionId: null,
        lastSeq: 0,
        state: 'live',
        createdAt: nowIso(),
        endedAt: null,
        endReason: null,
      };

      const entry: SessionEntry = {
        record,
        adapter: adapterResult.value,
        turn: null,
        seq: 0,
        firstTurnAnnounced: false,
        hasRunATurn: false,
        checkpointsAvailable: true,
        storageFailed: false,
        standingRules: [],
        lane: createLane(), creating: true, operation: null,
        subscribers: new Set(),
        writeQueue: Promise.resolve(),
        livePid: null,
        pendingToolOutputWrites: new Set(),
      };
      sessions.set(sessionId, entry);
      const created = await store.createSession(record);
      if (!created.ok) {
        sessions.delete(sessionId);
        await hostCreate.abort(sessionId);
        await entry.adapter!.kill();
        const cleanup = await destroySessionStorage(sessionId);
        if (cleanup.destroyed.ok && cleanup.deleted.ok) await releaseCreateAttempt(sessionId);
        return { ok: false, error: { code: 'storage', cause: created.error } };
      }

      registered = true;
      for (const notification of pendingNotifications) handleNotification(sessionId, notification);

      // S6.8: a ckpt.git that cannot be initialised is a warning, not a session-creation
      // failure — the session is created and usable without checkpoints.
      const initialised = await checkpointExtension.hooks.afterCreate(sessionId, cwd);
      if (!initialised.ok) {
        entry.checkpointsAvailable = false;
        await emit(entry, 'session.notice', {
          level: 'warn',
          code: 'checkpoints_unavailable',
          text: `checkpoints could not be initialised for this session: ${checkpointErrorDetail(initialised.error)}`,
        });
      }

      const committed = await hostCreate.commit(sessionId);
      if (!committed.ok) {
        if (committed.error === 'create_outcome_unknown') return { ok: false, error: { code: 'create_outcome_unknown', sessionId } };
        await hostCreate.abort(sessionId);
        sessions.delete(sessionId);
        const cleanup = await destroySessionStorage(sessionId);
        await entry.adapter!.kill();
        if (cleanup.destroyed.ok && cleanup.deleted.ok) await releaseCreateAttempt(sessionId);
        return { ok: false, error: { code: 'host_create', cause: committed.error } };
      }
      const published = await store.createAttempts.remove(sessionId);
      if (!published.ok) return { ok: false, error: { code: 'storage', cause: published.error } };
      entry.lane.run(() => { entry.creating = false; });
      allocation.activate(sessionId);
      return { ok: true, value: { sessionId } };
    },

    list(owner) {
      const out: SessionSummary[] = [];
      for (const entry of sessions.values()) {
        // A5: pending/indeterminate host commits are recovery state, not sessions
        // an ordinary caller may treat as successfully created. Keep the entry and
        // its allocation intact; confirmed commit alone clears `creating`.
        if (entry.creating || entry.record.owner !== owner) continue;
        out.push(toSummary(entry.record));
      }
      return out;
    },

    get(sessionId, owner) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.creating || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      return { ok: true, value: toSummary(entry.record) };
    },

    async send(sessionId, owner, text, attachments, model) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
      if (entry.creating || entry.operation) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.operation ?? sessionId as unknown as TurnId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };

      // (D160) Attachment refusals precede claiming the turn slot: nothing is written and
      // no turn starts on a refused message (S21.5, S21.8) — this is deliberately ahead of
      // every `await` below, in the same unbroken block as the checks above (I5).
      if (attachments.length > 0 && !entry.adapter!.acceptsAttachments) {
        return { ok: false, error: { code: 'bad_request', field: 'attachments', detail: "this session's vendor does not accept attachments" } };
      }
      if (attachments.length > config.caps.attachmentCount) {
        return {
          ok: false,
          error: { code: 'bad_request', field: 'attachments', detail: `at most ${config.caps.attachmentCount} attachments are allowed per message` },
        };
      }
      const staged = staging.take(sessionId, owner, attachments);
      if (!staged.ok) return staged;
      const decodedAttachments = staged.value;

      const turnId = randomUUID() as TurnId;
      entry.turn = entry.lane.run(() => entry.turn = { turnId, phase: 'starting', startedAt: nowIso(), pending: new Map() });
      // Every check above this line, and the claim on the line above, completed before the
      // first `await` (I5) — the attachment writes below are async and must run only once
      // the slot is already held, or two concurrent `message()` calls could both pass the
      // `turn_in_flight` check above before either claims it.

      // (D160, I49) Written and fsync'd — `store.writeAttachment`'s contract — before the
      // `message` envelope naming them is constructed below. `attachmentId` is minted here,
      // never the operator's `filename`, which never reaches a path. Each attachment writes
      // a distinct file with no dependency on the others, so the writes run concurrently
      // rather than paying N sequential fsync round trips on the message-send hot path.
      const attachmentPayloads: AttachmentPayload[] = decodedAttachments.map(({ upload, bytes }) => ({
        ref: { attachmentId: randomUUID() as AttachmentId, filename: upload.filename, mediaType: upload.mediaType, bytes: bytes.length },
        data: bytes,
      }));
      // (#203) Staged, and rolled back on any failure before the `message` envelope
      // naming them becomes durable — the emit below is that publication point, and
      // once it succeeds these files are referenced and must never be removed here
      // again. Best-effort: a failure to remove is logged, not surfaced, because the
      // error already being returned is about the write/append that actually failed.
      async function rollbackAttachments(): Promise<void> {
        if (attachmentPayloads.length === 0) return;
        const removed = await store.removeAttachments(sessionId, turnId);
        if (!removed.ok) {
          console.error(
            `[session-manager] session ${sessionId}: failed to roll back staged attachments for turn ${turnId}: ${JSON.stringify(removed.error)}`,
          );
        }
      }

      const writes = await Promise.all(
        attachmentPayloads.map((p) => store.writeAttachment(sessionId, turnId, p.ref.attachmentId, Buffer.from(p.data), p.ref.mediaType)),
      );
      const failedWrite = writes.find((w) => !w.ok);
      if (failedWrite && !failedWrite.ok) {
        // No `turn.started` was ever emitted for this attempt, so there is nothing to
        // close — releasing the slot outright is what lets a retry proceed rather than
        // leaving a phantom claim behind. A sibling attachment that wrote successfully
        // before this one failed is rolled back too — this whole message is refused,
        // not just the attachment whose own write failed.
        await rollbackAttachments();
        entry.turn = null;
        entry.livePid = null;
        return { ok: false, error: { code: 'storage', cause: failedWrite.error } };
      }

      // S6.2/D42: committed while the slot is claimed but before turn.started fires, so
      // checkpoint.created always precedes it in seq order.
      if (entry.checkpointsAvailable) {
        const checkpointed = await checkpointExtension.hooks.beforeTurn(sessionId, entry.record.cwd, turnId);
        if (checkpointed.ok) {
          await emit(entry, 'checkpoint.created', { turnId, sha: checkpointed.value.sha, label: checkpointed.value.label });
        } else {
          await emit(entry, 'session.notice', {
            level: 'warn',
            code: 'checkpoint_skipped',
            text: `the pre-turn checkpoint failed; this turn has no restore point: ${checkpointErrorDetail(checkpointed.error)}`,
          });
        }
      }

      // D41/D100: any `emit` above may have ended the session and cleared the slot this
      // function claimed, because a spill append failed. TypeScript's narrowing of
      // `entry.turn` does not survive that — it is a mutable property another function
      // wrote — so the check is explicit, and it is `session_ended` rather than a throw:
      // that is a documented refusal on this route, and it is precisely what happened.
      // Returning here is also what keeps a child from being spawned into a dead session.
      // (#203) The `message` envelope below is what publishes these attachments; a
      // session-ending failure here means it never will, so the blobs are rolled back.
      if (entry.turn === null) {
        await rollbackAttachments();
        return { ok: false, error: { code: 'session_ended', sessionId } };
      }

      await emit(entry, 'turn.started', { turnId });
      if (entry.turn === null) {
        await rollbackAttachments();
        return { ok: false, error: { code: 'session_ended', sessionId } };
      }
      entry.turn.phase = 'running';

      // The operator's own message, refs only (D160) — this is the durable record S21.2
      // requires: no envelope in `events.ndjson` ever carries attachment bytes.
      await emit(entry, 'message', { turnId, role: 'user', text, attachments: attachmentPayloads.map((p) => p.ref) });
      if (entry.turn === null) {
        // The append itself is what failed here — the reference never became durable,
        // so this is still a rollback case, not the "already published" case above.
        await rollbackAttachments();
        return { ok: false, error: { code: 'session_ended', sessionId } };
      }

      // S4.15/D34: a turn that spawns with no `--resume` on a session that has already
      // run one — because the CLI died before ever reporting `system/init`, leaving
      // `cliSessionId` null — loses conversation context silently unless this says so.
      if (entry.hasRunATurn && entry.record.cliSessionId === null) {
        await emit(entry, 'session.notice', {
          level: 'warn',
          code: 'resume_unavailable',
          text: 'The previous turn ended before its session id was reported; conversation context was not carried forward.',
        });
      }

      // `state === 'ended'` was refused above; only a live session's entry reaches here,
      // and only `create` sets `state: 'live'`, always alongside a real adapter.
      const sendResult = await entry.adapter!.send(text, attachmentPayloads, entry.record.cliSessionId, turnId, model);
      if (!sendResult.ok) {
        // D143/#131: the operator learns why, not just that the turn ended, whenever the
        // cause is the agent CLI being unreachable.
        if (sendResult.error.code === 'agent_unavailable') {
          await emit(entry, 'error', { kind: 'agent_unavailable', message: sendResult.error.detail, fatal: true });
        }
        // D209/I59: `write_failed` is the one `send()` failure that can follow a real
        // spawn — the write racing right behind it, on a child already live and tracked
        // (`spawned` already notified). This Result never reaches the `turn.ended`
        // notification handler that carries every other path's kill (S28.3/S28.9), so
        // it owes the same `Adapter.kill()` here or the tree it just spawned outlives
        // the turn. A `send` that never spawned (e.g. `agent_unavailable`) still has no
        // live child, so this stays the no-op S28.6 already covers.
        await entry.adapter!.kill();
        // The `turn.started` above is already durable; pair it (I14, D39) before
        // freeing the slot, or the log carries an open turn no restart ever repairs.
        await emit(entry, 'turn.ended', { turnId, stopReason: 'error', usage: null });
        entry.turn = null;
        entry.livePid = null;
        return { ok: false, error: { code: 'adapter', cause: sendResult.error } };
      }
      // Set only once the CLI actually spawned: a `send` failure never ran a process, so
      // it must not count as "a turn that could have lost context" for the next one.
      entry.hasRunATurn = true;
      return { ok: true, value: { turnId } };
    },

    async answerPermission(sessionId, owner, answer: PermissionAnswer) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };

      // I43: a standing rule is only ever created where `decision === 'allow'`, `rule`
      // parses, and the named request's `matchTarget` is non-null — every other
      // `scope: 'always'` is `bad_request`, never silently downgraded to `once`. These
      // three checks need no `turn` or pending lookup; the fourth (`matchTarget`) does,
      // and runs after it below, before anything is mutated.
      let rule: StandingRuleExpression | null = null;
      if (answer.scope === 'always') {
        if (answer.rule === null) {
          return { ok: false, error: { code: 'bad_request', field: 'rule', detail: "scope 'always' requires a rule" } };
        }
        const parsed = parseStandingRule(answer.rule as unknown as string, config.caps);
        if (parsed === null) {
          return { ok: false, error: { code: 'bad_request', field: 'rule', detail: 'rule does not parse as a standing-rule expression' } };
        }
        if (answer.decision === 'deny') {
          return { ok: false, error: { code: 'bad_request', field: 'decision', detail: "scope 'always' requires decision 'allow'" } };
        }
        rule = parsed;
      }

      const turn = entry.turn;
      if (!turn) return { ok: true, value: { accepted: false, resolution: null } };
      const pending = turn.pending.get(answer.requestId);
      if (!pending) return { ok: true, value: { accepted: false, resolution: null } }; // already resolved (D33)

      if (rule !== null && pending.matchTarget === null) {
        return { ok: false, error: { code: 'bad_request', field: 'scope', detail: 'no standing rule may be created against a request with no matchTarget' } };
      }

      entry.lane.run(() => { turn.pending.delete(answer.requestId); }); // before any await (D33)

      const record: AuditRecord = {
        ts: nowIso(),
        operator: owner,
        sessionId: entry.record.id,
        vendor: entry.record.vendor,
        sandbox: entry.record.sandbox,
        tool: pending.tool,
        input: pending.input,
        decision: answer.decision,
        scope: rule !== null ? 'always' : 'once',
        reason: answer.reason,
      };

      // I10/S4.6: the audit record is fsync'd (store.appendAudit's contract) before the
      // control_response reaches the child's stdin. A pending request exists only on a
      // live turn, which only a live session (a real adapter) can have — a rehydrated
      // session's `turn` is always null. `permission.resolved` must fire either way, or
      // this answer's own audit record ends up with no paired resolution event (I9).
      const resolution = await finalizeResolution(
        entry,
        turn,
        answer.requestId,
        record,
        { decision: answer.decision, scope: rule !== null ? 'always' : 'once', operator: owner, reason: 'answered' },
        // Held only once its grant is durable — S10.3: never handed to the child (I47),
        // never persisted (D110), and from this point matched against every later
        // request on this session.
        rule !== null ? () => entry.standingRules.push(rule) : undefined,
      );
      return { ok: true, value: { accepted: true, resolution } };
    },

    async interrupt(sessionId, owner, turnId) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };

      // S5.3: a statement about a desired end state, not a command that can arrive too
      // late — a session with no live turn, or a `turnId` that no longer names it,
      // no-ops rather than erroring.
      if (!entry.turn || entry.turn.turnId !== turnId) return { ok: true, value: undefined };

      // What `turn.ended` this produces, and resolving every outstanding
      // `permission.request` as `cancelled_process_exit`, both follow from the child's
      // own `exited` notification once `kill` reaches it (S5.1, S5.4) — the same path
      // an unexpected crash already takes, and the vendor adapter is what tells the two
      // apart for `stopReason`.
      // A live turn (checked above) exists only on a live session, which always has a
      // real adapter — a rehydrated session's `turn` is always null.
      await entry.adapter!.kill();
      return { ok: true, value: undefined };
    },

    async end(sessionId, owner) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      if (entry.creating || entry.operation) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.operation ?? sessionId as unknown as TurnId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };
      // Already ended (a rehydrated session, or a repeat `/end` call): a no-op, not a
      // second `endedAt`/`session.ended` — the documented error set for this route has
      // no `session_ended`, which only makes sense if a repeat call is safely inert.
      if (entry.record.state === 'ended') return { ok: true, value: undefined };

      entry.lane.run(() => {
        entry.record.state = 'ended';
        entry.record.endedAt = nowIso();
        entry.record.endReason = 'operator';
      });
      staging.discard(sessionId);
      allocation.release(sessionId);
      // Best-effort, matching the 'cli-session' notification handler below: `/end`'s
      // only refusals are `bad_origin`, `no_such_session` and `turn_in_flight` (no 500),
      // so a failed rewrite does not block the state transition that already freed the
      // workspace (S5.6) — the in-memory record, which `findLiveOverlap` reads, is
      // already `ended` regardless of whether the disk copy caught up.
      await store.writeMeta(entry.record);
      await emit(entry, 'session.ended', { reason: 'operator', endedAt: entry.record.endedAt! });
      return { ok: true, value: undefined };
    },

    async remove(sessionId, owner) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      if (entry.creating || entry.operation) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.operation ?? sessionId as unknown as TurnId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };

      // #200: a tool-output write started by a turn that has since ended can still be in
      // flight — `entry.turn` being null (checked above) proves nothing about it. Draining
      // here, before storage is torn down, is what keeps a late write from recreating the
      // session directory `store.deleteSession` is about to remove (the store's own
      // `writeToolOutput` recursively makes its parent directories, same as any other
      // write). A failed write already logged itself at the call site and settles the same
      // as a successful one, so this never hangs on one.
      entry.lane.run(() => { entry.operation = randomUUID() as TurnId; });
      await Promise.all(entry.pendingToolOutputWrites);
      await entry.writeQueue;

      // S6.10: ckpt.git comes out alongside everything else `store.deleteSession`
      // already owns removing — see `destroySessionStorage`'s comment for the ordering.
      // Any failure from either still folds into the same non-fatal notice below (S5.11).
      const { destroyed, deleted } = await destroySessionStorage(sessionId);
      // S5.11: the registry entry comes out regardless of whether storage cleanup fully
      // succeeded — a partial failure must not leave a session an operator asked to
      // remove still listed.
      sessions.delete(sessionId);
      staging.discard(sessionId);
      allocation.release(sessionId);
      // I2: the spill this ring is supposed to be a suffix of is gone, so the ring must go
      // with it — otherwise a deleted session's envelopes stay in memory for the life of
      // the process, and `dropRing` is a `SessionStore` primitive nothing ever calls.
      store.dropRing(sessionId);

      const failures: string[] = [];
      if (!deleted.ok) {
        failures.push(deleted.error.code === 'io' ? `${deleted.error.path}: ${deleted.error.detail}` : deleted.error.code);
      }
      if (!destroyed.ok) {
        failures.push(`ckpt.git: ${checkpointErrorDetail(destroyed.error)}`);
      }

      if (failures.length > 0) {
        entry.seq += 1;
        const notice: Envelope = {
          seq: entry.seq as Seq,
          sessionId: entry.record.id,
          ts: nowIso(),
          kind: 'error',
          data: { kind: 'session_delete_incomplete', message: `session storage could not be fully removed: ${failures.join('; ')}`, fatal: false },
        } as Envelope;
        // Delivered live only: the session (and, on a happy path, its spill) is already
        // gone from the registry by the time this fires, so there is nothing left to
        // replay it from — a subscriber still attached is the only audience left (S5.11).
        for (const sub of entry.subscribers) sub.deliver(notice);
      }

      return { ok: true, value: undefined };
    },
    async listCheckpoints(sessionId, owner): Promise<Result<readonly Checkpoint[], SessionError>> {
      const entry = sessions.get(sessionId);
      if (!entry || entry.creating || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      const listed = await checkpointExtension.operations['checkpoints.list'].run(sessionId, entry.record.cwd);
      if (!listed.ok) return { ok: false, error: { code: 'checkpoint', cause: listed.error } };
      return { ok: true, value: listed.value };
    },

    async restore(sessionId, owner, sha) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      // A rehydrated session has no adapter and its cwd may already be reclaimed by a
      // new live session (ended sessions hold no allocation) — restoring
      // into it would run a git checkout against a workspace this entry no longer owns.
      if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
      // S6.5/D17: restore is a second consumer of the single-writer turn-slot invariant,
      // alongside `POST /message` — claimed synchronously here, before the first `await`
      // (I5), the same way `message()` claims it, so a concurrent `message()` or a second
      // `restore()` can never interleave its own git operations with this one.
      if (entry.creating || entry.operation) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.operation ?? sessionId as unknown as TurnId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };
      // Restore claims an operation id for the busy-slot error, without creating a
      // visible turn or spawning a child.
      const conflict = allocation.exclusive(sessionId);
      if (conflict) return { ok: false, error: { code: 'workspace_busy', holder: { cwd: conflict.cwd, owner: conflict.principal } } };
      entry.lane.run(() => { entry.operation = randomUUID() as TurnId; });

      try {
        const restored = await checkpointExtension.operations['checkpoints.restore'].run(sessionId, entry.record.cwd, sha);
        if (!restored.ok) {
          if (restored.error.code === 'restore_incomplete') {
            await emit(entry, 'error', {
              kind: 'checkpoint_restore_failed',
              message: `restore to ${sha} failed part-way: ${restored.error.detail}`,
              fatal: false,
            });
            // D31/S6.11: the safety checkpoint was already committed before this failure —
            // announce it so the client's list picks it up even though the restore itself
            // did not complete; `list()` returns newest-first, so the safety commit is its
            // first entry.
            const listed = await checkpoints.list(sessionId, entry.record.cwd);
            const safety = listed.ok ? listed.value[0] : undefined;
            if (safety) await emit(entry, 'checkpoint.created', { turnId: null, sha: safety.sha, label: safety.label });
          }
          return { ok: false, error: { code: 'checkpoint', cause: restored.error } };
        }

        // D31: `turnId: null` is CheckpointCreated's discriminator for the safety
        // checkpoint restore always takes first.
        await emit(entry, 'checkpoint.created', { turnId: null, sha: restored.value.safety.sha, label: restored.value.safety.label });
        return { ok: true, value: restored.value };
      } finally {
        entry.lane.run(() => { entry.operation = null; });
        allocation.releaseExclusive(sessionId);
      }
    },

    async openToolOutput(sessionId, owner, turnId, callId) {
      // S9.3/I23/D43: the ownership check is the same as every other session route —
      // another operator gets `no_such_session`, not a distinguishable `no_such_output`
      // that would confirm the session exists.
      const entry = sessions.get(sessionId);
      if (!entry || entry.creating || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      const opened = await store.openToolOutput(sessionId, turnId, callId);
      if (!opened.ok) return { ok: false, error: { code: 'storage', cause: opened.error } };
      return { ok: true, value: opened.value };
    },

    async openAttachment(sessionId, owner, turnId, attachmentId) {
      // (D160) Same ownership check as `openToolOutput` (S21.7).
      const entry = sessions.get(sessionId);
      if (!entry || entry.creating || entry.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      const opened = await store.openAttachment(sessionId, turnId, attachmentId);
      if (!opened.ok) return { ok: false, error: { code: 'storage', cause: opened.error } };
      return { ok: true, value: opened.value };
    },

    async subscribe(sessionId, owner, after, sink: SubscriberSink): Promise<Result<Subscription, SessionError>> {
      const found = sessions.get(sessionId);
      if (!found || found.creating || found.record.owner !== owner) return { ok: false, error: { code: 'not_found', sessionId } };
      const entry = found; // captured once so closures below narrow past `| undefined`
      const receiver = sink;
      let active = true;
      sink = {
        deliver(event) { if (active && entry.record.owner === owner) receiver.deliver(event); },
        close() { if (active) { active = false; receiver.close(); } },
      };

      // A gap is not an event: `emit` never produces one, it consumes no `seq`, it is
      // never appended to the spill, and it goes to a single subscriber. So it restates
      // the watermark that subscriber is complete *through* rather than claiming a new
      // position. Stamping it with `entry.seq` instead would tell the client it holds
      // history it never received, and — because the edge writes `seq` as the SSE `id:` —
      // would make that the resume point of the next reconnect, turning one reported gap
      // into permanent silent loss (I1).
      const gapEnvelope = (through: number, message: string): Envelope => ({
        seq: through as Seq,
        sessionId: entry.record.id,
        ts: nowIso(),
        kind: 'error',
        data: { kind: 'replay_gap', message, fatal: false },
      } as Envelope);

      // A resume point past the end of this session's history is unservable by
      // construction: no store holds it, and waiting for `seq` to climb to it would
      // stream nothing forever. Reporting it as a gap is what makes the client refetch
      // rather than sit on a silently empty transcript.
      if ((after as number) > entry.record.lastSeq) {
        entry.subscribers.add(sink);
        sink.deliver(gapEnvelope(entry.record.lastSeq, 'the resume point is past the end of this session'));
        return { ok: true, value: { close: () => entry.subscribers.delete(sink) } };
      }

      // The ring is checked first because it answers synchronously: `pushRing` and
      // `emit`'s fan-out share one synchronous prefix (I27), so reading the ring and
      // registering the subscriber in the same synchronous block can never straddle a
      // live envelope arriving in between (D18's "buffer appended before fan-out").
      const ringResult = store.readRingAfter(sessionId, after);
      if (ringResult !== null) {
        entry.subscribers.add(sink);
        for (const envelope of ringResult) sink.deliver(envelope);
        return { ok: true, value: { close: () => entry.subscribers.delete(sink) } };
      }

      // The ring cannot serve this range (D40): replay from the spill instead. That read
      // is async I/O, so a live envelope can arrive mid-replay — a proxy subscriber is
      // registered first to buffer anything that lands while the file is being read,
      // which is then reconciled against the replay's watermark and flushed once the
      // spill catches up, before switching to direct passthrough for the live stream.
      const highWater = config.caps.subscriberQueueHighWater;
      let mode: 'buffering' | 'live' = 'buffering';
      let dropped = false;
      // Declared above the proxy because the drop path reports the gap against it too:
      // what a dropped subscriber is complete through is whatever the replay had reached.
      let replayedThrough = after as number;
      const buffered: Envelope[] = [];
      const proxy: SubscriberSink = {
        deliver(envelope) {
          if (dropped) return;
          if (mode === 'live') {
            sink.deliver(envelope);
            return;
          }
          // (D168, I51) A frame has no `seq` and is never replayed — a subscriber still
          // catching up from the ring or the spill is, for a frame's purposes, no
          // different from one that has to reconnect: it receives no deltas for a
          // message already in flight and renders the `message` when it lands. Buffering
          // it here (or counting it against `highWater`, which exists to bound how much
          // *replayable* history a slow catch-up can pile up) would hold onto something
          // this subscriber's live pass-through below can never legitimately flush.
          if (isFrame(envelope)) return;
          if (buffered.length >= highWater) {
            dropped = true;
            entry.subscribers.delete(proxy);
            sink.deliver(gapEnvelope(replayedThrough, 'too many envelopes arrived while catching up from storage'));
            sink.close();
            return;
          }
          buffered.push(envelope);
        },
        close() {
          sink.close();
        },
      };
      entry.subscribers.add(proxy);

      // The durable append is asynchronous and only chained, not synchronous, with the
      // live fan-out above (I27): an envelope already delivered to every other subscriber
      // can still be in flight to disk. Reading the spill before that flush lands would
      // see a file genuinely short of what this subscriber's own registration already
      // promises it — and, since that envelope already had its one-time live fan-out
      // before this subscriber existed, it would never arrive by the live path either.
      // Awaiting the write queue captured at registration is what closes that window.
      await entry.writeQueue;

      // The spill's seq contiguity is what tells a torn *middle* line apart from a torn
      // *trailing* one (S3.3, S3.6): a gap between what was just delivered and what comes
      // next is reported once; a torn line with nothing after it to compare against never
      // trips this and is silently short, per `store`'s own drop-and-log.
      for await (const result of store.readEventsAfter(sessionId, after)) {
        if (dropped) break;
        if (!result.ok) {
          const detail = 'detail' in result.error ? result.error.detail : result.error.code;
          sink.deliver(gapEnvelope(replayedThrough, `replay from storage failed: ${detail}`));
          break;
        }
        const envelope = result.value;
        if (envelope.seq !== replayedThrough + 1) {
          sink.deliver(gapEnvelope(replayedThrough, 'the recorded history has a gap before this point'));
          break;
        }
        sink.deliver(envelope);
        replayedThrough = envelope.seq;
      }

      if (!dropped) {
        mode = 'live';
        for (const envelope of buffered) {
          if (envelope.seq > replayedThrough) {
            sink.deliver(envelope);
            replayedThrough = envelope.seq;
          }
        }
        buffered.length = 0;
      }

      return { ok: true, value: { close: () => entry.subscribers.delete(proxy) } };
    },
  };

  // Shared by `answerPermission` and `resolvePreapproved`: persist the audit record,
  // then respond to the adapter and emit `permission.resolved` — on an audit-append
  // failure this denies regardless of what was decided and reports `audit_unavailable`
  // (S4.7/I9), otherwise it reports `success`. `onDurable` runs once the record is
  // durable but before the child is answered, which is where `answerPermission` holds a
  // newly-created standing rule (I43) — a grant that was never durably recorded must not
  // start auto-approving.
  async function finalizeResolution(
    entry: SessionEntry,
    turn: Turn,
    requestId: RequestId,
    record: AuditRecord,
    success: { decision: PermissionDecision; scope: ResolvedScope; operator: PrincipalId | null; reason: PermissionResolvedReason },
    onDurable?: () => void,
  ): Promise<EventPayloadMap['permission.resolved']> {
    const appended = await audit.append(record);
    if (!appended.ok) {
      const resolution = await respondOrCancel(entry, turn, requestId, record, 'deny', {
        turnId: turn.turnId,
        requestId,
        decision: 'deny',
        scope: 'once',
        operator: null,
        reason: 'audit_unavailable',
      });
      await emit(entry, 'session.notice', {
        level: 'error',
        code: 'audit_unavailable',
        text: 'The audit record could not be written; the tool call was denied.',
      });
      return resolution;
    }

    onDurable?.();
    return respondOrCancel(entry, turn, requestId, record, success.decision, {
      turnId: turn.turnId,
      requestId,
      decision: success.decision,
      scope: success.scope,
      operator: success.operator,
      reason: success.reason,
    });
  }

  // D213: `respond`'s `write_failed` means the child's stdin closed out from under this
  // answer — the same race `send` hits right behind a spawn (D209/I59), but here the
  // request was already removed from `turn.pending` (D33, before `finalizeResolution`
  // runs), so the `exited` notification's own cancellation sweep can never reach it. This
  // is the one place left to turn it into the `cancelled_process_exit` resolution
  // `20-contract.md`'s `AdapterError.write_failed` row promises, instead of emitting the
  // `intended` event/record as if the child had actually received it. `no_child` means the
  // child was already gone before this call reached the adapter — the exited sweep already
  // ran, or is racing to — so nothing new is owed here (the `AdapterError.no_child` row).
  async function respondOrCancel(
    entry: SessionEntry,
    turn: Turn,
    requestId: RequestId,
    record: AuditRecord,
    decision: PermissionDecision,
    intended: EventPayloadMap['permission.resolved'],
  ): Promise<EventPayloadMap['permission.resolved']> {
    const responded = entry.adapter!.respond(requestId, decision);
    if (!responded.ok) {
      const resolution: EventPayloadMap['permission.resolved'] = { turnId: turn.turnId, requestId, decision: 'deny', scope: 'once', operator: null, reason: 'cancelled_process_exit' };
      if (responded.error.code === 'write_failed') {
        const cancelled = await audit.append({
          ts: nowIso(),
          operator: null,
          sessionId: record.sessionId,
          vendor: record.vendor,
          sandbox: record.sandbox,
          tool: record.tool,
          input: record.input,
          decision: 'deny',
          scope: 'once',
          reason: 'cancelled_process_exit',
        });
        await emit(entry, 'permission.resolved', {
          turnId: turn.turnId,
          requestId,
          decision: 'deny',
          scope: 'once',
          operator: null,
          reason: 'cancelled_process_exit',
        });
        if (!cancelled.ok) {
          await emit(entry, 'session.notice', {
            level: 'error',
            code: 'audit_unavailable',
            text: 'The audit record for a permission cancelled by process exit could not be written.',
          });
        }
      }
      return resolution;
    }
    await emit(entry, 'permission.resolved', intended);
    return intended;
  }

  // S10.4: the server's own decision for a request matched against a standing rule.
  // Mirrors `answerPermission`'s happy/audit-failure paths via `finalizeResolution`, but
  // the operator is `null` throughout and the grant behind it was already durable when
  // the rule was created — there is nothing left to validate here, only to record and
  // answer.
  async function resolvePreapproved(entry: SessionEntry, turn: Turn, request: PermissionRequest, matched: StandingRuleExpression): Promise<void> {
    if (!turn.pending.has(request.requestId)) return; // already resolved by a race
    turn.pending.delete(request.requestId);

    // 20-contract.md § Audit record: on `scope === 'standing'`, `reason` carries the
    // matched `StandingRuleExpression` verbatim — the only place it holds anything but
    // the operator's free-text reason. The caller already found it while deciding to
    // auto-approve; re-scanning `entry.standingRules` here would repeat that match.
    const record: AuditRecord = {
      ts: nowIso(),
      operator: null,
      sessionId: entry.record.id,
      vendor: entry.record.vendor,
      sandbox: entry.record.sandbox,
      tool: request.tool,
      input: request.input,
      decision: 'allow',
      scope: 'standing',
      reason: matched,
    };

    await finalizeResolution(entry, turn, request.requestId, record, {
      decision: 'allow',
      scope: 'standing',
      operator: null,
      reason: 'preapproved',
    });
  }

  function handleNotification(sessionId: SessionId, n: AdapterNotification): void {
    if (notifyMuted) {
      // D178, I55: nothing below this line runs, which is why a child spawning here gets
      // no `pids.ndjson` entry and is owed no tombstone (S27.9). For `event`, `cli-session`
      // and `exited` silence is the whole answer. `spawned` is the one kind that still owes
      // an action, because shutdown's kill pass is a single snapshot taken before this
      // child existed: `message()` had claimed the turn slot but had not yet reached
      // `adapter.send()`, so `entry.adapter.kill()` no-opped against a null child and
      // nothing sweeps again. Without this the process outlives the server — the orphan
      // S27 exists to prevent, in the one race it is hardest to see.
      //
      // The pid comes from the notification rather than from the adapter, and the kill is
      // boot's reap kill rather than `adapter.kill()`, so `Adapter` gains nothing here
      // (D178). It writes nothing, resolves nothing and emits nothing, so I52 holds; and
      // no handler runs, so I55 holds in the sense it is stated for — the sink acts, the
      // handlers below it do not.
      if (n.kind === 'spawned') {
        // The pid is the only witness this leaves: with `pids.ndjson` deliberately
        // untouched and every envelope suppressed, an operator reading the shutdown log
        // would otherwise have no record that a child was created and killed during
        // teardown. S27.9 asserts against this line for the same reason.
        console.warn(`[session-manager] shutdown: pid ${n.pid} (${n.image}) spawned behind the mute; killing it and recording nothing`);
        // The adapters report `proc.pid ?? -1` for a child whose pid Node never assigned,
        // and `killProcessTree` negates what it is given: `-1` would arrive at the kernel
        // as a `SIGKILL` to pid 1, the container's own entrypoint. Nothing to kill is the
        // one case where doing nothing is right.
        if (n.pid > 0) void killProcessTree(n.pid, n.pgid && n.pgid > 0 ? n.pgid : null);
      }
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) return;
    void handleNotificationAsync(entry, n);
  }

  async function handleNotificationAsync(entry: SessionEntry, n: AdapterNotification): Promise<void> {
    switch (n.kind) {
      case 'cli-session': {
        entry.record.cliSessionId = n.cliSessionId;
        // I64: `emit` must be reached before this handler's first `await` — the
        // `meta.json` write comes after `session.started` is emitted, not before.
        if (!entry.firstTurnAnnounced) {
          entry.firstTurnAnnounced = true;
          await emit(entry, 'session.started', {
            vendor: entry.record.vendor,
            cwd: entry.record.cwd,
            model: entry.record.model,
            policy: entry.record.policy,
            state: 'live',
            createdAt: entry.record.createdAt,
          });
        }
        await store.writeMeta(entry.record); // one of the three occasions store's table names
        return;
      }
      case 'spawned': {
        // D102: a turn-scoped fact arriving with no live turn is an error, never an
        // invented value. A child is only ever spawned from inside `message()`, which
        // holds the slot across `adapter.send` — so a `spawned` with no turn is a state
        // this design says cannot occur, and minting a `TurnId` for it would put an id
        // naming no turn into `pids.ndjson`, where the reaper reads it as fact.
        // `ProcessRecord.turnId` stays non-null; the record is refused instead.
        const turn = entry.turn;
        if (!turn) {
          await emit(entry, 'error', {
            kind: 'adapter_unknown_record',
            message: `a child (pid ${n.pid}, ${n.image}) was reported spawned with no live turn; it is not recorded in pids.ndjson and boot will not reap it`,
            fatal: false,
          });
          return;
        }
        entry.livePid = n.pid;
        // S29.7: a capture failure here costs nothing but the guard — `getOsCreatedAt`
        // already swallows its own failure into `null`, so the child runs and its line is
        // appended exactly as if the read had simply come back empty; no envelope, no
        // notice.
        const osCreatedAt = await getOsCreatedAt(n.pid);
        await supervisor.ledger.appendPid({
          pid: n.pid,
          pgid: n.pgid,
          sessionId: entry.record.id,
          turnId: turn.turnId,
          hostname: os.hostname(),
          startedAt: nowIso(),
          image: n.image,
          osCreatedAt,
          exitedAt: null,
        });
        return;
      }
      case 'exited': {
        // S4.9/D97: the adapter never resolves a permission of its own — it only
        // reports that its child is gone. Deciding every outstanding request is now
        // `cancelled_process_exit`, and owing each one exactly one `AuditRecord`
        // (I11), is the manager's, the same as for an interrupt or a boot-time close.
        //
        // `turn.ended` for this same exit follows as a second, separate notification
        // the adapter sends right after this one (still inside the same synchronous
        // callback), so every cancellation's `seq` must already be assigned before
        // this function next yields — otherwise `turn.ended` could be delivered with
        // an earlier `seq` than a cancellation the criterion requires to precede it.
        // `emit`'s synchronous prefix assigns `seq` the instant it is called, so firing
        // every cancellation's `emit` from a synchronous `.map()` (rather than one at a
        // time inside a `for` loop with an `await` between each) is what keeps that
        // order intact when there is more than one outstanding request.
        const turn = entry.turn;
        if (turn && turn.pending.size > 0) {
          const cancelled = [...turn.pending.entries()];
          turn.pending.clear();
          const emits = cancelled.map(([requestId]) =>
            emit(entry, 'permission.resolved', {
              turnId: turn.turnId,
              requestId,
              decision: 'deny',
              scope: 'once',
              operator: null,
              reason: 'cancelled_process_exit',
            }),
          );
          const audits = cancelled.map(([, pending]) =>
            audit.append({
              ts: nowIso(),
              operator: null,
              sessionId: entry.record.id,
              vendor: entry.record.vendor,
              sandbox: entry.record.sandbox,
              tool: pending.tool,
              input: pending.input,
              decision: 'deny',
              scope: 'once',
              reason: 'cancelled_process_exit',
            }),
          );
          await Promise.all(emits);
          const auditResults = await Promise.all(audits);
          // The decision was already forced to 'deny' by the exit itself, so a failed
          // append cannot change what was resolved on the wire the way it does in
          // `answerPermission` — but I11 still owes one `AuditRecord` per resolution, so
          // a failure here must not pass silently the way an unchecked `Result` would.
          if (auditResults.some((r) => !r.ok)) {
            await emit(entry, 'session.notice', {
              level: 'error',
              code: 'audit_unavailable',
              text: 'The audit record for one or more cancelled permissions could not be written.',
            });
          }
        }
        // Pid tombstoning across a real restart is S7's; not exercised here.
        return;
      }
      case 'event': {
        const { kind, data, raw } = n.event as { kind: EventKind; data: Record<string, unknown>; raw?: unknown };
        const turn = entry.turn;
        // S10.4: a request matching a standing rule this session already holds is
        // auto-answered right after its own `permission.request` is emitted below — it
        // still gets the full request/resolved pair and an audit record, just with no
        // operator in the loop.
        let autoApprove: PermissionRequest | null = null;
        let autoApproveRule: StandingRuleExpression | null = null;
        if (kind === 'permission.request' && turn) {
          const d = data as unknown as {
            requestId: RequestId;
            callId: CallId;
            tool: string;
            input: Readonly<Record<string, unknown>>;
            matchTarget: string | null;
            suggestions: readonly unknown[];
          };
          turn.pending.set(d.requestId, { callId: d.callId, tool: d.tool, input: d.input, matchTarget: d.matchTarget });
          const request: PermissionRequest = {
            turnId: turn.turnId,
            requestId: d.requestId,
            callId: d.callId,
            tool: d.tool,
            input: d.input,
            matchTarget: d.matchTarget,
            suggestions: d.suggestions ?? [],
          };
          const matchedRule = entry.standingRules.find((rule) => match(rule, request)) ?? null;
          if (matchedRule) {
            autoApprove = request;
            autoApproveRule = matchedRule;
          }
        }
        // S9.1: truncated before the envelope naming it is constructed (I3, D22). The
        // adapter always reports the pre-truncation `bytes` and `truncated: false` (S9
        // is explicitly out of its scope) — this is the one place `caps.toolResultBytes`
        // is enforced. A write failure for the untruncated blob does not undo the
        // truncation decision (S9.5): the envelope stays truncated either way, and the
        // fetch route reports the blob missing if the write never landed. The blob write
        // is not awaited here: this handler runs synchronously per notification (no
        // queueing between them), and blocking on disk I/O before `emit` would let a
        // later, unrelated notification for the same turn (e.g. `turn.ended`, which has
        // no await before its own `emit`) claim a lower `seq` than this one (I1, I27).
        let eventData: Record<string, unknown> = data;
        if (kind === 'tool.result' && turn) {
          const d = data as unknown as { callId: CallId; output: string; bytes: number };
          if (d.bytes > config.caps.toolResultBytes) {
            const outputBytes = Buffer.from(d.output, 'utf8');
            const { turnId } = turn;
            // #200: tracked so `remove()` can drain it — see `pendingToolOutputWrites`'s own
            // comment. Still fire-and-forget from the caller's perspective (I27): nothing here
            // awaits `write`, only records it so a later drain can.
            const write = store.writeToolOutput(entry.record.id, turnId, d.callId, outputBytes).then((written) => {
              if (!written.ok) {
                console.warn(
                  `[session-manager] session ${entry.record.id}: failed to write the tool-output blob for ` +
                    `${turnId}/${d.callId}: ${JSON.stringify(written.error)}`,
                );
              }
            });
            const tracked = write.finally(() => entry.pendingToolOutputWrites.delete(tracked));
            entry.pendingToolOutputWrites.add(tracked);
            eventData = { ...d, output: truncateUtf8(outputBytes, config.caps.toolResultBytes), truncated: true };
          }
        }
        // The adapter omits `turnId` from every payload that carries one (contract
        // `AdapterEvent`); the manager, which owns `Turn`, is what stamps it back on.
        //
        // D102: with no live turn there is nothing to stamp, and neither of the two ways
        // out is acceptable — emitting the payload anyway ships an envelope missing a
        // field the contract declares non-optional (and, for `permission.request`, one
        // that never enters `pending` and so is never resolved, against I9), while
        // stamping a remembered id attributes the event to a turn it does not belong to.
        // So the state is reported rather than papered over, with the original in `raw`.
        if (!turn && KINDS_CARRYING_TURN_ID.has(kind)) {
          await emit(
            entry,
            'error',
            {
              kind: 'adapter_unknown_record',
              message: `a ${kind} arrived with no live turn and was dropped; it carries no turnId to attribute it by`,
              fatal: false,
            },
            raw ?? eventData,
          );
          return;
        }
        const payload = turn && KINDS_CARRYING_TURN_ID.has(kind) ? { ...eventData, turnId: turn.turnId } : eventData;
        // (D168, I51) A delta never closes a turn, never carries a permission, and is
        // never spilled — routed through `emitFrame` instead of `emit`, and returned
        // here rather than falling into the `turn.ended`/autoApprove handling below,
        // neither of which a `message.delta` ever triggers.
        if (kind === 'message.delta') {
          emitFrame(entry, kind, payload as never, raw);
          return;
        }
        // Cleared before the event is emitted, not after: `emit` delivers to
        // subscribers synchronously but then awaits the spill write, so a caller
        // reacting to the delivered `turn.ended` (e.g. sending the next message) must
        // already see the slot free — clearing it after `await emit` leaves a window
        // where that caller races the still-pending spill append (S5.1).
        //
        // S28.3/S28.4/S28.9/S28.11 (D184, D201, I59): the tree is surrendered here, on
        // every path that reaches this notification unmuted — normal completion, an
        // adapter reporting a schema mismatch, and an operator's interrupt (whose own
        // `kill()` call already reached it, so this entry is S28.6's no-op) — using the
        // same `Adapter.kill()` `interrupt()` and `shutdown()` already call. This is the
        // manager's own obligation and not one vendor's close handler: it runs
        // regardless of what the adapter that reported this `turn.ended` did on its own.
        // The kill is issued before the slot is cleared and before this envelope is
        // emitted, synchronously in the same call stack as the notification that carried
        // it — before the child's own `close`, which needs a real OS round trip to fire at
        // all (S28.9). It is issued and not awaited ahead of `emit` (I59, D209): I64 needs
        // this handler to reach `emit` before its first `await`, so the kill's completion
        // is awaited only after the envelope has its `seq` (S28.4, D235).
        const killing = kind === 'turn.ended' ? entry.adapter!.kill() : null;
        if (killing) entry.lane.run(() => {
          entry.turn = null;
          entry.livePid = null;
        });
        await emit(entry, kind, payload as never, raw);
        if (killing) { await killing; checkpointExtension.hooks.afterTurn(); }
        if (autoApprove && autoApproveRule && turn) await resolvePreapproved(entry, turn, autoApprove, autoApproveRule);
        return;
      }
    }
  }

  return manager;
}

function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    owner: record.owner,
    vendor: record.vendor,
    cwd: record.cwd,
    model: record.model,
    policy: record.policy,
    sandbox: record.sandbox,
    lastSeq: record.lastSeq,
    state: record.state,
    createdAt: record.createdAt,
    endedAt: record.endedAt,
  };
}

// Re-exported so the throwaway CLI harness can name the type without reaching into
// contract internals it does not otherwise need.
export type { GitSha };
