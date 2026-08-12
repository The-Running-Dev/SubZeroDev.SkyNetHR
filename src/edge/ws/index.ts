import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { CallId, Envelope, SessionId, Seq, Subscription, TurnId } from '../../contract/index.js';
import { sendError } from '../error-envelope/index.js';
import {
  type EdgeDeps,
  apiErrorFor,
  createHttpHandlers,
  failWith,
  headerValue,
  isMutating,
  originAllowed,
  resolveOperator,
  sendJson,
  serveStatic,
} from '../http-common/index.js';

/**
 * `createWsEdge`'s return value is exactly a `RequestListener` (`20-contract.md § edge/sse
 * and edge/ws`) to every caller that only calls it as one. This is the implementation-only
 * extension `server.ts` reads off to wire `http.Server`'s `'upgrade'` event, which a bare
 * `RequestListener` is never given — D117.
 */
export interface WsRequestListener extends RequestListener {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

// S11.5, `20-contract.md § How the client learns which edge is live`: the tag is "set by
// whichever edge serves the document" — both edges inject it. No `<head>` element to
// insert before — the document has no explicit `<head>` or `<body>` tags at all — so the
// tag lands right after the charset declaration, which every version of this file has
// opened with.
function stampEdgeTag(html: string): string {
  return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="skynet-edge" content="ws">');
}

// RFC 6455 §1.3.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
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

// Matches `readBody`'s HTTP body cap. This edge only ever expects a small `{after: N}`
// first message plus ping/pong/close control frames — nothing legitimate approaches this —
// so a connection that buffers past it is dribbling an oversized frame rather than making
// progress, and is closed rather than left to grow the process's memory without bound.
const MAX_BUFFERED_FRAME_BYTES = 1024 * 1024;

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
    // RFC 6455 §5.1: a server MUST close the connection upon receiving a frame that is not
    // masked. Every legitimate client frame carries a mask key; one that doesn't is either
    // a broken client or an intermediary the masking requirement exists to defend against.
    if (maskKey === null) throw new Error('unmasked client frame');
    const rawPayload = buf.subarray(cursor, cursor + payloadLen);
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = rawPayload[i]! ^ maskKey[i % 4]!;
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

  const {
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
  } = createHttpHandlers(deps);

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

  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
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
      // `Number.isInteger`, not just `isFinite`: SSE's equivalent (`Last-Event-ID`) is
      // always an integer via `Number.parseInt`, and `Seq`/ring-buffer lookups downstream
      // are keyed on integers — a fractional `after` must not reach `manager.subscribe`
      // with different rounding behaviour than the SSE path's.
      const after = (typeof afterRaw === 'number' && Number.isInteger(afterRaw) && afterRaw > 0 ? afterRaw : 0) as Seq | 0;

      // S11.3: first-message auth resolves the same `OperatorId` as the SSE edge, from the
      // same credentials — the handshake's own headers/cookies, not a second token scheme.
      const resolved = identity({
        headers: req.headers as Readonly<Record<string, string | readonly string[] | undefined>>,
        remoteAddress: req.socket.remoteAddress ?? '',
      });
      if (!resolved.ok) {
        if (resolved.error.code === 'untrusted_proxy') {
          console.warn(
            `[identity] rejected an identity header from an untrusted peer: ${resolved.error.remoteAddress}`,
          );
        }
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

    function onData(chunk: Buffer): void {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_BUFFERED_FRAME_BYTES) {
        return writeCloseFrame(socket, 1009, 'message too big');
      }
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
          onFirstMessage(frame.payload).catch((err: unknown) => {
            console.warn(`[ws] onFirstMessage failed: ${(err as Error).message}`);
            teardown();
            if (open) writeCloseFrame(socket, 1011, 'internal error');
          });
        }
        // A second and later text frame carries nothing this edge reads: `after` is only
        // meaningful once, at subscribe time.
      }
    }

    socket.on('data', onData);
    // Node's `'upgrade'` event hands back any bytes its HTTP parser already read off the
    // socket past the handshake request — `head` — before this handler ever attaches a
    // `'data'` listener. A client (or proxy) that pipelines its first WS frame in the same
    // TCP segment as the handshake would have that frame silently dropped otherwise.
    if (head.length > 0) onData(head);
  }

  const listener: WsRequestListener = function listener(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const pathname = url.pathname;

        if (method === 'GET' && (await serveStatic(pathname, res, stampEdgeTag))) return;

        if (!pathname.startsWith('/api/')) {
          return sendError(res, 'no_such_session', 'no such route');
        }

        if (isMutating(method) && !originAllowed(req, config.allowedOrigins)) {
          return sendError(res, 'bad_origin', 'origin is not allowed');
        }

        if (method === 'POST' && pathname === '/api/login') return handleLogin(req, res);

        const owner = resolveOperator(req, res, identity);
        if (owner === null) return;

        if (method === 'GET' && pathname === '/api/sessions') {
          return sendJson(res, 200, { sessions: manager.list(owner) });
        }
        if (method === 'POST' && pathname === '/api/sessions') {
          return handleCreate(req, res, owner);
        }
        if (method === 'GET' && pathname === '/api/audit') {
          return handleAudit(req, res);
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
