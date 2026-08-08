/**
 * Agent Console — spike server.
 *
 * Zero dependencies. `node server.mjs`.
 *
 * Implements enough of design/20-contract.md to prove the transport, the SSE replay and
 * the permission handshake end to end. See spike/README.md for what is deliberately absent.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionStore } from './lib/sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  secret: process.env.CONSOLE_SECRET ?? '',
  // Open WebUI's terminal proxy forwards this (90-decisions.md D11).
  trustHeader: process.env.CONSOLE_TRUST_HEADER ?? '',
  trustedPeers: (process.env.CONSOLE_TRUSTED_PEERS ?? '').split(',').filter(Boolean),
  roots: (process.env.WORKSPACE_ROOTS ?? process.cwd())
    .split(path.delimiter).filter(Boolean),
  storageDir: process.env.CONSOLE_STORAGE ?? path.join(HERE, '.data'),
};

// ── Fail closed (10-design.md § Security controls, 30-slices.md S3.4) ──────────────────
// A console reachable off-box with no identity is an unauthenticated remote shell. This is
// a refusal to start, not a warning, because the failure mode of a warning is that nobody
// reads it.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
if (!LOOPBACK.includes(CONFIG.host) && !CONFIG.secret && !CONFIG.trustHeader) {
  console.error(
    `refusing to bind ${CONFIG.host} with no auth configured.\n` +
    `set CONSOLE_SECRET, or CONSOLE_TRUST_HEADER with CONSOLE_TRUSTED_PEERS, or bind 127.0.0.1.`,
  );
  process.exit(1);
}
if (CONFIG.trustHeader && !CONFIG.trustedPeers.length && !LOOPBACK.includes(CONFIG.host)) {
  console.error('CONSOLE_TRUST_HEADER set without CONSOLE_TRUSTED_PEERS: a client could forge it.');
  process.exit(1);
}

fs.mkdirSync(CONFIG.storageDir, { recursive: true });
const store = createSessionStore({ roots: CONFIG.roots, storageDir: CONFIG.storageDir });

// ── Identity ──────────────────────────────────────────────────────────────────────────
function identify(req) {
  if (CONFIG.trustHeader) {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    const ok = LOOPBACK.includes(CONFIG.host) || CONFIG.trustedPeers.includes(peer);
    const who = req.headers[CONFIG.trustHeader.toLowerCase()];
    if (ok && who) return String(who);
    return null;
  }
  if (CONFIG.secret) {
    const cookie = /(?:^|;\s*)console_secret=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return cookie === CONFIG.secret ? 'operator' : null;
  }
  return 'local';   // loopback, no auth configured — permitted only by the check above
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────
const send = (res, code, body) => {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
};
const fail = (res, code, error, message) => send(res, code, { error: { code: error, message } });

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5 * 1024 * 1024) throw Object.assign(new Error('too large'), { code: 'bad_request' });
  }
  return body ? JSON.parse(body) : {};
}

// ── Routes ────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const seg = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Unlike the prior art, the model's output is rendered as text, never as markup.
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
    });
    return res.end(html);
  }

  const owner = identify(req);
  if (!owner) return fail(res, 401, 'unauthenticated', 'no usable identity');

  try {
    // POST /api/sessions
    if (seg[0] === 'api' && seg[1] === 'sessions' && seg.length === 2) {
      if (req.method === 'GET') return send(res, 200, { sessions: store.list(owner) });
      if (req.method !== 'POST') return fail(res, 405, 'bad_request', 'method');
      const { vendor = 'claude', cwd, model } = await readJson(req);
      if (!cwd) return fail(res, 422, 'bad_request', 'cwd required');
      const s = store.create({ owner, vendor, cwd, model });
      return send(res, 200, { sessionId: s.id, cwd: s.cwd });
    }

    if (seg[0] === 'api' && seg[1] === 'sessions' && seg[2]) {
      const session = store.get(seg[2], owner);
      // 404 not 403: session existence is not something a non-owner may probe.
      if (!session) return fail(res, 404, 'no_such_session', 'unknown session');
      const action = seg[3];

      // GET .../events — SSE
      if (action === 'events' && req.method === 'GET') {
        const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });

        const write = (env) => {
          res.write(`id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`);
        };

        const backlog = store.replay(session, after);
        if (backlog === null) {
          write({ seq: session.seq, sessionId: session.id, ts: new Date().toISOString(),
                  kind: 'error', data: { kind: 'replay_gap', message: 'refetch required', fatal: false } });
        } else {
          for (const env of backlog) write(env);
        }

        session.subscribers.add(write);
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => { clearInterval(keepalive); session.subscribers.delete(write); });
        return;
      }

      if (req.method !== 'POST') return fail(res, 405, 'bad_request', 'method');
      const body = await readJson(req);

      if (action === 'message') {
        if (session.adapter.busy) return fail(res, 409, 'turn_in_flight', 'a turn is running');
        if (!body.text) return fail(res, 422, 'bad_request', 'text required');
        return send(res, 200, { turnId: session.adapter.send(body.text) });
      }

      if (action === 'permission') {
        const accepted = session.adapter.respondPermission({ ...body, operator: owner });
        // accepted:false means another client answered first — not an error (S4.4).
        return send(res, 200, { accepted });
      }

      if (action === 'interrupt') return send(res, 200, { ok: session.adapter.interrupt() });
    }

    if (seg[0] === 'api' && seg[1] === 'sessions' && seg[2] && req.method === 'DELETE') {
      return send(res, 200, { ok: store.destroy(seg[2], owner) });
    }

    return fail(res, 404, 'not_found', 'no route');
  } catch (err) {
    const code = err.code === 'outside_workspace_root' ? 409
      : err.code === 'turn_in_flight' ? 409
      : err.code === 'bad_request' ? 422 : 500;
    return fail(res, code, err.code ?? 'internal', err.message);
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const mode = CONFIG.trustHeader ? `proxy header '${CONFIG.trustHeader}'`
    : CONFIG.secret ? 'shared secret' : 'none (loopback only)';
  console.log(`agent-console spike  http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  auth:  ${mode}`);
  console.log(`  roots: ${CONFIG.roots.join(', ')}`);
});
