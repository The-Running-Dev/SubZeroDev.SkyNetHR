// In-process session boundary. Host identity and business records stay outside it.
import type * as Generic from '../contract/index.js';
import type { Brand, SessionId, TurnId, Seq, AttachmentId, CliSessionId, CallId, RequestId, ResolvedPath, IsoTimestamp, GitSha, Result, Frame, SessionEndReason } from '../contract/index.js';
import type { PermissionPolicy, SandboxMode, PermissionDecision, AdapterError } from '../providers/types.js';
import type { ProcessRecord } from '../process/ledger.js';
import type { RuntimeLease } from '../store/lease.js';
import type { RuntimeLeaseError } from '../store/lease.js';
import type { AttachmentStaging, UploadId } from './attachments.js';
import type { CreateAttemptStore } from '../store/create-attempts.js';
export type * from '../contract/index.js';
export type * from '../providers/types.js';
export type { ProcessRecord } from '../process/ledger.js';
export type PrincipalId = string;
export type ProviderId = string;
export function isFrame(event: Envelope | Frame): event is Frame { return !('seq' in event); }
// Host augmentation remains intact. Only identity-bearing generic payloads are
// widened here; the host facade maps its branded identity at the boundary.
export type EventPayloadMap = Omit<Generic.EventPayloadMap, 'session.started' | 'permission.resolved'> & {
  'session.started': SessionStarted; 'permission.resolved': PermissionResolved;
};
export type EventKind = keyof EventPayloadMap;
export type Envelope<K extends EventKind = EventKind> = K extends EventKind ? { readonly seq: Seq; readonly sessionId: SessionId; readonly ts: IsoTimestamp; readonly kind: K; readonly data: EventPayloadMap[K]; readonly raw?: unknown } : never;
export interface RuntimeOptions {
  readonly storageRoot: ResolvedPath;
  readonly workspaceRoots: readonly ResolvedPath[];
  readonly caps: Caps;
  readonly includeRaw: boolean;
  readonly streamDeltas: boolean;
  readonly maxLiveSessionsPerWorkspace?: number;
}
export type SessionState = 'live' | 'ended';

export interface SessionRecord {
    readonly id: SessionId;
    readonly owner: PrincipalId;
    readonly vendor: ProviderId;
    readonly cwd: ResolvedPath;
    readonly model: string | null;
    readonly policy: PermissionPolicy;
    readonly sandbox: SandboxMode | null;
    cliSessionId: CliSessionId | null;
    lastSeq: Seq | 0;
    state: SessionState;
    readonly createdAt: IsoTimestamp;
    endedAt: IsoTimestamp | null;
    endReason?: SessionEndReason | null;
}

export interface SessionSummary {
    readonly id: SessionId;
    readonly owner: PrincipalId;
    readonly vendor: ProviderId;
    readonly cwd: ResolvedPath;
    readonly model: string | null;
    readonly policy: PermissionPolicy;
    readonly sandbox: SandboxMode | null;
    readonly lastSeq: Seq | 0;
    readonly state: SessionState;
    readonly createdAt: IsoTimestamp;
    readonly endedAt: IsoTimestamp | null;
}

export interface SessionSnapshot {
    readonly sessionId: SessionId;
    readonly owner: PrincipalId;
    readonly vendor: ProviderId;
    readonly cwd: ResolvedPath;
    readonly createdAt: IsoTimestamp;
}

export interface LiveSession {
    readonly record: SessionRecord;
    turn: Turn | null;
}

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
    readonly matchTarget: string | null;
}

export interface AttachmentUpload {
    readonly filename: string;
    readonly mediaType: string;
    readonly dataBase64: string;
}

export type StandingRuleExpression = Brand<string, 'StandingRuleExpression'>;

export type AnswerScope = 'once' | 'always';

export type ResolvedScope = 'once' | 'always' | 'standing';

export type PermissionResolvedReason = 'answered' | 'preapproved' | 'cancelled_process_exit' | 'superseded' | 'audit_unavailable';

export interface PermissionResolved {
    readonly turnId: TurnId;
    readonly requestId: RequestId;
    readonly decision: PermissionDecision;
    readonly scope: ResolvedScope;
    readonly operator: PrincipalId | null;
    readonly reason: PermissionResolvedReason;
}

export interface SessionStarted {
    readonly vendor: ProviderId;
    readonly cwd: ResolvedPath;
    readonly model: string | null;
    readonly policy: PermissionPolicy;
    readonly state: SessionState;
    readonly createdAt: IsoTimestamp;
}

export interface Checkpoint {
    readonly sha: GitSha;
    readonly label: string;
    readonly ts: IsoTimestamp;
}

export interface IgnoredEntry {
    readonly path: string;
    readonly kind: 'file' | 'dir';
    readonly sizeBytes: number | null;
    readonly mtimeMs: number;
}

export interface IgnoredManifest {
    readonly sha: GitSha;
    readonly capturedAt: IsoTimestamp;
    readonly entries: readonly IgnoredEntry[];
}

export interface IgnoredDelta {
    readonly path: string;
    readonly change: 'added' | 'removed' | 'modified';
}

export interface RestoreResult {
    readonly safety: Checkpoint;
    readonly unreached: readonly IgnoredDelta[] | null;
}

export type AuditCursor = Brand<string, 'AuditCursor'>;

export interface AuditRecord {
    readonly ts: IsoTimestamp;
    readonly operator: PrincipalId | null;
    readonly sessionId: SessionId;
    readonly vendor: ProviderId;
    readonly sandbox: SandboxMode | null;
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly decision: PermissionDecision;
    readonly scope: ResolvedScope;
    readonly reason: string | null;
}

export interface AuditQuery {
    readonly before: AuditCursor | null;
    readonly limit: number;
    readonly sessionId: SessionId | null;
    readonly operator: PrincipalId | null;
    readonly since: IsoTimestamp | null;
    readonly until: IsoTimestamp | null;
    readonly incidentsOnly: boolean;
}

export interface AuditPage {
    readonly records: readonly AuditRecord[];
    readonly nextCursor: AuditCursor | null;
}

export interface Caps {
    readonly ringCapacity: number;
    readonly toolResultBytes: number;
    readonly subscriberQueueHighWater: number;
    readonly auditPageMax: number;
    readonly standingRuleBytes: number;
    readonly attachmentBytes: number;
    readonly attachmentCount: number;
    readonly sessionToolOutputBytes: number;
}

export interface SessionMetaFile {
    readonly schemaVersion: 1;
    readonly session: SessionRecord;
}

export interface CreateSessionInput {
    readonly hostData?: unknown;
    readonly vendor: ProviderId;
    readonly cwd: string;
    readonly model: string | null;
    readonly sandbox: SandboxMode | null;
}

export interface PermissionAnswer {
    readonly requestId: RequestId;
    readonly decision: PermissionDecision;
    readonly scope: AnswerScope;
    readonly rule: StandingRuleExpression | null;
    readonly reason: string | null;
}

export interface SubscriberSink {
    deliver(envelope: Envelope | Frame): void;
    close(): void;
}

export interface Subscription {
    close(): void;
}

export interface LoadedMeta {
    readonly sessionId: SessionId;
    readonly result: Result<SessionRecord, StoreError>;
}

export interface SessionStore {
    readonly createAttempts: CreateAttemptStore;
    readonly lease: RuntimeLease;
    createSession(record: SessionRecord): Promise<Result<void, StoreError>>;
    writeMeta(record: SessionRecord): Promise<Result<void, StoreError>>;
    readAllMeta(): Promise<readonly LoadedMeta[]>;
    deleteSession(sessionId: SessionId): Promise<Result<void, StoreError>>;
    appendEvent(sessionId: SessionId, envelope: Envelope): Promise<Result<void, StoreError>>;
    readEventsAfter(sessionId: SessionId, after: Seq | 0): AsyncIterable<Result<Envelope, StoreError>>;
    readLastSeq(sessionId: SessionId): Promise<Result<Seq | 0, StoreError>>;
    pushRing(sessionId: SessionId, envelope: Envelope): void;
    readRingAfter(sessionId: SessionId, after: Seq | 0): readonly Envelope[] | null;
    dropRing(sessionId: SessionId): void;
    writeToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId, bytes: Buffer): Promise<Result<void, StoreError>>;
    openToolOutput(sessionId: SessionId, turnId: TurnId, callId: CallId): Promise<Result<NodeJS.ReadableStream, StoreError>>;
    writeAttachment(sessionId: SessionId, turnId: TurnId, attachmentId: AttachmentId, bytes: Buffer, mediaType: string): Promise<Result<void, StoreError>>;
    openAttachment(sessionId: SessionId, turnId: TurnId, attachmentId: AttachmentId): Promise<Result<{
        readonly stream: NodeJS.ReadableStream;
        readonly mediaType: string;
    }, StoreError>>;
    removeAttachments(sessionId: SessionId, turnId: TurnId): Promise<Result<void, StoreError>>;
    appendAudit(record: AuditRecord): Promise<Result<void, StoreError>>;
    readAuditPage(query: AuditQuery): Promise<Result<AuditPage, StoreError>>;
    appendPid(record: ProcessRecord): Promise<Result<void, StoreError>>;
    tombstonePid(pid: number, exitedAt: IsoTimestamp): Promise<Result<void, StoreError>>;
    readOpenPids(): Promise<readonly ProcessRecord[]>;
    close(): Promise<void>;
}

export interface Checkpoints {
    init(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<void, CheckpointError>>;
    commit(sessionId: SessionId, cwd: ResolvedPath, label: string): Promise<Result<Checkpoint, CheckpointError>>;
    list(sessionId: SessionId, cwd: ResolvedPath): Promise<Result<readonly Checkpoint[], CheckpointError>>;
    restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha): Promise<Result<RestoreResult, CheckpointError>>;
    destroy(sessionId: SessionId): Promise<Result<void, CheckpointError>>;
}

export type JailError = {
    readonly code: 'outside_workspace_root';
    readonly candidate: string;
    readonly roots: readonly string[];
} | {
    readonly code: 'unresolvable';
    readonly candidate: string;
    readonly detail: string;
};

export type StoreError = {
    readonly code: 'io';
    readonly path: string;
    readonly detail: string;
} | {
    readonly code: 'not_found';
    readonly path: string;
} | {
    readonly code: 'corrupt';
    readonly path: string;
    readonly detail: string;
} | {
    readonly code: 'unsupported_schema_version';
    readonly path: string;
    readonly found: number;
};

export type CheckpointError = {
    readonly code: 'git_unavailable';
    readonly detail: string;
} | {
    readonly code: 'init_failed';
    readonly detail: string;
} | {
    readonly code: 'locked';
    readonly detail: string;
} | {
    readonly code: 'no_such_checkpoint';
    readonly sha: GitSha;
} | {
    readonly code: 'commit_failed';
    readonly detail: string;
} | {
    readonly code: 'restore_incomplete';
    readonly detail: string;
};

export type SessionError = {
    readonly code: 'not_found';
    readonly sessionId: SessionId;
} | {
    readonly code: 'session_ended';
    readonly sessionId: SessionId;
} | {
    readonly code: 'turn_in_flight';
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
} | {
    readonly code: 'workspace_busy';
    readonly holder: {
        readonly cwd: ResolvedPath;
        readonly owner: PrincipalId;
    };
}  | {
    readonly code: 'bad_request';
    readonly field: string;
    readonly detail: string;
} | {
    readonly code: 'jail';
    readonly cause: JailError;
} | {
    readonly code: 'adapter';
    readonly cause: AdapterError;
} | {
    readonly code: 'checkpoint';
    readonly cause: CheckpointError;
} | {
    readonly code: 'storage';
    readonly cause: StoreError;
} | { readonly code: 'host_create'; readonly cause: unknown }
  | { readonly code: 'create_outcome_unknown'; readonly sessionId: SessionId };

export interface SessionCore {
    readonly extensions: {
      readonly operations: readonly { name: string; schema: unknown; mutates: boolean }[];
      invoke(name: string, sessionId: SessionId, owner: PrincipalId, input: unknown): Promise<Result<unknown, SessionError>>;
    };
    readonly attachments: AttachmentStaging;
    boot(): Promise<Result<void, RuntimeLeaseError>>;
    readonly events: {
      append<K extends EventKind>(sessionId: SessionId, owner: PrincipalId, kind: K, data: EventPayloadMap[K]): Promise<Result<Envelope<K>, SessionError>>;
    };
    readonly admin: {
      snapshot(sessionId: SessionId): SessionRecord | null;
      readEvents(sessionId: SessionId, after?: Seq | 0): AsyncIterable<Result<Envelope, StoreError>>;
      readAudit(query: AuditQuery): Promise<Result<AuditPage, StoreError>>;
      remove(sessionId: SessionId): Promise<Result<void, SessionError>>;
      reassignPrincipal(sessionId: SessionId, principal: PrincipalId): Promise<Result<void, SessionError>>;
    };
    listPage(owner: PrincipalId, after: SessionId | null, limit: number): { items: readonly SessionSummary[]; next: SessionId | null };
    shutdown(): Promise<void>;
    create(owner: PrincipalId, input: CreateSessionInput): Promise<Result<{
        sessionId: SessionId;
    }, SessionError>>;
    list(owner: PrincipalId): readonly SessionSummary[];
    get(sessionId: SessionId, owner: PrincipalId): Result<SessionSummary, SessionError>;
    send(sessionId: SessionId, owner: PrincipalId, text: string, attachments: readonly UploadId[]): Promise<Result<{
        turnId: TurnId;
    }, SessionError>>;
    answerPermission(sessionId: SessionId, owner: PrincipalId, answer: PermissionAnswer): Promise<Result<{
        accepted: boolean;
        resolution: EventPayloadMap['permission.resolved'] | null;
    }, SessionError>>;
    interrupt(sessionId: SessionId, owner: PrincipalId, turnId: TurnId): Promise<Result<void, SessionError>>;
    end(sessionId: SessionId, owner: PrincipalId): Promise<Result<void, SessionError>>;
    remove(sessionId: SessionId, owner: PrincipalId): Promise<Result<void, SessionError>>;
    listCheckpoints(sessionId: SessionId, owner: PrincipalId): Promise<Result<readonly Checkpoint[], SessionError>>;
    restore(sessionId: SessionId, owner: PrincipalId, sha: GitSha): Promise<Result<RestoreResult, SessionError>>;
    openToolOutput(sessionId: SessionId, owner: PrincipalId, turnId: TurnId, callId: CallId): Promise<Result<NodeJS.ReadableStream, SessionError>>;
    openAttachment(sessionId: SessionId, owner: PrincipalId, turnId: TurnId, attachmentId: AttachmentId): Promise<Result<{
        readonly stream: NodeJS.ReadableStream;
        readonly mediaType: string;
    }, SessionError>>;
    subscribe(sessionId: SessionId, owner: PrincipalId, after: Seq | 0, sink: SubscriberSink): Promise<Result<Subscription, SessionError>>;
}
