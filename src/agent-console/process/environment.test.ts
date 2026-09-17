import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvironment } from './environment.js';

test('Phase 3 environment — default inheritance equals the existing spread, including unset entries', () => {
  const source = { Path: 'bin', PRIVATE_HOST_VALUE: 'preserved', UNSET: undefined, FORCE_COLOR: 'yes' };
  const overrides = { FORCE_COLOR: '0', NO_COLOR: '1' };
  assert.deepEqual(buildEnvironment({ source, overrides }), { ...source, ...overrides });
  assert.deepEqual(buildEnvironment({ overrides }), { ...process.env, ...overrides });
  assert.equal(source.FORCE_COLOR, 'yes');
});

test('Phase 3 environment — constructed mode retains essentials, proxy/TLS and declared inputs only', () => {
  const names = ['Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'USERNAME', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PROVIDER_CONFIG'];
  const retained = Object.fromEntries(names.map(name => [name, `value:${name}`]));
  const source = { ...retained, UNRELATED_SECRET: 'omit', FORCE_COLOR: 'yes', NO_COLOR: 'no' };
  const host = { HOST_EXPLICIT: 'supplied', PROVIDER_CONFIG: 'host value', FORCE_COLOR: 'host value' };
  const overrides = { FORCE_COLOR: '0', NO_COLOR: '1' };
  assert.deepEqual(buildEnvironment({ mode: 'constructed', source, providerNames: ['PROVIDER_CONFIG'], host, overrides }),
    { ...retained, ...host, ...overrides });
  assert.equal(buildEnvironment({ mode: 'constructed', source }).PROVIDER_CONFIG, undefined);
  assert.equal(source.UNRELATED_SECRET, 'omit');
});
