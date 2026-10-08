import { prepareCodex, probeCodex } from './index.js';
import { wrapAdapter } from '../adapter-session.js';
import type { ProviderDefinition } from '../types.js';

// `probeTimeoutMs` is for tests only; production leaves it unset (see `probeOk`, #524).
export function defineCodexProvider(executableOverride?: string, settings: { readonly probeTimeoutMs?: number } = {}) {
  const executable = (): string => executableOverride ?? process.env['SKYNET_CODEX_EXECUTABLE'] ?? 'codex';
  return {
    id: 'codex' as const, label: 'Codex CLI',
    probe: (context) => probeCodex(executable(), context, settings.probeTimeoutMs),
    async create(context, options) {
      if (options.sandbox === null || !['read-only', 'workspace-write', 'unrestricted'].includes(options.sandbox)) {
        return { ok: false, error: { code: 'unsupported_sandbox', sandbox: String(options.sandbox) } };
      }
      const prepared = await prepareCodex(executable(), context, settings.probeTimeoutMs);
      return wrapAdapter(prepared.create, context, options, prepared.status.capabilities);
    },
  } satisfies ProviderDefinition;
}
export const codexProvider = defineCodexProvider();
