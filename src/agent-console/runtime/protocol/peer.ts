import type { Readable, Writable } from 'node:stream';
import { RpcReader } from './reader.js';
import { RpcWriter } from './writer.js';

export class RpcError extends Error {
  constructor(readonly rpcCode: number, message: string, readonly data?: { code: string; detail?: string; retryable?: boolean }) { super(message); }
}
export const applicationError = (code: string, detail?: string) => new RpcError(-32000, code, { code, ...(detail === undefined ? {} : { detail }) });
export type Handler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class RpcPeer {
  readonly writer: RpcWriter;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private requests = new Map<number, AbortController>();
  private sequence = 0;
  private stopped = false;
  private lastReceived = Date.now();
  private timer: ReturnType<typeof setInterval>;
  constructor(input: Readable, output: Writable, private handle: Handler, private shutdown: (reason: string) => void,
    timing: { intervalMs?: number; timeoutMs?: number } = {}) {
    this.writer = new RpcWriter(output, reason => this.stop(reason));
    const reader = new RpcReader(line => this.receive(line), reason => {
      this.notify('runtime.protocolError', { code: reason });
      // Give the control writer its turn before shutting down this corrupt link.
      setImmediate(() => this.stop(reason));
    });
    input.on('data', (chunk: Buffer) => reader.push(chunk));
    input.once('end', () => { reader.end(); this.stop('stdin_eof'); });
    input.once('error', () => this.stop('stdin_error'));
    this.timer = setInterval(() => {
      if (Date.now() - this.lastReceived >= (timing.timeoutMs ?? 30_000)) this.stop('heartbeat_timeout');
      else this.notify('runtime.heartbeat', {});
    }, timing.intervalMs ?? 10_000);
    this.timer.unref();
  }
  notify(method: string, params: unknown) { if (!this.stopped) this.writer.control({ jsonrpc: '2.0', method, params }); }
  call(method: string, params: unknown): { id: string; result: Promise<unknown> } {
    const id = `r:${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.stopped) { reject(applicationError('RuntimeTerminated')); return; }
      this.pending.set(id, { resolve, reject });
      this.writer.control({ jsonrpc: '2.0', id, method, params });
    });
    return { id, result };
  }
  cancel(id: string) { this.notify('$/cancel', { id }); }
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
    this.lastReceived = Date.now();
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
    const controller = new AbortController(); this.requests.set(id, controller);
    // Do not await here: replies to host callbacks must continue to be consumed.
    void this.handle(msg.method, msg.params ?? {}, controller.signal).then(result => {
      if (!this.stopped) this.writer.control({ jsonrpc: '2.0', id, result: result ?? null });
    }, error => {
      if (!this.stopped) this.error(id, error instanceof RpcError ? error : new RpcError(-32603, 'Internal error'));
    }).finally(() => this.requests.delete(id));
  }
}
