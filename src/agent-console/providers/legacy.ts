import type { Adapter, AdapterError, AdapterOptions, AdapterEvent, Result, TurnHandle } from './types.js';
import type { ProviderRegistry } from './registry.js';

// SkyNetHR keeps its audit and notification sink during the staged extraction.
export async function createRegisteredAdapter(registry: ProviderRegistry, id: string, options: AdapterOptions): Promise<Result<Adapter, AdapterError>> {
  const event = (kind: string, data: unknown, raw?: unknown): void => {
    options.notify({ kind: 'event', event: { kind, data, raw } as AdapterEvent });
  };
  const created = await registry.create(id, { cwd: options.cwd, notify: options.notify, emit: event }, {
    sandbox: options.sandbox, streamDeltas: options.streamDeltas,
    ...(options.stdoutLineBytes === undefined ? {} : { stdoutLineBytes: options.stdoutLineBytes }),
    ...(options.model === null ? {} : { model: options.model }),
  });
  if (!created.ok) return created;
  const session = created.value;
  let handle: TurnHandle | undefined;
  return { ok: true, value: {
    vendor: id, policy: session.policy, acceptsAttachments: session.capabilities.attachments.supported,
    send(text, attachments, resume, turnId, model) {
      handle = session.startTurn({ text, attachments, resume, ...(model === undefined ? {} : { model }) }, { turnId, emit: event, frame: event });
      return handle.started;
    },
    respond(requestId, decision) {
      if (!handle) return { ok: false, error: { code: 'no_child' } };
      const result = handle.respondToPermission(requestId, decision);
      if (!result.ok) return result;
      if (result.value.reason === 'cancelled_process_exit') return { ok: false, error: result.value.cause };
      return { ok: true, value: undefined };
    },
    kill() { return handle ? handle.interrupt() : Promise.resolve(); },
  } };
}
