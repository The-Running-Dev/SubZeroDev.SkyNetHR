import type { Readable, Writable } from 'node:stream';
import { RpcReader } from './reader.js';
import { RpcWriter } from './writer.js';

export class RpcError extends Error {
  constructor(readonly rpcCode: number, message: string, readonly data?: { code: string; detail?: string; retryable?: boolean }) { super(message); }
}
export const applicationError = (code: string, detail?: string) => new RpcError(-32000, code, { code, ...(detail === undefined ? {} : { detail }) });
export type Handler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function safeNumbers(value: unknown) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'number' && (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current)))) return false;
    if (current && typeof current === 'object') for (const child of Object.values(current)) pending.push(child);
  }
  return true;
}

export class RpcPeer {
  readonly writer: RpcWriter;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private requests = new Map<number, AbortController>();
  private sequence = 0;
  private stopped = false;
  private lastReceived: number;
  private now: () => number;
  private timer: ReturnType<typeof setInterval>;
  constructor(input: Readable, output: Writable, private handle: Handler, private shutdown: (reason: string) => void,
    timing: { intervalMs?: number; timeoutMs?: number; now?: () => number } = {}) {
    this.now = timing.now ?? Date.now; this.lastReceived = this.now();
    this.writer = new RpcWriter(output, reason => this.stop(reason));
    let corrupt = false;
    const reader = new RpcReader(line => { if (!corrupt) this.receive(line); }, reason => {
      if (corrupt) return;
      corrupt = true;
      this.notify('runtime.protocolError', { code: reason });
      // Give the control writer its turn before shutting down this corrupt link.
      setImmediate(() => this.stop(reason));
    });
    input.on('data', (chunk: Buffer) => reader.push(chunk));
    input.once('end', () => { reader.end(); this.stop('stdin_eof'); });
    input.once('error', () => this.stop('stdin_error'));
    this.timer = setInterval(() => {
      if (this.now() - this.lastReceived >= (timing.timeoutMs ?? HEARTBEAT_TIMEOUT_MS)) this.stop('heartbeat_timeout');
      else this.notify('runtime.heartbeat', {});
    }, timing.intervalMs ?? HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }
  notify(method: string, params: unknown) { if (!this.stopped) this.writer.control({ jsonrpc: '2.0', method, params }); }
  call(method: string, params: unknown, timeoutMs?: number): { id: string; result: Promise<unknown> } {
    const id = `r:${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.stopped) { reject(applicationError('RuntimeTerminated')); return; }
      if (this.pending.size >= 256) { reject(applicationError('bad_request', 'host callback limit reached')); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = { resolve: (value: unknown) => { clearTimeout(timer); resolve(value); }, reject: (error: unknown) => { clearTimeout(timer); reject(error); } };
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) timer = setTimeout(() => { this.pending.delete(id); pending.reject(applicationError('host_callback_timeout')); }, timeoutMs);
      this.writer.control({ jsonrpc: '2.0', id, method, params });
    });
    return { id, result };
  }
  cancel(id: string) {
    this.notify('$/cancel', { id });
    const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(applicationError('cancelled'));
  }
  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.writer.close();
    for (const request of this.requests.values()) request.abort();
    for (const pending of this.pending.values()) pending.reject(applicationError('RuntimeTerminated', reason));
    this.pending.clear(); this.shutdown(reason);
  }
  private error(id: unknown, error: RpcError) {
    this.writer.control({ jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.message, ...(error.data ? { data: error.data } : {}) } });
  }
  private receive(line: string) {
    if (this.stopped) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.error(null, new RpcError(-32700, 'Parse error')); return; }
    if (!object(msg) || msg.jsonrpc !== '2.0') { this.error(null, new RpcError(-32600, 'Invalid Request')); return; }
    if (!safeNumbers(msg)) { this.error(typeof msg.id === 'number' && Number.isSafeInteger(msg.id) ? msg.id : null, new RpcError(-32602, 'Unsafe numeric value')); return; }
    this.lastReceived = this.now();
    if (typeof msg.method !== 'string') {
      if (typeof msg.id !== 'string' || !/^r:[1-9][0-9]*$/.test(msg.id) || ('result' in msg) === ('error' in msg)) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) pending.reject(msg.error); else pending.resolve(msg.result);
      return;
    }
    if (msg.method === '$/cancel') {
      const id = object(msg.params) ? msg.params.id : undefined;
      if (typeof id === 'number') this.requests.get(id)?.abort();
      else if (typeof id === 'string') {
        const pending = this.pending.get(id); this.pending.delete(id);
        pending?.reject(applicationError('cancelled'));
      }
      return;
    }
    if (msg.method === 'runtime.heartbeat' && !('id' in msg)) return;
    if (!('id' in msg)) return; // Mutations are requests; unacknowledged mutations are never dispatched.
    if (!Number.isSafeInteger(msg.id) || typeof msg.id !== 'number') { this.error(null, new RpcError(-32600, 'Invalid request id')); return; }
    const id = msg.id;
    if (this.requests.has(id)) { this.error(id, new RpcError(-32600, 'Duplicate request id')); return; }
    if (this.requests.size >= 256) { this.error(id, applicationError('bad_request', 'request limit reached')); return; }
    const controller = new AbortController(); this.requests.set(id, controller);
    // Do not await here: replies to host callbacks must continue to be consumed.
    void this.handle(msg.method, msg.params ?? {}, controller.signal).then(result => {
      if (!this.stopped) this.writer.control({ jsonrpc: '2.0', id, result: result ?? null });
    }, error => {
      if (!this.stopped) this.error(id, error instanceof RpcError ? error : new RpcError(-32603, 'Internal error'));
    }).finally(() => this.requests.delete(id));
  }
}
