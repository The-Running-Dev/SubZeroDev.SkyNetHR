import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSseEdge } from './index.js';
import { resolverFor } from '../../identity/index.js';
import { createSessionManager } from '../../session-manager/index.js';
import { createStore } from '../../store/index.js';
import { createCheckpoints } from '../../checkpoints/index.js';
import { createRecords } from '../../records/index.js';
import { stripExtendedPrefix } from '../../jail/index.js';
import type { AuthConfig, Config, Records, Store } from '../../contract/index.js';

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
  readonly storageRoot: string;
  readonly records: Records;
}

async function makeEdge(
  auth: AuthConfig = { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
  over: Partial<Config> = {},
  scenario = 'full',
  recordsOverride: ((config: Config, store: Store) => Records) | null = null,
): Promise<Harness> {
  process.env['SKYNET_TEST_SCENARIO'] = scenario;
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-edge-store-'));
  storageRoots.push(storageRoot);
  const workspaceRootRaw = await mkdtemp(path.join(tmpdir(), 'skynet-edge-ws-'));
  // `stripExtendedPrefix(realpathSync.native(...))` is what `config/index.ts` actually does
  // for `WORKSPACE_ROOTS` — the jail resolves a candidate `cwd` the same way, and on macOS
  // `/var/folders/...` and its realpath `/private/var/folders/...` are different strings.
  const workspaceRoot = stripExtendedPrefix(realpathSync.native(workspaceRootRaw));
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
      standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    streamDeltas: false,
    sessionTokenBudget: null,
    tokenRates: null,
    currency: null,
    checklist: [],
    edge: 'sse',
    ...over,
  };
  const storeResult = await createStore(config);
  if (!storeResult.ok) throw new Error('store failed to init');
  const records = recordsOverride ? recordsOverride(config, storeResult.value) : notImplementedProxy<Records>('records');
  const manager = createSessionManager({
    config,
    store: storeResult.value,
    checkpoints: createCheckpoints(config),
    records,
  });
  const listener = createSseEdge({ config, identity: resolverFor(config.auth, config.trustProxy), manager, records });
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, workspaceRoot, storageRoot, records };
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

  it('D132 — refuses a cwd that cannot be resolved with the same 409 outside_workspace_root, not a distinguishable code', async () => {
    const h = await makeEdge();
    // Inside a configured root and simply not there. Answering this differently from the
    // case above would make the route a filesystem existence probe for any authenticated
    // operator; the contract's error table routes both jail failures to one code.
    const missing = path.join(h.workspaceRoot, 'no-such-directory');
    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd: missing, model: null, sandbox: null, requisitionId: null });
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

  it('S13.6 — an approved requisitionId is accepted, claimed and consumed', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const cwd = path.join(h.workspaceRoot, 'c');
    await mkdir(cwd);
    const raised = await h.records.raise('ben' as never, { title: 't', justification: 'j', workspace: cwd, vendor: 'claude' });
    assert.equal(raised.ok, true);
    if (!raised.ok) return;
    await h.records.decide(raised.value.requisitionId, 'ben' as never, 'approve');

    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: raised.value.requisitionId });
    assert.equal(res.status, 201, `create failed: ${await res.clone().text()}`);
    const body = (await res.json()) as { sessionId?: string };
    assert.equal(typeof body.sessionId, 'string');

    const after = h.records.getRequisition(raised.value.requisitionId);
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.value.state, 'consumed');
  });

  it('S13.7 — an unapproved requisitionId is refused 409 requisition_not_approved', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const cwd = path.join(h.workspaceRoot, 'c2');
    await mkdir(cwd);
    const raised = await h.records.raise('ben' as never, { title: 't', justification: 'j', workspace: cwd, vendor: 'claude' });
    assert.equal(raised.ok, true);
    if (!raised.ok) return;

    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: raised.value.requisitionId });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'requisition_not_approved');
  });

  it('an unknown requisitionId is refused 404 no_such_requisition', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const cwd = path.join(h.workspaceRoot, 'c3');
    await mkdir(cwd);
    const res = await post(h, '/api/sessions', { vendor: 'claude', cwd, model: null, sandbox: null, requisitionId: 'no-such-id' });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_requisition');
  });
});

describe('S13 — POST/GET /api/requisitions, POST /api/requisitions/:id/decision', () => {
  it('S13.2/S13.3 — raise, then list, sees it in state open', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const raised = await post(h, '/api/requisitions', { title: 't', justification: 'j', workspace: '/outside/every/root', vendor: 'claude' });
    assert.equal(raised.status, 201, `raise failed: ${await raised.clone().text()}`);
    const body = (await raised.json()) as { requisition: { requisitionId: string; state: string; workspace: string } };
    assert.equal(body.requisition.state, 'open');
    assert.equal(body.requisition.workspace, '/outside/every/root'); // S13.2: no jail call

    const listed = await get(h, '/api/requisitions');
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { requisitions: Array<{ requisitionId: string }> };
    assert.ok(listedBody.requisitions.some((r) => r.requisitionId === body.requisition.requisitionId));
  });

  it('S13.4/S13.5 — decision approves, and self-approval is recorded', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const raised = await post(h, '/api/requisitions', { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' }, 'ben');
    const { requisition } = (await raised.json()) as { requisition: { requisitionId: string } };

    const decided = await post(h, `/api/requisitions/${requisition.requisitionId}/decision`, { decision: 'approve' }, 'ben');
    assert.equal(decided.status, 200);
    const decidedBody = (await decided.json()) as { requisition: { state: string; decidedBy: string } };
    assert.equal(decidedBody.requisition.state, 'approved');
    assert.equal(decidedBody.requisition.decidedBy, 'ben');

    const second = await post(h, `/api/requisitions/${requisition.requisitionId}/decision`, { decision: 'reject' }, 'carol');
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'already_decided');
  });

  it('S13.11 — an oversized title is refused 422 bad_request naming the field', async () => {
    const h = await makeEdge(
      { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
      {
        caps: {
          ringCapacity: 500,
          toolResultBytes: 65536,
          subscriberQueueHighWater: 1000,
          keepaliveMs: 15000,
          auditPageMax: 200,
          reviewBodyBytes: 1024,
          requisitionTextBytes: 8,
          standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
        },
      },
      undefined,
      (c, s) => createRecords({ config: c, store: s }),
    );
    const res = await post(h, '/api/requisitions', { title: 'way too long for eight bytes', justification: 'ok', workspace: '/w', vendor: 'claude' });
    assert.equal(res.status, 422);
    const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
    assert.equal(err.detail?.field, 'title');
  });
});

describe('S15 — POST/GET /api/reviews, POST /api/reviews/:id, POST /api/reviews/:id/finalise', () => {
  it('S15.2 — creates a draft for a session the caller does not own, with the snapshot copied at authorship', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const id = await newSession(h, 'r1', 'alice');

    const created = await post(h, '/api/reviews', { subject: id, rating: 'meets', pip: false, body: 'solid work' }, 'bob');
    assert.equal(created.status, 201, `create failed: ${await created.clone().text()}`);
    const body = (await created.json()) as { review: { reviewId: string; state: string; author: string; snapshot: { sessionId: string; owner: string } } };
    assert.equal(body.review.state, 'draft');
    assert.equal(body.review.author, 'bob');
    assert.equal(body.review.snapshot.sessionId, id);
    assert.equal(body.review.snapshot.owner, 'alice');
  });

  it('an unknown subject is refused 404 no_such_session', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const res = await post(h, '/api/reviews', { subject: 'no-such-session', rating: null, pip: false, body: 'x' });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
  });

  it('S15.7 — an unrecognised rating token is refused 422 bad_request naming the field', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const id = await newSession(h, 'r2');
    const res = await post(h, '/api/reviews', { subject: id, rating: 'amazing', pip: false, body: 'x' });
    assert.equal(res.status, 422);
    const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
    assert.equal(err.code, 'bad_request');
    assert.equal(err.detail?.field, 'rating');
  });

  it('S15.3/S15.4/S15.6 — a draft is invisible to another operator, and finalising makes it readable and listed', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const id = await newSession(h, 'r3');
    const created = await post(h, '/api/reviews', { subject: id, rating: null, pip: true, body: 'draft body' }, 'alice');
    const { review } = (await created.json()) as { review: { reviewId: string } };

    const listedWhileDraft = await get(h, `/api/reviews?subject=${id}`, 'carol');
    assert.equal(((await listedWhileDraft.json()) as { reviews: unknown[] }).reviews.length, 0);

    const readByOther = await get(h, `/api/reviews/${review.reviewId}`, 'carol');
    assert.equal(readByOther.status, 404);
    assert.equal(((await readByOther.json()) as { error: { code: string } }).error.code, 'no_such_review');

    const finalised = await post(h, `/api/reviews/${review.reviewId}/finalise`, {}, 'alice');
    assert.equal(finalised.status, 200, `finalise failed: ${await finalised.clone().text()}`);
    assert.equal(((await finalised.json()) as { review: { state: string } }).review.state, 'final');

    const readAfter = await get(h, `/api/reviews/${review.reviewId}`, 'carol');
    assert.equal(readAfter.status, 200);

    const listedAfter = await get(h, `/api/reviews?subject=${id}`, 'carol');
    const listedBody = (await listedAfter.json()) as { reviews: Array<{ reviewId: string }> };
    assert.equal(listedBody.reviews.length, 1);
    assert.equal(listedBody.reviews[0]!.reviewId, review.reviewId);

    const secondFinalise = await post(h, `/api/reviews/${review.reviewId}/finalise`, {}, 'alice');
    assert.equal(secondFinalise.status, 409);
    assert.equal(((await secondFinalise.json()) as { error: { code: string } }).error.code, 'review_final');
  });

  it('S15.5 — POST /api/reviews/:id edits a draft in place from the caller\'s point of view', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const id = await newSession(h, 'r4');
    const created = await post(h, '/api/reviews', { subject: id, rating: null, pip: false, body: 'v1' }, 'alice');
    const { review } = (await created.json()) as { review: { reviewId: string } };

    const edited = await post(h, `/api/reviews/${review.reviewId}`, { body: 'v2' }, 'alice');
    assert.equal(edited.status, 200, `edit failed: ${await edited.clone().text()}`);
    assert.equal(((await edited.json()) as { review: { body: string } }).review.body, 'v2');

    const editByOther = await post(h, `/api/reviews/${review.reviewId}`, { body: 'hijacked' }, 'carol');
    assert.equal(editByOther.status, 404);
  });

  it('S15.8 — an oversized body is refused 422 bad_request naming the field', async () => {
    const h = await makeEdge(
      { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
      {
        caps: {
          ringCapacity: 500,
          toolResultBytes: 65536,
          subscriberQueueHighWater: 1000,
          keepaliveMs: 15000,
          auditPageMax: 200,
          reviewBodyBytes: 8,
          requisitionTextBytes: 1024,
          standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
        },
      },
      undefined,
      (c, s) => createRecords({ config: c, store: s }),
    );
    const id = await newSession(h, 'r5');
    const res = await post(h, '/api/reviews', { subject: id, rating: null, pip: false, body: 'way too long for eight bytes' });
    assert.equal(res.status, 422);
    const err = ((await res.json()) as { error: { code: string; detail?: { field?: string } } }).error;
    assert.equal(err.code, 'bad_request');
    assert.equal(err.detail?.field, 'body');
  });

  it('S15.10 — a review survives DELETE /api/sessions/:id and renders from its snapshot', async () => {
    const h = await makeEdge(undefined, undefined, undefined, (c, s) => createRecords({ config: c, store: s }));
    const id = await newSession(h, 'r6');
    const created = await post(h, '/api/reviews', { subject: id, rating: null, pip: false, body: 'x' }, 'alice');
    const { review } = (await created.json()) as { review: { reviewId: string } };
    await post(h, `/api/reviews/${review.reviewId}/finalise`, {}, 'alice');

    const ended = await post(h, `/api/sessions/${id}/end`, {});
    assert.equal(ended.status, 200);
    const deleted = await fetch(`${h.base}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-user': 'ben' },
    });
    assert.equal(deleted.status, 200, `delete failed: ${await deleted.clone().text()}`);

    const read = await get(h, `/api/reviews/${review.reviewId}`, 'carol');
    assert.equal(read.status, 200);
    const body = (await read.json()) as { review: { snapshot: { sessionId: string } } };
    assert.equal(body.review.snapshot.sessionId, id);
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
        keepaliveMs: 15000, auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024, standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
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
        keepaliveMs: 60, auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024, standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
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

  it("scope: 'always' with no rule is refused 422 bad_request naming rule, and a well-formed 'always' answer now succeeds (S4.12's blanket refusal is removed by S10.6)", async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'p4');
    const { requestId } = await firstPermissionRequestId(h, id);

    const noRule = await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'always', rule: null, reason: null });
    assert.equal(noRule.status, 422);
    assert.equal(((await noRule.json()) as { error: { detail?: { field?: string } } }).error.detail?.field, 'rule');

    const id2 = await newSession(h, 'p4b');
    const { requestId: requestId2 } = await firstPermissionRequestId(h, id2);
    const withRule = await post(h, `/api/sessions/${id2}/permission`, { requestId: requestId2, decision: 'allow', scope: 'always', rule: 'Bash:echo hi', reason: null });
    assert.equal(withRule.status, 200);
    assert.equal(((await withRule.json()) as { accepted: boolean }).accepted, true);
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

  it('serves theme.js — index.html loads it as a classic script ahead of the stylesheet (S18.4), so a missing route here leaves the document unthemed', async () => {
    const h = await makeEdge();
    const res = await fetch(`${h.base}/theme.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
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

describe('S25.3 — message.delta over the real SSE wire', () => {
  it('a frame is dispatched under its own event name, with no id: line', async () => {
    const h = await makeEdge(undefined, { streamDeltas: true }, 'streamed');
    const id = await newSession(h, 's25-sse');
    const events = await get(h, `/api/sessions/${id}/events`);
    await post(h, `/api/sessions/${id}/message`, { text: 'go' });

    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('"kind":"message.delta"')), 15000);
    const deltaFrame = frames.find((f) => f.includes('"kind":"message.delta"'))!;
    assert.match(deltaFrame, /^event: message\.delta$/m, 'dispatched under its own event name');
    assert.doesNotMatch(deltaFrame, /^id:/m, 'a frame carries no seq and is written with no id: line');
  });
});

describe('#178 — a route handler that throws answers 503, rather than hanging the request', () => {
  it('a records collaborator that throws on the append-review route still gets a response', async () => {
    // No `recordsOverride`: `makeEdge` wires `notImplementedProxy<Records>('records')` by
    // default, which throws synchronously on any property access — the same shape the
    // issue's own repro names ("a Proxy that throws on any property access"). Reaching
    // `deps.records.appendReview` inside the async route handler turns that throw into a
    // rejected promise; pre-fix, `return handleAppendReview(...)` (no `await`) inside the
    // listener's outer `try` never routes that rejection through its `catch`, so no
    // response is ever written and the request hangs forever.
    const h = await makeEdge();
    const id = 'does-not-matter-records-throws-first';

    const res = await Promise.race([
      post(h, `/api/reviews/${id}`, {}),
      new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error('request hung: no response within 15s')), 15000).unref()),
    ]);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'agent_unavailable');
  });
});

describe('#133 — a slow live subscriber is dropped past caps.subscriberQueueHighWater', () => {
  it('a client that never reads is dropped with a replay_gap frame, and the server closes the connection', async () => {
    const h = await makeEdge(
      undefined,
      {
        caps: {
          ringCapacity: 500,
          toolResultBytes: 65536,
          subscriberQueueHighWater: 2, // low enough that a megabyte-scale undrained burst reliably crosses it
          keepaliveMs: 15000,
          auditPageMax: 200,
          reviewBodyBytes: 1024,
          requisitionTextBytes: 1024,
          standingRuleBytes: 1024,
          attachmentBytes: 10485760,
          attachmentCount: 5,
          sessionToolOutputBytes: 10485760,
        },
      },
      'many-big',
    );
    const id = await newSession(h, 'w133-sse');

    // A raw request whose response is left paused — no `data` listener, no `.resume()` —
    // so Node's own backpressure holds the OS receive window shut, the same as a browser
    // tab that has stopped reading. `fetch`'s reader would risk reading ahead internally;
    // the raw client here is what actually withholds every byte.
    const rawRes = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${h.base}/api/sessions/${id}/events`, { headers: { 'x-forwarded-user': 'ben' } });
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawRes.statusCode, 200);

    await post(h, `/api/sessions/${id}/message`, { text: 'go' });

    // #246: withhold reading for a fixed real-time window before draining at all.
    // Production speed is not reliable across environments — CI's Windows runner has been
    // observed delivering the burst as a slow trickle an actively-draining client can keep
    // pace with indefinitely, regardless of total volume. TCP flow control only closes the
    // window when nothing reads it, whatever the peer's write rate; a fixed real delay with
    // zero consumption forces genuine backpressure everywhere the fast-burst assumption
    // this scenario used to rely on alone did not.
    await new Promise((resolve) => setTimeout(resolve, 3000).unref());

    // The burst is megabytes and the client has read nothing at all yet, so by the time
    // this resolves the server has already forced real backpressure and, past a
    // high-water mark of 2, dropped the subscriber — writing the gap frame and calling
    // `res.end()`. That final write cannot itself flush to a peer that never reads, so
    // waiting for a `'close'` event *before* reading would deadlock: draining is what
    // unblocks the server's own pending end-of-response write, not something that can wait
    // for it. One persistent `'data'` listener (switching the stream to flowing mode once,
    // not per-chunk) avoids the gap a `.once`-per-iteration loop would have between an
    // event firing and the next listener being attached.
    const raw: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for the drop; saw ${raw.length} chunks`)), 20000);
      timer.unref();
      rawRes.on('data', (c: Buffer) => raw.push(c));
      rawRes.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      rawRes.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const text = Buffer.concat(raw).toString('utf8');
    assert.match(text, /"kind":"replay_gap"/, 'a replay_gap envelope was delivered before the drop');
    assert.match(text, /"fatal":false/, 'the gap is reported non-fatal, same shape session-manager.subscribe mints');
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

describe('S6 — GET .../checkpoints, POST .../checkpoint/restore', () => {
  /** Runs one turn to completion (allow) and returns the pre-turn checkpoint's sha. */
  async function checkpointedSha(h: Harness, id: string): Promise<string> {
    const events = await get(h, `/api/sessions/${id}/events`);
    const { requestId } = await firstPermissionRequestId(h, id);
    await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: null, reason: null });
    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('"kind":"turn.ended"')));
    const created = frames.find((f) => f.includes('event: checkpoint.created'))!;
    const dataLine = created.split('\n').find((l) => l.startsWith('data: '))!;
    return (JSON.parse(dataLine.slice('data: '.length)) as { data: { sha: string } }).data.sha;
  }

  // The turn slot frees only once turn.ended's durable write has landed, slightly after
  // the client observes the SSE frame (the same S3.7/S4.15/S5.9 race) — retry rather than
  // assert once on the very next request after a `turn.ended` this test just saw.
  async function restoreAfterTurnEnds(h: Harness, id: string, sha: string): Promise<Response> {
    for (;;) {
      const res = await post(h, `/api/sessions/${id}/checkpoint/restore`, { sha });
      if (res.status === 409) {
        const body = (await res.clone().json()) as { error: { code: string } };
        if (body.error.code === 'turn_in_flight') {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
      }
      return res;
    }
  }

  it('GET /checkpoints returns 200 { checkpoints } including the pre-turn checkpoint (S6.2)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c1');
    const sha = await checkpointedSha(h, id);

    const res = await get(h, `/api/sessions/${id}/checkpoints`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { checkpoints: Array<{ sha: string }> };
    assert.ok(body.checkpoints.some((c) => c.sha === sha));
  });

  it('GET /checkpoints is 404 no_such_session for another operator', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c2', 'ben');
    const res = await get(h, `/api/sessions/${id}/checkpoints`, 'mallory');
    assert.equal(res.status, 404);
  });

  it('POST /checkpoint/restore returns 200 { ok: true } and a later restore of the resulting safety checkpoint is possible (S6.4)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c3');
    const sha = await checkpointedSha(h, id);

    const res = await restoreAfterTurnEnds(h, id, sha);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);

    const listed = await get(h, `/api/sessions/${id}/checkpoints`);
    const body = (await listed.json()) as { checkpoints: Array<{ sha: string; label: string }> };
    assert.ok(body.checkpoints.some((c) => c.label.includes('before restore to')), 'the safety checkpoint is listed');
  });

  it('POST /checkpoint/restore is 404 no_such_checkpoint for an unknown sha (S6.5)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c4');
    await checkpointedSha(h, id);

    const res = await restoreAfterTurnEnds(h, id, '0'.repeat(40));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_checkpoint');
  });

  it('POST /checkpoint/restore is 409 turn_in_flight while a turn runs (S6.5)', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c5');
    const { requestId } = await firstPermissionRequestId(h, id);
    void requestId; // the turn is now live and stalled on this request

    const res = await post(h, `/api/sessions/${id}/checkpoint/restore`, { sha: '0'.repeat(40) });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'turn_in_flight');
  });

  it('POST /checkpoint/restore refuses a missing sha with 422 bad_request', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c6');
    const res = await post(h, `/api/sessions/${id}/checkpoint/restore`, {});
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { detail?: { field?: string } } }).error.detail?.field, 'sha');
  });

  it('POST /checkpoint/restore is 404 no_such_session for another operator', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c7', 'ben');
    const res = await post(h, `/api/sessions/${id}/checkpoint/restore`, { sha: '0'.repeat(40) }, 'mallory');
    assert.equal(res.status, 404);
  });

  it('POST /checkpoint/restore is 403 bad_origin cross-origin', async () => {
    const h = await makeEdge();
    const id = await newSession(h, 'c8');
    const res = await fetch(`${h.base}/api/sessions/${id}/checkpoint/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-user': 'ben', origin: 'https://evil.example' },
      body: JSON.stringify({ sha: '0'.repeat(40) }),
    });
    assert.equal(res.status, 403);
  });
});

const S9_CAPS: Config['caps'] = {
  ringCapacity: 500,
  toolResultBytes: 1024,
  subscriberQueueHighWater: 1000,
  keepaliveMs: 15000,
  auditPageMax: 200,
  reviewBodyBytes: 1024,
  requisitionTextBytes: 1024,
  standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
};

describe('S9.2/S9.3/S9.5 — GET .../tool-output/:turnId/:callId', () => {
  // A fresh GET /events replays the whole spill (D40), so a second call on the same
  // session sees the first turn's history too — filtering every frame by this turn's own
  // `turnId` (from the POST /message response, not the stream) is what keeps a second
  // truncated turn on the same session from picking up the first one's frames instead.
  function findOwnFrame(frames: string[], kind: string, turnId: string): string {
    return frames.find((f) => f.includes(`event: ${kind}`) && f.includes(`"turnId":"${turnId}"`))!;
  }

  /** Runs one turn whose tool.result is over the cap, and returns its (turnId, callId, bytes). */
  async function runTruncatedTurn(h: Harness, id: string, bigBytes: number): Promise<{ turnId: string; callId: string; bytes: number }> {
    process.env['SKYNET_BIG_TOOL_RESULT_BYTES'] = String(bigBytes);
    const events = await get(h, `/api/sessions/${id}/events`);
    const sent = await post(h, `/api/sessions/${id}/message`, { text: 'go' });
    const { turnId } = (await sent.json()) as { turnId: string };

    const { frames: reqFrames } = await readFrames(events, (f) => findOwnFrame(f, 'permission.request', turnId) !== undefined);
    const reqFrame = findOwnFrame(reqFrames, 'permission.request', turnId);
    const requestId = (JSON.parse(reqFrame.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { data: { requestId: string } }).data.requestId;
    await post(h, `/api/sessions/${id}/permission`, { requestId, decision: 'allow', scope: 'once', rule: null, reason: null });

    // `readFrames` cancels the reader it hands back, so the same connection cannot be
    // read twice — this is a fresh one, replaying history filtered by `turnId` again.
    const events2 = await get(h, `/api/sessions/${id}/events`);
    const { frames } = await readFrames(events2, (f) => findOwnFrame(f, 'tool.result', turnId) !== undefined);
    const frame = findOwnFrame(frames, 'tool.result', turnId);
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const envelope = JSON.parse(dataLine.slice('data: '.length)) as { data: { turnId: string; callId: string; truncated: boolean; bytes: number } };
    assert.equal(envelope.data.truncated, true, 'the fixture emitted enough bytes to cross the cap');
    return { turnId: envelope.data.turnId, callId: envelope.data.callId, bytes: envelope.data.bytes };
  }

  /**
   * The blob write behind a truncated envelope is fire-and-forget by design
   * (session-manager's comment at the `writeToolOutput` call site, I1/I27: awaiting disk
   * I/O before `emit` would let a later notification claim a lower `seq`). So a GET issued
   * the instant the truncated envelope is observed can legitimately still see `404
   * no_such_output` while the write is in flight — S9.5 names that outcome, not a bug — and
   * on a loaded or slow-disk runner (windows-latest under the full matrix) the gap is wide
   * enough to hit routinely. This is a test synchronization gap, the same category #110
   * was (src/session-manager/index.test.ts): poll until the write has actually landed
   * rather than asserting against a single, unsynchronized read.
   */
  async function getBlobWhenReady(h: Harness, url: string, operator = 'ben'): Promise<Response> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const res = await get(h, url, operator);
      if (res.status !== 404) return res;
      const body = (await res.json()) as { error?: { code?: string } };
      if (body.error?.code !== 'no_such_output' || Date.now() >= deadline) return res;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('serves 200 text/plain with nosniff and attachment, and the full pre-truncation byte count', async () => {
    const h = await makeEdge(undefined, { caps: S9_CAPS }, 'big-tool-result');
    const id = await newSession(h, 't1');
    const { turnId, callId, bytes } = await runTruncatedTurn(h, id, 5000);

    const res = await getBlobWhenReady(h, `/api/sessions/${id}/tool-output/${turnId}/${callId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain; charset=utf-8/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    const body = await res.text();
    assert.equal(body.length, bytes, 'the fetched body is the untruncated size, not the capped envelope');
  });

  it('is 404 no_such_session for another operator, indistinguishable from a session that never existed (I23/D43)', async () => {
    const h = await makeEdge(undefined, { caps: S9_CAPS }, 'big-tool-result');
    const id = await newSession(h, 't2', 'ben');
    const { turnId, callId } = await runTruncatedTurn(h, id, 5000);

    const res = await get(h, `/api/sessions/${id}/tool-output/${turnId}/${callId}`, 'mallory');
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_session');
  });

  it('is 404 no_such_output for a callId that was never truncated, and for a turnId that never ran (S9.5)', async () => {
    const h = await makeEdge(undefined, { caps: S9_CAPS }, 'big-tool-result');
    const id = await newSession(h, 't3');
    const { turnId } = await runTruncatedTurn(h, id, 5000);

    const wrongCall = await get(h, `/api/sessions/${id}/tool-output/${turnId}/call-does-not-exist`);
    assert.equal(wrongCall.status, 404);
    assert.equal(((await wrongCall.json()) as { error: { code: string } }).error.code, 'no_such_output');

    const wrongTurn = await get(h, `/api/sessions/${id}/tool-output/turn-does-not-exist/call-1`);
    assert.equal(wrongTurn.status, 404);
    assert.equal(((await wrongTurn.json()) as { error: { code: string } }).error.code, 'no_such_output');
  });

  it('two turns emitting the same callId keep separate blobs, each fetchable only by its own turnId (S9.4)', async () => {
    const h = await makeEdge(undefined, { caps: S9_CAPS }, 'big-tool-result');
    const id = await newSession(h, 't4');
    const first = await runTruncatedTurn(h, id, 5000);
    const second = await runTruncatedTurn(h, id, 6000);
    assert.equal(first.callId, second.callId, 'the fixture reuses call-1 on every turn (test setup)');
    assert.notEqual(first.turnId, second.turnId);

    const firstBody = await (await getBlobWhenReady(h, `/api/sessions/${id}/tool-output/${first.turnId}/${first.callId}`)).text();
    const secondBody = await (await getBlobWhenReady(h, `/api/sessions/${id}/tool-output/${second.turnId}/${second.callId}`)).text();
    assert.equal(firstBody.length, 5000);
    assert.equal(secondBody.length, 6000);
  });
});

describe('S21 — attachments', () => {
  const PNG_BYTES = 'not-really-a-png-just-test-bytes';
  const attachmentUpload = (overrides: Record<string, unknown> = {}) => ({
    filename: 'bug.png',
    mediaType: 'image/png',
    dataBase64: Buffer.from(PNG_BYTES, 'utf8').toString('base64'),
    ...overrides,
  });

  async function sendWithAttachment(h: Harness, id: string, attachments: unknown[], operator = 'ben') {
    const events = await get(h, `/api/sessions/${id}/events`, operator);
    const sent = await post(h, `/api/sessions/${id}/message`, { text: 'see attached', attachments }, operator);
    return { sent, events };
  }

  it('S21.2 — POST /message with an attachment returns 202 { turnId }, and the replayed message envelope carries one AttachmentRef with filename, mediaType and bytes', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 'att1');
    const { sent, events } = await sendWithAttachment(h, id, [attachmentUpload()]);
    assert.equal(sent.status, 202, `message failed: ${await sent.clone().text()}`);
    const { turnId } = (await sent.json()) as { turnId: string };

    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('event: message') && x.includes('"role":"user"')));
    const frame = frames.find((f) => f.includes('event: message') && f.includes('"role":"user"'))!;
    const envelope = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)) as {
      data: { turnId: string; role: string; text: string; attachments: Array<{ attachmentId: string; filename: string; mediaType: string; bytes: number }> };
    };
    assert.equal(envelope.data.turnId, turnId);
    assert.equal(envelope.data.attachments.length, 1);
    assert.equal(envelope.data.attachments[0]!.filename, 'bug.png');
    assert.equal(envelope.data.attachments[0]!.mediaType, 'image/png');
    assert.equal(envelope.data.attachments[0]!.bytes, Buffer.byteLength(PNG_BYTES, 'utf8'));
  });

  it('S21.5 — an oversized attachment, or too many attachments, is 422 bad_request naming attachments, and nothing is written', async () => {
    const h = await makeEdge(undefined, { caps: { ...S9_CAPS, attachmentBytes: 8, attachmentCount: 1 } }, 'error-result');
    const id = await newSession(h, 'att2');

    const tooBig = await post(h, `/api/sessions/${id}/message`, { text: 'go', attachments: [attachmentUpload()] });
    assert.equal(tooBig.status, 422);
    const tooBigBody = (await tooBig.json()) as { error: { code: string; detail?: { field?: string } } };
    assert.equal(tooBigBody.error.code, 'bad_request');
    assert.equal(tooBigBody.error.detail?.field, 'attachments');

    const tooMany = await post(h, `/api/sessions/${id}/message`, {
      text: 'go',
      attachments: [attachmentUpload({ dataBase64: Buffer.from('a').toString('base64') }), attachmentUpload({ dataBase64: Buffer.from('b').toString('base64') })],
    });
    assert.equal(tooMany.status, 422);
    const tooManyBody = (await tooMany.json()) as { error: { code: string; detail?: { field?: string } } };
    assert.equal(tooManyBody.error.code, 'bad_request');
    assert.equal(tooManyBody.error.detail?.field, 'attachments');

    assert.equal(existsSync(path.join(h.storageRoot, 'sessions', id, 'attachments')), false);
  });

  it('S21.6 — GET .../attachments/:turnId/:attachmentId serves nosniff always, inline for an allow-listed image and attachment otherwise, echoing the stored mediaType only for the allow-list', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 'att3');
    const { sent, events } = await sendWithAttachment(h, id, [
      attachmentUpload({ filename: 'shot.png', mediaType: 'image/png' }),
      attachmentUpload({ filename: 'evil.html', mediaType: 'text/html', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') }),
    ]);
    assert.equal(sent.status, 202, `message failed: ${await sent.clone().text()}`);
    const { turnId } = (await sent.json()) as { turnId: string };

    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('event: message') && x.includes('"role":"user"')));
    const frame = frames.find((f) => f.includes('event: message') && f.includes('"role":"user"'))!;
    const envelope = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)) as {
      data: { attachments: Array<{ attachmentId: string; mediaType: string }> };
    };
    const [png, html] = envelope.data.attachments;

    const pngRes = await get(h, `/api/sessions/${id}/attachments/${turnId}/${png!.attachmentId}`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('x-content-type-options'), 'nosniff');
    // S21 fix: an allow-listed image is served `inline` so the client's own `<img src>`
    // actually paints it in every browser (Safari/WebKit honors `Content-Disposition` even
    // on an `<img>` subresource fetch, unlike Chrome/Firefox).
    assert.equal(pngRes.headers.get('content-disposition'), 'inline');
    assert.match(pngRes.headers.get('content-type') ?? '', /^image\/png/);
    assert.equal(await pngRes.text(), PNG_BYTES);

    const htmlRes = await get(h, `/api/sessions/${id}/attachments/${turnId}/${html!.attachmentId}`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlRes.headers.get('content-disposition'), 'attachment');
    // D160: an operator-declared text/html is never echoed unguarded — it is what would
    // make this stored XSS holding the console's credentials.
    assert.match(htmlRes.headers.get('content-type') ?? '', /^application\/octet-stream/);
  });

  it('S21.7 — another operator gets 404 no_such_session; a missing turn or attachment id is 404 no_such_attachment; a reconnect replays the same ref', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 'att4');
    const { sent, events } = await sendWithAttachment(h, id, [attachmentUpload()]);
    const { turnId } = (await sent.json()) as { turnId: string };
    const { frames } = await readFrames(events, (f) => f.some((x) => x.includes('event: message') && x.includes('"role":"user"')));
    const frame = frames.find((f) => f.includes('event: message') && f.includes('"role":"user"'))!;
    const envelope = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)) as {
      data: { attachments: Array<{ attachmentId: string }> };
    };
    const attachmentId = envelope.data.attachments[0]!.attachmentId;

    const mallory = await get(h, `/api/sessions/${id}/attachments/${turnId}/${attachmentId}`, 'mallory');
    assert.equal(mallory.status, 404);
    assert.equal(((await mallory.json()) as { error: { code: string } }).error.code, 'no_such_session');

    const wrongAttachment = await get(h, `/api/sessions/${id}/attachments/${turnId}/does-not-exist`);
    assert.equal(wrongAttachment.status, 404);
    assert.equal(((await wrongAttachment.json()) as { error: { code: string } }).error.code, 'no_such_attachment');

    const wrongTurn = await get(h, `/api/sessions/${id}/attachments/does-not-exist/${attachmentId}`);
    assert.equal(wrongTurn.status, 404);
    assert.equal(((await wrongTurn.json()) as { error: { code: string } }).error.code, 'no_such_attachment');

    // A reconnect (a fresh /events subscription) renders the same ref from the spill.
    const reconnected = await get(h, `/api/sessions/${id}/events`);
    const { frames: replayed } = await readFrames(reconnected, (f) => f.some((x) => x.includes('event: message') && x.includes('"role":"user"')));
    const replayedFrame = replayed.find((f) => f.includes('event: message') && f.includes('"role":"user"'))!;
    const replayedEnvelope = JSON.parse(replayedFrame.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)) as {
      data: { attachments: Array<{ attachmentId: string }> };
    };
    assert.deepEqual(replayedEnvelope.data.attachments, envelope.data.attachments);

    const stillFetchable = await get(h, `/api/sessions/${id}/attachments/${turnId}/${attachmentId}`);
    assert.equal(stillFetchable.status, 200);
  });

  it('S21.9 — DELETE removes attachments/ with the rest, and audit.ndjson stays byte-identical', async () => {
    const h = await makeEdge(undefined, undefined, 'error-result');
    const id = await newSession(h, 'att5');
    const { events } = await sendWithAttachment(h, id, [attachmentUpload()]);
    // DELETE refuses 409 turn_in_flight while the turn is running — wait for it to end,
    // the same way every other test in this file that deletes after a message does.
    await readFrames(events, (f) => f.some((x) => x.includes('event: turn.ended')));

    const attachmentsDir = path.join(h.storageRoot, 'sessions', id, 'attachments');
    assert.equal(existsSync(attachmentsDir), true, 'the attachment was actually written before deletion');

    const auditPath = path.join(h.storageRoot, 'audit.ndjson');
    const auditBefore = existsSync(auditPath) ? await readFile(auditPath, 'utf8') : null;

    const deleted = await fetch(`${h.base}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-user': 'ben' },
    });
    assert.equal(deleted.status, 200);

    assert.equal(existsSync(path.join(h.storageRoot, 'sessions', id)), false);
    const auditAfter = existsSync(auditPath) ? await readFile(auditPath, 'utf8') : null;
    assert.equal(auditAfter, auditBefore, 'audit.ndjson is byte-identical across the delete (D25)');
  });
});

describe('S12 — GET /api/audit', () => {
  function auditLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      ts: '2026-08-13T00:00:00.000Z',
      operator: 'alice',
      sessionId: 'sess-owned-by-alice',
      vendor: 'claude',
      sandbox: null,
      tool: 'Bash',
      input: { command: 'ls' },
      decision: 'allow',
      scope: 'once',
      reason: null,
      ...overrides,
    });
  }

  it('S12.1/S12.2 — is wired and serves 200 AuditPage', async () => {
    const h = await makeEdge();
    await writeFile(path.join(h.storageRoot, 'audit.ndjson'), auditLine() + '\n', 'utf8');
    const res = await get(h, '/api/audit');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: unknown[]; nextCursor: string | null };
    assert.equal(body.records.length, 1);
    assert.equal(body.nextCursor, null);
  });

  it('S12.7 — is readable by every authenticated operator, not scoped to the caller — and refuses no identity with 401', async () => {
    const h = await makeEdge();
    // Written by "alice", never a session "bob" owns or created.
    await writeFile(path.join(h.storageRoot, 'audit.ndjson'), auditLine({ operator: 'alice', sessionId: 'sess-owned-by-alice' }) + '\n', 'utf8');

    const asBob = await get(h, '/api/audit', 'bob');
    assert.equal(asBob.status, 200);
    const body = (await asBob.json()) as { records: Array<{ operator: string; sessionId: string }> };
    assert.equal(body.records.length, 1, 'bob reads alice\'s record in full (D70)');
    assert.equal(body.records[0]!.operator, 'alice');
    assert.equal(body.records[0]!.sessionId, 'sess-owned-by-alice');

    const noIdentity = await fetch(`${h.base}/api/audit`, { headers: {} });
    assert.equal(noIdentity.status, 401);
    assert.equal(((await noIdentity.json()) as { error: { code: string } }).error.code, 'unauthenticated');
  });

  it('S12.5 — an altered cursor is refused 422 bad_request rather than followed', async () => {
    const h = await makeEdge();
    await writeFile(path.join(h.storageRoot, 'audit.ndjson'), [auditLine(), auditLine()].join('\n') + '\n', 'utf8');
    const res = await get(h, '/api/audit?before=not-a-real-cursor');
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_request');
  });

  it('S12.3 — a limit above caps.auditPageMax is clamped rather than refused', async () => {
    const smallCap: Config['caps'] = { ...S9_CAPS, auditPageMax: 3 };
    const h = await makeEdge(undefined, { caps: smallCap });
    const lines = Array.from({ length: 10 }, (_, i) => auditLine({ sessionId: `s-${i}` }));
    await writeFile(path.join(h.storageRoot, 'audit.ndjson'), lines.join('\n') + '\n', 'utf8');
    const res = await get(h, '/api/audit?limit=1000');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: unknown[] };
    assert.equal(body.records.length, 3, 'clamped to auditPageMax rather than refused');
  });

  it('S12.6 — sessionId and operator filter the served page', async () => {
    const h = await makeEdge();
    await writeFile(
      path.join(h.storageRoot, 'audit.ndjson'),
      [
        auditLine({ operator: 'alice', sessionId: 's-a' }),
        auditLine({ operator: 'bob', sessionId: 's-b' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const res = await get(h, '/api/audit?operator=bob');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: Array<{ operator: string }> };
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0]!.operator, 'bob');
  });

  it('S12.6 — a malformed since or until is refused 422 bad_request rather than silently matching nothing', async () => {
    const h = await makeEdge();
    await writeFile(path.join(h.storageRoot, 'audit.ndjson'), auditLine() + '\n', 'utf8');

    const badSince = await get(h, '/api/audit?since=not-a-date');
    assert.equal(badSince.status, 422);
    const sinceBody = (await badSince.json()) as { error: { code: string; detail: { field: string } } };
    assert.equal(sinceBody.error.code, 'bad_request');
    assert.equal(sinceBody.error.detail.field, 'since');

    const badUntil = await get(h, '/api/audit?until=2026-08-13');
    assert.equal(badUntil.status, 422);
    const untilBody = (await badUntil.json()) as { error: { code: string; detail: { field: string } } };
    assert.equal(untilBody.error.code, 'bad_request');
    assert.equal(untilBody.error.detail.field, 'until');
  });

  it('S17.1/S17.6 — incidentsOnly=true serves only the union of deny/operator-null/standing, readable by every operator across owners and deleted sessions (D70, D25)', async () => {
    const h = await makeEdge();
    await writeFile(
      path.join(h.storageRoot, 'audit.ndjson'),
      [
        auditLine({ operator: 'alice', sessionId: 's-a', decision: 'allow', scope: 'once' }), // ordinary — excluded
        auditLine({ operator: null, sessionId: 's-not-owned', decision: 'deny', scope: 'once', reason: 'cancelled_process_exit' }),
        auditLine({ operator: 'bob', sessionId: 's-deleted', decision: 'allow', scope: 'standing', reason: 'Bash:*' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const asCarol = await get(h, '/api/audit?incidentsOnly=true', 'carol');
    assert.equal(asCarol.status, 200);
    const body = (await asCarol.json()) as { records: Array<{ sessionId: string; operator: string | null; scope: string }> };
    assert.equal(body.records.length, 2, 'the ordinary allow is excluded; the forced deny and the standing allow are not');
    const sessionIds = body.records.map((r) => r.sessionId).sort();
    assert.deepEqual(sessionIds, ['s-deleted', 's-not-owned'], 'neither record belongs to carol, and one names a session that never existed for her');
  });
});
