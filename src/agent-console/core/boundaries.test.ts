import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLane } from './lane.js';
import { createWorkspaceAllocator } from './workspaces/allocator.js';
import { isSafePathSegment } from '../store/paths.js';
import type { ResolvedPath } from '../contract/index.js';

test('A22 — synchronous transitions finish before returning; no promise is accepted', () => {
  const lane = createLane();
  const seen: number[] = [];
  lane.run(() => { seen.push(1); });
  lane.run(() => { seen.push(2); });
  assert.deepEqual(seen, [1, 2]);
  assert.throws(() => lane.run((() => Promise.resolve()) as () => never), /synchronous/);
  assert.equal(lane.run(() => 3), 3);
});

test('A11 — pending, live and exclusive reservations share overlapping-path allocation', () => {
  const allocator = createWorkspaceAllocator(2);
  const cwd = '/work/project' as ResolvedPath;
  assert.equal(allocator.reserve('a', cwd, 'alice'), null);
  assert.equal(allocator.reserve('b', (cwd + '/nested') as ResolvedPath, 'bob'), null);
  assert.equal(allocator.reserve('c', cwd, 'carol')?.principal, 'alice');
  allocator.activate('a');
  assert.notEqual(allocator.exclusive('a'), null, 'pending creates exclude restore');
  allocator.release('b');
  assert.equal(allocator.exclusive('a'), null);
  assert.notEqual(allocator.reserve('c', cwd, 'carol'), null, 'restore excludes create even below capacity');
  allocator.releaseExclusive('a');
  assert.equal(allocator.reserve('c', cwd, 'carol'), null);
  allocator.release('a');
  allocator.release('c');
  assert.equal(allocator.reserve('d', cwd, 'dana'), null);
});

test('A21 — filesystem identifiers reject platform aliases without changing display filenames', () => {
  for (const name of ['..', '.', '', 'a/b', 'a\\b', 'a\0b', 'NUL', 'con.txt', 'COM1', 'LPT9.log', 'a:b', 'a.', 'a ', 'e\u0301']) {
    assert.equal(isSafePathSegment(name), false, JSON.stringify(name));
  }
  for (const name of ['call_123', 'turn-123', 'report.txt', 'é', 'COM10']) assert.equal(isSafePathSegment(name), true, name);
});
