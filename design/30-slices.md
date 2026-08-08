# Slices — SkyNet HR

Derived from `10-design.md` and `20-contract.md`. Each slice ends runnable. Criteria carry
stable ids; drift is compared on ids, never prose.

**This supersedes the pre-contract slice set.** The previous version was written before
`20-contract.md` existed and asserted things the contract has since removed — a
`session.exit` event (retired by D45), a tool-output fetch keyed on `callId` alone (retired
by D22), and `scope: 'always'` forwarding the vendor's own suggestion (retired by D35). Its
ids are not carried forward. No GitHub issue exists yet, so no checkbox refers to any of
them; `/track` has not run.

Four ids are cited from other documents and are deliberately preserved against the same
topics: **S3.3** (replay gap, cited by D40 and `90-decisions.md § Open`), **S6.5** (restore
refused during a turn, cited by `10-design.md § The single-writer invariant`), and **S8.1**
(the Codex experiment, cited by `10-design.md § Identity spaces`, § Open questions 6, and
`90-decisions.md § Open`).

## Ordering, and why

`10-design.md § What we add` names the three things that dictate structure — ownership, the
jail, and a monotonic `seq` on every event from day one. All three land in S1 and S2, before
surface area grows around them. The dangerous intermediate state — a console reachable
off-box with no auth — is never reachable, because S2 refuses to bind a routable interface
without an auth mode from its first commit.

The design's riskiest bets, and where each is exercised:

| Bet | Exercised |
|---|---|
| The Claude CLI can be driven over stdio with stdin held open across a permission round trip | S1 (the wire, auto-denied), S4 (the feature) |
| The ring buffer is a strict suffix of the spill, so replay can be served from either | S3 |
| A child's whole process tree can be terminated on Windows and on Linux | S5, and S7 reuses the same mechanism |
| Codex exposes a live stream resembling its rollout schema | S8.1 |

S8 sits eighth because everything after S8.1 needs the adapter interface and the policy
banner to exist. **S8.1 itself needs neither and is cheap — run it early, out of order, and
report.** A negative answer is already absorbed by D5, so this is bounded risk rather than
deferred risk.

`spike/` covers parts of S1 and S2 as throwaway proof. It is not the implementation; see
`spike/README.md § What this is not`. `spike/.data` is deleted rather than migrated
(`20-contract.md § Migration`).

---

## S1 — Drive Claude from the server, and keep what it said

Delivers: Someone with a terminal on the machine holding the code can point the tool at a
project folder, send the agent one message, and get back a complete, ordered record of
everything the agent did — saved to disk so it survives the run. It also refuses, out loud,
to start against a folder outside the areas the deployment allows.

Touches: `contract`, `config`, `jail`, `store` (`meta.json`, `events.ndjson`),
`adapters/claude`, `session-manager`, plus a throwaway CLI harness that is not shipped.

Depends on: none.

Acceptance:
  - S1.1 `claude` is spawned with `--output-format stream-json --input-format stream-json
    --verbose --permission-prompt-tool stdio`, and stdin is still writable when the child
    emits `control_request` — asserted by writing a `control_response` to it and observing
    the turn continue to `result`.
  - S1.2 The NDJSON splitter, fed a recorded fixture one byte at a time, produces an event
    sequence identical to the same fixture fed whole. Both a `\n`-split mid-object and a
    chunk boundary inside a multi-byte UTF-8 character are in the fixture.
  - S1.3 Every row of `20-contract.md § Vendor mapping — Claude` produces its normalised
    event against a recorded fixture. The table has twelve rows; the test asserts twelve
    mappings and the count is stated in the slice report.
  - S1.4 An unrecognised record kind yields `error / adapter_unknown_record`, non-fatal,
    with the original record preserved in `raw`; a malformed JSON line yields
    `error / adapter_bad_line`, non-fatal. In both cases the following records still map.
  - S1.5 `seq` starts at 1 and is contiguous with no gaps over a fixture of at least 200
    envelopes, and is assigned only by `session-manager` — the adapter's
    `AdapterNotification` payloads carry no `seq`, no `sessionId` and no `ts`.
  - S1.6 A `cwd` outside every configured root is refused with
    `JailError.outside_workspace_root` naming the roots. Cases: `..` traversal, a symlink
    whose target is outside, and on Windows both a case variation and an 8.3 short name.
  - S1.7 The resolved real path, not the caller's string, is what the child runs in —
    asserted from the child's own reported working directory, not from reading the calling
    code.
  - S1.8 `meta.json` is written by temp-file-then-atomic-rename at create and not again
    during the run; `events.ndjson` holds one parseable `Envelope` per line with `seq`
    ascending contiguously from 1.
  - S1.9 A prompt that provokes a tool call produces `permission.request` carrying the exact
    tool input as the CLI sent it. The harness auto-denies, and the turn still reaches
    `turn.ended`.
  - S1.10 No vendor string above the adapter layer: a search of `config`, `jail`, `store`,
    `session-manager` and `contract` sources for the literals `claude` and `codex` returns
    only the `Vendor` type declaration and the pass-through argument to `createAdapter`
    (I20).

Out of scope: HTTP, the browser, identity resolution, answering a permission
interactively, checkpoints, the audit log, interrupt, replay, truncation, Codex.

## S2 — The browser console

Delivers: An operator opens a page in their browser, is recognised by whatever already
authenticates them, picks a project folder and Claude, types a message, and watches the
agent work as it happens — seeing their own sessions and nobody else's.

Touches: `identity`, `edge/sse`, `client`, `config` (bind, auth, `allowedOrigins`,
`trustProxy`), `session-manager` (`create`, `list`, `get`, `message`, `subscribe`).

Depends on: S1.

Acceptance:
  - S2.1 `POST /api/sessions` returns `201 { sessionId }`, and its refusals carry the exact
    codes in `20-contract.md § HTTP routes`: `409 outside_workspace_root`,
    `422 bad_request`, `503 agent_unavailable`.
  - S2.2 `POST /api/sessions/:id/message` returns `202 { turnId }`; a second message while a
    turn is running returns `409 turn_in_flight`.
  - S2.3 `GET /api/sessions/:id/events` is `text/event-stream`, one envelope per message,
    `id:` set to `seq` and `event:` set to `kind`.
  - S2.4 Proxy-header mode resolves an `OperatorId` from the configured header, and rejects
    that header with `401 unauthenticated` when the peer address is not in `trustProxy`,
    logging the address.
  - S2.5 Shared-secret mode authenticates from its cookie; a wrong secret is
    `401 unauthenticated`. The cookie is set `SameSite=Strict; HttpOnly; Path=/`.
  - S2.6 Every `/api/sessions/:id` route implemented in this slice returns
    `404 no_such_session` — never `403` — for a session owned by another operator.
  - S2.7 `GET /api/sessions` returns only the caller's sessions.
  - S2.8 The server refuses to start when it would bind a non-loopback interface with no
    auth mode configured: `ConfigError.insecure_bind`, a message naming the fix, and a
    non-zero exit. Not a warning.
  - S2.9 A `POST` whose `Origin` is not in `allowedOrigins` returns `403 bad_origin`, and
    does so **before identity is resolved** — asserted by an unauthenticated request with a
    disallowed origin returning `403`, not `401` (I24).
  - S2.10 A `: keepalive` comment is sent every `caps.keepaliveMs`, and an idle stream
    survives at least three intervals through a reverse proxy.
  - S2.11 The client renders `message`, `thinking` and `tool.call` from normalised events
    only; a search of client sources for `claude` and `codex` returns nothing.
  - S2.12 The document is served with exactly the CSP in `10-design.md § Security controls`;
    the built client contains no inline script or style; a tool name or message text
    containing `<img src=x onerror=alert(1)>` renders as literal characters and executes
    nothing (I26).
  - S2.13 The negative authentication cases are each rejected and the counts stated in the
    slice report: no identity, a forged header from a peer outside `trustProxy`, a wrong
    shared secret, and a disallowed origin.

Out of scope: the WebSocket edge (S11), the permission prompt (S4), reconnect and replay
(S3), checkpoints, interrupt, mobile layout beyond not breaking,
`--include-partial-messages` and `message.delta` (carried in `90-decisions.md § Open`).

## S3 — Close the laptop, open the phone

Delivers: An operator can lose their connection in the middle of a run — close the laptop,
walk away, reopen the console on a phone — and find every message, tool call and prompt that
happened while they were gone, in order, with nothing missing and nothing shown twice. The
agent keeps working the whole time.

Touches: `store` (`readEventsAfter`, `readLastSeq`, ring buffer), `session-manager`
(`subscribe`, replay), `edge/sse` (`Last-Event-ID`), `config` (`caps.ringCapacity`,
`caps.subscriberQueueHighWater`).

Depends on: S1, S2.

Acceptance:
  - S3.1 Reconnecting with `Last-Event-ID: N` delivers `N+1` onward and nothing else. The
    pre- and post-reconnect envelope sequences, concatenated, equal a single uninterrupted
    run of the same fixture element for element.
  - S3.2 A `Last-Event-ID` older than `caps.ringCapacity` is served from `events.ndjson`
    for a **live** session mid-turn, with no `replay_gap` — asserted with `ringCapacity` set
    to 10 against a turn emitting at least 100 envelopes (D40).
  - S3.3 `error / replay_gap` is emitted **only** where the spill cannot serve the range.
    A healthy spill never produces one; a truncated or unwritable spill produces exactly
    one, after which the client refetches.
  - S3.4 The same spill-served replay works for a session in state `ended`.
  - S3.5 The ring buffer is a strict suffix of the spill: over a run of at least 500
    envelopes with `ringCapacity` 100, the ring's contents equal the spill's last 100 lines,
    envelope for envelope (I2).
  - S3.6 A torn trailing line in `events.ndjson` is dropped and logged, the preceding lines
    are served, and the file is not modified by the read.
  - S3.7 A subscriber past `caps.subscriberQueueHighWater` is dropped with a gap reported to
    that subscriber alone; other subscribers on the same session receive every envelope of
    the run.
  - S3.8 A disconnected client does not reach the child: the emitted `seq` range and the
    envelope sequence across a disconnect are identical to the same run with no disconnect.

Out of scope: an offset index for the spill (carried in `90-decisions.md § Open`); the
WebSocket reconnect path (S11); truncation of large results (S9).

## S4 — Ask before you run it, and write down who said yes

Delivers: When the agent wants to run a command, the operator is asked — in the browser,
wherever they are — and sees exactly what will run before allowing or denying it. Every
answer is written to a permanent record of who approved what and when, and that record is
safely on disk before the agent is told it may proceed.

Touches: `session-manager` (`answerPermission`, the `pending` map, decision ordering),
`store` (`appendAudit`, fsync), `adapters/claude` (`respond`), `edge/sse`
(`POST /:id/permission`), `client` (the prompt).

Depends on: S1, S2.

Acceptance:
  - S4.1 `control_request / can_use_tool` becomes `permission.request` carrying the tool
    input exactly as the CLI sent it — object-equal to the fixture record, never a summary
    and never truncated.
  - S4.2 Allow and deny each round-trip to a real `claude` child and the agent proceeds
    accordingly, demonstrated on one real tool call run both ways, with the child's
    subsequent output recorded for each.
  - S4.3 Every `permission.request` is followed by exactly one `permission.resolved` with
    the same `requestId`, before or at `turn.ended`, over a run containing at least three
    requests (I9).
  - S4.4 A second client answering an already-resolved request receives
    `200 { accepted: false }` — not an error — and no second `control_response` is written
    to the child's stdin, asserted by counting stdin writes.
  - S4.5 The `pending` delete is synchronous with the lookup and precedes the audit append:
    two answers dispatched in the same tick produce exactly one audit record and exactly one
    stdin write (D33).
  - S4.6 The `AuditRecord` is fsync'd before the `control_response` reaches stdin, asserted
    by a store double recording call order (I10), and the appended line carries all ten
    fields of `20-contract.md § Audit record`.
  - S4.7 An audit append failure denies: `control_response { behavior: 'deny' }`,
    `permission.resolved { decision: 'deny', reason: 'audit_unavailable' }`, and
    `session.notice / error` with code `audit_unavailable`. The turn continues and no tool
    runs. Asserted with an injected write failure.
  - S4.8 `AuditRecord.input` equals the `PermissionRequest.input` shown to the operator, key
    for key and value for value, with `caps.toolResultBytes` not applied to it (I12).
  - S4.9 A child that dies with requests outstanding produces one
    `permission.resolved { reason: 'cancelled_process_exit' }` per outstanding request, then
    `turn.ended { stopReason: 'process_exit' }`.
  - S4.10 `audit.ndjson` is server-wide and append-only: a run across two sessions writes
    both sets of records to one file in append order, and no code path in this slice
    rewrites, truncates, or reorders it (I13).
  - S4.11 The browser prompt displays the exact input and cannot render it as markup — an
    input containing HTML appears as text.
  - S4.12 `scope: 'always'` is refused with `422 bad_request` naming the field, until S10
    ships a grammar. `rule` is likewise rejected when present.

Out of scope: standing rules and `scope: 'always'` (S10, blocked on open question 8);
forwarding `updatedPermissions` to the CLI (D35 rejects it); Codex permissions (S8);
per-operator vendor authorisation (there is no operator record to hold one, D50).

## S5 — Stop it, close it, remove it

Delivers: An operator who has seen enough can stop the agent mid-run without losing the
session; can close a session down when they are finished so the project folder is free for
somebody else; and can remove a session they no longer want — with the record of what was
approved kept either way.

Touches: `session-manager` (`interrupt`, `end`, `remove`, the workspace claim),
`adapters/*` (`kill`), `store` (`deleteSession`, `writeMeta`), `edge/sse` routes, `client`.

Depends on: S1, S2, S4.

Acceptance:
  - S5.1 `POST /:id/interrupt { turnId }` kills the turn's child and emits
    `turn.ended { stopReason: 'interrupted' }`. The session stays `live` with no turn, and
    the client presents it as an expected end, not an error.
  - S5.2 Interrupt terminates the **tree**: a turn whose agent spawned a long-running
    grandchild leaves no live descendant five seconds after the route returns, asserted by
    process enumeration on both Windows and Linux (D38).
  - S5.3 An interrupt whose `turnId` does not name the live turn, or that arrives when there
    is no live turn, returns `200 { ok: true }` and emits nothing.
  - S5.4 Every outstanding permission resolves `cancelled_process_exit` on interrupt.
  - S5.5 `POST /:id/end` sets `state: 'ended'` and `endedAt`, emits
    `session.ended { reason: 'operator' }`, and rewrites `meta.json` by atomic rename. A
    subsequent message returns `409 session_ended` (D36).
  - S5.6 Ending frees the workspace: a create on the same path refused `409 workspace_busy`
    before the end succeeds after it.
  - S5.7 The busy check tests overlap, not equality — a create at a parent of, a child of,
    and a differently spelled version of a live session's `cwd` (case, trailing separator,
    and on Windows an 8.3 short name) is each refused `409 workspace_busy` naming the
    holding path and operator (I6, D30).
  - S5.8 A guard is claimed in the same synchronous block that tests it: two
    `POST /api/sessions` for one path dispatched in the same tick yield exactly one `201`
    and one `409 workspace_busy`; two `POST /message` on one session yield exactly one `202`
    and one `409 turn_in_flight` (I5, D32).
  - S5.9 `DELETE /api/sessions/:id` removes `meta.json`, `events.ndjson`, `tool-output/`
    and the registry entry, and leaves `audit.ndjson` byte-identical (D25).
  - S5.10 `end` and `delete` during a turn are both `409 turn_in_flight`; `interrupt` is the
    one operation that is allowed during a turn.
  - S5.11 A delete that fails part-way still removes the registry entry, emits
    `error / session_delete_incomplete` non-fatal, and names the paths left on disk.

Out of scope: destroying `ckpt.git` on delete (added in S6.10, which is where checkpoints
first exist); an idle auto-end (D36 rejects it, and D21 removed server-side timers); a soft
delete or tombstoned `meta.json` (D25 rejects both).

## S6 — Put the folder back

Delivers: An operator who does not like what the agent did can return the project folder to
the way it was before any earlier message — including removing files the agent created —
without touching their own version control and without having to reinstall dependencies.

Touches: `checkpoints`, `session-manager` (`listCheckpoints`, `restore`, the turn guard),
`edge/sse` routes, `client`.

Depends on: S1, S2, S5.

Acceptance:
  - S6.1 A shadow `GIT_DIR` is created at `<storage>/sessions/<id>/ckpt.git` with the
    session's `cwd` as work-tree, and the workspace's own `.git`, where one exists, reports
    an identical `HEAD` and an identical `git status --porcelain` before and after a full
    session.
  - S6.2 A checkpoint is committed before each turn, appears in
    `GET /api/sessions/:id/checkpoints`, and its `checkpoint.created` precedes that turn's
    `turn.started` in `seq` order (I15).
  - S6.3 Restore returns the workspace to the target state exactly: a file the agent
    modified is reverted **and** a file the agent created after the target is gone. Asserted
    by comparing a recursive hash of the tree against the same hash taken before the turn
    (D31).
  - S6.4 Restore commits a safety checkpoint first; it appears in the checkpoint list, and
    restoring it returns the workspace to the pre-restore state.
  - S6.5 A restore requested while a turn is in flight is refused `409 turn_in_flight`, and
    an unknown `sha` is `404 no_such_checkpoint`, with the workspace untouched in both
    cases.
  - S6.6 Paths ignored by the workspace's own `.gitignore` are neither checkpointed nor
    removed: a `node_modules/` directory present before a restore is present and unchanged
    after it.
  - S6.7 A workspace that is not a git repository checkpoints and restores normally, and
    acquires no `.git` of its own.
  - S6.8 A `ckpt.git` that cannot be initialised yields `session.notice / warn` with code
    `checkpoints_unavailable`; the session is created and usable without checkpoints.
  - S6.9 A pre-turn checkpoint that fails yields `session.notice / warn` with code
    `checkpoint_skipped`, naming `ckpt.git/index.lock` where that is the cause, and **the
    turn proceeds** with no restore point. Asserted by planting an `index.lock` (D42).
  - S6.10 `DELETE /api/sessions/:id` now also removes `ckpt.git/`.
  - S6.11 A restore that fails part-way emits `error / checkpoint_restore_failed`,
    non-fatal, and returns `500 checkpoint_failed`; the safety checkpoint from S6.4 still
    names the pre-restore state.

Out of scope: restoring a workspace held by another session (S5.7 makes it impossible);
pathspec-scoped per-session checkpoints (D30 rejects them); a confirmation dialog — D31's
safety checkpoint is what makes one unnecessary.

## S7 — Survive a restart

Delivers: An operator whose server restarted — deliberately or by a crash — still finds
every session they were working in, can read the whole transcript and roll the folder back,
and is told plainly that those sessions cannot be continued. No agent process is left
running behind their back, and no innocent process is killed tidying up.

Touches: `session-manager` (`boot`), `store` (`readAllMeta`, `readLastSeq`, `appendPid`,
`tombstonePid`, `readOpenPids`), `config`.

Depends on: S1, S5, S6.

Acceptance:
  - S7.1 Boot runs reap → rehydrate → close open turns → listen in that order, and no
    connection is accepted until all three have completed — asserted by issuing a request
    during a deliberately slowed rehydration and observing a connection refusal rather than
    a partial session list (I18).
  - S7.2 Every rehydrated session is `state: 'ended'` with `endedAt` set; a message to one
    returns `409 session_ended` and the client disables the compose box (D20).
  - S7.3 `lastSeq` is derived from the spill's tail, not read from `meta.json` — asserted by
    writing a deliberately wrong `lastSeq` into `meta.json` and confirming the next emitted
    `seq` follows the spill (I17, D37).
  - S7.4 A spill ending on an unpaired `turn.started` is closed on disk at boot: one
    `permission.resolved { reason: 'cancelled_process_exit' }` per outstanding request, then
    `turn.ended { stopReason: 'server_restart' }`, appended at the next `seq` and durable
    before listening (I14, D39).
  - S7.5 A `ProcessRecord` with no `exitedAt`, a `startedAt` later than the host's last boot
    and a matching process image is reaped — killing the tree — and its entry is tombstoned.
  - S7.6 A record failing any one of those three tests is **not** killed: it is logged and
    tombstoned. Asserted with a record naming a live process of a different image, which is
    still running afterwards (I19).
  - S7.7 A `meta.json` that fails to parse, or carries an unknown `schemaVersion`, causes
    that session to be skipped and logged with its files untouched, and boot continues to
    serve every other session.
  - S7.8 A rehydrated session does not hold its workspace: a new session on the same path is
    created successfully after a restart.
  - S7.9 `pids.ndjson` gains one line per spawn and one tombstone line per exit; where a pid
    appears more than once, the latest line wins.
  - S7.10 A storage root that cannot be written at boot causes a refusal to start with
    `StartupError.storage_unwritable` and a non-zero exit.

Out of scope: resuming a rehydrated session with `--resume` (D20 rejects it — it fails
silently, which is the worst way to fail); a lock file preventing two servers over one
storage root (carried in `90-decisions.md § Open`); closing the spawn-to-append window with
a Windows Job Object (D23 rejects the dependency).

## S8 — Codex, honestly

**This slice opens as an experiment, not an implementation.** `20-contract.md § Vendor
mapping — Codex` is a hypothesis drawn from an on-disk rollout schema, not from an observed
live stream. Stop and report before building against it.

Delivers: An operator can choose Codex when starting a session and finds out immediately
where they stand — either it works and they are told which sandbox the agent is confined to,
for as long as the session lasts, or the console refuses to start and says exactly why. What
it never does is show a blank screen that looks like the agent thinking.

Touches: `adapters/codex`, `client` (the standing banner), `session-manager` (policy at
create). A correction to `20-contract.md § Vendor mapping — Codex` is a prerequisite, not a
part of this slice — see S8.2.

Depends on: S1, S2.

Acceptance:
  - S8.1 A written report, committed before any mapping code, answering: does the Codex CLI
    expose a live streaming mode at all; what records does it emit; do they match the rollout
    schema; are its `callId`s unique within a session or only within a turn; and is
    `approval_policy = "on-request"` reachable over a programmatic stream. Each answer cites
    the command run and its observed output.
  - S8.2 `20-contract.md § Vendor mapping — Codex` is corrected to match observation, and
    its three unknown rows are filled. That edit is a contract amendment and belongs to
    `/contract` at its own tier; this slice stops until it lands and may not guess.
  - S8.3 A Codex session reports
    `policy { mode: 'preauthorised', sandbox: <the mode chosen>, banner: <naming it> }`, and
    the client shows a standing banner naming that sandbox for the life of the session,
    including after a reload and after a replay from the spill.
  - S8.4 A Codex session emits zero `permission.request` events across a full turn, and the
    client renders that as a normal state rather than a stalled turn (I25).
  - S8.5 A stream not matching the corrected table yields `AdapterError.schema_mismatch`,
    an `error / adapter_schema_mismatch` with `fatal: true`, and a refusal to start the
    session. Asserted by feeding a deliberately wrong fixture.
  - S8.6 If S8.1 finds no live stream, the slice **stops here**: no rollout-file scraping and
    no fallback. The finding is written up, the remaining criteria are recorded as blocked
    rather than failed, and the decision about what to do instead is `/design`'s.
  - S8.7 If S8.1 finds `callId`s unique only within a turn, the slice stops before
    implementing tool correlation and says so — open question 7's correlation half needs a
    server-side alias, which is a design decision, not an adapter one.

Out of scope: making Codex match Claude's interactive model (D5 lets it under-deliver,
visibly); scraping `~/.codex/sessions/**/rollout-*.jsonl`; revisiting D5 inside this slice —
a reachable `on-request` prompt is reported, not acted on.

## S9 — Big outputs and slow clients

Delivers: An operator can run something that prints an enormous amount — a full test suite,
a repository-wide search — and the console stays usable, showing a trimmed view with the
whole output one click away, rather than freezing the browser or quietly losing the record.

Touches: `session-manager` (truncation), `store` (`writeToolOutput`, `openToolOutput`, the
ring), `edge/sse` (the tool-output route), `client`, `config` (`caps`).

Depends on: S1, S2, S3.

Acceptance:
  - S9.1 A `tool.result` above `caps.toolResultBytes` is truncated **before its envelope is
    constructed**: `truncated: true`, `bytes` carrying the pre-truncation size, and the
    envelope in the ring byte-identical to the line in the spill (I3, D22).
  - S9.2 The untruncated bytes are written to
    `<storage>/sessions/<id>/tool-output/<turnId>/<callId>` and fetchable at
    `GET /api/sessions/:id/tool-output/:turnId/:callId`, both path segments taken from the
    same envelope.
  - S9.3 That route serves `text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`
    and `Content-Disposition: attachment`, and applies the ownership check — another
    operator receives `404 no_such_session` (I23, D43).
  - S9.4 No blob is addressable by `callId` alone: two turns in one session emitting the
    same `callId` produce two distinct files, and each envelope's link fetches its own
    turn's bytes (I22).
  - S9.5 A missing or unreadable blob returns `404 no_such_output`, and the truncated
    envelope is unaffected.
  - S9.6 A turn emitting 50 MB across tool results keeps every browser main-thread task
    under 200 ms; the measured figures are recorded in the slice report — longest task,
    peak DOM node count, and peak renderer memory.
  - S9.7 Over a session of at least 50 000 envelopes the ring never exceeds
    `caps.ringCapacity` and server peak RSS is stated in the slice report.
  - S9.8 A spill append failure ends the session: the live turn ends
    `stopReason: 'storage_failure'`, `session.ended { reason: 'storage_failure' }` and
    `session.notice / error` with code `storage_failure` are emitted, and no envelope
    reaches the ring that the spill does not hold (D41).

Out of scope: a retention rule for tool-output blobs (carried in
`90-decisions.md § Open` — they are the one store that grows with tool volume rather than
session count); an offset index for the spill; virtualised scrollback beyond whatever S9.6
requires.

## S10 — Stop asking me about this one

**Blocked on open question 8.** D35 made the grammar this slice needs a prerequisite rather
than a nice-to-know, because the matching now happens in this server rather than in the CLI.

Delivers: An operator who has approved the same kind of command five times can say "always
allow this" once and stop being asked — while every one of those automatic approvals still
appears in the record of who let the agent do what.

Touches: `session-manager` (the standing-rule store and matcher), `store` (`appendAudit`),
`client` (the scope control). A `StandingRuleExpression` grammar and a `match` signature in
`20-contract.md` are a prerequisite, not a part of this slice — see S10.2.

Depends on: S4.

Acceptance:
  - S10.1 A written finding, committed before any matching code, on whether
    `permission_suggestions` from the Claude CLI is a sufficient grammar, citing observed
    `suggestions` payloads from a real run. Where it is not sufficient, the proposed local
    grammar is stated and the slice stops for a decision — a grammar is not invented and
    shipped in the same slice.
  - S10.2 `StandingRuleExpression` gains a defined shape and a `match(rule, request)`
    signature in `20-contract.md`. That is a contract amendment at `/contract`'s tier; this
    slice may not introduce a signature the contract does not carry.
  - S10.3 `POST /:id/permission { scope: 'always', rule }` is accepted, the rule is held in
    this server's session state, and `updatedPermissions` is never written to the child's
    stdin — asserted by inspecting every line written to it (D35).
  - S10.4 A later request matching a held rule is auto-answered by the server and still
    emits a full `permission.request` / `permission.resolved` pair with `scope: 'standing'`,
    `reason: 'preapproved'` and `operator: null`, and appends an audit record — every time,
    asserted over at least five matches (I11).
  - S10.5 A standing rule does not outlive its session: a new session on the same workspace,
    started by a different operator, is asked again.
  - S10.6 `scope: 'always'` with no `rule` returns `422 bad_request` naming the field, and
    S4.12's blanket refusal of `always` is removed in the same change.

Out of scope: standing rules that persist across sessions or attach to an operator (there is
no operator record, D3); a revocation UI beyond ending the session; forwarding the grant to
the CLI (D35 rejects it, and it is the whole reason this slice exists).

## S11 — The WebSocket edge

Delivers: An operator whose network sits behind something that mangles long-lived HTTP
streams gets the same console over a WebSocket instead — the same events, in the same order,
selected by configuration, with no change to how the page is used.

Touches: `edge/ws`, `config`, `client` (transport selection).

Depends on: S2, S3.

Acceptance:
  - S11.1 For one fixture run, the envelope sequence received over the WebSocket edge equals
    the sequence received over the SSE edge, element for element.
  - S11.2 The origin allow-list is applied at the handshake, before any frame is read — a
    handshake carrying a disallowed `Origin` is refused and no connection is established
    (I24).
  - S11.3 First-message auth resolves the same `OperatorId` as the SSE edge from the same
    credentials, and every ownership refusal is `no_such_session`.
  - S11.4 A reconnect supplying an `after` seq behaves exactly as `Last-Event-ID` does on the
    SSE edge, including the spill-served case of S3.2 and the gap case of S3.3.
  - S11.5 The edge is chosen by configuration; exactly one edge binds at a time, and the
    client learns which from the served page rather than by probing.

Out of scope: replacing SSE; running both edges simultaneously; a WebSocket-specific event
shape — the envelope is the same one.

---

## What no slice covers

Stated so it is a decision rather than an omission. Each is carried in
`90-decisions.md § Open`; `/track` is what turns them into issues.

- **Token-level streaming.** Whether `--include-partial-messages` yields usable deltas, and
  whether `message.delta` survives contact with it. Cheap to test, changes the renderer.
- **A retention rule for tool-output blobs** (open question 2).
- **A lock file preventing two server processes over one storage root** (open question 3).
- **An offset index for the spill** (open question 11).
- **Attachments on `POST /message`** — undesigned, and out of the contract until a design
  decision puts them back (D47).
- **Who renders `ToolCall.summary`** — unowned between the adapter and the manager.
- **`Start-AgentSession.ps1`** (D14), unreconciled against this architecture.

Next: run `/track` in a fresh session to open the issues and the milestone for this set.
`/slices` does not write to GitHub.
