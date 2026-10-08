import type { Config, Envelope, EventPayloadMap, OperatorId, Result, SessionId, StoreError } from '../contract/index.js';

// S39 (D260, D265, I73): the two budget notices. Each announces a crossing and stops nothing.
//
// Whether a code has already been emitted is read from the spill on every check, never held
// in memory, so a restart neither repeats one nor needs state to avoid repeating it. Burn is
// the same full component-wise sum `PayrollView.remainingTokens` subtracts, so a notice and
// the payroll tile never disagree about whether a line was crossed.
export interface BudgetNoticeDeps {
  readEvents(sessionId: SessionId): AsyncIterable<Result<Envelope, StoreError>>;
  // The host append path the checklist uses (`SessionCore.events.append`).
  append(sessionId: SessionId, owner: OperatorId, data: EventPayloadMap['session.notice']): Promise<Result<unknown, unknown>>;
  // Settles once every envelope already handed to a subscriber is in the spill, so the
  // `usage` envelope that triggered a check is part of what the check reads.
  flush(): Promise<void>;
}

export function createBudgetNotices(
  config: Pick<Config, 'sessionTokenBudget' | 'sessionTokenBudgetWarnFraction'>,
  deps: BudgetNoticeDeps,
) {
  // One check at a time per session. A check's own appends are durable before it settles,
  // so the next check's spill read sees them — the serialisation is what makes "read from
  // the spill" sufficient to keep each code to one occurrence.
  const chains = new Map<SessionId, Promise<void>>();

  async function check(sessionId: SessionId, owner: OperatorId): Promise<void> {
    const budget = config.sessionTokenBudget;
    if (budget === null) return;
    await deps.flush();
    let burn = 0;
    let usageSeen = false;
    let warned = false;
    let exhausted = false;
    for await (const result of deps.readEvents(sessionId)) {
      // An unreadable spill emits nothing: the next `usage` envelope checks again, late
      // rather than never.
      if (!result.ok) return;
      const envelope = result.value;
      if (envelope.kind === 'usage') {
        const { usage } = envelope.data as EventPayloadMap['usage'];
        usageSeen = true;
        burn += usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheCreate;
      } else if (envelope.kind === 'session.notice') {
        const { code } = envelope.data as EventPayloadMap['session.notice'];
        if (code === 'budget_warning') warned = true;
        else if (code === 'budget_exhausted') exhausted = true;
      }
    }
    // An unknown burn crosses nothing, and a warning after the line it warns of is noise
    // whatever configuration change made it newly reachable.
    if (!usageSeen || exhausted) return;
    const fraction = config.sessionTokenBudgetWarnFraction;
    if (fraction !== null && !warned && burn >= fraction * budget) {
      const appended = await deps.append(sessionId, owner, {
        level: 'warn',
        code: 'budget_warning',
        text: `This session has used ${burn} of its ${budget}-token budget, past the ${Math.round(fraction * 100)}% warning line. Nothing has been stopped.`,
      });
      // The warning precedes the exhaustion notice in `seq` order; if it did not land, the
      // next check emits both, in that order.
      if (!appended.ok) return;
    }
    if (burn >= budget) {
      await deps.append(sessionId, owner, {
        level: 'warn',
        code: 'budget_exhausted',
        text: `This session has used ${burn} tokens, its whole ${budget}-token budget. Nothing has been stopped, and it keeps accepting messages.`,
      });
    }
  }

  return {
    // Called once per `usage` envelope observed. Resolves when this check has finished.
    observe(sessionId: SessionId, owner: OperatorId): Promise<void> {
      const next = (chains.get(sessionId) ?? Promise.resolve()).then(() => check(sessionId, owner)).catch(() => {});
      chains.set(sessionId, next);
      void next.then(() => { if (chains.get(sessionId) === next) chains.delete(sessionId); });
      return next;
    },
  };
}
