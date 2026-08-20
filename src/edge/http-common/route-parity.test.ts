import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile, realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createSseEdge } from '../sse/index.js';
import { createWsEdge } from '../ws/index.js';
import { resolverFor } from '../../identity/index.js';
import { createSessionManager } from '../../session-manager/index.js';
import { createStore } from '../../store/index.js';
import { createCheckpoints } from '../../checkpoints/index.js';
import { createRecords } from '../../records/index.js';
import { stripExtendedPrefix } from '../../jail/index.js';
import type { Config } from '../../contract/index.js';

const readFileAsync = promisify(readFile);

// Every `:segment` in the contract's `Path` column is a route parameter; this check never
// resolves one to a real record, so any string free of `/` stands in for it — the point is
// only whether the request reaches its named handler, not what that handler then does.
function fillPlaceholders(routePath: string): string {
  return routePath.replace(/:[A-Za-z]+/g, 'ph');
}

/** Reads `## HTTP routes` out of `20-contract.md` and returns every `Method`/`Path` pair its
 * tables declare — the routing table this document owns per its own opening line ("The
 * routing table is this document's, not the tree's"), enumerated rather than restated by hand
 * (#136: a hand-asserted parity claim in prose is exactly what went stale). */
async function readContractRoutes(): Promise<Array<{ method: string; path: string }>> {
  const contractPath = path.join(process.cwd(), 'design', '20-contract.md');
  const text = await readFileAsync(contractPath, 'utf8');
  const sectionStart = text.indexOf('\n## HTTP routes');
  const sectionEnd = text.indexOf('\n## Error semantics');
  assert.ok(sectionStart !== -1 && sectionEnd !== -1 && sectionEnd > sectionStart, 'design/20-contract.md § HTTP routes was not found where this check expects it');
  const section = text.slice(sectionStart, sectionEnd);

  const routes: Array<{ method: string; path: string }> = [];
  const rowPattern = /^\| `(GET|POST|DELETE)` \| `([^`]+)` \|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(section)) !== null) {
    routes.push({ method: match[1]!, path: match[2]! });
  }
  assert.ok(routes.length > 0, 'no routes were parsed out of design/20-contract.md § HTTP routes');
  return routes;
}

const servers: Server[] = [];

interface Harness {
  readonly sseBase: string;
  readonly wsBase: string;
}

async function makeSharedEdges(): Promise<Harness> {
  process.env['SKYNET_TEST_SCENARIO'] = 'full';
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-parity-store-'));
  const workspaceRootRaw = await mkdtemp(path.join(tmpdir(), 'skynet-parity-ws-'));
  const workspaceRoot = stripExtendedPrefix(realpathSync.native(workspaceRootRaw));
  const config: Config = {
    bind: { host: '127.0.0.1', port: 0 },
    auth: { mode: 'proxy-header', userHeader: 'x-forwarded-user' },
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
  };
  const storeResult = await createStore(config);
  if (!storeResult.ok) throw new Error('store failed to init');
  const records = createRecords({ config, store: storeResult.value });
  const manager = createSessionManager({
    config,
    store: storeResult.value,
    checkpoints: createCheckpoints(config),
    records,
  });
  const deps = { config, identity: resolverFor(config.auth, config.trustProxy), manager, records };

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

  return { sseBase: `http://127.0.0.1:${sseAddr.port}`, wsBase: `http://127.0.0.1:${wsAddr.port}` };
}

// The exact refusal every edge's catch-all falls back to for a path or sub-path it does not
// route at all — `edge/sse/index.ts` and `edge/ws/index.ts` both send this literal message.
// Any other response — success, a real refusal, even an unhandled-handler 500 — proves the
// route reached its named handler instead of falling through to here.
const NOT_WIRED_MESSAGE = 'that route is not available in this build';

async function hitsCatchAll(base: string, method: string, routePath: string): Promise<boolean> {
  // `GET .../events` on `edge/sse` is the one route that answers `200 text/event-stream` and
  // never closes its body on its own (D21: no server-side timer) — reading it to completion
  // here would hang forever. A live `/events` stream is unambiguous proof the route is wired,
  // so this is checked by status and content-type alone, the response aborted immediately
  // after — never by waiting on a body this check has no reason to drain.
  if (routePath.endsWith('/events') && method === 'GET') {
    const controller = new AbortController();
    const res = await fetch(`${base}${routePath}`, {
      headers: { 'x-forwarded-user': 'ben' },
      signal: controller.signal,
    });
    const isEventStream = res.headers.get('content-type')?.startsWith('text/event-stream') ?? false;
    controller.abort();
    if (isEventStream) return false;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message === NOT_WIRED_MESSAGE;
  }

  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-user': 'ben',
    },
  };
  if (method !== 'GET' && method !== 'DELETE') init.body = '{}';
  const res = await fetch(`${base}${routePath}`, init);
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message === NOT_WIRED_MESSAGE;
}

describe('#136/D144 — edge/ws serves every route in design/20-contract.md § HTTP routes', () => {
  it('every enumerated route is wired on both edge/sse and edge/ws', async () => {
    const routes = await readContractRoutes();
    const h = await makeSharedEdges();
    try {
      for (const route of routes) {
        const routePath = fillPlaceholders(route.path);
        const sseHit = await hitsCatchAll(h.sseBase, route.method, routePath);
        assert.equal(sseHit, false, `edge/sse falls through to its catch-all for ${route.method} ${route.path}`);
        const wsHit = await hitsCatchAll(h.wsBase, route.method, routePath);
        assert.equal(wsHit, false, `edge/ws falls through to its catch-all for ${route.method} ${route.path}`);
      }
    } finally {
      for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
    }
  });
});
