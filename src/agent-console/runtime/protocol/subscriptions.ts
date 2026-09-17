import { randomUUID } from 'node:crypto';
import type { Envelope, Frame, Result, SessionCore, SessionId, Seq, StoreError, Subscription } from '../../core/types.js';
import { isFrame } from '../../core/types.js';
import { applicationError } from './peer.js';
import { RpcWriter, type Delivery } from './writer.js';
import { wireEvent } from './events.js';

export class Subscriptions {
  private entries = new Map<string, { principal: string; sessionId: SessionId; credit: number; queue: Delivery[]; bytes: number;
    through: number; stopped: boolean; subscription?: Subscription; close(): void }>();
  constructor(private core: SessionCore, private writer: RpcWriter, private budget: number) {}
  async subscribe(sessionId: SessionId, principal: string, fromSeq: number) {
    if (this.entries.size >= 1024) throw applicationError('bad_request', 'subscription limit reached');
    const found = this.core.get(sessionId, principal);
    if (!found.ok) return found;
    const replayThrough = found.value.lastSeq;
    const id = randomUUID();
    const entry: NonNullable<ReturnType<typeof this.entries.get>> = { principal, sessionId, credit: 0, queue: [], bytes: 0, through: fromSeq, stopped: false, close: () => retire() };
    let replaying = fromSeq < replayThrough, reading = false, replayItem: Delivery | undefined;
    let replay: AsyncIterator<Result<Envelope, StoreError>> | undefined;
    let flushed = false;
    this.entries.set(id, entry);
    const closeReplay = () => {
      if (replay) { const current = replay; replay = undefined; void current.return?.().catch(() => {}); }
    };
    const retire = () => {
      entry.stopped = true; entry.queue = []; entry.bytes = 0; entry.subscription?.close();
      replayItem = undefined; closeReplay();
      this.writer.remove(id); this.entries.delete(id);
    };
    this.writer.add(id, { next: () => {
      if (entry.credit === 0) return;
      // History is pulled one record at a time, only when the writer has credit.
      // Live events remain bounded separately while history catches up.
      let item: Delivery | undefined;
      if (replaying) {
        item = replayItem;
        if (!item) { void readReplay(); return; }
        replayItem = undefined;
      } else item = entry.queue.shift();
      if (item) { entry.credit--; entry.bytes -= item.bytes; }
      return item;
    } });
    const gap = (message = 'subscription delivery budget exhausted; resubscribe') => {
      if (entry.stopped) return;
      if (this.writer.backpressured) { this.writer.linkFault(); return; }
      retire();
      // A control notification consumes no credit; the watermark never advances.
      this.writer.control({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id,
        event: { sessionId, seq: entry.through, ts: new Date().toISOString(), kind: 'error',
          data: { kind: 'replay_gap', message, fatal: false } } } });
    };
    const encode = (event: Envelope | Frame) => {
      const item = this.writer.encode({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id, event: wireEvent(event) } });
      if (!item) return;
      if (entry.queue.length + (replayItem ? 1 : 0) >= this.budget || entry.bytes + item.bytes > 8 * 1024 * 1024) { gap(); return; }
      item.delivered = () => { if (!isFrame(event)) entry.through = event.seq; };
      entry.bytes += item.bytes;
      return item;
    };
    const readReplay = async () => {
      if (reading || entry.stopped || !replaying) return;
      reading = true;
      try {
        // The snapshot may include an event still queued for durable append.
        // Register the live sink first; this wait never blocks provider delivery.
        if (!flushed) { await this.core.flush(); flushed = true; }
        if (entry.stopped) return;
        replay ??= this.core.admin.readEvents(sessionId, fromSeq as Seq | 0)[Symbol.asyncIterator]();
        const result = await replay.next();
        if (entry.stopped) return;
        if (!this.core.get(sessionId, principal).ok) { retire(); return; }
        if (result.done || !result.value.ok) { gap('replay from storage ended before the snapshot; resubscribe'); return; }
        const event = result.value.value;
        if (event.seq !== entry.through + 1) { gap('the recorded history has a gap before this point'); return; }
        const item = encode(event);
        if (!item) return;
        item.delivered = () => {
          entry.through = event.seq;
          if (event.seq === replayThrough) { replaying = false; closeReplay(); }
        };
        replayItem = item; this.writer.wake();
      } catch {
        gap('replay from storage failed; resubscribe');
      } finally { reading = false; }
    };
    const deliver = (event: Envelope | Frame) => {
      if (entry.stopped) return;
      if (!isFrame(event) && event.kind === 'error' && event.data.kind === 'replay_gap') {
        retire();
        this.writer.control({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: id, event } });
        return;
      }
      if (replaying && isFrame(event)) return;
      const item = encode(event);
      if (!item) return;
      entry.queue.push(item); this.writer.wake();
    };
    // Snapshot and live registration share this synchronous prefix: no event can
    // fall between them. Core still owns live delivery and invalid future cursors.
    const result = await this.core.subscribe(sessionId, principal, Math.max(fromSeq, replayThrough) as Seq | 0, { deliver,
      close: retire });
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
    this.find(id, principal).close(); return null;
  }
  close() { for (const entry of this.entries.values()) entry.close(); }
}
