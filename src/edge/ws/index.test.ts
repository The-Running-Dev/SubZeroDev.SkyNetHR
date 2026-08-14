import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSseEdge } from '../sse/index.js';
import { createWsEdge } from './index.js';
import { resolverFor } from '../../identity/index.js';
import { createSessionManager } from '../../session-manager/index.js';
import { createStore } from '../../store/index.js';
import { createCheckpoints } from '../../checkpoints/index.js';
import { stripExtendedPrefix } from '../../jail/index.js';
import type { AuthConfig, Config, Records } from '../../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');
const ALLOWED_ORIGIN = 'https://console.example';

function notImplementedProxy<T extends object>(name: string): T {
  return new Proxy({}, { get: () => () => { throw new Error(`${name} must not be called in S11`); } }) as T;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
const storageRoots: string[] = [];

after(async () => {
  for (const s of sockets) s.destroy();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  for (const root of storageRoots) {
    let log: string;
    try {
      log = await readFile(path.join(root, 'pids.ndjson'), 'utf8');
    } catch {
      continue;
    }
    for (const line of log.split('\n')) {
      if (line.trim() === '') continue;
      let record: { pid?: number; exitedAt?: string | null };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (typeof record.pid !== 'number' || record.exitedAt) continue;
      try {
        process.kill(record.pid);
      } catch {
        // Already gone.
      }
    }
  }
});

interface Harness {
  readonly sseBase: string;
  readonly wsBase: string;
  readonly workspaceRoot: string;
}

/** Both edges wired to the *same* `SessionManager` (S11.1's whole point: one truth, two
 * transports reading it — not two independent runs whose vendor-minted ids could never
 * line up). */
async function makeSharedEdges(
  auth: AuthConfig = { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
  over: Partial<Config> = {},
  scenario = 'full',
): Promise<Harness> {
  process.env['SKYNET_TEST_SCENARIO'] = scenario;
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-ws-store-'));
  storageRoots.push(storageRoot);
  const workspaceRootRaw = await mkdtemp(path.join(tmpdir(), 'skynet-ws-ws-'));
  // `stripExtendedPrefix(realpathSync.native(...))` is what `config/index.ts` actually does
  // for `WORKSPACE_ROOTS` — the jail resolves a candidate `cwd` the same way, and on macOS
  // `/var/folders/...` and its realpath `/private/var/folders/...` are different strings.
  const workspaceRoot = stripExtendedPrefix(realpathSync.native(workspaceRootRaw));
  const config: Config = {
    bind: { host: '127.0.0.1', port: 0 },
    auth,
    workspaceRoots: [workspaceRoot as never],
    storageRoot,
    allowedOrigins: [ALLOWED_ORIGIN],
    trustProxy: [],
    caps: {
      ringCapacity: 500,
      toolResultBytes: 65536,
      subscriberQueueHighWater: 1000,
      keepaliveMs: 15000,
      auditPageMax: 200,
      reviewBodyBytes: 1024,
      requisitionTextBytes: 1024,
      standingRuleBytes: 1024,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    sessionTokenBudget: null,
    checklist: [],
    edge: 'ws',
    ...over,
  };
  const storeResult = await createStore(config);
  if (!storeResult.ok) throw new Error('store failed to init');
  const manager = createSessionManager({
    config,
    store: storeResult.value,
    checkpoints: createCheckpoints(config),
    records: notImplementedProxy<Records>('records'),
  });
  const deps = { config, identity: resolverFor(config.auth, config.trustProxy), manager, records: notImplementedProxy<Records>('records') };

  const sseServer = createServer(createSseEdge(deps));
  servers.push(sseServer);
  await new Promise<void>((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
  const sseAddr = sseServer.address();
  if (sseAddr === null || typeof sseAddr === 'string') throw new Error('no port');

  const wsListener = createWsEdge(deps);
  const wsServer = createServer(wsListener);
  wsServer.on('upgrade', wsListener.handleUpgrade);
  servers.push(wsServer);
  await new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const wsAddr = wsServer.address();
  if (wsAddr === null || typeof wsAddr === 'string') throw new Error('no port');

  return {
    sseBase: `http://127.0.0.1:${sseAddr.port}`,
    wsBase: `http://127.0.0.1:${wsAddr.port}`,
    workspaceRoot,
  };
}

function post(base: string, url: string, body: unknown, operator = 'ben', headers: Record<string, string> = {}) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-user': operator,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function newSession(h: Harness, dir: string, operator = 'ben'): Promise<string> {
  const cwd = path.join(h.workspaceRoot, dir);
  await mkdir(cwd, { recursive: true });
  const res = await post(h.sseBase, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null }, operator);
  assert.equal(res.status, 201, `create failed: ${await res.clone().text()}`);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

// -----------------------------------------------------------------------
// A minimal RFC 6455 client: masked frames out, unmasked frames in — the
// mirror image of `edge/ws`'s own codec.
// -----------------------------------------------------------------------

interface WsFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(buf: Buffer): { frames: WsFrame[]; consumed: number } {
  const frames: WsFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const byte0 = buf[offset]!;
    const byte1 = buf[offset + 1]!;
    const opcode = byte0 & 0x0f;
    let len = byte1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (buf.length - cursor < 2) break;
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (buf.length - cursor < 8) break;
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (buf.length - cursor < len) break;
    const payload = Buffer.from(buf.subarray(cursor, cursor + len));
    cursor += len;
    frames.push({ opcode, payload });
    offset = cursor;
  }
  return { frames, consumed: offset };
}

class TestWsClient {
  private buffered = Buffer.alloc(0);
  private queue: WsFrame[] = [];
  private waiters: Array<() => void> = [];
  closed = false;

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      const { frames, consumed } = parseServerFrames(this.buffered);
      this.buffered = this.buffered.subarray(consumed);
      for (const f of frames) this.queue.push(f);
      if (frames.length > 0) this.drain();
    });
    socket.on('close', () => {
      this.closed = true;
      this.drain();
    });
  }

  private drain(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  send(obj: unknown): void {
    this.socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  async nextTextFrame(timeoutMs = 5000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.queue.findIndex((f) => f.opcode === 0x1);
      if (idx !== -1) return this.queue.splice(idx, 1)[0]!.payload.toString('utf8');
      if (this.closed) return null;
      if (Date.now() > deadline) throw new Error('timed out waiting for a text frame');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async collectEnvelopes(count: number, timeoutMs = 10000): Promise<unknown[]> {
    const out: unknown[] = [];
    while (out.length < count) {
      const raw = await this.nextTextFrame(timeoutMs);
      if (raw === null) throw new Error(`socket closed after ${out.length}/${count} envelopes`);
      out.push(JSON.parse(raw));
    }
    return out;
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Performs the handshake by hand (so headers like `x-forwarded-user` and `origin` are
 * controllable) and resolves once the socket is either upgraded (`101`) or the server has
 * refused it (any other status, or the connection was reset). */
function handshake(
  base: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; client: TestWsClient | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + urlPath);
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      sockets.push(socket);
      resolve({ status: res.statusCode ?? 101, client: new TestWsClient(socket) });
    });
    req.on('response', (res) => {
      // Refused before/without upgrading — the origin and route-not-found cases.
      res.resume();
      resolve({ status: res.statusCode ?? 0, client: null });
    });
    req.on('error', () => resolve({ status: 0, client: null }));
    req.end();
  });
}

describe('S11.1 — the WebSocket edge delivers the same envelope sequence as SSE, element for element', () => {
  it('matches for one fixture run', async () => {
    const h = await makeSharedEdges(undefined, undefined, 'many');
    const id = await newSession(h, 'w1');

    const sseRes = await fetch(`${h.sseBase}/api/sessions/${id}/events`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.equal(sseRes.status, 200);
    const sseReader = sseRes.body!.getReader();

    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, {
      origin: ALLOWED_ORIGIN,
      'x-forwarded-user': 'ben',
    });
    assert.equal(status, 101);
    client!.send({ after: 0 });

    await post(h.sseBase, `/api/sessions/${id}/message`, { text: 'go' });

    const wsEnvelopes = await client!.collectEnvelopes(8, 15000);

    // Read the same count of `data:` frames off the SSE stream. `raw` may end mid-event when a
    // chunk boundary falls inside one — only the segments before the last `\n\n` are complete;
    // the tail is kept and re-joined with the next read rather than parsed as-is.
    const decoder = new TextDecoder();
    let raw = '';
    const sseEnvelopes: unknown[] = [];
    while (sseEnvelopes.length < 8) {
      const { value, done } = await sseReader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const segments = raw.split('\n\n');
      raw = segments.pop() ?? '';
      for (const frame of segments.filter((f) => f.includes('data: '))) {
        if (sseEnvelopes.length >= 8) break;
        sseEnvelopes.push(JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)));
      }
    }
    await sseReader.cancel().catch(() => {});
    client!.close();

    assert.deepEqual(wsEnvelopes, sseEnvelopes, 'the two transports delivered the identical sequence');
  });
});

describe('S11.2 — the origin allow-list is applied at the handshake, before any frame is read', () => {
  it('refuses a disallowed Origin and never completes the upgrade', async () => {
    const h = await makeSharedEdges();
    const id = await newSession(h, 'w2');
    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, {
      origin: 'https://evil.example',
      'x-forwarded-user': 'ben',
    });
    assert.equal(status, 403);
    assert.equal(client, null);
  });

  it('accepts a configured Origin', async () => {
    const h = await makeSharedEdges();
    const id = await newSession(h, 'w3');
    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, {
      origin: ALLOWED_ORIGIN,
      'x-forwarded-user': 'ben',
    });
    assert.equal(status, 101);
    client!.close();
  });
});

describe('S11.3 — first-message auth resolves the same OperatorId as SSE, and ownership refusals are no_such_session', () => {
  it("streams only the owner's own session", async () => {
    const h = await makeSharedEdges(undefined, undefined, 'many');
    const id = await newSession(h, 'w4', 'ben');
    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, {
      origin: ALLOWED_ORIGIN,
      'x-forwarded-user': 'ben',
    });
    assert.equal(status, 101);
    client!.send({ after: 0 });
    await post(h.sseBase, `/api/sessions/${id}/message`, { text: 'go' });
    const [envelope] = (await client!.collectEnvelopes(1)) as Array<{ sessionId: string }>;
    assert.equal(envelope!.sessionId, id);
    client!.close();
  });

  it('answers no_such_session for another operator, over the connection rather than a status code', async () => {
    const h = await makeSharedEdges();
    const id = await newSession(h, 'w5', 'ben');
    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, {
      origin: ALLOWED_ORIGIN,
      'x-forwarded-user': 'mallory',
    });
    // The handshake itself succeeds — ownership is a first-message concern, exactly as
    // identity is (S11.3) — and the refusal arrives as a frame once resolved.
    assert.equal(status, 101);
    client!.send({ after: 0 });
    const raw = await client!.nextTextFrame();
    const parsed = JSON.parse(raw!) as { type: string; error: { code: string } };
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.code, 'no_such_session');
    client!.close();
  });
});

describe('S11.4 — a reconnect with `after` behaves exactly as Last-Event-ID does', () => {
  it('resumes from exactly after+1', async () => {
    const h = await makeSharedEdges(undefined, undefined, 'many');
    const id = await newSession(h, 'w6');
    const first = await handshake(h.wsBase, `/api/sessions/${id}/events`, { origin: ALLOWED_ORIGIN, 'x-forwarded-user': 'ben' });
    assert.equal(first.status, 101);
    first.client!.send({ after: 0 });
    await post(h.sseBase, `/api/sessions/${id}/message`, { text: 'go' });
    const envelopes = (await first.client!.collectEnvelopes(10, 15000)) as Array<{ seq: number }>;
    const cutoff = envelopes[9]!.seq;
    first.client!.close();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await handshake(h.wsBase, `/api/sessions/${id}/events`, { origin: ALLOWED_ORIGIN, 'x-forwarded-user': 'ben' });
    assert.equal(second.status, 101);
    second.client!.send({ after: cutoff });
    const [resumed] = (await second.client!.collectEnvelopes(1, 10000)) as Array<{ seq: number }>;
    assert.equal(resumed!.seq, cutoff + 1, 'resumes at exactly after+1');
    second.client!.close();
  });

  it('a gap past the ring and spill is delivered as an error/replay_gap envelope, same as SSE (S3.3)', async () => {
    const h = await makeSharedEdges(undefined, undefined, 'error-result');
    const id = await newSession(h, 'w7');
    await post(h.sseBase, `/api/sessions/${id}/message`, { text: 'go' });

    // Warm the session past a `turn.ended` so history exists to gap against.
    const warm = await fetch(`${h.sseBase}/api/sessions/${id}/events`, { headers: { 'x-forwarded-user': 'ben' } });
    const reader = warm.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.includes('"kind":"turn.ended"')) break;
    }
    await reader.cancel().catch(() => {});

    const { status, client } = await handshake(h.wsBase, `/api/sessions/${id}/events`, { origin: ALLOWED_ORIGIN, 'x-forwarded-user': 'ben' });
    assert.equal(status, 101);
    client!.send({ after: 999999999 });
    const [gap] = (await client!.collectEnvelopes(1, 10000)) as Array<{ kind: string; data?: { kind?: string } }>;
    assert.equal(gap!.kind, 'error');
    assert.equal(gap!.data?.kind, 'replay_gap');
    client!.close();
  });
});

describe('S11.5 — the edge is chosen by configuration, and the client learns which from the served page', () => {
  it("serves index.html with <meta name=\"skynet-edge\" content=\"ws\">", async () => {
    const h = await makeSharedEdges();
    const res = await fetch(`${h.wsBase}/`);
    const body = await res.text();
    assert.match(body, /<meta name="skynet-edge" content="ws">/);
  });

  it('every other route in the table is still served over plain HTTP by this edge', async () => {
    const h = await makeSharedEdges();
    const cwd = path.join(h.workspaceRoot, 'w8');
    await mkdir(cwd, { recursive: true });
    const res = await post(h.wsBase, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null });
    assert.equal(res.status, 201);
  });

  it('a plain GET on /events (no upgrade) is refused, not silently served', async () => {
    const h = await makeSharedEdges();
    const id = await newSession(h, 'w9');
    const res = await fetch(`${h.wsBase}/api/sessions/${id}/events`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_request');
  });
});
