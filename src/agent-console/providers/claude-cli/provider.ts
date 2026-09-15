import { createClaudeAdapter } from './index.js';
import { probeCommand } from '../probe.js';
import { wrapAdapter } from '../adapter-session.js';
import type { ProbeContext, ProviderDefinition, ProviderStatus } from '../types.js';

const cache = new Map<string, Promise<ProviderStatus>>();
export function defineClaudeProvider(executableOverride?: string) {
  const executable = (): string => executableOverride ?? process.env['SKYNET_CLAUDE_EXECUTABLE'] ?? 'claude';
  async function probe(context: ProbeContext): Promise<ProviderStatus> {
    const image = executable();
    const key = JSON.stringify([image, context.cwd]);
    if (context.refresh) cache.delete(key);
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        const script = /\.(mjs|js)$/.test(image);
        const shell = process.platform === 'win32' && !script && (image === 'claude' || /\.(cmd|bat)$/i.test(image));
        const command = script ? process.execPath : shell && /\s/.test(image) ? `"${image}"` : image;
        const found = await probeCommand(command, script ? [image, '--version'] : ['--version'], context.cwd, shell);
        return {
          available: found.ok,
          ...(found.ok ? (found.output ? { version: found.output } : {}) : { unavailableReason: 'agent_unavailable' }),
          capabilities: {
            workspace: 'required', permissions: 'interactive', attachments: { supported: true },
            usage: true, resume: true, streamingDeltas: true, models: 'free-form', sandboxModes: [],
            needsProcess: true, conversationState: 'provider',
          },
        };
      })();
      cache.set(key, result);
    }
    return result;
  }
  return {
    id: 'claude' as const, label: 'Claude CLI', probe,
    async create(context, options) {
      if (options.sandbox !== null) return { ok: false, error: { code: 'unsupported_sandbox', sandbox: options.sandbox } };
      const status = await probe(context);
      // Existing behavior: absence is reported by send, after the paired turn.started.
      return wrapAdapter((opts) => createClaudeAdapter({ ...opts, executable: executable() }), context, options, status.capabilities);
    },
  } satisfies ProviderDefinition;
}
export const claudeProvider = defineClaudeProvider();
