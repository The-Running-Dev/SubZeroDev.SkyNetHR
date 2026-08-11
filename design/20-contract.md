# Contract — SkyNet HR

Derived from `10-design.md`. Where this document and the code disagree, one of them is a
defect — say which, do not reconcile silently.

The governing rule from the design: **no vendor string above the adapter layer.** Every type
here is vendor-neutral except the three vendor-minted opaque identifiers named in
`10-design.md § Data model — Identity spaces`. `raw` exists for debugging and must never be
rendered.

**The design has two tiers and so does this document.** Everything unmarked is tier one.
Structures marked **(tier two)** are the operator's working surfaces admitted by D53 to D55
and D58; they are binding scope, and they are separable — tier one is finishable without any
of them (D59). One tier-one surface is new in this pass and is marked as such: the audit read
route (D73), which brief item 7 always needed and which no earlier revision specified.

Language is TypeScript, per `00-brief.md § Constraints`. Signatures only; no bodies.

## Types

### Identifiers and scalars

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };

// Server-minted.
type SessionId  = Brand<string, 'SessionId'>;    // UUIDv4
type TurnId     = Brand<string, 'TurnId'>;       // UUIDv4
type Seq        = Brand<number, 'Seq'>;          // integer >= 1

// Server-minted, tier two.
type ReviewId      = Brand<string, 'ReviewId'>;       // UUIDv4
type RequisitionId = Brand<string, 'RequisitionId'>;  // UUIDv4

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

// An identifier declared by a deployment's checklist template in `config`. Tier two.
type ChecklistItemId = Brand<string, 'ChecklistItemId'>;

// Server-minted, opaque to every caller: a position in `audit.ndjson` from which the
// next page continues. Equality and round-tripping only; no caller may parse one.
type AuditCursor = Brand<string, 'AuditCursor'>;

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

// The denormalised session identity a review copies at authorship (D67). It is a copy,
// never a reference: after D25 deletes the session, this is what still resolves.
interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly owner: OperatorId;
  readonly vendor: Vendor;
  readonly cwd: ResolvedPath;
  readonly createdAt: IsoTimestamp;
}
```

There is no employment-status field, and none may be added: D79 makes the badge a client-side
projection over `state`, the live turn and outstanding permission requests.

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
  exitedAt: IsoTimestamp | null;       // null while live; set by folding in the tombstone
}

// The exit line. `pids.ndjson` carries two line shapes and this is the second: a full
// `ProcessRecord` is written at spawn, and this narrower line at exit, because
// `tombstonePid` is given a pid and a timestamp and nothing else (D95).
interface ProcessTombstone {
  readonly pid: number;
  readonly exitedAt: IsoTimestamp;
}
```

**A reader folds the two shapes; it does not treat the latest line as a whole record.**
Liveness comes from the latest line for a `pid`; `startedAt`, `image`, `sessionId` and
`turnId` come from that pid's most recent **spawn** line. The reuse guard reads all three of
`exitedAt`, `startedAt` and `image` (I19), and a reader that took them off the tombstone
would find two of them missing and reap on a guard that never ran.

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
  'checklist.item.completed': ChecklistItemCompleted;   // tier two (D71)
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

The vocabulary is closed (D44). `checklist.item.completed` is the one kind tier two adds, and
it is session-scoped: it carries no `turnId` and may land between a `turn.started` and its
`turn.ended`.

### Event payloads

```ts
interface SessionStarted {
  readonly vendor: Vendor;          // display only; no logic may branch on it
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly state: SessionState;     // the state at emission, and therefore always 'live'
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

// Incremental and summable by construction: the adapter normalises whatever the vendor
// reports into deltas before emitting (D75). Nothing above `adapters/*` may do arithmetic
// on a vendor's own numbers. Whether a given vendor reports cumulatively is open
// question 14 and is the adapter's problem, never a caller's.
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

// Tier two (D71). Session-scoped: no `turnId`, and it may interleave with a turn's events.
interface ChecklistItemCompleted {
  readonly itemId: ChecklistItemId;
  readonly by: OperatorId;
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
- **`SessionStarted.state` is the state at emission and is therefore always `'live'`.** The
  authoritative current state is `SessionSummary.state` from `GET /api/sessions`, or the
  presence of a `session.ended` later in the stream. A client that reads `state` off a
  replayed `session.started` will show an enabled compose box for an ended session. The field
  is retained knowingly (D45).
- The untruncated bytes behind a `tool.result` with `truncated: true` are at
  `GET /api/sessions/:id/tool-output/:turnId/:callId`. Both segments come from the same
  envelope.
- **Belonging to a turn is a field, never a position in the stream.** `checkpoint.created`,
  `session.notice` and `checklist.item.completed` carry no `turnId` and do land between a
  `turn.started` and its `turn.ended`. A renderer that treats that interval as the turn's
  contents will attribute an operator's click to the agent.
- **There is no employment-status field on the wire** (D79). `CLOCKED OUT` is
  `state === 'ended'`; `BLOCKED` is a live session with an unresolved `permission.request`;
  `ON SHIFT` is a live turn; `IDLE` is the remainder. `ON PIP` is orthogonal and comes from
  the review fold below, not from the session.
- **PIP status is derived, never served as a session field** (D72). It is the `pip` value of
  the review for that subject with `state === 'final'` and the greatest `updatedAt`, ties
  broken by the later line in `reviews.ndjson`. Drafts are excluded. `GET /api/reviews?subject=`
  returns exactly the finals this fold reads.

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

The read side (D73), which serves brief item 7 in tier one and the incident view of item 11
in tier two. It is one read with filters, never two shapes:

```ts
interface AuditQuery {
  readonly before: AuditCursor | null;   // newest-first; null starts at the newest record
  readonly limit: number;                // clamped to Caps.auditPageMax
  readonly sessionId: SessionId | null;
  readonly operator: OperatorId | null;
  readonly since: IsoTimestamp | null;
  readonly until: IsoTimestamp | null;
  // The incident view: decision === 'deny', or operator === null (the server forced it),
  // or scope === 'standing'. Grouping by session and by operator is the reader's.
  readonly incidentsOnly: boolean;
}

interface AuditPage {
  readonly records: readonly AuditRecord[];   // newest first
  readonly nextCursor: AuditCursor | null;    // null when the window reached the oldest record
}
```

### Review (tier two)

Every field is `readonly`: a line in `reviews.ndjson` is immutable, and editing a draft
appends a new line for the same `reviewId` (D65). The latest line wins.

```ts
type Rating =
  | 'does_not_meet'
  | 'meets_some'
  | 'meets'
  | 'exceeds'
  | 'exceptional';

type ReviewState = 'draft' | 'final';

interface Review {
  readonly reviewId: ReviewId;
  readonly subject: SessionId;
  readonly snapshot: SessionSnapshot;   // copied at authorship; never re-resolved (D67)
  readonly author: OperatorId;
  readonly state: ReviewState;          // one-way; `final` is terminal
  readonly rating: Rating | null;
  readonly pip: boolean;
  readonly body: string;                // UTF-8, at most Caps.reviewBodyBytes bytes
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;     // on the `final` line, this is the finalisation time
}
```

`Rating` is display-independent: the tokens are what persists, and the wording an operator
sees is the client's (D82). `updatedAt` on a `final` line is the ordering key for "the most
recent final review", and it can be, because `final` refuses every further append (D83).

### Requisition (tier two)

Same file discipline as `Review`: append-only, latest line per id wins.

```ts
type RequisitionState = 'open' | 'approved' | 'rejected' | 'consumed';
type RequisitionDecision = 'approve' | 'reject';

interface Requisition {
  readonly requisitionId: RequisitionId;
  readonly raisedBy: OperatorId;
  readonly title: string;           // UTF-8, at most Caps.requisitionTextBytes bytes
  readonly justification: string;   // UTF-8, at most Caps.requisitionTextBytes bytes
  // The client's string, stored unresolved and never passed to `jail` before session
  // creation (D68). It is deliberately not a ResolvedPath: an approval is permission to
  // try, not a grant.
  readonly workspace: string;
  readonly vendor: Vendor;
  readonly state: RequisitionState;   // open → approved → consumed, or open → rejected
  readonly decidedBy: OperatorId | null;
  readonly decidedAt: IsoTimestamp | null;
  readonly sessionId: SessionId | null;   // set once, at consumption
  readonly raisedAt: IsoTimestamp;
}
```

### Onboarding checklist (tier two)

The template is a `config` value; completion lives in the session's event stream and the
checklist is the fold over it (D71). Nothing is persisted for a checklist, and it dies with
its session under D25.

```ts
interface ChecklistItemTemplate {
  readonly id: ChecklistItemId;
  readonly label: string;
}

interface ChecklistItemState {
  readonly id: ChecklistItemId;
  readonly label: string;                     // from the template, at read time
  readonly completedBy: OperatorId | null;
  readonly completedAt: IsoTimestamp | null;  // the `ts` of the completing envelope
}
```

### Payroll view (tier two)

Brief item 8. A fold over the session's own event log and a `config` value; no entity, no
file (D75, D76).

```ts
interface PayrollView {
  readonly sessionId: SessionId;
  readonly burn: Usage;                     // component-wise sum of every `usage` event
  readonly budgetTokens: number | null;     // Config.sessionTokenBudget; null when unset
  readonly remainingTokens: number | null;  // null when budgetTokens is null; see Unresolved 8
  readonly idleMs: number;                  // live-with-no-turn wall clock
  readonly droppedIntervals: number;        // idle intervals discarded for spanning a restart
}
```

### Operator

```ts
interface Operator { readonly id: OperatorId }
```

Not persisted. An operator exists as a string on a `SessionRecord`, an `AuditRecord`, a
`Review` and a `Requisition`, and nowhere else (D3, D66). Tier two adds no operator record
and no preference: the theme is browser state and never reaches this server (D60, D78).

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
  readonly auditPageMax: number;             // largest window `GET /api/audit` will serve
  readonly reviewBodyBytes: number;          // (tier two) rejection threshold for Review.body
  readonly requisitionTextBytes: number;     // (tier two) per field: title, justification
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
  readonly sessionTokenBudget: number | null;              // (tier two) per session; null disables the view's budget
  readonly checklist: readonly ChecklistItemTemplate[];    // (tier two) empty disables the checklist
}
```

A cap is a threshold, not a truncation, for the two tier-two text fields: a body or a
justification over the cap is refused with `422 bad_request`, never silently shortened. The
values are a deployment's; this document declares the fields and sets none of them (D84).

## Persisted schemas

```
<storage>/sessions/<sessionId>/
  meta.json                                   SessionMetaFile
  events.ndjson                               one Envelope per line, append-only
  tool-output/<turnId>/<callId>               untruncated bytes, one file per call
  ckpt.git/                                   shadow GIT_DIR, work-tree = the session's cwd
<storage>/audit.ndjson                        one AuditRecord per line, append-only
<storage>/pids.ndjson                         one ProcessRecord per line, append-only
<storage>/reviews.ndjson                      (tier two) one Review per line, append-only
<storage>/requisitions.ndjson                 (tier two) one Requisition per line, append-only
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
| `events.ndjson` | `(sessionId, seq)` | `seq` ascending, contiguous from 1 | Append-only, written in `seq` order through the session's own append chain (D89). Not fsync'd per line. Read from the start and skipped to `after`; no offset index exists |
| `tool-output/<turnId>/<callId>` | `(sessionId, turnId, callId)` | — | Written once, never appended. `turnId` is in the path because `callId` is vendor-minted and only *assumed* session-unique |
| `audit.ndjson` | append order | append order, read newest first | Server-wide. fsync'd before the decision it records reaches the child. Never truncated, never deleted with a session. Every read is a bounded window resumed by `AuditCursor` |
| `pids.ndjson` | append order; `pid` is not unique over time | append order | Server-wide. Two line shapes: a `ProcessRecord` at spawn, a `ProcessTombstone` at exit (D95). The latest line for a `pid` decides liveness; the spawn line carries everything else |
| `reviews.ndjson` *(tier two)* | `reviewId` | append order; the latest line for an id wins | Server-wide. Never rewritten. Survives deletion of the session it names (D67). A `final` line is terminal — no later line for that id is written |
| `requisitions.ndjson` *(tier two)* | `requisitionId` | append order; the latest line for an id wins | Server-wide. Never rewritten. Written before the session it opens exists |
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
| `reviews.ndjson`, `requisitions.ndjson` | none | Readers ignore unknown fields; added fields must be optional. A dropped trailing line does not shorten the record, it reverts it to the previous line for that id — accepted in `10-design.md § Persistence summary`. **A removed or retyped field has no discriminator to gate on in these two files**; see `## Unresolved` 11 |
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

// The one containment predicate in this server: true when the two paths are equal or
// either contains the other, under the same normalisation `resolveInsideRoot` applies.
// Both arguments must already be jail-resolved. `session-manager`'s workspace busy check
// (D30) calls this; no module hand-rolls a second one.
declare function pathsOverlap(a: ResolvedPath, b: ResolvedPath): boolean;

// Normalises away the `\\?\` extended-length prefix a native realpath returns on
// Windows. Exported because `config` must canonicalise a declared workspace root with
// exactly the normalisation a candidate gets here (D94) — a root spelled differently
// from the candidates tested against it refuses legitimate paths.
declare function stripExtendedPrefix(p: string): string;
```

`jail` depends on `contract` alone. The roots arrive as a parameter, so there is no
`jail → config` edge; the edge runs the other way (`10-design.md § Module boundaries`).

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
  readAuditPage(query: AuditQuery): Promise<Result<AuditPage, StoreError>>;   // bounded; never a whole-file scan
  appendPid(record: ProcessRecord): Promise<Result<void, StoreError>>;
  tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, StoreError>>;
  readOpenPids(): Promise<readonly ProcessRecord[]>;

  // Record logs (tier two). A read failure yields an empty list and never aborts boot.
  appendReview(record: Review): Promise<Result<void, StoreError>>;
  readAllReviews(): Promise<readonly Review[]>;              // latest line per reviewId
  appendRequisition(record: Requisition): Promise<Result<void, StoreError>>;
  readAllRequisitions(): Promise<readonly Requisition[]>;    // latest line per requisitionId
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

type AdapterEmitted = Exclude<
  EventKind,
  | 'session.started'
  | 'session.ended'
  | 'checkpoint.created'
  | 'checklist.item.completed'
  | 'permission.resolved'
>;

type AdapterEvent = {
  [K in AdapterEmitted]:
    { readonly kind: K; readonly data: Omit<EventPayloadMap[K], 'turnId'>; readonly raw?: unknown }
}[AdapterEmitted];

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

**A vendor adapter may accept one thing beyond `AdapterOptions`, and it is a test seam, not a
deployment knob** (D91). `createClaudeAdapter` takes an optional `executable`, defaulting to
`SKYNET_CLAUDE_EXECUTABLE` and then to the vendor's own name, so a fixture CLI speaking the
documented wire shape can stand in for the real binary over a real child process — which is
what D88's verification of the permission round trip rests on. It is deliberately **not** a
`Config` field: a deployment that can repoint the agent binary from the environment is a
deployment where the audit log names a program nobody chose. `createAdapter` does not expose
it, so nothing above `adapters/*` can reach it.

An adapter never emits `checklist.item.completed`: that envelope originates with an operator,
not with a child process.

**Nor does it emit `permission.resolved`** (D97). The manager holds the `pending` map, deletes
from it synchronously (D33) and appends the audit record every resolution owes (I11), so an
adapter that resolved a request of its own would produce a resolution with no audit record and
leave the manager's map holding an entry nothing will clear. What the adapter contributes when
its child dies is the `exited` notification; deciding that every outstanding request is now
`cancelled_process_exit` is the manager's, in the same place it decides it for an interrupt and
for a turn boot closes.

### `records` *(tier two)*

Owns the review and requisition lifecycles and their in-memory registries. Depends on
`config`, `store` and `contract` — **never on `session-manager`** (D77). It is handed a
`SessionSnapshot` as a parameter; it does not know a session registry exists.

```ts
interface RaiseRequisitionInput {
  readonly title: string;
  readonly justification: string;
  readonly workspace: string;    // stored unresolved; the jail runs at session creation
  readonly vendor: Vendor;
}

interface CreateReviewInput {
  readonly subject: SessionId;
  readonly rating: Rating | null;
  readonly pip: boolean;
  readonly body: string;
}

// Absent fields are left as they stand on the latest line for that review.
interface ReviewPatch {
  readonly rating?: Rating | null;
  readonly pip?: boolean;
  readonly body?: string;
}

interface Records {
  // Boot: load both logs into the registries. Never fails — an unreadable log yields an
  // empty registry and a log line, because tier two must not deny an operator tier one.
  boot(): Promise<void>;

  // Requisitions
  raise(raisedBy: OperatorId, input: RaiseRequisitionInput): Promise<Result<Requisition, RecordsError>>;
  listRequisitions(): readonly Requisition[];                 // every authenticated operator (D70)
  getRequisition(requisitionId: RequisitionId): Result<Requisition, RecordsError>;
  decide(requisitionId: RequisitionId, decidedBy: OperatorId, decision: RequisitionDecision): Promise<Result<Requisition, RecordsError>>;

  // Consumption, in the three steps control flow 1 draws. `claim` is **synchronous**: it
  // tests `state === 'approved'` and takes the claim in the same block, per D32.
  claim(requisitionId: RequisitionId): Result<void, RecordsError>;
  attachSession(requisitionId: RequisitionId, sessionId: SessionId): Promise<Result<void, RecordsError>>;
  release(requisitionId: RequisitionId): void;   // in-process only; a crash leaves it spent (D80)

  // Reviews. `snapshot` is supplied by the caller; `records` never resolves a session.
  createReview(author: OperatorId, snapshot: SessionSnapshot, input: CreateReviewInput): Promise<Result<Review, RecordsError>>;
  appendReview(reviewId: ReviewId, author: OperatorId, patch: ReviewPatch): Promise<Result<Review, RecordsError>>;
  finaliseReview(reviewId: ReviewId, author: OperatorId): Promise<Result<Review, RecordsError>>;
  getReview(reviewId: ReviewId, reader: OperatorId): Result<Review, RecordsError>;   // a draft resolves for its author only
  listReviews(subject: SessionId): readonly Review[];         // finals only, every operator (D70)
  isUnderPip(subject: SessionId): boolean;                    // the D72 fold; drafts excluded
}

declare function createRecords(deps: {
  readonly config: Config;
  readonly store: Store;
}): Records;
```

`CreateReviewInput` is the wire shape and carries `subject`; the `SessionSnapshot` the edge
supplies carries `sessionId`. The two must name the same session, and `records` refuses with
`bad_request` when they do not — it is the one consistency check it can make without
resolving a session it is forbidden to resolve.

`getReview` and `appendReview` answer `no_such_review` — never a distinct forbidden — for a
draft belonging to someone else, matching D50's treatment of a session an operator does not
own.

There is no `revoke` and no expiry: an approval stays spendable until it is spent (D81).

### `session-manager`

```ts
interface CreateSessionInput {
  readonly vendor: Vendor;
  readonly cwd: string;                  // the client's string; never used after the jail check
  // Constrained, not free text: `/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/`, else `422 bad_request`
  // on `model`. It reaches a child's argv, which Windows passes through a shell (D90).
  readonly model: string | null;
  readonly sandbox: SandboxMode | null;
  readonly requisitionId: RequisitionId | null;   // (tier two) optional; never a gate (D68)
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

  // Tier two. Both are folds over what this session has already written.
  payroll(sessionId: SessionId, owner: OperatorId): Promise<Result<PayrollView, SessionError>>;
  checklist(sessionId: SessionId, owner: OperatorId): Promise<Result<readonly ChecklistItemState[], SessionError>>;
  tickChecklistItem(sessionId: SessionId, owner: OperatorId, itemId: ChecklistItemId): Promise<Result<void, SessionError>>;
}

declare function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
  readonly records: Records;   // (tier two) for the requisition claim during create, only
}): SessionManager;
```

`tickChecklistItem` is idempotent: a second tick for an item already complete emits no second
envelope and still succeeds.

The `records` dependency is one-directional and exists for the claim during `create`. Nothing
else in the manager may call it, and `records` may never call back.

### `edge/sse` and `edge/ws`

```ts
interface EdgeDeps {
  readonly config: Config;
  readonly identity: IdentityResolver;
  readonly manager: SessionManager;
  readonly records: Records;   // (tier two) the edge composes it with the manager (D77)
}

declare function createSseEdge(deps: EdgeDeps): import('node:http').RequestListener;
declare function createWsEdge(deps: EdgeDeps): import('node:http').RequestListener;
```

Both edges apply the origin allow-list before resolving identity. `edge/ws` applies it at the
handshake, not at first-message auth.

### `client`

No runtime interface. It consumes `Envelope` and the HTTP routes below. Its rendering rules
are binding and are in `10-design.md § Security controls`: a strict CSP with no
`unsafe-inline`, no `innerHTML` for anything this codebase did not write (D74), and the four
themes as CSS custom properties toggled by a root attribute, with the choice held in browser
storage and never sent here (D60, D78).

## HTTP routes

All request and response bodies are JSON unless stated. All routes require authentication.
Every `POST` and `DELETE` under `/api/` requires an origin match, checked before identity is
resolved.

### Sessions

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/sessions` | `CreateSessionInput` | `201 { sessionId }` | `403 bad_origin`, `401 unauthenticated`, `409 outside_workspace_root`, `409 workspace_busy`, `404 no_such_requisition`, `409 requisition_not_approved`, `409 requisition_consumed`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/message` | `{ text: string }` | `202 { turnId }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/permission` | `PermissionAnswer` | `200 { accepted: boolean }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/interrupt` | `{ turnId: TurnId }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/end` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `POST` | `/api/sessions/:id/checkpoint/restore` | `{ sha: GitSha }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `404 no_such_checkpoint`, `409 turn_in_flight`, `422 bad_request`, `500 checkpoint_failed` |
| `DELETE` | `/api/sessions/:id` | — | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `GET` | `/api/sessions` | — | `200 { sessions: SessionSummary[] }`, caller's own only | `401 unauthenticated` |
| `GET` | `/api/sessions/:id/events` | `Last-Event-ID` header | `200 text/event-stream` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/checkpoints` | — | `200 { checkpoints: Checkpoint[] }` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/tool-output/:turnId/:callId` | — | `200 text/plain; charset=utf-8` | `404 no_such_session`, `404 no_such_output` |

The permission route resolves identity and the ownership check like every other session
route; the operator it resolves is the one written to `AuditRecord.operator`.

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

### Audit — tier one (D73)

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `GET` | `/api/audit` | `AuditQuery` as query parameters | `200 AuditPage` | `401 unauthenticated`, `422 bad_request` |

Readable by every authenticated operator, not scoped to the caller's own sessions (D70): the
question this log answers crosses sessions, and scoped to one operator it answers only "what
did I approve". The window is bounded by `Caps.auditPageMax` and resumed by `nextCursor`;
there is no unbounded read, because this is the one file that grows for the deployment's
lifetime. The incident view of brief item 11 is this route with `incidentsOnly: true`.

### Requisitions — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/requisitions` | `RaiseRequisitionInput` | `201 { requisition }` | `403 bad_origin`, `401 unauthenticated`, `422 bad_request`, `500 record_write_failed` |
| `GET` | `/api/requisitions` | — | `200 { requisitions: Requisition[] }`, all of them | `401 unauthenticated` |
| `POST` | `/api/requisitions/:id/decision` | `{ decision: RequisitionDecision }` | `200 { requisition }` | `403 bad_origin`, `404 no_such_requisition`, `409 already_decided`, `422 bad_request`, `500 record_write_failed` |

`workspace` is stored as the client sent it and is not resolved here. A requisition naming a
path outside every root is approvable, and fails `409 outside_workspace_root` at the moment a
session tries to spend it — with the claim not taken, because the jail runs first (D68).

Self-approval is permitted and recorded: `decidedBy` may equal `raisedBy` (D69).

### Reviews — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/reviews` | `CreateReviewInput` | `201 { review }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request`, `500 record_write_failed` |
| `POST` | `/api/reviews/:id` | `ReviewPatch` | `200 { review }` | `403 bad_origin`, `404 no_such_review`, `409 review_final`, `422 bad_request`, `500 record_write_failed` |
| `POST` | `/api/reviews/:id/finalise` | `{}` | `200 { review }` | `403 bad_origin`, `404 no_such_review`, `409 review_final`, `500 record_write_failed` |
| `GET` | `/api/reviews` | `?subject=<SessionId>` | `200 { reviews: Review[] }`, finals only | `401 unauthenticated`, `422 bad_request` |
| `GET` | `/api/reviews/:id` | — | `200 { review }` | `404 no_such_review` |

`GET /api/reviews` returns finals and no drafts at all, for every caller including a draft's
own author (`10-design.md § Failure modes — Records boundary`). An author reaches their draft
by `GET /api/reviews/:id` with the `reviewId` that `POST /api/reviews` returned.

`404 no_such_review` covers three cases and distinguishes none of them: no such id, a draft
that is not the caller's, and a review the caller may not touch. `404` rather than `403`,
matching D50.

### Session records — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `GET` | `/api/sessions/:id/payroll` | — | `200 PayrollView` | `404 no_such_session`, `500 payroll_unavailable` |
| `GET` | `/api/sessions/:id/checklist` | — | `200 { items: ChecklistItemState[] }` | `404 no_such_session` |
| `POST` | `/api/sessions/:id/checklist/:itemId` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `404 no_such_item` |

Both checklist routes are under `/api/sessions/:id` and carry the ownership check: only the
session's owner may read or tick its checklist. Whether a tick is refused on an ended session,
and which sessions have a checklist at all, are undecided — see `## Unresolved` 9.

A tick is idempotent and is **not** audited: `audit.ndjson` records tool approvals, and
diluting it with provisioning clicks makes the artifact the threat model leans on harder to
read.

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
  | 'outside_workspace_root' | 'bad_request' | 'checkpoint_failed' | 'agent_unavailable'
  // tier two
  | 'no_such_requisition' | 'requisition_not_approved' | 'requisition_consumed'
  | 'already_decided' | 'no_such_review' | 'review_final' | 'no_such_item'
  | 'record_write_failed' | 'payroll_unavailable';
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
| 422 | `bad_request` | Malformed body, or a text field over its cap |
| 500 | `checkpoint_failed` | A checkpoint operation failed; see the accompanying `error` event |
| 503 | `agent_unavailable` | CLI missing or failed to spawn |
| 404 | `no_such_requisition` *(tier two)* | Unknown `requisitionId` |
| 409 | `requisition_not_approved` *(tier two)* | Its state is not `approved` |
| 409 | `requisition_consumed` *(tier two)* | Already spent on a session |
| 409 | `already_decided` *(tier two)* | A decision is terminal; the refusal names who made it and what it was |
| 404 | `no_such_review` *(tier two)* | Unknown, or a draft that is not the caller's |
| 409 | `review_final` *(tier two)* | A final review accepts no further append |
| 404 | `no_such_item` *(tier two)* | No such `itemId` in the configured checklist template |
| 500 | `record_write_failed` *(tier two)* | The record-log append failed; nothing changed anywhere |
| 500 | `payroll_unavailable` *(tier two)* | The fold could not read the spill; the session itself is unaffected |

`404` rather than `403` for another operator's session is deliberate: session existence is
not something a non-owner should be able to probe. There is no `403 forbidden` for session
access, and no per-operator vendor authorisation — there is no operator record to hold one.
What that `404` buys narrowed when tier two arrived: reviews and audit records name
`SessionId`s, so existence is discoverable through the record logs and the `404` is now access
control rather than concealment (D70).

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

// tier two
type RecordsError =
  | { readonly code: 'no_such_requisition'; readonly requisitionId: RequisitionId }
  | { readonly code: 'already_decided'; readonly requisitionId: RequisitionId; readonly decidedBy: OperatorId; readonly state: RequisitionState }
  | { readonly code: 'requisition_not_approved'; readonly requisitionId: RequisitionId; readonly state: RequisitionState }
  | { readonly code: 'requisition_consumed'; readonly requisitionId: RequisitionId; readonly sessionId: SessionId | null }
  | { readonly code: 'no_such_review'; readonly reviewId: ReviewId }
  | { readonly code: 'review_final'; readonly reviewId: ReviewId }
  | { readonly code: 'bad_request'; readonly field: string; readonly detail: string }
  | { readonly code: 'storage'; readonly cause: StoreError };

type SessionError =
  | { readonly code: 'no_such_session'; readonly sessionId: SessionId }
  | { readonly code: 'session_ended'; readonly sessionId: SessionId }
  | { readonly code: 'turn_in_flight'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly code: 'workspace_busy'; readonly holder: { readonly cwd: ResolvedPath; readonly owner: OperatorId } }
  | { readonly code: 'no_such_item'; readonly itemId: ChecklistItemId }
  | { readonly code: 'bad_request'; readonly field: string; readonly detail: string }
  | { readonly code: 'jail'; readonly cause: JailError }
  | { readonly code: 'adapter'; readonly cause: AdapterError }
  | { readonly code: 'checkpoint'; readonly cause: CheckpointError }
  | { readonly code: 'storage'; readonly cause: StoreError }
  | { readonly code: 'records'; readonly cause: RecordsError };
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `ConfigError.insecure_bind` | A routable bind that no `trustProxy` allow-list covers. **Not** a missing auth mode: D93 makes one mandatory in every configuration, so that case is `missing_field` at parse time and never reaches here | No | Refuse to start, naming the fix |
| `ConfigError.missing_field` / `invalid_field` | Validation of the environment | No | Refuse to start |
| `StartupError.storage_unwritable` | The storage root cannot be written at boot | No | Refuse to start |
| `IdentityError.no_identity` | No header, no cookie, or an empty one | No | `401 unauthenticated` |
| `IdentityError.untrusted_proxy` | The identity header arrived from an address not in `trustProxy` | No | `401 unauthenticated`; log the address |
| `IdentityError.bad_secret` | The shared-secret cookie does not match | No | `401 unauthenticated` |
| `JailError.outside_workspace_root` | The resolved real path is inside no root | No | `409 outside_workspace_root`, naming the roots |
| `JailError.unresolvable` | The candidate cannot be resolved to a real path | No | `409 outside_workspace_root`. The jail admits only paths *proven* inside a root |
| `StoreError.io` | Any write or read failure | Sometimes | On a spill append: end the session (`storage_failure`). On an audit append: deny the permission. On a blob read: `404 no_such_output`. On a record-log append: `500 record_write_failed`, registry unchanged |
| `StoreError.not_found` | A blob or session directory is absent | No | `404 no_such_output` |
| `StoreError.corrupt` | `meta.json` fails to parse, or a trailing line does | No | Skip that session at boot, or drop that line and serve the rest. Never abort boot |
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
| `RecordsError.no_such_requisition` | Unknown id, on a decision or a claim | No | `404 no_such_requisition`; during `create`, no claim was taken |
| `RecordsError.already_decided` | A second decision on one requisition | No | `409 already_decided`, naming the decider and the state |
| `RecordsError.requisition_not_approved` | A claim against `open` or `rejected` | Yes, once approved | `409 requisition_not_approved`; nothing is claimed |
| `RecordsError.requisition_consumed` | A claim against one already spent | No | `409 requisition_consumed`; raise another (D80, D81) |
| `RecordsError.no_such_review` | Unknown id, or a draft that is not the caller's | No | `404 no_such_review`. Never distinguishes the two |
| `RecordsError.review_final` | An append or a second finalise on a final review | No | `409 review_final` |
| `RecordsError.bad_request` | A text field over its cap, or a malformed field | No | `422 bad_request`, naming the field |
| `RecordsError.storage` | The record-log append failed | Sometimes | `500 record_write_failed`. **The registry is not mutated**; the edit is still in the operator's form |
| `SessionError.no_such_session` | Unknown id, or the caller is not the owner | No | `404 no_such_session` |
| `SessionError.session_ended` | A message to a session in state `ended` | No | `409 session_ended` |
| `SessionError.turn_in_flight` | A second message, or a restore, end, or delete during a turn | Yes, once the turn ends | `409 turn_in_flight` |
| `SessionError.workspace_busy` | The resolved path overlaps a live session's `cwd` | Yes, once that session ends | `409 workspace_busy`, naming the holding path and operator |
| `SessionError.no_such_item` | A tick for an `itemId` absent from the configured template | No | `404 no_such_item` |
| `SessionError.bad_request` | A malformed or missing field | No | `422 bad_request` |
| `SessionError.jail` / `adapter` / `checkpoint` / `storage` / `records` | A dependency's error, wrapped | Per the cause | Map the cause, per the rows above |

Three error paths are decisions rather than mappings, and are stated so they are not
re-derived:

- **An audit append that fails denies the permission.** The manager sends
  `control_response { behavior: 'deny' }` with the storage failure as the reason, emits
  `permission.resolved { decision: 'deny', reason: 'audit_unavailable' }` and a
  `session.notice / error`. The turn continues. Denial is the only decision safe to make
  without being able to record it.
- **A spill append that fails ends the session.** The live turn is interrupted with
  `stopReason: 'storage_failure'` and the session moves to `ended`. Continuing to stream
  would leave the ring holding events the spill never will.
- **A record-log append that fails changes nothing.** No registry mutation, no partial state,
  and the operator retypes nothing they cannot see. This is the reverse of the audit path's
  ordering, deliberately: a review or a decision is not irreversible and nothing downstream
  acts on it. The precise ordering of the registry claim against the append is contested in
  the design and is not settled here — see `## Unresolved` 7.

## Invariants

Written so each could become an assertion. The named module is responsible for maintaining
it; where two are named, the second is where a violation would first be observable.

| # | Invariant | Owner |
|---|---|---|
| I1 | `seq` is strictly increasing by exactly one, per session, from 1. A gap is a bug, never a dropped event | `session-manager` |
| I2 | The ring buffer's contents are a strict suffix of the spill's, envelope for envelope, byte for byte | `store` |
| I3 | A `tool.result` is truncated before its envelope is constructed; the envelope in the ring and the line in the spill are identical | `session-manager` |
| I4 | At most one `Turn` per session is non-null at any time | `session-manager` |
| I5 | A guard is claimed in the same synchronous block that tests it: no `await` sits between a check and the mutation it protects. It governs four guards — the turn slot, the workspace claim, a requisition's decision, and a requisition's consumption | `session-manager`, `records` |
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
| I18 | No connection is accepted until reaping, rehydration, open-turn closure, and record-log loading have all completed | `session-manager`, `records` |
| I19 | A `ProcessRecord` is reaped only when it has no `exitedAt`, its `startedAt` is later than the host's last boot, and the live process's image matches. Reaping kills the tree, never the bare pid | `session-manager` |
| I20 | No module above `adapters/*` branches on a vendor string. `vendor` is carried as data on `SessionRecord`, `SessionSummary`, `SessionStarted`, `AuditRecord`, `SessionSnapshot` and `Requisition`, and is display or evidence in every one of them | all |
| I21 | `CliSessionId`, `CallId`, and `RequestId` are only ever compared for equality above the adapter layer | `session-manager` |
| I22 | A blob path contains both `turnId` and `callId`; no blob is addressable by `callId` alone | `store` |
| I23 | Every route that reads or mutates a **session's** data is under `/api/sessions/:id` and applies the ownership check. The record routes are not session data and are governed by D70 instead: read is open, write is attributed | `edge/sse`, `edge/ws` |
| I24 | The origin allow-list is applied to every mutating route and to the WebSocket handshake, before identity is resolved | `edge/sse`, `edge/ws` |
| I25 | A `preauthorised` session emits zero `permission.request` events | `adapters/*` |
| I26 | No string this codebase did not write is ever assigned to `innerHTML` or parsed as markup — agent output, tool results, and stored operator text alike | `client` |
| I27 | There is no mutex, lock, or semaphore in the server. `emit`'s synchronous prefix — `seq`, ring push, fan-out — is the serialisation point. The per-session append chain that follows it orders I/O and excludes nothing (D89) | all |
| I28 | `Usage` on an emitted `usage` event is incremental and summable; no module above `adapters/*` performs arithmetic on a vendor's own token numbers | `adapters/*` |
| I29 | *(tier two)* A review's `state` moves `draft → final` and never back. A `final` review accepts no further append for that `reviewId` | `records` |
| I30 | *(tier two)* A review's `snapshot` is copied at authorship and never refreshed; no read of a review resolves its `subject` | `records` |
| I31 | *(tier two)* A `draft` review is readable and writable by its `author` alone; a `final` review is readable by every authenticated operator; `listReviews` returns finals only | `records` |
| I32 | *(tier two)* A requisition moves only `open → approved → consumed` or `open → rejected`. There is no revocation and no expiry | `records` |
| I33 | *(tier two)* A requisition is consumed at most once. A second claim is refused, never queued | `records` |
| I34 | *(tier two)* `Requisition.workspace` is never a `ResolvedPath` and is never resolved before session creation; only `jail` mints a `ResolvedPath` | `records`, `session-manager` |
| I35 | *(tier two)* PIP status is the `pip` of the `final` review for that subject with the greatest `updatedAt`, ties broken by the later line. Drafts never contribute | `records` |
| I36 | *(tier two)* At most one `checklist.item.completed` envelope exists per `(sessionId, itemId)`; a second tick emits nothing and still succeeds | `session-manager` |
| I37 | *(tier two)* A record-log append that fails leaves the in-memory registry and the file agreeing, with nothing changed in either | `records` |
| I38 | *(tier two)* An unreadable or partly corrupt record log yields an empty or shortened registry and a log line. It never aborts boot, and never denies an operator tier one | `records` |
| I39 | Every read of `audit.ndjson` is bounded by `Caps.auditPageMax` and resumed by cursor. Nothing scans the whole file | `store` |

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
| `assistant` → `message.usage` | `usage`, **normalised to a delta** (D75) |
| `user` → content `tool_result` | `tool.result` |
| `control_request` / `can_use_tool` | `permission.request` |
| `result`, subtype success | `turn.ended`, `stopReason: 'completed'`; close stdin |
| `result`, any other subtype | `turn.ended`, `stopReason: 'error'`; close stdin |
| `close` with no `result` seen | `turn.ended`, `stopReason: 'process_exit'` |
| A record on the ignored list below | *nothing*, deliberately — **not** `adapter_unknown_record` |

Launched with `-p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio`, plus `--model <model>` when the session names one and
`--resume <cliSessionId>` when the manager supplies one. **`-p` is not optional**: without it
the CLI does not run non-interactively and the stream-json transport never starts. Outbound
user messages and `control_response` are single JSON lines written to stdin, which stays open
for the whole turn.

**The twelve rows are not the CLI's whole vocabulary, and the mapper must not treat them as
one** (D92). The live stream carries records that are ordinary, harmless, and no part of this
vocabulary; raising `error / adapter_unknown_record` for each would put a diagnostic line in
front of the operator on every routine turn. The adapter therefore holds a named ignore list —
top-level `rate_limit_event` and `control_response`, and the `system` subtypes `hook_started`,
`hook_response`, `thinking_tokens` and `post_turn_summary` — and returns silently for those.
Anything outside both the twelve rows and that list still raises `adapter_unknown_record`,
non-fatally, with the record preserved in `raw`. The list is a vendor fact and lives with the
vendor's adapter; adding to it is an adapter change, never a change to `ErrorEventKind`.

`updatedPermissions` is never sent. Standing approvals are held by this server and matched
here, so that every match still produces a `permission.request` / `permission.resolved` pair
and an audit record.

**`permission_suggestions` is forwarded unmapped, and no consumer may read a forwarded element
as a `PermissionSuggestion`** (D104). `PermissionSuggestion` names `{ label, rule }` against a
`StandingRuleExpression` whose grammar is undecided — `## Unresolved` 2, issue #16 — so there is
nothing here to map onto yet, and inventing one would be inventing that grammar. The adapter
therefore passes the vendor's array through as it arrived. Nothing exercises this today: no
observed CLI run has produced a `control_request` at all (D88), and the fixture sends an empty
array. This paragraph is deleted when #16 lands and the mapping is written.

Policy for every Claude session: `{ mode: 'interactive', sandbox: null, banner: null }`.

**Claude's usage is per-message, not cumulative, and the arithmetic the adapter owes is
de-duplication rather than subtraction** (open question 14, answered for Claude by S1).
Each `assistant` record reports that API call's own marginal usage, so nothing is subtracted.
But one logical message arrives as several `assistant` records that share a `message.id` and
repeat byte-identical usage, so the adapter emits `usage` **once per `message.id`** and drops
the repeats. The `result` record's usage is a different and larger basis and has no row in
this table; mixing it in would misreport burn. Probes and fixtures:
`design/findings/S1-claude-adapter.md`. The obligation stays the adapter's; no caller
compensates for it.

## Vendor mapping — Codex

**The rollout-schema hypothesis is dead.** The table this section previously carried was drawn
from the on-disk rollout schema in `tools/Measure-Session.ps1`, upstream of which is
`SubZeroDev.AgentKit`, and **none of its record shapes appear on any live stream**. S8.1 probed
the installed CLI (`codex-cli 0.146.0`) and found *two* live interfaces, neither matching it:
`codex exec --json` and `codex app-server`. Probes, commands and transcripts:
`design/findings/S8-codex-adapter.md`.

**The source is `codex exec --json`** (D107). `app-server` is the richer interface — per-item
deltas, thread-scoped ids, explicitly marginal usage, and a real approval round trip — and every
one of those advantages costs a change this document may not make. It is a long-lived JSON-RPC
server spanning turns, where `Adapter.send` spawns *the turn's* child and holds its stdin; and
its reachable `on-request` prompt reopens D5. Both are `/design`'s.

Launched with `--json -s <sandbox> --skip-git-repo-check`, the prompt on stdin. `SandboxMode`
maps `read-only` → `read-only`, `workspace-write` → `workspace-write`, `unrestricted` →
`danger-full-access` (`codex exec --help`, 0.146.0). **Unlike Claude, stdin carries the prompt
and nothing else**: this interface has no inbound control channel. `Adapter.respond` therefore
needs no Codex behaviour and gains no error variant — a `preauthorised` session emits zero
`permission.request` events, so nothing above ever calls it, and a stray answer is already
refused by the manager before it could.

| CLI stdout | Normalised |
|---|---|
| `thread.started` | `AdapterNotification` `cli-session`; `cliSessionId` = `thread_id` |
| `turn.started` | *nothing* — the manager mints the `turnId` and emits `turn.started` itself |
| `item.completed`, item `reasoning` | `thinking` |
| `item.completed`, item `agent_message` | `message`, role assistant |
| `item.started`, item `command_execution` | `tool.call`; `callId` = `item.id`, `name` = `'command_execution'`, `input` = `{ command }` |
| `item.completed`, item `command_execution` | `tool.result`; `callId` = `item.id`, `ok` = `exit_code === 0`, `output` = `aggregated_output` |
| `turn.completed` | `turn.ended`, `stopReason: 'completed'` |
| `close` with no `turn.completed` seen | `turn.ended`, `stopReason: 'process_exit'` |

**Eight rows is not the vocabulary, and unlike Claude's list this one is knowingly short.** The
rows above are every shape S8.1 *observed*. They are not every shape the CLI emits — see
`## Unresolved` 12, which names what is missing and why no row may be written for it yet.

**There is no `tool.result` on the wire; the adapter synthesizes the split** (D108). A command
execution is one item whose lifecycle carries its own result as a field update — `item.started`
with `status: 'in_progress'`, then `item.completed` with the same `id` now carrying
`aggregated_output` and `exit_code`. The `tool.call` / `tool.result` pair this contract requires
is manufactured from those two states, never read off the wire as two records. An
`item.completed` whose `item.started` was never seen still emits both, in order, so the
renderer's "`tool.result` always follows its `tool.call`" rule holds unconditionally.
`ToolCall.summary` is rendered from `command`, and the Claude summariser is not reused: it keys
on Claude's tool names and would fall through to the bare name for every Codex call.

**`callId` is unique within a turn only, and nothing in this contract needs more** (D109).
`exec --json` numbers items with a per-turn counter (`item_0`, `item_1`, …) that restarts on
every resumed turn — confirmed across two independent resumes. That is the condition **S8.7**
stops on, and it is recorded here rather than resolved: every correlation this contract performs
is already keyed by `(turnId, callId)` — `ToolCall` and `ToolResult` both carry `turnId`, the
blob path is `tool-output/:turnId/:callId`, and the manager's pending map is per-turn and keyed
by `requestId`. Whether that discharges open question 7 or a server-side alias is still owed is
`/design`'s ruling, and S8 stays stopped at S8.7 until it makes one.

Policy for every Codex session:
`{ mode: 'preauthorised', sandbox: <the mode chosen at launch>, banner: <naming that mode> }`.
**`approval_policy = 'on-request'` is unreachable on this interface, and reachable on the other.**
S8.1 set it, prompted a write under `read-only`, and saw no approval record of any kind: the
sandbox denied the write and the agent reported the failure in its own message. `exec` is
non-interactive by construction. Over `app-server` a genuine JSON-RPC approval request arrives.
Open question 4 is therefore answered *yes for the vendor, no for the interface adopted here*,
and D5 stands unreopened.

**The adapter must fail loudly, not degrade quietly.** If the stream does not match, return
`AdapterError.schema_mismatch` and emit `error / adapter_schema_mismatch` with
`fatal: true`. A Codex adapter that silently renders nothing is worse than one that refuses
to start, because the operator will believe the agent is thinking.

**That rule cannot be armed against the table above, and S8.5 may not be implemented until it
can.** `schema_mismatch` is specified fatal, so every item type absent from the table refuses
the session outright. The type union has **eighteen** variants against the three observed here,
and an operator whose agent edits a file or runs a search would be refused for ordinary traffic.
Claude solved the same problem with a named ignore list (D92); Codex needs one, and it cannot be
written from an enumeration nothing has watched arrive. Until `## Unresolved` 12 closes, the
adapter treats an unmodelled item type as `adapter_unknown_record`, **non-fatally**, with the
record preserved in `raw` — Claude's behaviour, deliberately, because refusing on the strength
of an incomplete list is the failure this paragraph exists to prevent.

## Unresolved

Signatures the design does not determine. Nothing downstream may invent them. Twelve items.
Items 5 to 11 were new in the tier-two pass and each names the issue that carries it. Item 12
is new in this one and is the odd one out in kind: the others wait on a decision, it waits on
an observation, and it names an issue for one of its four bullets only.

1. **`Attachment`.** `POST /api/sessions/:id/message` previously carried
   `attachments?: Attachment[]` against a type that was never defined, and no section of
   `10-design.md` describes attachment handling — not the transport to the CLI, not storage,
   not the byte cap, not the audit consequence of a file reaching an agent. The field is
   removed from the route rather than left dangling. Restoring it needs a design decision
   first. (#22)
2. **The standing-rule grammar, and where a standing rule lives.**
   `StandingRuleExpression` is opaque here because open question 8 is open: whether
   `permission_suggestions` from the Claude CLI is a sufficient grammar for "always allow",
   or whether a local rule language is needed. D35 makes this blocking for the slice that
   ships standing approvals — the server does the matching, so it needs a grammar it can
   evaluate. Separately, the design describes the behaviour and gives the rule no home: no
   entity, no field, no file, and no statement of its lifetime across session end or restart.
   Until both are decided, no `match(rule, request)` signature can be written, `scope:
   'always'` cannot be implemented, and `ResolvedScope: 'standing'` is unreachable. (#16, #37)
3. **Resolved by S8.1 and superseded by item 12.** The three normalised kinds that had no
   source record now have one: `message` and `tool.call` / `tool.result` are in the table
   above, the last pair synthesized from a single item's two lifecycle states (D108). What
   replaced this is narrower and is carried as item 12. (#14, #18)
4. **`ToolCall.summary`'s renderer.** The design calls it "server-rendered" and names no
   owner. It is emitted by the adapter in the shape above, which makes it vendor code
   producing a display string — the one place that reading is uncomfortable. It is not
   moved here because moving it would put tool-shape knowledge in the session manager, which
   is exactly what the vendor boundary forbids. (#23)
5. **Which module serves `GET /api/audit`.** The route is determined and is tier one; its
   owner is not. `10-design.md § Module boundaries` gives the incident read to `records`,
   which is tier two, so as drawn tier one cannot serve brief item 7 without building part of
   tier two. `Store.readAuditPage` is written above because reading `audit.ndjson` is
   unambiguously `store`'s, and an edge may not call `store` directly — so the missing piece
   is exactly one method on one module, and this contract does not choose which. (#34)
6. **How the edge obtains a `SessionSnapshot` for a review about a session the author does
   not own.** `records.createReview` takes the snapshot as a parameter (D77) and that part is
   settled. What is not: the threat model says writing a review about another operator's
   session is deliberately open, while the only route to a session is the ownership check that
   answers `404` to a non-owner. The two cannot both be true, and the resolution decides
   whether `POST /api/reviews` needs a manager method that does not apply that check. (#32)
7. **The write-protocol ordering for record-log mutations.** The design states two orders in
   two places — the registry claimed synchronously before the append, and the append landing
   before any registry mutation — and they cannot both hold. The signatures above are
   deliberately compatible with either, and `RecordsError.storage` says only that a failure
   leaves the registry and the file agreeing. (#31)
8. **What "burn" is measured in for `remainingTokens`.** `PayrollView.burn` is a component-wise
   sum and is determined. The subtraction is not: brief item 8's "budget remaining" needs one
   scalar, and nothing says whether cache reads and cache creation count against a budget
   alongside input and output tokens. The budget's *scope* is a separate open owner decision
   which this contract follows the design in taking as per session. (#29, #30)
9. **The checklist tick's session-state refusal and eligibility rule.** Every other route that
   writes to a session refuses once it has ended; this one, as drawn, checks only ownership and
   the template. Whether a tick on an ended session is refused, and whether every session has a
   checklist or only one opened through a requisition, are both unstated. The route above
   therefore lists no `409 session_ended`, and that omission is the open question, not a
   ruling. (#41)
10. **Review finalisation's concurrency guard, and a torn tail that un-finalises.** `updatedAt`
    now gives the PIP fold an ordering key, which was one half of this. The other half is
    mechanism: nothing states that finalisation is claimed under I5, and the accepted
    latest-line-wins reversion applied to `reviews.ndjson` can retract a final review that
    other operators have already seen and that may have raised a PIP badge. I29 states the
    invariant; what enforces it across a crash is undetermined. (#35, #36)
11. **How a removed or retyped field in `reviews.ndjson` or `requisitions.ndjson` is
    migrated.** Every other persisted shape gates on `meta.json`'s `schemaVersion`, and these
    two files are not under it. Adding fields is safe today; removing or retyping one has no
    stated rule and no discriminator to hang one on.
12. **Four facts `codex exec --json` has not been watched producing.** S8.1 answered its five
    questions and its probes were real, but a single happy-path turn is not an enumeration, and
    the gap is what stops S8.2 from being fully met. Each item below is a probe, not a design
    question, and none may be filled from `codex app-server generate-json-schema` — that dumps
    the *other* interface's protocol, and reading this one's rows out of it would repeat exactly
    the mistake `agent.md` records against `--permission-prompt-tool stdio`.
    - **The item-type ignore list.** The type union has eighteen variants
      (`userMessage, hookPrompt, agentMessage, plan, reasoning, commandExecution, fileChange,
      mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView,
      sleep, imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction`) against
      three observed. Which are ordinary traffic to ignore, which map, and which are genuinely a
      `schema_mismatch` is undetermined, and it is what arms S8.5. `contextCompaction` looks like
      `session.notice` (`compaction`) and `fileChange` like a second `tool.call` shape — both are
      guesses and neither is written above.
    - **`item.updated` and `turn.failed`.** Both are present in the shipping binary's string
      table and neither was observed. If `item.updated` carries incremental text it is
      `message.delta`'s source, which changes what the renderer can do; `turn.failed` is
      presumably `stopReason: 'error'` and presumption is not a row.
    - **Whether `turn.completed.usage` is cumulative or marginal.** D75 makes the adapter owe a
      delta. S8.1 saw `input_tokens` and `cached_input_tokens` both almost exactly double across
      two resumed turns and stopped short of calling it, and `app-server`'s separate `total` and
      `last` make cumulative the better reading — but the arithmetic the adapter owes is the
      difference between a correct burn figure and a doubled one, and no `usage` row appears
      above until it is observed. This is open question 14's Codex half. (#30)
    - **Whether `exec resume <thread_id>` resumes by id.** `Adapter.send` takes
      `resume: CliSessionId | null` and needs resumption *by that id*. `codex exec resume --help`
      documents a `SESSION_ID` argument and S8.1 only ever ran `--last`, which the manager cannot
      use — it would resume whichever session the host touched most recently, not this one.
      Documented is not observed.
