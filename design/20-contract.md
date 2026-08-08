# Contract — SkyNet HR

Derived from `10-design.md`. Where this document and the code disagree, one of them is a
defect — say which, do not reconcile silently.

The governing rule from the design: **no vendor string above the adapter layer.** Every type
here is vendor-neutral except the three vendor-minted opaque identifiers named in
`10-design.md § Data model — Identity spaces`. `raw` exists for debugging and must never be
rendered.

Language is TypeScript, per `00-brief.md § Constraints`. Signatures only; no bodies.

## Types

### Identifiers and scalars

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };

// Server-minted.
type SessionId  = Brand<string, 'SessionId'>;    // UUIDv4
type TurnId     = Brand<string, 'TurnId'>;       // UUIDv4
type Seq        = Brand<number, 'Seq'>;          // integer >= 1

// Identity, from the identity edge.
type OperatorId = Brand<string, 'OperatorId'>;

// Vendor-minted and opaque above the adapter layer: equality only, never parsed,
// never compared for ordering, never used to infer structure.
type CliSessionId = Brand<string, 'CliSessionId'>;
type CallId       = Brand<string, 'CallId'>;
type RequestId    = Brand<string, 'RequestId'>;

// A path proven, once, to resolve inside a configured workspace root. Only `jail`
// may mint one.
type ResolvedPath = Brand<string, 'ResolvedPath'>;

// ISO 8601, UTC, millisecond precision, `Z` suffix.
type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

// A 40-character lowercase hexadecimal git object id.
type GitSha = Brand<string, 'GitSha'>;

type Vendor = 'claude' | 'codex';
type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted';
type SessionState = 'live' | 'ended';
```

Every fallible operation crossing a module boundary returns this rather than throwing.

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

### Session

```ts
interface PermissionPolicy {
  readonly mode: 'interactive' | 'preauthorised';
  readonly sandbox: SandboxMode | null;
  readonly banner: string | null;   // non-null exactly when mode === 'preauthorised'
}

// The full in-memory session record. `meta.json` persists every field below.
interface SessionRecord {
  readonly id: SessionId;
  readonly owner: OperatorId;
  readonly vendor: Vendor;
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly sandbox: SandboxMode | null;
  cliSessionId: CliSessionId | null;   // last-write-wins, from every system/init
  lastSeq: Seq | 0;                    // 0 before the first emit; a hint on disk only
  state: SessionState;
  readonly createdAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;        // non-null iff state === 'ended'
}

// What crosses to the client. The persisted record minus `cliSessionId`, which is
// vendor-opaque and has no client use.
interface SessionSummary {
  readonly id: SessionId;
  readonly owner: OperatorId;
  readonly vendor: Vendor;
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly sandbox: SandboxMode | null;
  readonly lastSeq: Seq | 0;
  readonly state: SessionState;
  readonly createdAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp | null;
}
```

### Turn

In memory only. No `turns.json` exists; turn history is reconstructed from the event log by
pairing `turn.started` with `turn.ended`.

```ts
interface Turn {
  readonly turnId: TurnId;
  phase: 'starting' | 'running';
  readonly startedAt: IsoTimestamp;
  readonly pending: Map<RequestId, PendingPermission>;
}

interface PendingPermission {
  readonly callId: CallId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}
```

### Process record

```ts
interface ProcessRecord {
  readonly pid: number;
  readonly pgid: number | null;        // null on Windows
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly startedAt: IsoTimestamp;    // load-bearing: the pid-reuse guard reads it
  readonly image: string;
  exitedAt: IsoTimestamp | null;       // tombstone
}
```

### Event envelope

```ts
interface EventPayloadMap {
  'session.started':     SessionStarted;
  'session.ended':       SessionEnded;
  'session.notice':      SessionNotice;
  'turn.started':        TurnStarted;
  'turn.ended':          TurnEnded;
  'message':             MessageEvent;
  'message.delta':       MessageDelta;
  'thinking':            Thinking;
  'tool.call':           ToolCall;
  'tool.result':         ToolResult;
  'permission.request':  PermissionRequest;
  'permission.resolved': PermissionResolved;
  'checkpoint.created':  CheckpointCreated;
  'usage':               UsageEvent;
  'error':               ErrorEvent;
}

type EventKind = keyof EventPayloadMap;

type Envelope<K extends EventKind = EventKind> = K extends EventKind
  ? {
      readonly seq: Seq;
      readonly sessionId: SessionId;
      readonly ts: IsoTimestamp;
      readonly kind: K;
      readonly data: EventPayloadMap[K];
      readonly raw?: unknown;   // present only when config.includeRaw
    }
  : never;
```

`seq` is the replay key and is assigned by the session manager, never by an adapter: an
adapter that restarts must not restart the sequence.

### Event payloads

```ts
interface SessionStarted {
  readonly vendor: Vendor;          // display only; no logic may branch on it
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly createdAt: IsoTimestamp;
}

type SessionEndReason = 'operator' | 'server_restart' | 'storage_failure';

interface SessionEnded {
  readonly reason: SessionEndReason;
  readonly endedAt: IsoTimestamp;
}

type SessionNoticeCode =
  | 'compaction'               // the CLI is compacting, or reported a compact boundary
  | 'resume_unavailable'       // spawning with no --resume; context not carried forward
  | 'checkpoints_unavailable'  // ckpt.git could not be initialised
  | 'checkpoint_skipped'       // the pre-turn checkpoint failed; the turn proceeds
  | 'sandbox'                  // the standing sandbox statement for a preauthorised session
  | 'audit_unavailable'        // a permission was denied because the audit append failed
  | 'storage_failure';         // a spill write failed; the session is ending

interface SessionNotice {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: SessionNoticeCode;
  readonly text: string;
}

interface TurnStarted { readonly turnId: TurnId }

type TurnStopReason =
  | 'completed'        // the CLI reported a successful result
  | 'error'            // the CLI reported an unsuccessful result
  | 'process_exit'     // the child died without reporting a result
  | 'interrupted'      // POST /interrupt
  | 'server_restart'   // boot closed a turn the crash left open
  | 'storage_failure'; // a spill write failed mid-turn

interface TurnEnded {
  readonly turnId: TurnId;
  readonly stopReason: TurnStopReason;
  readonly usage: Usage | null;
}

interface MessageEvent {
  readonly turnId: TurnId;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

interface MessageDelta {
  readonly turnId: TurnId;
  readonly role: 'assistant';
  readonly text: string;    // append-only
}

interface Thinking {
  readonly turnId: TurnId;
  readonly text: string;
}

interface ToolCall {
  readonly turnId: TurnId;
  readonly callId: CallId;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly summary: string;   // one line, server-rendered, safe to show collapsed
}

interface ToolResult {
  readonly turnId: TurnId;
  readonly callId: CallId;
  readonly ok: boolean;
  readonly output: string;    // truncated before this envelope was constructed
  readonly truncated: boolean;
  readonly bytes: number;     // pre-truncation size
}

// Opaque pending open question 8; see `## Unresolved`. Equality and storage only —
// no component may parse one until a grammar is decided.
type StandingRuleExpression = Brand<string, 'StandingRuleExpression'>;

interface PermissionSuggestion {
  readonly label: string;
  readonly rule: StandingRuleExpression;
}

interface PermissionRequest {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly callId: CallId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;   // exactly what will run, never a summary
  readonly suggestions: readonly PermissionSuggestion[];
}

type PermissionDecision = 'allow' | 'deny';
type AnswerScope   = 'once' | 'always';                // what a client may send
type ResolvedScope = 'once' | 'always' | 'standing';   // 'standing' = matched a stored rule

type PermissionResolvedReason =
  | 'answered'                // an operator answered
  | 'preapproved'             // matched a standing rule held by this server
  | 'cancelled_process_exit'  // the child died, or was interrupted, or boot closed the turn
  | 'superseded'
  | 'audit_unavailable';      // denied because the audit record could not be appended

interface PermissionResolved {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly decision: PermissionDecision;
  readonly scope: ResolvedScope;
  readonly operator: OperatorId | null;   // null when the server decided
  readonly reason: PermissionResolvedReason;
}

interface CheckpointCreated {
  readonly turnId: TurnId | null;   // null for the safety checkpoint taken before a restore
  readonly sha: GitSha;
  readonly label: string;
}

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

interface UsageEvent {
  readonly turnId: TurnId;
  readonly usage: Usage;
}

type ErrorEventKind =
  | 'replay_gap'
  | 'agent_unavailable'
  | 'adapter_unknown_record'
  | 'adapter_bad_line'
  | 'adapter_schema_mismatch'
  | 'checkpoint_restore_failed'
  | 'session_delete_incomplete';

interface ErrorEvent {
  readonly kind: ErrorEventKind;
  readonly message: string;
  readonly fatal: boolean;
}
```

### Rules the renderer may rely on

- `message.delta` events for one `turnId` concatenate, in `seq` order, to the `message` that
  follows. A client may render either and must not render both, and picks by `turnId`.
- `tool.result` always follows its `tool.call`. A `tool.call` with no result by `turn.ended`
  was abandoned.
- `permission.request` is always answered by exactly one `permission.resolved`, including
  when the process dies, when an operator interrupts, and when boot closes a turn a crash
  left open — all three carry `reason: 'cancelled_process_exit'`.
- A `preauthorised` session emits **zero** `permission.request` events. That is normal and
  must not read as a stalled turn.
- `session.started` is emitted once per session, on the first turn only, even though the CLI
  reports `system/init` on every turn.
- The untruncated bytes behind a `tool.result` with `truncated: true` are at
  `GET /api/sessions/:id/tool-output/:turnId/:callId`. Both segments come from the same
  envelope.

### Checkpoint

```ts
interface Checkpoint {
  readonly sha: GitSha;
  readonly label: string;
  readonly ts: IsoTimestamp;
}
```

Entirely derived from the shadow `GIT_DIR`. No mirror is persisted.

### Audit record

```ts
interface AuditRecord {
  readonly ts: IsoTimestamp;
  readonly operator: OperatorId | null;    // null when the server decided
  readonly sessionId: SessionId;
  readonly vendor: Vendor;                 // copied from the session at decision time
  readonly sandbox: SandboxMode | null;    // copied from the session at decision time
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;   // never truncated, never summarised
  readonly decision: PermissionDecision;
  readonly scope: ResolvedScope;
  readonly reason: string | null;
}
```

### Operator

```ts
interface Operator { readonly id: OperatorId }
```

Not persisted. An operator exists as a string on a `SessionRecord` and on an `AuditRecord`,
and nowhere else.

### Config

```ts
type AuthConfig =
  | { readonly mode: 'proxy-header'; readonly userHeader: string }
  | { readonly mode: 'open-webui'; readonly userHeader: string; readonly sessionHeader: string }
  | { readonly mode: 'shared-secret'; readonly cookieName: string; readonly secret: string };

interface Caps {
  readonly ringCapacity: number;             // envelopes retained in memory per session
  readonly toolResultBytes: number;          // truncation threshold for tool.result
  readonly subscriberQueueHighWater: number; // envelopes queued per subscriber before it is dropped
  readonly keepaliveMs: number;              // SSE comment interval
}

interface Config {
  readonly bind: { readonly host: string; readonly port: number };
  readonly auth: AuthConfig;
  readonly workspaceRoots: readonly ResolvedPath[];
  readonly storageRoot: string;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: readonly string[];    // upstream addresses permitted to set the identity header
  readonly caps: Caps;
  readonly includeRaw: boolean;
}
```

## Persisted schemas

```
<storage>/sessions/<sessionId>/
  meta.json                                   SessionMetaFile
  events.ndjson                               one Envelope per line, append-only
  tool-output/<turnId>/<callId>               untruncated bytes, one file per call
  ckpt.git/                                   shadow GIT_DIR, work-tree = the session's cwd
<storage>/audit.ndjson                        one AuditRecord per line, append-only
<storage>/pids.ndjson                         one ProcessRecord per line, append-only
```

```ts
interface SessionMetaFile {
  readonly schemaVersion: 1;
  readonly session: SessionRecord;   // `lastSeq` here is a diagnostic hint, not authority
}
```

| File | Key | Ordering / index | Constraints |
|---|---|---|---|
| `meta.json` | `sessionId` from the directory name | — | Written by temp-file-then-atomic-rename, never in place, on exactly three occasions: create, a `state` transition, a `cliSessionId` change. Never per event |
| `events.ndjson` | `(sessionId, seq)` | `seq` ascending, contiguous from 1 | Append-only. Not fsync'd per line. Read from the start and skipped to `after`; no offset index exists |
| `tool-output/<turnId>/<callId>` | `(sessionId, turnId, callId)` | — | Written once, never appended. `turnId` is in the path because `callId` is vendor-minted and only *assumed* session-unique |
| `audit.ndjson` | append order | append order | Server-wide. fsync'd before the decision it records reaches the child. Never truncated, never deleted with a session |
| `pids.ndjson` | append order; `pid` is not unique over time | append order | Server-wide. A tombstone is a second line for the same `pid`; the latest line for a `pid` wins |
| `ckpt.git/` | git object ids | git history | Git is the store. `add -A` honours the workspace's own `.gitignore` |

**Authority.** `lastSeq` is derived at boot from the tail of `events.ndjson`. Where
`meta.json` and the spill disagree, the spill is right.

**Migration.** There is no deployed data. `spike/.data` is throwaway proof-of-concept storage
in an unversioned shape and is not migrated; it is deleted. Forward rules for the first
shipped shape:

| File | Existing data | Rule |
|---|---|---|
| `meta.json` | none | `schemaVersion` gates rehydration. An unknown version is treated exactly as a corrupt file: the session is skipped, logged, and its files left untouched |
| `events.ndjson`, `audit.ndjson`, `pids.ndjson` | none | Readers ignore unknown fields and drop an unparseable trailing line. Added fields must be optional; a removed or retyped field is a new `schemaVersion` on `meta.json` and a refusal to rehydrate older sessions |
| `tool-output/*` | none | Opaque bytes; no schema to migrate |
| `ckpt.git/` | none | Git's own format; not ours to migrate |

## Public signatures

Internal helpers are out of scope. Every signature below crosses a module boundary.

### `contract`

Types only. No runtime export.

### `config`

```ts
declare function loadConfig(env: Readonly<Record<string, string | undefined>>): Result<Config, ConfigError>;
```

### `identity`

```ts
interface IdentityRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly remoteAddress: string;
}

type IdentityResolver = (req: IdentityRequest) => Result<OperatorId, IdentityError>;

declare function resolverFor(auth: AuthConfig, trustProxy: readonly string[]): IdentityResolver;
```

### `jail`

```ts
declare function resolveInsideRoot(
  candidate: string,
  roots: readonly ResolvedPath[],
): Promise<Result<ResolvedPath, JailError>>;
```

### `store`

```ts
interface LoadedMeta {
  readonly sessionId: SessionId;
  readonly result: Result<SessionRecord, StoreError>;   // a per-session failure never aborts boot
}

interface Store {
  // Session directory and metadata
  createSession(record: SessionRecord): Promise<Result<void, StoreError>>;
  writeMeta(record: SessionRecord): Promise<Result<void, StoreError>>;
  readAllMeta(): Promise<readonly LoadedMeta[]>;
  deleteSession(sessionId: SessionId): Promise<Result<void, StoreError>>;

  // Spill
  appendEvent(sessionId: SessionId, envelope: Envelope): Promise<Result<void, StoreError>>;
  readEventsAfter(sessionId: SessionId, after: Seq | 0): AsyncIterable<Result<Envelope, StoreError>>;
  readLastSeq(sessionId: SessionId): Promise<Result<Seq | 0, StoreError>>;

  // Ring buffer (in memory, bounded by Caps.ringCapacity)
  pushRing(sessionId: SessionId, envelope: Envelope): void;
  readRingAfter(sessionId: SessionId, after: Seq | 0): readonly Envelope[] | null;  // null = cannot serve
  dropRing(sessionId: SessionId): void;

  // Tool output blobs
  writeToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId, bytes: Buffer): Promise<Result<void, StoreError>>;
  openToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId): Promise<Result<NodeJS.ReadableStream, StoreError>>;

  // Server-wide append-only files
  appendAudit(record: AuditRecord): Promise<Result<void, StoreError>>;   // durable: fsync before it returns
  appendPid(record: ProcessRecord): Promise<Result<void, StoreError>>;
  tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, StoreError>>;
  readOpenPids(): Promise<readonly ProcessRecord[]>;
}

declare function createStore(config: Config): Promise<Result<Store, StoreError>>;
```

### `checkpoints`

```ts
interface Checkpoints {
  init(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<void, CheckpointError>>;
  commit(sessionId: SessionId, cwd: ResolvedPath, label: string): Promise<Result<Checkpoint, CheckpointError>>;
  list(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<readonly Checkpoint[], CheckpointError>>;
  // commit(safety) → checkout <sha> -- . → clean -fd. Returns the safety checkpoint.
  restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha): Promise<Result<Checkpoint, CheckpointError>>;
  destroy(sessionId: SessionId): Promise<Result<void, CheckpointError>>;
}

declare function createCheckpoints(config: Config): Checkpoints;
```

### `adapters/*`

The only module that knows a vendor exists. Depends on `contract` and nothing else: it is
handed a resolved `cwd` and one outbound channel, and that is its entire world.

```ts
// Everything an adapter tells the manager. Event payloads carry no `seq`, no `sessionId`
// and no `ts` — the manager assigns those.
type AdapterNotification =
  | { readonly kind: 'event'; readonly event: AdapterEvent }
  | { readonly kind: 'cli-session'; readonly cliSessionId: CliSessionId }   // every system/init
  | { readonly kind: 'spawned'; readonly pid: number; readonly pgid: number | null; readonly image: string }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null };

type AdapterEvent = {
  [K in Exclude<EventKind, 'session.started' | 'session.ended' | 'checkpoint.created'>]:
    { readonly kind: K; readonly data: Omit<EventPayloadMap[K], 'turnId'>; readonly raw?: unknown }
}[Exclude<EventKind, 'session.started' | 'session.ended' | 'checkpoint.created'>];

interface AdapterOptions {
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly sandbox: SandboxMode | null;
  readonly notify: (n: AdapterNotification) => void;
}

interface Adapter {
  readonly vendor: Vendor;
  readonly policy: PermissionPolicy;                 // the vendor's capability, fixed at create
  // Spawns the turn's child, writes the message to stdin, and holds stdin open.
  send(text: string, resume: CliSessionId | null, turnId: TurnId): Promise<Result<void, AdapterError>>;
  respond(requestId: RequestId, decision: PermissionDecision): Result<void, AdapterError>;
  kill(): Promise<void>;                             // terminate-then-force, on the process tree
}

declare function createAdapter(vendor: Vendor, opts: AdapterOptions): Result<Adapter, AdapterError>;
```

`policy` is read at session creation and is what the client renders as either "you will be
asked" or a standing sandbox banner. `sandbox` is the operator's choice and is validated by
the adapter.

### `session-manager`

```ts
interface CreateSessionInput {
  readonly vendor: Vendor;
  readonly cwd: string;                  // the client's string; never used after the jail check
  readonly model: string | null;
  readonly sandbox: SandboxMode | null;
}

interface PermissionAnswer {
  readonly requestId: RequestId;
  readonly decision: PermissionDecision;
  readonly scope: AnswerScope;
  readonly rule: StandingRuleExpression | null;   // required when scope === 'always'
  readonly reason: string | null;                 // the operator's stated reason
}

interface SubscriberSink {
  deliver(envelope: Envelope): void;
  close(): void;
}

interface Subscription { close(): void }

interface SessionManager {
  boot(): Promise<Result<void, StartupError>>;     // reap → rehydrate → close open turns; before listen

  create(owner: OperatorId, input: CreateSessionInput): Promise<Result<{ sessionId: SessionId }, SessionError>>;
  list(owner: OperatorId): readonly SessionSummary[];
  get(sessionId: SessionId, owner: OperatorId): Result<SessionSummary, SessionError>;

  message(sessionId: SessionId, owner: OperatorId, text: string): Promise<Result<{ turnId: TurnId }, SessionError>>;
  answerPermission(sessionId: SessionId, owner: OperatorId, answer: PermissionAnswer): Promise<Result<{ accepted: boolean }, SessionError>>;
  interrupt(sessionId: SessionId, owner: OperatorId, turnId: TurnId): Promise<Result<void, SessionError>>;
  end(sessionId: SessionId, owner: OperatorId): Promise<Result<void, SessionError>>;
  remove(sessionId: SessionId, owner: OperatorId): Promise<Result<void, SessionError>>;

  listCheckpoints(sessionId: SessionId, owner: OperatorId): Promise<Result<readonly Checkpoint[], SessionError>>;
  restore(sessionId: SessionId, owner: OperatorId, sha: GitSha): Promise<Result<void, SessionError>>;
  openToolOutput(sessionId: SessionId, owner: OperatorId, turnId: TurnId, callId: CallId): Promise<Result<NodeJS.ReadableStream, SessionError>>;

  // Replays from the ring, else from the spill, else delivers one `error / replay_gap`,
  // then joins the live stream.
  subscribe(sessionId: SessionId, owner: OperatorId, after: Seq | 0, sink: SubscriberSink): Promise<Result<Subscription, SessionError>>;
}

declare function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
}): SessionManager;
```

### `edge/sse` and `edge/ws`

```ts
interface EdgeDeps {
  readonly config: Config;
  readonly identity: IdentityResolver;
  readonly manager: SessionManager;
}

declare function createSseEdge(deps: EdgeDeps): import('node:http').RequestListener;
declare function createWsEdge(deps: EdgeDeps): import('node:http').RequestListener;
```

Both edges apply the origin allow-list before resolving identity. `edge/ws` applies it at the
handshake, not at first-message auth.

### `client`

No runtime interface. It consumes `Envelope` and the HTTP routes below.

## HTTP routes

All request and response bodies are JSON unless stated. All routes require authentication.
Every `POST` and `DELETE` under `/api/` requires an origin match, checked before identity is
resolved.

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/sessions` | `CreateSessionInput` | `201 { sessionId }` | `403 bad_origin`, `401 unauthenticated`, `409 outside_workspace_root`, `409 workspace_busy`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/message` | `{ text: string }` | `202 { turnId }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/permission` | `PermissionAnswer` | `200 { accepted: boolean }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/interrupt` | `{ turnId: TurnId }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/end` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `POST` | `/api/sessions/:id/checkpoint/restore` | `{ sha: GitSha }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `404 no_such_checkpoint`, `409 turn_in_flight`, `500 checkpoint_failed` |
| `DELETE` | `/api/sessions/:id` | — | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `GET` | `/api/sessions` | — | `200 { sessions: SessionSummary[] }`, caller's own only | `401 unauthenticated` |
| `GET` | `/api/sessions/:id/events` | `Last-Event-ID` header | `200 text/event-stream` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/checkpoints` | — | `200 { checkpoints: Checkpoint[] }` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/tool-output/:turnId/:callId` | — | `200 text/plain; charset=utf-8` | `404 no_such_session`, `404 no_such_output` |

`accepted: false` on the permission route means another client answered first. It is not an
error and carries `200`.

`POST /interrupt` returns `{ ok: true }` when the session has no live turn, or when `turnId`
does not name the live turn. An interrupt is a statement about a desired end state, not a
command that can arrive too late.

The tool-output route serves `X-Content-Type-Options: nosniff` and
`Content-Disposition: attachment` alongside `text/plain`.

Read routes are deliberately not under the origin check: a cross-origin `GET` cannot be read
back by the attacking page, and checking `GET /events` would break a reverse proxy that
rewrites `Origin`.

### Streaming

`GET /api/sessions/:id/events` is Server-Sent Events. One envelope per SSE message, with
`id:` set to `seq`:

```
id: 42
event: tool.call
data: {"seq":42,"sessionId":"...","ts":"...","kind":"tool.call","data":{...}}
```

On reconnect the browser's `EventSource` sends `Last-Event-ID`. The server replays from
`seq + 1` — from the ring buffer where it can, otherwise from the spill, for live and ended
sessions alike. Only where the spill cannot serve the range does the server send a single
`error` with `kind: 'replay_gap'`, after which the client refetches.

A comment line (`: keepalive`) every `Caps.keepaliveMs` keeps intermediaries from closing an
idle stream, and is what lets a client tell a silent agent from a dead connection.

## Error semantics

```ts
interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly detail?: unknown;
  };
}

type ApiErrorCode =
  | 'unauthenticated' | 'bad_origin' | 'no_such_session' | 'no_such_output'
  | 'no_such_checkpoint' | 'turn_in_flight' | 'session_ended' | 'workspace_busy'
  | 'outside_workspace_root' | 'bad_request' | 'checkpoint_failed' | 'agent_unavailable';
```

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `unauthenticated` | No usable identity |
| 403 | `bad_origin` | `Origin` / `Sec-Fetch-Site` did not match the allow-list on a mutating route |
| 404 | `no_such_session` | Unknown, or not the caller's |
| 404 | `no_such_output` | The tool-output blob is missing or unreadable |
| 404 | `no_such_checkpoint` | No such `sha` in this session's shadow git |
| 409 | `turn_in_flight` | A turn is running |
| 409 | `session_ended` | The session is ended and accepts no new turn |
| 409 | `workspace_busy` | The resolved path equals, contains, or is contained by a live session's `cwd` |
| 409 | `outside_workspace_root` | `cwd` failed the jail check |
| 422 | `bad_request` | Malformed body |
| 500 | `checkpoint_failed` | A checkpoint operation failed; see the accompanying `error` event |
| 503 | `agent_unavailable` | CLI missing or failed to spawn |

`404` rather than `403` for another operator's session is deliberate: session existence is
not something a non-owner should be able to probe. There is no `403 forbidden` for session
access, and no per-operator vendor authorisation — there is no operator record to hold one.

### Per-module error types

```ts
type ConfigError =
  | { readonly code: 'insecure_bind'; readonly bind: string }
  | { readonly code: 'missing_field'; readonly field: string }
  | { readonly code: 'invalid_field'; readonly field: string; readonly detail: string };

type StartupError =
  | { readonly code: 'storage_unwritable'; readonly path: string; readonly detail: string }
  | ConfigError;

type IdentityError =
  | { readonly code: 'no_identity' }
  | { readonly code: 'untrusted_proxy'; readonly remoteAddress: string }
  | { readonly code: 'bad_secret' };

type JailError =
  | { readonly code: 'outside_workspace_root'; readonly candidate: string; readonly roots: readonly string[] }
  | { readonly code: 'unresolvable'; readonly candidate: string; readonly detail: string };

type StoreError =
  | { readonly code: 'io'; readonly path: string; readonly detail: string }
  | { readonly code: 'not_found'; readonly path: string }
  | { readonly code: 'corrupt'; readonly path: string; readonly detail: string }
  | { readonly code: 'unsupported_schema_version'; readonly path: string; readonly found: number };

type CheckpointError =
  | { readonly code: 'git_unavailable'; readonly detail: string }
  | { readonly code: 'init_failed'; readonly detail: string }
  | { readonly code: 'locked'; readonly detail: string }          // ckpt.git/index.lock
  | { readonly code: 'no_such_checkpoint'; readonly sha: GitSha }
  | { readonly code: 'commit_failed'; readonly detail: string }
  | { readonly code: 'restore_incomplete'; readonly detail: string };

type AdapterError =
  | { readonly code: 'agent_unavailable'; readonly image: string; readonly detail: string }
  | { readonly code: 'unsupported_vendor'; readonly vendor: string }
  | { readonly code: 'unsupported_sandbox'; readonly sandbox: string }
  | { readonly code: 'no_child' }
  | { readonly code: 'schema_mismatch'; readonly detail: string }
  | { readonly code: 'write_failed'; readonly detail: string };

type SessionError =
  | { readonly code: 'no_such_session'; readonly sessionId: SessionId }
  | { readonly code: 'session_ended'; readonly sessionId: SessionId }
  | { readonly code: 'turn_in_flight'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly code: 'workspace_busy'; readonly holder: { readonly cwd: ResolvedPath; readonly owner: OperatorId } }
  | { readonly code: 'bad_request'; readonly field: string; readonly detail: string }
  | { readonly code: 'jail'; readonly cause: JailError }
  | { readonly code: 'adapter'; readonly cause: AdapterError }
  | { readonly code: 'checkpoint'; readonly cause: CheckpointError }
  | { readonly code: 'storage'; readonly cause: StoreError };
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `ConfigError.insecure_bind` | A non-loopback bind with no auth mode configured | No | Refuse to start, naming the fix |
| `ConfigError.missing_field` / `invalid_field` | Validation of the environment | No | Refuse to start |
| `StartupError.storage_unwritable` | The storage root cannot be written at boot | No | Refuse to start |
| `IdentityError.no_identity` | No header, no cookie, or an empty one | No | `401 unauthenticated` |
| `IdentityError.untrusted_proxy` | The identity header arrived from an address not in `trustProxy` | No | `401 unauthenticated`; log the address |
| `IdentityError.bad_secret` | The shared-secret cookie does not match | No | `401 unauthenticated` |
| `JailError.outside_workspace_root` | The resolved real path is inside no root | No | `409 outside_workspace_root`, naming the roots |
| `JailError.unresolvable` | The candidate cannot be resolved to a real path | No | `409 outside_workspace_root`. The jail admits only paths *proven* inside a root |
| `StoreError.io` | Any write or read failure | Sometimes | On a spill append: end the session (`storage_failure`). On an audit append: deny the permission. On a blob read: `404 no_such_output` |
| `StoreError.not_found` | A blob or session directory is absent | No | `404 no_such_output` |
| `StoreError.corrupt` | `meta.json` fails to parse, or the spill's trailing line does | No | Skip that session at boot, or drop that line and serve the rest. Never abort boot |
| `StoreError.unsupported_schema_version` | `meta.json` carries an unknown `schemaVersion` | No | Skip that session at boot; leave its files untouched |
| `CheckpointError.git_unavailable` / `init_failed` | `ckpt.git` cannot be created | No | `session.notice / warn` (`checkpoints_unavailable`); the session proceeds without checkpoints |
| `CheckpointError.locked` | `ckpt.git/index.lock` exists | Yes, after the lock clears | Pre-turn: `session.notice / warn` (`checkpoint_skipped`); the turn proceeds with no restore point |
| `CheckpointError.commit_failed` | A commit fails for any other reason | Sometimes | As above |
| `CheckpointError.no_such_checkpoint` | Restore names an unknown `sha` | No | `404 no_such_checkpoint`; the workspace is untouched |
| `CheckpointError.restore_incomplete` | `checkout` or `clean` fails part-way | No | `error / checkpoint_restore_failed`, non-fatal, plus `500 checkpoint_failed`. **The workspace is partially restored**; the safety checkpoint is the way back |
| `AdapterError.agent_unavailable` | `spawn` returns `ENOENT` | Yes, once installed | `503 agent_unavailable`; `error / agent_unavailable`, fatal to the turn; clear the turn. The session stays live |
| `AdapterError.unsupported_vendor` | An unknown vendor string | No | `422 bad_request` |
| `AdapterError.unsupported_sandbox` | A sandbox the vendor does not offer | No | `422 bad_request` |
| `AdapterError.no_child` | `send` or `respond` with no live child | No | Treat as a turn that has already ended; emit nothing new |
| `AdapterError.schema_mismatch` | The stream does not match the expected shape | No | `error / adapter_schema_mismatch`, **fatal**. Fail loudly; never degrade quietly |
| `AdapterError.write_failed` | A write to the child's stdin fails | No | Resolve pending permissions `cancelled_process_exit`; end the turn `process_exit` |
| `SessionError.no_such_session` | Unknown id, or the caller is not the owner | No | `404 no_such_session` |
| `SessionError.session_ended` | A message to a session in state `ended` | No | `409 session_ended` |
| `SessionError.turn_in_flight` | A second message, or a restore, end, or delete during a turn | Yes, once the turn ends | `409 turn_in_flight` |
| `SessionError.workspace_busy` | The resolved path overlaps a live session's `cwd` | Yes, once that session ends | `409 workspace_busy`, naming the holding path and operator |
| `SessionError.bad_request` | A malformed or missing field | No | `422 bad_request` |
| `SessionError.jail` / `adapter` / `checkpoint` / `storage` | A dependency's error, wrapped | Per the cause | Map the cause, per the rows above |

Two error paths are decisions rather than mappings, and are stated so they are not
re-derived:

- **An audit append that fails denies the permission.** The manager sends
  `control_response { behavior: 'deny' }` with the storage failure as the reason, emits
  `permission.resolved { decision: 'deny', reason: 'audit_unavailable' }` and a
  `session.notice / error`. The turn continues. Denial is the only decision safe to make
  without being able to record it.
- **A spill append that fails ends the session.** The live turn is interrupted with
  `stopReason: 'storage_failure'` and the session moves to `ended`. Continuing to stream
  would leave the ring holding events the spill never will.

## Invariants

Written so each could become an assertion. The named module is responsible for maintaining
it; where two are named, the second is where a violation would first be observable.

| # | Invariant | Owner |
|---|---|---|
| I1 | `seq` is strictly increasing by exactly one, per session, from 1. A gap is a bug, never a dropped event | `session-manager` |
| I2 | The ring buffer's contents are a strict suffix of the spill's, envelope for envelope, byte for byte | `store` |
| I3 | A `tool.result` is truncated before its envelope is constructed; the envelope in the ring and the line in the spill are identical | `session-manager` |
| I4 | At most one `Turn` per session is non-null at any time | `session-manager` |
| I5 | A guard is claimed in the same synchronous block that tests it: no `await` sits between a check and the mutation it protects. Applies to the turn slot and the workspace claim | `session-manager` |
| I6 | No two `live` sessions have `cwd` values where one equals, contains, or is contained by the other | `session-manager` |
| I7 | `cwd` is a `ResolvedPath` inside a configured root, resolved exactly once at session creation and never re-resolved | `jail`, `session-manager` |
| I8 | `state === 'ended'` implies `turn === null` and `endedAt !== null`; `state === 'live'` implies `endedAt === null` | `session-manager` |
| I9 | Every `permission.request` is followed by exactly one `permission.resolved` with the same `requestId`, in the same session, before or at `turn.ended` | `session-manager` |
| I10 | An `AuditRecord` is fsync'd before the corresponding `control_response` is written to the child's stdin | `session-manager`, `store` |
| I11 | Every `permission.resolved` has exactly one `AuditRecord`, including auto-answers with `scope: 'standing'` | `session-manager` |
| I12 | `AuditRecord.input` is never truncated, summarised, or derived; it is the bytes shown to the operator | `session-manager` |
| I13 | `audit.ndjson` is never deleted, rewritten, or shortened, including when the session it names is deleted | `store` |
| I14 | `turn.started` for a turn precedes every other event of that turn, and `turn.ended` follows all of them, including across a server restart | `session-manager` |
| I15 | The `checkpoint.created` for turn N precedes `turn.started` for turn N, where a checkpoint was taken at all | `session-manager` |
| I16 | `meta.json` is written only by temp-file-then-atomic-rename, and only on create, a `state` transition, or a `cliSessionId` change | `store` |
| I17 | `lastSeq` used at boot is derived from the spill's tail, never read from `meta.json` | `session-manager`, `store` |
| I18 | No connection is accepted until reaping, rehydration, and open-turn closure have all completed | `session-manager` |
| I19 | A `ProcessRecord` is reaped only when it has no `exitedAt`, its `startedAt` is later than the host's last boot, and the live process's image matches. Reaping kills the tree, never the bare pid | `session-manager` |
| I20 | No module above `adapters/*` reads, branches on, or contains a vendor string, except `SessionStarted.vendor` and `AuditRecord.vendor`, which are display and evidence only | all |
| I21 | `CliSessionId`, `CallId`, and `RequestId` are only ever compared for equality above the adapter layer | `session-manager` |
| I22 | A blob path contains both `turnId` and `callId`; no blob is addressable by `callId` alone | `store` |
| I23 | Every route that reads or mutates session data is under `/api/sessions/:id` and applies the ownership check | `edge/sse`, `edge/ws` |
| I24 | The origin allow-list is applied to every mutating route and to the WebSocket handshake, before identity is resolved | `edge/sse`, `edge/ws` |
| I25 | A `preauthorised` session emits zero `permission.request` events | `adapters/*` |
| I26 | No agent-derived string is ever assigned to `innerHTML` or parsed as markup | `client` |
| I27 | There is no mutex, lock, or semaphore in the server. `emit` is synchronous and is the serialisation point | all |

## Vendor mapping — Claude

Verified against `Forks-Claude-Code-Chat@ab6e307`.

| CLI stdout | Normalised |
|---|---|
| `system` / `init` | `AdapterNotification` `cli-session`; the manager emits `session.started` on the first turn only |
| `system` / `status: compacting` | `session.notice` (`compaction`) |
| `system` / `compact_boundary` | `session.notice` (`compaction`), reset local token counters |
| `assistant` → content `text` | `message` (role assistant) |
| `assistant` → content `thinking` | `thinking` |
| `assistant` → content `tool_use` | `tool.call` |
| `assistant` → `message.usage` | `usage` |
| `user` → content `tool_result` | `tool.result` |
| `control_request` / `can_use_tool` | `permission.request` |
| `result`, subtype success | `turn.ended`, `stopReason: 'completed'`; close stdin |
| `result`, any other subtype | `turn.ended`, `stopReason: 'error'`; close stdin |
| `close` with no `result` seen | `turn.ended`, `stopReason: 'process_exit'` |

Launched with `--output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio`, plus `--resume <cliSessionId>` when the manager supplies
one. Outbound user messages and `control_response` are single JSON lines written to stdin,
which stays open for the whole turn.

`updatedPermissions` is never sent. Standing approvals are held by this server and matched
here, so that every match still produces a `permission.request` / `permission.resolved` pair
and an audit record.

Policy for every Claude session: `{ mode: 'interactive', sandbox: null, banner: null }`.

## Vendor mapping — Codex

**Unverified.** Everything below is a hypothesis to be tested by the spike, drawn from the
on-disk rollout schema documented in `SubZeroDev.AgentKit/tools/Measure-Session.ps1`, not
from an observed live stream.

| Expected record | Normalised |
|---|---|
| `payload.type == 'session_meta'` | `AdapterNotification` `cli-session` |
| `payload.info` → `token_count` | `usage` |
| *(unknown)* | `message`, `tool.call`, `tool.result` |

Policy for every Codex session, until proven otherwise:
`{ mode: 'preauthorised', sandbox: <the mode chosen at launch>, banner: <naming that mode> }`.

**The adapter must fail loudly, not degrade quietly.** If the stream does not match, return
`AdapterError.schema_mismatch` and emit `error / adapter_schema_mismatch` with
`fatal: true`. A Codex adapter that silently renders nothing is worse than one that refuses
to start, because the operator will believe the agent is thinking.

## Unresolved

Signatures the design does not determine. Nothing downstream may invent them.

1. **`Attachment`.** `POST /api/sessions/:id/message` previously carried
   `attachments?: Attachment[]` against a type that was never defined, and no section of
   `10-design.md` describes attachment handling — not the transport to the CLI, not storage,
   not the byte cap, not the audit consequence of a file reaching an agent. The field is
   removed from the route rather than left dangling. Restoring it needs a design decision
   first.
2. **The standing-rule grammar.** `StandingRuleExpression` is opaque here because open
   question 8 is open: whether `permission_suggestions` from the Claude CLI is a sufficient
   grammar for "always allow", or whether a local rule language is needed. D35 makes this
   blocking for the slice that ships standing approvals — the server does the matching, so
   it needs a grammar it can evaluate. Until it is decided, no `match(rule, request)`
   signature can be written, and `scope: 'always'` cannot be implemented.
3. **The Codex event mapping.** Three of the five normalised kinds have no source record.
   S8.1 is the experiment that answers it; the adapter may not guess.
4. **`ToolCall.summary`'s renderer.** The design calls it "server-rendered" and names no
   owner. It is emitted by the adapter in the shape above, which makes it vendor code
   producing a display string — the one place that reading is uncomfortable. It is not
   moved here because moving it would put tool-shape knowledge in the session manager, which
   is exactly what the vendor boundary forbids.
