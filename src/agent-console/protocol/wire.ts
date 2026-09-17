// Phase 4 wire values. Optional null and absence have the same meaning; opaque
// string outcomes deliberately admit future values. No branded host identity.
export interface SessionRef { sessionId: string; principal: string; }
export interface Page { cursor?: string | null; limit?: number | null; }
export type Event = { sessionId: string; ts: string; kind: string; data: Record<string, unknown>; raw?: Record<string, unknown> | null }
  & ({ seq: number } | { kind: 'message.delta'; seq?: null });
export interface Session {
  id: string; owner: string; vendor: string; cwd: string; model?: string | null;
  policy: { mode: string; sandbox?: string | null; banner?: string | null }; sandbox?: string | null;
  lastSeq: number; state: string; createdAt: string; endedAt?: string | null; endReason?: string | null;
}
export interface Chunk { data: string; nextOffset: number; eof: boolean; contentType?: string | null; }
export interface Operation<P, R> { params: P; result: R; }
export interface Operations {
  'runtime.hello': Operation<{ version: string; storage: { kind: 'fs' | 'memory'; root: string }; workspaceRoots: string[];
    hostMethods?: string[] | null; options?: { includeRaw?: boolean | null; streamDeltas?: boolean | null; maxLiveSessionsPerWorkspace?: number | null;
      hostAttemptTimeoutMs?: number | null; providerStdoutLineBytes?: number | null; caps?: Record<string, number | null> | null } | null },
    { version: string; storage: string; extensions: { name: string; schema: unknown; mutates: boolean }[] }>;
  'sessions.create': Operation<{ principal: string; provider: string; cwd: string; model?: string | null; sandbox?: string | null; input?: unknown }, { sessionId: string }>;
  'sessions.list': Operation<{ principal: string } & Page, { items: Session[]; next?: string | null }>;
  'sessions.get': Operation<SessionRef, Session>;
  'sessions.end': Operation<SessionRef, null>;
  'sessions.remove': Operation<SessionRef, null>;
  'turns.send': Operation<SessionRef & { text: string; model?: string | null; uploads?: string[] | null }, { turnId: string }>;
  'turns.interrupt': Operation<SessionRef & { turnId: string }, null>;
  'permissions.respond': Operation<SessionRef & { requestId: string; decision: 'allow' | 'deny'; scope?: 'once' | 'always' | null; rule?: string | null; reason?: string | null },
    { accepted: boolean; resolution?: Record<string, unknown> | null }>;
  'events.subscribe': Operation<SessionRef & { fromSeq?: number | null }, { subscriptionId: string }>;
  'events.unsubscribe': Operation<{ principal: string; subscriptionId: string }, null>;
  'events.credit': Operation<{ principal: string; subscriptionId: string; count: number }, null>;
  'events.read': Operation<SessionRef & { fromSeq?: number | null; limit?: number | null }, { events: Event[]; nextSeq: number }>;
  'events.append': Operation<SessionRef & { kind: string; data: Record<string, unknown> }, Event>;
  'toolOutput.read': Operation<SessionRef & { turnId: string; callId: string; offset: number; length: number }, Chunk>;
  'attachments.begin': Operation<SessionRef & { name: string; size: number; contentType?: string | null }, { uploadId: string }>;
  'attachments.write': Operation<{ principal: string; uploadId: string; offset: number; data: string }, { nextOffset: number }>;
  'attachments.commit': Operation<{ principal: string; uploadId: string }, { committedUploadId: string }>;
  'attachments.abort': Operation<{ principal: string; uploadId: string }, null>;
  'attachments.read': Operation<SessionRef & { turnId: string; attachmentId: string; offset: number; length: number }, Chunk>;
  'providers.list': Operation<Record<string, never>, { id: string; label: string; available: boolean; unavailableReason?: string | null; cliVersion?: string | null; capabilities: Record<string, unknown> }[]>;
  'providers.refresh': Operations['providers.list'];
  'checkpoints.list': Operation<SessionRef, { sha: string; label: string; ts: string }[]>;
  'checkpoints.restore': Operation<SessionRef & { sha: string }, { safety: { sha: string; label: string; ts: string }; unreached?: { path: string; change: string }[] | null }>;
  'admin.sessions.list': Operation<Page & { principal?: string | null }, { items: Session[]; next?: string | null }>;
  'admin.sessions.snapshot': Operation<{ sessionId: string }, Session>;
  'admin.sessions.remove': Operation<{ sessionId: string }, null>;
  'admin.sessions.reassignPrincipal': Operation<SessionRef, null>;
  'admin.audit.read': Operation<Page & { query?: { sessionId?: string | null; principal?: string | null; since?: string | null; until?: string | null; incidentsOnly?: boolean | null } | null },
    { records: Record<string, unknown>[]; nextCursor?: string | null }>;
  'host.create.prepare': Operation<{ createAttemptId: string; principal: string; input?: unknown }, null>;
  'host.create.commit': Operation<{ createAttemptId: string; sessionId: string }, null>;
  'host.create.abort': Operation<{ createAttemptId: string; reason: string }, { state: string; sessionId?: string | null }>;
  'host.create.status': Operation<{ createAttemptId: string }, { state: string; sessionId?: string | null }>;
}
export type Method = keyof Operations;
export type Request<M extends Method = Method> = M extends Method ? { jsonrpc: '2.0'; id: M extends `host.${string}` ? `r:${number}` : number; method: M; params: Operations[M]['params'] } : never;
export type Response<M extends Method> = { jsonrpc: '2.0'; id: number | `r:${number}`; result: Operations[M]['result'] };
export interface ErrorData { code: string; detail?: string | null; retryable?: boolean | null; }
export interface ErrorResponse { jsonrpc: '2.0'; id: number | `r:${number}` | null; error:
  { code: -32000; message: string; data: ErrorData } | { code: -32700 | -32600 | -32601 | -32602 | -32603; message: string; data?: ErrorData | null }; }
export type Notification = { jsonrpc: '2.0'; method: 'events.event'; params: { subscriptionId: string; event: Event } }
  | { jsonrpc: '2.0'; method: '$/cancel'; params: { id: number | `r:${number}` } }
  | { jsonrpc: '2.0'; method: 'runtime.heartbeat'; params: Record<string, never> }
  | { jsonrpc: '2.0'; method: 'runtime.protocolError'; params: { code: string } };

// Explicit protocol routing contract for browser-facing integrations. The stdio
// parent is trusted and can use admin methods; a browser bridge cannot use this
// table to forward admin, host callbacks, or runtime initialization.
export const browserMethods = [
  'sessions.create', 'sessions.list', 'sessions.get', 'sessions.end', 'sessions.remove',
  'turns.send', 'turns.interrupt', 'permissions.respond', 'events.subscribe', 'events.unsubscribe', 'events.credit', 'events.read', 'events.append',
  'toolOutput.read', 'attachments.begin', 'attachments.write', 'attachments.commit', 'attachments.abort', 'attachments.read',
  'providers.list', 'providers.refresh', 'checkpoints.list', 'checkpoints.restore',
] as const satisfies readonly Method[];
