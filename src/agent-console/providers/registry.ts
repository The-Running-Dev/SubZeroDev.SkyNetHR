import type { AdapterError, ProbeContext, ProviderContext, ProviderDefinition, ProviderOptions, ProviderSession, ProviderStatus, Result } from './types.js';

export interface ListedProvider extends Omit<ProviderStatus, 'version'> {
  readonly id: string;
  readonly label: string;
  readonly cliVersion?: string;
}

export function createProviderRegistry() {
  const providers = new Map<string, ProviderDefinition>();
  function register(definition: ProviderDefinition): Result<void, { readonly code: 'duplicate_provider'; readonly id: string }> {
    if (providers.has(definition.id)) return { ok: false, error: { code: 'duplicate_provider', id: definition.id } };
    providers.set(definition.id, definition);
    return { ok: true, value: undefined };
  }
  async function list(context: ProbeContext): Promise<readonly ListedProvider[]> {
    return Promise.all([...providers.values()].map(async (provider) => {
      const { version, ...status } = await provider.probe(context);
      return { id: provider.id, label: provider.label, ...status, ...(version === undefined ? {} : { cliVersion: version }) };
    }));
  }
  return {
    register,
    ids: (): readonly string[] => [...providers.keys()],
    has: (id: string): boolean => providers.has(id),
    list,
    refresh: (context: ProbeContext): Promise<readonly ListedProvider[]> => list({ ...context, refresh: true }),
    create(id: string, context: ProviderContext, options: ProviderOptions): Promise<Result<ProviderSession, AdapterError>> {
      const provider = providers.get(id);
      return provider ? provider.create(context, options)
        : Promise.resolve({ ok: false, error: { code: 'unsupported_vendor', vendor: id } });
    },
  };
}

export type ProviderRegistry = ReturnType<typeof createProviderRegistry>;
