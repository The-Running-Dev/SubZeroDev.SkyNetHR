import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RENAME_RETRY_DELAYS_MS, renameOver } from './rename-over.js';

// Issues #511 and #382: Windows refuses a rename-over while another rename onto the same target
// is in flight. These pin the retry rule itself, independent of when the race happens to land.
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

test('#511 — renameOver retries a transient EPERM and completes the rename', async () => {
  let calls = 0;
  await renameOver('from', 'to', async () => {
    calls += 1;
    if (calls <= 2) throw errnoError('EPERM');
  });
  assert.equal(calls, 3, 'two refusals, then the rename lands');
});

test('#511 — renameOver rethrows a non-transient error without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    renameOver('from', 'to', async () => {
      calls += 1;
      throw errnoError('ENOENT');
    }),
    { code: 'ENOENT' },
  );
  assert.equal(calls, 1);
});

test('#511 — renameOver gives up on a refusal that outlasts its bounded retries', async () => {
  let calls = 0;
  await assert.rejects(
    renameOver('from', 'to', async () => {
      calls += 1;
      throw errnoError('EPERM');
    }),
    { code: 'EPERM' },
  );
  assert.equal(calls, RENAME_RETRY_DELAYS_MS.length + 1, 'one attempt per retry, then a last one that throws');
});

// The real race, on the real filesystem: two renames onto one target at once. On Windows the
// unretried form fails this on most runs of 200 rounds; elsewhere it passes either way.
test('#511 — two simultaneous rename-overs onto one target both land', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'skynet-rename-over-'));
  try {
    const target = path.join(dir, 'target.json');
    await writeFile(target, '{}');
    let failures = 0;
    for (let round = 0; round < 200; round += 1) {
      const sources = [path.join(dir, `a-${round}.tmp`), path.join(dir, `b-${round}.tmp`)];
      await Promise.all(sources.map((s) => writeFile(s, s)));
      const settled = await Promise.allSettled(sources.map((s) => renameOver(s, target)));
      failures += settled.filter((x) => x.status === 'rejected').length;
    }
    assert.equal(failures, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
