import { randomUUID } from 'node:crypto';
import { createAdapter } from '../adapters/index.js';
import { resolveInsideRoot } from '../jail/index.js';
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

function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const na = norm(a);
  const nb = norm(b);
  const sep = process.platform === 'win32' ? '\\' : '/';
  return na === nb || na.startsWith(nb + sep) || nb.startsWith(na + sep);
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
      if (entry.record.state === 'live' && overlaps(candidate, entry.record.cwd)) return entry;
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
      const jailed = await resolveInsideRoot(input.cwd, config.workspaceRoots);
      if (!jailed.ok) return { ok: false, error: { code: 'jail', cause: jailed.error } };
      const cwd = jailed.value;

      const overlap = findLiveOverlap(cwd);
      if (overlap) {
        return { ok: false, error: { code: 'workspace_busy', holder: { cwd: overlap.record.cwd, owner: overlap.record.owner } } };
      }

      const adapterResult = createAdapter(input.vendor, {
        cwd,
        model: input.model,
        sandbox: input.sandbox,
        notify: (n) => handleNotification(sessionId, n),
      });
      if (!adapterResult.ok) return { ok: false, error: { code: 'adapter', cause: adapterResult.error } };

      const sessionId = randomUUID() as SessionId;
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

      const created = await store.createSession(record);
      if (!created.ok) return { ok: false, error: { code: 'storage', cause: created.error } };

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
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      // Ring/spill replay (S3) is not this slice's; S1's harness subscribes live-only
      // from `after: 0`.
      void after;
      entry.subscribers.add(sink);
      return {
        ok: true,
        value: {
          close() {
            entry.subscribers.delete(sink);
          },
        },
      };
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
