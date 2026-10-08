// Shadow-git checkpoints (S6, D31). A second `GIT_DIR` per session, pointed at the
// session's `cwd` as its work-tree — `--git-dir`/`--work-tree` are passed on every
// invocation rather than relied on from config, so a stray `GIT_DIR` in this process's
// own environment can never redirect a command at the operator's real repository (S6.1).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Checkpoint,
  CheckpointError,
  Checkpoints,
  RuntimeOptions,
  GitSha,
  IgnoredDelta,
  IgnoredEntry,
  IgnoredManifest,
  IsoTimestamp,
  ResolvedPath,
  Result,
  SessionId,
} from '../../core/types.js';
import { renameOver } from '../../process/rename-over.js';

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

// D187: the ignored-path manifest is a sibling of `ckpt.git`, owned by this module rather
// than by `store` — `checkpoints` already derives this directory from `config.storageRoot`
// and already runs the `status` a manifest is built from, so no module edge to `store` is
// added.
function ignoredDir(storageRoot: string, sessionId: SessionId): string {
  return path.join(storageRoot, 'sessions', sessionId, 'ignored');
}

function ignoredManifestPath(storageRoot: string, sessionId: SessionId, sha: GitSha): string {
  return path.join(ignoredDir(storageRoot, sessionId), `${sha}.json`);
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) delete env[key];
  return env;
}

export interface GitFailure {
  readonly message: string;
  readonly enoent: boolean;
}

// S38.5/S38.6: the one seam a test reaches the git invocations through — to record their
// order, or to make one of them fail. Production always runs `runGit` itself.
export type GitRunner = (gitDir: string, workTree: string, args: readonly string[]) => Promise<Result<string, GitFailure>>;

export async function runGit(gitDir: string, workTree: string, args: readonly string[]): Promise<Result<string, GitFailure>> {
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

// Temp-file-then-atomic-rename, the same discipline `store`'s own `atomicWrite` uses for
// `meta.json` (I61) — duplicated in miniature here rather than imported, since D187
// deliberately gives `checkpoints` no dependency edge to `store`. The rename itself is the
// shared `renameOver` (#382), which lives beside the append log rather than in `store`.
async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmpPath, JSON.stringify(value));
  await renameOver(tmpPath, targetPath);
}

// One line of `git status --porcelain=v1 -z --ignored=matching` per ignored path, `-z` so a
// path with an unusual character is never quoted and never needs unescaping. `matching`
// collapses an ignored directory into a single entry rather than walking beneath it (I58's
// collapsed-directory blindness starts here) — the entry's own trailing `/` is how a
// collapsed directory is told apart from a file.
export async function listIgnoredEntries(gitDir: string, cwd: string, git: GitRunner = runGit): Promise<IgnoredEntry[]> {
  const status = await git(gitDir, cwd, ['status', '--porcelain=v1', '-z', '--ignored=matching']);
  if (!status.ok) throw new Error(status.error.message);

  const entries: IgnoredEntry[] = [];
  for (const record of status.value.split('\0')) {
    if (!record.startsWith('!! ')) continue;
    const rawPath = record.slice(3);
    if (rawPath.length === 0) continue;
    const isDir = rawPath.endsWith('/');
    const entryPath = isDir ? rawPath.slice(0, -1) : rawPath;
    try {
      const info = await stat(path.join(cwd, rawPath));
      entries.push({ path: entryPath, kind: isDir ? 'dir' : 'file', sizeBytes: isDir ? null : info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Vanished between `status` and `stat` — nothing to report for a path that no
      // longer exists either way.
    }
  }
  return entries;
}

// S32.3: a capture failure never fails the commit. The checkpoint is worth more than its
// manifest, so this is swallowed rather than propagated — a later restore reports the
// missing manifest as unknown (I58), never as a failure of its own.
//
// `known` is a restore's protected set, read moments before its safety commit with nothing
// written in between: reusing it keeps that read the restore's only one before `read-tree`
// (I77, S38.6), rather than a second `status` inside the commit.
async function captureIgnoredManifest(git: GitRunner, gitDir: string, cwd: string, storageRoot: string, sessionId: SessionId, sha: GitSha, known?: readonly IgnoredEntry[]): Promise<void> {
  try {
    const entries = known ?? await listIgnoredEntries(gitDir, cwd, git);
    const manifest: IgnoredManifest = { sha, capturedAt: new Date().toISOString() as IsoTimestamp, entries };
    await atomicWriteJson(ignoredManifestPath(storageRoot, sessionId, sha), manifest);
  } catch {
    // See above.
  }
}

// I58/S32.6: `null` means the comparison could not be made, and it has exactly three
// routes — an absent manifest, one that fails to parse, and a live `status` that fails —
// each its own `catch` here so a test can force each independently. An empty array is the
// positive answer: the two sides matched on every entry.
export async function computeUnreached(gitDir: string, cwd: string, storageRoot: string, sessionId: SessionId, targetSha: GitSha, git: GitRunner = runGit): Promise<readonly IgnoredDelta[] | null> {
  let target: IgnoredManifest;
  try {
    const raw = await readFile(ignoredManifestPath(storageRoot, sessionId, targetSha), 'utf8');
    const parsed = JSON.parse(raw) as IgnoredManifest;
    if (!Array.isArray(parsed.entries)) throw new Error('malformed manifest: entries is not an array');
    target = parsed;
  } catch {
    return null;
  }

  let current: IgnoredEntry[];
  try {
    current = await listIgnoredEntries(gitDir, cwd, git);
  } catch {
    return null;
  }

  const targetByPath = new Map(target.entries.map((e) => [e.path, e] as const));
  const currentByPath = new Map(current.map((e) => [e.path, e] as const));
  const deltas: IgnoredDelta[] = [];
  for (const [entryPath, was] of targetByPath) {
    const now = currentByPath.get(entryPath);
    if (now === undefined) deltas.push({ path: entryPath, change: 'removed' });
    else if (now.kind !== was.kind || now.sizeBytes !== was.sizeBytes || now.mtimeMs !== was.mtimeMs) deltas.push({ path: entryPath, change: 'modified' });
  }
  for (const entryPath of currentByPath.keys()) {
    if (!targetByPath.has(entryPath)) deltas.push({ path: entryPath, change: 'added' });
  }
  return deltas;
}

async function doCommit(git: GitRunner, gitDir: string, cwd: string, label: string, storageRoot: string, sessionId: SessionId, knownIgnored?: readonly IgnoredEntry[]): Promise<Result<Checkpoint, CheckpointError>> {
  const added = await git(gitDir, cwd, ['add', '-A']);
  if (!added.ok) return { ok: false, error: commitFailure(gitDir, added.error) };

  const committed = await git(gitDir, cwd, ['commit', '--allow-empty', '-m', label]);
  if (!committed.ok) return { ok: false, error: commitFailure(gitDir, committed.error) };

  const sha = await git(gitDir, cwd, ['rev-parse', 'HEAD']);
  if (!sha.ok) return { ok: false, error: { code: 'commit_failed', detail: sha.error.message } };

  const ts = await git(gitDir, cwd, ['log', '-1', '--format=%cI']);
  if (!ts.ok) return { ok: false, error: { code: 'commit_failed', detail: ts.error.message } };

  const checkpoint: Checkpoint = { sha: sha.value.trim() as GitSha, label, ts: ts.value.trim() as IsoTimestamp };
  await captureIgnoredManifest(git, gitDir, cwd, storageRoot, sessionId, checkpoint.sha, knownIgnored);
  return { ok: true, value: checkpoint };
}

// `p` is at or beneath `entry`: the entry itself, or a path inside the directory it names.
function atOrBeneath(p: string, entry: string): boolean {
  return p === entry || p.startsWith(`${entry}/`);
}

// D267's three collision shapes, looked up in the target's tree and never the work-tree: a
// protected path the target holds, one the target holds paths beneath, and one beneath a
// path the target holds as a file. Every colliding entry is returned, not the first (S38.4).
function collisions(protectedSet: readonly IgnoredEntry[], targetPaths: readonly string[]): string[] {
  const held = new Set(targetPaths);
  const holdsBeneath = new Set<string>();
  for (const t of targetPaths) {
    for (let i = t.indexOf('/'); i !== -1; i = t.indexOf('/', i + 1)) holdsBeneath.add(t.slice(0, i));
  }
  const colliding: string[] = [];
  for (const { path: p } of protectedSet) {
    let hit = held.has(p) || holdsBeneath.has(p);
    for (let i = p.indexOf('/'); !hit && i !== -1; i = p.indexOf('/', i + 1)) hit = held.has(p.slice(0, i));
    if (hit) colliding.push(p);
  }
  return colliding;
}

export function createCheckpoints(config: Pick<RuntimeOptions, 'storageRoot'>, identity: { name: string; email: string }, git: GitRunner = runGit): Checkpoints {
  return {
    async init(sessionId: SessionId, cwd: ResolvedPath) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      try {
        await mkdir(gitDir, { recursive: true });
      } catch (err) {
        return { ok: false, error: { code: 'init_failed', detail: (err as Error).message } };
      }

      const init = await git(gitDir, cwd, ['init', '--quiet']);
      if (!init.ok) return { ok: false, error: initFailure(init.error) };

      // A committer identity, and no signing — this is bookkeeping this server owns,
      // never a commit an operator authored, so it must not depend on (or fight with) a
      // git identity or a signing key configured on the machine for the operator's own
      // repositories.
      const name = await git(gitDir, cwd, ['config', 'user.name', identity.name]);
      if (!name.ok) return { ok: false, error: initFailure(name.error) };
      const email = await git(gitDir, cwd, ['config', 'user.email', identity.email]);
      if (!email.ok) return { ok: false, error: initFailure(email.error) };
      const noSign = await git(gitDir, cwd, ['config', 'commit.gpgsign', 'false']);
      if (!noSign.ok) return { ok: false, error: initFailure(noSign.error) };

      return { ok: true, value: undefined };
    },

    async commit(sessionId: SessionId, cwd: ResolvedPath, label: string) {
      return doCommit(git, ckptGitDir(config.storageRoot, sessionId), cwd, label, config.storageRoot, sessionId);
    },

    async list(sessionId: SessionId, cwd: ResolvedPath) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      // A shadow repo with no commits yet (a session that has never run a turn, or whose
      // `init` never completed) is `git log`'s ordinary failure mode — an unborn HEAD —
      // not a real error; there is nothing to list either way (S6.2's "before each turn"
      // means the first checkpoint exists only once a turn has actually started). Every
      // other failure (a missing git binary, a corrupted `ckpt.git`, a permissions/I/O
      // error) is a real failure and must not be reported as "no checkpoints" the same
      // way — only git's own unborn-HEAD message is treated as empty.
      const log = await git(gitDir, cwd, ['log', `--format=%H${FIELD_SEP}%s${FIELD_SEP}%cI`]);
      if (!log.ok) {
        if (/does not have any commits yet/.test(log.error.message)) return { ok: true, value: [] };
        return { ok: false, error: initFailure(log.error) };
      }

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
      const verified = await git(gitDir, cwd, ['cat-file', '-e', sha]);
      if (!verified.ok) return { ok: false, error: { code: 'no_such_checkpoint', sha } };

      // I77/D267: the protected set — what the workspace's rules ignore as the restore
      // starts — read once, before anything is written. Every later step is held to it,
      // including after `read-tree` has written the target's own `.gitignore`, which is the
      // case a per-step reading of the rules got wrong. Unreadable means refused, untouched.
      let protectedSet: IgnoredEntry[];
      try {
        protectedSet = await listIgnoredEntries(gitDir, cwd, git);
      } catch (err) {
        return { ok: false, error: { code: 'ignored_set_unreadable', detail: `the ignored paths could not be read: ${(err as Error).message}` } };
      }

      // Preflight against the target's tree, before any write. `read-tree -u` would
      // overwrite or delete whatever stands at a protected path the target holds, and the
      // server never resolves that for the operator — not with `add -f`, not by deleting.
      // A tree that cannot be listed is the same refusal as a set that cannot be read:
      // nothing is written yet, so it must not read as a partial restore.
      if (protectedSet.length > 0) {
        const tree = await git(gitDir, cwd, ['ls-tree', '-r', '--name-only', '-z', sha]);
        if (!tree.ok) return { ok: false, error: { code: 'ignored_set_unreadable', detail: `the target's tree could not be listed for the preflight: ${tree.error.message}` } };
        const colliding = collisions(protectedSet, tree.value.split('\0').filter((p) => p.length > 0));
        if (colliding.length > 0) return { ok: false, error: { code: 'ignored_path_collision', paths: colliding } };
      }

      // D31: the safety checkpoint first — `add -A` and commit, the same primitive an
      // ordinary pre-turn checkpoint uses — so a restore to the wrong `sha` is itself
      // recoverable. This is what the return value is, not the target. Its manifest is the
      // protected set already read, never a second `status` (S38.6).
      const safety = await doCommit(git, gitDir, cwd, `before restore to ${sha}`, config.storageRoot, sessionId, protectedSet);
      if (!safety.ok) return safety;

      // `checkout <sha> -- .` only ever writes paths present in `<sha>`'s tree; a file
      // the safety commit above just tracked but that `<sha>` does not have would stay
      // tracked and behind on disk forever. `read-tree --reset -u` instead makes the index
      // (and, via `-u`, the work-tree) match `<sha>` exactly — additions, edits and
      // removals alike, an emptied directory going with its last file — without moving
      // `HEAD` or the branch, so the checkpoint history this repo's `log` walks stays
      // linear through every later commit. No `clean` follows it (D267): the only work it
      // had left was deleting a path the current rules ignore and the target's do not,
      // which is exactly what the protected set exists to stop.
      const reset = await git(gitDir, cwd, ['read-tree', '--reset', '-u', sha]);
      if (!reset.ok) return { ok: false, error: { code: 'restore_incomplete', detail: reset.error.message } };

      // Verified rather than inferred from an exit code: `read-tree` exits 0 with only a
      // warning on stderr when it cannot `rmdir` a directory an embedded repository still
      // occupies. A restore that leaves the work-tree short of the target must not be
      // reported as one that fully happened. Two checks, because one alone misses half of
      // it: `diff --quiet <sha>` catches every tracked-content mismatch against the target,
      // and `ls-files --others --exclude-standard` — under the rules the target just wrote —
      // catches what was left behind, less the protected set. A protected path the target
      // does not ignore is untracked by construction: it is exposed, not left behind (D277).
      const diffed = await git(gitDir, cwd, ['diff', '--quiet', sha]);
      if (!diffed.ok) {
        return { ok: false, error: { code: 'restore_incomplete', detail: `the work-tree still differs from the target after restore: ${diffed.error.message}` } };
      }
      const others = await git(gitDir, cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
      if (!others.ok) {
        return { ok: false, error: { code: 'restore_incomplete', detail: others.error.message } };
      }
      const exposedSet = new Set<string>();
      const leftover: string[] = [];
      for (const listed of others.value.split('\0')) {
        if (listed.length === 0) continue;
        const p = listed.endsWith('/') ? listed.slice(0, -1) : listed;
        const holder = protectedSet.find((e) => atOrBeneath(p, e.path));
        if (holder) exposedSet.add(holder.path);
        else leftover.push(listed);
      }
      if (leftover.length > 0) {
        return { ok: false, error: { code: 'restore_incomplete', detail: `paths left behind that the target does not have:\n${leftover.join('\n')}` } };
      }
      // In protected-set order, and one name per entry however much of a collapsed
      // directory the read listed beneath it.
      const exposed = protectedSet.filter((e) => exposedSet.has(e.path)).map((e) => e.path);

      // D182: the report runs last, and now it must — it reads the workspace under the
      // rules the target wrote, which are the rules the target's manifest was captured
      // under. It never delays the restore and never has a way to prevent one (S32.9). A
      // dirty verification pass above returns before this line is ever reached, so a failed
      // restore carries no report (S32.10).
      const unreached = await computeUnreached(gitDir, cwd, config.storageRoot, sessionId, sha, git);

      return { ok: true, value: { safety: safety.value, unreached, exposed } };
    },

    async destroy(sessionId: SessionId) {
      const gitDir = ckptGitDir(config.storageRoot, sessionId);
      try {
        await rm(gitDir, { recursive: true, force: true });
        // S32.11: a deleted session's manifests go with its shadow git directory.
        await rm(ignoredDir(config.storageRoot, sessionId), { recursive: true, force: true });
      } catch (err) {
        return { ok: false, error: { code: 'init_failed', detail: (err as Error).message } };
      }
      return { ok: true, value: undefined };
    },
  };
}
