import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Black-box, subprocess-level coverage of `server.ts`'s own shutdown ordering (S27.1,
// S27.2, S27.3, S27.10, S27.12 — `design/30-slices.md` § S27) — the criteria that live in
// the composition root itself, not in `session-manager`, and so cannot be exercised by
// calling `SessionManager.shutdown()` directly the way `session-manager/index.test.ts`'s
// own S27.5/S27.6/S27.8/S27.9/S27.11/S27.13 tests do. `main()` is never imported in-process
// for this: a second `SIGTERM` is a real `process.exit(1)` (S27.1), and running that against
// the test runner's own process would abort every other test still in flight.
const SERVER_ENTRY = path.join(process.cwd(), 'dist', 'server.js');
const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

const liveServers: ChildProcess[] = [];
after(() => {
  for (const child of liveServers) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern} in:\n${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const m = pattern.exec(buf);
      if (m) {
        cleanup();
        resolve(buf);
      }
    };
    // A server that refuses to start (`refuseToStart`, a failed boot, a claimed lock) is
    // gone in milliseconds and will never print this pattern. Without this the caller waits
    // out the whole timeout and is handed an empty stdout buffer, while the one line saying
    // why sits unread on stderr — `startServer` appends that buffer to this message.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`server exited (code ${code}, signal ${signal}) before ${pattern} was seen; stdout:\n${buf}`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    }
    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

// Bounded, and the bound is the point: every criterion here is about a process that exits,
// so an unbounded wait turns the regression these tests exist to catch — a shutdown that
// never reaches `process.exit` — into a hung suite rather than a failed assertion. `node
// --test` applies no per-test timeout of its own. The default sits well above the server's
// own worst case, DRAIN_TIMEOUT_MS (5s) + RELEASE_LOCK_TIMEOUT_MS (2s).
function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', onExit);
  });
}

let nextPortOffset = 0;

async function startServer(overrideEnv: Record<string, string> = {}): Promise<{
  child: ChildProcess;
  port: number;
  storageRoot: string;
  workspaceRoot: string;
  stderr: () => string;
}> {
  const storageRoot = overrideEnv['STORAGE_ROOT'] ?? (await mkdtemp(path.join(tmpdir(), 'skynet-server-storage-')));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'skynet-server-ws-'));
  // Not 0: `server.ts` logs the port it was configured with, not the OS-assigned one, so a
  // dynamic port would make the "listening" line unusable for readiness detection. Offset
  // by this process's own pid and a per-call counter, so two servers started by the same
  // test file never collide.
  const port = 21000 + (process.pid % 2000) + nextPortOffset++;

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      BIND_HOST: '127.0.0.1',
      BIND_PORT: String(port),
      AUTH_MODE: 'shared-secret',
      AUTH_COOKIE_NAME: 'skynet_hr_session',
      AUTH_SECRET: 'server-test-secret',
      WORKSPACE_ROOTS: workspaceRoot,
      STORAGE_ROOT: storageRoot,
      ALLOWED_ORIGINS: 'http://skynet-hr.test',
      SKYNET_CLAUDE_EXECUTABLE: FIXTURE,
      SKYNET_TEST_SCENARIO: 'grandchild',
      SKYNET_GRANDCHILD_MARKER: path.join(storageRoot, 'grandchild-marker.json'),
      ...overrideEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveServers.push(child);
  let stderrBuf = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrBuf += c.toString('utf8');
  });
  try {
    await waitForOutput(child, /listening on/);
  } catch (err) {
    // `refuseToStart`, a failed boot and a refused lock claim all report on stderr and
    // nowhere else, so a readiness failure without it names no cause at all.
    throw new Error(`${(err as Error).message}\nstderr:\n${stderrBuf}`);
  }
  return { child, port, storageRoot, workspaceRoot, stderr: () => stderrBuf };
}

function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { body?: unknown; cookie?: string; origin?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
    if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
    if (opts.origin !== undefined) headers['origin'] = opts.origin;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Logs in, creates one session and opens its `/events` stream, leaving the connection open
// (the SSE request is never ended) — the "subscriber that never disconnects" S27.3 names.
async function openSubscribedSession(port: number, workspaceRoot: string): Promise<{ cookie: string; sseReq: http.ClientRequest; sseRes: http.IncomingMessage }> {
  const login = await request(port, 'POST', '/api/login', { body: { secret: 'server-test-secret' }, origin: 'http://skynet-hr.test' });
  assert.equal(login.status, 200, `login: ${login.body}`);
  const setCookie = login.headers['set-cookie']?.[0];
  assert.ok(setCookie, 'login set a cookie');
  const cookie = setCookie!.split(';')[0]!;

  const created = await request(port, 'POST', '/api/sessions', {
    body: { cwd: workspaceRoot, vendor: 'claude', model: null, sandbox: null },
    cookie,
    origin: 'http://skynet-hr.test',
  });
  assert.equal(created.status, 201, `create: ${created.body}`);
  const { sessionId } = JSON.parse(created.body) as { sessionId: string };

  const messaged = await request(port, 'POST', `/api/sessions/${sessionId}/message`, {
    body: { text: 'go', attachments: [] },
    cookie,
    origin: 'http://skynet-hr.test',
  });
  assert.equal(messaged.status, 202, `message: ${messaged.body}`);

  const { req: sseReq, res: sseRes } = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/sessions/${sessionId}/events`, headers: { cookie } },
      (res) => resolve({ req, res }),
    );
    req.on('error', reject);
    req.end();
  });
  // Drain (and discard) the stream's data so the underlying socket empties its buffer, the
  // same as a real `EventSource` reading continuously — resolved once the first byte
  // arrives, which proves the stream is actually open rather than merely requested.
  await new Promise<void>((resolve) => sseRes.once('data', () => resolve()));
  sseRes.on('data', () => {});

  return { cookie, sseReq, sseRes };
}

// `child.kill('SIGTERM')` cannot exercise `process.on('SIGTERM', ...)` on this platform:
// Windows has no real signals, so Node emulates the call as an unconditional, immediate
// termination (Node docs, `child_process.kill()`) — indistinguishable, from this test's
// side, from the target never having installed a handler at all. The deployment target is
// Linux under `tini` (the Dockerfile), where a real `SIGTERM` reaches the handler these two
// tests exist to check — until then this is the same platform divergence #28/S19 already
// names for S1.6, S5.2, S7.5 and S7.6, applied to S27's own guard and drain criteria.
test('S27.2/S27.3/S27.10/S27.12 — one signal, with a subscriber attached, still reaches a clean exit within the drain bound, closes the stream, refuses a new connection, and leaves no lock for the next boot to reclaim', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Linux-only: SIGTERM cannot be delivered to a child process on Windows (#28)');
    return;
  }
  const { child, port, storageRoot, workspaceRoot, stderr } = await startServer();
  const { sseRes } = await openSubscribedSession(port, workspaceRoot);

  const streamClosed = new Promise<void>((resolve) => {
    sseRes.on('close', () => resolve());
    sseRes.on('end', () => resolve());
  });

  const exitPromise = waitForExit(child);
  const killedAt = Date.now();
  child.kill('SIGTERM');

  // S27.2: the listener is closed at once — a new connection attempt fails rather than
  // hanging or succeeding. Given a moment for `server.close()`'s synchronous effect to
  // take hold; this is not the drain bound, which only governs already-open connections.
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(request(port, 'GET', '/api/sessions'), 'a new connection is refused once the listener is closed');

  // S27.3: the process still reaches exit 0 — well inside the drain bound, since nothing
  // in this build closes the stream on its own — and the stream the server force-closed
  // ends from the client's side too.
  const [{ code }] = await Promise.all([exitPromise, streamClosed]);
  const elapsedMs = Date.now() - killedAt;
  assert.equal(code, 0, 'a clean shutdown with a subscriber attached still exits zero (I54)');
  // The bound this criterion names, asserted rather than only described: the server's own
  // worst case is DRAIN_TIMEOUT_MS (5s) + RELEASE_LOCK_TIMEOUT_MS (2s), and nothing here
  // closes the stream on its own, so the drain runs to its full window every time.
  assert.ok(elapsedMs < 10000, `the exit lands inside the drain bound (took ${elapsedMs}ms)`);

  // S27.10: by the time exit has happened, release (step 4) has already run, so the lock
  // is gone — proxied here as "absent after a clean exit", the observable half of "only
  // after the kill step has completed" (the ordering itself is asserted at the unit level,
  // `session-manager/index.test.ts`'s S27.8, which shows the tombstone lands with no exit
  // notification ever arriving to gate it).
  assert.equal(existsSync(path.join(storageRoot, 'server.lock')), false, 'server.lock is removed by a clean shutdown');

  // S27.12: a second boot against the same storage root takes the lock outright — S22.5's
  // reclaim path, instrumented there as "found uncalled", is observed here as "logs nothing
  // about reclaiming a stale lock", which is what an operator watching stderr would see.
  const second = await startServer({ STORAGE_ROOT: storageRoot });
  assert.equal(/reclaim/i.test(second.stderr()), false, 'a clean prior shutdown leaves nothing for the next boot to reclaim');
  const secondExit = waitForExit(second.child);
  second.child.kill('SIGTERM');
  await secondExit;
});

test('S27.1 — a second signal during a stalled drain exits at once, non-zero, past every step below the guard', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Linux-only: SIGTERM cannot be delivered to a child process on Windows (#28)');
    return;
  }
  const { child, port, storageRoot, workspaceRoot } = await startServer();
  await openSubscribedSession(port, workspaceRoot);

  const exitPromise = waitForExit(child);
  child.kill('SIGTERM'); // begins the drain, bounded at 5s in this build, with the stream still open
  await new Promise((r) => setTimeout(r, 300)); // well inside the drain window
  const before = Date.now();
  child.kill('SIGTERM'); // the guard: no drain, no kill, no release — exit now
  const { code, signal } = await exitPromise;
  const elapsedMs = Date.now() - before;

  assert.ok(elapsedMs < 2000, `the guard exits at once rather than waiting out the drain (took ${elapsedMs}ms)`);
  assert.equal(signal, null, 'process.exit, not a delivered signal killing it');
  assert.notEqual(code, 0, 'the guard is the one non-zero exit in this path (D174)');
  // Past the guard nothing below it ran: the kill step never reached the lock, so release
  // never got there either, and the file this server claimed at boot is still on disk.
  assert.equal(existsSync(path.join(storageRoot, 'server.lock')), true, 'a guard exit leaves server.lock behind — nothing below it ran');
});
