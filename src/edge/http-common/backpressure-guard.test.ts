import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createBackpressureGuard } from './index.js';

// A duck-typed stand-in for `ServerResponse`/`Socket` — both are `Writable`s, and
// `createBackpressureGuard` only ever touches the two members Node's `Writable` contract
// guarantees on either: `write` returning the backpressure signal, and the `'drain'` event.
class FakeStream extends EventEmitter {
  written: (string | Uint8Array)[] = [];
  nextWriteReturns = true;

  write(chunk: string | Uint8Array): boolean {
    this.written.push(chunk);
    return this.nextWriteReturns;
  }
}

test('#133 — every write that flushes immediately never counts toward the drop threshold', () => {
  const stream = new FakeStream();
  let dropped = 0;
  const write = createBackpressureGuard(stream, 2, () => {
    dropped += 1;
  });

  for (let i = 0; i < 100; i++) write(`line ${i}`);

  assert.equal(stream.written.length, 100);
  assert.equal(dropped, 0);
});

test('#133 — past the high-water mark of consecutive queued writes, the subscriber is dropped exactly once', () => {
  const stream = new FakeStream();
  stream.nextWriteReturns = false; // every write queues rather than flushes
  let dropped = 0;
  const write = createBackpressureGuard(stream, 2, () => {
    dropped += 1;
  });

  write('a'); // queued 1 — at the mark, not past it
  assert.equal(dropped, 0);
  write('b'); // queued 2 — at the mark, not past it
  assert.equal(dropped, 0);
  write('c'); // queued 3 — past the mark of 2
  assert.equal(dropped, 1);

  // A dropped guard stops writing altogether — no further bytes reach the stream and the
  // drop callback never fires a second time.
  const writtenBeforeFurtherCalls = stream.written.length;
  write('d');
  write('e');
  assert.equal(stream.written.length, writtenBeforeFurtherCalls, 'a dropped guard writes nothing further');
  assert.equal(dropped, 1, 'onDrop fires exactly once');
});

test("#133 — only the stream's own 'drain' event resets the counter, not a write that happens to flush", () => {
  const stream = new FakeStream();
  let dropped = 0;
  const write = createBackpressureGuard(stream, 2, () => {
    dropped += 1;
  });

  stream.nextWriteReturns = false;
  write('a'); // queued 1
  write('b'); // queued 2
  stream.nextWriteReturns = true;
  write('c'); // this call flushes, but the buffer dipping below the mark for one call is not the same as actually draining
  stream.nextWriteReturns = false;
  write('d'); // queued 3 if the counter was never reset — past the mark of 2
  assert.equal(dropped, 1, 'a write that happens to return true does not reset the backlog count');
});

test('#133 — a real drain event resets the counter, so a subscriber that catches up is not dropped for old backlog', () => {
  const stream = new FakeStream();
  let dropped = 0;
  const write = createBackpressureGuard(stream, 2, () => {
    dropped += 1;
  });

  stream.nextWriteReturns = false;
  write('a'); // queued 1
  write('b'); // queued 2
  stream.emit('drain');
  write('c'); // queued 1 again, post-drain
  write('d'); // queued 2 again
  assert.equal(dropped, 0, 'the backlog reset at drain, so two more queued writes stay at the mark');
});
