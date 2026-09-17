import type { EventKind, EventPayloadMap, FrameKind, AttachmentRef, ResolvedPath, CliSessionId, RequestId, TurnId, TurnEnded, Result } from '../contract/index.js';
export type { CallId, CliSessionId, RequestId, Result, TurnId } from '../contract/index.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted';
export type PermissionDecision = 'allow' | 'deny';
export interface PermissionPolicy {
  readonly mode: 'interactive' | 'preauthorised';
  readonly sandbox: SandboxMode | null;
  readonly banner: string | null; // non-null exactly when mode === 'preauthorised'
}

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
  // (S25.6) Whether to request token-level `message.delta` frames from a transport that
  // gates them behind a flag. An adapter whose transport streams deltas unconditionally
  // ignores it. Defaults off (`Config.streamDeltas`); off reproduces today's envelope
  // sequence element for element. Which adapters read it, and how, is `adapters/*`'s own
  // vendor knowledge (I20) and is not stated here.
  readonly streamDeltas: boolean;
}

// (D160) An attachment as the adapter receives it: the ref the envelope carries, plus the bytes.
// The manager reads them from `store` and hands them down, because an adapter depends on
// `contract` and nothing else and may not be given a store handle.
export interface AttachmentPayload {
  readonly ref: AttachmentRef;
  readonly data: Uint8Array;
}

export interface Adapter {
  readonly vendor: string;
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
    model?: string,
  ): Promise<Result<void, AdapterError>>;
  respond(requestId: RequestId, decision: PermissionDecision): Result<void, AdapterError>;
  kill(): Promise<void>; // terminate-then-force, on the process tree
}

export type AdapterError =
  | { readonly code: 'invalid_model'; readonly model: string }
  | { readonly code: 'turn_in_flight' }
  | { readonly code: 'session_closed' }
  | { readonly code: 'agent_unavailable'; readonly image: string; readonly detail: string }
  | { readonly code: 'unsupported_vendor'; readonly vendor: string }
  | { readonly code: 'unsupported_sandbox'; readonly sandbox: string }
  | { readonly code: 'no_child' }
  | { readonly code: 'schema_mismatch'; readonly detail: string }
  | { readonly code: 'write_failed'; readonly detail: string };

export interface ProviderCapabilities {
  readonly workspace: 'required' | 'none';
  readonly permissions: PermissionPolicy['mode'];
  readonly attachments: { readonly supported: boolean };
  readonly usage: boolean;
  readonly resume: boolean;
  readonly streamingDeltas: boolean;
  readonly models?: 'free-form' | readonly string[];
  readonly sandboxModes?: readonly SandboxMode[];
  readonly needsProcess: boolean;
  readonly conversationState: 'provider' | 'runtime';
}

export interface ProviderStatus {
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly version?: string;
  readonly capabilities: ProviderCapabilities;
}

export interface ProbeContext {
  readonly cwd: ResolvedPath;
  readonly refresh?: boolean;
}

// Process facts remain separate from transcript payloads until ProcessSupervisor lands.
export type ProviderNotification = Exclude<AdapterNotification, { kind: 'event' }>;
export type ProviderEventKind = Exclude<AdapterEmitted, FrameKind>;
export type ProviderData<K extends AdapterEmitted> = Omit<EventPayloadMap[K], 'turnId'>;

export interface ProviderContext extends ProbeContext {
  notify(notification: ProviderNotification): void;
  emit<K extends 'session.notice' | 'error'>(kind: K, data: ProviderData<K>, raw?: unknown): void;
}

export interface ProviderOptions {
  readonly model?: string;
  readonly sandbox: SandboxMode | null;
  readonly streamDeltas: boolean;
}

export interface TurnInput {
  readonly text: string;
  readonly attachments: readonly AttachmentPayload[];
  readonly resume: CliSessionId | null;
  readonly model?: string;
}

export interface TurnContext {
  readonly turnId: TurnId;
  emit<K extends ProviderEventKind>(kind: K, data: ProviderData<K>, raw?: unknown): void;
  frame<K extends FrameKind>(kind: K, data: ProviderData<K>, raw?: unknown): void;
}

// Delivery outcome only. The caller owns audit, operator identity and resolution events.
export type Resolution =
  | { readonly decision: PermissionDecision; readonly reason: 'answered' }
  | { readonly decision: 'deny'; readonly reason: 'cancelled_process_exit';
      readonly cause: Extract<AdapterError, { code: 'no_child' | 'write_failed' }> };
export type TurnOutcome = Omit<TurnEnded, 'turnId'>;

export interface TurnHandle {
  // The existing send acknowledgement is distinct from the lifetime of the turn.
  readonly started: Promise<Result<void, AdapterError>>;
  readonly done: Promise<TurnOutcome>;
  respondToPermission(requestId: RequestId, decision: PermissionDecision): Result<Resolution, AdapterError>;
  interrupt(): Promise<void>;
}

export interface ProviderSession {
  readonly policy: PermissionPolicy;
  readonly capabilities: ProviderCapabilities;
  startTurn(input: TurnInput, context: TurnContext): TurnHandle;
  close(): Promise<void>;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly label: string;
  probe(context: ProbeContext): Promise<ProviderStatus>;
  create(context: ProviderContext, options: ProviderOptions): Promise<Result<ProviderSession, AdapterError>>;
}
