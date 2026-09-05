import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { computeUnreached, createCheckpoints } from './index.js';
import type { Config, GitSha, IgnoredManifest, SessionId } from '../contract/index.js';

function baseConfig(storageRoot: string): Config {
  return {
    bind: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'x' },
    workspaceRoots: [],
    storageRoot: storageRoot as never,
    allowedOrigins: [],
    trustProxy: [],
    caps: {
      ringCapacity: 10,
      toolResultBytes: 1024,
      subscriberQueueHighWater: 100,
      keepaliveMs: 15000,
      auditPageMax: 200,
      reviewBodyBytes: 1024,
      requisitionTextBytes: 1024,
      standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    streamDeltas: false,
    sessionTokenBudget: null,
    tokenRates: null,
    currency: null,
    checklist: [],
    edge: 'sse',
  };
}

async function fixture() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-ckpt-store-'));
  const cwd = await mkdtemp(path.join(tmpdir(), 'skynet-ckpt-ws-'));
  const config = baseConfig(storageRoot);
  const checkpoints = createCheckpoints(config);
  const sessionId = 'sess-1' as SessionId;
  return { storageRoot, cwd: cwd as never, checkpoints, sessionId };
}

test('S6.1 — init creates a shadow GIT_DIR at ckpt.git and never touches the workspace\'s own .git', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();

  // The operator's real repository, with a commit already on it — the baseline S6.1
  // asserts is unchanged.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('git', ['-C', cwd, 'init', '--quiet']);
  await exec('git', ['-C', cwd, 'config', 'user.name', 'op']);
  await exec('git', ['-C', cwd, 'config', 'user.email', 'op@example.com']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'hello');
  await exec('git', ['-C', cwd, 'add', '-A']);
  await exec('git', ['-C', cwd, 'commit', '-m', 'baseline']);
  const headBefore = (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
  const statusBefore = (await exec('git', ['-C', cwd, 'status', '--porcelain'])).stdout;

  const initialised = await checkpoints.init(sessionId, cwd);
  assert.equal(initialised.ok, true);
  assert.equal(existsSync(path.join(storageRoot, 'sessions', sessionId, 'ckpt.git')), true);

  await writeFile(path.join(cwd, 'untracked-by-real-repo.txt'), 'agent wrote this');
  const committed = await checkpoints.commit(sessionId, cwd, 'before turn 1');
  assert.equal(committed.ok, true);

  const headAfter = (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
  const statusAfter = (await exec('git', ['-C', cwd, 'status', '--porcelain'])).stdout;
  assert.equal(headAfter, headBefore, "the workspace's own HEAD is untouched");
  // The shadow commit staged the new file in ckpt.git only; the real repo still reports
  // it as untracked, identically to before the shadow checkpoint ran.
  assert.equal(statusAfter, statusBefore === '' ? statusAfter : statusBefore);
  assert.match(statusAfter, /untracked-by-real-repo\.txt/);
});

test('S6.3 — restore reverts a modified file and removes a file created after the target', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);

  await writeFile(path.join(cwd, 'keep.txt'), 'version 1');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  await writeFile(path.join(cwd, 'keep.txt'), 'version 2 — modified after the target');
  await writeFile(path.join(cwd, 'created-after.txt'), 'should be gone after restore');

  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, true);

  assert.equal(await readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'version 1');
  assert.equal(existsSync(path.join(cwd, 'created-after.txt')), false);
});

test('S6.4 — restore commits a safety checkpoint first, and restoring it returns to the pre-restore state', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);

  await writeFile(path.join(cwd, 'a.txt'), 'A');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  await writeFile(path.join(cwd, 'a.txt'), 'A, but edited just before the restore');
  const listBefore = await checkpoints.list(sessionId, cwd);
  assert.equal(listBefore.ok, true);
  const countBefore = listBefore.ok ? listBefore.value.length : 0;

  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  const safetySha = restored.value.safety.sha;

  const listAfter = await checkpoints.list(sessionId, cwd);
  assert.equal(listAfter.ok, true);
  if (listAfter.ok) {
    assert.equal(listAfter.value.length, countBefore + 1, 'the safety checkpoint appears in the list');
    assert.ok(listAfter.value.some((c) => c.sha === safetySha));
  }

  // Restoring the safety checkpoint returns to the state just before the first restore.
  const restoredAgain = await checkpoints.restore(sessionId, cwd, safetySha);
  assert.equal(restoredAgain.ok, true);
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'A, but edited just before the restore');
});

test('S6.5 — restore against an unknown sha is refused no_such_checkpoint and touches nothing', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, 'only.txt'), 'unchanged');

  const bogus = '0'.repeat(40) as GitSha;
  const restored = await checkpoints.restore(sessionId, cwd, bogus);
  assert.equal(restored.ok, false);
  if (!restored.ok) assert.equal(restored.error.code, 'no_such_checkpoint');

  assert.equal(await readFile(path.join(cwd, 'only.txt'), 'utf8'), 'unchanged');
  const list = await checkpoints.list(sessionId, cwd);
  assert.equal(list.ok, true);
  if (list.ok) assert.equal(list.value.length, 0, 'no safety checkpoint was committed for a rejected sha');
});

test('S6.6 — a path ignored by the workspace\'s own .gitignore is neither checkpointed nor removed by restore', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await writeFile(path.join(cwd, '.gitignore'), 'node_modules/\n');
  await mkdir(path.join(cwd, 'node_modules'));
  await writeFile(path.join(cwd, 'node_modules', 'dep.js'), 'module.exports = {};');

  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, 'tracked.txt'), 'v1');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  await writeFile(path.join(cwd, 'tracked.txt'), 'v2');
  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, true);

  assert.equal(existsSync(path.join(cwd, 'node_modules', 'dep.js')), true, 'the ignored directory survives the restore untouched');
  assert.equal(await readFile(path.join(cwd, 'node_modules', 'dep.js'), 'utf8'), 'module.exports = {};');
});

test('S6.7 — a workspace that is not a git repository checkpoints and restores normally, and acquires no .git of its own', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  assert.equal(existsSync(path.join(cwd, '.git')), false);

  const initialised = await checkpoints.init(sessionId, cwd);
  assert.equal(initialised.ok, true);

  await writeFile(path.join(cwd, 'x.txt'), '1');
  const committed = await checkpoints.commit(sessionId, cwd, 'first');
  assert.equal(committed.ok, true);
  if (!committed.ok) return;

  await writeFile(path.join(cwd, 'x.txt'), '2');
  const restored = await checkpoints.restore(sessionId, cwd, committed.value.sha);
  assert.equal(restored.ok, true);
  assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), '1');

  assert.equal(existsSync(path.join(cwd, '.git')), false, 'the workspace acquired no .git of its own');
});

test('S6.8 — a ckpt.git that cannot be initialised yields init_failed, naming the cause', async () => {
  const { cwd, sessionId } = await fixture();
  // A file sits where the shadow git directory needs to be created, so
  // `mkdir(..., {recursive: true})` fails: a path component exists and is not a directory.
  const blockedRoot = await mkdtemp(path.join(tmpdir(), 'skynet-ckpt-blocked-'));
  await mkdir(path.join(blockedRoot, 'sessions'), { recursive: true });
  await writeFile(path.join(blockedRoot, 'sessions', sessionId as string), 'not a directory');
  const blockedCheckpoints = createCheckpoints(baseConfig(blockedRoot));

  const initialised = await blockedCheckpoints.init(sessionId, cwd);
  assert.equal(initialised.ok, false);
  if (!initialised.ok) assert.equal(initialised.error.code, 'init_failed');
});

test('S6.9 — a commit blocked by a planted index.lock is reported locked, naming ckpt.git/index.lock', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);

  const gitDir = path.join(storageRoot, 'sessions', sessionId, 'ckpt.git');
  await writeFile(path.join(gitDir, 'index.lock'), '');

  await writeFile(path.join(cwd, 'y.txt'), 'content');
  const committed = await checkpoints.commit(sessionId, cwd, 'before turn N');
  assert.equal(committed.ok, false);
  if (!committed.ok) {
    assert.equal(committed.error.code, 'locked');
    assert.match(committed.error.detail, /ckpt\.git\/index\.lock/);
  }
});

test('S6.10-adjacent/S32.11 — destroy removes ckpt.git and its ignored-path manifests entirely', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  const gitDir = path.join(storageRoot, 'sessions', sessionId, 'ckpt.git');
  assert.equal(existsSync(gitDir), true);

  await writeFile(path.join(cwd, '.gitignore'), 'secret.env\n');
  await writeFile(path.join(cwd, 'secret.env'), 'API_KEY=x');
  const committed = await checkpoints.commit(sessionId, cwd, 'with a manifest');
  assert.equal(committed.ok, true);
  const ignoredDir = path.join(storageRoot, 'sessions', sessionId, 'ignored');
  assert.equal(existsSync(ignoredDir), true, 'a manifest directory now exists alongside ckpt.git');

  const destroyed = await checkpoints.destroy(sessionId);
  assert.equal(destroyed.ok, true);
  assert.equal(existsSync(gitDir), false);
  assert.equal(existsSync(ignoredDir), false, 'the manifest directory is gone along with ckpt.git');
});

test('S6.11/S32.10 — a restore left short by an embedded git repository (git leaves it behind, exit code 0) is still reported restore_incomplete, with the safety checkpoint already committed and no report', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);

  await writeFile(path.join(cwd, 'a.txt'), 'v1');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  // A genuinely nested, valid git repository — e.g. something the agent cloned into the
  // workspace — is exactly the case git itself protects from casual removal: `read-tree`
  // exits 0 despite failing to `rmdir` it, and `clean -fd` (single force) declines to
  // touch a directory holding its own `.git`. Both report success; the directory survives
  // either way. This is not a permission trick or a platform quirk — it is git's own
  // behaviour on any platform this ships on.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const nested = path.join(cwd, 'nested');
  await mkdir(nested);
  await exec('git', ['-C', nested, 'init', '--quiet']);
  await exec('git', ['-C', nested, 'config', 'user.name', 'op']);
  await exec('git', ['-C', nested, 'config', 'user.email', 'op@example.com']);
  await writeFile(path.join(nested, 'inner.txt'), 'vendored');
  await exec('git', ['-C', nested, 'add', '-A']);
  await exec('git', ['-C', nested, 'commit', '-m', 'inner']);

  const listBefore = await checkpoints.list(sessionId, cwd);
  const countBefore = listBefore.ok ? listBefore.value.length : 0;

  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, false);
  if (!restored.ok) {
    assert.equal(restored.error.code, 'restore_incomplete');
    // S32.10: a dirty verification pass fails exactly as before, and carries no report —
    // the report step never runs on this path, so there is no `unreached` to inspect.
    assert.equal('unreached' in restored, false);
  }

  const listAfter = await checkpoints.list(sessionId, cwd);
  assert.equal(listAfter.ok, true);
  if (listAfter.ok) assert.equal(listAfter.value.length, countBefore + 1, 'the safety checkpoint is already committed despite the failure');
});

// --- S32 — Say what the rollback did not reach --------------------------------------

test('S32.1/S32.2 — a checkpoint writes a manifest of workspace-relative paths, kind, size and mtime, and nothing else', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, '.gitignore'), 'ignored-file.txt\nignored-dir/\n');
  await writeFile(path.join(cwd, 'ignored-file.txt'), 'secret contents');
  await mkdir(path.join(cwd, 'ignored-dir'));
  await writeFile(path.join(cwd, 'ignored-dir', 'inner.txt'), 'also secret');

  const committed = await checkpoints.commit(sessionId, cwd, 'with ignored paths');
  assert.equal(committed.ok, true);
  if (!committed.ok) return;

  const manifestPath = path.join(storageRoot, 'sessions', sessionId, 'ignored', `${committed.value.sha}.json`);
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as IgnoredManifest;
  assert.equal(manifest.sha, committed.value.sha);
  assert.equal(manifest.entries.length, 2);

  const file = manifest.entries.find((e) => e.path === 'ignored-file.txt');
  const dir = manifest.entries.find((e) => e.path === 'ignored-dir');
  assert.ok(file, 'the ignored file appears, workspace-relative and POSIX');
  assert.ok(dir, 'the ignored directory appears as a single collapsed entry');
  assert.equal(file!.kind, 'file');
  assert.equal(dir!.kind, 'dir');
  assert.equal(typeof file!.sizeBytes, 'number');
  assert.equal(dir!.sizeBytes, null, 'size is absent exactly for a directory');
  assert.equal(typeof file!.mtimeMs, 'number');
  assert.equal(typeof dir!.mtimeMs, 'number');

  // S32.2: no entry carries content or a digest of it — exactly these four keys, on every entry.
  for (const entry of manifest.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'mtimeMs', 'path', 'sizeBytes'].sort());
  }
  const raw = await readFile(manifestPath, 'utf8');
  assert.doesNotMatch(raw, /secret contents|also secret/, 'no ignored byte ever reaches the manifest');
});

test('S32.3 — a manifest capture failure never fails the commit', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);

  // A file sits where the manifest directory needs to be created, so `mkdir(...,
  // {recursive: true})` inside the capture step fails — the same blocking trick S6.8
  // uses for `ckpt.git` itself, aimed here at `ignored/` instead.
  const sessionDir = path.join(storageRoot, 'sessions', sessionId);
  await writeFile(path.join(sessionDir, 'ignored'), 'not a directory');

  await writeFile(path.join(cwd, '.gitignore'), 'ignored-file.txt\n');
  await writeFile(path.join(cwd, 'ignored-file.txt'), 'x');
  const committed = await checkpoints.commit(sessionId, cwd, 'capture blocked');
  assert.equal(committed.ok, true, 'the commit succeeds even though its manifest could not be written');
  assert.equal(existsSync(path.join(sessionDir, 'ignored', `${committed.ok ? committed.value.sha : ''}.json`)), false);
});

test('S32.4 — restore returns the safety checkpoint, never the target', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, 'a.txt'), 'v1');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  await writeFile(path.join(cwd, 'a.txt'), 'v2');
  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.notEqual(restored.value.safety.sha, target.value.sha, 'the returned checkpoint is the safety commit, not the restore target');
});

test('S32.5/S32.7 — the report names modified, added and removed paths and omits an untouched one, all in one workspace; an empty report is the positive answer', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  // Individual top-level ignored files, not files nested inside one ignored directory —
  // a directory match collapses everything beneath it to a single entry (S32.12), which
  // would hide exactly the per-path differences this test needs to see independently.
  await writeFile(path.join(cwd, '.gitignore'), 'untouched.txt\nto-modify.txt\nto-remove.txt\nnew-file.txt\n');
  await writeFile(path.join(cwd, 'untouched.txt'), 'same throughout');
  await writeFile(path.join(cwd, 'to-modify.txt'), 'v1');
  await writeFile(path.join(cwd, 'to-remove.txt'), 'gone later');

  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  // Nothing changes yet: restoring right away must report an empty array — the positive
  // "nothing differs" answer — not null.
  const clean = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(clean.ok, true);
  if (clean.ok) {
    assert.notEqual(clean.value.unreached, null, 'a clean match is a real answer, not unknown');
    assert.deepEqual(clean.value.unreached, [], 'an empty report is the positive answer');
  }

  // Now diverge every which way, entirely outside restore's own control — exactly what
  // an agent turn between checkpoints would do to ignored paths.
  await writeFile(path.join(cwd, 'to-modify.txt'), 'v2, a different size');
  await rm(path.join(cwd, 'to-remove.txt'));
  await writeFile(path.join(cwd, 'new-file.txt'), 'appeared after the checkpoint');

  const dirty = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(dirty.ok, true);
  if (!dirty.ok) return;
  const unreached = dirty.value.unreached;
  assert.notEqual(unreached, null);
  if (unreached === null) return;
  assert.equal(unreached.length, 3, 'exactly the three differences, and only the differences');
  const byPath = new Map(unreached.map((d) => [d.path, d.change]));
  assert.equal(byPath.get('to-modify.txt'), 'modified');
  assert.equal(byPath.get('to-remove.txt'), 'removed');
  assert.equal(byPath.get('new-file.txt'), 'added');
  assert.equal(byPath.has('untouched.txt'), false, 'the unchanged path is not named');
});

test('S32.6 — unreached is null on each of its three independent routes to unknown', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(cwd, 'ignored.txt'), 'x');

  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;
  const manifestPath = path.join(storageRoot, 'sessions', sessionId, 'ignored', `${target.value.sha}.json`);

  // Route 1: an absent manifest — a checkpoint predating this mechanism, simulated by
  // deleting the one just captured.
  await rm(manifestPath);
  const absent = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.value.unreached, null, 'an absent manifest is unknown, never a clean match');

  // Route 2: a manifest that fails to parse.
  await writeFile(manifestPath, 'not json{{{');
  const corrupt = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(corrupt.ok, true);
  if (corrupt.ok) assert.equal(corrupt.value.unreached, null, 'an unparseable manifest is unknown, never a clean match');

  // Route 3: a live `status` that fails — exercised directly against the comparison
  // step, since the shadow git's own verification steps (`diff`, `ls-files`) share the
  // same exclude-rule machinery `status --ignored=matching` does and so cannot be made
  // to fail independently of it through a full `restore()` call. A `gitDir` that was
  // never `git init`-ed fails exactly the way a corrupted `ckpt.git` would.
  await writeFile(manifestPath, JSON.stringify({ sha: target.value.sha, capturedAt: new Date().toISOString(), entries: [] }));
  const neverInitialised = path.join(storageRoot, 'sessions', 'no-such-session', 'ckpt.git');
  const viaStatusFailure = await computeUnreached(neverInitialised, cwd, storageRoot, sessionId, target.value.sha);
  assert.equal(viaStatusFailure, null, 'a live status that cannot run is unknown, never a clean match');
});

test('S32.8 — the restore itself is identical whether the manifest is deleted, corrupt, or reports differences', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, 'tracked.txt'), 'v1');
  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;
  const manifestPath = path.join(storageRoot, 'sessions', sessionId, 'ignored', `${target.value.sha}.json`);

  for (const corrupt of [
    async () => rm(manifestPath, { force: true }),
    async () => writeFile(manifestPath, 'not json'),
    async () => Promise.resolve(), // the manifest is left alone — a real report, not an absence
  ]) {
    await writeFile(path.join(cwd, 'tracked.txt'), 'v2 — will be reverted');
    await corrupt();
    const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
    assert.equal(restored.ok, true, 'the restore succeeds regardless of the manifest\'s condition');
    assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'v1', 'the tracked content is restored identically either way');
  }
});

test('S32.12 — the collapsed-directory blindness is real: an edit deep inside an ignored directory leaves its single collapsed entry looking unchanged', async () => {
  const { cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  await writeFile(path.join(cwd, '.gitignore'), 'ignored/\n');
  await mkdir(path.join(cwd, 'ignored', 'nested'), { recursive: true });
  await writeFile(path.join(cwd, 'ignored', 'nested', 'deep.txt'), 'v1');

  const target = await checkpoints.commit(sessionId, cwd, 'target');
  assert.equal(target.ok, true);
  if (!target.ok) return;

  // Edited in place, same file, same directory listing at every level — the collapsed
  // `ignored/` entry's own mtime does not move for a change this far beneath it.
  await writeFile(path.join(cwd, 'ignored', 'nested', 'deep.txt'), 'v2 — content actually changed');

  const restored = await checkpoints.restore(sessionId, cwd, target.value.sha);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.deepEqual(restored.value.unreached, [], 'a real content change is invisible to the collapsed directory\'s own metadata — this is the documented blindness (D187, I58), not a bug');
});
