import { readFile } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type {
  ApiErrorCode,
  Config,
  Envelope,
  IdentityResolver,
  OperatorId,
  Records,
  Seq,
  SessionError,
  SessionId,
  SessionManager,
  Subscription,
  TurnId,
} from '../../contract/index.js';

interface EdgeDeps {
  readonly config: Config;
  readonly identity: IdentityResolver;
  readonly manager: SessionManager;
  readonly records: Records;
}

// The browser's own `EventSource` reconnect delay. Independent of `caps.keepaliveMs`,
// which paces the heartbeat comment, not the client's retry backoff — conflating the two
// would make a keepalive tuned for a proxy's idle timeout silently slow every reconnect.
const SSE_RETRY_MS = 2000;

// `10-design.md § Security controls`, verbatim. Served on the document only.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

// A fixed map rather than a path join: there is no traversal to defend against if no
// caller-supplied string ever reaches the filesystem.
const STATIC: ReadonlyMap<string, { readonly file: string; readonly type: string }> = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/render.js', { file: 'render.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);

const CLIENT_DIR = new URL('../../../client/', import.meta.url);

const STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  bad_origin: 403,
  no_such_session: 404,
  no_such_output: 404,
  no_such_checkpoint: 404,
  turn_in_flight: 409,
  session_ended: 409,
  workspace_busy: 409,
  outside_workspace_root: 409,
  bad_request: 422,
  checkpoint_failed: 500,
  agent_unavailable: 503,
  no_such_requisition: 404,
  requisition_not_approved: 409,
  requisition_consumed: 409,
  already_decided: 409,
  no_such_review: 404,
  review_final: 409,
  no_such_item: 404,
  record_write_failed: 500,
  payroll_unavailable: 500,
};

function sendError(res: ServerResponse, code: ApiErrorCode, message: string, detail?: unknown): void {
  const body = JSON.stringify({ error: detail === undefined ? { code, message } : { code, message, detail } });
  res.writeHead(STATUS_FOR[code], { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/**
 * `SessionError` is the manager's vocabulary; `ApiErrorCode` is the wire's. Every arm is
 * spelled out rather than defaulted, so a variant added to the contract is a compile error
 * here instead of a silent 500.
 */
function apiErrorFor(error: SessionError): { code: ApiErrorCode; message: string; detail?: unknown } {
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
      return { code: 'checkpoint_failed', message: 'a checkpoint operation failed' };
    case 'storage':
      return { code: 'agent_unavailable', message: 'session storage is unavailable' };
    case 'records':
      return { code: 'record_write_failed', message: 'a record-log write failed' };
  }
}

function failWith(res: ServerResponse, error: SessionError): void {
  const api = apiErrorFor(error);
  sendError(res, api.code, api.message, api.detail);
}

async function readBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<string | null> {
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

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

/**
 * `10-design.md § Security controls`: a mutating request is accepted only when its
 * `Origin` is on the allow-list, or when the browser states `Sec-Fetch-Site: same-origin`.
 * Nothing else — a missing `Origin` gets no partial credit.
 */
function originAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  if (headerValue(req, 'sec-fetch-site') === 'same-origin') return true;
  const origin = headerValue(req, 'origin');
  return origin !== undefined && allowed.includes(origin);
}

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const same = left.length === right.length;
  return timingSafeEqual(left, same ? right : left) && same;
}

export function createSseEdge(deps: EdgeDeps): RequestListener {
  const { config, identity, manager } = deps;
  void deps.records; // tier two composes through it (D77); nothing in this slice reads it.

  async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const entry = STATIC.get(pathname);
    if (entry === undefined) return false;
    let body: Buffer;
    try {
      body = await readFile(new URL(entry.file, CLIENT_DIR));
    } catch {
      sendError(res, 'no_such_output', 'client asset missing');
      return true;
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

  function resolveOperator(req: IncomingMessage, res: ServerResponse): OperatorId | null {
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
    // D94: a tier-two field is refused, never accepted and ignored. Accepting it would
    // silently drop the approval a requisition represents.
    if (body['requisitionId'] !== undefined && body['requisitionId'] !== null) {
      return sendError(res, 'bad_request', 'requisitions are not available in this build', { field: 'requisitionId' });
    }

    const created = await manager.create(owner, {
      vendor: body['vendor'] as never,
      cwd: body['cwd'],
      model: model as string | null,
      sandbox: sandbox as never,
      requisitionId: null,
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

  async function handleEvents(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    const lastEventId = headerValue(req, 'last-event-id');
    const parsedAfter = lastEventId === undefined ? 0 : Number.parseInt(lastEventId, 10);
    const after = (Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0) as Seq | 0;

    // Ownership and existence are settled before any byte goes out, because after the
    // 200 there is no status code left to say `no_such_session` with. This is the order
    // `10-design.md § Reconnect and replay` draws: identity and `get`, then replay.
    const known = manager.get(sessionId, owner);
    if (!known.ok) return failWith(res, known.error);

    let open = true;
    let subscription: Subscription | null = null;
    let keepalive: NodeJS.Timeout | null = null;

    // Registered *before* the subscribe below, which since S3 replays the whole spill and
    // can therefore take arbitrarily long. A client that gives up mid-replay emits
    // `close` during that window, and a listener attached afterwards would never see it —
    // leaving the subscriber registered on the session for its whole life, fed every
    // later envelope through a destroyed socket.
    const teardown = (): void => {
      open = false;
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
      if (subscription !== null) {
        subscription.close();
        subscription = null;
      }
    };
    req.on('close', teardown);
    res.on('close', teardown);

    // Headers first, so the replay streams to the socket as it is read rather than
    // accumulating in this process: a session whose spill holds the whole of a long turn
    // is exactly the case S3 exists for, and it must not be buffered here in its
    // entirety before the browser sees a single byte.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer the stream; without it a proxied console shows nothing
      // until the response is large enough to flush.
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders();
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    keepalive = setInterval(() => {
      if (open) res.write(': keepalive\n\n');
    }, config.caps.keepaliveMs);
    // The heartbeat should not be a reason for the process to stay alive; the open socket
    // already is one.
    keepalive.unref();

    // `id:` is what a browser `EventSource` sends back as `Last-Event-ID`, so it may only
    // ever advance past what this connection has actually delivered. A `replay_gap`
    // restates the watermark the client is complete through rather than carrying a new
    // position (`session-manager.subscribe`), so it never writes one.
    //
    // The floor is `after`, not zero: a connection that reports a gap before delivering
    // anything would otherwise stamp the gap's seq as the resume point, and the next
    // reconnect would start past the history this one failed to serve.
    let lastIdWritten = after as number;
    const sink = {
      deliver(envelope: Envelope): void {
        if (!open) return;
        // `event:` is the kind and `id:` is the seq, so a browser `EventSource` can
        // dispatch by kind and resume by seq with no body parsing. `data:` is one line:
        // `JSON.stringify` never emits a raw newline, so no continuation is possible.
        const advances = envelope.seq > lastIdWritten;
        if (advances) lastIdWritten = envelope.seq;
        const id = advances ? `id: ${envelope.seq}\n` : '';
        res.write(`${id}event: ${envelope.kind}\ndata: ${JSON.stringify(envelope)}\n\n`);
      },
      close(): void {
        if (!open) return;
        open = false;
        res.end();
      },
    };

    const subscribed = await manager.subscribe(sessionId, owner, after, sink);
    if (!subscribed.ok) {
      // The `get` above already passed, so this is a session removed underneath us. The
      // status line is long gone; ending the stream is the only honest signal left, and
      // the client's reconnect gets the real error from the route.
      teardown();
      if (!res.writableEnded) res.end();
      return;
    }
    subscription = subscribed.value;
    // The client may have left while the replay ran, in which case `teardown` already
    // fired with nothing to close.
    if (!open) subscription.close();
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
      'Max-Age=2592000',
    ];
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': attributes.join('; '),
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify({ ok: true }));
  }

  return function listener(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const pathname = url.pathname;

        if (method === 'GET' && (await serveStatic(pathname, res))) return;

        if (!pathname.startsWith('/api/')) {
          return sendError(res, 'no_such_session', 'no such route');
        }

        // Origin before identity (I24): a request that should not have been made does not
        // deserve a lookup, and answering 401 here would tell a cross-origin page whether
        // its victim was signed in.
        if (isMutating(method) && !originAllowed(req, config.allowedOrigins)) {
          return sendError(res, 'bad_origin', 'origin is not allowed');
        }

        // The login exchange is what mints the credential, so it cannot require one.
        if (method === 'POST' && pathname === '/api/login') return handleLogin(req, res);

        const owner = resolveOperator(req, res);
        if (owner === null) return;

        if (method === 'GET' && pathname === '/api/sessions') {
          return sendJson(res, 200, { sessions: manager.list(owner) });
        }
        if (method === 'POST' && pathname === '/api/sessions') {
          return handleCreate(req, res, owner);
        }

        const sessionRoute = /^\/api\/sessions\/([^/]+)(\/[^?]*)?$/.exec(pathname);
        if (sessionRoute !== null) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(sessionRoute[1]!);
          } catch {
            return sendError(res, 'bad_request', 'session id is not a valid path segment', { field: 'sessionId' });
          }
          const sessionId = decoded as SessionId;
          const rest = sessionRoute[2] ?? '';
          if (method === 'POST' && rest === '/message') return handleMessage(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/permission') return handlePermission(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/interrupt') return handleInterrupt(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/end') return handleEnd(req, res, owner, sessionId);
          if (method === 'DELETE' && rest === '') return handleDelete(req, res, owner, sessionId);
          if (method === 'GET' && rest === '/events') return handleEvents(req, res, owner, sessionId);
          if (method === 'GET' && rest === '') {
            const got = manager.get(sessionId, owner);
            return got.ok ? sendJson(res, 200, { session: got.value }) : failWith(res, got.error);
          }
          // Every other route under a session id belongs to a later slice. It is refused
          // rather than 404'd against the session, so a client cannot read the refusal as
          // "this session does not exist".
          return sendError(res, 'bad_request', 'that route is not available in this build', { field: rest || '/' });
        }

        return sendError(res, 'bad_request', 'that route is not available in this build', { field: pathname });
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 'agent_unavailable', `unhandled edge failure: ${(err as Error).message}`);
        } else {
          res.end();
        }
      }
    })();
  };
}
