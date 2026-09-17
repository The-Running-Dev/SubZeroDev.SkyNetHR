import type { Writable } from 'node:stream';

export const LINE_BYTES = 8 * 1024 * 1024;
export interface Delivery { line: string; bytes: number; delivered(): void; }
export interface DeliverySource { next(): Delivery | undefined; }

// The writer owns stdout, but never owns provider draining or persistence.
export class RpcWriter {
  private controls: Delivery[] = [];
  private bytes = 0;
  private sources = new Map<string, DeliverySource>();
  private cursor = 0;
  private blocked = false;
  private stopped = false;
  private scheduled = false;
  constructor(private output: Writable, private fault: (reason: string) => void,
    private budget = 2 * LINE_BYTES, private controlLimit = 256) {
    output.on('drain', () => { this.blocked = false; this.wake(); });
    output.on('error', () => this.fail('stdout_closed'));
  }
  private fail(reason: string) { if (!this.stopped) { this.close(); this.fault(reason); } }
  encode(value: unknown): Delivery | undefined {
    const line = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(line);
    if (bytes - 1 > LINE_BYTES) { this.fail('outgoing_line_too_large'); return; }
    return { line, bytes, delivered() {} };
  }
  control(value: unknown) {
    if (this.stopped) return;
    const item = this.encode(value);
    if (!item) return;
    if (this.controls.length >= this.controlLimit || this.bytes + item.bytes + this.output.writableLength > this.budget) {
      this.fail('writer_budget_exhausted'); return;
    }
    this.controls.push(item); this.bytes += item.bytes; this.wake();
  }
  add(id: string, source: DeliverySource) { this.sources.set(id, source); this.wake(); }
  remove(id: string) { this.sources.delete(id); }
  get backpressured() { return this.blocked; }
  linkFault() { this.fail('writer_budget_exhausted'); }
  wake() {
    if (this.scheduled || this.stopped || this.blocked) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (this.stopped || this.blocked) return;
    // Yield after a bounded batch, so a fully credited replay cannot starve reads.
    for (let batch = 0; batch < 32; batch++) {
      let item = this.controls.shift();
      if (item) this.bytes -= item.bytes;
      else {
        const sources = [...this.sources.values()];
        for (let n = 0; n < sources.length; n++) {
          this.cursor %= sources.length;
          item = sources[this.cursor++]!.next();
          if (item) break;
        }
      }
      if (!item) return;
      if (this.output.writableLength + item.bytes > this.budget) { this.fail('writer_budget_exhausted'); return; }
      const accepted = this.output.write(item.line);
      item.delivered();
      if (!accepted) { this.blocked = true; return; }
    }
    this.wake();
  }
  close() { this.stopped = true; this.controls = []; this.sources.clear(); this.bytes = 0; }
}
