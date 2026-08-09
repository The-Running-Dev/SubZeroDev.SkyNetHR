import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { loadConfig } from './index.js';

// A real directory, because WORKSPACE_ROOTS is canonicalised at load.
const root = tmpdir();

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_MODE: 'proxy-header',
    AUTH_USER_HEADER: 'x-forwarded-user',
    WORKSPACE_ROOTS: root,
    STORAGE_ROOT: root,
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
