import { randomUUID } from 'node:crypto';
import { createAdapter } from '../adapters/index.js';
import { pathsOverlap, resolveInsideRoot } from '../jail/index.js';
import type {
  Adapter,
  AdapterNotification,
  CallId,
  Checkpoint,
  ChecklistItemId,
  ChecklistItemState,
  Config,
  Envelope,
  EventKind,
  EventPayloadMap,
  GitSha,
  IsoTimestamp,
  OperatorId,
  PayrollView,
  PermissionAnswer,
  PendingPermission,
  RequestId,
  ResolvedPath,
  Result,
  Seq,
  SessionError,
  SessionId,
  SessionManager,
  SessionRecord,
  SessionSummary,
  StartupError,
  Store,
  Subscription,
  SubscriberSink,
  TurnId,
} from '../contract/index.js';
import type { Checkpoints } from '../contract/index.js';
import type { Records } from '../contract/index.js';

interface TurnState {
  readonly turnId: TurnId;
  phase: 'starting' | 'running';
  readonly pending: Map<RequestId, PendingPermission>;
}

interface SessionEntry {
  record: SessionRecord;
  adapter: Adapter;
  turn: TurnState | null;
  seq: number;
  firstTurnAnnounced: boolean;
  readonly subscribers: Set<SubscriberSink>;
  // I27: there is no lock in this server; `emit`'s synchronous prefix (seq assignment,
  // ring push, subscriber delivery) is the serialisation point. The durable spill write
  // is asynchronous I/O and, left unqueued, can *complete* out of the order its seq was
  // assigned in — this chain is what keeps `events.ndjson` written in seq order despite
  // that.
  writeQueue: Promise<void>;
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

function notImplemented(method: string): never {
  throw new Error(`session-manager.${method} is not implemented before its owning slice`);
}

export function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
  readonly records: Records;
}): SessionManager {
  const { config, store } = deps;
  const sessions = new Map<SessionId, SessionEntry>();

  function findLiveOverlap(candidate: ResolvedPath): SessionEntry | null {
    for (const entry of sessions.values()) {
      if (entry.record.state === 'live' && pathsOverlap(candidate, entry.record.cwd)) return entry;
    }
    return null;
  }

  async function emit<K extends EventKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K], raw?: unknown): Promise<void> {
    entry.seq += 1;
    const envelope = {
      seq: entry.seq as Seq,
      sessionId: entry.record.id,
      ts: nowIso(),
      kind,
      data,
      ...(config.includeRaw && raw !== undefined ? { raw } : {}),
    } as Envelope<K>;
    entry.record.lastSeq = envelope.seq;

    // Ring push and subscriber delivery happen here, synchronously, in seq order —
    // never after an `await`, which is what keeps two envelopes from ever being
    // delivered out of the order their `seq` was assigned in.
    store.pushRing(entry.record.id, envelope as Envelope);
    for (const sub of entry.subscribers) sub.deliver(envelope as Envelope);

    // The durable spill write is I/O and does not resolve in call order on its own;
    // chaining it onto the session's write queue is what keeps `events.ndjson` written
    // in seq order despite that (I1, I27). A spill-append failure is fatal to the
    // session (D41); full recovery is out of this slice's scope, but the session is at
    // least marked so it stops accepting new turns.
    entry.writeQueue = entry.writeQueue.then(async () => {
      const appended = await store.appendEvent(entry.record.id, envelope as Envelope);
      if (!appended.ok) {
        entry.record.state = 'ended';
        entry.record.endedAt = nowIso();
      }
    });
    await entry.writeQueue;
  }

  const manager: SessionManager = {
    async boot(): Promise<Result<void, StartupError>> {
      // Reap, rehydrate and open-turn closure are S7's. S1 has nothing to rehydrate: a
      // fresh process starts with an empty in-memory registry.
      return { ok: true, value: undefined };
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

      // I5: the workspace test and the claim happen in one synchronous block — no
      // `await` between `findLiveOverlap` and `sessions.set` — so two concurrent
      // creates for overlapping cwds cannot both pass the test.
      const overlap = findLiveOverlap(cwd);
      if (overlap) {
        return { ok: false, error: { code: 'workspace_busy', holder: { cwd: overlap.record.cwd, owner: overlap.record.owner } } };
      }

      const sessionId = randomUUID() as SessionId;
      const adapterResult = createAdapter(input.vendor, {
        cwd,
        model: input.model,
        sandbox: input.sandbox,
        notify: (n) => handleNotification(sessionId, n),
      });
      if (!adapterResult.ok) return { ok: false, error: { code: 'adapter', cause: adapterResult.error } };

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
      };

      const entry: SessionEntry = {
        record,
        adapter: adapterResult.value,
        turn: null,
        seq: 0,
        firstTurnAnnounced: false,
        subscribers: new Set(),
        writeQueue: Promise.resolve(),
      };
      sessions.set(sessionId, entry);

      const created = await store.createSession(record);
      if (!created.ok) {
        sessions.delete(sessionId);
        return { ok: false, error: { code: 'storage', cause: created.error } };
      }

      // Checkpoints (S6) and requisition attachment (S13) are not this slice's.

      return { ok: true, value: { sessionId } };
    },

    list(owner) {
      const out: SessionSummary[] = [];
      for (const entry of sessions.values()) {
        if (entry.record.owner !== owner) continue;
        out.push(toSummary(entry.record));
      }
      return out;
    },

    get(sessionId, owner) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      return { ok: true, value: toSummary(entry.record) };
    },

    async message(sessionId, owner, text) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };

      const turnId = randomUUID() as TurnId;
      entry.turn = { turnId, phase: 'starting', pending: new Map() };
      // Every check above this line completed before the first `await` (I5).

      await emit(entry, 'turn.started', { turnId });
      entry.turn.phase = 'running';

      const sendResult = await entry.adapter.send(text, entry.record.cliSessionId, turnId);
      if (!sendResult.ok) {
        // The `turn.started` above is already durable; pair it (I14, D39) before
        // freeing the slot, or the log carries an open turn no restart ever repairs.
        await emit(entry, 'turn.ended', { turnId, stopReason: 'error', usage: null });
        entry.turn = null;
        return { ok: false, error: { code: 'adapter', cause: sendResult.error } };
      }
      return { ok: true, value: { turnId } };
    },

    async answerPermission(sessionId, owner, answer: PermissionAnswer) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      const turn = entry.turn;
      if (!turn) return { ok: true, value: { accepted: false } };
      const pending = turn.pending.get(answer.requestId);
      if (!pending) return { ok: true, value: { accepted: false } }; // already resolved (D33)
      turn.pending.delete(answer.requestId);

      // The audit trail (I10, I11) and standing-rule matching (D35) are S4's and S10's.
      // This slice's harness needs only enough to unblock the turn and record the
      // outcome on the wire.
      const responded = entry.adapter.respond(answer.requestId, answer.decision);
      if (!responded.ok) return { ok: false, error: { code: 'adapter', cause: responded.error } };

      await emit(entry, 'permission.resolved', {
        turnId: turn.turnId,
        requestId: answer.requestId,
        decision: answer.decision,
        scope: 'once',
        operator: owner,
        reason: 'answered',
      });
      return { ok: true, value: { accepted: true } };
    },

    async interrupt() {
      notImplemented('interrupt');
    },
    async end() {
      notImplemented('end');
    },
    async remove() {
      notImplemented('remove');
    },
    async listCheckpoints(): Promise<Result<readonly Checkpoint[], SessionError>> {
      notImplemented('listCheckpoints');
    },
    async restore() {
      notImplemented('restore');
    },
    async openToolOutput() {
      notImplemented('openToolOutput');
    },

    async subscribe(sessionId, owner, after, sink: SubscriberSink): Promise<Result<Subscription, SessionError>> {
      const found = sessions.get(sessionId);
      if (!found || found.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      const entry = found; // captured once so closures below narrow past `| undefined`

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

    async payroll(): Promise<Result<PayrollView, SessionError>> {
      notImplemented('payroll');
    },
    async checklist(): Promise<Result<readonly ChecklistItemState[], SessionError>> {
      notImplemented('checklist');
    },
    async tickChecklistItem() {
      notImplemented('tickChecklistItem');
    },
  };

  function handleNotification(sessionId: SessionId, n: AdapterNotification): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    void handleNotificationAsync(entry, n);
  }

  async function handleNotificationAsync(entry: SessionEntry, n: AdapterNotification): Promise<void> {
    switch (n.kind) {
      case 'cli-session': {
        entry.record.cliSessionId = n.cliSessionId;
        await store.writeMeta(entry.record); // one of the three occasions store's table names
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
        return;
      }
      case 'spawned': {
        await store.appendPid({
          pid: n.pid,
          pgid: n.pgid,
          sessionId: entry.record.id,
          turnId: entry.turn?.turnId ?? (randomUUID() as TurnId),
          startedAt: nowIso(),
          image: n.image,
          exitedAt: null,
        });
        return;
      }
      case 'exited':
        return; // pid tombstoning across a real restart is S7's; not exercised here
      case 'event': {
        const { kind, data, raw } = n.event as { kind: EventKind; data: Record<string, unknown>; raw?: unknown };
        const turn = entry.turn;
        if (kind === 'permission.request' && turn) {
          const d = data as unknown as { requestId: RequestId; callId: CallId; tool: string; input: Readonly<Record<string, unknown>> };
          turn.pending.set(d.requestId, { callId: d.callId, tool: d.tool, input: d.input });
        }
        // The adapter omits `turnId` from every payload that carries one (contract
        // `AdapterEvent`); the manager, which owns `Turn`, is what stamps it back on.
        const payload = turn && KINDS_CARRYING_TURN_ID.has(kind) ? { ...data, turnId: turn.turnId } : data;
        await emit(entry, kind, payload as never, raw);
        if (kind === 'turn.ended') entry.turn = null;
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
export type { GitSha, ChecklistItemId };
