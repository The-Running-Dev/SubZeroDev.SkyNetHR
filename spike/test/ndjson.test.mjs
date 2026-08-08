import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter } from '../lib/ndjson.mjs';

const STREAM =
  '{"type":"system","subtype":"init","session_id":"abc"}\n' +
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello \\u00e9\\n world"}]}}\n' +
  '{"type":"result","stop_reason":"end_turn"}\n';

function collect(feed) {
  const out = [];
  const push = createLineSplitter(() => assert.fail('unexpected parse error'));
  for (const chunk of feed) out.push(...push(chunk));
  return out;
}

test('whole-stream and byte-by-byte feeds agree', () => {
  const whole = collect([STREAM]);

  // Byte-by-byte over the *bytes*, not the characters, so multi-byte UTF-8 is split
  // mid-character at least once. This is the case that breaks naive implementations.
  const bytes = Buffer.from(STREAM, 'utf8');
  const perByte = collect([...bytes].map((b) => Buffer.from([b])));

  assert.equal(whole.length, 3);
  assert.deepEqual(perByte, whole);
});

test('a trailing fragment is carried, not emitted', () => {
  const push = createLineSplitter();
  assert.deepEqual(push('{"a":1}\n{"b":'), [{ a: 1 }]);
  assert.deepEqual(push('2}\n'), [{ b: 2 }]);
});

test('blank lines and CRLF are tolerated', () => {
  const push = createLineSplitter();
  assert.deepEqual(push('{"a":1}\r\n\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
});

test('a bad line is reported, not dropped, and does not desync the stream', () => {
  const seen = [];
  const push = createLineSplitter((_err, line) => seen.push(line));
  assert.deepEqual(push('{"a":1}\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(seen, ['not json']);
});
