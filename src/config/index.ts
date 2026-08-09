import { realpathSync } from 'node:fs';
import type {
  AuthConfig,
  Caps,
  ChecklistItemId,
  ChecklistItemTemplate,
  Config,
  ConfigError,
  ResolvedPath,
  Result,
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
      resolved.push(realpathSync(candidate) as ResolvedPath);
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
    items.push({ id: e.id as ChecklistItemId, label: e.label });
  }
  return { ok: true, value: items };
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

  const ringCapacity = parseIntEnv(env, 'CAPS_RING_CAPACITY', 500);
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

  const caps: Caps = {
    ringCapacity: ringCapacity.value,
    toolResultBytes: toolResultBytes.value,
    subscriberQueueHighWater: subscriberQueueHighWater.value,
    keepaliveMs: keepaliveMs.value,
    auditPageMax: auditPageMax.value,
    reviewBodyBytes: reviewBodyBytes.value,
    requisitionTextBytes: requisitionTextBytes.value,
  };

  const includeRaw = env['INCLUDE_RAW'] === 'true';

  let sessionTokenBudget: number | null = null;
  const budgetRaw = env['SESSION_TOKEN_BUDGET'];
  if (budgetRaw !== undefined && budgetRaw !== '') {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return invalid('SESSION_TOKEN_BUDGET', `expected a non-negative integer, got '${budgetRaw}'`);
    sessionTokenBudget = n;
  }

  const checklist = parseChecklist(env);
  if (!checklist.ok) return checklist;

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
      includeRaw,
      sessionTokenBudget,
      checklist: checklist.value,
    },
  };
}
