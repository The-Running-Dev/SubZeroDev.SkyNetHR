import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSseEdge } from './index.js';
import { resolverFor } from '../../identity/index.js';
import { createSessionManager } from '../../session-manager/index.js';
import { createStore } from '../../store/index.js';
import type { AuthConfig, Checkpoints, Config, Records } from '../../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

function notImplementedProxy<T extends object>(name: string): T {
  return new Proxy({}, { get: () => () => { throw new Error(`${name} must not be called in S2`); } }) as T;
}

const servers: Server[] = [];
const openStreams: AbortController[] = [];
const storageRoots: string[] = [];

after(async () => {
  for (const c of openStreams) c.abort();
  // `close()` alone waits for in-flight connections, and an SSE stream never ends on its
  // own — without this the runner hangs rather than failing.
  for (const s of servers) { s.closeAllConnections(); s.close(); }

  // A turn that stalls on an unanswered permission leaves its child alive, and a live
  // child holds the event loop open. Terminating one is `interrupt`'s, which is S5's — so
  // until that exists these tests reap what they started, from the pid log the store
  // already writes. Without this the runner passes and then hangs.
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
        // Already gone, which is the common case.
      }
    }
  }
});

interface Harness {
  readonly base: string;
  readonly workspaceRoot: string;
}

async function makeEdge(
  auth: AuthConfig = { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
  over: Partial<Config> = {},
  scenario = 'full',
): Promise<Harness> {
  process.env['SKYNET_TEST_SCENARIO'] = scenario;
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-edge-store-'));
  storageRoots.push(storageRoot);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'skynet-edge-ws-'));
  const config: Config = {
    bind: { host: '127.0.0.1', port: 0 },
    auth,
    workspaceRoots: [workspaceRoot as never],
    storageRoot,
    allowedOrigins: ['https://console.example'],
    trustProxy: [],
    caps: {
      ringCapacity: 500,
      toolResultBytes: 65536,
      subscriberQueueHighWater: 1000,
      keepaliveMs: 15000,
      auditPageMax: 200,
      reviewBodyBytes: 1024,
      requisitionTextBytes: 1024,
    },
    includeRaw: false,
    sessionTokenBudget: null,
    checklist: [],
    ...over,
  };
  const storeResult = await createStore(config);
  if (!storeResult.ok) throw new Error('store failed to init');
  const manager = createSessionManager({
    config,
    store: storeResult.value,
    checkpoints: notImplementedProxy<Checkpoints>('checkpoints'),
    records: notImplementedProxy<Records>('records'),
  });
  const listener = createSseEdge({ config, identity: resolverFor(config.auth, config.trustProxy), manager, records: notImplementedProxy<Records>('records') });
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, workspaceRoot };
}

/** A same-origin browser POST from an authenticated operator. */
function post(h: Harness, url: string, body: unknown, operator = 'ben', headers: Record<string, string> = {}) {
  return fetch(`${h.base}${url}`, {
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

function get(h: Harness, url: string, operator = 'ben', headers: Record<string, string> = {}) {
  const controller = new AbortController();
  openStreams.push(controller);
  return fetch(`${h.base}${url}`, {
    headers: { 'x-forwarded-user': operator, ...headers },
    signal: controller.signal,
  });
}

async function newSession(h: Harness, dir: string, operator = 'ben'): Promise<string> {
  const cwd = path.join(h.workspaceRoot, dir);
  await mkdir(cwd, { recursive: true });
  const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null }, operator);
  assert.equal(res.status, 201, `create failed: ${await res.clone().text()}`);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe('S2.1 — POST /api/sessions', () => {
  it('returns 201 { sessionId }', async () => {
    const h = await makeEdge();
    const cwd = path.join(h.workspaceRoot, 'a');
    await mkdir(cwd);
    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { sessionId?: string };
    assert.equal(typeof body.sessionId, 'string');
  });

  it('refuses a cwd outside every root with 409 outside_workspace_root', async () => {
    const h = await makeEdge();
    const outside = await mkdtemp(path.join(tmpdir(), 'skynet-outside-'));
    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd: outside, model: null, sandbox: null, requisitionId: null });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'outside_workspace_root');
  });

  it('refuses a malformed body with 422 bad_request naming the field', async () => {
    const h = await makeEdge();
    const cwd = path.join(h.workspaceRoot, 'b');
    await mkdir(cwd);
    const cases: Array<[unknown, string]> = [
      [{ vendor: 'claude', cwd, model: 'sonnet & calc.exe', sandbox: null, requisitionId: null }, 'model'],
      [{ vendor: 'nonesuch', cwd, model: null, sandbox: null, requisitionId: null }, 'vendor'],
      [{ vendor: 'claude', model: null, sandbox: null, requisitionId: null }, 'cwd'],
    ];
    for (const [body, field] of cases) {
      const res = await post(h, '/api/sessions', body);
      assert.equal(res.status, 422, JSON.stringify(body));
      const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
      assert.equal(err.code, 'bad_request');
      assert.equal(err.detail?.field, field);
    }
  });

  it('refuses a body that is not JSON at all with 422 bad_request', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-user': 'ben' },
      body: '{not json',
    });
    assert.equal(res.status, 422);
  });

  it('refuses a tier-two requisitionId rather than accepting and ignoring it (D94)', async () => {
    const h = await makeEdge();
    const cwd = path.join(h.workspaceRoot, 'c');
    await mkdir(cwd);
    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: 'req-1' });
    assert.equal(res.status, 422);
    const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
    assert.equal(err.detail?.field, 'requisitionId');
  });
});

describe('S2.2 — POST /api/sessions/:id/message', () => {
  it('returns 202 { turnId }', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'm1');
    const res = await post(h, `/api/sessions/${id}/message`, { text: 'hello' });
    assert.equal(res.status, 202);
    assert.equal(typeof ((await res.json()) as { turnId?: string }).turnId, 'string');
  });

  it('returns 409 turn_in_flight for a second message while a turn runs', async () => {
    const h = await makeEdge(undefined, undefined, 'many');
    const id = await newSession(h, 'm2');
    const first = await post(h, `/api/sessions/${id}/message`, { text: 'go' });
    assert.equal(first.status, 202);
    const second = await post(h, `/api/sessions/${id}/message`, { text: 'again' });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'turn_in_flight');
  });

  it('returns 503 agent_unavailable when the CLI cannot be spawned', async () => {
    const h = await makeEdge();
    // The executable is resolved when the adapter is constructed, which is at create —
    // so the session has to be opened against the missing binary, not merely messaged
    // after it goes missing.
    process.env['SKYNET_CLAUDE_EXECUTABLE'] = 'skynet-no-such-binary';
    try {
      const id = await newSession(h, 'm3');
      const res = await post(h, `/api/sessions/${id}/message`, { text: 'go' });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'agent_unavailable');
    } finally {
      process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
    }
  });

  it('refuses a missing text field with 422 bad_request', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'm4');
    const res = await post(h, `/api/sessions/${id}/message`, {});
    assert.equal(res.status, 422);
  });
});

/** Reads SSE frames from a live response until `stop` says enough, then aborts. */
async function readFrames(
  res: Response,
  stop: (frames: string[], raw: string) => boolean,
  timeoutMs = 10000,
): Promise<{ frames: string[]; raw: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`timed out; saw:\n${raw}`);
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const frames = raw.split('\n\n').filter((f) => f.trim().length > 0);
      if (stop(frames, raw)) return { frames, raw };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { frames: raw.split('\n\n').filter((f) => f.trim().length > 0), raw };
}

describe('S2.3 — GET /api/sessions/:id/events', () => {
  it('is text/event-stream with id: set to seq and event: set to kind, one envelope per message', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'e1');
    const res = await get(h, `/api/sessions/${id}/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');

    await post(h, `/api/sessions/${id}/message`, { text: 'hello' });
    // Not `turn.ended`: nothing answers the permission request until S4, so the turn
    // legitimately stalls there. Eight envelopes is well past the point the framing is
    // proven.
    const { frames } = await readFrames(res, (f) => f.filter((x) => x.includes('data: ')).length >= 8);

    const dataFrames = frames.filter((f) => f.includes('data: '));
    assert.ok(dataFrames.length >= 2, 'several envelopes arrived');

    for (const frame of dataFrames) {
      const idLine = frame.split('\n').find((l) => l.startsWith('id: '))!;
      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))!;
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
      const envelope = JSON.parse(dataLine.slice('data: '.length)) as { seq: number; kind: string; sessionId: string };
      assert.equal(idLine.slice('id: '.length), String(envelope.seq), 'id: is the seq');
      assert.equal(eventLine.slice('event: '.length), envelope.kind, 'event: is the kind');
      assert.equal(envelope.sessionId, id);
      // One envelope per message: exactly one data: line in the frame.
      assert.equal(frame.split('\n').filter((l) => l.startsWith('data: ')).length, 1);
    }

    const seqs = dataFrames.map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).seq as number);
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1]! + 1, 'seq is contiguous over the stream');
  });

  it('is 404 no_such_session for another operator, and carries no body distinguishing it', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'e2', 'ben');
    const res = await get(h, `/api/sessions/${id}/events`, 'mallory');
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
  });
});

describe('S3.1 — reconnect over the wire', () => {
  it('a Last-Event-ID header resumes from seq+1', async () => {
    const h = await makeEdge(undefined, undefined, 'many');
    const id = await newSession(h, 's31');
    const first = await get(h, `/api/sessions/${id}/events`);
    await post(h, `/api/sessions/${id}/message`, { text: 'go' });

    const { frames: firstFrames } = await readFrames(first, (f) => f.filter((x) => x.includes('data: ')).length >= 20, 15000);
    const seqOf = (frame: string): number =>
      JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)).seq as number;
    const dataFrames = firstFrames.filter((f) => f.includes('data: '));
    const cutoff = seqOf(dataFrames[9]!);
    // Give the first connection's server-side teardown a moment to land before opening
    // the next one against the same session.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reconnected = await get(h, `/api/sessions/${id}/events`, 'ben', { 'last-event-id': String(cutoff) });
    const { frames: reconnFrames } = await readFrames(reconnected, (f) => f.filter((x) => x.includes('data: ')).length >= 1, 10000);
    const firstReconnSeq = seqOf(reconnFrames.filter((f) => f.includes('data: '))[0]!);
    assert.equal(firstReconnSeq, cutoff + 1, 'resumes at exactly seq+1');
  });

  it('a connection with no Last-Event-ID at all replays from the start (the "reopen on a phone" case)', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 's31b');
    await post(h, `/api/sessions/${id}/message`, { text: 'go' });
    const seqOf = (frame: string): number =>
      JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)).seq as number;

    const fresh = await get(h, `/api/sessions/${id}/events`);
    const { frames: freshFrames } = await readFrames(fresh, (f) => f.filter((x) => x.includes('data: ')).length >= 1, 10000);
    const firstFreshSeq = seqOf(freshFrames.filter((f) => f.includes('data: '))[0]!);
    assert.equal(firstFreshSeq, 1, 'a connection with no Last-Event-ID replays from the start');
  });
});

describe('S2.10 — SSE retry hint', () => {
  it('sets retry: independently of caps.keepaliveMs', async () => {
    const h = await makeEdge(undefined, {
      caps: {
        ringCapacity: 500, toolResultBytes: 65536, subscriberQueueHighWater: 1000,
        keepaliveMs: 15000, auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024,
      },
    });
    const id = await newSession(h, 'r1');
    const res = await get(h, `/api/sessions/${id}/events`);
    const { raw } = await readFrames(res, (_f, r) => r.includes('retry: '), 5000);
    const retryLine = raw.split('\n').find((l) => l.startsWith('retry: '))!;
    const retryMs = Number.parseInt(retryLine.slice('retry: '.length), 10);
    assert.notEqual(retryMs, 15000, 'retry: must not be caps.keepaliveMs');
  });
});

describe('S2.10 — SSE keepalive', () => {
  it('sends a : keepalive comment every caps.keepaliveMs and the idle stream survives three intervals', async () => {
    const h = await makeEdge(undefined, {
      caps: {
        ringCapacity: 500, toolResultBytes: 65536, subscriberQueueHighWater: 1000,
        keepaliveMs: 60, auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024,
      },
    });
    const id = await newSession(h, 'k1');
    const res = await get(h, `/api/sessions/${id}/events`);
    // No message is ever sent: the stream is idle for its whole life.
    const { raw } = await readFrames(res, (_f, r) => (r.match(/^: keepalive$/gm) ?? []).length >= 3, 5000);
    const keepalives = raw.match(/^: keepalive$/gm) ?? [];
    assert.ok(keepalives.length >= 3, `expected 3+ keepalives, got ${keepalives.length}`);
    assert.ok(!raw.includes('data: '), 'an idle stream carried no envelopes');
  });
});

describe('S2.6 / S2.7 — ownership', () => {
  it('answers 404 no_such_session, never 403, on every :id route in this slice', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'o1', 'ben');
    const routes: Array<() => Promise<Response>> = [
      () => post(h, `/api/sessions/${id}/message`, { text: 'x' }, 'mallory'),
      () => get(h, `/api/sessions/${id}/events`, 'mallory'),
    ];
    for (const call of routes) {
      const res = await call();
      assert.equal(res.status, 404);
      assert.notEqual(res.status, 403);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
    }
  });

  it('answers 404 for a session id that does not exist at all — indistinguishable from the above', async () => {
    const h = await makeEdge();
    const res = await post(h, '/api/sessions/2b2e1e6a-0000-4000-8000-000000000000/message', { text: 'x' });
    assert.equal(res.status, 404);
  });

  it('answers 422 bad_request, not 503, for a session id with a malformed percent-escape', async () => {
    const h = await makeEdge();
    const res = await post(h, '/api/sessions/%/message', { text: 'x' });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_request');
  });

  it('GET /api/sessions returns only the caller\'s sessions', async () => {
    const h = await makeEdge();
    await newSession(h, 'o2', 'ben');
    await newSession(h, 'o3', 'ben');
    await newSession(h, 'o4', 'mallory');

    const mine = (await (await get(h, '/api/sessions', 'ben')).json()) as { sessions: Array<{ owner: string }> };
    assert.equal(mine.sessions.length, 2);
    assert.ok(mine.sessions.every((s) => s.owner === 'ben'));

    const theirs = (await (await get(h, '/api/sessions', 'mallory')).json()) as { sessions: Array<{ owner: string }> };
    assert.equal(theirs.sessions.length, 1);

    const nobody = (await (await get(h, '/api/sessions', 'carol')).json()) as { sessions: unknown[] };
    assert.equal(nobody.sessions.length, 0);
  });
});

/**
 * Opens the event stream, sends a message, waits for the first permission.request, and
 * returns its requestId — `readFrames` always cancels the reader it hands back, so the
 * stream itself is not reusable afterward; a caller wanting what happens next reopens
 * one (a fresh GET replays the history the ring or spill still holds).
 */
async function firstPermissionRequestId(h: Harness, id: string): Promise<{ requestId: string }> {
  const res = await get(h, `/api/sessions/${id}/events`);
  await post(h, `/api/sessions/${id}/message`, { text: 'hello' });
  const { frames } = await readFrames(res, (f) => f.some((x) => x.includes('event: permission.request')));
  const frame = frames.find((f) => f.includes('event: permission.request'))!;
  const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
  const envelope = JSON.parse(dataLine.slice('data: '.length)) as { data: { requestId: string } };
  return { requestId: envelope.data.requestId };
}

describe('S4 — POST /api/sessions/:id/permission', () => {
  it('returns 200 { accepted: true } and the child proceeds accordingly (S4.2)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p1');
    const { requestId } = await firstPermissionRequestId(h, id);
    const res = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: null, reason: null });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { accepted: boolean }).accepted, true);

    const replay = await get(h, `/api/sessions/${id}/events`);
    await readFrames(replay, (f) => f.some((x) => x.includes('event: turn.ended')));
  });

  it('returns 200 { accepted: false } for a second answer to the same request', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p2');
    const { requestId } = await firstPermissionRequestId(h, id);
    const first = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: null, reason: null });
    assert.equal(first.status, 200);
    const second = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'deny', scope: 'once', rule: null, reason: null });
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { accepted: boolean }).accepted, false);
  });

  it('answers 404 no_such_session, never 403, for another operator (S4.13)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p3', 'ben');
    const { requestId } = await firstPermissionRequestId(h, id);
    const res = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: null, reason: null }, 'mallory');
    assert.equal(res.status, 404);
    assert.notEqual(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
  });

  it('refuses scope: always and a supplied rule with 422 bad_request naming the field (S4.12)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p4');
    const { requestId } = await firstPermissionRequestId(h, id);

    const always = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'always', rule: null, reason: null });
    assert.equal(always.status, 422);
    assert.equal(((await always.json()) as { error: { detail?: { field?: string } } }).error.detail?.field, 'scope');

    const withRule = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: 'x', reason: null });
    assert.equal(withRule.status, 422);
    assert.equal(((await withRule.json()) as { error: { detail?: { field?: string } } }).error.detail?.field, 'rule');
  });

  it('refuses a malformed body with 422 bad_request naming the field', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p5');
    const cases: Array<[unknown, string]> = [
      [{ decision: 'allow', scope: 'once', rule: null, reason: null }, 'requestId'],
      [{ requestId: 'r1', scope: 'once', rule: null, reason: null }, 'decision'],
      [{ requestId: 'r1', decision: 'allow', rule: null, reason: null }, 'scope'],
    ];
    for (const [body, field] of cases) {
      const res = await post(h, `/api/sessions/${id}/permission`, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
      assert.equal(err.code, 'bad_request');
      assert.equal(err.detail?.field, field);
    }
  });
});

describe('S2.9 — origin discipline', () => {
  it('refuses a disallowed Origin with 403 bad_origin before identity is resolved', async () => {
    const h = await makeEdge();
    // No identity header at all, and a disallowed origin: the answer must be 403, not 401.
    const res = await fetch(`${h.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ vendor: 'claude', cwd: h.workspaceRoot, model: null, sandbox: null, requisitionId: null }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_origin');
  });

  it('accepts a configured Origin', async () => {
    const h = await makeEdge();
    const cwd = path.join(h.workspaceRoot, 'g1');
    await mkdir(cwd);
    const res = await fetch(`${h.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.example', 'x-forwarded-user': 'ben' },
      body: JSON.stringify({ vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null }),
    });
    assert.equal(res.status, 201);
  });

  it('refuses a mutating request carrying neither Origin nor Sec-Fetch-Site — no partial credit', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-user': 'ben' },
      body: JSON.stringify({ vendor: 'claude', cwd: h.workspaceRoot, model: null, sandbox: null, requisitionId: null }),
    });
    assert.equal(res.status, 403);
  });

  it('does not apply the origin check to read routes', async () => {
    const h = await makeEdge();
    const res = await get(h, '/api/sessions', 'ben', { origin: 'https://evil.example' });
    assert.equal(res.status, 200);
  });
});

describe('S2.13 — the negative authentication cases', () => {
  it('rejects no identity with 401 unauthenticated', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/api/sessions`, { headers: {} });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unauthenticated');
  });

  it('rejects a forged header from a peer outside trustProxy with 401, and logs the address', async () => {
    // trustProxy names an address that is not the loopback peer these tests connect from.
    const h = await makeEdge({ mode: 'proxy-header', userHeader: 'x-forwarded-user' }, { trustProxy: ['10.9.9.9'] });
    const logged: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = await get(h, '/api/sessions', 'mallory');
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unauthenticated');
    } finally {
      console.warn = realWarn;
    }
    assert.ok(logged.some((l) => l.includes('127.0.0.1')), `the peer address was logged; saw ${JSON.stringify(logged)}`);
  });

  it('rejects a wrong shared secret with 401 unauthenticated', async () => {
    const h = await makeEdge({ mode: 'shared-secret', cookieName: 'skynet', secret: 'right' });
    const res = await fetch(`${h.base}/api/sessions`, { headers: { cookie: 'skynet=wrong' } });
    assert.equal(res.status, 401);
  });

  it('accepts the right shared secret', async () => {
    const h = await makeEdge({ mode: 'shared-secret', cookieName: 'skynet', secret: 'right' });
    const res = await fetch(`${h.base}/api/sessions`, { headers: { cookie: 'skynet=right' } });
    assert.equal(res.status, 200);
  });

  it('rejects a disallowed origin with 403 — counted here as the fourth case', async () => {
    const h = await makeEdge();
    const res = await post(h, '/api/sessions', {}, 'ben', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(res.status, 403);
  });
});

describe('S2.5 — the shared-secret cookie', () => {
  it('is set SameSite=Strict; HttpOnly; Path=/ when the secret is presented to the login route', async () => {
    const h = await makeEdge({ mode: 'shared-secret', cookieName: 'skynet', secret: 'right' });
    const res = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ secret: 'right' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^skynet=right;/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\//);
  });

  it('refuses a wrong secret at the login route without setting a cookie', async () => {
    const h = await makeEdge({ mode: 'shared-secret', cookieName: 'skynet', secret: 'right' });
    const res = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ secret: 'wrong' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('is absent in proxy-header mode — there is no secret to exchange', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ secret: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('S2.12 — the document CSP', () => {
  const EXPECTED_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

  it('serves exactly the CSP in 10-design.md § Security controls on the document', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), EXPECTED_CSP);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('serves the document without requiring authentication, so the login form is reachable', async () => {
    const h = await makeEdge({ mode: 'shared-secret', cookieName: 'skynet', secret: 'right' });
    assert.equal((await fetch(`${h.base}/`)).status, 200);
  });

  it('serves the script and stylesheet from self with the right types', async () => {
    const h = await makeEdge();
    const js = await fetch(`${h.base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const css = await fetch(`${h.base}/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  });

  it('does not serve anything outside the client directory', async () => {
    const h = await makeEdge();
    for (const attempt of ['/../package.json', '/%2e%2e/package.json', '/../../etc/passwd']) {
      const res = await fetch(`${h.base}${attempt}`);
      assert.ok(res.status === 404 || res.status === 400, `${attempt} -> ${res.status}`);
    }
  });
});

describe('S3.3 — a replay_gap never moves the client\'s resume point', () => {
  it('is sent without an id:, so EventSource keeps the Last-Event-ID it already had', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 's33c');
    await post(h, `/api/sessions/${id}/message`, { text: 'go' });

    // Wait for the turn to produce history, so `lastSeq` is well above zero.
    const warm = await get(h, `/api/sessions/${id}/events`);
    await readFrames(warm, (f) => f.some((x) => x.includes('"kind":"turn.ended"')), 15000);

    // A resume point the session never reached: the one range no store can serve.
    const beyond = await get(h, `/api/sessions/${id}/events`, 'ben', { 'last-event-id': '999999999' });
    const { frames } = await readFrames(beyond, (f) => f.some((x) => x.includes('replay_gap')), 10000);

    const gapFrame = frames.find((f) => f.includes('replay_gap'))!;
    assert.match(gapFrame, /^event: error$/m, 'the gap is dispatched as an error event');
    assert.doesNotMatch(gapFrame, /^id:/m, 'and carries no id: — an id here would resume past history never received');
  });
});

/** `delete` is a keyword; a plain named function reads oddly as `deleteSession`. */
function del(h: Harness, url: string, operator = 'ben') {
  return fetch(`${h.base}${url}`, {
    method: 'DELETE',
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-user': operator },
  });
}

describe('S5 — POST .../interrupt, POST .../end, DELETE /api/sessions/:id', () => {
  it('POST /interrupt returns 200 { ok: true } and the turn ends interrupted (S5.1)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'i1');
    const events = await get(h, `/api/sessions/${id}/events`);
    const messaged = await post(h, `/api/sessions/${id}/message`, { text: 'go' });
    assert.equal(messaged.status, 202);
    const { turnId } = (await messaged.json()) as { turnId: string };

    const res = await post(h, `/api/sessions/${id}/interrupt`, { turnId });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);

    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('"kind":"turn.ended"')), 10000);
    const ended = frames.find((f) => f.includes('"kind":"turn.ended"'))!;
    assert.match(ended, /"stopReason":"interrupted"/);
  });

  it('POST /interrupt is 200 { ok: true } for a turnId that does not name the live turn (S5.3)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'i2');
    const res = await post(h, `/api/sessions/${id}/interrupt`, { turnId: 'not-a-real-turn' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  });

  it('POST /interrupt refuses a missing turnId with 422 bad_request', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'i3');
    const res = await post(h, `/api/sessions/${id}/interrupt`, {});
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { detail?: { field?: string } } }).error.detail?.field, 'turnId');
  });

  it('POST /interrupt is 404 no_such_session for another operator', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'i4', 'ben');
    const res = await post(h, `/api/sessions/${id}/interrupt`, { turnId: 'x' }, 'mallory');
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
  });

  it('POST /end sets the session ended and a further message is 409 session_ended (S5.5)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'e1');
    const res = await post(h, `/api/sessions/${id}/end`, {});
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);

    const summary = await get(h, `/api/sessions/${id}`);
    assert.equal(((await summary.json()) as { session: { state: string } }).session.state, 'ended');

    const messaged = await post(h, `/api/sessions/${id}/message`, { text: 'go' });
    assert.equal(messaged.status, 409);
    assert.equal(((await messaged.json()) as { error: { code: string } }).error.code, 'session_ended');
  });

  it('POST /end frees the workspace for a new create (S5.6)', async () => {
    const h = await makeEdge();
    const cwd = path.join(h.workspaceRoot, 'e2');
    await mkdir(cwd);
    const first = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null });
    assert.equal(first.status, 201);
    const { sessionId } = (await first.json()) as { sessionId: string };

    const busy = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null });
    assert.equal(busy.status, 409);

    await post(h, `/api/sessions/${sessionId}/end`, {});

    const afterEnd = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: null });
    assert.equal(afterEnd.status, 201);
  });

  it('POST /end and DELETE are both 409 turn_in_flight during a turn (S5.10)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'e3');
    const { requestId } = await firstPermissionRequestId(h, id);
    void requestId; // the turn is now live and stalled on this request

    const endRes = await post(h, `/api/sessions/${id}/end`, {});
    assert.equal(endRes.status, 409);
    assert.equal(((await endRes.json()) as { error: { code: string } }).error.code, 'turn_in_flight');

    const delRes = await del(h, `/api/sessions/${id}`);
    assert.equal(delRes.status, 409);
    assert.equal(((await delRes.json()) as { error: { code: string } }).error.code, 'turn_in_flight');
  });

  it('DELETE removes the session; a subsequent GET is 404 no_such_session (S5.9)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'd1');
    const res = await del(h, `/api/sessions/${id}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);

    const after = await get(h, `/api/sessions/${id}`);
    assert.equal(after.status, 404);
  });

  it('DELETE is 404 no_such_session for another operator', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'd2', 'ben');
    const res = await del(h, `/api/sessions/${id}`, 'mallory');
    assert.equal(res.status, 404);
  });
});
