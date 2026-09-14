# Red team — agentconsole-redteam-amended-v2.md

Target: D:/Downloads/agentconsole-redteam-amended-v2.md @ sha256:03f350b5bfe01e126acc6ee132a4a97f5daf5d08120c19a147c6c54c2c8cbcf7 (not in repo; evidence read at SkyNetHR eca7b2c)
Vendor: Anthropic
Model: claude-opus-5, effort not reported
Date: 2026-09-14
Note: This session wrote the base review. Another vendor made the amendments. The pass was run on the user's instruction. Findings F1–F17 in `2026-09-14-agentconsole-redteam-amended.md` are against the previous revision and are not restated here.

## F1
Severity: BLOCKING
Status: defect (adjudicated 2026-09-14). Evidence correction: the S13.9 bullet is wrong that the Phase 3b gate "cannot pass". `src/session-manager/index.test.ts` L3364 asserts only `state === 'approved'` (L3385) and never retries, and `claim` never changes `state`. The only other `release` test (`src/records/index.test.ts` L212) calls `release` directly. The gate would therefore pass silently with the defect present. Added evidence: the target's own L97 says the claim "must be released if a later step fails", and A5 provides no hook to do it.
Claim: A5 gives the host no signal that a create it has already approved was rolled back. The host's `records.claim` and `attachSession` side effects therefore outlive the session they were made for.
Where: §5 A5 (bullets 3–4, 6), A11 bullet 3; §6 row `records.claim/attachSession`; §9 Cancellation; §13 Phase 3b gate ("existing session-manager and edge suites pass unchanged")
Breaks when: The failure can happen in three places.
- **Failure after `beforeCreate`.** `host.beforeCreate` returns after SkyNetHR has claimed requisition R. Then the runtime's own create step fails: the adapter fails to spawn, or `store.createSession` hits a full disk. A5 rolls back only the runtime's pending transition and reservation. The hook set is `beforeCreate`, `afterCreate`, `beforeTurn` and `afterTurn`, so none of them runs on a failed create. `claim()` has added R to the in-memory `reservedForConsumption` set (`src/records/index.ts` L153-168). With no release, every later claim of R returns `requisition_consumed` until SkyNetHR restarts. Today the create path releases on every failure (`src/session-manager/index.ts` L1033, L1074, L1091-1102). Test S13.9 (`src/session-manager/index.test.ts` L3364) asserts that R is still `approved` after an injected `createSession` failure, so the Phase 3b gate cannot pass.
- **`beforeCreate` timeout.** The host handler claims R at 31 s. The runtime has already timed out at 30 s and rolled back. §9 `$/cancel` covers only SDK→runtime requests, so nothing tells the handler to stop or undo.
- **`afterCreate` timeout or stale discard.** `sessions.end` or a timeout invalidates the token after the handler's `attachSession` has durably appended `consumed` with the new sessionId (`src/records/index.ts` L170-179). The runtime discards the result and rolls the create back. `consumed` is terminal.
Consequence: A requisition becomes unusable, either until restart or permanently. In the permanent case it points at a session that does not exist. No operator action through the console recovers it.
Cost: Expensive later. The hook set, and where each hook sits relative to rollback, becomes part of both SDKs' host-callback surface at Phase 4. The permanent case writes bad records that survive the fix.

## F2
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-14). Evidence corrections: (1) "§3 L79" is §2 K2's recommended resolution. The rule that binds the amended text is A4 L318–319, where the bridge "injects it into the runtime call" and a non-owner gets `not_found`. L849 backs up A12's ban on owner filtering in bridges. (2) The document writes `principal` on `sessions.list`, `attachments.begin`, `events.append` and `turns.interrupt`, so its absence elsewhere is not shorthand. (3) The handle-keyed operations (`attachments.write/commit/abort`, `events.credit`, `events.unsubscribe`) are the weaker half, since nothing says the handle is bound to the opening principal. The strong half is `events.subscribe`, `events.read`, `toolOutput.read` and `attachments.read`, which are opened with no principal at all.
Claim: A2's read, subscribe and upload-continuation operations carry no `principal`. This contradicts A4's rule of "a principal on every session-scoped operation" (§3 L79), and A12 forbids the bridges from filtering by owner instead.
Where: §5 A2 (`events.subscribe`, `events.read`, `toolOutput.read`, `attachments.write/commit/abort/read`); A4 bullets 2–3; A12 bullet 3; A21 bullet 1
Breaks when: Operator B's browser asks the bridge for operator A's session: `events.subscribe {sessionId: A1}`, or `toolOutput.read {sessionId: A1, turnId, callId}`.
- **The bridge cannot check ownership.** It may not "implement owner filtering themselves" (A12), and the operation has no field to inject the principal into.
- **The runtime cannot check ownership either.** It has no caller to compare against A1's owner, so A4's `not_found` for non-owners cannot be produced.
- **Today every one of these calls takes `owner`.** See `subscribe`, `openToolOutput` and `openAttachment` (`src/contract/index.ts` L874-931).
- **`attachments.read {attachmentId}` loses the storage key.** It drops `sessionId` and `turnId`, but the preserved layout (A21) is keyed by all three (store `openAttachment(sessionId, turnId, attachmentId)`, `src/store/index.ts` L845). The runtime would need a global attachment index, or a scan, and there is still no session to scope an owner check against.
Consequence: Either any authenticated operator can read or stream any other operator's transcript, tool output and attachments, or the bridges carry owner policy that A12 says they must not. In both cases the Phase 4 impersonation conformance test covers only the operations that do carry `principal`.
Cost: Expensive later. Operation parameter shapes are frozen into PROTOCOL.md and both SDKs at Phase 4.

## F3
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-14). Location correction: the document supports two readings. (A) L797's "lane (A22)" includes the end semantics, so the Phase 3b gate contradicts itself as stated. (B) Phase 3b introduces only the lane (L805), and L808 defers "A22 semantics" to Phase 4. The break then lands at the Phase 5+7 cutover (L814), where SkyNetHR's `POST /end` mid-turn stops returning 409, contrary to the Phase 7 "behave the same from an operator perspective" criterion (L28, L47). Under either reading the document never says whether SkyNetHR keeps `409 turn_in_flight` on end. Added evidence: this is contracted behaviour, not only a test (SkyNetHR `design/20-contract.md` L1777, `design/10-design.md` L1747, S5.10).
Claim: A22's `sessions.end` closing barrier contradicts the document's own Phase 3b gate.
Where: §5 A22 bullet 5; §13 Phase 3b gate bullet 1
Breaks when: Phase 3b introduces the A22 lane while a turn is running, and `sessions.end` is called.
- **A22 requires end to proceed.** It "requests termination of any active turn … and only then transitions the session to ended".
- **The gate forbids that.** It requires "the existing session-manager and edge suites pass unchanged". Those suites assert that end mid-turn is refused with `turn_in_flight` and never kills the turn: S5.10 at `src/session-manager/index.test.ts` L1826 and `src/edge/sse/index.test.ts` L1140, implemented at `src/session-manager/index.ts` L1376.
- **Consequence for the gate.** It cannot pass with A22 implemented as written. One of the two is silently not met.
Consequence: The one gate meant to prove the in-process split changed nothing either fails, or is passed by not implementing A22's end semantics until Phase 4, where the stdio boundary is already in place.
Cost: Cheap now. The contradiction is between two paragraphs of the same document before any code exists.

## F4
Severity: LOCAL
Status: unadjudicated
Claim: A11's restore exclusivity is checked once at the start of a restore and is not held as a reservation. The create admission formula ("live sessions + pending reservations") does not see a restore in progress.
Where: §5 A11 bullets 3–4, 6
Breaks when: An embedder sets `maxLiveSessionsPerWorkspace: 2`. A11 makes this configurable, and only SkyNetHR sets it to `1`. Session S1 on `repo` starts `checkpoints.restore`, which passes its exclusivity check because no other overlapping session is live. While the checkout runs, `sessions.create` on `repo/web` counts one live session and zero reservations, which is below 2, so it is admitted. The new session's first turn writes into the tree mid-checkout.
Consequence: The restored tree mixes checkpoint content with the new session's writes, and the new session's first checkpoint captures a half-restored state.
Cost: Cheap now.

## F5
Severity: LOCAL
Status: unadjudicated
Claim: §8 still states the NuGet package graph that §10 and §15 forbid.
Where: §8 L535 ("one package per RID"), L548 ("`SubZeroDev.AgentConsole` references all `Runtime.<rid>` packages"); §10 L647; §15 L859
Breaks when: An implementer follows §8's package tree. §10 says the meta package "must **not** depend on every `Runtime.<rid>` package", and §15 says not to freeze the RID graph before the packaging spike.
Consequence: The package layout is built as described in §8 and has to be replaced after the spike.
Cost: Cheap now.
