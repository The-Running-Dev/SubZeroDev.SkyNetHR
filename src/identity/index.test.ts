import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolverFor } from './index.js';
import type { AuthConfig } from '../contract/index.js';

const proxyAuth: AuthConfig = { mode: 'proxy-header', userHeader: 'x-forwarded-user' };
const secretAuth: AuthConfig = { mode: 'shared-secret', cookieName: 'skynet', secret: 'correct horse battery staple' };

describe('identity — proxy-header mode (S2.4)', () => {
  it('resolves an OperatorId from the configured header when the peer is trusted', () => {
    const resolve = resolverFor(proxyAuth, ['10.0.0.1']);
    const r = resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '10.0.0.1' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value, 'ben');
  });

  it('is case-insensitive about the header name', () => {
    const resolve = resolverFor({ mode: 'proxy-header', userHeader: 'X-Forwarded-User' }, ['10.0.0.1']);
    const r = resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '10.0.0.1' });
    assert.equal(r.ok && r.value, 'ben');
  });

  it('rejects the header from a peer outside trustProxy, naming the address', () => {
    const resolve = resolverFor(proxyAuth, ['10.0.0.1']);
    const r = resolve({ headers: { 'x-forwarded-user': 'mallory' }, remoteAddress: '203.0.113.9' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok === false && r.error, { code: 'untrusted_proxy', remoteAddress: '203.0.113.9' });
  });

  it('trusts loopback peers when trustProxy is empty', () => {
    const resolve = resolverFor(proxyAuth, []);
    assert.equal(resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '127.0.0.1' }).ok, true);
    assert.equal(resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '::1' }).ok, true);
    assert.equal(resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '10.0.0.1' }).ok, false);
  });

  it('is no_identity when the header is absent or empty', () => {
    const resolve = resolverFor(proxyAuth, ['10.0.0.1']);
    assert.deepEqual(
      resolve({ headers: {}, remoteAddress: '10.0.0.1' }),
      { ok: false, error: { code: 'no_identity' } },
    );
    assert.deepEqual(
      resolve({ headers: { 'x-forwarded-user': '  ' }, remoteAddress: '10.0.0.1' }),
      { ok: false, error: { code: 'no_identity' } },
    );
  });

  it('checks the peer before the header, so a forged header from an untrusted peer never resolves', () => {
    const resolve = resolverFor(proxyAuth, ['10.0.0.1']);
    const r = resolve({ headers: {}, remoteAddress: '203.0.113.9' });
    assert.equal(r.ok === false && r.error.code, 'untrusted_proxy');
  });

  it('takes the last value when a header arrives more than once', () => {
    const resolve = resolverFor(proxyAuth, ['10.0.0.1']);
    const r = resolve({ headers: { 'x-forwarded-user': ['first', 'second'] }, remoteAddress: '10.0.0.1' });
    assert.equal(r.ok && r.value, 'second');
  });

  it('matches trustProxy against an IPv4-mapped IPv6 peer on a dual-stack bind', () => {
    const resolve = resolverFor(proxyAuth, ['192.168.1.10']);
    const r = resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '::ffff:192.168.1.10' });
    assert.equal(r.ok, true);
  });

  it('matches an IPv4-mapped entry in trustProxy against a plain IPv4 peer', () => {
    const resolve = resolverFor(proxyAuth, ['::ffff:192.168.1.10']);
    const r = resolve({ headers: { 'x-forwarded-user': 'ben' }, remoteAddress: '192.168.1.10' });
    assert.equal(r.ok, true);
  });
});

describe('identity — shared-secret mode (S2.5)', () => {
  it('authenticates from its cookie', () => {
    const resolve = resolverFor(secretAuth, []);
    const r = resolve({
      headers: { cookie: 'other=1; skynet=correct horse battery staple' },
      remoteAddress: '203.0.113.9',
    });
    assert.equal(r.ok, true);
  });

  it('rejects a wrong secret with bad_secret', () => {
    const resolve = resolverFor(secretAuth, []);
    const r = resolve({ headers: { cookie: 'skynet=wrong' }, remoteAddress: '127.0.0.1' });
    assert.deepEqual(r, { ok: false, error: { code: 'bad_secret' } });
  });

  it('is no_identity with no cookie at all', () => {
    const resolve = resolverFor(secretAuth, []);
    assert.deepEqual(
      resolve({ headers: {}, remoteAddress: '127.0.0.1' }),
      { ok: false, error: { code: 'no_identity' } },
    );
  });

  it('does not consult trustProxy — the secret is the credential, not the peer', () => {
    const resolve = resolverFor(secretAuth, ['10.0.0.1']);
    assert.equal(resolve({ headers: { cookie: 'skynet=correct horse battery staple' }, remoteAddress: '198.51.100.4' }).ok, true);
  });

  it('decodes a cookie value the edge wrote through encodeURIComponent', () => {
    // `edge/sse/index.ts` sets the cookie as `encodeURIComponent(secret)`; a secret with
    // spaces or `+`/`/` is only readable back if this side decodes it the same way.
    const resolve = resolverFor(secretAuth, []);
    const encoded = encodeURIComponent(secretAuth.mode === 'shared-secret' ? secretAuth.secret : '');
    const r = resolve({ headers: { cookie: `skynet=${encoded}` }, remoteAddress: '127.0.0.1' });
    assert.equal(r.ok, true);
  });
});

describe('identity — open-webui mode', () => {
  it('resolves from the user header under the same peer trust rule', () => {
    const auth: AuthConfig = { mode: 'open-webui', userHeader: 'x-user-id', sessionHeader: 'x-session-id' };
    const resolve = resolverFor(auth, ['10.0.0.1']);
    assert.equal(resolve({ headers: { 'x-user-id': 'u-7' }, remoteAddress: '10.0.0.1' }).ok, true);
    assert.equal(resolve({ headers: { 'x-user-id': 'u-7' }, remoteAddress: '203.0.113.9' }).ok, false);
  });
});
