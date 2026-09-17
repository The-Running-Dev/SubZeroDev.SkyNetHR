import { randomUUID } from 'node:crypto';
import type { Envelope, Frame, SessionCore, SessionId, Seq, Subscription } from '../../core/types.js';
import { isFrame } from '../../core/types.js';
import { applicationError } from './peer.js';
import { RpcWriter, type Delivery } from './writer.js';

export class Subscriptions {
  private entries = new Map<string, { principal: string; sessionId: SessionId; credit: number; queue: Delivery[]; bytes: number;
    through: number; stopped: boolean; subscription?: Subscription }>();
  constructor(private core: SessionCore, private writer: RpcWriter, private budget: number) {}
  async subscribe(sessionId: SessionId, principal: string, fromSeq: number) {
    const id = randomUUID();
    const entry: NonNullable<ReturnType<typeof this.entries.get>> = { principal, sessionId, credit: 0, queue: [], bytes: 0, through: fromSeq, stopped: false };
    this.entries.set(id, entry);
    this.writer.add(id, { next: () => {
      if (entry.credit === 0) return;
      const item = entry.queue.shift();
      if (item) { entry.credit--; entry.bytes -= item.bytes; }
      return item;
    } });
    const gap = () => {
      if (entry.stopped) return;
      if (this.writer.backpressured) { this.writer.linkFault(); return; }
      entry.stopped = true; entry.queue = []; entry.bytes = 0; entry.subscription?.close();
      // A control notification consumes no credit; the watermark never advances.
      this.writer.control({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id,
        event: { sessionId, seq: entry.through, ts: new Date().toISOString(), kind: 'error',
          data: { kind: 'replay_gap', message: 'subscription delivery budget exhausted; resubscribe', fatal: false } } } });
    };
    const deliver = (event: Envelope | Frame) => {
      if (entry.stopped) return;
      if (!isFrame(event) && event.kind === 'error' && event.data.kind === 'replay_gap') {
        entry.stopped = true; entry.queue = []; entry.bytes = 0;
        this.writer.control({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id, event } });
        entry.subscription?.close(); return;
      }
      const item = this.writer.encode({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id, event } });
      if (!item) return;
      if (entry.queue.length >= this.budget || entry.bytes + item.bytes > 8 * 1024 * 1024) { gap(); return; }
      item.delivered = () => { if (!isFrame(event)) entry.through = event.seq; };
      entry.queue.push(item); entry.bytes += item.bytes; this.writer.wake();
    };
    const result = await this.core.subscribe(sessionId, principal, fromSeq as Seq | 0, { deliver,
      close: () => { entry.stopped = true; entry.queue = []; entry.bytes = 0; } });
    if (!result.ok) { this.writer.remove(id); this.entries.delete(id); return result; }
    entry.subscription = result.value;
    if (entry.stopped) result.value.close();
    return { ok: true as const, value: { subscriptionId: id } };
  }
  private find(id: string, principal: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.principal !== principal || !this.core.get(entry.sessionId, principal).ok) throw applicationError('not_found');
    return entry;
  }
  credit(id: string, principal: string, count: number) {
    const entry = this.find(id, principal);
    if (!Number.isSafeInteger(entry.credit + count)) throw applicationError('bad_request', 'credit overflow');
    entry.credit += count; this.writer.wake(); return null;
  }
  unsubscribe(id: string, principal: string) {
    const entry = this.find(id, principal); entry.subscription?.close();
    this.writer.remove(id); this.entries.delete(id); return null;
  }
  close() { for (const entry of this.entries.values()) entry.subscription?.close(); this.entries.clear(); }
}
