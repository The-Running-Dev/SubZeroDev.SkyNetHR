# Red team — agentconsole-redteam-amended.md

Target: D:/Downloads/agentconsole-redteam-amended.md @ sha256:9e63897708fa95e9a82f777d8efb892e85115667038faa5ceb9222ca8d47446f (not in repo; evidence read at SkyNetHR eca7b2c)
Vendor: Anthropic
Model: claude-opus-5, effort not reported
Date: 2026-09-14
Note: This session wrote the base review. Another vendor made the amendments. The pass was run on the user's instruction.

## F1
Severity: BLOCKING
Status: defect (adjudicated 2026-09-15). Evidence nuance: L774 already converts records into A5 hooks in Phase 3b in-process, so if that hook is awaited the race is reachable a phase earlier than Phase 4, and the "suites pass unchanged" gate would not catch it. Context: v2 addresses this (A11 L365–367 overlap semantics and pending reservations, L866). v2 also dropped this revision's `onCreateFailed` (A5 L307), which is the gap v2 F1 records.
Claim: Workspace concurrency (A11) has no serialization domain. A22's lanes are per session, and A5 moves `records.claim` into an async `host.beforeCreate` round trip that sits inside the window between the busy check and the claim.
Where: §5 A5, A11, A22; §6 row "Workspace jail … I6"; §13 Phase 4 gate
Breaks when: SkyNetHR sets `maxLiveSessionsPerWorkspace: 1`, and two operators call `sessions.create` with cwd `D:/src/app` and `D:/src/app/web` within one `host.beforeCreate` round trip (one pipe round trip plus the host handler). Neither session exists yet, so no per-session lane covers either request. Both see zero live sessions, both await the callback, and both proceed. Today, I5 forbids any `await` between `findLiveOverlap` and `sessions.set` (`src/session-manager/index.ts` L1005-1069), and `records.claim` is synchronous by contract (L1013-1019). A11 also counts sessions "per workspace", while today's test is `pathsOverlap` (`src/jail/index.ts` L50-52), which catches nesting in either direction; A11 never says what identity "workspace" has. Phase 3b's race tests cover only A22's per-session races. The race first becomes reachable in Phase 4's `sessions.create → host.beforeCreate` scenario.
Consequence: Two live agents write the same tree. One session's checkpoints capture the other's edits, and restoring one reverts the other's work.
Cost: Expensive later. A22 declares serialization to be protocol semantics, and where the callback sits inside `create` is fixed into both SDKs' conformance scenarios from Phase 4 on.

## F2
Severity: BLOCKING
Status: defect (adjudicated 2026-09-15). Scenario correction: this revision has only two host callbacks, `host.beforeCreate` (A5 L313) and `afterCreate` (§6 L414). Secret resolution is for API providers (A10 L332), and host-executed tools come "later" (L364). The Stop-during-lookup case is therefore not reachable in v1: under `beforeCreate` the session does not exist yet, and under either callback no turn is running. The v1-reachable form is `afterCreate` once S is addressable (A19 L374 or `sessions.list`). A second caller's `sessions.end {S}` gets a spurious `reentrant_session_call`, or the handler's own `events.append {S}` deadlocks. The general case arrives with host-executed tools, after the protocol has frozen at Phase 4. The mechanism is sustained as stated: SDK requests carry only integer ids (§9 L526–527), so nothing links a request to its callback. Context: v2 addresses this by not holding the lane across callbacks (v2 A5 L325–330, A17 L395).
Claim: A17's re-entrancy rule cannot be implemented. The runtime cannot tell a callback handler's re-entrant mutating call apart from an unrelated concurrent mutating call on the same session.
Where: §5 A5 (last bullet), A17 (last bullet), A22 (bullet 4); §9 stdio "Concurrent session operations"; §13 Phase 4 gate
Breaks when: The runtime is awaiting a host callback that holds session S's lane, for example an 800 ms records lookup. During that wait, (a) the operator clicks Stop and the bridge sends `turns.interrupt {S}`, and (b) the callback handler itself calls `events.append {S}`. Both arrive on stdin as ordinary requests with integer ids. Neither carries the `r:<n>` id of the callback, because the protocol defines no causal link, and "synchronously" has no meaning across a pipe. The runtime must therefore treat both calls the same way. If it rejects both, the operator's Stop, approve or end gets `reentrant_session_call`. If it queues both, (b) deadlocks: the callback awaits a request that is queued behind the lane the callback holds.
Consequence: Either operators get spurious errors on Stop, approve and end whenever a host callback is in flight, or the session hangs permanently. The Phase 4 gate ("rejection of same-session mutating re-entry") passes with a single caller and fails with two.
Cost: Expensive later. Callback-issued requests would need a correlation field defined in PROTOCOL.md and implemented in both SDKs.

## F3
Severity: BLOCKING
Status: defect (adjudicated 2026-09-15). Evidence nuances: (1) the git-checkout-over-B bullet is partly answered by A11 L345, which lets an extension declare stricter workspace concurrency with the runtime enforcing the effective minimum. The document never says checkpoints does so. The ended-session guard at L1458–1461 is about a rehydrated session's reclaimed cwd, not a live overlapping session. (2) The disappearing-rows bullet is conditional. A8 L325 says only "extension event", while the L780 snapshot test and L826 keep the unprefixed `checkpoint.created`. The core holds: no checkpoint operations in A2, no operation registration anywhere in the document, and restore is absent from the A22 L384 mutator list. §4 item 12 (L270) makes the extension "definitive", so this is an internal contradiction, not a deferral. Context: v2 addresses this with extension-registered `checkpoints.list`/`checkpoints.restore` as A11/A22 mutators (v2 L304, L421, L870), and keeps `checkpoint.created` (v2 L343). v2's restore-reservation gap is v2 F4.
Claim: Checkpoint listing and restore have no protocol operation, and no extension mechanism exists that could add one. Restore is also not among A22's named lane mutators.
Where: §5 A2, A5, A6, A8, A11, A22; §4 item 12 ("made definitive"); §6 row `src/checkpoints`
Breaks when: SkyNetHR migrates (step 6). Today:
- restore is `restore(sessionId, owner, sha)` (contract L894);
- the client lists checkpoints and posts a restore (`client/app.js` L298, L323);
- restore claims the turn slot synchronously, so it cannot interleave with `message()` (`src/session-manager/index.ts` L1462-1471).

What the document offers instead:
- A2 adds no checkpoint operations.
- A5 gives extensions four lifecycle hooks and no way to register a method.
- A12 forbids bridges from parsing payloads for policy.
- With `maxLiveSessionsPerWorkspace > 1` (A11), restoring session A runs a git checkout over session B's live tree. That hazard is why restore refuses ended sessions today (L1458-1461).
- A8 makes `checkpoint.created` an extension event. If it takes A6's `x-` form, renderers ignore it, and the checkpoint rows drawn by `client/render.js` L164/L329 disappear.
Consequence: Tier-one item 6 (roll back) cannot be reached through the runtime, so Phase 7's "behave the same from an operator perspective" fails. If restore is added ad hoc outside the lane, a Send racing a Restore interleaves git operations with a running turn.
Cost: Expensive later. It needs an extension-operation namespace and a lane-mutator category, added after both SDKs ship.

## F4
Severity: BLOCKING
Status: defect (adjudicated 2026-09-15). Severity kept at BLOCKING over a recommended STRUCTURAL: K2 (L68, L79) presents A4 as the answer to cross-user access, so as shipped it reads as a tenant boundary, and the worst outcome is cross-tenant exposure attributed to the reader's own tool call. Evidence: no statement anywhere in this revision that `principal` is not an OS or filesystem boundary. Q1 (L810) covers only shared CLI login and billing, Q6 (L815) only session sharing, and L165's "another tenant's checkout" reinforces the tenant reading. Unverified: the Absence line's claim about the proposal, which is not available; the review half holds. Context: v2 addresses this with a threat-model boundary in A4 that puts mutually untrusted tenants out of scope (v2 L321–322).
Claim: Principal isolation (A4) is enforced only at the protocol surface. Every principal's agent runs as the same OS user, with read and write reach over every other principal's workspaces, the runtime store and the audit log. Nothing in the document says so.
Where: §2 K2; §5 A4, A9, A11; §14 Q1, Q6. Absence: neither the review nor the proposal has a threat model (the proposal has no match for "threat", "isolation" or "trusted").
Breaks when: A multi-user ASP.NET host (K2's own scenario) has principals alice and bob and `workspaceRoots: ['D:/work']`. Alice's session in `D:/work/alice` asks the agent to read `D:/work/bob/.env`, or `<runtimeRoot>/sessions/*/events.ndjson`. Nothing stops it:
- the realpath jail constrains only `cwd` at create time (D28, "not a sandbox");
- A9 constrains the environment, not the filesystem;
- CLI tool calls run as the host OS user.

SkyNetHR's brief scopes this case out ("Console access is equivalent to shell access", Non-goals). The review carries A4 forward to multi-user hosts without that non-goal.
Consequence: An embedder reads K2 ("user A can read, drive and approve tool calls in user B's session") and A4 as a tenant boundary, and deploys to mutually untrusted users. Any user can then read any other user's code, secrets and transcripts through their own agent. The audit log records this as alice's own tool call.
Cost: Expensive later. A real boundary means a per-principal OS identity or containers, which changes the process model, the PID ledger and the store layout.

## F5
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-15). Evidence nuance: elsewhere the review uses "§17" for the proposal's ASP.NET section (L45, L63, L132), and L690 also cites a "§17 table". So "the §17 error table below" may point at a proposal section rather than a missing section of this document. It dangles either way: the ASP.NET section is not an error table, and L486 lists the error table only as future `PROTOCOL.md` content. Added evidence: H3 L126 cites `EventPayloadMap` "L208-223" as lacking `error`, but `error` is at L222, inside that range. The L1477 emission carries `fatal: false`. Context: v2 addresses this, keeping `error` as a v1 kind (v2 H3 L125–127, A8 L342) and flipping the warning (v2 L852).
Claim: H3, A8 and a §15 warning rest on a false fact. `error` is already an event kind, so "no `error` event kind" removes a kind that exists, is emitted and is rendered.
Where: §3 H3; §5 A8; §15 "DO NOT LET ASTRA add an `error` event kind"
Breaks when: An implementer follows A8 or the §15 warning. The kind is live today:
- `src/contract/index.ts` L222 declares `error: ErrorEvent` inside `EventPayloadMap` (L207).
- `src/session-manager/index.ts` L1477 emits `error` for `checkpoint_restore_failed`.
- `client/app.js` L598 lists `error` among the kinds it handles.

A8 also defines v1 as "the existing `EventPayloadMap` minus `checklist.item.completed`", which still contains `error`, so A8 contradicts itself. A8 further points to "the §17 error table below", but the document ends at §15.
Consequence: A partial restore (`restore_incomplete`, `fatal: false`) and other failures outside a turn have no event, so the operator is not told the workspace is half-restored. Otherwise the implementer keeps `error` and breaks the warning. Either way the vocabulary is decided by whichever sentence was read last.
Cost: Expensive later. The v1 vocabulary is frozen into the schemas and both SDKs.

## F6
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-15). Reach corrections: (a) holds, and the runtime heartbeat (L630) cannot detect it because the receive loop stays live (L578). In v1, only create callbacks hold a lane (see F2), so a hung `beforeCreate` leaves `sessions.create` unanswered, and a hung `afterCreate` blocks `sessions.end`/`events.append` on S. Blocked `turns.interrupt`/`permissions.respond` requires a callback during a turn. (b) The deadlock branch is not the document's reading, because A22 L384 lists "turn start/end" as separate mutators. The other branch stands as written: L384 makes `turn.ended` a lane mutator, L388's barrier fails "later queued mutators" with no exception for the active turn's terminal event, and L389 requires the end-vs-in-flight scenario without defining its outcome. SkyNetHR today refuses end with `turn_in_flight` (`src/session-manager/index.ts` L1376), so the orphan appears only once A22 replaces that (compare v2 F3). Context: v2 addresses both, with a 30 s callback timeout that never wedges the lane (v2 A5 L328, L851) and a barrier that still permits the active turn's terminal events (v2 A22 L418).
Claim: A22's lane has no liveness rule. Runtime→host callbacks have no timeout, and nothing defines what holds the lane across a multi-minute turn. The behaviour of `sessions.end` and `turns.interrupt` against a held lane is therefore undefined.
Where: §5 A5, A17, A22; §9 stdio "Process death" and "Concurrent session operations"
Breaks when:
- **(a) A host callback handler hangs** (database lock, thread-pool starvation). The lane is held indefinitely. Queued `turns.interrupt`, `permissions.respond` and `sessions.end` never run. Only stdin EOF clears it, which restarts the runtime for every principal. The document contains no callback timeout; its only timeouts are the heartbeat and the host shutdown (§10).
- **(b) A turn spans minutes** from `turn.started` to `turn.ended`, including permission waits.
  - If the turn holds the lane, `permissions.respond` and `turns.interrupt` queue behind the very turn they target, which is a deadlock.
  - If the turn does not hold the lane, the lane only serializes the order requests are queued in, and A22's "`sessions.end` vs an in-flight turn" scenario has no defined outcome. Once `end` is accepted as the barrier, `turn.ended` (itself a lane mutator) is a "later queued mutator" and must fail with `session_ended`, which leaves the turn with no terminal event.
Consequence: A stuck session that no operator action can stop, or a transcript whose last turn never ends, so the renderer spinner never clears on replay.
Cost: Expensive later. Lane granularity is the core concurrency contract.

## F7
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-15). Evidence corrections: (1) queue depth is still measurable per subscription. What the shared pipe removes is attributing the pressure to one subscription; SkyNetHR today guards each subscriber's own socket (`src/edge/sse/index.ts` L145). (2) Only subscriptions actually streaming during the stall cross high-water, so 100 gaps needs 100 busy sessions. (3) Step 5 is inference: the target never says the writer shares an execution path with lane processing or CLI stdout reads. Confirmed: §9 L566–567 and L569 specify per-subscription queues, never-dropped responses and resubscribe-from-last-seq with no link-level flow control and no overflow rule for the control lane. Context: v2 addresses this with `events.credit` (v2 L291, L309, L598–600), declares pipe backpressure global (v2 L311, L869), and adds a priority control queue with fair scheduling (v2 L601).
Claim: Per-subscription backpressure (A3, §9) cannot be measured on one shared stdout pipe. One slow SDK reader therefore gaps every session at once, and resubscribe-with-replay amplifies the load that caused it. The "bounded control lane", whose responses "are never dropped", has no overflow behaviour.
Where: §5 A3; §9 stdio "Backpressure"
Breaks when: One ASP.NET host runs 100 live sessions across 30 principals, and a GC pause or thread-pool starvation stalls the SDK read loop for 2 s. The chain:
1. The only signal the runtime sees is `stdout.write` returning false, which is pipe-wide, not per subscription.
2. All 100 subscription queues cross high-water together, producing 100 `replay_gap`s.
3. The SDK resubscribes each one from its last seq (§9), replaying ring and spill for 100 sessions onto the pipe that just stalled, which gaps again.
4. Meanwhile the control lane fills. "Bounded" plus "never dropped" leaves only blocking the writer.
5. A blocked writer stalls lane processing, which stops the runtime reading CLI stdout, which blocks the CLI children.
Consequence: Under load no single user would produce, every user's console flaps between gap and replay, and turns stall across the whole host.
Cost: Expensive later. Flow control on the link is protocol semantics shared by both SDKs.

## F8
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-15). Added evidence: `audit.ndjson` also sits at `storageRoot` (`src/store/index.ts` L577), and §6 L407 routes `readAudit` to the runtime, so audit is in the same unassigned move as `reviews.ndjson`/`requisitions.ndjson` (L579–580). The target cites both the current blob layout (L52, L235) and the shared lease (L100), yet has no match for migration, compatibility or relocation. The `schemaVersion` bullet is conditional: the target never mentions a bump, and `readAllMeta` accepts only `1` (L648). Context: v2 addresses this, forbidding Phase 3b relocation and adding a compatibility layout adapter for historical sessions (v2 A13 L378–379).
Claim: A21 (opaque storage ids) and A13 (separate runtime and HR storage roots) change the on-disk layout of existing SkyNetHR data, and no phase migrates that data or reads the old layout.
Where: §5 A13, A21; §6 `src/store` rows; §13 Phase 3b ("Give HR files their own lease root"), step 6 ("Cutover is per process")
Breaks when: A SkyNetHR instance upgrades through Phase 3b and step 6 while holding existing data:
- `sessions/<id>/tool-output/<turnId>/<callId>` blobs (`src/store/index.ts` L772-796);
- reviews and requisitions under the same root.

After the upgrade:
- The runtime looks blobs up by opaque id, and nothing indexes the pre-existing callId-named files.
- The HR files are not at the new HR root.
- If the layout change bumps `schemaVersion`, `readAllMeta` returns `unsupported_schema_version` for every old `meta.json` (L648-653).
Consequence: Every tool output in past transcripts returns not-found, reviews and requisitions look empty, or old sessions come back unreadable. That breaks "ended and readable" (D20), which §9 itself cites.
Cost: Expensive later. Once both layouts exist in the field, readers must carry both indefinitely.

## F9
Severity: STRUCTURAL
Status: defect (adjudicated 2026-09-15). Context: the shape is inherited, not introduced. SkyNetHR today has only an owner-scoped hard delete (D25), no automatic retention, and no paging, which suits its small trusted operator group but not a reusable multi-user protocol. Not a brief conflict, since SkyNetHR's brief does not require retention. Q6 (L815) covers cross-principal sharing, not identity migration or cleanup. The only paging in this revision is `events.read {…limit}` (L287). v2 adds a paged `sessions.list` (L284, L293), an explicit retention default (L285), and `admin.sessions.list/remove/reassignPrincipal` (L286, L295).
Claim: Session data has no retention policy, no removal path that works without the owning principal, and no pagination. Storage and boot cost grow with every principal's entire history, and sessions become unreachable when a principal mapping changes.
Where: §5 A1, A2 (`sessions.remove` is principal-scoped), A4 (`admin.*` is read-only: audit query and snapshot); §14 Q6
Breaks when:
- **The host changes its identity mapping.** For example, a proxy header switches from username to email, or an IdP migration changes `sub`. Every existing session keeps the old principal, so equality fails. `sessions.remove` requires that old principal, and `admin.*` has no list or remove.
- **Volume reaches 100× SkyNetHR's.** A multi-user host with 50 users × 20 sessions per day for a year has about 365,000 sessions. Boot reads every `meta.json` sequentially (`readAllMeta`, `src/store/index.ts` L633-661). `sessions.list` walks an in-memory map of every session with no page parameter (`src/session-manager/index.ts` L1108-1115).
Consequence: Disk fills with orphaned transcripts and tool output that no one can reach or delete short of `rm`. Runtime start time grows with retention, and list responses for a heavy user grow without bound.
Cost: Expensive later for pagination and admin removal, which are protocol surface in both SDKs. Cheap now for a retention statement.

## F10
Severity: LOCAL
Status: defect (adjudicated 2026-09-15). Confirmed: the only fault path is stdout EOF (L572), which a stalled event loop never produces, and this revision has no per-request timeout (the only other timeout is host shutdown, L634). Cost correction: `runtime.ping` is named only in §10 L630 and is absent from A2's operation list, so the fix adds one operation as well as SDK launch code; still cheap now. The failure is new with the extraction, since SkyNetHR runs in-process today. v2 applies the heartbeat on all platforms (L657–658) and warns against treating the Job Object as hang detection (L873).
Claim: A hung runtime on Windows is never detected. The heartbeat exists only on Linux and macOS, and the Job Object acts only when the host dies.
Where: §10 Launch
Breaks when: The runtime's event loop stalls (an adapter parse loop, a synchronous fs call on a network share, a provider bug) while the ASP.NET host stays up. Windows sends no `runtime.ping`, and stdin EOF never happens because the host is alive.
Consequence: Every session for every principal freezes, with no fault, no restart and no log line. This happens on SkyNetHR's primary platform (brief: "The primary host is Windows").
Cost: Cheap now. The fix is contained in SDK launch code; the heartbeat method already exists in the protocol.

## F11
Severity: LOCAL
Status: defect (adjudicated 2026-09-15). Nuances: A9's third part, explicit host-supplied provider `env` (L331), lets a site pass proxy and CA variables through config, so the defect is an ungated default flip (L335) with a failure that does not name environment filtering, not an unfixable configuration. The relocated-login bullet is the weakest, since the provider-declared allowlist (L330) could carry `CLAUDE_CONFIG_DIR`/`CODEX_HOME`; A9 just does not require it. Local support for the Windows bullet: both adapters read `ComSpec` for `shell: true` spawns (`src/adapters/claude/index.ts` L29, `src/adapters/codex/index.ts` L76) and inherit the full env today (claude L475, codex L511, L704). The downstream-tool [X] claims are unverified here. v2 adds the Windows and network/TLS variables (L349–350), provider CLI-home declarations (L351), probe-gated default (L354), and diagnosing conformance tests (L355).
Claim: A9's base allowlist omits variables that vendor CLIs need to reach their APIs and find their logins, and that allowlist becomes the default in AgentConsole's first release.
Where: §5 A9; §10 Launch
Breaks when: The CLI needs any of these, none of which is in the base list:
- **Proxy and TLS inspection:** `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`.
- **Relocated login:** `CLAUDE_CONFIG_DIR` or `CODEX_HOME` [X].
- **Windows shell basics:** `ComSpec`, `ProgramFiles`, `ProgramData`, `USERNAME`, `WINDIR`, which child tools that shell out rely on [X].

The provider-declared allowlist is per provider and cannot know a site's proxy or CA requirements.
Consequence: After the upgrade every turn fails with a vendor network or authentication error that says nothing about environment filtering. The operator sees the CLI as "logged out".
Cost: Cheap now. Contained in ProcessSupervisor.

## F12
Severity: LOCAL
Status: defect (adjudicated 2026-09-15). Context: the failure is new with the extraction. SkyNetHR sends attachments base64-inline in the `/message` body (`src/edge/http-common/index.ts` L219–226, L402–417), capped by `CAPS_ATTACHMENT_BYTES` and `CAPS_ATTACHMENT_COUNT` (`src/config/index.ts` L242–245) and rolled back per turn (`removeAttachments`, `src/store/index.ts` L875), so no partial-upload state exists today. Nuances: the 20 MiB figure exceeds SkyNetHR's 10 MiB default cap but is immaterial, since any file over 256 KiB is multi-chunk; A2 does not say whether `turns.send` takes attachment ids, which is part of the defect; §12 does not say whether the bridge buffers before chunking, so an SDK or host dying mid-sequence is an equivalent path. v2 adds begin/write/commit/abort with declared size (L297–302), partial caps, expiry and committed-ids-only `turns.send` (L303, L758–759), and a §15 warning (L871).
Claim: Chunked `attachments.add` (A2) has no upload lifecycle: no upload identity, commit step, declared size or expiry. Abandoned uploads leave partial attachments that no operator action can find or remove.
Where: §5 A2; §9 NDJSON "Binary data"; §12 Attachments
Breaks when: A phone browser uploads a 20 MiB file as 80 chunks of 256 KiB, and the tab is backgrounded at chunk 37 (§12 notes that background tabs drop connections). No operation defines resume, abort or completeness, and `turns.send` referencing an attachment whose last chunk never arrived has no defined error. Tool output has a per-session byte cap (D162, `src/store/index.ts` L778-785), but no cap is stated for partial attachments.
Consequence: Partial files accumulate in session storage without limit, and a turn may hand the agent a truncated file.
Cost: Cheap now. Expensive once both SDKs implement a chunk protocol without these fields.

## F13
Severity: LOCAL
Status: defect (adjudicated 2026-09-15). Location: §8 L516, §10 L612–614 and L619. Nuances: "pulls all of them in anyway" overstates the contradiction, since nuget.org's 250 MB limit is per package and the split still meets L615's stated purpose; "six executables on every Windows build" holds only for RID-less builds (L619), because a RID-specific build copies one folder and restore unpacks into the global cache once. That restore downloads every referenced RID package is [X], unverified here, and accepted by the amending vendor in v2 L647. v2 corrects §10 (L647, L654, L663, L859) but leaves §8 L548 unchanged, which is v2 F5.
Claim: The meta package references every `Runtime.<rid>` package. Every consumer therefore restores all six Node binaries whatever their target, and RID-less builds copy all six into `bin/`.
Where: §8 "Versioning rule"; §10 Packages and Resolution
Breaks when: Any `dotnet restore` of `SubZeroDev.AgentConsole`. Six official Node binaries at roughly 80–120 MB each [X] come to about 0.5–0.7 GB per restore and per RID-less publish. §10 splits the packages to stay under nuget.org's 250 MB limit, then pulls all of them in anyway.
Consequence: Bloated CI caches and container images. Deployment size limits on App Service zip deploy may be exceeded [X]. Antivirus scans six executables on every Windows build.
Cost: Cheap now, since it is only the package graph. Expensive once consumers depend on the meta package's shape.

## F14
Severity: LOCAL
Status: unadjudicated
Claim: L2's evidence is false: `callId` and `turnId` are already validated before becoming path segments. A21's opaque-id storage change is justified by that false finding.
Where: §3 L2; §5 A21; §15 "external identifier as a filesystem path segment" warning
Breaks when: Read against the tree. `isSafePathSegment` (`src/store/index.ts` L70-80) rejects empty names, `.` and `..`, `/`, `\`, NUL, and anything that is not its own basename. It is applied in `writeToolOutput` (L775) and `openToolOutput` (L799). L2 says "A grep of `src/` found no `callId` pattern check." What the check does not cover, not tested in this pass [I]: Windows device names (`CON`, `NUL`) and `name:stream` alternate data stream syntax.
Consequence: A layout change with a migration cost (F8) is adopted as the fix for a defect that does not exist as described, and the adjudicator weighs A21 against a risk that is mis-stated.
Cost: Cheap now, as an evidence correction. Expensive if A21 ships on this basis.

## F15
Severity: LOCAL
Status: unadjudicated
Claim: A13's suggested ASP.NET retry window (10 s lease + 2 s) is shorter than an overlapped-recycle drain held open by the console's own long-lived connections, so the new worker's runtime fails to start on every recycle.
Where: §5 A13; §10 "Overlapped recycle vs the lease"; §3 H9
Breaks when: IIS does an overlapped recycle while SSE or WebSocket consoles are attached. The old worker keeps serving those connections until they close or `shutdownTimeLimit` expires (default 90 s [X]), and its runtime keeps renewing the lease every 2 s (`src/store/index.ts` L40, L944-1003). The new worker's hosted service retries for 12 s, gets `storage_locked`, and fails `StartAsync`.
Consequence: Every app pool recycle (default every 29 h [X]) takes the console down until the old worker exits and the pool is restarted. Operators see disconnects, then 503s.
Cost: Cheap now. It is host integration policy.

## F16
Severity: LOCAL
Status: unadjudicated
Claim: Step 6 says the in-process cutover keeps the "same lease", which contradicts A13, Phase 3b and §15, all of which require separate runtime and HR leases.
Where: §13 step 6 vs §13 Phase 3b, §5 A13, §15 lease warning
Breaks when: An implementer carries out step 6 as written after Phase 3b has split the storage roots.
Consequence: One of two outcomes. The runtime root runs with no lease of its own inside SkyNetHR's process, so a second SkyNetHR instance can write that root unguarded. Or Phase 3b's split is undone.
Cost: Cheap now; the fix is one sentence. Expensive if the lease topology is carried into the child-process cutover.

## F17
Severity: LOCAL
Status: unadjudicated
Claim: The v1 runtime ships two capabilities that SkyNetHR's brief excludes, inside the process SkyNetHR migrates onto: secret resolution for vendor credentials (A17, "from v1"), and runtime-held conversation state (§11, `conversationState: 'runtime'`).
Where: §5 A9, A17; §11 OpenAI/Anthropic API; §13 step 12
Breaks when: SkyNetHR runs on the runtime (step 6). The brief's non-goals say "No inference happens here and no vendor credential is held", and that the CLI owns conversation state, which "we render and replay; we do not reconstruct". Against that, A17 makes secret resolution a v1 callback path, A9 routes API credentials through the runtime, and §11 adds runtime-held history to `SessionStore`.
Consequence: SkyNetHR's deployed process contains a credential-holding path and a history store that its brief says do not exist. A misconfigured `anthropic` provider silently makes SkyNetHR a credential holder, which is H1's own billing-switch scenario.
Cost: Cheap now, since it is placement and packaging. Expensive once the v1 SDKs expose the callback.
