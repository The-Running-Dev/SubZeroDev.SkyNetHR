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

// The persisted session record: exactly what `meta.json` carries, and nothing more. The
// live turn is deliberately absent — `meta.json` is the session minus turn, buffer and
// subscribers (D49) — and `LiveSession` below is where it lives instead.
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

// The two fields of the session manager's registry entry that the invariants are stated
// over: the persisted record, plus the one piece of state that is never written.
// `turn === null` means idle, and it is always null once `state === 'ended'` — which is what
// makes I8 assertable against a declared field rather than against a field only
// `10-design.md § Data model — Session` names.
//
// **The manager's actual entry extends this**, and the extension is deliberately not
// declared: fan-out bookkeeping, the per-session append chain, the standing-rule list and
// the flags that decide whether a later turn retries a doomed checkpoint are scheduling
// state that crosses no module boundary, and a contract that enumerated them would have to
// be amended every time the manager learned a new thing about its own turns. What is
// declared is what something outside `session-manager` may assume. The ring buffer and the
// subscriber set are named here only to say they are *not* it: the ring is `store`'s,
// reached by `pushRing` / `readRingAfter` on a `SessionId`, and the subscriber set never
// leaves the manager's fan-out.
interface LiveSession {
  readonly record: SessionRecord;
  turn: Turn | null;
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
  // Carried from the originating `PermissionRequest` so that `answerPermission` can enforce
  // I43 — `scope: 'always'` against an unprojectable request is `bad_request` — without
  // re-reading `input`, which would put tool-shape knowledge in `session-manager` and break
  // I46. It is a copy of the adapter's projection, never a second projection.
  readonly matchTarget: string | null;
}
```

A live `Turn` hangs off `LiveSession.turn` and nowhere else. **It carries no child-process
handle.** The child is spawned inside `Adapter.send` and terminated through `Adapter.kill`, so
the handle never crosses into `session-manager`, and declaring a second reference to it here
would give the manager a way to reach a process the adapter is the only declared owner of.

`pending`'s value type is all four fields of `PendingPermission`, because `answerPermission`
must enforce I43 — `scope: 'always'` against a request whose `matchTarget` is `null` is
`bad_request` — and append I11's audit record carrying `tool` and `input`, without re-reading
the originating request. Re-reading it is what would put tool-shape knowledge in
`session-manager` and break I46 (D109).

Both of these stood here as declared divergences from `10-design.md § Data model — Turn`,
which listed a `child` row and typed `pending` as `{callId}`. That section now states neither;
the divergences are closed.

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

**A reader must never hand back a tombstone as an open record.** Liveness comes from the latest
line for a `pid`; `startedAt` and `image` must come from that pid's most recent **spawn** line,
because the reuse guard reads all three of `exitedAt`, `startedAt` and `image` (I19) and a reader
that took them off the tombstone would find two of them missing and reap on a guard that never
ran. That is the requirement; folding the two shapes is one way to meet it and not the only one.
Filtering the latest line on `exitedAt === null` meets it too, because a tombstone always carries
a non-null `exitedAt` and so never survives the filter — which is what `store` does.

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

// The three ways into `ended` (D45): D36 operator, D20 restart, D41 storage failure. **No
// `session.ended` carries `server_restart`.** Boot appending one was D45's rejected alternative,
// dropped with the derive-state-from-the-stream proposal it belonged to, and nothing has
// added it since — so this value names a real transition that is never on the wire. It is
// retained knowingly, exactly as `SessionStarted.state` is, and an implementer must not close
// the apparent gap by emitting one at boot. A rehydrated session's state is read from
// `SessionSummary.state`. What boot *does* append is `session.notice / server_restart` (D130),
// which shares the spelling and is a different thing: a notice is not an end reason, and it
// marks where the outage fell without claiming to say why the session ended.
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
  | 'sandbox'                  // **no producer, retained knowingly.** Superseded by
                              // `PermissionPolicy.banner`, which the client renders instead and
                              // which survives a replay because it is a session field rather
                              // than an envelope (S8.3). Kept rather than removed: dropping a
                              // member narrows a declared union and buys nothing
  | 'audit_unavailable'        // a permission was denied because the audit append failed
  | 'storage_failure'          // a spill write failed; the session is ending
  | 'server_restart'           // boot found this session live at shutdown (D130)
  | 'usage_unavailable';       // this session's transport reports no token usage, so its burn
                              // is unknown rather than zero (D146). Emitted once, at session
                              // start, by whichever adapter selects a transport that cannot
                              // report usage — today only `codex exec --json`

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
  // **No producer, retained knowingly** (D151). Every adapter and every synthesised close
  // emits `null` here, because D75 puts the vendor-normalised, summable figure on the
  // dedicated `usage` envelope and `PayrollView`'s fold reads only that. A reader that
  // summed both sources would double-count a turn's burn the moment anything populated
  // this — the failure I28 exists to prevent. Kept rather than removed: dropping a field
  // narrows a declared public interface, and the slot is where a vendor-reported turn
  // total would go if one ever proves worth carrying.
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

// `"<tool>:<pattern>"`. Constrained: /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^\r\n]+$/ , and no
// longer than `Caps.standingRuleBytes` as UTF-8. The half before the first colon is compared
// for equality against `PermissionRequest.tool`; every later colon belongs to the pattern.
// The pattern is matched against `PermissionRequest.matchTarget` in full, anchored at both
// ends, byte for byte and case-sensitively, with no normalisation on either side. `*` is the
// only metacharacter: it matches any run of characters, including the empty run, except
// `;` `&` `|` `<` `>` `` ` `` `$` CR LF. There is no escape, so no rule matches a literal
// `*`. Nothing else in the pattern is special. Minted only by `parseStandingRule`.
type StandingRuleExpression = Brand<string, 'StandingRuleExpression'>;

interface PermissionRequest {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly callId: CallId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;   // exactly what will run, never a summary
  // The one string a rule's pattern is matched against, projected from `input` by the adapter
  // and emitted verbatim. `null` where the adapter defines no projection for this tool, and
  // then no standing rule may be created against this request (I43).
  readonly matchTarget: string | null;
  // The vendor's `permission_suggestions`, forwarded exactly as it arrived (D104). Unverified
  // on this transport; no module narrows, parses, or indexes it (I44).
  readonly suggestions: readonly unknown[];
}

type PermissionDecision = 'allow' | 'deny';
type AnswerScope   = 'once' | 'always';                // what a client may send
type ResolvedScope = 'once' | 'always' | 'standing';   // 'standing' = matched a stored rule

type PermissionResolvedReason =
  | 'answered'                // an operator answered
  | 'preapproved'             // matched a standing rule held by this server
  | 'cancelled_process_exit'  // the child died, or was interrupted, or boot closed the turn
  | 'superseded'             // **no producer, and reserved rather than dead.** Nothing resolves
                             // one request because another replaced it; if such a path is ever
                             // added this is its reason, and until then it must not be repurposed
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
  authoritative current state is `SessionSummary.state` from `GET /api/sessions` or
  `GET /api/sessions/:id`, or the
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
  // On `scope === 'standing'` this is the matched `StandingRuleExpression`, verbatim. That
  // is what makes an auto-approval explain itself without a new persisted field.
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
  readonly nextCursor: AuditCursor | null;    // null when the read reached the oldest record
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
  readonly remainingTokens: number | null;  // budgetTokens minus burn's full component-wise sum
                                             // (input, output, cache reads, cache creation);
                                             // null when budgetTokens is null (D129)
  readonly idleMs: number;                  // live-with-no-turn wall clock
  readonly droppedIntervals: number;        // idle intervals discarded for spanning a restart
}
```

**`session.notice / server_restart` is the fold's only restart marker, and `turn.ended`'s
`server_restart` stop reason carries no fold meaning** (D130). The fold walks the spill and
stops billing at that notice: the idle interval the notice closes, **if one was open**, is
dropped and counted in `droppedIntervals`, and nothing after it is billed. Both restart cases
fall out of the one rule — a server that went down while the session sat idle between turns
had an interval open, so it reports one dropped; a server that went down mid-turn had none,
because the outage was inside a turn and was never idle to begin with, so it reports zero and
the outage is attributed to the turn. Reading `turn.ended { stopReason: 'server_restart' }` as
the marker instead is what leaves the idle case unmarked entirely, since D39 appends that
close **only** where the spill ends on an unpaired `turn.started`.

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
  readonly standingRuleBytes: number;        // rejection threshold for one StandingRuleExpression
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
  // `Max-Age` on the cookie `POST /api/login` mints. Only read under
  // `auth.mode === 'shared-secret'`; ignored under either header mode, where the credential
  // is the upstream proxy's and its lifetime is not ours to set. A session lifetime is a
  // deployment's security posture, not a constant — a literal here is the buried-constant
  // failure `10-design.md § Module boundaries` names for caps, and it applies harder to
  // this, because shortening it is what a deployment does after an incident.
  readonly sessionCookieMaxAgeSeconds: number;
  readonly includeRaw: boolean;
  readonly sessionTokenBudget: number | null;              // (tier two) per session; null disables the view's budget
  readonly checklist: readonly ChecklistItemTemplate[];    // (tier two) empty disables the checklist
  // D10/D117: which transport edge this deployment binds. `server.ts` constructs
  // `createSseEdge` or `createWsEdge` accordingly; exactly one binds (S11.5).
  readonly edge: 'sse' | 'ws';
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
  appendReview(record: Review): Promise<Result<void, StoreError>>;   // durable: fsync before it returns (D128)
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
  // commit(safety) → read-tree --reset -u <sha> → clean -fd → verify. Returns the safety
  // checkpoint, never the target. See below for why the middle operation is not D31's.
  restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha): Promise<Result<Checkpoint, CheckpointError>>;
  destroy(sessionId: SessionId): Promise<Result<void, CheckpointError>>;
}

declare function createCheckpoints(config: Config): Checkpoints;
```

**Restore's middle operation is `read-tree --reset -u`, not D31's `checkout <sha> -- .`**
(D112). D31 pairs `checkout` with `clean -fd` so that a file created after the target is
removed rather than left behind, and against untracked files that holds. It does not hold
against tracked ones, and the safety checkpoint is what makes them tracked: `commit` runs
`add -A` first, so every file the agent created is in the index by the time `checkout` runs.
`checkout <sha> -- .` writes only paths present in the target's tree and `clean` never
removes a tracked path, so such a file survives both operations — the exact failure D31 was
written to close, reintroduced by D31's own first step. `read-tree --reset -u` makes index
and work-tree match the target exactly, additions, edits and removals alike, without moving
`HEAD`, so the shadow history stays linear and `list`'s `git log` still walks it.

`clean -fd` is retained behind it, for the directories `read-tree` empties but does not
remove. No `-x` under either operation, so a path the workspace's own `.gitignore` covers is
untouched — D31's symmetry argument is unchanged, and a restore still cannot force a
dependency reinstall.

**Success is verified, not inferred from an exit code.** `read-tree` exits 0 with a warning
when it cannot remove a directory an embedded repository occupies, and `clean` declines such
a directory unless forced twice, which this deliberately never does. So the sequence ends
with `diff --quiet <sha>` for tracked content and `ls-files --others --exclude-standard` for
what was left behind; either coming back dirty is `CheckpointError.restore_incomplete`. The
partially-restored row in `10-design.md § Failure modes` is unchanged and is now *detected*
rather than assumed absent.

**This amendment is discharged.** `10-design.md § Data model — Checkpoint` describes the
`read-tree` sequence and why D31's own `add -A` defeats `checkout`, and D31 carries a
supersession banner naming D112. Nothing is queued here for a later pass.

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
deployment knob** (D91). `createClaudeAdapter` and `createCodexAdapter` each take an optional
`executable`, defaulting to `SKYNET_<VENDOR>_EXECUTABLE` and then to the vendor's own name, so
a fixture CLI speaking the
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
  // No caller today: every read path the client has goes through `listRequisitions`.
  // Reserved for a single-requisition read, and retained rather than removed because a
  // decision route that wants to report the current state without listing all of them is
  // the obvious next caller (D145).
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
  // The D72 fold; drafts excluded. **No caller above `records` today, and that is the
  // shape D72 forces rather than an omission**: PIP is derived and never served as a
  // session field, so the fold has to run wherever the finals already are — which for the
  // badge is the client, over `GET /api/reviews?subject=`. This is the server-side
  // statement of I35, kept so the invariant can be asserted against an implementation in
  // the module that owns it instead of only against browser code (D145).
  isUnderPip(subject: SessionId): boolean;
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
  // Required, and only permitted, when scope === 'always'. Operator-typed at answer time and
  // never parsed from a vendor suggestion. `scope === 'always'` additionally requires
  // `decision === 'allow'` and a non-null `matchTarget` on the named request (I43).
  readonly rule: StandingRuleExpression | null;
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

  // Not session-scoped and takes no owner, like `boot`: D70 opens this read to every
  // authenticated operator. A pure delegation to `Store.readAuditPage` — it exists here,
  // not on `records`, because `records` is tier two and this route is tier one (`## Unresolved` 5).
  readAudit(query: AuditQuery): Promise<Result<AuditPage, StoreError>>;

  // Tier two. No owner, shaped like `readAudit` for the same reason: D70 opens a review about
  // any session to every operator, not only the session's own owner. `null` for a session that
  // does not exist; `POST /api/reviews` turns that into `404 no_such_session` (D127).
  getSnapshotForReview(sessionId: SessionId): SessionSnapshot | null;
}

declare function createSessionManager(deps: {
  readonly config: Config;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
  readonly records: Records;   // (tier two) for the requisition claim during create, only
}): SessionManager;

// The grammar, owned by `session-manager` per D35. Both are pure and total: no I/O, no state,
// no tool knowledge, no vendor knowledge.
declare function parseStandingRule(text: string, caps: Caps): StandingRuleExpression | null;
declare function match(rule: StandingRuleExpression, request: PermissionRequest): boolean;
```

`tickChecklistItem` is idempotent: a second tick for an item already complete emits no second
envelope and still succeeds.

**Standing rules.** `parseStandingRule` is the only way to mint a `StandingRuleExpression`; it
returns `null` for anything failing the constraint on that type, which `answerPermission` maps
to `bad_request` naming `rule`. `match` reads `rule`, `request.tool` and `request.matchTarget`
and nothing else — never `input` — which is what keeps tool-shape knowledge inside `adapters/*`
where `## Unresolved` 4 says it belongs (I46). It returns `false` whenever `matchTarget` is
`null`, so an unprojectable tool is unmatched rather than universally matched.

A rule lives in its session's in-memory state and nowhere else: no field on `SessionRecord`, no
line in any file, no entry in `meta.json`. **There is therefore no persisted schema and no
migration story for standing rules — that is the ruling, not an omission.** A session rehydrated
at boot holds none, and the operator is asked again (I45). This is narrower than S10.5, which
only requires that a *new* session on the same workspace asks again; the stronger form is chosen
because a grant that outlives the process holding it cannot be revoked by ending the session,
which is the only revocation this design offers.

A standing rule is never handed to the child. `updatedPermissions` is not written to stdin under
any decision (I47) — that is the whole of D35 and the reason this grammar exists at all.

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

`createWsEdge`'s `RequestListener` serves the whole `## HTTP routes` table exactly as
`edge/sse`'s does, with one substitution: `GET /api/sessions/:id/events` is not reachable as a
plain request under this edge — a client that tries it is refused `422 bad_request`, naming
the field `upgrade` — because that route's real handler runs on the `http.Server`'s
`'upgrade'` event, which a bare `RequestListener` is never given. `createWsEdge` attaches its
upgrade handler to the returned function as `.handleUpgrade` — `(req, socket, head) => void`,
Node's own `'upgrade'` listener signature — and `server.ts` reads it off and wires
`server.on('upgrade', listener.handleUpgrade)` whenever `config.edge === 'ws'`. This is an
implementation-only extension of the returned value, not a widened contract signature: the
function is still exactly a `RequestListener` to every caller that only calls it as one.

The WebSocket connection, once the handshake and first-message auth (S11.3) both succeed,
carries the same `Envelope` stream `edge/sse` writes as SSE `data:` lines — one JSON-encoded
`Envelope` per text frame, in `seq` order, nothing else multiplexed onto the same socket. The
first client frame is JSON `{ after?: Seq }`, read exactly as `Last-Event-ID` is on the SSE
edge (S11.4): omitted or `0` replays from the start, otherwise from `after + 1`, including the
spill-served case (S3.2) and the gap case (S3.3), where `error / replay_gap` is sent as a
frame carrying no resumable position, exactly as SSE's gap frame carries no `id:`.

**How the client learns which edge is live (S11.5).** `index.html` carries
`<meta name="skynet-edge" content="sse">` or `content="ws"`, set by whichever edge serves the
document — this is a `<meta>` tag, not a `<script>`, so it costs the strict CSP nothing. The
client reads it once at load and never probes.

### `client`

No runtime interface. It consumes `Envelope` and the HTTP routes below. Its rendering rules
are binding and are in `10-design.md § Security controls`: a strict CSP with no
`unsafe-inline`, no `innerHTML` for anything this codebase did not write (D74), and the four
themes as CSS custom properties toggled by a root attribute, with the choice held in browser
storage and never sent here (D60, D78).

## HTTP routes

All request and response bodies are JSON unless stated. **Every route under `/api/` requires
authentication, with exactly one exception — `POST /api/login`, which cannot, because it is
what mints the credential.** The static client assets the same listener serves — `/`,
`/app.js`, `/render.js`, `/app.css`, `/theme.js` — are outside `/api/` and outside this rule: they are the
console's own code, they carry no operator's data, and a page that refused to load before
authentication would have nothing left to authenticate with.

Every `POST` and `DELETE` under `/api/` requires an origin match, checked before identity is
resolved — `POST /api/login` included, since the origin check precedes both.

### Identity

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/login` | `{ secret: string }` | `200 { ok: true }` + `Set-Cookie` | `403 bad_origin`, `401 unauthenticated`, `404 no_such_session`, `422 bad_request` |

**Served only under `auth.mode === 'shared-secret'`**; under either header mode the route does
not exist and answers `404`, because the credential it would mint is one the deployment has
said it does not use. The secret is compared in constant time. The cookie is
`<auth.cookieName>=<secret>; SameSite=Strict; HttpOnly; Path=/; Max-Age=<Config.sessionCookieMaxAgeSeconds>`
— the attributes are defence in depth and the origin check is the control (D29,
`10-design.md § Security controls`).

The `404` is `no_such_session` because `ApiErrorCode` carries no route-level not-found; see
*Error semantics*.

### Sessions

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/sessions` | `CreateSessionInput` | `201 { sessionId }` | `403 bad_origin`, `401 unauthenticated`, `409 outside_workspace_root`, `409 workspace_busy`, `404 no_such_requisition`, `409 requisition_not_approved`, `409 requisition_consumed`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/message` | `{ text: string }` | `202 { turnId }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/permission` | `PermissionAnswer` | `200 { accepted: boolean }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/interrupt` | `{ turnId: TurnId }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/end` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `POST` | `/api/sessions/:id/checkpoint/restore` | `{ sha: GitSha }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `404 no_such_checkpoint`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `500 checkpoint_failed` |
| `DELETE` | `/api/sessions/:id` | — | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `GET` | `/api/sessions` | — | `200 { sessions: SessionSummary[] }`, caller's own only | `401 unauthenticated` |
| `GET` | `/api/sessions/:id` | — | `200 { session: SessionSummary }` | `401 unauthenticated`, `404 no_such_session` |
| `GET` | `/api/sessions/:id/events` | `Last-Event-ID` header | `200 text/event-stream` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/checkpoints` | — | `200 { checkpoints: Checkpoint[] }` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/tool-output/:turnId/:callId` | — | `200 text/plain; charset=utf-8` | `404 no_such_session`, `404 no_such_output` |

`GET /api/sessions/:id` is the single-resource read of the same `SessionSummary` the list
route returns, under the same ownership check, and it exists so that a client holding one
`sessionId` can re-read that session's authoritative `state` without fetching every session
it owns. It answers `404 no_such_session` for a session that is not the caller's, exactly as
every other route under `/api/sessions/:id` does.

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
| `GET` | `/api/audit` | `AuditQuery` as query parameters | `200 AuditPage` | `401 unauthenticated`, `422 bad_request`, `503 agent_unavailable` |

Readable by every authenticated operator, not scoped to the caller's own sessions (D70): the
question this log answers crosses sessions, and scoped to one operator it answers only "what
did I approve". The window is bounded by `Caps.auditPageMax` and resumed by `nextCursor`;
there is no unbounded read, because this is the one file that grows for the deployment's
lifetime. The incident view of brief item 11 is this route with `incidentsOnly: true`.

**`Caps.auditPageMax` bounds records *examined*, not only records returned, and the
consequence is that a page may be short — or empty — with a cursor still to follow.** A
filter bounded only by its result count is not bounded at all: a query matching nothing walks
to the start of the file, which is exactly the scan D73 refuses and the one that grows with
the deployment rather than with the answer. So a read stops at whichever comes first, `limit`
matches or `Caps.auditPageMax` records inspected, and reports where to resume either way. **A
short page is therefore not the end of the log and a caller must not read it as one**; only
`nextCursor === null` is.

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
| `POST` | `/api/sessions/:id/checklist/:itemId` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `404 no_such_item` |

Both checklist routes are under `/api/sessions/:id` and carry the ownership check: only the
session's owner may read or tick its checklist. Every session has a checklist, and a tick on
an ended session is `409 session_ended` (D122).

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
| 409 | `session_ended` | The session is ended: it accepts no new turn, no checklist tick, and no restore |
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
| 409 | `review_final` *(tier two)* | A final review accepts no further append — and neither does one whose own append is still in flight (D120) |
| 404 | `no_such_item` *(tier two)* | No such `itemId` in the configured checklist template |
| 500 | `record_write_failed` *(tier two)* | The record-log append failed; nothing changed anywhere |
| 500 | `payroll_unavailable` *(tier two)* | The fold could not read the spill; the session itself is unaffected |

**An unknown route has no code of its own, and the two substitutes it gets are split by
prefix.** This union carries no route-level not-found, so:

- A path **outside `/api/`** that is not one of the five static client assets answers
  `404 no_such_session`. So does `POST /api/login` under a header auth mode, where the route
  genuinely does not exist for that deployment.
- A path **under `/api/`** that this build does not serve — including an unrecognised
  sub-route under an existing session id — answers `422 bad_request`, naming the offending
  path or sub-route in `detail.field`.

The consequence of the first is stated so a client does not read more into it than it holds: a
`404 no_such_session` distinguishes "no such session", "not your session" and "no such route"
from each other in none of the three cases. The consequence of the second is that a `422` from
a session sub-route means *this build serves no such route*, and is deliberately not a `404`
against the session — a client must not read it as "this session does not exist". Adding a code
to separate route-level not-found from both is additive and is not done here (D116).

**`SessionError.storage` reaching an edge is reported as `503 agent_unavailable`.** Every
storage failure the error table below routes by call site — a spill append ends the session,
an audit append denies the permission, a blob read is `404 no_such_output`, a record-log
append is `500 record_write_failed` — and what is left is a storage failure during `create`,
where no more specific declared refusal exists. `503` is right (it is transient and the
caller should retry); the code name is not, and it is retained rather than multiplied because
the alternative is a `storage_unavailable` variant whose only caller is this one path.

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
  | { readonly code: 'records'; readonly cause: RecordsError }
  | { readonly code: 'payroll_unavailable'; readonly cause: StoreError };
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
| `CheckpointError.restore_incomplete` | `read-tree` or `clean` fails, **or the verification pass comes back dirty** — `diff --quiet <sha>` for tracked content, `ls-files --others --exclude-standard` for what was left behind. Never an exit code alone: `read-tree` exits 0 with a warning on the embedded-repository case (D112) | No | `error / checkpoint_restore_failed`, non-fatal, plus `500 checkpoint_failed`. **The workspace is partially restored**; the safety checkpoint is the way back |
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
| `RecordsError.review_final` | An append or a second finalise on a final review, **or on one whose own append is still in flight** — D120's exclusivity lock, refusing the second writer before either write lands, exactly as `already_decided` does for a requisition | No | `409 review_final`. Terminal in the first case and retryable in the second; a caller that cannot tell them apart retries and either succeeds or is refused again |
| `RecordsError.bad_request` | A text field over its cap, or a malformed field | No | `422 bad_request`, naming the field |
| `RecordsError.storage` | The record-log append failed | Sometimes | `500 record_write_failed`. **The registry is not mutated**; the edit is still in the operator's form |
| `SessionError.no_such_session` | Unknown id, or the caller is not the owner | No | `404 no_such_session` |
| `SessionError.session_ended` | A message, a checklist tick, or a **restore** against a session in state `ended`. Restore is refused because an ended session keeps its `cwd` while the busy check excludes only *live* sessions (D30), so a new session may already hold that workspace — restoring through the ended one would run git against a work-tree it no longer owns. `POST /:id/end` is the exception and is deliberately inert on a repeat call | No | `409 session_ended` |
| `SessionError.turn_in_flight` | A second message, or a restore, end, or delete during a turn | Yes, once the turn ends | `409 turn_in_flight` |
| `SessionError.workspace_busy` | The resolved path overlaps a live session's `cwd` | Yes, once that session ends | `409 workspace_busy`, naming the holding path and operator |
| `SessionError.no_such_item` | A tick for an `itemId` absent from the configured template | No | `404 no_such_item` |
| `SessionError.bad_request` | A malformed or missing field. On `answerPermission` this is four distinct cases, each naming the offending field: `scope: 'always'` with no `rule` (`rule`); a `rule` `parseStandingRule` refuses (`rule`); `scope: 'always'` with `decision: 'deny'` (`decision`); `scope: 'always'` against a request whose `matchTarget` is `null` (`scope`) | No | `422 bad_request`, naming the field |
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
| I5 | A guard is claimed in the same synchronous block that tests it: no `await` sits between a check and the mutation it protects. It governs six guards — the turn slot, the workspace claim, a requisition's decision, a requisition's consumption, a review's mutation, and a checklist item's completion | `session-manager`, `records` |
| I6 | No two `live` sessions have `cwd` values where one equals, contains, or is contained by the other | `session-manager` |
| I7 | `cwd` is a `ResolvedPath` inside a configured root, resolved exactly once at session creation and never re-resolved | `jail`, `session-manager` |
| I8 | `state === 'ended'` implies `LiveSession.turn === null` and `endedAt !== null`; `state === 'live'` implies `endedAt === null` | `session-manager` |
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
| I43 | A standing rule is created only where `decision === 'allow'`, `rule` parses, and the named request's `matchTarget` is non-null. Every other `scope: 'always'` is `bad_request`; none is silently downgraded to `once` | `session-manager` |
| I44 | `PermissionRequest.suggestions` is the vendor's array forwarded verbatim. No module narrows, parses, indexes, or derives a `StandingRuleExpression` from it | `adapters/*`, `client` |
| I45 | A standing rule exists only in its session's in-memory state. Nothing writes one to disk, and a session rehydrated at boot holds none | `session-manager` |
| I46 | `match` reads only `rule`, `request.tool` and `request.matchTarget`. It never reads `input`, and no tool name appears in `session-manager` | `session-manager` |
| I47 | `updatedPermissions` is never written to a child's stdin, under any decision or scope | `adapters/*`, `session-manager` |

**I40, I41 and I42 were never allocated, and the gap is left open rather than closed.** The
numbering jumps from I39 to I43 and nothing is missing. Ids here are cited by number in
`90-decisions.md`, in this document's own prose, and in `src/`, so renumbering to close a gap
would silently repoint every one of those citations — the same reason `AGENTS.md § Tracking
work` compares drift on ids and never on position.

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

`updatedPermissions` is never sent (I47). Standing approvals are held by this server and matched
here, so that every match still produces a `permission.request` / `permission.resolved` pair
and an audit record.

**`permission_suggestions` stays forwarded unmapped, now permanently rather than pending a
decision** (D104, D108). The grammar is decided and is deliberately not the vendor's: `#16`'s
finding established that this field is not merely un-mapped but **unobservable** — the
`control_request` that would carry it has never appeared on this transport across two
independent probes three days apart, and the upstream defect was stale-closed without a fix.
A mapping cannot be written against a shape nobody has seen, so the adapter passes the array
through as `readonly unknown[]` and nothing narrows it (I44). The fixture sends an empty array.
Deleting the field was considered and rejected: forwarding costs nothing and keeps the payload
from being dropped silently if the channel ever starts firing.

**`matchTarget` is this adapter's projection table**, and it is the only place tool-shape
knowledge is permitted to live (I46). It is emitted verbatim — no case folding, no separator
rewriting, no trimming:

| `tool` | `matchTarget` |
|---|---|
| `Bash` | `input.command` |
| `Read`, `Edit`, `Write` | `input.file_path` |
| anything else, including every `mcp__*` | `null` |

**Four rows, because four are what the finding names.** Every other tool in the CLI's vocabulary
projects `null` — not because a projection would be wrong, but because none has been observed
and this table is not the place to guess one. Adding a row is an adapter change carrying the
same obligation as any other row here: an observed request showing the field. It never changes
`StandingRuleExpression`.

A tool in the table whose named field is absent or is not a string projects `null` rather than a
coerced string. `null` is not a failure and raises nothing: it means a standing rule cannot be
created against that request, which the route refuses with `422 bad_request` on `scope` (I43).

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

**Observed against `codex-cli 0.146.0`, not hypothesised** (`design/findings/S8-codex-adapter.md`,
S8.1). What stood here before is **falsified**: neither live interface emits `session_meta`,
`payload.info` or `token_count`. That schema describes `~/.codex/sessions/**/rollout-*.jsonl` on
disk, which S8's *Out of scope* forbids scraping, and it is not what the CLI puts on a wire.

The CLI exposes **two** live interfaces, not one, and their guarantees differ in ways this
contract cannot average away — item-id uniqueness and the usage basis both change between them.
Both are mapped. **`app-server` is primary; `exec --json` is the fallback** (D107).

**Transport selection is the adapter's and it ends there.** `createAdapter` takes no transport
parameter and none is added: a transport is a vendor fact, and I20 forbids one above
`adapters/*`. The adapter selects `app-server` where the installed CLI offers it and `exec --json`
otherwise, once, at `create`. Where neither is available the result is
`AdapterError.agent_unavailable`, exactly as for a missing binary.

### `codex app-server` — primary

JSON-RPC 2.0 over stdio, marked `[experimental]` by the CLI itself. The shapes below are
schema-generated (`codex app-server generate-json-schema`, `v2/`), not hand-transcribed.

| Wire record | Normalised |
|---|---|
| `thread/started` | `AdapterNotification` `cli-session`, carrying `threadId`; the manager emits `session.started` on the first turn only |
| `turn/started` | *nothing* — the manager emitted `turn.started` when it claimed the slot |
| `item/started`, type `reasoning` | *nothing*; text accumulates in the adapter |
| `item/reasoning/summaryTextDelta` | *nothing*; accumulated |
| `item/completed`, type `reasoning` | `thinking`, with the accumulated text |
| `item/agentMessage/delta` | `message.delta`, role assistant |
| `item/completed`, type `agentMessage` | `message`, role assistant |
| `item/started`, type `commandExecution` | `tool.call`; `callId` is the item's `id` |
| `item/commandExecution/outputDelta` | *nothing*; accumulated |
| `item/completed`, type `commandExecution` | `tool.result`, same `callId`; `ok` from `status`, `output` from `aggregatedOutput` |
| `thread/tokenUsage/updated` → `last` | `usage` |
| `turn/completed` | `turn.ended`; `stopReason` from `turn.status` — `completed`, `interrupted`, `error`, and anything else is `schema_mismatch`. Its `last` is **not** mapped: see *Usage* |
| `item/commandExecution/requestApproval` | **unreachable under the shipped policy** — see below |
| `close` with no `turn/completed` seen | `turn.ended`, `stopReason: 'process_exit'` |

### `codex exec --json` — fallback

Newline-delimited JSON on stdout. **No deltas of any kind**: text arrives whole, on completion.

| Wire record | Normalised |
|---|---|
| `thread.started` | `AdapterNotification` `cli-session`, carrying `thread_id` |
| `turn.started` | *nothing* |
| `item.completed`, `item.type == 'reasoning'` | `thinking` |
| `item.completed`, `item.type == 'agent_message'` | `message`, role assistant |
| `item.started` / `item.completed`, `item.type == 'command_execution'` | *not mapped* — recognised and dropped, deliberately. The item's `aggregated_output`, `exit_code` and `status` are all there; what is missing is a session-unique `CallId` to correlate on. See *Item ids* below and `## Unresolved` 13 |
| `turn.completed` | `turn.ended`, `stopReason: 'completed'`. Its `usage` is **not** mapped — see *Usage* |
| `close` with no `turn.completed` seen | `turn.ended`, `stopReason: 'process_exit'` |

### Neither interface emits a `tool.call` / `tool.result` pair

Both model a command execution as **one** item with two lifecycle states — `started` with null
result fields, then `completed` on the same id carrying `aggregated_output`, `exit_code` and
`status`. There is no discrete result record to normalise. The adapter therefore **synthesises**
the contract's pair from one item's two states. This is what the falsified table's three
`(unknown)` rows could not describe, and it is why filling them was a contract amendment rather
than an adapter detail.

The ordering guarantee holds by construction: `completed` for an item cannot precede its
`started`, so *"`tool.result` follows its `tool.call`"* is satisfied with no buffering.

### Policy, and the approval prompt now known to be reachable

Policy for every Codex session is unchanged:
`{ mode: 'preauthorised', sandbox: <the mode chosen at launch>, banner: <naming that mode> }`,
and I25 holds — a Codex session emits **zero** `permission.request` events.

**What changed is that the fallback's premise no longer holds, and this says so rather than
quietly keeping the conclusion.** `10-design.md § The hard problem` recorded Codex's runtime
approval as unverified and open question 4 asked for the experiment. S8.1 ran it: under
`app-server` with `approvalPolicy: 'on-request'`, the server sends a genuine JSON-RPC **request**
— `item/commandExecution/requestApproval`, carrying `reason`, `command` and an `availableDecisions`
enum — which a client can answer. `exec --json` sends nothing of the kind and cannot; it is
non-interactive by construction and represents a sandbox denial only as the model reporting its
own failure in prose.

The asymmetry D5 accepted is therefore measurably narrower than when it was accepted. **This
section does not act on that**: S8's *Out of scope* says a reachable `on-request` prompt is
reported, not acted on, and D5 is `/design`'s. The row is marked unreachable under the shipped
policy rather than deleted, because the mapping it would need is one decision away, not one
experiment away.

This adapter therefore has **no `matchTarget` projection table**, and needs none: it constructs
no `PermissionRequest` at all. Should the `on-request` row ever be mapped, a projection table is
part of that work — `item/commandExecution/requestApproval` carries `command`, so the row exists
in evidence already — and it is that adapter's, never `session-manager`'s (I46).

### Usage

**`app-server` needs no arithmetic, and it reads exactly one of the two records that offer it.**
`turn/completed` and `thread/tokenUsage/updated` both carry explicit `total` and `last`
sub-objects. The adapter reads `thread/tokenUsage/updated`'s `last`, which is that turn's own
marginal figure, so D75's summability requirement is met by reading rather than by subtracting —
the same shape of answer S1 reached for Claude. **`turn/completed`'s `last` is deliberately not
mapped**, and the table above says so: it is the *same* marginal figure by a second route, so
emitting `usage` from both would put two envelopes carrying one turn's burn into the fold that
sums them — double-counting on the one screen headed *payroll*, which is the failure I28 exists
to prevent. Which of the two is read is arbitrary; reading only one is not.

**`exec --json`'s basis is undetermined, so its usage is not mapped at all.** Its
`turn.completed.usage` was observed almost exactly doubling across two sequential resumed turns of
one thread — `input_tokens` 46276 → 93393, `cached_input_tokens` 33280 → 66560 — which is
consistent with a running total and equally consistent with each call resending a growing context.
S8.1 did not settle which, and I28 forbids guessing: a cumulative figure summed as a delta
double-counts burn on the one screen headed *payroll*. A session on this transport therefore emits
no `usage` events.

**That silence is surfaced, and surfacing it is not optional** (D146). An adapter selecting a
transport that cannot report usage appends `session.notice / usage_unavailable` at `level: 'warn'`
**once, at session start, before the first `turn.started`** — not per turn, which would say the
same thing repeatedly and bury it. The notice is the discriminator between a burn of zero because
the session was idle and a burn of zero because nothing was ever counted, and without it
`PayrollView.burn` reports the two identically. This is *fail loudly, never degrade quietly*
applied to the one screen where a silent zero reads as good news.

A notice envelope is the right carrier here, and the `sandbox` member above is not the precedent
against it: `sandbox` needed to be visible to a client joining at an arbitrary point, which an
envelope cannot promise and a session field can, whereas `PayrollView` is a fold that walks the
spill from the beginning (*Types § Payroll view*). `session.notice / server_restart` is already
folded that way (D130), so this consumes an existing path rather than adding one.

**What the fold does with it is not settled here.** `PayrollView` has no field distinguishing
unknown from zero, and giving it one is a second public-surface change; `## Unresolved` 12 carries
it.

### Item ids, and where the fallback breaks correlation

`CallId` is session-unique **by assumption** (`10-design.md § Data model — Identity spaces`). That
assumption is now measured for Codex, and it holds on only one of the two transports.

- **`app-server`: UUID-based** (`exec-a2215fa5-…`), distinct across two sequential turns of one
  thread. That is evidence of the scheme, not proof it never collides — two turns were probed, and
  only for `commandExecution` items. It is treated exactly as Claude's is: assumed, and stated as
  an assumption.
- **`exec --json`: a per-turn counter** — `item_0`, `item_1`, `item_2` — that **restarts on every
  turn of the same thread**, reproduced across two independent `codex exec resume --last` runs.
  This is not an assumption that might fail; it is a known collision.

S8.7 stops the slice before implementing tool correlation where this is found, and it is found. The
fallback's `tool.call` / `tool.result` correlation is therefore **not specified here** and no alias
is invented; `## Unresolved` 13 carries it. What must not happen is the obvious patch: composing a
session-unique `CallId` from `(turnId, itemId)` inside the adapter is cheap and invisible above the
boundary, and may well be the answer — but S8.7 reserves it, and a contract that quietly took it
would be deciding open question 7's correlation half by writing a table.

Storage is unaffected either way: D22 already puts `turnId` in the blob path, so a turn-scoped
`callId` cannot overwrite an earlier turn's output (I22). Correlation is the half no path scheme
closes.

### Schema mismatch

Unchanged, with two surfaces to check rather than one. A stream not matching the table for the
transport **actually selected** returns `AdapterError.schema_mismatch` and emits
`error / adapter_schema_mismatch` with `fatal: true`; the session refuses to start. **The adapter
must fail loudly, not degrade quietly** — a Codex adapter that silently renders nothing is worse
than one that refuses to start, because the operator will believe the agent is thinking.

An `app-server` probe that finds no such subcommand is **not** a mismatch: that is the fallback's
trigger, and it is the one case where falling back rather than failing is correct.

Records outside a transport's table but harmless may be held on a named ignore list, exactly as
D92 gives Claude one. Adding to it is an adapter change, never a change to `ErrorEventKind`.

## Unresolved

Signatures the design does not determine. Nothing downstream may invent them. Items 5 to 11
are new in this pass and each names the issue that carries it.

1. **`Attachment`.** `POST /api/sessions/:id/message` previously carried
   `attachments?: Attachment[]` against a type that was never defined, and no section of
   `10-design.md` describes attachment handling — not the transport to the CLI, not storage,
   not the byte cap, not the audit consequence of a file reaching an agent. The field is
   removed from the route rather than left dangling. Restoring it needs a design decision
   first. (#22)
2. **Resolved by S10.1 and this pass** (D108–D110). Open question 8 is answered, and the answer
   is narrower than "insufficient": `permission_suggestions` is **unobservable** — the
   `control_request` carrying it has never appeared on this transport across two independent
   probes, and the upstream defect was stale-closed unfixed. `StandingRuleExpression` is
   therefore a local grammar, `"<tool>:<pattern>"`, declared above with its full constraint;
   `parseStandingRule` and `match` are declared under `session-manager`; the tool-shape
   knowledge `match` would have needed moved to the adapter as `PermissionRequest.matchTarget`,
   which is what keeps `## Unresolved` 4's boundary intact. The rule's home is in-memory
   session state and its lifetime ends with the process — stated as a ruling, so there is no
   persisted schema and no migration story to write. `scope: 'always'` is implementable and
   `ResolvedScope: 'standing'` is reachable. (#16, #37)

   Two things this deliberately did **not** settle, neither blocking: whether a standing
   *denial* is ever wanted (`always` + `deny` is refused today, D110, and relaxing it is
   additive), and whether a rule should be revocable other than by ending the session.
3. **Resolved by S8.1.** The Codex event mapping had three normalised kinds with no source
   record. Both transports are now mapped from observation in `## Vendor mapping — Codex`, and
   the three rows are filled: there is no wire-level `tool.call` / `tool.result` pair on either
   interface, and the adapter synthesises it from one item's two lifecycle states. What the
   experiment exposed instead is carried as 12 and 13 below. (#14, #18)
4. **`ToolCall.summary`'s renderer.** The design calls it "server-rendered" and names no
   owner. It is emitted by the adapter in the shape above, which makes it vendor code
   producing a display string — the one place that reading is uncomfortable. It is not
   moved here because moving it would put tool-shape knowledge in the session manager, which
   is exactly what the vendor boundary forbids. (#23)
5. **Resolved by S12.** `session-manager.readAudit` serves the route, delegating straight to
   `Store.readAuditPage`; `session-manager` was chosen over `records` because `records` is
   tier two and does not exist when tier one's `GET /api/audit` must already work, and every
   edge already depends on `session-manager` and never on `store` directly. The method takes
   no owner and applies no ownership check, unlike every other method on that interface,
   because D70 opens this read to every authenticated operator regardless of session
   ownership — it sits on `session-manager` only because that module already bridges edges to
   `store`, not because the read is about sessions. S17 (tier two) reuses the same method with
   `incidentsOnly: true` rather than duplicating it on `records`. (#34)
6. **Resolved by D127.** `SessionManager.getSnapshotForReview` reads a session's snapshot with
   no owner parameter and no ownership check, shaped like `readAudit` above. `POST /api/reviews`
   calls it directly rather than the ownership-checked `get`. (#32)
7. **Resolved by D120.** The two orders were each partly right: a requisition's decision and a
   review's mutation claim an exclusivity lock synchronously, before the append — which is what
   D32's guard rule requires — but that lock is distinct from `state`, and `state` itself
   changes only after the append durably succeeds, never before. The signatures above needed no
   change; `decide`, `appendReview` and `finaliseReview` already return only once the store call
   settles, and `RecordsError.storage`'s "the registry is not mutated" already said the right
   thing. (#31, and #35 for the review half)
8. **Resolved by D129.** `remainingTokens` subtracts `burn`'s full component-wise sum — input,
   output, cache reads, and cache creation all count against the budget — from `budgetTokens`.
   The budget's *scope* is resolved separately: per session (#29), which this contract already
   followed the design in taking.
9. **Resolved by D122.** Every session has a checklist — the template is global configuration
   (D71) and not tied to a requisition — and ticking is refused on an ended session,
   `409 session_ended`, matching every other session-write route. (#41)
10. **Resolved by D120, D124 and D128.** `finaliseReview` claims the same synchronous I5 lock
    as `appendReview` (D120, and named among I5's six guards by D124). The crash half is closed
    by D128: `Store.appendReview` is durable — fsync'd before it returns — so a line the caller
    was actually told succeeded cannot be un-written by a later host crash. The accepted
    latest-line-wins reversion (D65) still applies to a write the caller was never acknowledged
    for, which is the same durable-before-ack shape I10 already gives `AuditRecord`. (#35, #36)
11. **How a removed or retyped field in `reviews.ndjson` or `requisitions.ndjson` is
    migrated.** Every other persisted shape gates on `meta.json`'s `schemaVersion`, and these
    two files are not under it. Adding fields is safe today; removing or retyping one has no
    stated rule and no discriminator to hang one on.

Items 12 and 13 arrived with S8.2, and both are now carried by an issue: 12 by #29 and #30,
13 by #93. The note that stood here said both were un-issued because `/track` was suspended
under D105 — D111 established that D105's freeze was decided and never executed, so nothing
was suspended and that reason was never true. `/track`'s own mandate covers `30-slices.md` and
`90-decisions.md § Open` only, never this section directly, which is why item 13 sat unissued
even after D111 — it needed opening by hand rather than by `/track`'s next run. Both items
belong to the `exec --json` fallback alone; neither affects a session on `app-server`.

12. **What basis `codex exec --json` reports usage on.** Its `turn.completed.usage` was observed
    roughly doubling across two resumed turns of one thread, which fits a running total and fits a
    growing resent context equally well. I28 requires the adapter to emit something summable, and
    guessing wrong double-counts burn in `PayrollView`. Until a probe distinguishes the two, that
    transport emits no `usage`. Related: 8, and whether `reasoning_output_tokens` counts toward
    `Usage.outputTokens` at all. (#29, #30)

    **The rider is resolved by D146 and no longer waits on the basis.** Whether a session that
    reports no burn says so is answered yes: `SessionNoticeCode` gains `usage_unavailable`,
    emitted once at session start by an adapter on a transport that cannot report usage, per
    *Vendor mapping — Codex § Usage*. Deferring it until the basis was known was rejected — the
    two questions are independent, and the silence misreads as a zero for however long the basis
    stays open. Shipping the fallback is therefore not gated on this either. (#91)

    **What remains open is the consumer, not the signal.** `PayrollView.burn` is a `Usage` whose
    all-zero value now has two meanings, and the view carries nothing to separate them. Making
    `burn` nullable is the honest shape and forces every reader to handle the unknown, where a
    boolean beside it can be ignored silently — but it is a second public-surface change to a
    materialised type, it makes `remainingTokens` null by consequence, and it was not decided
    here. Nothing may infer the distinction by testing `burn` for zero. (#30, #91)
13. **Tool correlation on `codex exec --json`, whose item ids collide across turns.** Its ids are
    a per-turn counter that restarts each turn of a thread, so `CallId` is not session-unique on
    that transport — measured, not assumed. S8.7 stops before implementing correlation here and
    routes it to `/design` as open question 7's correlation half. The obvious fix — the adapter
    composing a session-unique `CallId` from `(turnId, itemId)` — is deliberately **not** taken
    here: it is invisible above the adapter boundary and may well be right, but S8.7 reserves the
    choice, and writing it into the mapping table would decide it by omission. (#93)
