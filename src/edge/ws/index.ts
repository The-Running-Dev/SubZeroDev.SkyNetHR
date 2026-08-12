import { readFile } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ApiErrorCode,
  CallId,
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
import { sendError } from '../error-envelope/index.js';

interface EdgeDeps {
  readonly config: Config;
  readonly identity: IdentityResolver;
  readonly manager: SessionManager;
  readonly records: Records;
}

/**
 * `createWsEdge`'s return value is exactly a `RequestListener` (`20-contract.md § edge/sse
 * and edge/ws`) to every caller that only calls it as one. This is the implementation-only
 * extension `server.ts` reads off to wire `http.Server`'s `'upgrade'` event, which a bare
 * `RequestListener` is never given — D117.
 */
export interface WsRequestListener extends RequestListener {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

// `10-design.md § Security controls`, verbatim. Served on the document only.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const STATIC: ReadonlyMap<string, { readonly file: string; readonly type: string }> = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/render.js', { file: 'render.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);

const CLIENT_DIR = new URL('../../../client/', import.meta.url);

// RFC 6455 §1.3.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** Identical to `edge/sse`'s mapping — the two edges are separate modules by design (D10,
 * `10-design.md § Module boundaries`) and neither depends on the other, so the mapping is
 * duplicated rather than shared. */
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
      return error.cause.code === 'no_such_checkpoint'
        ? { code: 'no_such_checkpoint', message: 'no such checkpoint', detail: { sha: error.cause.sha } }
        : { code: 'checkpoint_failed', message: 'a checkpoint operation failed' };
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

/** `10-design.md § Security controls` — identical rule to `edge/sse`'s. */
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

// ---------------------------------------------------------------------------
// Minimal RFC 6455 frame codec — text frames only, no extensions, no
// fragmentation. Client frames are masked (RFC 6455 §5.3) and must be
// unmasked; server frames (`writeFrame`) are sent unmasked, as the RFC
// requires.
// ---------------------------------------------------------------------------

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Parses as many complete frames as `buf` holds; returns the frames found and the number of
 * leading bytes they consumed. A trailing partial frame is left for the next chunk. */
function parseFrames(buf: Buffer): { frames: ParsedFrame[]; consumed: number } {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const byte0 = buf[offset]!;
    const byte1 = buf[offset + 1]!;
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (buf.length - cursor < 2) break;
      payloadLen = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (buf.length - cursor < 8) break;
      const big = buf.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
      payloadLen = Number(big);
      cursor += 8;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length - cursor < 4) break;
      maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (buf.length - cursor < payloadLen) break;
    const rawPayload = buf.subarray(cursor, cursor + payloadLen);
    const payload = Buffer.alloc(payloadLen);
    if (maskKey !== null) {
      for (let i = 0; i < payloadLen; i++) payload[i] = rawPayload[i]! ^ maskKey[i % 4]!;
    } else {
      rawPayload.copy(payload);
    }
    cursor += payloadLen;

    frames.push({ fin, opcode, payload });
    offset = cursor;
  }
  return { frames, consumed: offset };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function writeTextFrame(socket: Socket, text: string): void {
  if (socket.writable) socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
}

function writeCloseFrame(socket: Socket, code: number, reason: string): void {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2, 'utf8');
  if (socket.writable) socket.write(encodeFrame(OPCODE_CLOSE, payload));
  socket.end();
}

// ---------------------------------------------------------------------------

export function createWsEdge(deps: EdgeDeps): WsRequestListener {
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
    // S11.5: the client learns which edge is live from the served page rather than by
    // probing. A `<meta>` tag, not a `<script>`, so the strict CSP (`script-src 'self'`,
    // no `unsafe-inline`) costs nothing.
    if (entry.file === 'index.html') {
      // No `<head>` element to insert before — the document has no explicit `<head>` or
      // `<body>` tags at all — so the tag lands right after the charset declaration,
      // which every version of this file has opened with.
      body = Buffer.from(
        body.toString('utf8').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="skynet-edge" content="ws">'),
        'utf8',
      );
    }
    const headers: Record<string, string> = {
      'content-type': entry.type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };
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
    await readBody(req);
    const ended = await manager.end(sessionId, owner);
    if (!ended.ok) return failWith(res, ended.error);
    sendJson(res, 200, { ok: true });
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse, owner: OperatorId, sessionId: SessionId): Promise<void> {
    await readBody(req);
    const removed = await manager.remove(sessionId, owner);
    if (!removed.ok) return failWith(res, removed.error);
    sendJson(res, 200, { ok: true });
  }

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

  // -------------------------------------------------------------------------
  // The WebSocket edge for `GET /api/sessions/:id/events` (S11).
  // -------------------------------------------------------------------------

  const EVENTS_ROUTE = /^\/api\/sessions\/([^/]+)\/events$/;

  function rejectUpgrade(socket: Socket, status: number, reason: string): void {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    socket.destroy();
  }

  function handleUpgrade(req: IncomingMessage, socket: Socket, _head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const match = EVENTS_ROUTE.exec(url.pathname);
    if (match === null) return rejectUpgrade(socket, 404, 'Not Found');

    // I24: the origin allow-list is applied at the handshake, before any frame is read —
    // and before the handshake itself completes, so a disallowed `Origin` never gets a
    // socket at all (S11.2).
    if (!originAllowed(req, config.allowedOrigins)) return rejectUpgrade(socket, 403, 'Forbidden');

    if ((headerValue(req, 'upgrade') ?? '').toLowerCase() !== 'websocket') {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const key = headerValue(req, 'sec-websocket-key');
    if (key === undefined) return rejectUpgrade(socket, 400, 'Bad Request');

    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]!);
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const sessionId = decoded as SessionId;

    const accept = computeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let open = true;
    let subscription: Subscription | null = null;
    let keepalive: NodeJS.Timeout | null = null;
    let buffered: Buffer = Buffer.alloc(0);
    let authed = false;

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

    socket.on('close', teardown);
    socket.on('error', teardown);

    // `id` is never written back to a `WebSocket` — unlike `EventSource`, it carries no
    // implicit resume header, so the client's `after` is the only source of the resume
    // point on any given connection (S11.4).
    const sink = {
      deliver(envelope: Envelope): void {
        if (!open) return;
        writeTextFrame(socket, JSON.stringify(envelope));
      },
      close(): void {
        if (!open) return;
        open = false;
        writeCloseFrame(socket, 1000, 'session ended');
      },
    };

    async function onFirstMessage(payload: Buffer): Promise<void> {
      authed = true;
      let request: { after?: unknown };
      try {
        request = JSON.parse(payload.toString('utf8')) as { after?: unknown };
      } catch {
        writeTextFrame(socket, JSON.stringify({ type: 'error', error: { code: 'bad_request', message: 'first message must be JSON' } }));
        return writeCloseFrame(socket, 1002, 'bad first message');
      }
      const afterRaw = request.after;
      const after = (typeof afterRaw === 'number' && Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0) as Seq | 0;

      // S11.3: first-message auth resolves the same `OperatorId` as the SSE edge, from the
      // same credentials — the handshake's own headers/cookies, not a second token scheme.
      const resolved = identity({
        headers: req.headers as Readonly<Record<string, string | readonly string[] | undefined>>,
        remoteAddress: req.socket.remoteAddress ?? '',
      });
      if (!resolved.ok) {
        writeTextFrame(socket, JSON.stringify({ type: 'error', error: { code: 'unauthenticated', message: 'no usable identity' } }));
        return writeCloseFrame(socket, 4401, 'unauthenticated');
      }
      const owner = resolved.value;

      const known = manager.get(sessionId, owner);
      if (!known.ok) {
        const api = apiErrorFor(known.error);
        writeTextFrame(socket, JSON.stringify({ type: 'error', error: { code: api.code, message: api.message } }));
        return writeCloseFrame(socket, 4404, api.code);
      }

      keepalive = setInterval(() => {
        if (open && socket.writable) socket.write(encodeFrame(OPCODE_PING, Buffer.alloc(0)));
      }, config.caps.keepaliveMs);
      keepalive.unref();

      const subscribed = await manager.subscribe(sessionId, owner, after, sink);
      if (!subscribed.ok) {
        teardown();
        if (open) writeCloseFrame(socket, 1011, 'session removed');
        return;
      }
      subscription = subscribed.value;
      if (!open) subscription.close();
    }

    socket.on('data', (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      let parsed: { frames: ParsedFrame[]; consumed: number };
      try {
        parsed = parseFrames(buffered);
      } catch {
        return writeCloseFrame(socket, 1002, 'protocol error');
      }
      buffered = buffered.subarray(parsed.consumed);

      for (const frame of parsed.frames) {
        if (frame.opcode === OPCODE_CLOSE) {
          teardown();
          writeCloseFrame(socket, 1000, 'bye');
          return;
        }
        if (frame.opcode === OPCODE_PING) {
          if (socket.writable) socket.write(encodeFrame(OPCODE_PONG, frame.payload));
          continue;
        }
        if (frame.opcode === OPCODE_PONG) continue;
        if (frame.opcode === OPCODE_CONTINUATION) continue; // no fragmentation support
        if (!frame.fin) {
          writeCloseFrame(socket, 1003, 'fragmentation not supported');
          return;
        }
        if (!authed) {
          void onFirstMessage(frame.payload);
        }
        // A second and later text frame carries nothing this edge reads: `after` is only
        // meaningful once, at subscribe time.
      }
    });
  }

  const listener: WsRequestListener = function listener(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const pathname = url.pathname;

        if (method === 'GET' && (await serveStatic(pathname, res))) return;

        if (!pathname.startsWith('/api/')) {
          return sendError(res, 'no_such_session', 'no such route');
        }

        if (isMutating(method) && !originAllowed(req, config.allowedOrigins)) {
          return sendError(res, 'bad_origin', 'origin is not allowed');
        }

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
          if (method === 'POST' && rest === '/checkpoint/restore') return handleCheckpointRestore(req, res, owner, sessionId);
          if (method === 'DELETE' && rest === '') return handleDelete(req, res, owner, sessionId);
          // This edge's `/events` runs on the `'upgrade'` event, not the request path —
          // a plain GET here is a client that failed to upgrade, not a route that exists.
          if (method === 'GET' && rest === '/events') {
            return sendError(res, 'bad_request', 'this edge serves events over a WebSocket upgrade, not a plain GET', { field: 'upgrade' });
          }
          if (method === 'GET' && rest === '/checkpoints') return handleListCheckpoints(req, res, owner, sessionId);
          const toolOutputMatch = /^\/tool-output\/([^/]+)\/([^/]+)$/.exec(rest);
          if (method === 'GET' && toolOutputMatch) {
            let decodedTurnId: string;
            try {
              decodedTurnId = decodeURIComponent(toolOutputMatch[1]!);
            } catch {
              return sendError(res, 'bad_request', 'turnId is not a valid path segment', { field: 'turnId' });
            }
            let decodedCallId: string;
            try {
              decodedCallId = decodeURIComponent(toolOutputMatch[2]!);
            } catch {
              return sendError(res, 'bad_request', 'callId is not a valid path segment', { field: 'callId' });
            }
            return handleToolOutput(req, res, owner, sessionId, decodedTurnId as TurnId, decodedCallId as CallId);
          }
          if (method === 'GET' && rest === '') {
            const got = manager.get(sessionId, owner);
            return got.ok ? sendJson(res, 200, { session: got.value }) : failWith(res, got.error);
          }
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
  } as WsRequestListener;

  listener.handleUpgrade = handleUpgrade;
  return listener;
}
