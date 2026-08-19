import type { ServerResponse } from 'node:http';
import type { ApiErrorCode } from '../../contract/index.js';

// Shared by every edge that speaks `ApiErrorCode` (`edge/sse` today, `edge/ws` from S11):
// one copy of the mapping is what keeps two transports answering the same failure with the
// same status.
const STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  bad_origin: 403,
  no_such_session: 404,
  no_such_output: 404,
  no_such_attachment: 404,
  no_such_checkpoint: 404,
  turn_in_flight: 409,
  session_ended: 409,
  workspace_busy: 409,
  outside_workspace_root: 409,
  bad_request: 422,
  checkpoint_failed: 500,
  agent_unavailable: 503,
  no_such_requisition: 404,
  requisition_not_approved: 409,
  requisition_consumed: 409,
  already_decided: 409,
  no_such_review: 404,
  review_final: 409,
  no_such_item: 404,
  record_write_failed: 500,
  payroll_unavailable: 500,
};

// Named so a fallback is visibly a fallback rather than a `500` chosen on the spot that
// happens to match `checkpoint_failed`'s. `STATUS_FOR` is `Record<ApiErrorCode, number>`, so
// every code the type system knows about already has an entry; this only reaches a caller
// that has a code the mapping does not — never a branch a compiler-checked switch would take.
export const FALLBACK_STATUS = 500;

export function statusForCode(code: ApiErrorCode): number {
  return STATUS_FOR[code] ?? FALLBACK_STATUS;
}

export function sendError(res: ServerResponse, code: ApiErrorCode, message: string, detail?: unknown): void {
  const body = JSON.stringify({ error: detail === undefined ? { code, message } : { code, message, detail } });
  res.writeHead(statusForCode(code), { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
