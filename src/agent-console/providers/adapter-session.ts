import type { Adapter, AdapterError, AdapterNotification, AdapterOptions, ProviderCapabilities, ProviderContext, ProviderOptions, ProviderSession, Result, TurnContext, TurnHandle, TurnOutcome } from './types.js';

// Migration seam: vendor mappings keep their tested notification/child lifecycle;
// the provider boundary exposes turn handles without moving session-manager policy.
export async function wrapAdapter(
  factory: (options: AdapterOptions) => Adapter | Result<Adapter, AdapterError> | Promise<Result<Adapter, AdapterError>>,
  context: ProviderContext,
  options: ProviderOptions,
  capabilities: ProviderCapabilities,
): Promise<Result<ProviderSession, AdapterError>> {
  if (options.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/.test(options.model)) {
    return { ok: false, error: { code: 'invalid_model', model: options.model } };
  }
  let active: { context: TurnContext; finish: (outcome: TurnOutcome) => void; ended: boolean } | undefined;
  let closed = false;
  function notify(notification: AdapterNotification): void {
    if (notification.kind !== 'event') { context.notify(notification); return; }
    const event = notification.event;
    if (event.kind === 'session.notice' || event.kind === 'error') {
      if (active) active.context.emit(event.kind, event.data, event.raw);
      else context.emit(event.kind, event.data, event.raw);
    } else if (active) {
      if (event.kind === 'message.delta') active.context.frame(event.kind, event.data, event.raw);
      else active.context.emit(event.kind, event.data, event.raw);
    }
    // Forward synchronously first: the manager issues the process-tree kill in emit.
    if (active && event.kind === 'turn.ended') {
      active.ended = true;
      active.finish(event.data);
    }
  }
  const made = await factory({ cwd: context.cwd, model: options.model ?? null, sandbox: options.sandbox, streamDeltas: options.streamDeltas, notify,
    ...(options.stdoutLineBytes === undefined ? {} : { stdoutLineBytes: options.stdoutLineBytes }) });
  const result = 'ok' in made ? made : { ok: true as const, value: made };
  if (!result.ok) return result;
  const adapter = result.value;
  return { ok: true, value: {
    policy: adapter.policy,
    capabilities,
    startTurn(input, turnContext): TurnHandle {
      let finish!: (outcome: TurnOutcome) => void;
      const done = new Promise<TurnOutcome>((resolve) => { finish = resolve; });
      const state = { context: turnContext, finish, ended: false };
      let failedStart = false;
      const invalidModel = input.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/.test(input.model);
      if (closed || (active && !active.ended) || invalidModel) {
        finish({ stopReason: 'error', usage: null });
        return {
          started: Promise.resolve({ ok: false, error: closed ? { code: 'session_closed' }
            : invalidModel ? { code: 'invalid_model', model: input.model! } : { code: 'turn_in_flight' } }), done,
          respondToPermission: () => ({ ok: false, error: { code: 'no_child' } }),
          interrupt: async () => {},
        };
      }
      active = state;
      const started = adapter.send(input.text, input.attachments, input.resume, turnContext.turnId, input.model);
      void started.then((sent) => {
        if (!sent.ok && !state.ended) { failedStart = true; state.ended = true; finish({ stopReason: 'error', usage: null }); }
      });
      return {
        started, done,
        respondToPermission(requestId, decision) {
          if (active !== state || state.ended) return { ok: false, error: { code: 'no_child' } };
          const response = adapter.respond(requestId, decision);
          if (response.ok) return { ok: true, value: { decision, reason: 'answered' } };
          if (response.error.code === 'no_child' || response.error.code === 'write_failed') {
            return { ok: true, value: { decision: 'deny', reason: 'cancelled_process_exit', cause: response.error } };
          }
          return response;
        },
        interrupt() {
          // A handle from an older turn must never reach this session's current child.
          if (active === state && (!state.ended || failedStart)) return adapter.kill();
          return Promise.resolve();
        },
      };
    },
    close() { closed = true; return adapter.kill(); },
  } };
}
