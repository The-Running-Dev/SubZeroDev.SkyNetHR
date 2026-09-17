import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as Host from '../../contract/index.js';
import type * as Extracted from './index.js';
import { isFrame as hostIsFrame } from '../../contract/index.js';
import { isFrame as extractedIsFrame } from './index.js';

// Frozen pre-extraction declarations from SkyNetHR 58a6843. In particular, the unions
// and the payload map are literal expectations, not derived from the extracted types.
declare namespace Before {
  export type Brand<T, B extends string> = T & {
    readonly __brand: B;
  };

  export type SessionId = Brand<string, 'SessionId'>;

  export type TurnId = Brand<string, 'TurnId'>;

  export type Seq = Brand<number, 'Seq'>;

  export type AttachmentId = Brand<string, 'AttachmentId'>;

  export type CliSessionId = Brand<string, 'CliSessionId'>;

  export type CallId = Brand<string, 'CallId'>;

  export type RequestId = Brand<string, 'RequestId'>;

  export type ResolvedPath = Brand<string, 'ResolvedPath'>;

  export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

  export type GitSha = Brand<string, 'GitSha'>;

  export type Result<T, E> = {
    readonly ok: true;
    readonly value: T;
  } | {
    readonly ok: false;
    readonly error: E;
  };

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
    'checklist.item.completed': ChecklistItemCompleted;
  }

  export type EventKind = keyof EventPayloadMap;

  export type Envelope<K extends EventKind = EventKind> = K extends EventKind ? {
    readonly seq: Seq;
    readonly sessionId: SessionId;
    readonly ts: IsoTimestamp;
    readonly kind: K;
    readonly data: EventPayloadMap[K];
    readonly raw?: unknown;
  } : never;

  export type FrameKind = 'message.delta';

  export type Frame<K extends FrameKind = FrameKind> = K extends FrameKind ? {
    readonly sessionId: SessionId;
    readonly ts: IsoTimestamp;
    readonly kind: K;
    readonly data: EventPayloadMap[K];
    readonly raw?: unknown;
  } : never;

  export type SessionEndReason = 'operator' | 'server_restart' | 'storage_failure';

  export interface SessionEnded {
    readonly reason: SessionEndReason;
    readonly endedAt: IsoTimestamp;
  }

  export type SessionNoticeCode = 'compaction' | 'resume_unavailable' | 'checkpoints_unavailable' | 'checkpoint_skipped' | 'sandbox' | 'audit_unavailable' | 'storage_failure' | 'server_restart' | 'usage_unavailable';

  export interface SessionNotice {
    readonly level: 'info' | 'warn' | 'error';
    readonly code: SessionNoticeCode;
    readonly text: string;
  }

  export interface TurnStarted {
    readonly turnId: TurnId;
  }

  export type TurnStopReason = 'completed' | 'error' | 'process_exit' | 'interrupted' | 'server_restart' | 'storage_failure';

  export interface TurnEnded {
    readonly turnId: TurnId;
    readonly stopReason: TurnStopReason;
    readonly usage: Usage | null;
  }

  export interface MessageEvent {
    readonly turnId: TurnId;
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly attachments: readonly AttachmentRef[];
  }

  export interface AttachmentRef {
    readonly attachmentId: AttachmentId;
    readonly filename: string;
    readonly mediaType: string;
    readonly bytes: number;
  }

  export interface MessageDelta {
    readonly turnId: TurnId;
    readonly role: 'assistant';
    readonly text: string;
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
    readonly summary: string;
  }

  export interface ToolResult {
    readonly turnId: TurnId;
    readonly callId: CallId;
    readonly ok: boolean;
    readonly output: string;
    readonly truncated: boolean;
    readonly bytes: number;
  }

  export interface PermissionRequest {
    readonly turnId: TurnId;
    readonly requestId: RequestId;
    readonly callId: CallId;
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly matchTarget: string | null;
    readonly suggestions: readonly unknown[];
  }

  export interface CheckpointCreated {
    readonly turnId: TurnId | null;
    readonly sha: GitSha;
    readonly label: string;
  }

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

  export type ErrorEventKind = 'replay_gap' | 'agent_unavailable' | 'adapter_unknown_record' | 'adapter_bad_line' | 'adapter_schema_mismatch' | 'checkpoint_restore_failed' | 'session_delete_incomplete';

  export interface ErrorEvent {
    readonly kind: ErrorEventKind;
    readonly message: string;
    readonly fatal: boolean;
  }

  export function isFrame(envelope: Envelope | Frame): envelope is Frame;

  export type Vendor = 'claude' | 'codex';

  export type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted';

  export type SessionState = 'live' | 'ended';

  export interface PermissionPolicy {
    readonly mode: 'interactive' | 'preauthorised';
    readonly sandbox: SandboxMode | null;
    readonly banner: string | null;
  }

  export interface SessionStarted {
    readonly vendor: Vendor;
    readonly cwd: ResolvedPath;
    readonly model: string | null;
    readonly policy: PermissionPolicy;
    readonly state: SessionState;
    readonly createdAt: IsoTimestamp;
  }

  export type OperatorId = Brand<string, 'OperatorId'>;

  export type PermissionDecision = 'allow' | 'deny';

  export type ResolvedScope = 'once' | 'always' | 'standing';

  export type PermissionResolvedReason = 'answered' | 'preapproved' | 'cancelled_process_exit' | 'superseded' | 'audit_unavailable';

  export interface PermissionResolved {
    readonly turnId: TurnId;
    readonly requestId: RequestId;
    readonly decision: PermissionDecision;
    readonly scope: ResolvedScope;
    readonly operator: OperatorId | null;
    readonly reason: PermissionResolvedReason;
  }

  export type ChecklistItemId = Brand<string, 'ChecklistItemId'>;

  export interface ChecklistItemCompleted {
    readonly itemId: ChecklistItemId;
    readonly by: OperatorId;
  }
}

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Assert<T extends true> = T;

type BrandBefore = Assert<Equals<<T, B extends string>() => Host.Brand<T, B>, <T, B extends string>() => Before.Brand<T, B>>>;
type BrandReexport = Assert<Equals<<T, B extends string>() => Host.Brand<T, B>, <T, B extends string>() => Extracted.Brand<T, B>>>;
type SessionIdBefore = Assert<Equals<Host.SessionId, Before.SessionId>>;
type SessionIdReexport = Assert<Equals<Host.SessionId, Extracted.SessionId>>;
type TurnIdBefore = Assert<Equals<Host.TurnId, Before.TurnId>>;
type TurnIdReexport = Assert<Equals<Host.TurnId, Extracted.TurnId>>;
type SeqBefore = Assert<Equals<Host.Seq, Before.Seq>>;
type SeqReexport = Assert<Equals<Host.Seq, Extracted.Seq>>;
type AttachmentIdBefore = Assert<Equals<Host.AttachmentId, Before.AttachmentId>>;
type AttachmentIdReexport = Assert<Equals<Host.AttachmentId, Extracted.AttachmentId>>;
type CliSessionIdBefore = Assert<Equals<Host.CliSessionId, Before.CliSessionId>>;
type CliSessionIdReexport = Assert<Equals<Host.CliSessionId, Extracted.CliSessionId>>;
type CallIdBefore = Assert<Equals<Host.CallId, Before.CallId>>;
type CallIdReexport = Assert<Equals<Host.CallId, Extracted.CallId>>;
type RequestIdBefore = Assert<Equals<Host.RequestId, Before.RequestId>>;
type RequestIdReexport = Assert<Equals<Host.RequestId, Extracted.RequestId>>;
type ResolvedPathBefore = Assert<Equals<Host.ResolvedPath, Before.ResolvedPath>>;
type ResolvedPathReexport = Assert<Equals<Host.ResolvedPath, Extracted.ResolvedPath>>;
type IsoTimestampBefore = Assert<Equals<Host.IsoTimestamp, Before.IsoTimestamp>>;
type IsoTimestampReexport = Assert<Equals<Host.IsoTimestamp, Extracted.IsoTimestamp>>;
type GitShaBefore = Assert<Equals<Host.GitSha, Before.GitSha>>;
type GitShaReexport = Assert<Equals<Host.GitSha, Extracted.GitSha>>;
type ResultBefore = Assert<Equals<<T, E>() => Host.Result<T, E>, <T, E>() => Before.Result<T, E>>>;
type ResultReexport = Assert<Equals<<T, E>() => Host.Result<T, E>, <T, E>() => Extracted.Result<T, E>>>;
// D239: pin the historical subset and the one authorized addition independently.
// The literal Before declarations remain frozen; unexpected new kinds still fail.
type EventPayloadMapBefore = Assert<Equals<Pick<Host.EventPayloadMap, Before.EventKind>, Before.EventPayloadMap>>;
type EventPayloadMapReexport = Assert<Equals<Host.EventPayloadMap, Extracted.EventPayloadMap>>;
type EventKindBefore = Assert<Equals<Exclude<Host.EventKind, 'x-skynet.checklist.item.completed'>, Before.EventKind>>;
type EventKindReexport = Assert<Equals<Host.EventKind, Extracted.EventKind>>;
type EnvelopeBefore = Assert<Equals<Host.Envelope<Before.EventKind>, Before.Envelope>>;
type EnvelopeReexport = Assert<Equals<Host.Envelope, Extracted.Envelope>>;
type FrameKindBefore = Assert<Equals<Host.FrameKind, Before.FrameKind>>;
type FrameKindReexport = Assert<Equals<Host.FrameKind, Extracted.FrameKind>>;
type FrameBefore = Assert<Equals<Host.Frame, Before.Frame>>;
type FrameReexport = Assert<Equals<Host.Frame, Extracted.Frame>>;
type SessionEndReasonBefore = Assert<Equals<Host.SessionEndReason, Before.SessionEndReason>>;
type SessionEndReasonReexport = Assert<Equals<Host.SessionEndReason, Extracted.SessionEndReason>>;
type SessionEndedBefore = Assert<Equals<Host.SessionEnded, Before.SessionEnded>>;
type SessionEndedReexport = Assert<Equals<Host.SessionEnded, Extracted.SessionEnded>>;
type SessionNoticeCodeBefore = Assert<Equals<Host.SessionNoticeCode, Before.SessionNoticeCode>>;
type SessionNoticeCodeReexport = Assert<Equals<Host.SessionNoticeCode, Extracted.SessionNoticeCode>>;
type SessionNoticeBefore = Assert<Equals<Host.SessionNotice, Before.SessionNotice>>;
type SessionNoticeReexport = Assert<Equals<Host.SessionNotice, Extracted.SessionNotice>>;
type TurnStartedBefore = Assert<Equals<Host.TurnStarted, Before.TurnStarted>>;
type TurnStartedReexport = Assert<Equals<Host.TurnStarted, Extracted.TurnStarted>>;
type TurnStopReasonBefore = Assert<Equals<Host.TurnStopReason, Before.TurnStopReason>>;
type TurnStopReasonReexport = Assert<Equals<Host.TurnStopReason, Extracted.TurnStopReason>>;
type TurnEndedBefore = Assert<Equals<Host.TurnEnded, Before.TurnEnded>>;
type TurnEndedReexport = Assert<Equals<Host.TurnEnded, Extracted.TurnEnded>>;
type MessageEventBefore = Assert<Equals<Host.MessageEvent, Before.MessageEvent>>;
type MessageEventReexport = Assert<Equals<Host.MessageEvent, Extracted.MessageEvent>>;
type AttachmentRefBefore = Assert<Equals<Host.AttachmentRef, Before.AttachmentRef>>;
type AttachmentRefReexport = Assert<Equals<Host.AttachmentRef, Extracted.AttachmentRef>>;
type MessageDeltaBefore = Assert<Equals<Host.MessageDelta, Before.MessageDelta>>;
type MessageDeltaReexport = Assert<Equals<Host.MessageDelta, Extracted.MessageDelta>>;
type ThinkingBefore = Assert<Equals<Host.Thinking, Before.Thinking>>;
type ThinkingReexport = Assert<Equals<Host.Thinking, Extracted.Thinking>>;
type ToolCallBefore = Assert<Equals<Host.ToolCall, Before.ToolCall>>;
type ToolCallReexport = Assert<Equals<Host.ToolCall, Extracted.ToolCall>>;
type ToolResultBefore = Assert<Equals<Host.ToolResult, Before.ToolResult>>;
type ToolResultReexport = Assert<Equals<Host.ToolResult, Extracted.ToolResult>>;
type PermissionRequestBefore = Assert<Equals<Host.PermissionRequest, Before.PermissionRequest>>;
type PermissionRequestReexport = Assert<Equals<Host.PermissionRequest, Extracted.PermissionRequest>>;
type CheckpointCreatedBefore = Assert<Equals<Host.CheckpointCreated, Before.CheckpointCreated>>;
type CheckpointCreatedReexport = Assert<Equals<Host.CheckpointCreated, Extracted.CheckpointCreated>>;
type UsageBefore = Assert<Equals<Host.Usage, Before.Usage>>;
type UsageReexport = Assert<Equals<Host.Usage, Extracted.Usage>>;
type UsageEventBefore = Assert<Equals<Host.UsageEvent, Before.UsageEvent>>;
type UsageEventReexport = Assert<Equals<Host.UsageEvent, Extracted.UsageEvent>>;
type ErrorEventKindBefore = Assert<Equals<Host.ErrorEventKind, Before.ErrorEventKind>>;
type ErrorEventKindReexport = Assert<Equals<Host.ErrorEventKind, Extracted.ErrorEventKind>>;
type ErrorEventBefore = Assert<Equals<Host.ErrorEvent, Before.ErrorEvent>>;
type ErrorEventReexport = Assert<Equals<Host.ErrorEvent, Extracted.ErrorEvent>>;
type ChecklistCutoverEnvelope = {
  readonly seq: Before.Seq;
  readonly sessionId: Before.SessionId;
  readonly ts: Before.IsoTimestamp;
  readonly kind: 'x-skynet.checklist.item.completed';
  readonly data: Before.ChecklistItemCompleted;
  readonly raw?: unknown;
};
type ChecklistCutoverKind = Assert<Equals<Exclude<Host.EventKind, Before.EventKind>, 'x-skynet.checklist.item.completed'>>;
type ChecklistCutoverPayload = Assert<Equals<Host.EventPayloadMap['x-skynet.checklist.item.completed'], Before.ChecklistItemCompleted>>;
type ChecklistCutoverShape = Assert<Equals<Host.Envelope<'x-skynet.checklist.item.completed'>, ChecklistCutoverEnvelope>>;
type isFrameBefore = Assert<Equals<typeof hostIsFrame,
  (envelope: Before.Envelope | ChecklistCutoverEnvelope | Before.Frame) => envelope is Before.Frame>>;
type ChecklistNotProviderEmitted = Assert<Equals<Extract<Host.AdapterEmitted,
  'checklist.item.completed' | 'x-skynet.checklist.item.completed'>, never>>;
type isFrameReexport = Assert<Equals<typeof hostIsFrame, typeof extractedIsFrame>>;
// Check distribution as well as the default full union.
type EnvelopeSubset = Assert<Equals<
  Host.Envelope<'message' | 'permission.resolved' | 'checklist.item.completed'>,
  Before.Envelope<'message' | 'permission.resolved' | 'checklist.item.completed'>
>>;
type FrameSubset = Assert<Equals<Host.Frame<'message.delta'>, Before.Frame<'message.delta'>>>;

test('Phase 1a — the host re-exports the original frame discriminator', () => {
  assert.equal(hostIsFrame, extractedIsFrame);
});
