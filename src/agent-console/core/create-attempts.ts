import type { PrincipalId, Result, SessionId } from './types.js';

export type CreateAttemptState = 'new' | 'prepared' | 'committing' | 'committed' | 'aborted';
export interface HostCreateCallbacks {
  prepare(id: SessionId, principal: PrincipalId, data: unknown): Promise<Result<void, unknown>>;
  commit(id: SessionId): Promise<Result<void, unknown>>;
  abort(id: SessionId): Promise<void>;
  status(id: SessionId): Promise<CreateAttemptState>;
  cancel?(id: SessionId): void;
}

// Host callbacks own their effects. This helper gives the in-process host the same
// idempotent attempt semantics that a later transport will carry.
export function createHostAttempts(effects: {
  prepare(id: SessionId, principal: PrincipalId, data: unknown, signal: AbortSignal): Result<void, unknown> | Promise<Result<void, unknown>>;
  commit(id: SessionId): Promise<Result<void, unknown>>;
  abort(id: SessionId): void | Promise<void>;
}): HostCreateCallbacks {
  interface Attempt {
    state: CreateAttemptState;
    controller: AbortController;
    preparation?: Promise<Result<void, unknown>>;
    committing?: Promise<Result<void, unknown>>;
    aborting?: Promise<void>;
  }
  const attempts = new Map<SessionId, Attempt>();
  const get = (id: SessionId) => {
    let a = attempts.get(id);
    if (!a) { a = { state: 'new', controller: new AbortController() }; attempts.set(id, a); }
    return a;
  };
  const aborted = (): Result<void, unknown> => ({ ok: false, error: 'create_aborted' });
  return {
    prepare(id, principal, data) {
      const a = get(id);
      if (a.state === 'aborted') return Promise.resolve(aborted());
      if (a.preparation) return a.preparation;
      // Invoke before Promise.resolve: a synchronous host claim must remain in this tick.
      let prepared: Result<void, unknown> | Promise<Result<void, unknown>>;
      try { prepared = effects.prepare(id, principal, data, a.controller.signal); }
      catch (error) { prepared = { ok: false, error }; }
      a.preparation = Promise.resolve(prepared).catch(error => ({ ok: false as const, error })).then(async result => {
        if (a.state === 'aborted') { await effects.abort(id); return aborted(); }
        if (result.ok) a.state = 'prepared';
        else { a.state = 'aborted'; await effects.abort(id); }
        return result;
      });
      return a.preparation;
    },
    commit(id) {
      const a = get(id);
      if (a.committing) return a.committing;
      if (a.state !== 'prepared') return Promise.resolve(aborted());
      a.state = 'committing';
      a.committing = (async () => {
        let result: Result<void, unknown>;
        try { result = await effects.commit(id); } catch (error) { result = { ok: false, error }; }
        a.state = result.ok ? 'committed' : 'aborted';
        if (!result.ok) await effects.abort(id);
        return result;
      })();
      return a.committing;
    },
    async abort(id) {
      const a = get(id);
      if (a.state === 'committing') await a.committing;
      if (a.state === 'committed') return;
      if (a.aborting) return a.aborting;
      a.state = 'aborted';
      a.controller.abort();
      a.aborting = Promise.resolve(effects.abort(id));
      await a.aborting;
    },
    async status(id) { return get(id).state; },
    cancel(id) { get(id).controller.abort(); },
  };
}

const timeout = Symbol('timeout');
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), ms); })]);
  } finally { clearTimeout(timer); }
}

// Never abort an uncertain commit. The reservation and busy slot are retained by
// the caller when reconciliation cannot establish a terminal state.
export async function recoverHostAttempt(host: HostCreateCallbacks, id: SessionId, timeoutMs = 30_000): Promise<CreateAttemptState | 'unknown'> {
  try {
    const state = await within(host.status(id), timeoutMs);
    return state === timeout ? 'unknown' : state;
  } catch { return 'unknown'; }
}

export function coordinateHostAttempts(host: HostCreateCallbacks, timeoutMs = 30_000): HostCreateCallbacks {
  return {
    ...host,
    async prepare(id, principal, data) {
      let result: Result<void, unknown> | typeof timeout;
      try { result = await within(host.prepare(id, principal, data), timeoutMs); }
      catch (error) { await host.abort(id); return { ok: false, error }; }
      if (result !== timeout) return result;
      host.cancel?.(id);
      await host.abort(id);
      return { ok: false, error: 'create_prepare_timeout' };
    },
    async commit(id) {
      // A thrown/lost reply says nothing about a commit's durable outcome.
      const observe = async <T>(call: () => Promise<T>): Promise<T | typeof timeout> => {
        try { return await within(call(), timeoutMs); } catch { return timeout; }
      };
      const result = await observe(() => host.commit(id));
      if (result !== timeout) return result;
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await observe(() => host.status(id));
        if (state === 'committed') return { ok: true, value: undefined };
        if (state === 'aborted') return { ok: false, error: 'create_aborted' };
        const retried = await observe(() => host.commit(id));
        if (retried !== timeout) return retried;
      }
      return { ok: false, error: 'create_outcome_unknown' };
    },
  };
}
