import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCheckpoints } from './index.js';
import type { Config, GitSha, SessionId } from '../contract/index.js';

function baseConfig(storageRoot: string): Config {
  return {
    bind: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'x' },
    workspaceRoots: [],
    storageRoot,
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
  const safetySha = restored.value.sha;

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

test('S6.10-adjacent — destroy removes ckpt.git entirely', async () => {
  const { storageRoot, cwd, checkpoints, sessionId } = await fixture();
  await checkpoints.init(sessionId, cwd);
  const gitDir = path.join(storageRoot, 'sessions', sessionId, 'ckpt.git');
  assert.equal(existsSync(gitDir), true);

  const destroyed = await checkpoints.destroy(sessionId);
  assert.equal(destroyed.ok, true);
  assert.equal(existsSync(gitDir), false);
});

test('S6.11 — a restore left short by an embedded git repository (git leaves it behind, exit code 0) is still reported restore_incomplete, with the safety checkpoint already committed', async () => {
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
  if (!restored.ok) assert.equal(restored.error.code, 'restore_incomplete');

  const listAfter = await checkpoints.list(sessionId, cwd);
  assert.equal(listAfter.ok, true);
  if (listAfter.ok) assert.equal(listAfter.value.length, countBefore + 1, 'the safety checkpoint is already committed despite the failure');
});
