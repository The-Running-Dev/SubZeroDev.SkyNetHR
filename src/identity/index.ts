import { timingSafeEqual } from 'node:crypto';
import type {
  AuthConfig,
  IdentityError,
  IdentityRequest,
  IdentityResolver,
  OperatorId,
  Result,
} from '../contract/index.js';

// A shared secret authenticates the deployment, not a person: every holder of it is the
// same operator. Nothing here mints a per-browser identity, because an operator record is
// exactly what D3 refuses to add. Ownership under this mode is therefore deployment-wide,
// which is the honest reading of "a shared secret in a cookie, for a bare LAN box".
const SHARED_OPERATOR = 'shared' as OperatorId;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fail(error: IdentityError): Result<never, IdentityError> {
  return { ok: false, error };
}

/** Case-insensitive header lookup. A repeated header takes its last value. */
function header(req: IdentityRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[value.length - 1] : (value as string);
  }
  return undefined;
}

function cookie(req: IdentityRequest, name: string): string | undefined {
  const raw = header(req, 'cookie');
  if (raw === undefined) return undefined;
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * An empty `trustProxy` means loopback only. `config` refuses a routable bind in the
 * header-trust modes unless the allow-list names an upstream (`ConfigError.insecure_bind`),
 * so an empty list can only be reached on a loopback bind — where the proxy is on this
 * host. Any other reading would make the default configuration authenticate nobody.
 */
function peerIsTrusted(remoteAddress: string, trustProxy: readonly string[]): boolean {
  if (trustProxy.length === 0) return LOOPBACK.has(remoteAddress);
  return trustProxy.includes(remoteAddress);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would leak the length by
  // exception rather than by timing. Compare lengths separately and still run the
  // comparison, so the fast path is not observably shorter.
  const same = left.length === right.length;
  const padded = same ? right : left;
  return timingSafeEqual(left, padded) && same;
}

export function resolverFor(auth: AuthConfig, trustProxy: readonly string[]): IdentityResolver {
  switch (auth.mode) {
    case 'proxy-header':
    case 'open-webui': {
      const userHeader = auth.userHeader;
      return (req) => {
        // The peer is checked before the header. A header from an untrusted peer is not
        // "missing identity", it is an attempt to set one, and the two must not collapse
        // into the same answer — the caller logs this case and does not log the other.
        if (!peerIsTrusted(req.remoteAddress, trustProxy)) {
          return fail({ code: 'untrusted_proxy', remoteAddress: req.remoteAddress });
        }
        const value = header(req, userHeader);
        if (value === undefined || value.trim() === '') return fail({ code: 'no_identity' });
        return { ok: true, value: value.trim() as OperatorId };
      };
    }

    case 'shared-secret': {
      const { cookieName, secret } = auth;
      return (req) => {
        const presented = cookie(req, cookieName);
        if (presented === undefined || presented === '') return fail({ code: 'no_identity' });
        if (!constantTimeEquals(presented, secret)) return fail({ code: 'bad_secret' });
        return { ok: true, value: SHARED_OPERATOR };
      };
    }
  }
}

export { SHARED_OPERATOR };
