import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff, fileChangeHunks, fileChangesDiff, isFileChanges } from './diff.js';

test('#458 — parses the installed CLI patch with omitted counts', () => {
  assert.deepEqual(parseUnifiedDiff('@@ -1 +1 @@\n-before\n+after\n'), [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] },
  ]);
});

test('#458 — multiple hunks retain context, zero counts, and literal HTML', () => {
  assert.deepEqual(parseUnifiedDiff('@@ -0,0 +1,1 @@\n+<script>\n@@ -5,2 +6,1 @@ context\n same\n-deleted\n\\ No newline at end of file\n'), [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+<script>'] },
    { oldStart: 5, oldLines: 2, newStart: 6, newLines: 1, lines: [' same', '-deleted'] },
  ]);
});

test('#458 — malformed or truncated patches never produce a partial diff', () => {
  for (const patch of ['', 'not a patch', '@@ -1 +1 @@\n-before\n', '@@ -1 +1 @@\n-before\n+after\n+extra\n', '@@ -1 +1 @@\n?before\n+after\n', '@@ -99999999999999999999 +1 @@\n-a\n+b\n']) {
    assert.equal(parseUnifiedDiff(patch), null, patch);
  }
});

test('#458 — additions and deletions carry full contents, including blank and empty files', () => {
  assert.deepEqual(fileChangeHunks({ path: 'new', kind: { type: 'add' }, diff: 'first\n\nlast\n' }), [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+first', '+', '+last'] },
  ]);
  assert.deepEqual(fileChangeHunks({ path: 'old', kind: { type: 'delete' }, diff: 'no newline' }), [
    { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-no newline'] },
  ]);
  assert.deepEqual(fileChangeHunks({ path: 'empty', kind: { type: 'add' }, diff: '' }), [
    { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] },
  ]);
});

test('#458 — file-change validation accepts known kinds and rejects malformed records', () => {
  for (const type of ['add', 'delete', 'update']) {
    assert.equal(isFileChanges([{ path: 'file', kind: { type }, diff: '' }]), true);
  }
  for (const value of [null, {}, [null], [{}], [{ path: 'file', kind: { type: 'rename' }, diff: '' }],
    [{ path: 'file', kind: { type: 'update', move_path: 42 }, diff: '' }],
    [{ path: 'file', kind: { type: 'add' }, diff: null }]]) {
    assert.equal(isFileChanges(value), false);
  }
});

test('#458 — renamed files retain both labels; one malformed file keeps the entire text fallback', () => {
  const change = { path: 'old.txt', kind: { type: 'update' as const, move_path: 'new.txt' }, diff: '@@ -1 +1 @@\n-old\n+new\n' };
  assert.equal(fileChangesDiff([change])?.hunks[0]?.path, 'old.txt → new.txt');
  assert.equal(fileChangesDiff([change, { ...change, diff: 'incomplete' }]), null);
  assert.equal(fileChangesDiff([]), null);
});
