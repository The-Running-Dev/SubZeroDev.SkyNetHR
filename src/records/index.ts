import { randomUUID } from 'node:crypto';
import type {
  Config,
  CreateReviewInput,
  IsoTimestamp,
  OperatorId,
  RaiseRequisitionInput,
  Records,
  RecordsError,
  Requisition,
  RequisitionDecision,
  RequisitionId,
  RequisitionState,
  Result,
  Review,
  ReviewId,
  ReviewPatch,
  SessionId,
  SessionSnapshot,
  Store,
} from '../contract/index.js';

function nowIso(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

function notImplemented(method: string): never {
  throw new Error(`records.${method} is not implemented before S15`);
}

function err<T>(error: RecordsError): Result<T, RecordsError> {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T, RecordsError> {
  return { ok: true, value };
}

export function createRecords(deps: { readonly config: Config; readonly store: Store }): Records {
  const { config, store } = deps;

  const requisitions = new Map<RequisitionId, Requisition>();

  // S13.6/I33/I5: a claim taken but not yet durable as `consumed` — checked by `claim`
  // alongside `state`, per D120's exclusivity-lock shape, so a second `POST /api/sessions`
  // naming the same requisition in the same tick is refused even though the on-disk/registry
  // `state` has not moved off `approved` yet.
  const reservedForConsumption = new Set<RequisitionId>();

  // D120: a decision claims this lock synchronously, before the `await` on its append —
  // never the requisition's own `state`, which changes only once that append durably
  // succeeds. A second `decide` racing the first in the same tick sees the lock and is
  // refused, reporting the outcome the in-flight decision is about to produce.
  const deciding = new Map<RequisitionId, { readonly decidedBy: OperatorId; readonly state: RequisitionState }>();

  const records: Records = {
    async boot(): Promise<void> {
      // I38: never fails — an unreadable log yields an empty registry, because tier two
      // must not deny an operator tier one. `store.readAllRequisitions` already folds to
      // the latest line per id and drops a torn trailing line (S13.14).
      const loaded = await store.readAllRequisitions();
      for (const record of loaded) requisitions.set(record.requisitionId, record);
    },

    async raise(raisedBy, input: RaiseRequisitionInput) {
      const titleBytes = Buffer.byteLength(input.title, 'utf8');
      if (titleBytes > config.caps.requisitionTextBytes) {
        return err({ code: 'bad_request', field: 'title', detail: `title exceeds ${config.caps.requisitionTextBytes} bytes` });
      }
      const justificationBytes = Buffer.byteLength(input.justification, 'utf8');
      if (justificationBytes > config.caps.requisitionTextBytes) {
        return err({ code: 'bad_request', field: 'justification', detail: `justification exceeds ${config.caps.requisitionTextBytes} bytes` });
      }

      // S13.2: `workspace` is stored exactly as given — never resolved, never jailed here.
      const record: Requisition = {
        requisitionId: randomUUID() as RequisitionId,
        raisedBy,
        title: input.title,
        justification: input.justification,
        workspace: input.workspace,
        vendor: input.vendor,
        state: 'open',
        decidedBy: null,
        decidedAt: null,
        sessionId: null,
        raisedAt: nowIso(),
      };

      const appended = await store.appendRequisition(record);
      if (!appended.ok) return err({ code: 'storage', cause: appended.error });
      requisitions.set(record.requisitionId, record);
      return ok(record);
    },

    listRequisitions() {
      // D70: every authenticated operator, not scoped to the caller.
      return Array.from(requisitions.values());
    },

    getRequisition(requisitionId) {
      const found = requisitions.get(requisitionId);
      if (!found) return err({ code: 'no_such_requisition', requisitionId });
      return ok(found);
    },

    async decide(requisitionId, decidedBy, decision: RequisitionDecision) {
      const current = requisitions.get(requisitionId);
      if (!current) return err({ code: 'no_such_requisition', requisitionId });

      if (current.state !== 'open') {
        return err({ code: 'already_decided', requisitionId, decidedBy: current.decidedBy as OperatorId, state: current.state });
      }

      const inFlight = deciding.get(requisitionId);
      if (inFlight) {
        return err({ code: 'already_decided', requisitionId, decidedBy: inFlight.decidedBy, state: inFlight.state });
      }

      const nextState: RequisitionState = decision === 'approve' ? 'approved' : 'rejected';
      // I5/D32: claimed synchronously, before the `await` below — no other synchronous
      // step separates this from the reads above.
      deciding.set(requisitionId, { decidedBy, state: nextState });

      const updated: Requisition = { ...current, state: nextState, decidedBy, decidedAt: nowIso() };
      const appended = await store.appendRequisition(updated);
      deciding.delete(requisitionId);
      if (!appended.ok) {
        // D120/Records boundary: a failed append must not mutate the registry — `current`
        // still reads `open` and a retry (by anyone) can still decide it.
        return err({ code: 'storage', cause: appended.error });
      }
      requisitions.set(requisitionId, updated);
      return ok(updated);
    },

    claim(requisitionId) {
      const current = requisitions.get(requisitionId);
      if (!current) return err({ code: 'no_such_requisition', requisitionId });
      if (current.state === 'consumed') {
        return err({ code: 'requisition_consumed', requisitionId, sessionId: current.sessionId });
      }
      if (current.state !== 'approved') {
        return err({ code: 'requisition_not_approved', requisitionId, state: current.state });
      }
      // S13.6/I33/I5: a second claim in the same tick, before either's append has landed.
      if (reservedForConsumption.has(requisitionId)) {
        return err({ code: 'requisition_consumed', requisitionId, sessionId: null });
      }
      reservedForConsumption.add(requisitionId);
      return ok(undefined);
    },

    async attachSession(requisitionId, sessionId) {
      const current = requisitions.get(requisitionId);
      if (!current) return err({ code: 'no_such_requisition', requisitionId });
      const updated: Requisition = { ...current, state: 'consumed', sessionId };
      const appended = await store.appendRequisition(updated);
      if (!appended.ok) return err({ code: 'storage', cause: appended.error });
      requisitions.set(requisitionId, updated);
      reservedForConsumption.delete(requisitionId);
      return ok(undefined);
    },

    release(requisitionId) {
      // S13.9/D80: in-process only. A crash between `claim` and `release`/`attachSession`
      // leaves the requisition spent with no session — accepted, not reconciled here.
      reservedForConsumption.delete(requisitionId);
    },

    async createReview(_author: OperatorId, _snapshot: SessionSnapshot, _input: CreateReviewInput) {
      notImplemented('createReview');
    },
    async appendReview(_reviewId: ReviewId, _author: OperatorId, _patch: ReviewPatch) {
      notImplemented('appendReview');
    },
    async finaliseReview(_reviewId: ReviewId, _author: OperatorId) {
      notImplemented('finaliseReview');
    },
    getReview(_reviewId: ReviewId, _reader: OperatorId) {
      notImplemented('getReview');
    },
    listReviews(_subject: SessionId) {
      notImplemented('listReviews');
    },
    isUnderPip(_subject: SessionId) {
      notImplemented('isUnderPip');
    },
  };

  return records;
}
