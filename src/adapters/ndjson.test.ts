import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NdjsonSplitter } from './ndjson.js';

// S1.2 — the fixture holds two records: one whose serialised JSON straddles a `\n`
// split mid-object (forced by feeding it in two arbitrary chunks), and one whose text
// field contains a multi-byte UTF-8 character (an emoji, 4 bytes in UTF-8) so that
// feeding byte-at-a-time necessarily splits that character's bytes across pushes.
function buildFixture(): Buffer {
  const recordA = JSON.stringify({ type: 'assistant', text: 'hello world, this record is split mid-object' });
  const recordB = JSON.stringify({ type: 'assistant', text: 'emoji boundary test \u{1F600} more text after' });
  const recordC = JSON.stringify({ type: 'result', subtype: 'success' });
  return Buffer.from(recordA + '\n' + recordB + '\n' + recordC + '\n', 'utf8');
}

function feedWhole(fixture: Buffer): string[] {
  const splitter = new NdjsonSplitter();
  return splitter.push(fixture);
}

function feedByteAtATime(fixture: Buffer): string[] {
  const splitter = new NdjsonSplitter();
  const lines: string[] = [];
  for (let i = 0; i < fixture.length; i++) {
    lines.push(...splitter.push(fixture.subarray(i, i + 1)));
  }
  return lines;
}

test('S1.2 — byte-at-a-time feeding matches whole-buffer feeding, including a mid-object split and a multi-byte UTF-8 boundary', () => {
  const fixture = buildFixture();
  const whole = feedWhole(fixture);
  const byteAtATime = feedByteAtATime(fixture);

  assert.deepEqual(byteAtATime, whole);
  assert.equal(whole.length, 3);
  assert.deepEqual(JSON.parse(whole[1]!), { type: 'assistant', text: 'emoji boundary test \u{1F600} more text after' });
});

test('S1.2 — an explicit chunk boundary inside the object and inside the multi-byte character', () => {
  const recordA = JSON.stringify({ type: 'assistant', text: 'split-mid-object marker' });
  const recordB = JSON.stringify({ type: 'assistant', text: '\u{1F600}' }); // 4-byte UTF-8 char
  const fixture = Buffer.from(recordA + '\n' + recordB + '\n', 'utf8');

  // Split the buffer at an arbitrary point inside recordA's JSON text, and again at a
  // point inside the emoji's 4-byte encoding within recordB.
  const midObjectSplit = Math.floor(recordA.length / 2);
  const emojiBytes = Buffer.from('\u{1F600}', 'utf8');
  const emojiByteOffsetInFixture = fixture.indexOf(emojiBytes);
  const midEmojiSplit = emojiByteOffsetInFixture + 2; // inside the 4-byte sequence

  const splitter = new NdjsonSplitter();
  const lines: string[] = [];
  lines.push(...splitter.push(fixture.subarray(0, midObjectSplit)));
  lines.push(...splitter.push(fixture.subarray(midObjectSplit, midEmojiSplit)));
  lines.push(...splitter.push(fixture.subarray(midEmojiSplit)));

  const whole = feedWhole(fixture);
  assert.deepEqual(lines, whole);
  assert.deepEqual(JSON.parse(lines[1]!), { type: 'assistant', text: '\u{1F600}' });
});
