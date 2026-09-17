import { createProviderRegistry } from '../registry.js';
import { claudeProvider } from '../claude-cli/provider.js';
import { codexProvider } from '../codex-cli/provider.js';

// Composition only. Selection and capability decisions stay in the registry.
export function createBuiltinRegistry() {
  const registry = createProviderRegistry();
  registry.register(claudeProvider); registry.register(codexProvider);
  return registry;
}
