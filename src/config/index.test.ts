import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from './index.js';

const execFileAsync = promisify(execFile);

// Real, sibling directories — WORKSPACE_ROOTS is canonicalised at load, and STORAGE_ROOT
// must not overlap it (S31, D185).
const root = path.join(tmpdir(), `skynet-config-test-${process.pid}`);
const storageDir = path.join(root, 'storage');
const workspaceDir = path.join(root, 'workspace');
mkdirSync(storageDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_MODE: 'proxy-header',
    AUTH_USER_HEADER: 'x-forwarded-user',
    WORKSPACE_ROOTS: workspaceDir,
    STORAGE_ROOT: storageDir,
    ...over,
  };
}

describe('config — fail closed on startup (S2.8)', () => {
  it('refuses a configuration with no auth mode at parse time, naming the field', () => {
    const r = loadConfig(env({ AUTH_MODE: undefined }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok === false && r.error, { code: 'missing_field', field: 'AUTH_MODE' });
  });

  it('refuses a routable bind that no trustProxy allow-list covers, naming the bind', () => {
    const r = loadConfig(env({ BIND_HOST: '0.0.0.0', BIND_PORT: '8080' }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'insecure_bind');
    assert.equal(r.ok === false && r.error.code === 'insecure_bind' && r.error.bind, '0.0.0.0:8080');
  });

  it('allows a routable bind once trustProxy names an upstream', () => {
    const r = loadConfig(env({ BIND_HOST: '0.0.0.0', TRUST_PROXY: '10.0.0.1' }));
    assert.equal(r.ok, true);
  });

  it('allows a loopback bind with no trustProxy', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      assert.equal(loadConfig(env({ BIND_HOST: host })).ok, true, host);
    }
  });

  it('allows any 127.0.0.0/8 alias, not just 127.0.0.1', () => {
    for (const host of ['127.0.0.2', '127.1.2.3', '127.255.255.255']) {
      assert.equal(loadConfig(env({ BIND_HOST: host })).ok, true, host);
    }
  });

  it('does not apply the bind rule to shared-secret mode, which trusts no header', () => {
    const r = loadConfig(
      env({
        AUTH_MODE: 'shared-secret',
        AUTH_USER_HEADER: undefined,
        AUTH_COOKIE_NAME: 'skynet',
        AUTH_SECRET: 's3cr3t',
        BIND_HOST: '0.0.0.0',
      }),
    );
    assert.equal(r.ok, true);
  });

  it('applies the bind rule to open-webui mode, which does trust a header', () => {
    const r = loadConfig(
      env({ AUTH_MODE: 'open-webui', AUTH_USER_HEADER: 'x-user-id', AUTH_SESSION_HEADER: 'x-session-id', BIND_HOST: '0.0.0.0' }),
    );
    assert.equal(r.ok === false && r.error.code, 'insecure_bind');
  });

  it('defaults the bind to loopback', () => {
    const r = loadConfig(env());
    assert.equal(r.ok && r.value.bind.host, '127.0.0.1');
  });
});

// D115: the `Max-Age` on the cookie `POST /api/login` mints is a deployment's, not a
// literal in the edge — shortening a session lifetime is what a deployment does after an
// incident and it must not need a release.
describe('config — the login cookie lifetime (D115)', () => {
  it('defaults to thirty days', () => {
    const r = loadConfig(env());
    assert.equal(r.ok && r.value.sessionCookieMaxAgeSeconds, 30 * 24 * 60 * 60);
  });

  it('takes an override from the environment', () => {
    const r = loadConfig(env({ SESSION_COOKIE_MAX_AGE_SECONDS: '3600' }));
    assert.equal(r.ok && r.value.sessionCookieMaxAgeSeconds, 3600);
  });

  it('refuses a value that is not a non-negative integer, naming the field', () => {
    for (const bad of ['-1', 'forever', '1.5', '30d']) {
      const r = loadConfig(env({ SESSION_COOKIE_MAX_AGE_SECONDS: bad }));
      assert.equal(r.ok, false, `expected '${bad}' to be refused`);
      assert.equal(r.ok === false && r.error.code, 'invalid_field', bad);
      assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'SESSION_COOKIE_MAX_AGE_SECONDS', bad);
    }
  });

  // An empty variable is an unset one, here as for every cap: `FOO=` in a compose file or a
  // shell profile is how a value gets un-overridden, and refusing it would make the one
  // security-relevant knob behave differently from the eight beside it.
  it('treats an empty variable as unset, taking the default', () => {
    const r = loadConfig(env({ SESSION_COOKIE_MAX_AGE_SECONDS: '' }));
    assert.equal(r.ok && r.value.sessionCookieMaxAgeSeconds, 30 * 24 * 60 * 60);
  });
});

describe('config — which edge binds (S11.5, D117)', () => {
  it("defaults to 'sse', so an existing deployment's behaviour is unchanged", () => {
    const r = loadConfig(env());
    assert.equal(r.ok && r.value.edge, 'sse');
  });

  it("takes 'ws' from EDGE", () => {
    const r = loadConfig(env({ EDGE: 'ws' }));
    assert.equal(r.ok && r.value.edge, 'ws');
  });

  it('refuses any other value, naming the field', () => {
    const r = loadConfig(env({ EDGE: 'polling' }));
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'EDGE');
  });

  it('treats an empty variable as unset, taking the default', () => {
    const r = loadConfig(env({ EDGE: '' }));
    assert.equal(r.ok && r.value.edge, 'sse');
  });
});

describe('config — the onboarding checklist (S14)', () => {
  it('defaults to an empty checklist', () => {
    const r = loadConfig(env());
    assert.deepEqual(r.ok && r.value.checklist, []);
  });

  it('parses a valid CHECKLIST_JSON', () => {
    const r = loadConfig(env({ CHECKLIST_JSON: '[{"id":"welcome","label":"Read the welcome guide"}]' }));
    assert.deepEqual(r.ok && r.value.checklist, [{ id: 'welcome', label: 'Read the welcome guide' }]);
  });

  it('refuses two items sharing an id, naming the field', () => {
    const r = loadConfig(
      env({ CHECKLIST_JSON: '[{"id":"welcome","label":"A"},{"id":"welcome","label":"B"}]' }),
    );
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'CHECKLIST_JSON');
  });
});

describe('config — the payroll cost tile\'s rates and currency (D158)', () => {
  it('defaults tokenRates and currency to null, so the tile is disabled', () => {
    const r = loadConfig(env());
    assert.equal(r.ok && r.value.tokenRates, null);
    assert.equal(r.ok && r.value.currency, null);
  });

  it('parses a valid TOKEN_RATES_JSON and CURRENCY', () => {
    const r = loadConfig(
      env({ TOKEN_RATES_JSON: '{"inputTokens":0.01,"outputTokens":0.02,"cacheRead":0.005,"cacheCreate":0.02}', CURRENCY: 'USD' }),
    );
    assert.deepEqual(r.ok && r.value.tokenRates, { inputTokens: 0.01, outputTokens: 0.02, cacheRead: 0.005, cacheCreate: 0.02 });
    assert.equal(r.ok && r.value.currency, 'USD');
  });

  it('refuses invalid JSON, naming the field', () => {
    const r = loadConfig(env({ TOKEN_RATES_JSON: 'not json' }));
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'TOKEN_RATES_JSON');
  });

  it('refuses a non-object, naming the field', () => {
    for (const bad of ['42', '"a string"', 'null']) {
      const r = loadConfig(env({ TOKEN_RATES_JSON: bad }));
      assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'TOKEN_RATES_JSON', bad);
    }
  });

  it('refuses a JSON array, distinctly from an object missing fields', () => {
    const r = loadConfig(env({ TOKEN_RATES_JSON: '[1,2,3,4]' }));
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'TOKEN_RATES_JSON');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.detail, 'must be an object');
  });

  it('refuses a rate object missing a required field', () => {
    const r = loadConfig(env({ TOKEN_RATES_JSON: '{"inputTokens":0.01,"outputTokens":0.02,"cacheRead":0.005}' }));
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'TOKEN_RATES_JSON');
  });

  it('refuses a negative rate', () => {
    const r = loadConfig(
      env({ TOKEN_RATES_JSON: '{"inputTokens":-0.01,"outputTokens":0.02,"cacheRead":0.005,"cacheCreate":0.02}' }),
    );
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'TOKEN_RATES_JSON');
  });

  it('treats an empty TOKEN_RATES_JSON as unset, taking null', () => {
    const r = loadConfig(env({ TOKEN_RATES_JSON: '' }));
    assert.equal(r.ok && r.value.tokenRates, null);
  });

  it('trims whitespace around CURRENCY before storing it', () => {
    const r = loadConfig(env({ CURRENCY: ' USD \n' }));
    assert.equal(r.ok && r.value.currency, 'USD');
  });

  it('treats a whitespace-only CURRENCY as unset, taking null', () => {
    const r = loadConfig(env({ CURRENCY: '   ' }));
    assert.equal(r.ok && r.value.currency, null);
  });
});

// Windows 8.3 short name for an entry inside `parentDir` — `dir /x`'s alias column,
// blank when the long name already fits 8.3. `null` when it cannot be determined at all,
// which callers treat as "skip this case" rather than a failure (mirrors the helper in
// `src/session-manager/index.test.ts`, S1.6/S5.7).
async function shortNameFor(parentDir: string, entryName: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('cmd.exe', ['/c', 'dir', '/x', parentDir]));
  } catch {
    return null;
  }
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(entryName);
    if (idx === -1 || !line.includes('<DIR>')) continue;
    const before = line.slice(0, idx).trim();
    const token = before.split(/\s+/).pop();
    return token && token !== entryName ? token : null;
  }
  return null;
}

describe('config — storage may not overlap a workspace root (S31, D185, I60)', () => {
  it('refuses a storage root equal to a workspace root, naming the field and the colliding root', () => {
    const r = loadConfig(env({ STORAGE_ROOT: workspaceDir }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'STORAGE_ROOT');
    assert.ok(
      r.ok === false && r.error.code === 'invalid_field' && r.error.detail.includes(workspaceDir),
      'detail names the colliding root',
    );
  });

  it('refuses a storage root that sits inside a workspace root', () => {
    const nested = path.join(workspaceDir, 'nested-storage');
    const r = loadConfig(env({ STORAGE_ROOT: nested }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'STORAGE_ROOT');
  });

  it('refuses a storage root that contains a workspace root', async () => {
    const parent = path.join(root, 'container');
    const nestedWorkspace = path.join(parent, 'workspace-inside-storage');
    mkdirSync(nestedWorkspace, { recursive: true });
    const r = loadConfig(env({ STORAGE_ROOT: parent, WORKSPACE_ROOTS: nestedWorkspace }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'STORAGE_ROOT');
  });

  it('refuses a ".." traversal that resolves to a workspace root', () => {
    const viaTraversal = path.join(workspaceDir, '..', 'workspace');
    const r = loadConfig(env({ STORAGE_ROOT: viaTraversal }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'STORAGE_ROOT');
  });

  it('refuses a symlink whose target sits inside a workspace root', async () => {
    const targetDir = path.join(workspaceDir, 'symlink-target');
    mkdirSync(targetDir, { recursive: true });
    const linkPath = path.join(root, 'storage-via-symlink');
    try {
      await symlink(targetDir, linkPath, 'junction');
    } catch {
      await symlink(targetDir, linkPath, 'dir');
    }
    const r = loadConfig(env({ STORAGE_ROOT: linkPath }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
    assert.equal(r.ok === false && r.error.code === 'invalid_field' && r.error.field, 'STORAGE_ROOT');
  });

  it('refuses a Windows case variation of a workspace root', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only: case-insensitive path resolution');
      return;
    }
    const r = loadConfig(env({ STORAGE_ROOT: workspaceDir.toUpperCase() }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
  });

  it('refuses a Windows 8.3 short name of a workspace root', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only: 8.3 short-name aliasing');
      return;
    }
    const shortName = await shortNameFor(root, path.basename(workspaceDir));
    if (shortName === null) {
      t.skip('could not determine an 8.3 short name on this host (8.3 creation may be disabled)');
      return;
    }
    const r = loadConfig(env({ STORAGE_ROOT: path.join(root, shortName) }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
  });

  it('mints no new ConfigError variant: every refusal above is invalid_field', () => {
    const r = loadConfig(env({ STORAGE_ROOT: workspaceDir }));
    assert.equal(r.ok === false && r.error.code, 'invalid_field');
  });

  it('leaves a non-overlapping configuration untouched: a sibling storage root starts normally', () => {
    const r = loadConfig(env());
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.storageRoot, realpathSync.native(storageDir));
  });

  it('is the jail\'s one containment predicate, with exactly two callers and no others', async () => {
    const srcRoot = path.join(process.cwd(), 'src');
    const entries = await readdir(srcRoot, { recursive: true });
    const callers = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const filePath = path.join(srcRoot, entry);
      const contents = await readFile(filePath, 'utf8');
      // Exclude the definition itself (`jail/index.ts`'s `export function pathsOverlap`)
      // and the type-only import lines every caller also carries.
      const calls = (contents.match(/(?<!function )pathsOverlap\(/g) ?? []).length;
      if (calls > 0) callers.set(entry, calls);
    }
    const normalised = new Map([...callers.entries()].map(([k, v]) => [k.replace(/\\/g, '/'), v]));
    assert.deepEqual(
      normalised,
      new Map([
        ['config/index.ts', 1],
        ['session-manager/index.ts', 1],
      ]),
      'pathsOverlap has exactly these two callers, each calling it once',
    );
  });

  it('creates the storage root on first boot, same as before this change', async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), 'skynet-config-fresh-'));
    const freshStorage = path.join(fresh, 'does-not-exist-yet');
    const freshWorkspace = path.join(fresh, 'workspace');
    await mkdir(freshWorkspace);
    const r = loadConfig(env({ STORAGE_ROOT: freshStorage, WORKSPACE_ROOTS: freshWorkspace }));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.storageRoot, realpathSync.native(freshStorage));
  });
});
