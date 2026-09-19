// Self-test for cdp.js's profile-directory cleanup. No browser involved — pure function over
// an injected rmSync — so this runs in the ordinary `npm test`, no Chromium-family browser
// needed. Covers the CI hang: a real Windows rmSync throwing ENOTEMPTY/EBUSY/EPERM right after
// the browser process exits (antivirus or the OS still holding a handle a moment longer) must
// not propagate, since a throw here previously pre-empted the caller's next cleanup step
// (closing the static server) and left the process hung rather than exited.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { removeUserDataDir } from './cdp.js';

test('removeUserDataDir warns instead of throwing when rmSync keeps failing', () => {
  const err = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
  const failingRm = mock.fn(() => {
    throw err;
  });
  assert.doesNotThrow(() => removeUserDataDir('/fake/profile-dir', failingRm));
  assert.equal(failingRm.mock.callCount(), 1);
});

test('removeUserDataDir asks rmSync to retry, for the Windows post-kill handle race', () => {
  const rm = mock.fn(() => {});
  removeUserDataDir('/fake/profile-dir', rm);
  const [, options] = rm.mock.calls[0].arguments;
  assert.equal(options.recursive, true);
  assert.equal(options.force, true);
  assert.ok(options.maxRetries > 0);
  assert.ok(options.retryDelay > 0);
});

test('removeUserDataDir defaults to the real rmSync and removes an actual directory', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'skynet-hr-browser-cdp-test-'));
  removeUserDataDir(dir);
  assert.equal(existsSync(dir), false);
});
