// Self-contained console vocabulary. SkyNetHR extends EventPayloadMap in its host
// contract; vendor and operator identity declarations remain there.

export type Brand<T, B extends string> = T & { readonly __brand: B };

// Server-minted.
export type SessionId = Brand<string, 'SessionId'>;

export type TurnId = Brand<string, 'TurnId'>;

export type Seq = Brand<number, 'Seq'>;

// (D160) Server-minted, and the only thing that ever names an attachment's file. The
// operator's `filename` is display text and never reaches a path (I49).
export type AttachmentId = Brand<string, 'AttachmentId'>;

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

// Every fallible operation crossing a module boundary returns this rather than throwing.
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export interface EventPayloadMap {
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
  'checkpoint.created': CheckpointCreated;
  usage: UsageEvent;
  error: ErrorEvent;
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

// (D168, I51) Not everything a client receives is an envelope. A `message.delta` is a
// frame: delivered to live subscribers and to nobody else, carrying no `seq`, never
// entering the ring buffer, never appended to the spill, and never replayed. A frame is
// an envelope minus `seq` — the manager assigns `sessionId`, `ts` and the payload's
// `turnId` exactly as for any other kind, and assigns no `seq`, because a frame has no
// position in the replayable stream.
export type FrameKind = 'message.delta';

export type Frame<K extends FrameKind = FrameKind> = K extends FrameKind
  ? {
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
  | 'usage_unavailable' // this session's transport reports no token usage, so its burn is
  // unknown rather than zero (D146). Emitted once, at session start, before the first
  // `turn.started`, by an adapter whose selected transport cannot report usage.
  | 'task_started' // a subagent/task lifecycle step began
  | 'task_progress' // a subagent/task lifecycle step reported progress
  | 'task_completed' // a subagent/task lifecycle step finished
  | 'task_failed' // a subagent/task lifecycle step failed
  | 'task_cancelled'; // a subagent/task lifecycle step was cancelled

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

export type ErrorEventKind =
  | 'replay_gap'
  | 'agent_unavailable'
  | 'adapter_unknown_record'
  | 'adapter_bad_line'
  | 'adapter_schema_mismatch'
  | 'adapter_output_overflow'
  | 'checkpoint_restore_failed'
  | 'session_delete_incomplete';

export interface ErrorEvent {
  readonly kind: ErrorEventKind;
  readonly message: string;
  readonly fatal: boolean;
}

// (D168, I51) The one place `'seq' in envelope` is written — every caller that needs to
// tell a `Frame` apart from an `Envelope` imports this instead of repeating the check.
export function isFrame(envelope: Envelope | Frame): envelope is Frame {
  return !('seq' in envelope);
}
