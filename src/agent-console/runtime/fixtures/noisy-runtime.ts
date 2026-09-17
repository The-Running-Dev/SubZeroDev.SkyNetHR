await import('../main.js'); // installs stdout discipline before the noisy module loads
const { runRuntime } = await import('../server.js');
const { createProviderRegistry } = await import('../../providers/registry.js');
import type { Checkpoints } from '../../core/types.js';
import type { ProviderDefinition } from '../../providers/types.js';
console.log('provider module loaded'); console.info('provider info'); console.debug('provider debug');
const provider: ProviderDefinition = {
  id: 'fixture', label: 'Noisy fixture',
  async probe() { console.log('probe noise'); return { available: true, capabilities: { workspace: 'required', permissions: 'interactive',
    attachments: { supported: true }, usage: true, resume: false, streamingDeltas: true, needsProcess: false, conversationState: 'provider' } }; },
  async create(context) {
    console.log('create noise');
    return { ok: true, value: { policy: { mode: 'interactive', sandbox: null, banner: null }, capabilities: (await provider.probe(context)).capabilities,
      startTurn(input, turn) {
        console.log('send noise');
        let finish!: (value: { stopReason: 'interrupted'; usage: null }) => void;
        let ended = false;
        const done = new Promise<{ stopReason: 'interrupted'; usage: null }>(resolve => { finish = resolve; });
        turn.emit('message', { role: 'assistant', text: input.model ?? input.text, attachments: [] });
        if (input.text === 'fail') return { started: Promise.resolve({ ok: false as const, error: { code: 'write_failed' as const, detail: 'fixture' } }), done,
          interrupt: async () => {}, respondToPermission: () => ({ ok: false as const, error: { code: 'no_child' as const } }) };
        return { started: Promise.resolve({ ok: true as const, value: undefined }), done,
          interrupt: async () => { if (ended) return; ended = true; turn.emit('turn.ended', { stopReason: 'interrupted', usage: null }); finish({ stopReason: 'interrupted', usage: null }); },
          respondToPermission: () => ({ ok: false as const, error: { code: 'no_child' as const } }) };
      }, close: async () => {} } };
  },
};
const registry = createProviderRegistry(); registry.register(provider);
const checkpoints: Checkpoints = { init: async () => ({ ok: true, value: undefined }), destroy: async () => ({ ok: true, value: undefined }),
  commit: async () => ({ ok: false, error: { code: 'commit_failed', detail: 'fixture' } }), list: async () => ({ ok: true, value: [] }),
  restore: async () => ({ ok: false, error: { code: 'no_such_checkpoint', sha: 'a'.repeat(40) as never } }) };
runRuntime(process.stdin, process.stdout, { registry, checkpoints, onExit: () => process.exit(0) });
