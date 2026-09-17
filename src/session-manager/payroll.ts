import type { Config, SessionId, SessionRecord, Result, PayrollView, SessionError, Usage, IsoTimestamp, EventPayloadMap, Store } from '../contract/index.js';
export function createPayrollFold(config: Config, store: Pick<Store, 'readEventsAfter'>) {


  // S16: burn, idle time and the budget subtraction are folds over the session's own
  // spill — never a running counter — so a live read and a post-restart read walk the
  // identical path and cannot disagree (S16.5). `usage` events are the only source of
  // `burn`: `turn.ended.usage` is always emitted `null` by every adapter (D75 puts the
  // vendor-normalised, summable figure on the dedicated `usage` envelope instead), so
  // summing it here would double-count nothing but is also never a source to skip.
  async function foldPayroll(sessionId: SessionId, record: SessionRecord): Promise<Result<PayrollView, SessionError>> {
    const burn: { -readonly [K in keyof Usage]: Usage[K] } = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
    let idleMs = 0;
    let droppedIntervals = 0;
    // D130: `session.notice / server_restart` is the only restart marker this fold reads.
    // Once it is seen the session's billable timeline stops — a rehydrated session is
    // `ended` and never runs another turn (D20), so anything after that notice is boot's
    // own bookkeeping, appended at the boot clock rather than at anything the operator did.
    let restarted = false;
    // S20.3: the discriminator for `costCurrency` is this notice, never a comparison against
    // `burn` — a session that genuinely burned nothing still prices a real `0.00`, and only a
    // transport that cannot report usage at all prices `null` (D146, `## Unresolved` 12).
    let usageUnavailable = false;
    // The wall-clock boundary the *next* idle interval starts from: `null` while a turn
    // is open (busy, not idle), the last `turn.ended`'s own `ts` otherwise. Idle time is
    // billed session-creation-to-first-turn (D76/`10-design.md § Derived views`), so it
    // starts at `record.createdAt` rather than at the first envelope read.
    let cursor: IsoTimestamp | null = record.createdAt;

    for await (const result of store.readEventsAfter(sessionId, 0)) {
      if (!result.ok) return { ok: false, error: { code: 'payroll_unavailable', cause: result.error } };
      const envelope = result.value;
      switch (envelope.kind) {
        case 'turn.started': {
          if (cursor !== null) idleMs += new Date(envelope.ts).getTime() - new Date(cursor).getTime();
          cursor = null;
          break;
        }
        case 'turn.ended': {
          // D130: this envelope's `stopReason` carries no fold meaning, `server_restart`
          // included. The guard is `restarted`, not the stop reason — boot appends its
          // synthetic close *after* the restart notice (S7.4), and billing an interval
          // from it would start a fresh one at the boot clock on a session that is over.
          if (!restarted) cursor = envelope.ts;
          break;
        }
        case 'session.notice': {
          const data = envelope.data as EventPayloadMap['session.notice'];
          if (data.code === 'usage_unavailable') {
            usageUnavailable = true;
            break;
          }
          if (data.code !== 'server_restart') break;
          // D130's one rule, covering both cases: drop the interval this notice closes if
          // one was open (the server went down between turns), and count it. Mid-turn
          // there is no open interval — `turn.started` cleared the cursor and the close
          // has not been appended yet — so nothing is dropped and the outage stays
          // attributed to the turn, which is `droppedIntervals: 0`.
          if (cursor !== null) droppedIntervals += 1;
          cursor = null;
          restarted = true;
          break;
        }
        case 'usage': {
          const data = envelope.data as EventPayloadMap['usage'];
          burn.inputTokens += data.usage.inputTokens;
          burn.outputTokens += data.usage.outputTokens;
          burn.cacheRead += data.usage.cacheRead;
          burn.cacheCreate += data.usage.cacheCreate;
          break;
        }
        default:
          break;
      }
    }

    // Last-turn-to-`endedAt` (S16.6). A live session mid-turn has `cursor === null` (no
    // trailing idle to bill yet); a live session between turns has no `endedAt` yet
    // either, so nothing is added until the session actually ends. A session that has been
    // through a restart never reaches this: the notice cleared the cursor, and `endedAt`
    // on a rehydrated session is stamped at boot rather than at anything it did (D130).
    if (cursor !== null && record.endedAt !== null) {
      idleMs += new Date(record.endedAt).getTime() - new Date(cursor).getTime();
    }

    const budgetTokens = config.sessionTokenBudget;
    const totalBurn = burn.inputTokens + burn.outputTokens + burn.cacheRead + burn.cacheCreate;
    // D158/S20: priced against `Config.tokenRates`, never against a vendor's billed amount.
    // `null` covers exactly the two cases S20.2 names — no rates configured, and this
    // session's transport cannot report usage — and neither is inferred from `totalBurn`.
    const rates = config.tokenRates;
    const costCurrency =
      rates === null || usageUnavailable
        ? null
        : burn.inputTokens * rates.inputTokens +
          burn.outputTokens * rates.outputTokens +
          burn.cacheRead * rates.cacheRead +
          burn.cacheCreate * rates.cacheCreate;
    return {
      ok: true,
      value: {
        sessionId,
        burn,
        budgetTokens,
        remainingTokens: budgetTokens === null ? null : budgetTokens - totalBurn, // D129
        idleMs,
        droppedIntervals,
        costCurrency,
        currency: costCurrency === null ? null : config.currency,
      },
    };
  }
return foldPayroll;
}
