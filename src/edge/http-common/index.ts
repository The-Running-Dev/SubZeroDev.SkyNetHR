import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ApiErrorCode,
  AuditCursor,
  AuditQuery,
  CallId,
  ChecklistItemId,
  EdgeDeps,
  IdentityResolver,
  IsoTimestamp,
  OperatorId,
  Rating,
  RecordsError,
  RequisitionId,
  ReviewId,
  SessionError,
  SessionId,
  TurnId,
  Vendor,
} from '../../contract/index.js';
import { sendError } from '../error-envelope/index.js';
import { VENDORS } from '../../adapters/index.js';

// D10 (`10-design.md § Module boundaries`) decided the two transport edges stay separate
// modules and neither imports the other — it did not forbid a third module both compose
// through. Everything here is transport-agnostic (no `Envelope`/SSE/WS framing), so one copy
// is what keeps `edge/sse` and `edge/ws` answering the same request the same way.

export type { EdgeDeps };

// `10-design.md § Security controls`, verbatim. Served on the document only.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

// A fixed map rather than a path join: there is no traversal to defend against if no
// caller-supplied string ever reaches the filesystem.
export const STATIC: ReadonlyMap<string, { readonly file: string; readonly type: string }> = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/render.js', { file: 'render.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);

export const CLIENT_DIR = new URL('../../../client/', import.meta.url);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/**
 * `SessionError` is the manager's vocabulary; `ApiErrorCode` is the wire's. Every arm is
 * spelled out rather than defaulted, so a variant added to the contract is a compile error
 * here instead of a silent 500.
 */
export function apiErrorFor(error: SessionError): { code: ApiErrorCode; message: string; detail?: unknown } {
  switch (error.code) {
    case 'no_such_session':
      return { code: 'no_such_session', message: 'no such session' };
    case 'session_ended':
      return { code: 'session_ended', message: 'the session has ended and accepts no new turn' };
    case 'turn_in_flight':
      return { code: 'turn_in_flight', message: 'a turn is already running', detail: { turnId: error.turnId } };
    case 'workspace_busy':
      return {
        code: 'workspace_busy',
        message: 'another live session holds this workspace',
        detail: { cwd: error.holder.cwd, owner: error.holder.owner },
      };
    case 'no_such_item':
      return { code: 'no_such_item', message: 'no such checklist item', detail: { itemId: error.itemId } };
    case 'bad_request':
      return { code: 'bad_request', message: error.detail, detail: { field: error.field } };
    case 'jail':
      return error.cause.code === 'outside_workspace_root'
        ? {
            code: 'outside_workspace_root',
            message: 'cwd is outside every configured workspace root',
            detail: { roots: error.cause.roots },
          }
        // `unresolvable` is a path that does not exist or cannot be canonicalised. That is
        // a malformed request rather than a containment failure, and saying
        // `outside_workspace_root` would tell the caller their path was rejected by the
        // jail when it was never resolved at all.
        : { code: 'bad_request', message: error.cause.detail, detail: { field: 'cwd' } };
    case 'adapter':
      switch (error.cause.code) {
        case 'unsupported_vendor':
          return { code: 'bad_request', message: 'unsupported vendor', detail: { field: 'vendor' } };
        case 'unsupported_sandbox':
          return { code: 'bad_request', message: 'unsupported sandbox for this vendor', detail: { field: 'sandbox' } };
        case 'agent_unavailable':
          return { code: 'agent_unavailable', message: error.cause.detail };
        default:
          return { code: 'agent_unavailable', message: `the agent failed: ${error.cause.code}` };
      }
    case 'checkpoint':
      // `20-contract.md`'s route table distinguishes an unknown `sha` (`404
      // no_such_checkpoint`) from every other checkpoint failure (`500
      // checkpoint_failed`); collapsing both to the same code would make a restore
      // against a typo'd sha indistinguishable from a git failure.
      return error.cause.code === 'no_such_checkpoint'
        ? { code: 'no_such_checkpoint', message: 'no such checkpoint', detail: { sha: error.cause.sha } }
        : { code: 'checkpoint_failed', message: 'a checkpoint operation failed' };
    case 'storage':
      return { code: 'agent_unavailable', message: 'session storage is unavailable' };
    case 'records':
      return recordsApiError(error.cause);
  }
}

/**
 * `RecordsError`'s own vocabulary, shared between `apiErrorFor`'s `'records'` arm (a
 * requisition claim failing during `session-manager.create`) and the requisition routes
 * below, which call `records` directly and never see a `SessionError`.
 */
export function recordsApiError(cause: RecordsError): { code: ApiErrorCode; message: string; detail?: unknown } {
  switch (cause.code) {
    case 'no_such_requisition':
      return { code: 'no_such_requisition', message: 'no such requisition', detail: { requisitionId: cause.requisitionId } };
    case 'already_decided':
      return {
        code: 'already_decided',
        message: 'this requisition has already been decided',
        detail: { requisitionId: cause.requisitionId, decidedBy: cause.decidedBy, state: cause.state },
      };
    case 'requisition_not_approved':
      return {
        code: 'requisition_not_approved',
        message: 'this requisition is not approved',
        detail: { requisitionId: cause.requisitionId, state: cause.state },
      };
    case 'requisition_consumed':
      return {
        code: 'requisition_consumed',
        message: 'this requisition has already been spent',
        detail: { requisitionId: cause.requisitionId, sessionId: cause.sessionId },
      };
    case 'no_such_review':
      return { code: 'no_such_review', message: 'no such review', detail: { reviewId: cause.reviewId } };
    case 'review_final':
      return { code: 'review_final', message: 'this review is already final', detail: { reviewId: cause.reviewId } };
    case 'bad_request':
      return { code: 'bad_request', message: cause.detail, detail: { field: cause.field } };
    case 'storage':
      return { code: 'record_write_failed', message: 'a record-log write failed' };
  }
}

export function failWith(res: ServerResponse, error: SessionError): void {
  const api = apiErrorFor(error);
  sendError(res, api.code, api.message, api.detail);
}

export async function readBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

/**
 * `10-design.md § Security controls`: a mutating request is accepted only when its
 * `Origin` is on the allow-list, or when the browser states `Sec-Fetch-Site: same-origin`.
 * Nothing else — a missing `Origin` gets no partial credit.
 */
export function originAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  if (headerValue(req, 'sec-fetch-site') === 'same-origin') return true;
  const origin = headerValue(req, 'origin');
  return origin !== undefined && allowed.includes(origin);
}

export function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

// `contract/index.ts`'s `IsoTimestamp` brand: "ISO 8601, UTC, millisecond precision, `Z`
// suffix". `handleAudit`'s `since`/`until` are the one place an `IsoTimestamp` is minted
// from caller input rather than the server's own clock, so this is the one place that shape
// is checked rather than assumed.
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseIsoTimestamp(value: string): string | null {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

// Kept identical to `store`'s `macEquals` by hand — the two modules cannot share a runtime
// helper (`store` depends only on `config`/`contract`; `contract` is types-only) but both
// compare a caller-supplied secret in constant time, so the technique must not drift between
// them even though the code does. Keep both in sync if either changes.
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const same = left.length === right.length;
  return timingSafeEqual(left, same ? right : left) && same;
}

/**
 * Serves a static client asset. `transformIndexHtml`, when given, runs only on
 * `index.html` — this is `edge/sse`'s and `edge/ws`'s one real difference in this path
 * (S11.5: each edge stamps its own `<meta name="skynet-edge">` tag on the document it
 * serves).
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  transformIndexHtml?: (html: string) => string,
): Promise<boolean> {
  const entry = STATIC.get(pathname);
  if (entry === undefined) return false;
  let body: Buffer;
  try {
    body = await readFile(new URL(entry.file, CLIENT_DIR));
  } catch {
    sendError(res, 'no_such_output', 'client asset missing');
    return true;
  }
  if (entry.file === 'index.html' && transformIndexHtml !== undefined) {
    body = Buffer.from(transformIndexHtml(body.toString('utf8')), 'utf8');
  }
  const headers: Record<string, string> = {
    'content-type': entry.type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
  // The CSP governs the document. Sending it on the subresources too would be noise —
  // they are already constrained by the document that loaded them.
  if (entry.file === 'index.html') {
    headers['content-security-policy'] = CSP;
    headers['referrer-policy'] = 'no-referrer';
  }
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

export function resolveOperator(req: IncomingMessage, res: ServerResponse, identity: IdentityResolver): OperatorId | null {
  const resolved = identity({
    headers: req.headers as Readonly<Record<string, string | readonly string[] | undefined>>,
    remoteAddress: req.socket.remoteAddress ?? '',
  });
  if (resolved.ok) return resolved.value;
  if (resolved.error.code === 'untrusted_proxy') {
    // The address is logged because this is the case that says someone tried to set an
    // identity header from somewhere the deployment does not trust.
    console.warn(
      `[identity] rejected an identity header from an untrusted peer: ${resolved.error.remoteAddress}`,
    );
  }
  sendError(res, 'unauthenticated', 'no usable identity');
  return null;
}

/**
 * Every REST handler except `/events` — that route is the one place `edge/sse` and
 * `edge/ws` genuinely diverge (a `text/event-stream` response vs. a WebSocket upgrade), so
 * each edge keeps its own. Everything here is pure JSON-in/JSON-out over `manager`/`config`.
 */
export function createHttpHandlers(deps: EdgeDeps) {
  const { config, manager } = deps;

  async function handleCreate(req: IncomingMessage, res: ServerResponse, owner: OperatorId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return sendError(res, 'bad_request', 'body must be an object', { field: 'body' });
    }
    const body = parsed as Record<string, unknown>;

    if (typeof body['cwd'] !== 'string' || body['cwd'].trim() === '') {
      return sendError(res, 'bad_request', 'cwd is required', { field: 'cwd' });
    }
    if (typeof body['vendor'] !== 'string') {
      return sendError(res, 'bad_request', 'vendor is required', { field: 'vendor' });
    }
    const model = body['model'] ?? null;
    if (model !== null && typeof model !== 'string') {
      return sendError(res, 'bad_request', 'model must be a string or null', { field: 'model' });
    }
    const sandbox = body['sandbox'] ?? null;
    if (sandbox !== null && typeof sandbox !== 'string') {
      return sendError(res, 'bad_request', 'sandbox must be a string or null', { field: 'sandbox' });
    }
    // S13.10: absent is the ordinary case and behaves exactly as it did before this field
    // existed — a requisition is a second way in, never a gate (D68). An empty string is
    // absent too, not an id to look up.
    const requisitionId = body['requisitionId'] === '' ? null : (body['requisitionId'] ?? null);
    if (requisitionId !== null && typeof requisitionId !== 'string') {
      return sendError(res, 'bad_request', 'requisitionId must be a string or null', { field: 'requisitionId' });
    }

    const created = await manager.create(owner, {
      vendor: body['vendor'] as never,
      cwd: body['cwd'],
      model: model as string | null,
      sandbox: sandbox as never,
      requisitionId: requisitionId as RequisitionId | null,
    });
    if (!created.ok) return failWith(res, created.error);
    sendJson(res, 201, { sessionId: created.value.sessionId });
  }

  async function handleMessage(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    const text = (parsed as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text === '') {
      return sendError(res, 'bad_request', 'text is required', { field: 'text' });
    }
    const sent = await manager.message(sessionId, owner, text);
    if (!sent.ok) return failWith(res, sent.error);
    sendJson(res, 202, { turnId: sent.value.turnId satisfies TurnId });
  }

  async function handlePermission(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return sendError(res, 'bad_request', 'body must be an object', { field: 'body' });
    }
    const body = parsed as Record<string, unknown>;

    if (typeof body['requestId'] !== 'string' || body['requestId'] === '') {
      return sendError(res, 'bad_request', 'requestId is required', { field: 'requestId' });
    }
    if (body['decision'] !== 'allow' && body['decision'] !== 'deny') {
      return sendError(res, 'bad_request', "decision must be 'allow' or 'deny'", { field: 'decision' });
    }
    if (body['scope'] !== 'once' && body['scope'] !== 'always') {
      return sendError(res, 'bad_request', "scope must be 'once' or 'always'", { field: 'scope' });
    }
    const rule = body['rule'] ?? null;
    if (rule !== null && typeof rule !== 'string') {
      return sendError(res, 'bad_request', 'rule must be a string or null', { field: 'rule' });
    }
    const reason = body['reason'] ?? null;
    if (reason !== null && typeof reason !== 'string') {
      return sendError(res, 'bad_request', 'reason must be a string or null', { field: 'reason' });
    }

    const answered = await manager.answerPermission(sessionId, owner, {
      requestId: body['requestId'] as never,
      decision: body['decision'],
      scope: body['scope'],
      rule: rule as never,
      reason: reason as string | null,
    });
    if (!answered.ok) return failWith(res, answered.error);
    sendJson(res, 200, { accepted: answered.value.accepted });
  }

  async function handleInterrupt(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    const turnId = (parsed as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId !== 'string' || turnId === '') {
      return sendError(res, 'bad_request', 'turnId is required', { field: 'turnId' });
    }
    const interrupted = await manager.interrupt(sessionId, owner, turnId as TurnId);
    if (!interrupted.ok) return failWith(res, interrupted.error);
    sendJson(res, 200, { ok: true });
  }

  async function handleEnd(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    await readBody(req); // drains the request; `{}` carries nothing to validate
    const ended = await manager.end(sessionId, owner);
    if (!ended.ok) return failWith(res, ended.error);
    sendJson(res, 200, { ok: true });
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    await readBody(req); // no request body defined for DELETE; drains it regardless
    const removed = await manager.remove(sessionId, owner);
    if (!removed.ok) return failWith(res, removed.error);
    sendJson(res, 200, { ok: true });
  }

  // S9.3: the ownership check is `openToolOutput`'s (`no_such_session`, indistinguishable
  // from a session that never existed); every other failure — a missing or unreadable
  // blob — is `no_such_output` (S9.5), which the generic `storage` mapping in
  // `apiErrorFor` does not produce, so this route maps it itself rather than routing
  // through `failWith`.
  async function handleToolOutput(
    req: IncomingMessage,
    res: ServerResponse,
    owner: OperatorId,
    sessionId: SessionId,
    turnId: TurnId,
    callId: CallId,
  ): Promise<void> {
    const opened = await manager.openToolOutput(sessionId, owner, turnId, callId);
    if (!opened.ok) {
      if (opened.error.code === 'no_such_session') return failWith(res, opened.error);
      return sendError(res, 'no_such_output', 'the tool-output blob is missing or unreadable');
    }
    const stream = opened.value;
    // `.pipe()` alone only unpipes on an early `res` close, it does not destroy `stream`
    // — without this, a client that aborts mid-download (the large-blob case this route
    // exists for) leaks the open file handle. `Store.openToolOutput` is typed to the
    // minimal `NodeJS.ReadableStream`, but every implementation hands back a real
    // `Readable` (an `fs.ReadStream`), which is what actually owns the file descriptor.
    if (stream instanceof Readable) req.on('close', () => stream.destroy());
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment',
    });
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  }

  // `GET /api/audit` (D73, D119): not session-scoped, open to every authenticated
  // operator (D70) — the route table declares only `401 unauthenticated` and
  // `422 bad_request` as refusals, so a storage failure falls back to the same
  // `503 agent_unavailable` `SessionError.storage` maps to elsewhere in this file.
  async function handleAudit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const params = url.searchParams;

    let limit = config.caps.auditPageMax;
    const limitRaw = params.get('limit');
    if (limitRaw !== null) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return sendError(res, 'bad_request', 'limit must be a positive integer', { field: 'limit' });
      }
      limit = Math.min(parsed, config.caps.auditPageMax);
    }

    const nonEmpty = (value: string | null): string | null => (value === null || value === '' ? null : value);

    const since = nonEmpty(params.get('since'));
    if (since !== null && parseIsoTimestamp(since) === null) {
      return sendError(res, 'bad_request', 'since must be an ISO 8601 UTC timestamp', { field: 'since' });
    }
    const until = nonEmpty(params.get('until'));
    if (until !== null && parseIsoTimestamp(until) === null) {
      return sendError(res, 'bad_request', 'until must be an ISO 8601 UTC timestamp', { field: 'until' });
    }

    const query: AuditQuery = {
      before: nonEmpty(params.get('before')) as AuditCursor | null,
      limit,
      sessionId: nonEmpty(params.get('sessionId')) as SessionId | null,
      operator: nonEmpty(params.get('operator')) as OperatorId | null,
      since: since as IsoTimestamp | null,
      until: until as IsoTimestamp | null,
      incidentsOnly: params.get('incidentsOnly') === 'true',
    };

    const result = await manager.readAudit(query);
    if (!result.ok) {
      if (result.error.code === 'corrupt') return sendError(res, 'bad_request', 'audit cursor is invalid', { field: 'before' });
      return sendError(res, 'agent_unavailable', 'audit storage is unavailable');
    }
    sendJson(res, 200, result.value);
  }

  // S13.2: `POST /api/requisitions` — `workspace` is stored as the caller's string with no
  // jail call and no refusal; caps and everything else are `records.raise`'s to enforce.
  async function handleRaiseRequisition(req: IncomingMessage, res: ServerResponse, owner: OperatorId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return sendError(res, 'bad_request', 'body must be an object', { field: 'body' });
    }
    const body = parsed as Record<string, unknown>;

    if (typeof body['title'] !== 'string' || body['title'] === '') {
      return sendError(res, 'bad_request', 'title is required', { field: 'title' });
    }
    if (typeof body['justification'] !== 'string' || body['justification'] === '') {
      return sendError(res, 'bad_request', 'justification is required', { field: 'justification' });
    }
    if (typeof body['workspace'] !== 'string' || body['workspace'] === '') {
      return sendError(res, 'bad_request', 'workspace is required', { field: 'workspace' });
    }
    if (typeof body['vendor'] !== 'string' || !VENDORS.includes(body['vendor'] as Vendor)) {
      return sendError(res, 'bad_request', 'vendor must be one of claude, codex', { field: 'vendor' });
    }

    const raised = await deps.records.raise(owner, {
      title: body['title'],
      justification: body['justification'],
      workspace: body['workspace'],
      vendor: body['vendor'] as Vendor,
    });
    if (!raised.ok) {
      const api = recordsApiError(raised.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 201, { requisition: raised.value });
  }

  // S13.3/D70: every authenticated operator, not scoped to the caller.
  function handleListRequisitions(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, { requisitions: deps.records.listRequisitions() });
  }

  async function handleDecideRequisition(req: IncomingMessage, res: ServerResponse, owner: OperatorId, requisitionId: RequisitionId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    const decision = (parsed as { decision?: unknown } | null)?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return sendError(res, 'bad_request', "decision must be 'approve' or 'reject'", { field: 'decision' });
    }

    // S13.5/D69: self-approval is permitted and recorded — `owner` is used unconditionally.
    const decided = await deps.records.decide(requisitionId, owner, decision);
    if (!decided.ok) {
      const api = recordsApiError(decided.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 200, { requisition: decided.value });
  }

  const RATINGS: readonly Rating[] = ['does_not_meet', 'meets_some', 'meets', 'exceeds', 'exceptional'];

  function parseRating(value: unknown): { ok: true; value: Rating | null } | { ok: false } {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (typeof value === 'string' && RATINGS.includes(value as Rating)) return { ok: true, value: value as Rating };
    return { ok: false };
  }

  // S15.2/D127: `POST /api/reviews` — the edge resolves the `SessionSnapshot` through
  // `manager.getSnapshotForReview` (no ownership check, D70) and hands it to `records`,
  // which never resolves a session itself (`## Unresolved` 5's boundary).
  async function handleCreateReview(req: IncomingMessage, res: ServerResponse, owner: OperatorId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return sendError(res, 'bad_request', 'body must be an object', { field: 'body' });
    }
    const body = parsed as Record<string, unknown>;

    if (typeof body['subject'] !== 'string' || body['subject'] === '') {
      return sendError(res, 'bad_request', 'subject is required', { field: 'subject' });
    }
    const rating = parseRating(body['rating']);
    if (!rating.ok) return sendError(res, 'bad_request', 'rating is not a recognised token', { field: 'rating' });
    if (typeof body['pip'] !== 'boolean') {
      return sendError(res, 'bad_request', 'pip must be a boolean', { field: 'pip' });
    }
    if (typeof body['body'] !== 'string') {
      return sendError(res, 'bad_request', 'body is required', { field: 'body' });
    }

    const subject = body['subject'] as SessionId;
    const snapshot = deps.manager.getSnapshotForReview(subject);
    if (snapshot === null) return sendError(res, 'no_such_session', 'no such session');

    const created = await deps.records.createReview(owner, snapshot, {
      subject,
      rating: rating.value,
      pip: body['pip'],
      body: body['body'],
    });
    if (!created.ok) {
      const api = recordsApiError(created.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 201, { review: created.value });
  }

  async function handleAppendReview(req: IncomingMessage, res: ServerResponse, owner: OperatorId, reviewId: ReviewId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return sendError(res, 'bad_request', 'body must be an object', { field: 'body' });
    }
    const body = parsed as Record<string, unknown>;

    const patch: { rating?: Rating | null; pip?: boolean; body?: string } = {};
    if ('rating' in body) {
      const rating = parseRating(body['rating']);
      if (!rating.ok) return sendError(res, 'bad_request', 'rating is not a recognised token', { field: 'rating' });
      patch.rating = rating.value;
    }
    if ('pip' in body) {
      if (typeof body['pip'] !== 'boolean') return sendError(res, 'bad_request', 'pip must be a boolean', { field: 'pip' });
      patch.pip = body['pip'];
    }
    if ('body' in body) {
      if (typeof body['body'] !== 'string') return sendError(res, 'bad_request', 'body must be a string', { field: 'body' });
      patch.body = body['body'];
    }

    const appended = await deps.records.appendReview(reviewId, owner, patch);
    if (!appended.ok) {
      const api = recordsApiError(appended.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 200, { review: appended.value });
  }

  async function handleFinaliseReview(req: IncomingMessage, res: ServerResponse, owner: OperatorId, reviewId: ReviewId): Promise<void> {
    await readBody(req); // drains the request; `{}` carries nothing to validate
    const finalised = await deps.records.finaliseReview(reviewId, owner);
    if (!finalised.ok) {
      const api = recordsApiError(finalised.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 200, { review: finalised.value });
  }

  // S15.4/D70: finals only, for every caller including a draft's own author — an author
  // reaches their draft through `GET /api/reviews/:id` instead.
  function handleListReviews(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const subject = url.searchParams.get('subject');
    if (subject === null || subject === '') {
      return sendError(res, 'bad_request', 'subject is required', { field: 'subject' });
    }
    sendJson(res, 200, { reviews: deps.records.listReviews(subject as SessionId) });
  }

  function handleGetReview(_req: IncomingMessage, res: ServerResponse, owner: OperatorId, reviewId: ReviewId): void {
    const got = deps.records.getReview(reviewId, owner);
    if (!got.ok) {
      const api = recordsApiError(got.error);
      return sendError(res, api.code, api.message, api.detail);
    }
    sendJson(res, 200, { review: got.value });
  }

  async function handleListCheckpoints(_req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const listed = await manager.listCheckpoints(sessionId, owner);
    if (!listed.ok) return failWith(res, listed.error);
    sendJson(res, 200, { checkpoints: listed.value });
  }

  async function handleCheckpointRestore(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    const sha = (parsed as { sha?: unknown } | null)?.sha;
    if (typeof sha !== 'string' || sha === '') {
      return sendError(res, 'bad_request', 'sha is required', { field: 'sha' });
    }
    const restored = await manager.restore(sessionId, owner, sha as never);
    if (!restored.ok) return failWith(res, restored.error);
    sendJson(res, 200, { ok: true });
  }

  async function handleChecklist(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const got = await manager.checklist(sessionId, owner);
    if (!got.ok) return failWith(res, got.error);
    sendJson(res, 200, { items: got.value });
  }

  async function handleTickChecklistItem(
    req: IncomingMessage,
    res: ServerResponse,
    owner: OperatorId,
    sessionId: SessionId,
    itemId: ChecklistItemId,
  ): Promise<void> {
    await readBody(req); // drains the request; `{}` carries nothing to validate
    const ticked = await manager.tickChecklistItem(sessionId, owner, itemId);
    if (!ticked.ok) return failWith(res, ticked.error);
    sendJson(res, 200, { ok: true });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.auth.mode !== 'shared-secret') {
      return sendError(res, 'no_such_session', 'no such route');
    }
    const raw = await readBody(req);
    if (raw === null) return sendError(res, 'bad_request', 'request body too large', { field: 'body' });
    let presented: unknown;
    try {
      presented = (JSON.parse(raw) as { secret?: unknown }).secret;
    } catch {
      return sendError(res, 'bad_request', 'body is not valid JSON', { field: 'body' });
    }
    if (typeof presented !== 'string' || !constantTimeEquals(presented, config.auth.secret)) {
      return sendError(res, 'unauthenticated', 'wrong secret');
    }
    // `SameSite=Strict; HttpOnly; Path=/` is defence in depth, not the control — the
    // origin check on every mutating route is (`10-design.md § Security controls`).
    const attributes = [
      `${config.auth.cookieName}=${encodeURIComponent(presented)}`,
      'SameSite=Strict',
      'HttpOnly',
      'Path=/',
      `Max-Age=${config.sessionCookieMaxAgeSeconds}`,
    ];
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': attributes.join('; '),
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify({ ok: true }));
  }

  return {
    handleCreate,
    handleMessage,
    handlePermission,
    handleInterrupt,
    handleEnd,
    handleDelete,
    handleToolOutput,
    handleListCheckpoints,
    handleCheckpointRestore,
    handleAudit,
    handleLogin,
    handleRaiseRequisition,
    handleListRequisitions,
    handleDecideRequisition,
    handleCreateReview,
    handleAppendReview,
    handleFinaliseReview,
    handleListReviews,
    handleGetReview,
    handleChecklist,
    handleTickChecklistItem,
  };
}
