# Red team — agentconsole-redteam-amended.md

Target: D:/Downloads/agentconsole-redteam-amended.md @ sha256:9e63897708fa95e9a82f777d8efb892e85115667038faa5ceb9222ca8d47446f (not in repo; evidence read at SkyNetHR eca7b2c)
Vendor: Anthropic
Model: claude-opus-5, effort not reported
Date: 2026-09-14
Note: This session wrote the base review. Another vendor made the amendments. The pass was run on the user's instruction.

## F1
Severity: BLOCKING
Status: unadjudicated
Claim: Workspace concurrency (A11) has no serialization domain. A22's lanes are per session, and A5 moves `records.claim` into an async `host.beforeCreate` round trip that sits inside the window between the busy check and the claim.
Where: §5 A5, A11, A22; §6 row "Workspace jail … I6"; §13 Phase 4 gate
Breaks when: SkyNetHR sets `maxLiveSessionsPerWorkspace: 1`, and two operators call `sessions.create` with cwd `D:/src/app` and `D:/src/app/web` within one `host.beforeCreate` round trip (one pipe round trip plus the host handler). Neither session exists yet, so no per-session lane covers either request. Both see zero live sessions, both await the callback, and both proceed. Today, I5 forbids any `await` between `findLiveOverlap` and `sessions.set` (`src/session-manager/index.ts` L1005-1069), and `records.claim` is synchronous by contract (L1013-1019). A11 also counts sessions "per workspace", while today's test is `pathsOverlap` (`src/jail/index.ts` L50-52), which catches nesting in either direction; A11 never says what identity "workspace" has. Phase 3b's race tests cover only A22's per-session races. The race first becomes reachable in Phase 4's `sessions.create → host.beforeCreate` scenario.
Consequence: Two live agents write the same tree. One session's checkpoints capture the other's edits, and restoring one reverts the other's work.
Cost: Expensive later. A22 declares serialization to be protocol semantics, and where the callback sits inside `create` is fixed into both SDKs' conformance scenarios from Phase 4 on.

## F2
Severity: BLOCKING
Status: unadjudicated
Claim: A17's re-entrancy rule cannot be implemented. The runtime cannot tell a callback handler's re-entrant mutating call apart from an unrelated concurrent mutating call on the same session.
Where: §5 A5 (last bullet), A17 (last bullet), A22 (bullet 4); §9 stdio "Concurrent session operations"; §13 Phase 4 gate
Breaks when: The runtime is awaiting a host callback that holds session S's lane, for example an 800 ms records lookup. During that wait, (a) the operator clicks Stop and the bridge sends `turns.interrupt {S}`, and (b) the callback handler itself calls `events.append {S}`. Both arrive on stdin as ordinary requests with integer ids. Neither carries the `r:<n>` id of the callback, because the protocol defines no causal link, and "synchronously" has no meaning across a pipe. The runtime must therefore treat both calls the same way. If it rejects both, the operator's Stop, approve or end gets `reentrant_session_call`. If it queues both, (b) deadlocks: the callback awaits a request that is queued behind the lane the callback holds.
Consequence: Either operators get spurious errors on Stop, approve and end whenever a host callback is in flight, or the session hangs permanently. The Phase 4 gate ("rejection of same-session mutating re-entry") passes with a single caller and fails with two.
Cost: Expensive later. Callback-issued requests would need a correlation field defined in PROTOCOL.md and implemented in both SDKs.

## F3
Severity: BLOCKING
Status: unadjudicated
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
Status: unadjudicated
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
Status: unadjudicated
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
Status: unadjudicated
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
Status: unadjudicated
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
Status: unadjudicated
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
Status: unadjudicated
Claim: Session data has no retention policy, no removal path that works without the owning principal, and no pagination. Storage and boot cost grow with every principal's entire history, and sessions become unreachable when a principal mapping changes.
Where: §5 A1, A2 (`sessions.remove` is principal-scoped), A4 (`admin.*` is read-only: audit query and snapshot); §14 Q6
Breaks when:
- **The host changes its identity mapping.** For example, a proxy header switches from username to email, or an IdP migration changes `sub`. Every existing session keeps the old principal, so equality fails. `sessions.remove` requires that old principal, and `admin.*` has no list or remove.
- **Volume reaches 100× SkyNetHR's.** A multi-user host with 50 users × 20 sessions per day for a year has about 365,000 sessions. Boot reads every `meta.json` sequentially (`readAllMeta`, `src/store/index.ts` L633-661). `sessions.list` walks an in-memory map of every session with no page parameter (`src/session-manager/index.ts` L1108-1115).
Consequence: Disk fills with orphaned transcripts and tool output that no one can reach or delete short of `rm`. Runtime start time grows with retention, and list responses for a heavy user grow without bound.
Cost: Expensive later for pagination and admin removal, which are protocol surface in both SDKs. Cheap now for a retention statement.

## F10
Severity: LOCAL
Status: unadjudicated
Claim: A hung runtime on Windows is never detected. The heartbeat exists only on Linux and macOS, and the Job Object acts only when the host dies.
Where: §10 Launch
Breaks when: The runtime's event loop stalls (an adapter parse loop, a synchronous fs call on a network share, a provider bug) while the ASP.NET host stays up. Windows sends no `runtime.ping`, and stdin EOF never happens because the host is alive.
Consequence: Every session for every principal freezes, with no fault, no restart and no log line. This happens on SkyNetHR's primary platform (brief: "The primary host is Windows").
Cost: Cheap now. The fix is contained in SDK launch code; the heartbeat method already exists in the protocol.

## F11
Severity: LOCAL
Status: unadjudicated
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
Status: unadjudicated
Claim: Chunked `attachments.add` (A2) has no upload lifecycle: no upload identity, commit step, declared size or expiry. Abandoned uploads leave partial attachments that no operator action can find or remove.
Where: §5 A2; §9 NDJSON "Binary data"; §12 Attachments
Breaks when: A phone browser uploads a 20 MiB file as 80 chunks of 256 KiB, and the tab is backgrounded at chunk 37 (§12 notes that background tabs drop connections). No operation defines resume, abort or completeness, and `turns.send` referencing an attachment whose last chunk never arrived has no defined error. Tool output has a per-session byte cap (D162, `src/store/index.ts` L778-785), but no cap is stated for partial attachments.
Consequence: Partial files accumulate in session storage without limit, and a turn may hand the agent a truncated file.
Cost: Cheap now. Expensive once both SDKs implement a chunk protocol without these fields.

## F13
Severity: LOCAL
Status: unadjudicated
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
