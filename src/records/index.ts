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

function err<T>(error: RecordsError): Result<T, RecordsError> {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T, RecordsError> {
  return { ok: true, value };
}

export function createRecords(deps: { readonly config: Config; readonly store: Store }): Records {
  const { config, store } = deps;

  const requisitions = new Map<RequisitionId, Requisition>();

  // Reviews, in write-recency order (oldest write first): an update deletes then re-sets
  // its key, moving it to the end of Map iteration order. `isUnderPip` reads that order
  // directly for D83's "ties broken by the later line" — the same technique
  // `store.foldLatestById` uses to give `readAllReviews` the matching order at boot.
  const reviews = new Map<ReviewId, Review>();

  // D120/I5: a review's mutation — `appendReview` (a draft edit) and `finaliseReview`
  // share one guard, claimed synchronously before the `await` on their append. `state`
  // itself changes only once that append durably succeeds (Records boundary).
  const reviewMutating = new Set<ReviewId>();

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

      // I38: same guarantee as requisitions above — an unreadable `reviews.ndjson` yields
      // an empty registry rather than aborting boot. `store.readAllReviews` already folds
      // to the latest line per id, in write order (S15.12).
      const loadedReviews = await store.readAllReviews();
      for (const record of loadedReviews) reviews.set(record.reviewId, record);
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

    async createReview(author, snapshot: SessionSnapshot, input: CreateReviewInput) {
      // D127/S15.2: `subject` (the wire shape) and `snapshot.sessionId` (what the edge
      // resolved) must name the same session — the one consistency check `records` can
      // make without resolving a session itself.
      if (input.subject !== snapshot.sessionId) {
        return err({ code: 'bad_request', field: 'subject', detail: 'subject does not match the resolved session' });
      }
      const bodyBytes = Buffer.byteLength(input.body, 'utf8');
      if (bodyBytes > config.caps.reviewBodyBytes) {
        return err({ code: 'bad_request', field: 'body', detail: `body exceeds ${config.caps.reviewBodyBytes} bytes` });
      }

      const now = nowIso();
      const record: Review = {
        reviewId: randomUUID() as ReviewId,
        subject: input.subject,
        snapshot,
        author,
        state: 'draft',
        rating: input.rating,
        pip: input.pip,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      };

      const appended = await store.appendReview(record);
      if (!appended.ok) return err({ code: 'storage', cause: appended.error });
      reviews.set(record.reviewId, record);
      return ok(record);
    },

    async appendReview(reviewId, author, patch: ReviewPatch) {
      const current = reviews.get(reviewId);
      if (!current) return err({ code: 'no_such_review', reviewId });
      // I29: a `final` review is terminal, for every caller, before the author check —
      // it has already been read by others and its badge may already be raised.
      if (current.state === 'final') return err({ code: 'review_final', reviewId });
      // I31/D50: a draft not owned by `author` reads as not found, never a distinct
      // forbidden.
      if (current.author !== author) return err({ code: 'no_such_review', reviewId });

      if (patch.body !== undefined) {
        const bodyBytes = Buffer.byteLength(patch.body, 'utf8');
        if (bodyBytes > config.caps.reviewBodyBytes) {
          return err({ code: 'bad_request', field: 'body', detail: `body exceeds ${config.caps.reviewBodyBytes} bytes` });
        }
      }

      // I5/D120: claimed synchronously, before the `await` below — no other synchronous
      // step separates this from the reads above. A second mutation racing this one in
      // the same tick sees the review still at its prior `state`/`author`, which the
      // checks above already covered; the lock's job is only to stop two appends for the
      // same review both winning past this point before either's write lands.
      if (reviewMutating.has(reviewId)) return err({ code: 'review_final', reviewId });
      reviewMutating.add(reviewId);

      const updated: Review = {
        ...current,
        rating: patch.rating !== undefined ? patch.rating : current.rating,
        pip: patch.pip !== undefined ? patch.pip : current.pip,
        body: patch.body !== undefined ? patch.body : current.body,
        updatedAt: nowIso(),
      };

      const appended = await store.appendReview(updated);
      reviewMutating.delete(reviewId);
      if (!appended.ok) {
        // Records boundary: a failed append must not mutate the registry — `current`
        // still stands and the operator's edit is still in their form.
        return err({ code: 'storage', cause: appended.error });
      }
      reviews.delete(reviewId);
      reviews.set(reviewId, updated);
      return ok(updated);
    },

    async finaliseReview(reviewId, author) {
      const current = reviews.get(reviewId);
      if (!current) return err({ code: 'no_such_review', reviewId });
      if (current.state === 'final') return err({ code: 'review_final', reviewId });
      if (current.author !== author) return err({ code: 'no_such_review', reviewId });

      // I5/D120/D124: the same synchronous lock `appendReview` claims — finalisation is
      // a review mutation too.
      if (reviewMutating.has(reviewId)) return err({ code: 'review_final', reviewId });
      reviewMutating.add(reviewId);

      const finalised: Review = { ...current, state: 'final', updatedAt: nowIso() };

      // D128: durable — fsync'd before this resolves, so a caller that has received the
      // `200` knows this line survives a subsequent crash (I29).
      const appended = await store.appendReview(finalised);
      reviewMutating.delete(reviewId);
      if (!appended.ok) return err({ code: 'storage', cause: appended.error });
      reviews.delete(reviewId);
      reviews.set(reviewId, finalised);
      return ok(finalised);
    },

    getReview(reviewId, reader) {
      const found = reviews.get(reviewId);
      if (!found) return err({ code: 'no_such_review', reviewId });
      if (found.state === 'draft' && found.author !== reader) return err({ code: 'no_such_review', reviewId });
      return ok(found);
    },

    listReviews(subject) {
      // D70/I31: finals only, for every operator including the drafts' own authors —
      // an author reaches their own draft through `getReview` instead.
      return Array.from(reviews.values()).filter((r) => r.state === 'final' && r.subject === subject);
    },

    isUnderPip(subject) {
      // I35/D72/D83: the `pip` of the final review for `subject` with the greatest
      // `updatedAt`, ties broken by the later line. `reviews` iterates oldest write
      // first, so scanning forward and taking `>=` lets the later-written entry win a
      // tie without a second field.
      let best: Review | null = null;
      for (const r of reviews.values()) {
        if (r.state !== 'final' || r.subject !== subject) continue;
        if (best === null || r.updatedAt >= best.updatedAt) best = r;
      }
      return best !== null && best.pip;
    },
  };

  return records;
}
