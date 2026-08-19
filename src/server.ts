import { createServer } from 'node:http';
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
  // `docker stop` would wait out its grace period first. Closing the listener stops new
  // connections while in-flight ones drain; a second signal is the operator saying they
  // are done waiting.
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal} received — closing the listener.`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  server.listen(config.value.bind.port, config.value.bind.host, () => {
    console.log(`SkyNet HR listening on http://${config.value.bind.host}:${config.value.bind.port}`);
    console.log(`auth mode: ${config.value.auth.mode}`);
    console.log(`edge: ${config.value.edge}`);
  });
}

void main();
