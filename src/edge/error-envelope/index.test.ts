import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiErrorCode } from '../../contract/index.js';
import { FALLBACK_STATUS, statusForCode } from './index.js';

describe('statusForCode', () => {
  it('resolves every mapped code to its own status', () => {
    assert.equal(statusForCode('unauthenticated'), 401);
    assert.equal(statusForCode('bad_origin'), 403);
    assert.equal(statusForCode('no_such_session'), 404);
    assert.equal(statusForCode('turn_in_flight'), 409);
    assert.equal(statusForCode('bad_request'), 422);
    assert.equal(statusForCode('checkpoint_failed'), 500);
    assert.equal(statusForCode('agent_unavailable'), 503);
  });

  it('resolves an unmapped code to the named fallback, not its own status', () => {
    // `ApiErrorCode` is a closed union, so this cast stands in for a code the mapping was
    // never updated for — the case the fallback exists to catch.
    const unmapped = 'nonesuch' as ApiErrorCode;
    assert.equal(statusForCode(unmapped), FALLBACK_STATUS);
  });
});
