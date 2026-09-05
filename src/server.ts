import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { createSseEdge } from './edge/sse/index.js';
import { createWsEdge } from './edge/ws/index.js';
import { resolverFor } from './identity/index.js';
import { createRecords } from './records/index.js';
import { createSessionManager } from './session-manager/index.js';
import { createStore } from './store/index.js';
import { createCheckpoints } from './checkpoints/index.js';
import { loadConfig } from './config/index.js';
import type { ConfigError } from './contract/index.js';

/** Fail closed, out loud, naming the fix. Never a warning (S2.8). */
function refuseToStart(error: ConfigError): never {
  const lines: string[] = [];
  switch (error.code) {
    case 'insecure_bind':
      lines.push(
        `Refusing to start: ${error.bind} is a routable address and TRUST_PROXY is empty.`,
        '',
        'The configured auth mode trusts an identity header, and a trusted header is only',
        'trustworthy if the client cannot set it. On a routable bind, anything that can reach',
        'the port can set it.',
        '',
        'Fix it by either:',
        '  - binding loopback only          BIND_HOST=127.0.0.1',
        '  - or naming the upstream proxy   TRUST_PROXY=10.0.0.1,10.0.0.2',
      );
      break;
    case 'missing_field':
      lines.push(
        `Refusing to start: ${error.field} is not set.`,
        '',
        error.field === 'AUTH_MODE'
          ? 'Every configuration must name an auth mode. Set AUTH_MODE to one of:\n' +
            '  proxy-header    with AUTH_USER_HEADER\n' +
            '  open-webui      with AUTH_USER_HEADER and AUTH_SESSION_HEADER\n' +
            '  shared-secret   with AUTH_COOKIE_NAME and AUTH_SECRET'
          : `Set ${error.field} in the environment.`,
      );
      break;
    case 'invalid_field':
      lines.push(`Refusing to start: ${error.field} is invalid — ${error.detail}.`);
      break;
  }
  console.error(lines.join('\n'));
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (!config.ok) refuseToStart(config.error);

  const store = await createStore(config.value);
  if (!store.ok) {
    console.error(`Refusing to start: the storage root could not be prepared — ${JSON.stringify(store.error)}`);
    process.exit(1);
  }

  // S27.15, test-only: forces `store.value.close()` to reject, the same way
  // `SKYNET_TEST_SCENARIO`/`SKYNET_CLAUDE_EXECUTABLE` substitute test behaviour elsewhere —
  // never set outside `server.test.ts`, and a no-op unless it is. Exercises the one branch
  // I53/D202 name that nothing in a real deployment can otherwise trigger: `Store.close()`'s
  // own contract says it never rejects, so this is what proves step 5's own catch still
  // holds if that ever stops being true.
  if (process.env['SKYNET_TEST_FORCE_STORE_CLOSE_ERROR'] === '1') {
    const realClose = store.value.close.bind(store.value);
    store.value.close = async () => {
      await realClose();
      throw new Error('forced failure for S27.15');
    };
  }

  const records = createRecords({ config: config.value, store: store.value });

  const manager = createSessionManager({
    config: config.value,
    store: store.value,
    checkpoints: createCheckpoints(config.value),
    records,
  });

  // I18: nothing is served until boot has finished. Boot ordering (`10-design.md § Boot
  // ordering`) is reap → rehydrate → close open turns → load the record logs → listen;
  // `records.boot` is step 4, after `manager.boot`'s three, because the requisition guards
  // are synchronous (D32) and so the registry must be whole before any request can reach it.
  const booted = await manager.boot();
  if (!booted.ok) {
    console.error(`Refusing to start: boot failed — ${JSON.stringify(booted.error)}`);
    process.exit(1);
  }
  await records.boot();

  const edgeDeps = {
    config: config.value,
    identity: resolverFor(config.value.auth, config.value.trustProxy),
    manager,
    records,
  };

  // D10/D117: exactly one edge binds (S11.5).
  const server = createServer();
  if (config.value.edge === 'ws') {
    const listener = createWsEdge(edgeDeps);
    server.on('request', listener);
    server.on('upgrade', listener.handleUpgrade);
  } else {
    server.on('request', createSseEdge(edgeDeps));
  }

  // A container stop is a signal, not a crash. `tini` is pid 1 in the deployment image
  // (see the Dockerfile) and forwards SIGTERM here; without a handler the process would
  // take the default terminate at whatever point the event loop happened to be, and
  // `docker stop` would wait out its grace period first.
  //
  // Six steps, in order, and the order is the point (`design/10-design.md` § *Shutdown
  // ordering*, D174-D178, D202):
  //   0. guard    a second signal exits at once, non-zero, past every step below (D174)
  //   1. quiesce  close the listener: no new connection, so no new session or turn
  //   2. drain    bounded — `server.close()`'s own callback never fires while any SSE or
  //               WS connection stays open (that is the whole of #197/D176), so whatever
  //               is still connected when the window closes is force-closed instead
  //   3. kill     `manager.shutdown()` — every live turn's child tree, then one
  //               `ProcessTombstone` each (D177, D178)
  //   4. release  remove `<storage>/server.lock`, bounded (D175)
  //   5. close    `store.close()` — this process's own OS handles, then exit zero (D202, I53)
  // Neither timing bound is a `Config` field (module constants, beside each other, is the
  // shape the design settles on) — promoting either to a deployment flag is a contract
  // amendment.
  const DRAIN_TIMEOUT_MS = 5000;
  const RELEASE_LOCK_TIMEOUT_MS = 2000;

  // Every socket this server has ever accepted, tracked so step 2 can force-close whatever
  // step 1 could not: `'connection'` fires once per underlying TCP connection, before HTTP
  // routing and before a WebSocket upgrade takes the socket out of the HTTP layer, so this
  // one registry reaches both edges without either needing a shutdown method of its own —
  // `20-contract.md § server`, "subscriptions are not closed through `SessionManager`".
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) process.exit(1); // guard (D174): past this, nothing below is retried
    stopping = true;
    console.log(`${signal} received — shutting down.`);
    void (async () => {
      // Step 1 (quiesce): stops accepting new connections the instant it is called: the
      // callback is a courtesy this caller does not wait on past the drain bound below,
      // because a subscribed client's response is open for the life of the stream and
      // would otherwise hold this callback, and therefore the exit, forever (D176).
      let closedNaturally = false;
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          closedNaturally = true;
          resolve();
        });
      });
      // `close()` on its own waits out an *idle* keep-alive socket as readily as a live
      // stream, so one browser holding a spent connection would spend the whole window
      // below achieving nothing. This is what makes step 1's "closes the connections that
      // are idle and waits for the rest" (`10-design.md § Shutdown ordering`) true of the
      // code and not only of the prose.
      server.closeIdleConnections();

      // Step 2 (drain): bounded. Whatever is still connected when the window closes is
      // closed — destroying the socket ends an SSE response or a WS connection the same
      // way, and D40 already serves a reconnect from the spill for either, so nothing is
      // lost (S27.4).
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref())]);
      if (!closedNaturally) {
        for (const socket of sockets) socket.destroy();
      }

      // Step 3 (kill): never routed through `interrupt` — see `manager.shutdown()`'s own
      // contract for why. `server.ts` holds no adapter and kills nothing itself.
      // Caught, and not as belt-and-braces: this chain is fired with `void`, so a rejection
      // escaping here is an unhandled rejection that takes the process down *before* step 4
      // — leaving `server.lock` on disk and exiting non-zero, which is D175's release and
      // I54's exit-zero both lost to the one step the design calls best-effort.
      try {
        await manager.shutdown();
      } catch (err) {
        console.error(`[server] shutdown: killing live turns failed; releasing the lock anyway — ${String(err)}`);
      }

      // Step 4 (release), last (D175, D161): removes `server.lock` so the next boot on
      // this storage root takes it without invoking the staleness path at all. Not fatal
      // if it fails, or if it never settles — the next boot's reclaim is what recovers
      // from a lock nobody removed.
      const releaseTimeout = new Promise<void>((resolve) => setTimeout(resolve, RELEASE_LOCK_TIMEOUT_MS).unref());
      await Promise.race([store.value.releaseLock().then(() => undefined), releaseTimeout]);
      // S27.15: logged unconditionally, not only under a test hook — this line is what a
      // black-box test (or an operator's own log) observes to know step 4 has returned
      // before step 5 is entered below.
      console.log('[server] shutdown: server.lock release step complete');

      // Step 5 (close), last and behind step 4 (D202, I53): releases this process's own OS
      // handles. It writes nothing and is invisible to any other process, so it sits behind
      // the one act — the lock's removal — a successor can observe, never in front of it.
      // `Store.close()`'s own contract says it never rejects, but this is still wrapped like
      // every other best-effort step past the guard (S27.11): nothing here may change the
      // exit code or hold up the exit.
      try {
        await store.value.close();
        console.log('[server] shutdown: store closed, exiting 0');
      } catch (err) {
        console.error(`[server] shutdown: closing the store failed; exiting anyway — ${String(err)}`);
      }
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // #207: `listen()`'s own error path (e.g. `EADDRINUSE`) bypasses `stop()` entirely — the
  // process never received a signal — so without this the lock `manager.boot()` already
  // claimed above is left on disk and the next boot pays the reclaim path for a holder that
  // is not actually running. `bound` scopes this to the startup failure this issue is about:
  // an 'error' after a successful `listening` is a runtime fault outside this fix's contract
  // and is only logged, never used to touch the lock.
  let bound = false;
  server.once('listening', () => {
    bound = true;
  });
  server.on('error', (err) => {
    if (bound) {
      console.error(`[server] error after startup: ${(err as Error).message}`);
      return;
    }
    console.error(`Refusing to start: ${(err as Error).message}`);
    void (async () => {
      const released = await store.value.releaseLock();
      if (!released.ok) {
        console.error(`[server] startup: failed to release lock — ${JSON.stringify(released.error)}`);
      }
      process.exit(1);
    })();
  });

  server.listen(config.value.bind.port, config.value.bind.host, () => {
    console.log(`SkyNet HR listening on http://${config.value.bind.host}:${config.value.bind.port}`);
    console.log(`auth mode: ${config.value.auth.mode}`);
    console.log(`edge: ${config.value.edge}`);
  });
}

void main();
