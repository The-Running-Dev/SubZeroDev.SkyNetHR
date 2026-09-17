import { claudeProvider } from '../agent-console/providers/claude-cli/provider.js';
import { codexProvider } from '../agent-console/providers/codex-cli/provider.js';
import { createProviderRegistry } from '../agent-console/providers/registry.js';
import { createRegisteredAdapter } from '../agent-console/providers/legacy.js';
import type { AdapterOptions } from '../agent-console/providers/types.js';

// Host composition is the only list of shipped providers. Types and edge validation derive from it.
export const providerDefinitions = [claudeProvider, codexProvider] as const;
export const providerRegistry = createProviderRegistry();
for (const definition of providerDefinitions) providerRegistry.register(definition);
export const VENDORS = providerRegistry.ids();
export const createConfiguredAdapter = (id: string, options: AdapterOptions) => createRegisteredAdapter(providerRegistry, id, options);
