import type { ProcessRecord } from '../agent-console/process/ledger.js';
// SkyNetHR's contract facade. Generic declarations are owned by AgentConsole;
// design/20-contract.md remains authoritative for their meaning.
import type { Adapter, AdapterError, AdapterOptions, AdapterNotification, AdapterEmitted, AdapterEvent, AttachmentPayload, SandboxMode, PermissionDecision, PermissionPolicy } from '../agent-console/providers/types.js';
export type { Adapter, AdapterError, AdapterOptions, AdapterNotification, AdapterEmitted, AdapterEvent, AttachmentPayload, SandboxMode, PermissionDecision, PermissionPolicy } from '../agent-console/providers/types.js';
import type {
  Brand,
  SessionId,
  TurnId,
  Seq,
  AttachmentId,
  CliSessionId,
  CallId,
  RequestId,
  ResolvedPath,
  IsoTimestamp,
  GitSha,
  Result,
  EventPayloadMap,
  EventKind,
  Envelope,
  FrameKind,
  Frame,
  SessionEndReason,
  SessionEnded,
  SessionNoticeCode,
  SessionNotice,
  TurnStarted,
  TurnStopReason,
  TurnEnded,
  MessageEvent,
  AttachmentRef,
  MessageDelta,
  Thinking,
  ToolCall,
  ToolResult,
  PermissionRequest,
  CheckpointCreated,
  Usage,
  UsageEvent,
  ErrorEventKind,
  ErrorEvent,
} from '../agent-console/contract/index.js';
export type {
  Brand,
  SessionId,
  TurnId,
  Seq,
  AttachmentId,
  CliSessionId,
  CallId,
  RequestId,
  ResolvedPath,
  IsoTimestamp,
  GitSha,
  Result,
  EventPayloadMap,
  EventKind,
  Envelope,
  FrameKind,
  Frame,
  SessionEndReason,
  SessionEnded,
  SessionNoticeCode,
  SessionNotice,
  TurnStarted,
  TurnStopReason,
  TurnEnded,
  MessageEvent,
  AttachmentRef,
  MessageDelta,
  Thinking,
  ToolCall,
  ToolResult,
  PermissionRequest,
  CheckpointCreated,
  Usage,
  UsageEvent,
  ErrorEventKind,
  ErrorEvent,
} from '../agent-console/contract/index.js';
export { isFrame } from '../agent-console/contract/index.js';

// Host-dependent payloads stay here. Augmentation preserves the existing closed
// SkyNetHR vocabulary, including historical checklist events, without a reverse import.
declare module '../agent-console/contract/index.js' {
  interface EventPayloadMap {
    'session.started': SessionStarted;
    'permission.resolved': PermissionResolved;
    'checklist.item.completed': ChecklistItemCompleted;
  }
}

// Server-minted, tier two.
export type ReviewId = Brand<string, 'ReviewId'>;
export type RequisitionId = Brand<string, 'RequisitionId'>;

// Identity, from the identity edge.
export type OperatorId = Brand<string, 'OperatorId'>;

// An identifier declared by a deployment's checklist template in `config`. Tier two.
export type ChecklistItemId = Brand<string, 'ChecklistItemId'>;

// Server-minted, opaque to every caller: a position in `audit.ndjson` from which the
// next page continues. Equality and round-tripping only; no caller may parse one.
export type AuditCursor = Brand<string, 'AuditCursor'>;

export type Vendor = typeof import('../config/providers.js').providerDefinitions[number]['id'];
export type SessionState = 'live' | 'ended';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

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
  // Optional (#115): absent on a session persisted before this field existed, and on any
  // other read null means "no reason recorded" rather than "not ended" — `endedAt` alone
  // still carries that. Boot rehydration is the one path that can tell a real end from its
  // own synthesised `endedAt` (D130's still-`live`-on-disk case), so it is the one path that
  // writes `'server_restart'` here; every other write is the real reason for a real end.
  endReason?: SessionEndReason | null;
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

export type { ProcessRecord, ProcessTombstone } from '../agent-console/process/ledger.js';

// ---------------------------------------------------------------------------
// Server lock
// ---------------------------------------------------------------------------

// `<storage>/server.lock`. A lease (D180): liveness is decided by watching `instanceId` and
// `renewals` change, never by interrogating a process table or comparing a clock. `pid`,
// `hostname`, `startedAt` and `image` are retained and are informational only — no decision
// reads them (I57); they are what a `storage_locked` refusal prints. It carries no
// `exitedAt`: `releaseLock` removes the file, so the file's absence is an unheld root.
export interface ServerLock {
  readonly instanceId: string; // minted randomly at boot; identifies one run of one server
  readonly renewals: number; // monotonic; incremented by the holder for as long as it holds the root
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: IsoTimestamp; // load-bearing, exactly as ProcessRecord.startedAt is
  readonly image: string;
}

// `'displaced'` is a success, not an error: the renewal found this process no longer holds
// the root (D195). See `Store.renewLock`.
export type LockRenewal = 'renewed' | 'displaced';

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

// (D160) What the operator uploads, inline on `POST /message`.
export interface AttachmentUpload {
  readonly filename: string; // display only; never used to build a path (I49)
  readonly mediaType: string; // the client's claim, stored verbatim, never trusted on the way out
  readonly dataBase64: string; // decoded size is what `Caps.attachmentBytes` bounds
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

// Tier two (D71). Session-scoped: no `turnId`, and it may interleave with a turn's events.
export interface ChecklistItemCompleted {
  readonly itemId: ChecklistItemId;
  readonly by: OperatorId;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly sha: GitSha;
  readonly label: string;
  readonly ts: IsoTimestamp;
}

// The ignored-path manifest (D182, D187) — the one exception to "git is the store",
// because ignored paths are neither checkpointed nor cleaned and git holds no record of
// them at all.

// One line of `git status --ignored=matching`, which collapses an ignored *directory*
// into a single entry rather than walking the files beneath it.
export interface IgnoredEntry {
  readonly path: string; // workspace-relative, POSIX separators, never absolute
  readonly kind: 'file' | 'dir'; // 'dir' is a collapsed directory
  readonly sizeBytes: number | null; // null exactly when kind === 'dir'
  readonly mtimeMs: number; // the entry's own mtime, not its subtree's
}

export interface IgnoredManifest {
  readonly sha: GitSha; // the checkpoint this was captured alongside
  readonly capturedAt: IsoTimestamp;
  readonly entries: readonly IgnoredEntry[];
}

// One difference between a target checkpoint's manifest and the workspace as restore found it.
export interface IgnoredDelta {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'modified';
}

// What `restore` returns. `safety` is the checkpoint taken on the way in, never the target.
export interface RestoreResult {
  readonly safety: Checkpoint;
  readonly unreached: readonly IgnoredDelta[] | null;
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
  // Total blob bytes one session may store. Past it the blob is not written, the envelope
  // still carries `truncated: true` and the true pre-truncation size, and the fetch route
  // answers `404 no_such_output` exactly as S9.5 already specifies. Nothing already written
  // is ever evicted, and the rule does not reach `attachments/` (D160): a tool blob is a
  // re-runnable command's output, an attachment is the operator's only copy.
  readonly sessionToolOutputBytes: number;
}

export interface Config {
  readonly bind: { readonly host: string; readonly port: number };
  readonly auth: AuthConfig;
  readonly workspaceRoots: readonly ResolvedPath[];
  readonly storageRoot: ResolvedPath;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: readonly string[]; // upstream addresses permitted to set the identity header
  readonly caps: Caps;
  // `Max-Age` on the cookie `POST /api/login` mints. Read only under
  // `auth.mode === 'shared-secret'`; under either header mode the credential is the
  // upstream proxy's and its lifetime is not ours to set.
  readonly sessionCookieMaxAgeSeconds: number;
  readonly includeRaw: boolean;
  // (S25.6) Requests token-level `message.delta` frames from a transport that gates them
  // behind a flag. Defaults off; off produces today's envelope sequence unchanged. A
  // transport that streams deltas unconditionally ignores it (`AdapterOptions.streamDeltas`).
  readonly streamDeltas: boolean;
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
  // (D168, I51) A frame carries no `seq`; a sink distinguishes the two by that absence
  // rather than a wrapper of its own — `isFrame` is the one place that check lives.
  deliver(envelope: Envelope | Frame): void;
  close(): void;
}

export interface Subscription {
  close(): void;
}

export interface SessionManager {
  boot(): Promise<Result<void, StartupError>>; // reap → rehydrate → close open turns; before listen

  // `server.ts`'s shutdown step 3 (D177, D178): mutes the manager's own notify sink, then
  // kills every live turn's child tree and tombstones it. Takes no owner and no arguments,
  // like `boot`, and returns no `Result` — best-effort throughout, no error union gains a
  // variant for it (`20-contract.md § session-manager`).
  shutdown(): Promise<void>;

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
  restore(sessionId: SessionId, owner: OperatorId, sha: GitSha): Promise<Result<RestoreResult, SessionError>>;
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
  // (#203) Rolls back every attachment staged for a turn whose durable `message`
  // reference will now never be constructed — a partial multi-attachment write failure,
  // or a spill-append failure (checkpoint, `turn.started`, or `message` itself) after
  // blob writes already succeeded. A no-op, not an error, when the turn wrote none.
  removeAttachments(sessionId: SessionId, turnId: TurnId): Promise<Result<void, StoreError>>;

  appendAudit(record: AuditRecord): Promise<Result<void, StoreError>>; // durable: fsync before it returns
  readAuditPage(query: AuditQuery): Promise<Result<AuditPage, StoreError>>; // bounded; never a whole-file scan
  appendPid(record: ProcessRecord): Promise<Result<void, StoreError>>;
  tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, StoreError>>;
  readOpenPids(): Promise<readonly ProcessRecord[]>;

  appendReview(record: Review): Promise<Result<void, StoreError>>;
  readAllReviews(): Promise<readonly Review[]>;
  appendRequisition(record: Requisition): Promise<Result<void, StoreError>>;
  readAllRequisitions(): Promise<readonly Requisition[]>;

  // Claim `<storage>/server.lock` for `self`. Called as boot's step 0, before the reap step
  // and not merely before `listen`. Returns `StartupError` rather than `StoreError` because
  // `storage_locked` is a startup refusal and because `SessionManager.boot` already returns
  // that union, so it composes with no wrapper. No `LivenessProbe` (D180): a present lock is
  // decided by observing `(instanceId, renewals)` unchanged across one observation window, on
  // this process's own monotonic clock, never by a process table or a wall clock.
  claimLock(self: ServerLock): Promise<Result<void, StartupError>>;

  // Remove the lock at clean shutdown. Ownership-checked (D180, I56): removes the file only
  // while it still carries the `instanceId` this process claimed with. A mismatch or an
  // absent file means this process has already been displaced and is a logged no-op, not an
  // error — shutdown raises nothing.
  releaseLock(): Promise<Result<void, StoreError>>;

  // Performs one ownership-checked renewal of `<storage>/server.lock` and reports which
  // happened (D195). `store` owns no clock: this is called on demand, and `server.ts` drives
  // the interval. `'displaced'` is a success, not an error — the lock is absent or names
  // another `instanceId`, and this process must stop rather than go on writing server-wide
  // state it no longer owns. A `StoreError.io` here means the renewal could not be attempted
  // at all, which is not the same thing and does not by itself mean the root was lost.
  renewLock(): Promise<Result<LockRenewal, StoreError>>;

  // Releases the OS handles a `Store` owns (D202): the four server-wide append files each
  // opened once and held for the store's life (`lazyHandle`). Returns no `Result` — it is
  // called from shutdown, where best-effort is the rule and no error union gains a variant
  // for it. Idempotent and writes nothing, so it establishes no durable state. Called only
  // from `server.ts`'s shutdown path, behind the lock release: `close()` releases this
  // process's own file handles, writes nothing, and is invisible to any other process, so it
  // belongs behind the one act (lock release) a successor can observe, never in front of it.
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

export interface Checkpoints {
  init(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<void, CheckpointError>>;
  commit(sessionId: SessionId, cwd: ResolvedPath, label: string): Promise<Result<Checkpoint, CheckpointError>>;
  list(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<readonly Checkpoint[], CheckpointError>>;
  restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha): Promise<Result<RestoreResult, CheckpointError>>;
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

export type StartupError =
  | { readonly code: 'storage_unwritable'; readonly path: string; readonly detail: string }
  // Another server holds this storage root. The holder is named because a refusal that does
  // not say who is holding it leaves an operator with nothing to act on — which is most of
  // the value when an operator is looking at one, and is why an OS advisory lock was
  // rejected (D161).
  | { readonly code: 'storage_locked'; readonly path: string; readonly holder: ServerLock }
  // `server.lock` is present and will not parse (D196). Not a renewal caught in flight —
  // every write publishes the file whole (I61) — and not a lock predating the lease, which
  // parses and simply carries no `renewals`, reaching the reclaim path instead (I61).
  | { readonly code: 'storage_lock_corrupt'; readonly path: string; readonly detail: string }
  | ConfigError;

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
