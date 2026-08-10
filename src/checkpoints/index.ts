// Shadow-git checkpoints (S6, D31). A second `GIT_DIR` per session, pointed at the
// session's `cwd` as its work-tree — `--git-dir`/`--work-tree` are passed on every
// invocation rather than relied on from config, so a stray `GIT_DIR` in this process's
// own environment can never redirect a command at the operator's real repository (S6.1).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Checkpoint, CheckpointError, Checkpoints, Config, GitSha, IsoTimestamp, ResolvedPath, Result, SessionId } from '../contract/index.js';

const execFileAsync = promisify(execFile);

// `%x1f` (unit separator) can never appear in a label this codebase constructs or in
// git's own `%cI` date format, so splitting on it never mistakes a field boundary for
// data the way a comma or a space could.
const FIELD_SEP = '\x1f';

// Vars a caller's own environment could carry that would redirect a git invocation away
// from the `--git-dir`/`--work-tree` given explicitly on the command line.
const GIT_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG'] as const;

function ckptGitDir(storageRoot: string, sessionId: SessionId): string {
  return path.join(storageRoot, 'sessions', sessionId, 'ckpt.git');
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) delete env[key];
  return env;
}

interface GitFailure {
  readonly message: string;
  readonly enoent: boolean;
}

async function runGit(gitDir: string, workTree: string, args: readonly string[]): Promise<Result<string, GitFailure>> {
  try {
    const { stdout } = await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, ...args], {
      env: cleanEnv(),
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, value: stdout };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    return { ok: false, error: { message: nodeErr.message, enoent: nodeErr.code === 'ENOENT' } };
  }
}

function initFailure(f: GitFailure): CheckpointError {
  return f.enoent ? { code: 'git_unavailable', detail: f.message } : { code: 'init_failed', detail: f.message };
}

// S6.9/D42: `ckpt.git/index.lock` existing is the one commit failure a caller is asked
// to name specifically (planted deliberately in the test that exercises it), because it
// is transient — the turn proceeds and the next turn's commit tries again. Every other
// commit failure is opaque; there is nothing more specific to say about it.
function commitFailure(gitDir: string, f: GitFailure): CheckpointError {
  return existsSync(path.join(gitDir, 'index.lock'))
    ? { code: 'locked', detail: `ckpt.git/index.lock exists — git said: ${f.message}` }
    : { code: 'commit_failed', detail: f.message };
}

async function doCommit(gitDir: string, cwd: string, label: string): Promise<Result<Checkpoint, CheckpointError>> {
  const added = await runGit(gitDir, cwd, ['add', '-A']);
  if (!added.ok) return { ok: false, error: commitFailure(gitDir, added.error) };

  const committed = await runGit(gitDir, cwd, ['commit', '--allow-empty', '-m', label]);
  if (!committed.ok) return { ok: false, error: commitFailure(gitDir, committed.error) };

  const sha = await runGit(gitDir, cwd, ['rev-parse', 'HEAD']);
  if (!sha.ok) return { ok: false, error: { code: 'commit_failed', detail: sha.error.message } };

  const ts = await runGit(gitDir, cwd, ['log', '-1', '--format=%cI']);
  if (!ts.ok) return { ok: false, error: { code: 'commit_failed', detail: ts.error.message } };

  return { ok: true, value: { sha: sha.value.trim() as GitSha, label, ts: ts.value.trim() as IsoTimestamp } };
}

export function createCheckpoints(config: Config): Checkpoints {
  return {
    async init(sessionId: SessionId, cwd: ResolvedPath) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      try {
        await mkdir(gitDir, { recursive: true });
      } catch (err) {
        return { ok: false, error: { code: 'init_failed', detail: (err as Error).message } };
      }

      const init = await runGit(gitDir, cwd, ['init', '--quiet']);
      if (!init.ok) return { ok: false, error: initFailure(init.error) };

      // A committer identity, and no signing — this is bookkeeping this server owns,
      // never a commit an operator authored, so it must not depend on (or fight with) a
      // git identity or a signing key configured on the machine for the operator's own
      // repositories.
      const name = await runGit(gitDir, cwd, ['config', 'user.name', 'skynet-hr']);
      if (!name.ok) return { ok: false, error: initFailure(name.error) };
      const email = await runGit(gitDir, cwd, ['config', 'user.email', 'checkpoints@skynet-hr.local']);
      if (!email.ok) return { ok: false, error: initFailure(email.error) };
      const noSign = await runGit(gitDir, cwd, ['config', 'commit.gpgsign', 'false']);
      if (!noSign.ok) return { ok: false, error: initFailure(noSign.error) };

      return { ok: true, value: undefined };
    },

    async commit(sessionId: SessionId, cwd: ResolvedPath, label: string) {
      return doCommit(ckptGitDir(config.storageRoot, sessionId), cwd, label);
    },

    async list(sessionId: SessionId, cwd: ResolvedPath) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      // A shadow repo with no commits yet (a session that has never run a turn, or whose
      // `init` never completed) is `git log`'s ordinary failure mode — an unborn HEAD —
      // not a real error; there is nothing to list either way (S6.2's "before each turn"
      // means the first checkpoint exists only once a turn has actually started).
      const log = await runGit(gitDir, cwd, ['log', `--format=%H${FIELD_SEP}%s${FIELD_SEP}%cI`]);
      if (!log.ok) return { ok: true, value: [] };

      const checkpoints: Checkpoint[] = [];
      for (const line of log.value.split('\n')) {
        if (line.length === 0) continue;
        const [sha, label, ts] = line.split(FIELD_SEP);
        if (sha === undefined || label === undefined || ts === undefined) continue;
        checkpoints.push({ sha: sha as GitSha, label, ts: ts as IsoTimestamp });
      }
      return { ok: true, value: checkpoints };
    },

    async restore(sessionId: SessionId, cwd: ResolvedPath, sha: GitSha) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);

      // Verified before anything is touched: S6.5 promises the workspace untouched on a
      // `404 no_such_checkpoint`, and checking first means an unknown `sha` never costs
      // the shadow history a wasted safety commit either.
      const verified = await runGit(gitDir, cwd, ['cat-file', '-e', sha]);
      if (!verified.ok) return { ok: false, error: { code: 'no_such_checkpoint', sha } };

      // D31: the safety checkpoint first — `add -A` and commit, the same primitive an
      // ordinary pre-turn checkpoint uses — so a restore to the wrong `sha` is itself
      // recoverable. This is what the return value is, not the target.
      const safety = await doCommit(gitDir, cwd, `before restore to ${sha}`);
      if (!safety.ok) return safety;

      // `checkout <sha> -- .` only ever writes paths present in `<sha>`'s tree; a file
      // the safety commit above just tracked but that `<sha>` does not have would stay
      // tracked and behind on disk forever, because `clean` never removes a tracked
      // path. `read-tree --reset -u` instead makes the index (and, via `-u`, the
      // work-tree) match `<sha>` exactly — additions, edits and removals alike — without
      // moving `HEAD` or the branch, so the checkpoint history this repo's `log` walks
      // stays linear through every later commit.
      const reset = await runGit(gitDir, cwd, ['read-tree', '--reset', '-u', sha]);
      if (!reset.ok) return { ok: false, error: { code: 'restore_incomplete', detail: reset.error.message } };

      // Belt and suspenders for what `read-tree -u` does not do on its own: remove a
      // directory `read-tree` emptied out, and sweep up anything genuinely untracked
      // that somehow still exists. No `-x`, so a path ignored by the workspace's own
      // `.gitignore` is left alone either way (S6.6).
      const cleaned = await runGit(gitDir, cwd, ['clean', '-fd']);
      if (!cleaned.ok) return { ok: false, error: { code: 'restore_incomplete', detail: cleaned.error.message } };

      // Neither step above is guaranteed atomic, and git tells some failures apart from
      // success only by what it leaves behind rather than by its exit code: `read-tree`
      // exits 0 with only a warning on stderr when it cannot `rmdir` a directory an
      // embedded repository still occupies, and `clean` silently declines to remove a
      // directory holding a nested `.git` unless forced twice, which this deliberately
      // never does (an embedded repository is exactly the kind of thing "clean" should
      // not casually destroy). A restore that leaves the work-tree short of the target —
      // by whatever mechanism — must not be reported as one that fully happened, so this
      // is verified rather than assumed. Two checks, because one alone misses half of it:
      // `diff --quiet <sha>` catches every tracked-content mismatch against the target,
      // but says nothing about a leftover directory `clean` declined to touch, since that
      // directory is untracked by definition — `ls-files --others --exclude-standard`
      // (honouring `.gitignore`, per S6.6) is what catches that half.
      const diffed = await runGit(gitDir, cwd, ['diff', '--quiet', sha]);
      if (!diffed.ok) {
        return { ok: false, error: { code: 'restore_incomplete', detail: `the work-tree still differs from the target after restore: ${diffed.error.message}` } };
      }
      const leftover = await runGit(gitDir, cwd, ['ls-files', '--others', '--exclude-standard']);
      if (!leftover.ok) {
        return { ok: false, error: { code: 'restore_incomplete', detail: leftover.error.message } };
      }
      if (leftover.value.trim().length > 0) {
        return { ok: false, error: { code: 'restore_incomplete', detail: `paths left behind that the target does not have:\n${leftover.value.trim()}` } };
      }

      return { ok: true, value: safety.value };
    },

    async destroy(sessionId: SessionId) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      try {
        await rm(gitDir, { recursive: true, force: true });
      } catch (err) {
        // No dedicated teardown code exists in `CheckpointError` (only lifecycle codes
        // for init/commit/restore); `init_failed` is the closest existing member for "the
        // shadow git directory could not be managed on disk" and the caller (S5.11's
        // notice path) reports the detail string regardless of which variant this is.
        return { ok: false, error: { code: 'init_failed', detail: (err as Error).message } };
      }
      return { ok: true, value: undefined };
    },
  };
}
