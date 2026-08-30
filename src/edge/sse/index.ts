import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AttachmentId, CallId, ChecklistItemId, Envelope, Frame, OperatorId, RequisitionId, ReviewId, Seq, SessionId, Subscription, TurnId } from '../../contract/index.js';
import { isFrame } from '../../contract/index.js';
import { sendError } from '../error-envelope/index.js';
import {
  type EdgeDeps,
  createBackpressureGuard,
  createHttpHandlers,
  failWith,
  headerValue,
  isMutating,
  originAllowed,
  resolveOperator,
  sendJson,
  serveStatic,
} from '../http-common/index.js';

// The browser's own `EventSource` reconnect delay. Independent of `caps.keepaliveMs`,
// which paces the heartbeat comment, not the client's retry backoff — conflating the two
// would make a keepalive tuned for a proxy's idle timeout silently slow every reconnect.
const SSE_RETRY_MS = 2000;

// S11.5, `20-contract.md § How the client learns which edge is live`: the tag is "set by
// whichever edge serves the document" — both edges inject it, not just `edge/ws`. No
// `<head>` element to insert before — the document has no explicit `<head>` or `<body>`
// tags at all — so the tag lands right after the charset declaration, which every version
// of this file has opened with.
function stampEdgeTag(html: string): string {
  return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="skynet-edge" content="sse">');
}

// Decodes one `%`-escaped path segment; a malformed encoding sends the standard `400
// bad_request` naming `field` and returns `null` for the caller to bail out on — the one
// shape every route match below shares instead of each repeating its own try/catch.
function decodeSegment(res: ServerResponse, raw: string, label: string, field: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    sendError(res, 'bad_request', `${label} is not a valid path segment`, { field });
    return null;
  }
}

export function createSseEdge(deps: EdgeDeps): RequestListener {
  const { config, identity, manager } = deps;

  const {
    handleCreate,
    handleMessage,
    handlePermission,
    handleInterrupt,
    handleEnd,
    handleDelete,
    handleToolOutput,
    handleAttachment,
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
    handlePayroll,
  } = createHttpHandlers(deps);

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

    // (#133) A subscriber that stops draining its socket is dropped once the backlog
    // passes `caps.subscriberQueueHighWater`, with the same `replay_gap` shape
    // `session-manager.subscribe`'s own catch-up buffering already reports — the live half
    // that guard never covered. The gap frame itself bypasses the guard: the connection is
    // closing regardless of whether this last write flushes.
    const guardedWrite = createBackpressureGuard(res, config.caps.subscriberQueueHighWater, () => {
      if (!open) return;
      const gap: Envelope = {
        seq: lastIdWritten as Seq,
        sessionId,
        ts: new Date().toISOString() as never,
        kind: 'error',
        data: { kind: 'replay_gap', message: 'the subscriber fell too far behind to keep delivering live', fatal: false },
      } as Envelope;
      res.write(`id: ${lastIdWritten}\nevent: error\ndata: ${JSON.stringify(gap)}\n\n`);
      teardown();
      if (!res.writableEnded) res.end();
    });
    const sink = {
      deliver(envelope: Envelope | Frame): void {
        if (!open) return;
        // `event:` is the kind and `id:` is the seq, so a browser `EventSource` can
        // dispatch by kind and resume by seq with no body parsing. `data:` is one line:
        // `JSON.stringify` never emits a raw newline, so no continuation is possible.
        //
        // (D168, I51) A frame carries no `seq` and is written with no `id:` line — a
        // client's resume point must be unchanged by receiving one, since no store holds
        // it to resume from.
        if (isFrame(envelope)) {
          guardedWrite(`event: ${envelope.kind}\ndata: ${JSON.stringify(envelope)}\n\n`);
          return;
        }
        const advances = envelope.seq > lastIdWritten;
        if (advances) lastIdWritten = envelope.seq;
        const id = advances ? `id: ${envelope.seq}\n` : '';
        guardedWrite(`${id}event: ${envelope.kind}\ndata: ${JSON.stringify(envelope)}\n\n`);
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

  return function listener(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const pathname = url.pathname;

        if (method === 'GET' && (await serveStatic(pathname, res, stampEdgeTag))) return;

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
        if (method === 'GET' && pathname === '/api/requisitions') {
          return handleListRequisitions(req, res);
        }
        if (method === 'POST' && pathname === '/api/requisitions') {
          return handleRaiseRequisition(req, res, owner);
        }

        const requisitionRoute = /^\/api\/requisitions\/([^/]+)\/decision$/.exec(pathname);
        if (method === 'POST' && requisitionRoute !== null) {
          const decoded = decodeSegment(res, requisitionRoute[1]!, 'requisition id', 'requisitionId');
          if (decoded === null) return;
          return handleDecideRequisition(req, res, owner, decoded as RequisitionId);
        }

        if (method === 'GET' && pathname === '/api/reviews') {
          return handleListReviews(req, res);
        }
        if (method === 'POST' && pathname === '/api/reviews') {
          return handleCreateReview(req, res, owner);
        }

        const reviewFinaliseRoute = /^\/api\/reviews\/([^/]+)\/finalise$/.exec(pathname);
        if (method === 'POST' && reviewFinaliseRoute !== null) {
          const decoded = decodeSegment(res, reviewFinaliseRoute[1]!, 'review id', 'reviewId');
          if (decoded === null) return;
          return handleFinaliseReview(req, res, owner, decoded as ReviewId);
        }

        const reviewRoute = /^\/api\/reviews\/([^/]+)$/.exec(pathname);
        if (reviewRoute !== null) {
          const decoded = decodeSegment(res, reviewRoute[1]!, 'review id', 'reviewId');
          if (decoded === null) return;
          if (method === 'POST') return handleAppendReview(req, res, owner, decoded as ReviewId);
          if (method === 'GET') return handleGetReview(req, res, owner, decoded as ReviewId);
        }

        const sessionRoute = /^\/api\/sessions\/([^/]+)(\/[^?]*)?$/.exec(pathname);
        if (sessionRoute !== null) {
          const decoded = decodeSegment(res, sessionRoute[1]!, 'session id', 'sessionId');
          if (decoded === null) return;
          const sessionId = decoded as SessionId;
          const rest = sessionRoute[2] ?? '';
          if (method === 'POST' && rest === '/message') return handleMessage(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/permission') return handlePermission(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/interrupt') return handleInterrupt(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/end') return handleEnd(req, res, owner, sessionId);
          if (method === 'POST' && rest === '/checkpoint/restore') return handleCheckpointRestore(req, res, owner, sessionId);
          if (method === 'DELETE' && rest === '') return handleDelete(req, res, owner, sessionId);
          if (method === 'GET' && rest === '/events') return handleEvents(req, res, owner, sessionId);
          if (method === 'GET' && rest === '/checkpoints') return handleListCheckpoints(req, res, owner, sessionId);
          if (method === 'GET' && rest === '/checklist') return handleChecklist(req, res, owner, sessionId);
          const checklistTickMatch = /^\/checklist\/([^/]+)$/.exec(rest);
          if (method === 'POST' && checklistTickMatch !== null) {
            const decodedItemId = decodeSegment(res, checklistTickMatch[1]!, 'itemId', 'itemId');
            if (decodedItemId === null) return;
            return handleTickChecklistItem(req, res, owner, sessionId, decodedItemId as ChecklistItemId);
          }
          if (method === 'GET' && rest === '/payroll') return handlePayroll(req, res, owner, sessionId);
          const toolOutputMatch = /^\/tool-output\/([^/]+)\/([^/]+)$/.exec(rest);
          if (method === 'GET' && toolOutputMatch) {
            const decodedTurnId = decodeSegment(res, toolOutputMatch[1]!, 'turnId', 'turnId');
            if (decodedTurnId === null) return;
            const decodedCallId = decodeSegment(res, toolOutputMatch[2]!, 'callId', 'callId');
            if (decodedCallId === null) return;
            return handleToolOutput(req, res, owner, sessionId, decodedTurnId as TurnId, decodedCallId as CallId);
          }
          const attachmentMatch = /^\/attachments\/([^/]+)\/([^/]+)$/.exec(rest);
          if (method === 'GET' && attachmentMatch) {
            const decodedTurnId = decodeSegment(res, attachmentMatch[1]!, 'turnId', 'turnId');
            if (decodedTurnId === null) return;
            const decodedAttachmentId = decodeSegment(res, attachmentMatch[2]!, 'attachmentId', 'attachmentId');
            if (decodedAttachmentId === null) return;
            return handleAttachment(req, res, owner, sessionId, decodedTurnId as TurnId, decodedAttachmentId as AttachmentId);
          }
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
