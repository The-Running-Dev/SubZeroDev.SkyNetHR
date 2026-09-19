// Minimal Chrome DevTools Protocol driver, Node builtins only (D245: no new dependency).
// Launches a Chromium-family browser headless on an ephemeral debugging port, opens page
// targets over the CDP HTTP endpoints, and drives each page over its own WebSocket —
// `global.WebSocket` and `fetch`, both built into Node 22+ (this repo's `engines.node`).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAUNCH_TIMEOUT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 15_000;
const PORT_POLL_INTERVAL_MS = 100;
const CLEANUP_MAX_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 200;

// Deletes a browser profile directory, tolerating the Windows race where the OS (or an
// antivirus scanner) still holds a handle inside it for a moment after the browser process
// has exited — rmSync's own maxRetries/retryDelay is Node's documented answer to exactly this
// EBUSY/ENOTEMPTY/EPERM pattern. A directory that still won't go away after retrying is left
// for the OS's temp-dir cleanup rather than failing the run: cleanup is not what the pass is
// checking, and letting it throw here previously skipped the caller's next cleanup step
// (closing the static server), leaving the process hung rather than exited.
export function removeUserDataDir(userDataDir, remove = rmSync) {
  try {
    remove(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS,
    });
  } catch (err) {
    console.warn(`warning: could not remove browser profile directory ${userDataDir}: ${err.message}`);
  }
}

function launchArgs(userDataDir) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    // Edge on Windows otherwise relaunches itself through a "compat layer" step — a second
    // process inherits the browser, and the one Node holds a handle to exits first, so a
    // stderr-tail (the "DevTools listening on" line other CDP drivers key off) never arrives
    // on the pipe Node is reading. Skipping the relaunch, and polling the port file below
    // instead of any process's stderr, works the same way on both platforms.
    '--edge-skip-compat-layer-relaunch',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];
}

// Chromium and Edge both write this file into the profile directory once the DevTools HTTP
// server is actually listening — first line is the port. Polling for it, rather than tailing
// the launched process's stderr, is unaffected by which process ends up owning the browser.
async function waitForDevToolsPort(userDataDir, child) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const firstLine = (await readFile(portFile, 'utf8')).split('\n')[0];
      const port = parseInt(firstLine, 10);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (exited) {
      throw new Error(`browser process exited (code ${exitCode}) before writing DevToolsActivePort`);
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }
  throw new Error(`browser did not write DevToolsActivePort within ${LAUNCH_TIMEOUT_MS}ms`);
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.ws = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (event) => reject(new Error(`WebSocket error: ${event.message ?? event}`)), { once: true });
    });
    this.ws.addEventListener('message', (event) => this._onMessage(event));
  }

  _onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const listeners = this.eventListeners.get(msg.method);
      if (listeners) for (const fn of listeners) fn(msg.params);
    }
  }

  on(method, fn) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set());
    this.eventListeners.get(method).add(fn);
    return () => this.eventListeners.get(method).delete(fn);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed — nothing to do.
    }
  }
}

export class Page {
  constructor(browser, targetId, connection) {
    this.browser = browser;
    this.targetId = targetId;
    this.connection = connection;
  }

  async goto(url) {
    await this.connection.send('Page.enable');
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`navigation to ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`)), NAVIGATE_TIMEOUT_MS);
      const off = this.connection.on('Page.loadEventFired', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    await this.connection.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluates `expression` in the page and returns its value by-value (JSON-serializable only). */
  async evaluate(expression) {
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page evaluation threw: ${desc}`);
    }
    return result.result.value;
  }

  async close() {
    this.connection.close();
    await fetch(`${this.browser.httpOrigin}/json/close/${this.targetId}`, { method: 'PUT' }).catch(() => {});
  }
}

export class Browser {
  static async launch(executablePath) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'skynet-hr-browser-'));
    const child = spawn(executablePath, launchArgs(userDataDir), { stdio: ['ignore', 'ignore', 'ignore'] });
    let port;
    try {
      port = await waitForDevToolsPort(userDataDir, child);
    } catch (err) {
      child.kill();
      removeUserDataDir(userDataDir);
      throw err;
    }
    return new Browser(child, `http://127.0.0.1:${port}`, userDataDir);
  }

  constructor(child, httpOrigin, userDataDir) {
    this.child = child;
    this.httpOrigin = httpOrigin;
    this.userDataDir = userDataDir;
  }

  async newPage() {
    const response = await fetch(`${this.httpOrigin}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) {
      throw new Error(`CDP /json/new failed: ${response.status} ${response.statusText}`);
    }
    const target = await response.json();
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    await connection.ready;
    return new Page(this, target.id, connection);
  }

  async close() {
    this.child.kill();
    await new Promise((resolve) => {
      this.child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    removeUserDataDir(this.userDataDir);
  }
}
