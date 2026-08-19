// Types only. No runtime export. Transcribed from `design/20-contract.md`, which is
// authoritative — where this file and that document disagree, the document is right.

export type Brand<T, B extends string> = T & { readonly __brand: B };

// Server-minted.
export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type Seq = Brand<number, 'Seq'>;
// (D160) Server-minted, and the only thing that ever names an attachment's file. The
// operator's `filename` is display text and never reaches a path (I49).
export type AttachmentId = Brand<string, 'AttachmentId'>;

// Server-minted, tier two.
export type ReviewId = Brand<string, 'ReviewId'>;
export type RequisitionId = Brand<string, 'RequisitionId'>;

// Identity, from the identity edge.
export type OperatorId = Brand<string, 'OperatorId'>;

// Vendor-minted and opaque above the adapter layer: equality only, never parsed,
// never compared for ordering, never used to infer structure.
export type CliSessionId = Brand<string, 'CliSessionId'>;
export type CallId = Brand<string, 'CallId'>;
export type RequestId = Brand<string, 'RequestId'>;

// A path proven, once, to resolve inside a configured workspace root. Only `jail`
// may mint one.
export type ResolvedPath = Brand<string, 'ResolvedPath'>;

// ISO 8601, UTC, millisecond precision, `Z` suffix.
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

// A 40-character lowercase hexadecimal git object id.
export type GitSha = Brand<string, 'GitSha'>;

// An identifier declared by a deployment's checklist template in `config`. Tier two.
export type ChecklistItemId = Brand<string, 'ChecklistItemId'>;

// Server-minted, opaque to every caller: a position in `audit.ndjson` from which the
// next page continues. Equality and round-tripping only; no caller may parse one.
export type AuditCursor = Brand<string, 'AuditCursor'>;

export type Vendor = 'claude' | 'codex';
export type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted';
export type SessionState = 'live' | 'ended';

// Every fallible operation crossing a module boundary returns this rather than throwing.
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface PermissionPolicy {
  readonly mode: 'interactive' | 'preauthorised';
  readonly sandbox: SandboxMode | null;
  readonly banner: string | null; // non-null exactly when mode === 'preauthorised'
}

// The persisted session record: exactly what `meta.json` carries, and nothing more. The
// live turn is deliberately absent — `meta.json` is the session minus turn, buffer and
// subscribers (D49) — and `LiveSession` below is where it lives instead.
export interface SessionRecord {
  readonly id: SessionId;
  readonly owner: OperatorId;
  readonly vendor: Vendor;
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly sandbox: SandboxMode | null;
  cliSessionId: CliSessionId | null; // last-write-wins, from every system/init
  lastSeq: Seq | 0; // 0 before the first emit; a hint on disk only
  state: SessionState;
  readonly createdAt: IsoTimestamp;
  endedAt: IsoTimestamp | null; // non-null iff state === 'ended'
}

// What crosses to the client. The persisted record minus `cliSessionId`, which is
// vendor-opaque and has no client use.
export interface SessionSummary {
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
export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly owner: OperatorId;
  readonly vendor: Vendor;
  readonly cwd: ResolvedPath;
  readonly createdAt: IsoTimestamp;
}

// The two fields of the session manager's registry entry that the invariants are stated
// over. The manager's actual entry extends this with scheduling state that crosses no
// module boundary and is deliberately not declared — see `20-contract.md § Session`.
export interface LiveSession {
  readonly record: SessionRecord;
  turn: Turn | null;
}

// ---------------------------------------------------------------------------
// Turn (in memory only — reconstructed from the event log, never persisted)
// ---------------------------------------------------------------------------

export interface Turn {
  readonly turnId: TurnId;
  phase: 'starting' | 'running';
  readonly startedAt: IsoTimestamp;
  readonly pending: Map<RequestId, PendingPermission>;
}

export interface PendingPermission {
  readonly callId: CallId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  // Carried from the originating `PermissionRequest` so `answerPermission` can enforce I43
  // without re-reading `input`, which would put tool-shape knowledge in `session-manager`
  // and break I46. A copy of the adapter's projection, never a second projection.
  readonly matchTarget: string | null;
}

// ---------------------------------------------------------------------------
// Process record
// ---------------------------------------------------------------------------

export interface ProcessRecord {
  readonly pid: number;
  readonly pgid: number | null; // null on Windows
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly startedAt: IsoTimestamp; // load-bearing: the pid-reuse guard reads it
  readonly image: string;
  exitedAt: IsoTimestamp | null; // null while live; set by folding in the tombstone
}

// The exit line. `pids.ndjson` carries two line shapes and this is the second: a full
// `ProcessRecord` is written at spawn, and this narrower line at exit, because
// `tombstonePid` is given a pid and a timestamp and nothing else (D95).
//
// A reader folds the two shapes; it does not treat the latest line as a whole record.
// Liveness comes from the latest line for a `pid`; `startedAt`, `image`, `sessionId` and
// `turnId` come from that pid's most recent *spawn* line. The reuse guard reads all three
// of `exitedAt`, `startedAt` and `image` (I19), and a reader that took them off the
// tombstone would find two of them missing and reap on a guard that never ran.
export interface ProcessTombstone {
  readonly pid: number;
  readonly exitedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export interface EventPayloadMap {
  'session.started': SessionStarted;
  'session.ended': SessionEnded;
  'session.notice': SessionNotice;
  'turn.started': TurnStarted;
  'turn.ended': TurnEnded;
  message: MessageEvent;
  'message.delta': MessageDelta;
  thinking: Thinking;
  'tool.call': ToolCall;
  'tool.result': ToolResult;
  'permission.request': PermissionRequest;
  'permission.resolved': PermissionResolved;
  'checkpoint.created': CheckpointCreated;
  usage: UsageEvent;
  error: ErrorEvent;
  'checklist.item.completed': ChecklistItemCompleted; // tier two (D71)
}

export type EventKind = keyof EventPayloadMap;

export type Envelope<K extends EventKind = EventKind> = K extends EventKind
  ? {
      readonly seq: Seq;
      readonly sessionId: SessionId;
      readonly ts: IsoTimestamp;
      readonly kind: K;
      readonly data: EventPayloadMap[K];
      readonly raw?: unknown; // present only when config.includeRaw
    }
  : never;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface SessionStarted {
  readonly vendor: Vendor; // display only; no logic may branch on it
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly policy: PermissionPolicy;
  readonly state: SessionState; // the state at emission, and therefore always 'live'
  readonly createdAt: IsoTimestamp;
}

export type SessionEndReason = 'operator' | 'server_restart' | 'storage_failure';

export interface SessionEnded {
  readonly reason: SessionEndReason;
  readonly endedAt: IsoTimestamp;
}

export type SessionNoticeCode =
  | 'compaction' // the CLI is compacting, or reported a compact boundary
  | 'resume_unavailable' // spawning with no --resume; context not carried forward
  | 'checkpoints_unavailable' // ckpt.git could not be initialised
  | 'checkpoint_skipped' // the pre-turn checkpoint failed; the turn proceeds
  // No producer, retained knowingly: superseded by `PermissionPolicy.banner`, which the
  // client renders instead and which survives a replay because it is a session field rather
  // than an envelope (S8.3). Kept rather than removed — dropping a member narrows a declared
  // union and buys nothing.
  | 'sandbox'
  | 'audit_unavailable' // a permission was denied because the audit append failed
  | 'storage_failure' // a spill write failed; the session is ending
  | 'server_restart' // boot found this session live at shutdown (D130)
  | 'usage_unavailable'; // this session's transport reports no token usage, so its burn is
  // unknown rather than zero (D146). Emitted once, at session start, before the first
  // `turn.started`, by an adapter whose selected transport cannot report usage.

export interface SessionNotice {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: SessionNoticeCode;
  readonly text: string;
}

export interface TurnStarted {
  readonly turnId: TurnId;
}

export type TurnStopReason =
  | 'completed' // the CLI reported a successful result
  | 'error' // the CLI reported an unsuccessful result
  | 'process_exit' // the child died without reporting a result
  | 'interrupted' // POST /interrupt
  | 'server_restart' // boot closed a turn the crash left open
  | 'storage_failure'; // a spill write failed mid-turn

export interface TurnEnded {
  readonly turnId: TurnId;
  readonly stopReason: TurnStopReason;
  // No producer, retained knowingly (D151): every adapter and every synthesised close
  // emits `null`, because D75 puts the summable figure on the `usage` envelope and the
  // payroll fold reads only that. Summing both sources double-counts a turn's burn (I28).
  readonly usage: Usage | null;
}

export interface MessageEvent {
  readonly turnId: TurnId;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  // (D160) Refs only, never bytes: the spill is the transcript. Empty on every `assistant`
  // message — an attachment originates with an operator. Bytes are fetched from
  // `GET /api/sessions/:id/attachments/:turnId/:attachmentId`.
  readonly attachments: readonly AttachmentRef[];
}

// (D160) What the operator uploads, inline on `POST /message`.
export interface AttachmentUpload {
  readonly filename: string; // display only; never used to build a path (I49)
  readonly mediaType: string; // the client's claim, stored verbatim, never trusted on the way out
  readonly dataBase64: string; // decoded size is what `Caps.attachmentBytes` bounds
}

// (D160) What the envelope carries and the client renders.
export interface AttachmentRef {
  readonly attachmentId: AttachmentId;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: number; // decoded size
}

export interface MessageDelta {
  readonly turnId: TurnId;
  readonly role: 'assistant';
  readonly text: string; // append-only
}

export interface Thinking {
  readonly turnId: TurnId;
  readonly text: string;
}

export interface ToolCall {
  readonly turnId: TurnId;
  readonly callId: CallId;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly summary: string; // one line, server-rendered, safe to show collapsed
}

export interface ToolResult {
  readonly turnId: TurnId;
  readonly callId: CallId;
  readonly ok: boolean;
  readonly output: string; // truncated before this envelope was constructed
  readonly truncated: boolean;
  readonly bytes: number; // pre-truncation size
}

// `"<tool>:<pattern>"`. Constrained: /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^\r\n]+$/, and no
// longer than `Caps.standingRuleBytes` as UTF-8. The half before the first colon is
// compared for equality against `PermissionRequest.tool`; every later colon belongs to
// the pattern. The pattern is matched against `PermissionRequest.matchTarget` in full,
// anchored at both ends, byte for byte and case-sensitively, with no normalisation on
// either side. `*` is the only metacharacter: it matches any run of characters,
// including the empty run, except `;` `&` `|` `<` `>` `` ` `` `$` CR LF. There is no
// escape, so no rule matches a literal `*`. Nothing else in the pattern is special.
// Minted only by `parseStandingRule`.
export type StandingRuleExpression = Brand<string, 'StandingRuleExpression'>;

export interface PermissionRequest {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly callId: CallId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>; // exactly what will run, never a summary
  // The one string a rule's pattern is matched against, projected from `input` by the
  // adapter and emitted verbatim. `null` where the adapter defines no projection for
  // this tool, and then no standing rule may be created against this request (I43).
  readonly matchTarget: string | null;
  // The vendor's `permission_suggestions`, forwarded exactly as it arrived (D104).
  // Unverified on this transport; no module narrows, parses, or indexes it (I44).
  readonly suggestions: readonly unknown[];
}

export type PermissionDecision = 'allow' | 'deny';
export type AnswerScope = 'once' | 'always'; // what a client may send
export type ResolvedScope = 'once' | 'always' | 'standing'; // 'standing' = matched a stored rule

export type PermissionResolvedReason =
  | 'answered' // an operator answered
  | 'preapproved' // matched a standing rule held by this server
  | 'cancelled_process_exit' // the child died, or was interrupted, or boot closed the turn
  // No producer, and reserved rather than dead: nothing resolves one request because another
  // replaced it. If such a path is ever added this is its reason; until then it must not be
  // repurposed.
  | 'superseded'
  | 'audit_unavailable'; // denied because the audit record could not be appended

export interface PermissionResolved {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly decision: PermissionDecision;
  readonly scope: ResolvedScope;
  readonly operator: OperatorId | null; // null when the server decided
  readonly reason: PermissionResolvedReason;
}

export interface CheckpointCreated {
  readonly turnId: TurnId | null; // null for the safety checkpoint taken before a restore
  readonly sha: GitSha;
  readonly label: string;
}

// Incremental and summable by construction: the adapter normalises whatever the vendor
// reports into deltas before emitting (D75). Nothing above `adapters/*` may do arithmetic
// on a vendor's own numbers.
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

export interface UsageEvent {
  readonly turnId: TurnId;
  readonly usage: Usage;
}

// Tier two (D71). Session-scoped: no `turnId`, and it may interleave with a turn's events.
export interface ChecklistItemCompleted {
  readonly itemId: ChecklistItemId;
  readonly by: OperatorId;
}

export type ErrorEventKind =
  | 'replay_gap'
  | 'agent_unavailable'
  | 'adapter_unknown_record'
  | 'adapter_bad_line'
  | 'adapter_schema_mismatch'
  | 'checkpoint_restore_failed'
  | 'session_delete_incomplete';

export interface ErrorEvent {
  readonly kind: ErrorEventKind;
  readonly message: string;
  readonly fatal: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly sha: GitSha;
  readonly label: string;
  readonly ts: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Audit record
// ---------------------------------------------------------------------------

export interface AuditRecord {
  readonly ts: IsoTimestamp;
  readonly operator: OperatorId | null; // null when the server decided
  readonly sessionId: SessionId;
  readonly vendor: Vendor; // copied from the session at decision time
  readonly sandbox: SandboxMode | null; // copied from the session at decision time
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>; // never truncated, never summarised
  readonly decision: PermissionDecision;
  readonly scope: ResolvedScope;
  readonly reason: string | null;
}

export interface AuditQuery {
  readonly before: AuditCursor | null; // newest-first; null starts at the newest record
  readonly limit: number; // clamped to Caps.auditPageMax
  readonly sessionId: SessionId | null;
  readonly operator: OperatorId | null;
  readonly since: IsoTimestamp | null;
  readonly until: IsoTimestamp | null;
  // The incident view: decision === 'deny', or operator === null (the server forced it),
  // or scope === 'standing'. Grouping by session and by operator is the reader's.
  readonly incidentsOnly: boolean;
}

export interface AuditPage {
  readonly records: readonly AuditRecord[]; // newest first
  readonly nextCursor: AuditCursor | null; // null when the window reached the oldest record
}

// ---------------------------------------------------------------------------
// Review (tier two)
// ---------------------------------------------------------------------------

export type Rating = 'does_not_meet' | 'meets_some' | 'meets' | 'exceeds' | 'exceptional';

// The one runtime enumeration of `Rating`'s members, `adapters`' `VENDORS` shape (D126):
// a second hand-copy elsewhere is the drift that having one canonical list exists to
// prevent, so `parseRating` at the edge imports this rather than re-enumerating it.
export const RATINGS: readonly Rating[] = ['does_not_meet', 'meets_some', 'meets', 'exceeds', 'exceptional'];

export type ReviewState = 'draft' | 'final';

export interface Review {
  readonly reviewId: ReviewId;
  readonly subject: SessionId;
  readonly snapshot: SessionSnapshot; // copied at authorship; never re-resolved (D67)
  readonly author: OperatorId;
  readonly state: ReviewState; // one-way; `final` is terminal
  readonly rating: Rating | null;
  readonly pip: boolean;
  readonly body: string; // UTF-8, at most Caps.reviewBodyBytes bytes
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp; // on the `final` line, this is the finalisation time
}

// ---------------------------------------------------------------------------
// Requisition (tier two)
// ---------------------------------------------------------------------------

export type RequisitionState = 'open' | 'approved' | 'rejected' | 'consumed';
export type RequisitionDecision = 'approve' | 'reject';

export interface Requisition {
  readonly requisitionId: RequisitionId;
  readonly raisedBy: OperatorId;
  readonly title: string; // UTF-8, at most Caps.requisitionTextBytes bytes
  readonly justification: string; // UTF-8, at most Caps.requisitionTextBytes bytes
  // The client's string, stored unresolved and never passed to `jail` before session
  // creation (D68). It is deliberately not a ResolvedPath.
  readonly workspace: string;
  readonly vendor: Vendor;
  readonly state: RequisitionState; // open → approved → consumed, or open → rejected
  readonly decidedBy: OperatorId | null;
  readonly decidedAt: IsoTimestamp | null;
  readonly sessionId: SessionId | null; // set once, at consumption
  readonly raisedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Onboarding checklist (tier two)
// ---------------------------------------------------------------------------

export interface ChecklistItemTemplate {
  readonly id: ChecklistItemId;
  readonly label: string;
}

export interface ChecklistItemState {
  readonly id: ChecklistItemId;
  readonly label: string; // from the template, at read time
  readonly completedBy: OperatorId | null;
  readonly completedAt: IsoTimestamp | null; // the `ts` of the completing envelope
}

// ---------------------------------------------------------------------------
// Payroll view (tier two)
// ---------------------------------------------------------------------------

export interface PayrollView {
  readonly sessionId: SessionId;
  readonly burn: Usage; // component-wise sum of every `usage` event
  readonly budgetTokens: number | null; // Config.sessionTokenBudget; null when unset
  readonly remainingTokens: number | null; // null when budgetTokens is null
  readonly idleMs: number; // live-with-no-turn wall clock
  readonly droppedIntervals: number; // idle intervals discarded for spanning a restart
  readonly costCurrency: number | null; // burn priced at Config.tokenRates (D158); null when
  // rates are unset, and null on a session whose transport reports no usage — never 0.00
  readonly currency: string | null; // Config.currency, echoed; null whenever cost is null
}

// (tier two, D158) One rate per `Usage` component, in `currency` units per token. Flat per
// deployment: nothing records which model produced a session's burn, so nothing can key on one.
export interface TokenRates {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export interface Operator {
  readonly id: OperatorId;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type AuthConfig =
  | { readonly mode: 'proxy-header'; readonly userHeader: string }
  | { readonly mode: 'open-webui'; readonly userHeader: string; readonly sessionHeader: string }
  | { readonly mode: 'shared-secret'; readonly cookieName: string; readonly secret: string };

export interface Caps {
  readonly ringCapacity: number; // envelopes retained in memory per session
  readonly toolResultBytes: number; // truncation threshold for tool.result
  readonly subscriberQueueHighWater: number; // envelopes queued per subscriber before it is dropped
  readonly keepaliveMs: number; // SSE comment interval
  readonly auditPageMax: number; // largest window `GET /api/audit` will serve
  readonly reviewBodyBytes: number; // (tier two) rejection threshold for Review.body
  readonly requisitionTextBytes: number; // (tier two) per field: title, justification
  readonly standingRuleBytes: number; // rejection threshold for one StandingRuleExpression
  readonly attachmentBytes: number; // (D160) rejection threshold, decoded, per attachment
  readonly attachmentCount: number; // (D160) rejection threshold, attachments per message
}

export interface Config {
  readonly bind: { readonly host: string; readonly port: number };
  readonly auth: AuthConfig;
  readonly workspaceRoots: readonly ResolvedPath[];
  readonly storageRoot: string;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: readonly string[]; // upstream addresses permitted to set the identity header
  readonly caps: Caps;
  // `Max-Age` on the cookie `POST /api/login` mints. Read only under
  // `auth.mode === 'shared-secret'`; under either header mode the credential is the
  // upstream proxy's and its lifetime is not ours to set.
  readonly sessionCookieMaxAgeSeconds: number;
  readonly includeRaw: boolean;
  readonly sessionTokenBudget: number | null; // (tier two) per session; null disables the view's budget
  readonly tokenRates: TokenRates | null; // (tier two) null disables the cost tile (D158)
  readonly currency: string | null; // (tier two) label only; never interpreted (D158)
  readonly checklist: readonly ChecklistItemTemplate[]; // (tier two) empty disables the checklist
  // D10/D117: which transport edge this deployment binds. Exactly one binds (S11.5).
  readonly edge: 'sse' | 'ws';
}

// ---------------------------------------------------------------------------
// Persisted schemas
// ---------------------------------------------------------------------------

export interface SessionMetaFile {
  readonly schemaVersion: 1;
  readonly session: SessionRecord; // `lastSeq` here is a diagnostic hint, not authority
}

// ---------------------------------------------------------------------------
// records (tier two) input/patch shapes
// ---------------------------------------------------------------------------

export interface RaiseRequisitionInput {
  readonly title: string;
  readonly justification: string;
  readonly workspace: string; // stored unresolved; the jail runs at session creation
  readonly vendor: Vendor;
}

export interface CreateReviewInput {
  readonly subject: SessionId;
  readonly rating: Rating | null;
  readonly pip: boolean;
  readonly body: string;
}

// Absent fields are left as they stand on the latest line for that review.
export interface ReviewPatch {
  readonly rating?: Rating | null;
  readonly pip?: boolean;
  readonly body?: string;
}

// ---------------------------------------------------------------------------
// adapters/*
// ---------------------------------------------------------------------------

// Everything an adapter tells the manager. Event payloads carry no `seq`, no `sessionId`
// and no `ts` — the manager assigns those.
export type AdapterNotification =
  | { readonly kind: 'event'; readonly event: AdapterEvent }
  | { readonly kind: 'cli-session'; readonly cliSessionId: CliSessionId } // every system/init
  | { readonly kind: 'spawned'; readonly pid: number; readonly pgid: number | null; readonly image: string }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null };

export type AdapterEmitted = Exclude<
  EventKind,
  | 'session.started'
  | 'session.ended'
  | 'checkpoint.created'
  | 'checklist.item.completed'
  // D97: the manager is the sole emitter. It holds the `pending` map, deletes from it
  // synchronously (D33) and appends the `AuditRecord` every resolution owes (I11), so an
  // adapter resolving a request of its own would produce a resolution with no audit record
  // and leave the map holding an entry nothing clears.
  | 'permission.resolved'
>;

export type AdapterEvent = {
  [K in AdapterEmitted]: {
    readonly kind: K;
    readonly data: Omit<EventPayloadMap[K], 'turnId'>;
    readonly raw?: unknown;
  };
}[AdapterEmitted];

export interface AdapterOptions {
  readonly cwd: ResolvedPath;
  readonly model: string | null;
  readonly sandbox: SandboxMode | null;
  readonly notify: (n: AdapterNotification) => void;
}

// (D160) An attachment as the adapter receives it: the ref the envelope carries, plus the bytes.
// The manager reads them from `store` and hands them down, because an adapter depends on
// `contract` and nothing else and may not be given a store handle.
export interface AttachmentPayload {
  readonly ref: AttachmentRef;
  readonly data: Uint8Array;
}

export interface Adapter {
  readonly vendor: Vendor;
  readonly policy: PermissionPolicy; // the vendor's capability, fixed at create
  // (D160) Whether this vendor's transport carries non-text content at all. Read by the edge
  // to refuse `attachments` with `422 bad_request`; a capability, not a vendor test (I20).
  readonly acceptsAttachments: boolean;
  // Spawns the turn's child, writes the message to stdin, and holds stdin open.
  send(
    text: string,
    attachments: readonly AttachmentPayload[],
    resume: CliSessionId | null,
    turnId: TurnId,
  ): Promise<Result<void, AdapterError>>;
  respond(requestId: RequestId, decision: PermissionDecision): Result<void, AdapterError>;
  kill(): Promise<void>; // terminate-then-force, on the process tree
}

// ---------------------------------------------------------------------------
// records (tier two)
// ---------------------------------------------------------------------------

export interface Records {
  boot(): Promise<void>;

  raise(raisedBy: OperatorId, input: RaiseRequisitionInput): Promise<Result<Requisition, RecordsError>>;
  listRequisitions(): readonly Requisition[];
  getRequisition(requisitionId: RequisitionId): Result<Requisition, RecordsError>;
  decide(
    requisitionId: RequisitionId,
    decidedBy: OperatorId,
    decision: RequisitionDecision,
  ): Promise<Result<Requisition, RecordsError>>;

  claim(requisitionId: RequisitionId): Result<void, RecordsError>;
  attachSession(requisitionId: RequisitionId, sessionId: SessionId): Promise<Result<void, RecordsError>>;
  release(requisitionId: RequisitionId): void;

  createReview(
    author: OperatorId,
    snapshot: SessionSnapshot,
    input: CreateReviewInput,
  ): Promise<Result<Review, RecordsError>>;
  appendReview(reviewId: ReviewId, author: OperatorId, patch: ReviewPatch): Promise<Result<Review, RecordsError>>;
  finaliseReview(reviewId: ReviewId, author: OperatorId): Promise<Result<Review, RecordsError>>;
  getReview(reviewId: ReviewId, reader: OperatorId): Result<Review, RecordsError>;
  listReviews(subject: SessionId): readonly Review[];
  isUnderPip(subject: SessionId): boolean;
}

// ---------------------------------------------------------------------------
// session-manager
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  readonly vendor: Vendor;
  readonly cwd: string; // the client's string; never used after the jail check
  readonly model: string | null;
  readonly sandbox: SandboxMode | null;
  readonly requisitionId: RequisitionId | null; // (tier two) optional; never a gate (D68)
}

export interface PermissionAnswer {
  readonly requestId: RequestId;
  readonly decision: PermissionDecision;
  readonly scope: AnswerScope;
  readonly rule: StandingRuleExpression | null; // required when scope === 'always'
  readonly reason: string | null; // the operator's stated reason
}

export interface SubscriberSink {
  deliver(envelope: Envelope): void;
  close(): void;
}

export interface Subscription {
  close(): void;
}

export interface SessionManager {
  boot(): Promise<Result<void, StartupError>>; // reap → rehydrate → close open turns; before listen

  create(owner: OperatorId, input: CreateSessionInput): Promise<Result<{ sessionId: SessionId }, SessionError>>;
  list(owner: OperatorId): readonly SessionSummary[];
  get(sessionId: SessionId, owner: OperatorId): Result<SessionSummary, SessionError>;

  message(
    sessionId: SessionId,
    owner: OperatorId,
    text: string,
    attachments: readonly AttachmentUpload[],
  ): Promise<Result<{ turnId: TurnId }, SessionError>>;
  answerPermission(
    sessionId: SessionId,
    owner: OperatorId,
    answer: PermissionAnswer,
  ): Promise<Result<{ accepted: boolean }, SessionError>>;
  interrupt(sessionId: SessionId, owner: OperatorId, turnId: TurnId): Promise<Result<void, SessionError>>;
  end(sessionId: SessionId, owner: OperatorId): Promise<Result<void, SessionError>>;
  remove(sessionId: SessionId, owner: OperatorId): Promise<Result<void, SessionError>>;

  listCheckpoints(sessionId: SessionId, owner: OperatorId): Promise<Result<readonly Checkpoint[], SessionError>>;
  restore(sessionId: SessionId, owner: OperatorId, sha: GitSha): Promise<Result<void, SessionError>>;
  openToolOutput(
    sessionId: SessionId,
    owner: OperatorId,
    turnId: TurnId,
    callId: CallId,
  ): Promise<Result<NodeJS.ReadableStream, SessionError>>;
  openAttachment(
    sessionId: SessionId,
    owner: OperatorId,
    turnId: TurnId,
    attachmentId: AttachmentId,
  ): Promise<Result<{ readonly stream: NodeJS.ReadableStream; readonly mediaType: string }, SessionError>>;

  subscribe(
    sessionId: SessionId,
    owner: OperatorId,
    after: Seq | 0,
    sink: SubscriberSink,
  ): Promise<Result<Subscription, SessionError>>;

  payroll(sessionId: SessionId, owner: OperatorId): Promise<Result<PayrollView, SessionError>>;
  checklist(sessionId: SessionId, owner: OperatorId): Promise<Result<readonly ChecklistItemState[], SessionError>>;
  tickChecklistItem(
    sessionId: SessionId,
    owner: OperatorId,
    itemId: ChecklistItemId,
  ): Promise<Result<void, SessionError>>;

  // Not session-scoped and takes no owner, like `boot`: D70 opens this read to every
  // authenticated operator. A pure delegation to `Store.readAuditPage` (D119).
  readAudit(query: AuditQuery): Promise<Result<AuditPage, StoreError>>;

  // Tier two. No owner, shaped like `readAudit` for the same reason: D70 opens a review
  // about any session to every operator, not only the session's own owner. `null` for a
  // session that does not exist; `POST /api/reviews` turns that into `404 no_such_session`
  // (D127).
  getSnapshotForReview(sessionId: SessionId): SessionSnapshot | null;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export interface IdentityRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly remoteAddress: string;
}

export type IdentityResolver = (req: IdentityRequest) => Result<OperatorId, IdentityError>;

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface LoadedMeta {
  readonly sessionId: SessionId;
  readonly result: Result<SessionRecord, StoreError>; // a per-session failure never aborts boot
}

export interface Store {
  createSession(record: SessionRecord): Promise<Result<void, StoreError>>;
  writeMeta(record: SessionRecord): Promise<Result<void, StoreError>>;
  readAllMeta(): Promise<readonly LoadedMeta[]>;
  deleteSession(sessionId: SessionId): Promise<Result<void, StoreError>>;

  appendEvent(sessionId: SessionId, envelope: Envelope): Promise<Result<void, StoreError>>;
  readEventsAfter(sessionId: SessionId, after: Seq | 0): AsyncIterable<Result<Envelope, StoreError>>;
  readLastSeq(sessionId: SessionId): Promise<Result<Seq | 0, StoreError>>;

  pushRing(sessionId: SessionId, envelope: Envelope): void;
  readRingAfter(sessionId: SessionId, after: Seq | 0): readonly Envelope[] | null; // null = cannot serve
  dropRing(sessionId: SessionId): void;

  writeToolOutput(
    sessionId: SessionId,
    turnId: TurnId,
    callId: CallId,
    bytes: Buffer,
  ): Promise<Result<void, StoreError>>;
  openToolOutput(
    sessionId: SessionId,
    turnId: TurnId,
    callId: CallId,
  ): Promise<Result<NodeJS.ReadableStream, StoreError>>;

  // (D160) Written and fsync'd before the envelope naming it is constructed (I49).
  // `attachmentId` is server-minted, so the operator's `filename` never reaches this path.
  // `mediaType` is stored alongside the bytes so the read route can echo it for an
  // allow-listed image type without scanning the session's spill for the `AttachmentRef`
  // that named it (S21.6).
  writeAttachment(
    sessionId: SessionId,
    turnId: TurnId,
    attachmentId: AttachmentId,
    bytes: Buffer,
    mediaType: string,
  ): Promise<Result<void, StoreError>>;
  openAttachment(
    sessionId: SessionId,
    turnId: TurnId,
    attachmentId: AttachmentId,
  ): Promise<Result<{ readonly stream: NodeJS.ReadableStream; readonly mediaType: string }, StoreError>>;

  appendAudit(record: AuditRecord): Promise<Result<void, StoreError>>; // durable: fsync before it returns
  readAuditPage(query: AuditQuery): Promise<Result<AuditPage, StoreError>>; // bounded; never a whole-file scan
  appendPid(record: ProcessRecord): Promise<Result<void, StoreError>>;
  tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, StoreError>>;
  readOpenPids(): Promise<readonly ProcessRecord[]>;

  appendReview(record: Review): Promise<Result<void, StoreError>>;
  readAllReviews(): Promise<readonly Review[]>;
  appendRequisition(record: Requisition): Promise<Result<void, StoreError>>;
  readAllRequisitions(): Promise<readonly Requisition[]>;
}

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

export interface Checkpoints {
  init(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<void, CheckpointError>>;
  commit(sessionId: SessionId, cwd: ResolvedPath, label: string): Promise<Result<Checkpoint, CheckpointError>>;
  list(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<readonly Checkpoint[], CheckpointError>>;
  restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha): Promise<Result<Checkpoint, CheckpointError>>;
  destroy(sessionId: SessionId): Promise<Result<void, CheckpointError>>;
}

// ---------------------------------------------------------------------------
// edge/sse, edge/ws deps
// ---------------------------------------------------------------------------

export interface EdgeDeps {
  readonly config: Config;
  readonly identity: IdentityResolver;
  readonly manager: SessionManager;
  readonly records: Records; // (tier two) the edge composes it with the manager (D77)
}

// ---------------------------------------------------------------------------
// HTTP error envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly detail?: unknown;
  };
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'bad_origin'
  | 'no_such_session'
  | 'no_such_output'
  | 'no_such_attachment'
  | 'no_such_checkpoint'
  | 'turn_in_flight'
  | 'session_ended'
  | 'workspace_busy'
  | 'outside_workspace_root'
  | 'bad_request'
  | 'checkpoint_failed'
  | 'agent_unavailable'
  // tier two
  | 'no_such_requisition'
  | 'requisition_not_approved'
  | 'requisition_consumed'
  | 'already_decided'
  | 'no_such_review'
  | 'review_final'
  | 'no_such_item'
  | 'record_write_failed'
  | 'payroll_unavailable';

// ---------------------------------------------------------------------------
// Per-module error types
// ---------------------------------------------------------------------------

export type ConfigError =
  | { readonly code: 'insecure_bind'; readonly bind: string }
  | { readonly code: 'missing_field'; readonly field: string }
  | { readonly code: 'invalid_field'; readonly field: string; readonly detail: string };

export type StartupError = { readonly code: 'storage_unwritable'; readonly path: string; readonly detail: string } | ConfigError;

export type IdentityError =
  | { readonly code: 'no_identity' }
  | { readonly code: 'untrusted_proxy'; readonly remoteAddress: string }
  | { readonly code: 'bad_secret' };

export type JailError =
  | { readonly code: 'outside_workspace_root'; readonly candidate: string; readonly roots: readonly string[] }
  | { readonly code: 'unresolvable'; readonly candidate: string; readonly detail: string };

export type StoreError =
  | { readonly code: 'io'; readonly path: string; readonly detail: string }
  | { readonly code: 'not_found'; readonly path: string }
  | { readonly code: 'corrupt'; readonly path: string; readonly detail: string }
  | { readonly code: 'unsupported_schema_version'; readonly path: string; readonly found: number };

export type CheckpointError =
  | { readonly code: 'git_unavailable'; readonly detail: string }
  | { readonly code: 'init_failed'; readonly detail: string }
  | { readonly code: 'locked'; readonly detail: string } // ckpt.git/index.lock
  | { readonly code: 'no_such_checkpoint'; readonly sha: GitSha }
  | { readonly code: 'commit_failed'; readonly detail: string }
  | { readonly code: 'restore_incomplete'; readonly detail: string };

export type AdapterError =
  | { readonly code: 'agent_unavailable'; readonly image: string; readonly detail: string }
  | { readonly code: 'unsupported_vendor'; readonly vendor: string }
  | { readonly code: 'unsupported_sandbox'; readonly sandbox: string }
  | { readonly code: 'no_child' }
  | { readonly code: 'schema_mismatch'; readonly detail: string }
  | { readonly code: 'write_failed'; readonly detail: string };

// tier two
export type RecordsError =
  | { readonly code: 'no_such_requisition'; readonly requisitionId: RequisitionId }
  | {
      readonly code: 'already_decided';
      readonly requisitionId: RequisitionId;
      readonly decidedBy: OperatorId;
      readonly state: RequisitionState;
    }
  | { readonly code: 'requisition_not_approved'; readonly requisitionId: RequisitionId; readonly state: RequisitionState }
  | { readonly code: 'requisition_consumed'; readonly requisitionId: RequisitionId; readonly sessionId: SessionId | null }
  | { readonly code: 'no_such_review'; readonly reviewId: ReviewId }
  | { readonly code: 'review_final'; readonly reviewId: ReviewId }
  | { readonly code: 'bad_request'; readonly field: string; readonly detail: string }
  | { readonly code: 'storage'; readonly cause: StoreError };

export type SessionError =
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
