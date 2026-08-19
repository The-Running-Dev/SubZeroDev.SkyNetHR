import { realpathSync } from 'node:fs';
import { stripExtendedPrefix } from '../jail/index.js';
import type {
  AuthConfig,
  Caps,
  ChecklistItemId,
  ChecklistItemTemplate,
  Config,
  ConfigError,
  ResolvedPath,
  Result,
  TokenRates,
} from '../contract/index.js';

// Env var names are this module's own choice; the contract fixes only the shape of
// `Config`, not how it is loaded.

function missing(field: string): Result<never, ConfigError> {
  return { ok: false, error: { code: 'missing_field', field } };
}

function invalid(field: string, detail: string): Result<never, ConfigError> {
  return { ok: false, error: { code: 'invalid_field', field, detail } };
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): Result<string, ConfigError> {
  const value = env[name];
  if (value === undefined || value === '') return missing(name);
  return { ok: true, value };
}

function parseIntEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): Result<number, ConfigError> {
  const raw = env[name];
  if (raw === undefined || raw === '') return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return invalid(name, `expected a non-negative integer, got '${raw}'`);
  return { ok: true, value: n };
}

function parseList(env: Readonly<Record<string, string | undefined>>, name: string): readonly string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseAuth(env: Readonly<Record<string, string | undefined>>): Result<AuthConfig, ConfigError> {
  const mode = requireEnv(env, 'AUTH_MODE');
  if (!mode.ok) return mode;
  switch (mode.value) {
    case 'proxy-header': {
      const userHeader = requireEnv(env, 'AUTH_USER_HEADER');
      if (!userHeader.ok) return userHeader;
      return { ok: true, value: { mode: 'proxy-header', userHeader: userHeader.value } };
    }
    case 'open-webui': {
      const userHeader = requireEnv(env, 'AUTH_USER_HEADER');
      if (!userHeader.ok) return userHeader;
      const sessionHeader = requireEnv(env, 'AUTH_SESSION_HEADER');
      if (!sessionHeader.ok) return sessionHeader;
      return {
        ok: true,
        value: { mode: 'open-webui', userHeader: userHeader.value, sessionHeader: sessionHeader.value },
      };
    }
    case 'shared-secret': {
      const cookieName = requireEnv(env, 'AUTH_COOKIE_NAME');
      if (!cookieName.ok) return cookieName;
      const secret = requireEnv(env, 'AUTH_SECRET');
      if (!secret.ok) return secret;
      return { ok: true, value: { mode: 'shared-secret', cookieName: cookieName.value, secret: secret.value } };
    }
    default:
      return invalid('AUTH_MODE', `unknown auth mode '${mode.value}'`);
  }
}

function parseWorkspaceRoots(env: Readonly<Record<string, string | undefined>>): Result<readonly ResolvedPath[], ConfigError> {
  const rootsField = requireEnv(env, 'WORKSPACE_ROOTS');
  if (!rootsField.ok) return rootsField;
  const candidates = rootsField.value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (candidates.length === 0) return invalid('WORKSPACE_ROOTS', 'must name at least one root');
  const resolved: ResolvedPath[] = [];
  for (const candidate of candidates) {
    try {
      // `.native` for the same reason the jail uses it (see src/jail/index.ts): the JS
      // realpath does not resolve Windows 8.3 short names, and a root canonicalised
      // differently from the candidates checked against it rejects legitimate cwds.
      resolved.push(stripExtendedPrefix(realpathSync.native(candidate)) as ResolvedPath);
    } catch (err) {
      return invalid('WORKSPACE_ROOTS', `cannot resolve '${candidate}': ${(err as Error).message}`);
    }
  }
  return { ok: true, value: resolved };
}

function parseChecklist(env: Readonly<Record<string, string | undefined>>): Result<readonly ChecklistItemTemplate[], ConfigError> {
  const raw = env['CHECKLIST_JSON'];
  if (raw === undefined || raw.trim() === '') return { ok: true, value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return invalid('CHECKLIST_JSON', `not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) return invalid('CHECKLIST_JSON', 'must be an array');
  const items: ChecklistItemTemplate[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { id?: unknown }).id !== 'string' ||
      typeof (entry as { label?: unknown }).label !== 'string'
    ) {
      return invalid('CHECKLIST_JSON', 'each item needs a string id and a string label');
    }
    const e = entry as { id: string; label: string };
    if (items.some((item) => item.id === e.id)) return invalid('CHECKLIST_JSON', `duplicate item id '${e.id}'`);
    items.push({ id: e.id as ChecklistItemId, label: e.label });
  }
  return { ok: true, value: items };
}

// (tier two, D158) `Config.tokenRates`: flat, per-deployment rates for the cost tile. Absent
// means the tile is disabled — `PayrollView.costCurrency` reads `null` rather than `0.00`.
function parseTokenRates(env: Readonly<Record<string, string | undefined>>): Result<TokenRates | null, ConfigError> {
  const raw = env['TOKEN_RATES_JSON'];
  if (raw === undefined || raw.trim() === '') return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return invalid('TOKEN_RATES_JSON', `not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid('TOKEN_RATES_JSON', 'must be an object');
  const fields = ['inputTokens', 'outputTokens', 'cacheRead', 'cacheCreate'] as const;
  const rates: { -readonly [K in (typeof fields)[number]]?: number } = {};
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return invalid('TOKEN_RATES_JSON', `field '${field}' must be a non-negative number`);
    }
    rates[field] = value;
  }
  return { ok: true, value: rates as TokenRates };
}

// Loopback is where a header-trust mode is safe with no allow-list: nothing off-box can
// reach the port to set the header in the first place. Everything else, `0.0.0.0`
// included, is routable. The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1 — a
// host running several bound services commonly gives each its own loopback alias.
const LOOPBACK_HOSTS = new Set(['::1', 'localhost']);
const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function bindIsRoutable(host: string): boolean {
  const lower = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return false;
  const v4 = LOOPBACK_V4.exec(lower);
  if (v4 === null) return true;
  return !v4.slice(1).every((octet) => Number(octet) <= 255);
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Result<Config, ConfigError> {
  const host = env['BIND_HOST'] ?? '127.0.0.1';

  const portResult = parseIntEnv(env, 'BIND_PORT', 3000);
  if (!portResult.ok) return portResult;

  const auth = parseAuth(env);
  if (!auth.ok) return auth;

  const roots = parseWorkspaceRoots(env);
  if (!roots.ok) return roots;

  const storageRoot = requireEnv(env, 'STORAGE_ROOT');
  if (!storageRoot.ok) return storageRoot;

  const allowedOrigins = parseList(env, 'ALLOWED_ORIGINS');
  const trustProxy = parseList(env, 'TRUST_PROXY');

  // D99: the shipped default is 2000, and it is not an arbitrary round number — D40's
  // argument for reading replay from the spill, and S3.3's test shape, are both calibrated
  // on it. A deployment may still override it; what it may not be is a figure the design
  // reasoned against and no deployment ever gets.
  const ringCapacity = parseIntEnv(env, 'CAPS_RING_CAPACITY', 2000);
  if (!ringCapacity.ok) return ringCapacity;
  const toolResultBytes = parseIntEnv(env, 'CAPS_TOOL_RESULT_BYTES', 64 * 1024);
  if (!toolResultBytes.ok) return toolResultBytes;
  const subscriberQueueHighWater = parseIntEnv(env, 'CAPS_SUBSCRIBER_QUEUE_HIGH_WATER', 1000);
  if (!subscriberQueueHighWater.ok) return subscriberQueueHighWater;
  const keepaliveMs = parseIntEnv(env, 'CAPS_KEEPALIVE_MS', 15000);
  if (!keepaliveMs.ok) return keepaliveMs;
  const auditPageMax = parseIntEnv(env, 'CAPS_AUDIT_PAGE_MAX', 200);
  if (!auditPageMax.ok) return auditPageMax;
  const reviewBodyBytes = parseIntEnv(env, 'CAPS_REVIEW_BODY_BYTES', 16 * 1024);
  if (!reviewBodyBytes.ok) return reviewBodyBytes;
  const requisitionTextBytes = parseIntEnv(env, 'CAPS_REQUISITION_TEXT_BYTES', 4 * 1024);
  if (!requisitionTextBytes.ok) return requisitionTextBytes;
  // A standing rule is one line, `"<tool>:<pattern>"` — an order of magnitude below the
  // other text caps is deliberately generous for the grammar it actually holds.
  const standingRuleBytes = parseIntEnv(env, 'CAPS_STANDING_RULE_BYTES', 1024);
  if (!standingRuleBytes.ok) return standingRuleBytes;

  const caps: Caps = {
    ringCapacity: ringCapacity.value,
    toolResultBytes: toolResultBytes.value,
    subscriberQueueHighWater: subscriberQueueHighWater.value,
    keepaliveMs: keepaliveMs.value,
    auditPageMax: auditPageMax.value,
    reviewBodyBytes: reviewBodyBytes.value,
    requisitionTextBytes: requisitionTextBytes.value,
    standingRuleBytes: standingRuleBytes.value,
  };

  const includeRaw = env['INCLUDE_RAW'] === 'true';

  // The `Max-Age` on the cookie `POST /api/login` mints. Read only under `shared-secret`;
  // the header modes' credential belongs to the upstream proxy and its lifetime is not
  // ours to set. Thirty days is the default rather than a constant, because shortening a
  // session lifetime is what a deployment does after an incident and it must not need a
  // release (D103's argument for the caps, applied to the one value that is a credential).
  const sessionCookieMaxAgeSeconds = parseIntEnv(env, 'SESSION_COOKIE_MAX_AGE_SECONDS', 30 * 24 * 60 * 60);
  if (!sessionCookieMaxAgeSeconds.ok) return sessionCookieMaxAgeSeconds;

  let sessionTokenBudget: number | null = null;
  const budgetRaw = env['SESSION_TOKEN_BUDGET'];
  if (budgetRaw !== undefined && budgetRaw !== '') {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return invalid('SESSION_TOKEN_BUDGET', `expected a non-negative integer, got '${budgetRaw}'`);
    sessionTokenBudget = n;
  }

  const checklist = parseChecklist(env);
  if (!checklist.ok) return checklist;

  const tokenRates = parseTokenRates(env);
  if (!tokenRates.ok) return tokenRates;
  const currencyRaw = env['CURRENCY'];
  const currency = currencyRaw === undefined || currencyRaw.trim() === '' ? null : currencyRaw.trim();

  // D10/D117: standalone deployments stream over SSE; a deployment sitting behind a proxy
  // that buffers or does not pass through `text/event-stream` sets `EDGE=ws` instead.
  const edgeEnv = env['EDGE'];
  const edgeRaw = edgeEnv === undefined || edgeEnv === '' ? 'sse' : edgeEnv;
  if (edgeRaw !== 'sse' && edgeRaw !== 'ws') {
    return invalid('EDGE', `must be 'sse' or 'ws', got '${edgeRaw}'`);
  }
  const edge = edgeRaw;

  // Fail closed on startup. A missing auth mode never reaches here: D93 makes one
  // mandatory and `parseAuth` above already refused with `missing_field`. What is left is
  // the bind, and it only bites the modes that trust a header the client could otherwise
  // set — a shared secret is a credential, not a claim about who the peer is, so a
  // routable bind is legitimate there.
  const trustsAHeader = auth.value.mode === 'proxy-header' || auth.value.mode === 'open-webui';
  if (trustsAHeader && bindIsRoutable(host) && trustProxy.length === 0) {
    return { ok: false, error: { code: 'insecure_bind', bind: `${host}:${portResult.value}` } };
  }

  return {
    ok: true,
    value: {
      bind: { host, port: portResult.value },
      auth: auth.value,
      workspaceRoots: roots.value,
      storageRoot: storageRoot.value,
      allowedOrigins,
      trustProxy,
      caps,
      sessionCookieMaxAgeSeconds: sessionCookieMaxAgeSeconds.value,
      includeRaw,
      sessionTokenBudget,
      tokenRates: tokenRates.value,
      currency,
      checklist: checklist.value,
      edge,
    },
  };
}
