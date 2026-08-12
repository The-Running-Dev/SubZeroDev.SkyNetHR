import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import { createAdapter } from '../adapters/index.js';
import { pathsOverlap, resolveInsideRoot } from '../jail/index.js';
import type {
  Adapter,
  AdapterNotification,
  AuditRecord,
  CallId,
  Caps,
  Checkpoint,
  CheckpointError,
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
  PermissionDecision,
  PermissionRequest,
  PermissionResolvedReason,
  ProcessRecord,
  RequestId,
  ResolvedPath,
  ResolvedScope,
  Result,
  Seq,
  SessionError,
  SessionId,
  SessionManager,
  SessionRecord,
  SessionSummary,
  StandingRuleExpression,
  StartupError,
  Store,
  Subscription,
  SubscriberSink,
  TurnId,
} from '../contract/index.js';

const isWindows = platform === 'win32';
const execFileAsync = promisify(execFile);
import type { Checkpoints } from '../contract/index.js';
import type { Records } from '../contract/index.js';

// Every `CheckpointError` variant but `no_such_checkpoint` carries `detail`; that one
// carries `sha` instead. Centralised so every notice/error text built from a
// `CheckpointError` reads the same way regardless of which variant it is.
function checkpointErrorDetail(e: CheckpointError): string {
  return e.code === 'no_such_checkpoint' ? `no such checkpoint: ${e.sha}` : e.detail;
}

// `PendingPermission` (20-contract.md § Turn) carries only what a manual answer needs.
// I43's validation additionally needs the matchTarget the adapter projected for this
// request — held here, in this module's own private turn-tracking shape, rather than as
// a contract amendment: `TurnState` is in-memory-only and never crosses the
// `SessionManager` boundary.
interface PendingPermissionState extends PendingPermission {
  readonly matchTarget: string | null;
}

interface TurnState {
  readonly turnId: TurnId;
  phase: 'starting' | 'running';
  readonly pending: Map<RequestId, PendingPermissionState>;
}

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

interface SessionEntry {
  record: SessionRecord;
  // `null` for a session rehydrated at boot (S7.2): no `--resume` is ever attempted on
  // one (D20), so it never needs a child process, and every route that would reach the
  // adapter for a live session already refuses first on `state === 'ended'` or on there
  // being no live turn.
  adapter: Adapter | null;
  turn: TurnState | null;
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

export function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
  readonly records: Records;
}): SessionManager {
  const { config, store, checkpoints } = deps;
  const sessions = new Map<SessionId, SessionEntry>();

  function findLiveOverlap(candidate: ResolvedPath): SessionEntry | null {
    for (const entry of sessions.values()) {
      if (entry.record.state === 'live' && pathsOverlap(candidate, entry.record.cwd)) return entry;
    }
    return null;
  }

  // S9.8: delivers a completion envelope live-only, bypassing the ring and the spill —
  // both belong to `emit`, and by the time this is called the spill has already failed
  // to hold the envelope that triggered the failure. Pushing these to the ring anyway
  // would put something in it the spill does not hold (D41); the same reasoning as
  // `remove()`'s post-registry notice, which has nothing left to replay it from either.
  function deliverDirect<K extends EventKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K]): void {
    entry.seq += 1;
    const envelope = { seq: entry.seq as Seq, sessionId: entry.record.id, ts: nowIso(), kind, data } as Envelope;
    // `entry.record.lastSeq` is what `subscribe`'s reconnect-gap check compares an
    // incoming `Last-Event-ID` against (I1). The edge writes this envelope's `seq` as
    // that SSE `id:`, so a later reconnect must find it already accounted for here —
    // otherwise a client that saw this envelope live gets told it is past the end of
    // history it already has.
    entry.record.lastSeq = envelope.seq;
    for (const sub of entry.subscribers) sub.deliver(envelope);
  }

  async function emit<K extends EventKind>(entry: SessionEntry, kind: K, data: EventPayloadMap[K], raw?: unknown): Promise<void> {
    // S9.8: once the spill has failed the session is already ended, and no further
    // envelope may reach the ring it can no longer back — the completion envelopes for
    // the failure itself go out through `deliverDirect` instead, not this path.
    if (entry.storageFailed) return;
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
      const turn = entry.turn;
      entry.turn = null;
      entry.record.state = 'ended';
      entry.record.endedAt = nowIso();
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
              store.appendAudit({
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
    await entry.writeQueue;
  }

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

  // The OS-reported image name for a live pid, or `null` when nothing is running there
  // (already exited, or never existed). Windows has no `/proc`; Linux does.
  async function getProcessImage(pid: number): Promise<string | null> {
    if (isWindows) {
      try {
        const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (!firstLine) return null;
        const match = /^"([^"]*)"/.exec(firstLine);
        return match ? match[1]! : null;
      } catch {
        return null;
      }
    }
    try {
      const comm = await readFile(`/proc/${pid}/comm`, 'utf8');
      return comm.trim();
    } catch {
      return null;
    }
  }

  function imagesMatch(recorded: string, actual: string): boolean {
    const strip = (s: string) => s.replace(/\.exe$/i, '');
    return isWindows ? strip(recorded).toLowerCase() === strip(actual).toLowerCase() : strip(recorded) === strip(actual);
  }

  // D38: the tree, not the recorded pid — `taskkill /T /F` walks the live process table
  // on Windows; on POSIX the recorded pid is the process-group leader (`detached: true`
  // at spawn), so signalling the negated pid reaches everything it later spawned.
  async function killProcessTree(pid: number, pgid: number | null): Promise<void> {
    if (isWindows) {
      await new Promise<void>((resolve) => {
        const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
        p.once('error', (err) => {
          console.warn(`[session-manager] boot: taskkill /PID ${pid} /T /F failed to start: ${err.message}; the process may still be running`);
          resolve();
        });
        p.once('exit', (code) => {
          if (code !== 0) {
            console.warn(`[session-manager] boot: taskkill /PID ${pid} /T /F exited with code ${code}; the process may still be running`);
          }
          resolve();
        });
      });
      return;
    }
    try {
      process.kill(-(pgid ?? pid), 'SIGKILL');
    } catch {
      // Already gone — nothing left to kill.
    }
  }

  // S7.5/S7.6 (D23, I19): the pid-reuse guard. An entry is reaped — tree killed, then
  // tombstoned — only when it has no `exitedAt` (guaranteed by `readOpenPids`), its
  // `startedAt` is later than the host's last boot, and the live process's image still
  // matches. Anything failing either of the remaining two tests is logged and tombstoned
  // without being touched: a stale record is bookkeeping, a wrong kill is an incident.
  async function reapOne(record: ProcessRecord, hostBootAt: number): Promise<void> {
    const startedAfterBoot = new Date(record.startedAt).getTime() > hostBootAt;
    const actualImage = startedAfterBoot ? await getProcessImage(record.pid) : null;
    const imageOk = actualImage !== null && imagesMatch(record.image, actualImage);

    if (startedAfterBoot && imageOk) {
      await killProcessTree(record.pid, record.pgid);
    } else {
      console.warn(
        `[session-manager] boot: not reaping pid ${record.pid} (${record.image}): ` +
          (startedAfterBoot ? `live image is ${actualImage ?? 'unknown'}, not ${record.image}` : 'recorded startedAt predates this host\'s last boot'),
      );
    }
    await store.tombstonePid(record.pid, nowIso());
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
      const appended = await store.appendAudit({
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

  const manager: SessionManager = {
    async boot(): Promise<Result<void, StartupError>> {
      // S7.10: a storage root that exists but cannot be written (permissions revoked,
      // mounted read-only, since `createStore` last touched it) is refused here rather
      // than discovered mid-rehydration.
      const writable = await probeStorageWritable(config.storageRoot);
      if (!writable.ok) return writable;

      // Step 1 (D23, D38): reap orphaned children before anything is rehydrated, so no
      // rehydrated session can be adopted by an orphan still holding its workspace.
      const hostBootAt = Date.now() - os.uptime() * 1000;
      const openPids = await store.readOpenPids();
      for (const record of openPids) {
        await reapOne(record, hostBootAt);
      }

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
        const lastSeqResult = await store.readLastSeq(sessionId);
        if (!lastSeqResult.ok) {
          console.warn(`[session-manager] boot: skipping session ${sessionId}: ${JSON.stringify(lastSeqResult.error)}`);
          continue;
        }
        const rehydrated: SessionRecord = {
          ...record,
          state: 'ended',
          endedAt: record.endedAt ?? nowIso(),
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
          subscribers: new Set(),
          writeQueue: Promise.resolve(),
        };
        sessions.set(sessionId, entry);
        // One of the three occasions `store`'s table names: a `state` transition.
        await store.writeMeta(rehydrated);
      }

      // Step 3 (D39): a spill left on an unpaired `turn.started` is closed on disk —
      // every outstanding `permission.request` resolved `cancelled_process_exit`, then
      // `turn.ended { stopReason: 'server_restart' }` — before anything is served, so the
      // ordering guarantees in `20-contract.md § Rules the renderer may rely on` hold
      // unconditionally rather than acquiring a "the transcript might just stop" case.
      for (const entry of sessions.values()) {
        await closeUnterminatedTurn(entry);
      }

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
        hasRunATurn: false,
        checkpointsAvailable: true,
        storageFailed: false,
        standingRules: [],
        subscribers: new Set(),
        writeQueue: Promise.resolve(),
      };
      sessions.set(sessionId, entry);

      const created = await store.createSession(record);
      if (!created.ok) {
        sessions.delete(sessionId);
        return { ok: false, error: { code: 'storage', cause: created.error } };
      }

      // S6.8: a ckpt.git that cannot be initialised is a warning, not a session-creation
      // failure — the session is created and usable without checkpoints.
      const initialised = await checkpoints.init(sessionId, cwd);
      if (!initialised.ok) {
        entry.checkpointsAvailable = false;
        await emit(entry, 'session.notice', {
          level: 'warn',
          code: 'checkpoints_unavailable',
          text: `checkpoints could not be initialised for this session: ${checkpointErrorDetail(initialised.error)}`,
        });
      }

      // Requisition attachment is S13's.

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

      // S6.2/D42: committed while the slot is claimed but before turn.started fires, so
      // checkpoint.created always precedes it in seq order.
      if (entry.checkpointsAvailable) {
        const checkpointed = await checkpoints.commit(sessionId, entry.record.cwd, `before turn ${turnId}`);
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
      if (entry.turn === null) return { ok: false, error: { code: 'session_ended', sessionId } };

      await emit(entry, 'turn.started', { turnId });
      if (entry.turn === null) return { ok: false, error: { code: 'session_ended', sessionId } };
      entry.turn.phase = 'running';

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
      const sendResult = await entry.adapter!.send(text, entry.record.cliSessionId, turnId);
      if (!sendResult.ok) {
        // The `turn.started` above is already durable; pair it (I14, D39) before
        // freeing the slot, or the log carries an open turn no restart ever repairs.
        await emit(entry, 'turn.ended', { turnId, stopReason: 'error', usage: null });
        entry.turn = null;
        return { ok: false, error: { code: 'adapter', cause: sendResult.error } };
      }
      // Set only once the CLI actually spawned: a `send` failure never ran a process, so
      // it must not count as "a turn that could have lost context" for the next one.
      entry.hasRunATurn = true;
      return { ok: true, value: { turnId } };
    },

    async answerPermission(sessionId, owner, answer: PermissionAnswer) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };

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
      if (!turn) return { ok: true, value: { accepted: false } };
      const pending = turn.pending.get(answer.requestId);
      if (!pending) return { ok: true, value: { accepted: false } }; // already resolved (D33)

      if (rule !== null && pending.matchTarget === null) {
        return { ok: false, error: { code: 'bad_request', field: 'scope', detail: 'no standing rule may be created against a request with no matchTarget' } };
      }

      turn.pending.delete(answer.requestId); // synchronous with the lookup, before any await (D33)

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
      await finalizeResolution(
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
      return { ok: true, value: { accepted: true } };
    },

    async interrupt(sessionId, owner, turnId) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };

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
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };
      // Already ended (a rehydrated session, or a repeat `/end` call): a no-op, not a
      // second `endedAt`/`session.ended` — the documented error set for this route has
      // no `session_ended`, which only makes sense if a repeat call is safely inert.
      if (entry.record.state === 'ended') return { ok: true, value: undefined };

      entry.record.state = 'ended';
      entry.record.endedAt = nowIso();
      // Best-effort, matching the 'cli-session' notification handler below: `/end`'s
      // only refusals are `bad_origin`, `no_such_session` and `turn_in_flight` (no 500),
      // so a failed rewrite does not block the state transition that already freed the
      // workspace (S5.6) — the in-memory record, which `findLiveOverlap` reads, is
      // already `ended` regardless of whether the disk copy caught up.
      await store.writeMeta(entry.record);
      await emit(entry, 'session.ended', { reason: 'operator', endedAt: entry.record.endedAt });
      return { ok: true, value: undefined };
    },

    async remove(sessionId, owner) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };

      // S6.10: ckpt.git comes out alongside everything else `store.deleteSession`
      // already owns removing. Sequential, not concurrent — `ckpt.git` sits inside the
      // very directory `store.deleteSession` recursively removes, and two concurrent
      // `fs.rm({recursive: true})` calls over overlapping trees can trip each other
      // (an `ENOTEMPTY` mid-walk, on the loser). Any failure from either still folds
      // into the same non-fatal notice below (S5.11).
      const destroyed = await checkpoints.destroy(sessionId);
      const deleted = await store.deleteSession(sessionId);
      // S5.11: the registry entry comes out regardless of whether storage cleanup fully
      // succeeded — a partial failure must not leave a session an operator asked to
      // remove still listed.
      sessions.delete(sessionId);

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
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      const listed = await checkpoints.list(sessionId, entry.record.cwd);
      if (!listed.ok) return { ok: false, error: { code: 'checkpoint', cause: listed.error } };
      return { ok: true, value: listed.value };
    },

    async restore(sessionId, owner, sha) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      // A rehydrated session has no adapter and its cwd may already be reclaimed by a
      // new live session (`findLiveOverlap` only excludes `state === 'live'`) — restoring
      // into it would run a git checkout against a workspace this entry no longer owns.
      if (entry.record.state === 'ended') return { ok: false, error: { code: 'session_ended', sessionId } };
      // S6.5/D17: restore is a second consumer of the single-writer turn-slot invariant,
      // alongside `POST /message` — claimed synchronously here, before the first `await`
      // (I5), the same way `message()` claims it, so a concurrent `message()` or a second
      // `restore()` can never interleave its own git operations with this one.
      if (entry.turn) return { ok: false, error: { code: 'turn_in_flight', sessionId, turnId: entry.turn.turnId } };
      entry.turn = { turnId: randomUUID() as TurnId, phase: 'running', pending: new Map() };

      try {
        const restored = await checkpoints.restore(sessionId, entry.record.cwd, sha);
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
        await emit(entry, 'checkpoint.created', { turnId: null, sha: restored.value.sha, label: restored.value.label });
        return { ok: true, value: undefined };
      } finally {
        entry.turn = null;
      }
    },

    async openToolOutput(sessionId, owner, turnId, callId) {
      // S9.3/I23/D43: the ownership check is the same as every other session route —
      // another operator gets `no_such_session`, not a distinguishable `no_such_output`
      // that would confirm the session exists.
      const entry = sessions.get(sessionId);
      if (!entry || entry.record.owner !== owner) return { ok: false, error: { code: 'no_such_session', sessionId } };
      const opened = await store.openToolOutput(sessionId, turnId, callId);
      if (!opened.ok) return { ok: false, error: { code: 'storage', cause: opened.error } };
      return { ok: true, value: opened.value };
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

  // Shared by `answerPermission` and `resolvePreapproved`: persist the audit record,
  // then respond to the adapter and emit `permission.resolved` — on an audit-append
  // failure this denies regardless of what was decided and reports `audit_unavailable`
  // (S4.7/I9), otherwise it reports `success`. `onDurable` runs once the record is
  // durable but before the child is answered, which is where `answerPermission` holds a
  // newly-created standing rule (I43) — a grant that was never durably recorded must not
  // start auto-approving.
  async function finalizeResolution(
    entry: SessionEntry,
    turn: TurnState,
    requestId: RequestId,
    record: AuditRecord,
    success: { decision: PermissionDecision; scope: ResolvedScope; operator: OperatorId | null; reason: PermissionResolvedReason },
    onDurable?: () => void,
  ): Promise<void> {
    const appended = await store.appendAudit(record);
    if (!appended.ok) {
      entry.adapter!.respond(requestId, 'deny');
      await emit(entry, 'permission.resolved', {
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
      return;
    }

    onDurable?.();
    entry.adapter!.respond(requestId, success.decision);
    await emit(entry, 'permission.resolved', {
      turnId: turn.turnId,
      requestId,
      decision: success.decision,
      scope: success.scope,
      operator: success.operator,
      reason: success.reason,
    });
  }

  // S10.4: the server's own decision for a request matched against a standing rule.
  // Mirrors `answerPermission`'s happy/audit-failure paths via `finalizeResolution`, but
  // the operator is `null` throughout and the grant behind it was already durable when
  // the rule was created — there is nothing left to validate here, only to record and
  // answer.
  async function resolvePreapproved(entry: SessionEntry, turn: TurnState, request: PermissionRequest, matched: StandingRuleExpression): Promise<void> {
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
            store.appendAudit({
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
            void store.writeToolOutput(entry.record.id, turnId, d.callId, outputBytes).then((written) => {
              if (!written.ok) {
                console.warn(
                  `[session-manager] session ${entry.record.id}: failed to write the tool-output blob for ` +
                    `${turnId}/${d.callId}: ${JSON.stringify(written.error)}`,
                );
              }
            });
            eventData = { ...d, output: truncateUtf8(outputBytes, config.caps.toolResultBytes), truncated: true };
          }
        }
        // The adapter omits `turnId` from every payload that carries one (contract
        // `AdapterEvent`); the manager, which owns `Turn`, is what stamps it back on.
        const payload = turn && KINDS_CARRYING_TURN_ID.has(kind) ? { ...eventData, turnId: turn.turnId } : eventData;
        // Cleared before the event is emitted, not after: `emit` delivers to
        // subscribers synchronously but then awaits the spill write, so a caller
        // reacting to the delivered `turn.ended` (e.g. sending the next message) must
        // already see the slot free — clearing it after `await emit` leaves a window
        // where that caller races the still-pending spill append (S5.1).
        if (kind === 'turn.ended') entry.turn = null;
        await emit(entry, kind, payload as never, raw);
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
export type { GitSha, ChecklistItemId };
