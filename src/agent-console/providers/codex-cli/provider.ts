import { createCodexAdapter, probeCodex } from './index.js';
import { wrapAdapter } from '../adapter-session.js';
import type { ProviderDefinition } from '../types.js';

export function defineCodexProvider(executableOverride?: string) {
  const executable = (): string => executableOverride ?? process.env['SKYNET_CODEX_EXECUTABLE'] ?? 'codex';
  return {
    id: 'codex' as const, label: 'Codex CLI',
    probe: (context) => probeCodex(executable(), context),
    async create(context, options) {
      if (options.sandbox === null || !['read-only', 'workspace-write', 'unrestricted'].includes(options.sandbox)) {
        return { ok: false, error: { code: 'unsupported_sandbox', sandbox: String(options.sandbox) } };
      }
      const status = await probeCodex(executable(), context);
      return wrapAdapter((opts) => createCodexAdapter({ ...opts, executable: executable() }), context, options, status.capabilities);
    },
  } satisfies ProviderDefinition;
}
export const codexProvider = defineCodexProvider();
