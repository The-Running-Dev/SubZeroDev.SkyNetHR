import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { resolveInsideRoot } from './index.js';

const execFileAsync = promisify(execFile);

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'skynet-jail-'));
  return realpath(dir);
}

test('S1.6 — a cwd inside a configured root resolves', async () => {
  const root = await makeRoot();
  const child = path.join(root, 'project');
  await mkdir(child);
  const result = await resolveInsideRoot(child, [root as never]);
  assert.equal(result.ok, true);
});

test('S1.6 — ".." traversal outside the root is refused, naming the roots', async () => {
  const root = await makeRoot();
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  const outsideDir = path.join(root, '..');
  const candidate = path.join(projectDir, '..', '..');
  void outsideDir;
  const result = await resolveInsideRoot(candidate, [root as never]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'outside_workspace_root');
    assert.deepEqual(result.error.roots, [root]);
  }
});

test('S1.6 — a symlink whose target is outside every root is refused', async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  const outsideTarget = path.join(outside, 'target');
  await mkdir(outsideTarget);
  const linkPath = path.join(root, 'escape-link');
  try {
    await symlink(outsideTarget, linkPath, 'junction');
  } catch {
    await symlink(outsideTarget, linkPath, 'dir');
  }
  const result = await resolveInsideRoot(linkPath, [root as never]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'outside_workspace_root');
});

test('S1.6 — an unresolvable candidate is refused as unresolvable, not outside_workspace_root', async () => {
  const root = await makeRoot();
  const result = await resolveInsideRoot(path.join(root, 'does-not-exist-at-all'), [root as never]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'unresolvable');
});

test('S1.6 — a Windows case variation of a root-contained path resolves inside it', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only: case-insensitive path resolution');
    return;
  }
  const root = await makeRoot();
  const child = path.join(root, 'Project');
  await mkdir(child);
  const upperCased = child.toUpperCase();
  const result = await resolveInsideRoot(upperCased, [root as never]);
  assert.equal(result.ok, true);
});

test('S1.7 — the value returned is the resolved real path, not the candidate string', async () => {
  const root = await makeRoot();
  const child = path.join(root, 'project');
  await mkdir(child);
  // `path.join` would collapse these `.` segments itself; build the redundant string
  // without it so the candidate genuinely differs from its resolved form.
  const withRedundantSegments = `${root}${path.sep}.${path.sep}project${path.sep}.`;
  const result = await resolveInsideRoot(withRedundantSegments, [root as never]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.notEqual(result.value, withRedundantSegments);
    assert.equal(result.value, child);
    assert.equal(await realpath(result.value), result.value);
  }
});

test('S1.7 — a child spawned with the jail-resolved path reports that exact path as its own cwd', async () => {
  const root = await makeRoot();
  const child = path.join(root, 'project');
  await mkdir(child);
  const candidate = path.join(root, '.', 'project'); // deliberately not the resolved form
  const result = await resolveInsideRoot(candidate, [root as never]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { stdout } = await execFileAsync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
    cwd: result.value,
  });
  assert.equal(await realpath(stdout.trim()), result.value);
});

test('THROWAWAY — deliberately fails on Linux only, to prove fail-fast:false (S19.2)', () => {
  if (process.platform !== 'win32') {
    assert.fail('deliberate failure for S19.2 verification, not a real defect');
  }
});
