# Slices — SkyNet HR

Derived from `10-design.md` and `20-contract.md`. Each slice ends runnable. Criteria carry
stable ids; drift is compared on ids, never prose.

**Two tiers, matching the brief.** S1 to S12 are tier one — the console, finishable on its
own (D59). S13 to S18 are tier two, the operator's working surfaces of brief items 8 to 12.
Tier two is binding scope and it is later, not optional. **S12 and S19 are tier one despite
sorting last**: S12 is the read half of brief item 7, which no earlier revision specified
(D73), and S19 is the two-platform gate without which the brief says tier one is not done at
all (D64). Slice numbers append rather than insert, so both sort after tier two.

**This supersedes the pre-contract slice set.** The previous version was written before
`20-contract.md` existed and asserted things the contract has since removed — a
`session.exit` event (retired by D45), a tool-output fetch keyed on `callId` alone (retired
by D22), and `scope: 'always'` forwarding the vendor's own suggestion (retired by D35). Its
ids are not carried forward.

**Two criteria were added after S1 landed, at the next free id in their slice** — S1.11 and
S4.15, both by the reconciliation that followed S1 (D89 to D96). Ids are still never reused
and never renumbered, so `/track` compares on ids as before and sees two additions rather than
any drift. They are not equivalent: **S1.11 is already met** — a passing test asserted it
before the criterion existed, which is the coverage arriving without the promise — while
**S4.15 is not met and names behaviour that has never existed**.

**S1 to S11 and every criterion under them are frozen.** `/track` has run: issues #2 to #12
carry those slices and their `Done when` checkboxes refer to these ids. This pass adds
criteria to S2, S3, S4 and S10 at the next free id in each, and adds no criterion in a gap.
Nothing is renumbered and nothing is removed.

Five ids are cited from other documents and are deliberately preserved against the same
topics: **S3.3** (replay gap, cited by D40, D41 and `10-design.md § Event envelope`),
**S6.5** (restore refused during a turn, cited by D17 and
`10-design.md § The single-writer invariant`), **S7.5** and **S7.6** (the pid reuse guard,
cited by D23), and **S8.1** (the Codex experiment, cited by
`10-design.md § Identity spaces`, § Open questions 6, and `20-contract.md § Unresolved` 3).

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
| `audit.ndjson` can be read newest-first, bounded, with no index (D73) | S12 |
| Tier two adds two append-only files and one module and no new architecture (D65, D77) | S13, then S15 |
| One design compiles into two working behaviours across the eight surfaces `10-design.md § Platform divergence` lists | S19 |

S8 sits eighth because everything after S8.1 needs the adapter interface and the policy
banner to exist. **S8.1 itself needs neither and is cheap — run it early, out of order, and
report.** A negative answer is already absorbed by D5, so this is bounded risk rather than
deferred risk.

**Numbering appends; it is not the execution order.** Ids are never renumbered, so a slice
added later sorts after slices it must be built after *and* after some it need not. The order
to build in is the `Depends on` line, and only that. Tier one reads
S1 → S2a → S2b → S2c → S2d → {S3, S4} → S5 → S6 → S7 → S8 → S9 → S10 → S11, with S12
reachable as soon as S4 and S5 have landed. **Letters append the same way numbers do** — S2a
to S2d subdivide S2 in place (D106) so that nothing after them renumbered. In tier
two, S13 comes before S15 because it builds `records`; S14 and S16 depend on neither and can be
taken in any order; **S17 and S18 are last because each waits on a tier-one slice** — S17 on
S12's route and S18 on S10's held rules. **S19 is reachable as soon as S7 has landed**, and
should be taken there rather than left to the end: everything after it is written against a
suite that has still only ever run on one of the two supported platforms.

**Seven slices open with a stop rather than with code.** S8.1, S10.1, S12.1, S13.1, S14.1,
S15.1 and S16.2 — one each, in seven slices — name a question the design or the contract has
not answered, and each says the slice stops until it does. That is the shape an unresolved
input has to take here: a criterion that is checkable, because the amendment either landed or
it did not, rather than an implementer's guess wearing the amendment's clothes.

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
  - S1.8 `meta.json` is written only by temp-file-then-atomic-rename, and only on the three
    occasions `20-contract.md § Persisted schemas` names — create, a `state` transition, and
    a change of `cliSessionId` — never per event. Asserted through `session-manager` driving
    a real turn, not against `store` alone, because the per-turn `cliSessionId` write (D34)
    is only observable there. `events.ndjson` holds one parseable `Envelope` per line with
    `seq` ascending contiguously from 1.
  - S1.9 A prompt that provokes a tool call produces `permission.request` carrying the exact
    tool input as the CLI sent it. The harness auto-denies, and the turn still reaches
    `turn.ended`.
  - S1.10 No vendor string above the adapter layer: a search of `config`, `jail`, `store`,
    `session-manager` and `contract` sources for the literals `claude` and `codex` returns
    only the `Vendor` type declaration and the pass-through argument to `createAdapter`
    (I20).
  - S1.11 `usage` is normalised per `message.id`, not summed raw: replayed against a captured
    real-CLI run, the emitted `usage` events sum component-wise to an independently computed
    total over distinct message ids, and `assistant` records repeating a `message.id` emit no
    second event (D75, I28). Added after the slice landed, against the probe that answered
    open question 14 for Claude — see `design/findings/S1-claude-adapter.md`.

Out of scope: HTTP, the browser, identity resolution, answering a permission
interactively, checkpoints, the audit log, interrupt, replay, truncation, Codex.

## S2 — The browser console (split into S2a to S2d)

Delivers: An operator opens a page in their browser, is recognised by whatever already
authenticates them, picks a project folder and Claude, types a message, and watches the
agent work as it happens — seeing their own sessions and nobody else's.

**Split into S2a to S2d by D106.** The four are the whole of S2 and nothing else. Every
criterion below carries the id it had before the split — none was renumbered, added or
removed — so `/track` compares on ids and sees a redistribution rather than drift. A
`Depends on: S2` line anywhere in this document means all four; those lines were deliberately
**not** narrowed to name a single sub-slice, because re-deriving which one each downstream
slice truly needs is the generative reconciliation D105 froze `design/` to stop.

Touches, across the four: `config` (bind, auth, `allowedOrigins`, `trustProxy`), `identity`,
`edge/sse`, `session-manager` (`create`, `list`, `get`, `message`, `subscribe`), `client`.

Out of scope, for all four: the WebSocket edge (S11), the permission prompt (S4), reconnect
and replay (S3), checkpoints, interrupt, mobile layout beyond not breaking, the other three
palettes and the theme switcher (S18 — S2.14 ships the token layer and one palette),
`--include-partial-messages` and `message.delta` (#13).

## S2a — Refuse to start insecurely

Delivers: The server reads its configuration and, where that configuration would expose it,
refuses to start at all rather than starting with a warning nobody reads. This is the slice
that makes the dangerous intermediate state — a console reachable off-box with no auth —
unreachable from the first commit, which is why it comes before anything that serves a route.

Touches: `config` (bind, auth, `allowedOrigins`, `trustProxy`).

Depends on: S1.

Acceptance:
  - S2.8 The server refuses to start on either fail-closed path, each with a non-zero exit
    and a message naming the fix. Not a warning. Two cases, because D93 split them: a
    routable bind that no `trustProxy` allow-list covers is `ConfigError.insecure_bind`; a
    configuration with no auth mode at all is refused earlier, at parse time, with
    `ConfigError.missing_field` naming the field — it never reaches the bind decision.

## S2b — Know who is asking

Delivers: An operator is recognised by whatever already authenticates them — a proxy header
from a peer the configuration trusts, or a shared-secret cookie — and a request that cannot be
attributed to someone is refused. Requests from an origin the configuration does not allow are
turned away before identity is even considered.

Touches: `identity`, `config` (auth, `trustProxy`, `allowedOrigins`).

Depends on: S2a.

Acceptance:
  - S2.4 Proxy-header mode resolves an `OperatorId` from the configured header, and rejects
    that header with `401 unauthenticated` when the peer address is not in `trustProxy`,
    logging the address.
  - S2.5 Shared-secret mode authenticates from its cookie; a wrong secret is
    `401 unauthenticated`. The cookie is set `SameSite=Strict; HttpOnly; Path=/`.
  - S2.9 A `POST` whose `Origin` is not in `allowedOrigins` returns `403 bad_origin`, and
    does so **before identity is resolved** — asserted by an unauthenticated request with a
    disallowed origin returning `403`, not `401` (I24).
  - S2.13 The negative authentication cases are each rejected and the counts stated in the
    slice report: no identity, a forged header from a peer outside `trustProxy`, a wrong
    shared secret, and a disallowed origin.

## S2c — Create a session, send a message, watch it stream

Delivers: The HTTP surface an operator actually drives — create a session, send it a message,
and subscribe to a live event stream that survives a reverse proxy's idle timeout. Someone
else's session is indistinguishable from one that does not exist.

Touches: `edge/sse`, `session-manager` (`create`, `list`, `get`, `message`, `subscribe`).

Depends on: S2b.

Acceptance:
  - S2.1 `POST /api/sessions` returns `201 { sessionId }`, and its refusals carry the exact
    codes in `20-contract.md § HTTP routes`: `409 outside_workspace_root`,
    `422 bad_request`, `503 agent_unavailable`.
  - S2.2 `POST /api/sessions/:id/message` returns `202 { turnId }`; a second message while a
    turn is running returns `409 turn_in_flight`.
  - S2.3 `GET /api/sessions/:id/events` is `text/event-stream`, one envelope per message,
    `id:` set to `seq` and `event:` set to `kind`.
  - S2.6 Every `/api/sessions/:id` route implemented in this slice returns
    `404 no_such_session` — never `403` — for a session owned by another operator.
  - S2.7 `GET /api/sessions` returns only the caller's sessions.
  - S2.10 A `: keepalive` comment is sent every `caps.keepaliveMs`, and an idle stream
    survives at least three intervals through a reverse proxy.

## S2d — The page itself

Delivers: The browser page, rendering the agent working as it happens from normalised events
only — no vendor name anywhere in the client, a strict CSP that hostile text cannot escape,
and every visual value coming from a design token rather than a literal.

Touches: `client`.

Depends on: S2c.

Acceptance:
  - S2.11 The client renders `message`, `thinking` and `tool.call` from normalised events
    only; a search of client sources for `claude` and `codex` returns nothing.
  - S2.12 The document is served with exactly the CSP in `10-design.md § Security controls`;
    the built client contains no inline script or style; a tool name or message text
    containing `<img src=x onerror=alert(1)>` renders as literal characters and executes
    nothing (I26).
  - S2.14 Every colour, spacing, radius and type value the client renders with is a CSS
    custom property declared in one stylesheet; no component style carries a literal colour.
    Asserted by searching the built client's styles for hex literals, `rgb(`, `hsl(` and CSS
    named colours, and finding them only inside the custom-property declarations themselves.
    D58 requires every component to be built four ways from the first one, and the token layer
    is the half of that which cannot be retrofitted — the four palettes and the switcher are
    S18's.

## S3 — Close the laptop, open the phone

Delivers: An operator can lose their connection in the middle of a run — close the laptop,
walk away, reopen the console on a phone — and find every message, tool call and prompt that
happened while they were gone, in order, with nothing missing and nothing shown twice. The
agent keeps working the whole time.

Touches: `store` (`readEventsAfter`, `readLastSeq`, ring buffer), `session-manager`
(`subscribe`, replay), `edge/sse` (`Last-Event-ID`), `config` (`caps.ringCapacity`,
`caps.subscriberQueueHighWater`), `client` (the phone layout).

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
  - S3.9 The console is usable on the phone, against `design/prototype/`'s phone chrome as the
    visual spec (D57): at 390 px wide the transcript, the session list and the compose box
    render with no horizontal scrolling, and a reconnect served from the spill renders the same
    envelope sequence on the phone layout as on the desktop one.

Out of scope: an offset index for the spill (#19); the WebSocket reconnect path (S11);
truncation of large results (S9); the phone approve-and-deny screen (S4.14 — D57 names it as
this slice's reason to exist, and it is built where the permission route is); the torn-tail
defect where one `seq` could name two different events (#33 — a design question S3.6 does not
answer).

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
  - S4.13 The permission route resolves identity and applies the ownership check like every
    other session route: another operator answering a prompt on a session they do not own gets
    `404 no_such_session` and writes no audit record, and `AuditRecord.operator` is the id
    resolved from the request, never one carried in the body (#38, I23).
  - S4.14 The approve-and-deny screen works on the phone (D57): at 390 px wide the exact tool
    input is legible without horizontal scrolling, and allow and deny each round-trip to a real
    child from that layout. The prototype draws no approval screen, so this one is specified
    here rather than taken from it.
  - S4.15 A turn that spawns with no `--resume` on a session that has already run one emits
    `session.notice / warn` with code `resume_unavailable`, saying the conversation context was
    not carried forward (D34). Asserted by killing a child before it reports `system/init` and
    sending a second message: the notice is emitted, the turn proceeds, and `cliSessionId` is
    unchanged. Added by reconciliation — the behaviour was specified in
    `10-design.md § Failure modes` and owned by no slice, so it silently did not exist.

Out of scope: standing rules and `scope: 'always'` (S10, blocked on #16); forwarding
`updatedPermissions` to the CLI (D35 rejects it); Codex permissions (S8); per-operator vendor
authorisation (there is no operator record to hold one, D50); the audit *read* — brief item 7's
other half is S12.

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
silently, which is the worst way to fail); the lock preventing two servers over one
storage root, which is S22's (D161 — it depends on this slice's liveness test rather than the
reverse); closing the spawn-to-append window with a Windows Job Object (D23 rejects the
dependency).

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

Out of scope: the retention rule for tool-output blobs, which is S23's — D162 gives them a
per-session byte budget, and this slice's S9.5 is what makes that cheap by having already
specified the absent-blob path; an offset index for the spill; virtualised scrollback beyond
whatever S9.6 requires.

## S10 — Stop asking me about this one

**Blocked on open question 8 (#16), and on #37.** D35 made the grammar this slice needs a
prerequisite rather than a nice-to-know, because the matching now happens in this server
rather than in the CLI — and the design describes the behaviour while giving the rule no home:
no entity, no field, no file, and no statement of its lifetime across session end or restart
(`20-contract.md § Unresolved` 2).

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

## S12 — Read the record of who approved what

**Tier one.** Brief item 7 is a read — "read an audit record of every tool approval: who, what,
when" — and until D73 no document specified one. S4 built the append; this builds the read, and
tier one is not finished without it.

Delivers: An operator can open the record of tool approvals and read back who allowed what,
when, and in which workspace — including approvals made on sessions that are not theirs and on
sessions that have since been removed. They page back through it without landing on a screen
that gets slower every month the deployment runs.

Touches: `store` (`readAuditPage`, minting `AuditCursor`), the module that serves the route
(see S12.1), `edge/sse` (`GET /api/audit`), `client` (the audit screen), `config`
(`caps.auditPageMax`).

Depends on: S2, S4, S5 (S12.8 needs `DELETE`).

Acceptance:
  - S12.1 The module that serves `GET /api/audit` is named in `20-contract.md`. As drawn,
    `10-design.md § Module boundaries` gives the audit read to `records`, which is tier two, so
    tier one cannot serve brief item 7 without building part of tier two; `Store.readAuditPage`
    exists and an edge may not call `store` directly, so the missing piece is one method on one
    module (`Unresolved` 5, #34). That is a contract amendment at `/contract`'s tier. **This
    slice stops until it lands** and may not add a signature the contract does not carry.
  - S12.2 `GET /api/audit` returns `200 AuditPage` with `records` newest first, and
    `nextCursor` null exactly when the window reached the oldest record.
  - S12.3 A `limit` above `caps.auditPageMax` is clamped to the cap rather than refused, and
    the served count is asserted against a log of at least three times `auditPageMax` records.
  - S12.4 Paging by `nextCursor` visits every record exactly once: the pages concatenated over
    a log of at least 500 records equal the file read newest-first, line for line, with no
    duplicate and no omission.
  - S12.5 The cursor is opaque and server-minted (D86): a cursor the caller has altered is
    refused `422 bad_request`, and a search of the client sources finds no code that parses,
    decodes or constructs one.
  - S12.6 Each filter narrows and they combine: `sessionId`, `operator`, `since`, `until`.
    Asserted against a fixture spanning two sessions, two operators and a known timestamp
    boundary, with the count matched for each filter and for the combination.
  - S12.7 The read is open to every authenticated operator and is not scoped to the caller's
    own sessions: operator B reads operator A's records in full (D70). An unauthenticated
    request is `401 unauthenticated`.
  - S12.8 Records for a session removed by `DELETE /api/sessions/:id` are still readable, with
    `vendor` and `sandbox` intact — which is the reason the record copies them rather than
    referencing the session (D25, I13).
  - S12.9 No read scans the whole file: the bytes read to serve one page do not grow with the
    file, asserted by instrumenting the read against logs of 10 000 and 100 000 records and
    stating both figures with the elapsed time for the first page and the deepest page (I39).
  - S12.10 The screen renders `operator`, `tool`, `input`, `decision` and `ts` as text nodes: a
    recorded tool input containing `<img src=x onerror=alert(1)>` appears as literal characters
    and executes nothing (I26).

Out of scope: the incident filters and grouping (S17 — the same read with `incidentsOnly`); an
offset index for `audit.ndjson` (#19, which now carries this file as well as the spill); any
retention, rotation or truncation rule — I13 forbids shortening this file, and the bounded
window is what makes that survivable.

## S13 — Hiring: open a session through a requisition someone approved

**Tier two**, brief item 10, first half. This is the slice that builds the `records` module and
the first of its two append-only logs, so it carries tier two's structural risk: if D65's
"append-only latest-wins files, not a database" is wrong, it is wrong here.

Delivers: An operator can ask for a workspace before they have it, writing down what they want
to work on and why, and somebody else can approve or reject the request. Once it is approved
the requester starts a session straight from it, and the request is spent. Everyone can see
every request and what happened to it.

Touches: `records` (new module — the requisition registry, `boot`, `raise`,
`listRequisitions`, `getRequisition`, `decide`, `claim`, `attachSession`, `release`), `store`
(`appendRequisition`, `readAllRequisitions`), `session-manager` (`create` with
`requisitionId`), `edge/sse` (the three requisition routes), `client`, `config`
(`caps.requisitionTextBytes`).

Depends on: S2, S5 (the workspace claim), S7 (boot ordering).

Acceptance:
  - S13.1 The write-protocol ordering for record-log mutations is settled in the design.
    `10-design.md` states both that the registry is claimed synchronously before the append and
    that the append lands before any registry mutation, and the two cannot both hold
    (`Unresolved` 7, #31). This slice is the first code that would implement one of them.
    **It stops until the design says which**, at `/design`'s tier.
  - S13.2 `POST /api/requisitions` returns `201` in state `open`, storing `workspace` as the
    client's string: a requisition naming a path outside every root is raised successfully, with
    no jail call made and no refusal (D68, I34).
  - S13.3 `GET /api/requisitions` returns every requisition to every authenticated operator,
    not only the caller's (D70) — a requisition cannot be approved by someone who cannot see it.
  - S13.4 `POST /api/requisitions/:id/decision` moves `open → approved` or `open → rejected`
    and records `decidedBy` and `decidedAt`. A second decision is `409 already_decided` naming
    the decider and the state, and two decisions dispatched in the same tick yield exactly one
    `200` and one `409` (I5, I32).
  - S13.5 Self-approval succeeds and is recorded: `decidedBy` equal to `raisedBy` is accepted
    and appears on the record (D69).
  - S13.6 `POST /api/sessions` naming an approved requisition creates the session and moves the
    requisition to `consumed` carrying that `sessionId`. A second create naming the same id is
    `409 requisition_consumed`, and two dispatched in the same tick yield exactly one `201`
    (I33, I5).
  - S13.7 A claim against the wrong state takes nothing: `open` and `rejected` each give
    `409 requisition_not_approved`, and an unknown id gives `404 no_such_requisition`.
  - S13.8 The jail and busy checks run before the claim: a create naming an approved
    requisition whose workspace is outside every root is `409 outside_workspace_root`, and the
    requisition is still `approved` and still spendable afterwards (D68).
  - S13.9 A creation that fails after the claim releases both claims together: the requisition
    reads `approved` again, the workspace is free, and a retry succeeds.
  - S13.10 `POST /api/sessions` with no `requisitionId` behaves exactly as it did in S2 —
    asserted by re-running S2.1's cases unchanged. A requisition is a second way in, never a
    gate (D68, D59).
  - S13.11 A `title` or `justification` over `caps.requisitionTextBytes` is refused
    `422 bad_request` naming the field, with nothing appended and nothing truncated (D84).
  - S13.12 A failed append returns `500 record_write_failed` and leaves the registry and the
    file agreeing, with the requisition at its prior state (I37).
  - S13.13 Boot loads `requisitions.ndjson` into the registry, latest line per id winning,
    before any connection is accepted; an unreadable file yields an empty registry, a log line,
    and a server that still serves every tier-one route (I18, I38).
  - S13.14 A torn trailing line is dropped at boot and the previous line for that id becomes
    authoritative — asserted with a truncated `consumed` line, after which the requisition reads
    `approved` and can be spent a second time. This is accepted behaviour, recorded, not fixed
    (`10-design.md § Persistence summary`).
  - S13.15 A `justification` containing HTML renders as literal characters in a *different*
    operator's browser (I26, D74).
  - S13.16 There is no revocation route and no expiry: the only transitions are I32's four, and
    a request for any other is refused (D81).

Out of scope: reconciling a `consumed` requisition whose session never materialised — D80
accepts that as a dead approval and the remedy is raising another; a candidate entity or
anything else from the prototype's hiring screen beyond the requisition itself; resolving
`workspace` at raise time (D68 rejects it).

## S14 — Onboarding: work the first-run checklist

**Tier two**, brief item 10, second half.

Delivers: An operator starting work in a new workspace is shown the deployment's own first-run
steps and ticks them off as they go. What they have ticked survives a reload, shows up for
anyone else watching the same session, and sits in the transcript at the point it happened.

Touches: `session-manager` (`checklist`, `tickChecklistItem`, the fold), `edge/sse` (the two
checklist routes), `client`, `config` (`checklist`).

Depends on: S2, S3 (the replay path S14.7 asserts).

Acceptance:
  - S14.1 Two rules are stated in the design: whether a tick on an ended session is refused,
    and whether every session has a checklist or only one opened through a requisition
    (`Unresolved` 9, #41). The route as drawn lists no `409 session_ended`, and that omission is
    the open question rather than a ruling. **This slice stops until both are answered**, because
    either answer is behaviour a criterion has to assert.
  - S14.2 `POST /api/sessions/:id/checklist/:itemId` emits one `checklist.item.completed
    { itemId, by }` through the same `emit` as every other event, at a `seq` contiguous with the
    session's stream (D71, I1).
  - S14.3 The envelope carries no `turnId` and is accepted mid-turn: a tick during a live turn
    lands between that turn's `turn.started` and `turn.ended`, and the renderer attributes it to
    the operator rather than to the agent (`20-contract.md § Rules the renderer may rely on`).
  - S14.4 Ticking is idempotent: a second tick for the same item returns `200 { ok: true }` and
    emits no second envelope, so at most one exists per `(sessionId, itemId)` (I36).
  - S14.5 An `itemId` absent from the configured template is `404 no_such_item`.
  - S14.6 `GET /api/sessions/:id/checklist` returns the fold — the template's label joined to
    `completedBy` and `completedAt` taken from the envelope's `by` and `ts` — for every item,
    complete or not. The client does not hold the template (D85).
  - S14.7 The fold survives a reload and a reconnect: after a replay served from the spill, the
    client shows the same ticked set the route reports.
  - S14.8 An empty `config.checklist` disables the surface: the read returns an empty list and
    the client shows no checklist rather than an empty panel.
  - S14.9 Both routes carry the ownership check: another operator gets `404 no_such_session` for
    the read and for the tick (I23).
  - S14.10 A tick appends nothing to `audit.ndjson`: the file is byte-identical across a run of
    at least five ticks. That log records tool approvals, and diluting it with provisioning
    clicks makes the artifact the threat model leans on harder to read (D71).

Out of scope: a per-requisition or per-vendor template (D71 rejects it — that is a workflow
engine); unticking, or any transition out of complete; ordering or dependencies between items;
persisting a checklist anywhere — it is derived and it dies with its session under D25.

## S15 — Performance reviews, and the plan badge over them

**Tier two**, brief item 9.

Delivers: An operator can write up how a session went, keep it to themselves while it is a
draft, and publish it when it is ready. Published reviews are readable by everyone and outlive
the session they are about, so removing a session never removes the record of it. Where the most
recent published review puts a session on a performance plan, everybody sees that on the
session.

Touches: `records` (the review registry, `createReview`, `appendReview`, `finaliseReview`,
`getReview`, `listReviews`, `isUnderPip`), `store` (`appendReview`, `readAllReviews`),
`edge/sse` (the five review routes, and the `SessionSnapshot` composition D77 puts at the edge),
`client`, `config` (`caps.reviewBodyBytes`).

Depends on: S13 (the `records` module and its boot path), S2, S5, S7.

Acceptance:
  - S15.1 Two prerequisites are settled in the design before any code, and #31 from S13.1 applies
    here unchanged: how the edge obtains a `SessionSnapshot` for a review about a session the
    author does not own, when the only route to a session is an ownership check that answers
    `404` to a non-owner (`Unresolved` 6, #32); and what claims finalisation, plus what stops the
    accepted torn-tail reversion retracting a final review other operators have already seen and
    that may already have raised a badge (`Unresolved` 10, #35, #36). Both are `/design`'s at its
    own tier. **This slice stops until they land.**
  - S15.2 `POST /api/reviews` returns `201` in state `draft`, with the `SessionSnapshot` copied
    at authorship and `author` taken from the identity edge. A `CreateReviewInput.subject` that
    disagrees with the snapshot's `sessionId` is `422 bad_request`.
  - S15.3 A draft is its author's alone: another operator reading it by id gets
    `404 no_such_review`, and appending to it gets `404` — never `403`, and never distinguishing
    "no such id" from "not yours" (I31, D50).
  - S15.4 `GET /api/reviews?subject=` returns finals only, for every caller including a draft's
    own author; an author reaches their own draft by `GET /api/reviews/:id` with the id that
    `POST` returned (I31).
  - S15.5 Editing a draft appends a new line for the same `reviewId` and leaves the earlier line
    on disk; the latest line wins on read and the file is never rewritten (D65).
  - S15.6 `POST /api/reviews/:id/finalise` moves `draft → final` once. A further append or a
    second finalise is `409 review_final`, and the same change makes the review readable by every
    authenticated operator (I29, I31).
  - S15.7 `Rating` accepts exactly the five tokens in `20-contract.md` and no display string; an
    unknown token is `422 bad_request` (D82).
  - S15.8 A `body` over `caps.reviewBodyBytes` is refused `422 bad_request` with nothing appended
    and nothing shortened — a silently truncated review misrepresents its author, which is why
    the rule differs from `tool.result`'s (D84).
  - S15.9 The plan badge is derived and never stored: it is the `pip` of the final review for
    that subject with the greatest `updatedAt`, ties broken by the later line, drafts excluded.
    Asserted with a draft carrying `pip: true` that changes no badge, and a later final that does
    (I35, D72, D83).
  - S15.10 A review survives `DELETE /api/sessions/:id`: it reads back whole, renders from its
    `snapshot`, and no read of it resolves its `subject` (I30, D67).
  - S15.11 A failed append returns `500 record_write_failed` with the registry and the file still
    agreeing, and the operator's text still in their form (I37).
  - S15.12 Boot loads `reviews.ndjson`, latest line per id, before listening; an unreadable file
    yields an empty registry and a log line, and tier one still serves (I18, I38).
  - S15.13 A review `body` containing HTML renders as literal characters in a different
    operator's browser. This is the first stored path from one operator's keyboard to another's,
    and it is the reason I26 was widened past agent-derived content (D74).

Out of scope: an employee or operator entity, and any per-operator record (D3 and D66 refuse
both); a reviewer role, or any read restriction beyond the draft carve-out (D70); attaching a
review to a person or a workspace path (D66 — paths are reused); the trailing-30-day metrics
grid and the weekly timecard the prototype draws beside the review — no document names a source
for either, and neither is in brief items 8 to 12.

## S16 — Payroll: what a session has cost

**Tier two**, brief item 8.

Delivers: An operator can see what a session has spent — tokens used so far, how much of its
budget is left, and how long it sat open doing nothing — and is told plainly when part of that
idle time could not be accounted for because the server was down.

Touches: `session-manager` (`payroll`, the running burn counter, the fold over the spill),
`adapters/*` (usage normalisation), `edge/sse` (`GET /api/sessions/:id/payroll`), `client`,
`config` (`sessionTokenBudget`).

Depends on: S1, S2, S7 (S16.7 needs a restart-closed turn).

Acceptance:
  - S16.1 A written finding, committed before the fold, on whether Claude's reported `usage` is
    cumulative within a context and what it does at a `compact_boundary`, citing the records
    observed. The adapter's normalisation to a delta is written against that observation rather
    than an assumption (D75, open question 14, #30). Codex's half is blocked behind S8.1 and is
    recorded as blocked, not failed.
  - S16.2 What `remainingTokens` subtracts is stated in the contract, and the budget's scope in
    the design: brief item 8's "budget remaining" needs one scalar and nothing says whether cache
    reads and cache creation count against a budget, and the scope is an owner's decision between
    per session, per deployment and per workspace (`Unresolved` 8, #29). **This slice stops until
    both land** — a screen shipped against one reading is what makes the other two awkward.
  - S16.3 `usage` is incremental and summable at the point it is emitted: over a turn with at
    least three `usage` events and one compaction, the component-wise sum equals the total
    computed independently from the raw records, and no module above `adapters/*` does arithmetic
    on a vendor's own numbers — asserted by searching `session-manager` and `client` for any read
    of `raw` (I28).
  - S16.4 `GET /api/sessions/:id/payroll` returns `burn` as the component-wise sum of every
    `usage` event of the session, `budgetTokens` from configuration, and `remainingTokens` null
    exactly when `budgetTokens` is null.
  - S16.5 The live counter and the fold agree: the payroll read for a live session equals the
    same read after a restart has rehydrated it, where the spill is the only source
    (`10-design.md § Derived views`). Where they disagree the spill is right, and the test asserts
    the counter against it, not the reverse.
  - S16.6 `idleMs` is the wall clock the session was live with no turn — creation to first turn,
    each `turn.ended` to the next `turn.started`, and last turn to `endedAt` — asserted to the
    millisecond against a fixture with known gaps.
  - S16.7 An idle interval containing a restart is dropped and counted, never billed: a session
    whose log carries `turn.ended { stopReason: 'server_restart' }` excludes that interval from
    `idleMs`, reports it in `droppedIntervals`, and the client says how many were dropped (D76).
  - S16.8 A payroll read whose spill cannot be read is `500 payroll_unavailable`, and the session
    is unaffected — the next message still starts a turn.
  - S16.9 The route carries the ownership check: another operator gets `404 no_such_session`
    (I23).

Out of scope: cost per shipped PR, which has no source inside this server — D158 cuts it and
substitutes a priced-burn tile, built in **S20** because this slice had already landed when that
decision was taken (#27); a
per-deployment or per-operator budget until #29 says otherwise, and a per-operator one needs the
operator record D3 refuses; pricing lookups (D61 declines to pre-decide them); storing any of
this — every number here is a fold over what the session already wrote.

## S17 — Incidents: the audit log as a history

**Tier two**, brief item 11. It adds no storage: it is S12's read with a filter.

Delivers: Instead of a flat log, an operator can look at what went wrong — denials, decisions the
server made on nobody's behalf, and approvals that happened automatically under a standing rule —
grouped by session and by operator over a window of time.

Touches: `store` (`readAuditPage` with `incidentsOnly`), the module serving `GET /api/audit`
(S12.1), `client` (the incident view).

Depends on: S12. S10 for S17.4's row to be reachable at all.

Acceptance:
  - S17.1 `incidentsOnly: true` returns exactly the union of three sets and nothing else:
    `decision === 'deny'`, `operator === null`, and `scope === 'standing'`. Asserted against a
    fixture holding all three plus ordinary allows, with the count stated for each set and for
    the union.
  - S17.2 It is the same route and the same read as S12: clamping, cursor, paging and the four
    filters behave identically with the flag set, asserted by re-running S12.4's paging assertion
    with `incidentsOnly: true` (D73).
  - S17.3 A decision the server forced appears as an incident: a permission denied because the
    audit append failed, and one resolved `cancelled_process_exit` because the child died, are
    both present with `operator: null` and the cause in `reason`.
  - S17.4 A standing auto-allow appears with `scope: 'standing'` and `operator: null`, asserted
    against S10's auto-answer path. Until S10 ships, this criterion is recorded as unreachable
    rather than as passing.
  - S17.5 Grouping is the reader's: the server returns records and the client groups the window
    by session and by operator. No grouped shape is added to the contract.
  - S17.6 The view reads records for sessions the caller does not own and for sessions that have
    been deleted (D70, D25).

Out of scope: an incident entity, an incident status, or an acknowledgement workflow — nothing in
storage is an incident and nothing may be added for one (`10-design.md § Data model`); alerting or
notification; anything that would make this a second read shape rather than the same one.

## S18 — Four visual systems, and the badges over them

**Tier two**, brief item 12. Client only: no route, no field, no stored value.

Delivers: An operator chooses which of the four looks the console presents, and the choice sticks
in that browser. Whichever they pick, a session reads the same in plain language — clocked out,
blocked waiting on them, on shift, or idle — with a separate mark when it is under a performance
plan.

Touches: `client`.

Depends on: S2 (S2.14's token layer), S4 (`BLOCKED` needs an outstanding request), S5
(`CLOCKED OUT` needs `end`), S15 (`ON PIP`), S10 (S18.9's second screen).

Acceptance:
  - S18.1 All four systems are CSS custom properties in one stylesheet served from `'self'`,
    selected by a `data-` attribute on the root element. No style text is generated, injected or
    interpolated at runtime, and the document's CSP is still S2.12's — `style-src 'self'` with no
    `unsafe-inline` (D78).
  - S18.2 Switching changes no markup and issues no request: across four switches the network log
    shows zero requests and the rendered DOM is element-for-element identical.
  - S18.3 The choice is held in browser storage and never reaches the server: no route carries
    it, and a search of the server sources for the storage key returns nothing (D60).
  - S18.4 The choice survives a reload with no flash of an unthemed document — the attribute is
    set before first paint, asserted on a cold load.
  - S18.5 Every component renders correctly under all four: a screenshot pass over each screen in
    each theme, with the count of screens times themes stated in the slice report. A component
    that reads a literal colour instead of a token is an S2.14 failure, not this slice's.
  - S18.6 The status badge is a projection with no field behind it: `CLOCKED OUT` is
    `state === 'ended'`, `BLOCKED` is a live session with an unresolved `permission.request`,
    `ON SHIFT` is a live turn, `IDLE` is the remainder. Asserted by driving one session through
    all four and reading the badge at each point (D79).
  - S18.7 `ON PIP` is orthogonal and comes from the review fold, never from the session: it can
    appear alongside any of the four states, and no session field carries it (D72, D79).
  - S18.8 `PROBATION` exists nowhere in the client: a search of the sources returns nothing.
    Nothing in this system is a source for it (D79).
  - S18.9 The termination and permissions-scope screens are presentation over endpoints that
    already exist: the first renders real session state from `GET /api/sessions` and `DELETE`, the
    second renders S10's held rules with a still-prompting rule shown as a request, and neither
    introduces a route, a field or a stored value (D56).
  - S18.10 Neither a `Clone` action nor an exit-interview transcript exists anywhere in the
    client (D56 cuts both — Clone needs the context-management non-goal reopened before it can be
    specified, and the interview stores a reply its own screen says nobody reads).

Out of scope: a per-operator stored preference (D60 put the choice in the browser, and the known
cost — the theme follows the browser rather than the person — is retained, not solved); a fifth
theme, or a light and dark pair; severance figures, and anything else on the termination screen
that is not real session state.

## S19 — Prove it on both platforms

**Tier one, and deliberately not a vertical slice.** Every other slice here runs from an entry
point to persistence; this one runs from a push to a check mark. It is admitted because the
rule's reason is satisfied more directly here than anywhere else — a slice must end in
something observable, and this one is green on both legs or it is not. The brief says tier one
is not done until both supported platforms are proven by an automated run rather than by
assertion (D64), so the alternative to slicing it is a tier that cannot be finished.

Delivers: Anyone proposing a change finds out before it lands whether it works on Windows and
on Linux, instead of finding out later from an operator on whichever platform nobody ran. Where
a check genuinely cannot be made on one of the two, it says so by name rather than passing
quietly.

Touches: `.github/workflows/verify.yml` (new), the platform-conditional tests in
`src/jail/index.test.ts` and `src/session-manager/index.test.ts`, and whatever the Linux leg
turns out to break.

Depends on: S1, S5, S7 — the slices owning the four criteria this gate exists to make
checkable. The workflow can be authored earlier; it cannot prove anything earlier.

Acceptance:
  - S19.1 The workflow runs on `pull_request` and on push to `main`, and its platform job runs
    on both `ubuntu-latest` and `windows-latest` from one `matrix.os`. A pull request shows one
    check per platform, and both check names are stated in the slice report so branch
    protection can later be attached to them by name.
  - S19.2 `fail-fast: false`, so one red leg does not cancel the other: a deliberately failing
    test on one platform leaves the other platform's conclusion reported. Asserted on a
    throwaway commit that is not merged, with both conclusions recorded. A cancelled leg reads
    as an absent result, which is the matrix-level form of the failure this whole slice is
    about.
  - S19.3 Every step that gates this repository carries `# verification: true` on the line
    above its `- name:`, and `/verify`'s discovery finds exactly those steps and no others —
    the count found is stated and equals the count flagged. Before this slice discovery finds
    none at all, because no workflow file exists for it to read
    (`.claude/commands/verify.md § Discover, do not assume`), so `/verify` and `/pr` have been
    reporting against an empty gate set.
  - S19.4 Both legs run the same Node version, pinned in the workflow rather than floating, and
    it satisfies `engines.node`. A gate whose legs differ in runtime as well as platform cannot
    attribute a divergence to either.
  - S19.5 A platform-divergent test is **reported skipped on the other platform, never absent
    from it**: the set of test names in the Linux leg's output equals the set in the Windows
    leg's, and every name that ran on one and not the other carries a stated skip reason. Today
    those tests sit inside `if (process.platform === 'win32')` blocks, so on Linux they are
    indistinguishable from tests that were deleted — and a suite cannot report what it never
    named.
  - S19.6 A platform-divergent test that cannot establish its own precondition reports skipped
    with the reason, and never returns green having asserted nothing. Asserted against S5.7's
    8.3 short-name case, which returns early when the host generates no short name: on a volume
    with 8.3 creation disabled — which a hosted Windows runner may well be — it currently reads
    as a pass.
  - S19.7 The slice report names, for each of **S1.6**, **S5.2**, **S7.5** and **S7.6**, which
    leg proved it and which test did. A criterion that no leg proves is reported as still
    unproven rather than as covered. Those four are the whole reason this slice exists (#28,
    `10-design.md § Platform divergence`).
  - S19.8 The suite runs on Linux for the first time and both legs report success on the merge
    commit, with the run recorded in the slice report. A red Linux leg here is a real defect,
    not noise, and an implementation defect is fixed inside this slice.
  - S19.9 Nothing was weakened to reach S19.8: the number of assertions reachable on the
    Windows leg is the same before and after this slice, and both counts are stated. Adding a
    skip that carries a reason is allowed; removing, narrowing, or newly platform-gating an
    assertion that used to run is a finding, reported with its diff rather than absorbed.
  - S19.10 A Linux failure that turns out to be a contract or a design question **stops the
    slice** and is stated rather than fixed inside it. This gate exists to make platform
    divergence visible; deciding what a divergence ought to do belongs to `/contract` or
    `/design` at its own tier.
  - S19.11 The `tools/` PowerShell suites are gated in the same file, by a job on
    `windows-latest` that parse-checks every `*.ps1` and runs Pester over `tools` — the shape
    `SubZeroDev.AgentKit`, `SubZeroDev.Data.Json` and `SubZeroDev.GameEngine` already use. They
    are the scripts `/verify` and `/pr` lean on and they are gated by nothing today. Pass and
    fail counts are stated.

Out of scope: macOS — there are two supported targets, not three, and `getProcessImage`'s macOS
branch (#118) exists because a developer runs one, not because it is a target; a third leg is a
brief change first. Enabling branch protection on the two checks — that is a repository-settings
write and the owner's, so this slice names the checks and stops (`AGENTS.md`, *Git and
delivery*). A second matrix dimension over Node versions — S19.4 pins one, and covering a range
is a different question nobody has asked. Deploy, release, container and docs workflows, which
the neighbouring repositories carry and this one has no artifact for. Running the real `claude`
CLI in CI: the suite drives `fake-claude-cli.mjs` through the `SKYNET_CLAUDE_EXECUTABLE` seam
(D91), so the criteria that say a **real** child — S1.1, S4.2 — stay proven locally, and this
gate must not be reported as having reproven them. Caching, artifact upload and test reporters.

## S20 — What the session cost, in money

**Tier two**, brief item 8's fourth clause. It is a slice of its own rather than two criteria
appended to S16 because **S16 had already landed** when D158 was taken: adding acceptance criteria
to a closed slice rewrites what its issue meant by done. S1.11 and S4.15 are not a precedent for
doing so here — both named behaviour the design had always specified and no slice had owned, where
this is new scope from a new decision.

Delivers: An operator sees what a session cost in money, not only in tokens — the same burn the
payroll screen already shows, priced against rates the deployment sets. Where the price cannot
honestly be computed, the figure is absent rather than zero, so nobody reads a free session and an
unmeasurable one as the same thing.

Touches: `session-manager` (the payroll fold), `contract` (`PayrollView`, `TokenRates`, `Config`),
`config`, `client` (the tile).

Depends on: S16.

Acceptance:
  - S20.1 `costCurrency` is `burn`'s four components each priced at `config.tokenRates` and
    summed, with `currency` echoed from configuration and never interpreted — no conversion, no
    lookup, no network call. Asserted against a fixture with known component counts and known
    rates, the expected figure stated in the slice report (D158).
  - S20.2 `costCurrency` and `currency` are both `null`, never `0`, in each of the two cases that
    produce no priced figure: `config.tokenRates` unset, and a session whose transport reports no
    usage.
  - S20.3 The unavailable case is derived from the same signal as
    `session.notice / usage_unavailable` and **never** from testing `burn` for zero — asserted by
    a search of the payroll fold finding no zero-comparison against `burn`, and by a session that
    genuinely burned nothing still reporting a priced `0` rather than `null`
    (`20-contract.md § Unresolved` 12, D146).
  - S20.4 The client renders an absent figure as absent — no tile, or an explicit "not available"
    — and never as a currency-formatted zero. Asserted on both null cases from S20.2.
  - S20.5 The slice report states plainly that the figure is an estimate against operator-set
    rates and not a vendor's billed amount, and the client says so where the tile is shown.

Out of scope: per-model rates — `Usage` carries no model identifier and `UsageEvent` is
`{ turnId, usage }`, so keying rates per model needs a new field on a public event payload and a
change in every adapter; D158 records the resulting imprecision as known and retained. Currency
conversion, any pricing lookup against a vendor, and any figure presented as a bill. Making
`PayrollView.burn` nullable, which is #30 and #91's and which D158 adds weight to without settling.

## S21 — Hand the agent a file

**Tier one's route, but not a tier-one item** — no definition-of-done item names attachments. D160
designed them at the owner's direction after the alternative, dropping them, was recommended and
declined. **It opens with a probe**, in the shape S8.1 and S10.1 use: the vendor behaviour it rests
on has never been observed, and a slice that guesses it builds a route onto a transport that may
refuse the payload.

Delivers: An operator can attach a file to a message — a screenshot of the bug, a log, a spec —
and the agent receives it alongside the text. The attachment stays part of the transcript: it is
there on a reconnect, on another device, and after a refresh, and it disappears with the session
when the session is removed. Where the agent's vendor cannot accept files at all, the operator is
told so rather than having the file silently ignored.

Touches: `store` (`writeAttachment`, `openAttachment`), `session-manager` (the message path),
`adapters/*` (`send`'s new parameter, `acceptsAttachments`), `edge/*` (the upload validation and
the read route), `client` (the picker and the rendering), `config` (`caps`), `contract`.

Depends on: S1, S2, S3 (S21.7's replay), S5 (S21.9 needs `DELETE`).

Acceptance:
  - S21.1 A written finding, committed before any transport code, answering whether
    `claude --input-format stream-json` accepts a `user` message whose `content` array holds a
    non-text block — an `image` block at minimum — and what it does with one it rejects. The
    command run and its observed output are cited. **If the CLI does not accept them, the slice
    stops here**: the remaining criteria are recorded as blocked rather than failed, no
    workaround is built, and what to do instead is `/design`'s. Writing the file into the
    workspace and naming its path to the agent is explicitly **not** a fallback to reach for — it
    is a different feature the operator can already perform themselves.
  - S21.2 A message with attachments returns `202 { turnId }` and the emitted `message` envelope
    carries one `AttachmentRef` per upload, with `filename`, `mediaType` and the decoded `bytes`.
    **No envelope in `events.ndjson` contains attachment bytes** — asserted by uploading a
    recognisable byte pattern and searching the whole spill for it (I49).
  - S21.3 Each blob is written and fsync'd before the envelope naming it is constructed, asserted
    by a store double recording call order (I49) — the same shape S4.6 uses for the audit record.
  - S21.4 The path is `attachments/<turnId>/<attachmentId>` with a server-minted `attachmentId`,
    and the operator's `filename` never reaches it: an upload named `../../escape.txt`, one named
    `C:\\Windows\\evil`, and one named with a NUL byte each store safely under a minted id, with
    the original preserved verbatim in the ref for display (I49).
  - S21.5 The caps refuse rather than truncate: an attachment over `caps.attachmentBytes` and a
    message over `caps.attachmentCount` are each `422 bad_request` naming the field, with nothing
    written to disk and nothing shortened (D84, D160). Asserted by confirming the attachments
    directory is unchanged after each refusal.
  - S21.6 `GET /api/sessions/:id/attachments/:turnId/:attachmentId` serves the bytes with
    `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` on **every** response,
    and echoes the stored `mediaType` only for the image allow-list — `image/png`, `image/jpeg`,
    `image/gif`, `image/webp` — serving `application/octet-stream` otherwise. Asserted with an
    upload declaring `text/html` whose body is a script: the response carries
    `application/octet-stream`, and navigating to the URL directly executes nothing.
  - S21.7 The route carries the ownership check — another operator gets `404 no_such_session`,
    never `403` (I23) — and a missing or unreadable blob is `404 no_such_attachment` with the
    envelope unaffected. A replay served from the spill after a reconnect renders the same refs,
    and the client fetches the bytes as it does on a live stream (S3.1).
  - S21.8 An adapter declaring `acceptsAttachments: false` refuses the whole message with
    `422 bad_request` naming `attachments`, and no turn starts. Asserted with a stub adapter, and
    the edge tests the capability rather than the vendor — a search of `edge/` for `claude` and
    `codex` still returns nothing (I20, S1.10).
  - S21.9 `DELETE /api/sessions/:id` removes `attachments/` with the rest, and `audit.ndjson`
    stays byte-identical (D25). This extends S5.9's list, which had no attachments to name.
  - S21.10 The client renders an allow-listed image inline under the document's existing
    `img-src 'self'` and every other type as a download naming the file and its size. The
    `filename` is a text node: an upload named `<img src=x onerror=alert(1)>` renders as literal
    characters and executes nothing (I26, D74).

Out of scope: attachments on any route other than `POST /message`; an audit record for an upload —
D160 rules there is none and S14.10 is the precedent, so a criterion asserting `audit.ndjson`
unchanged across an upload belongs here only as part of S21.9; a separate upload route and the
orphan sweep it would need (D160 rejects it); attachment support for Codex, which S21.8 makes a
declared capability rather than a promise; resending an attachment on a later turn; and any
retention rule beyond deletion with the session — attachments are a second store that grows with
operator behaviour rather than session count, which is #20's question and now covers this directory
too.

## S22 — One server per storage root

**Tier one**, and small. D161 decided it; this builds it. It exists because the single-process
premise the whole *Concurrency* argument rests on was assumed rather than enforced, and the way it
fails is silent — a corrupted audit log and another server's agents killed, neither diagnosable
from symptoms.

Delivers: Starting a second server against a storage root another server is already using refuses,
immediately and by name, instead of quietly corrupting the shared record and killing the first
server's running agents. A server whose host crashed starts again by itself, without anyone
clearing a file by hand.

Touches: `store` (`claimLock`, `releaseLock`, reading a `ServerLock`), `session-manager` (`boot`'s
new first step), `contract` (`ServerLock`, `StartupError.storage_locked`), `server.ts` (release on
clean shutdown).

Depends on: S7 — it reuses D23's liveness test, which S7.5 and S7.6 build.

Acceptance:
  - S22.1 A second server booting against a held storage root refuses with
    `StartupError.storage_locked` and a non-zero exit, and its message names the holder's `pid`,
    `hostname` and `startedAt`. The first server is unaffected: its sessions are still live and
    its children are still running afterwards, asserted by process enumeration.
  - S22.2 The claim happens **before boot's reap step**, not merely before `listen` — asserted by
    a second boot against a root whose `pids.ndjson` names live children of the first server, and
    confirming those children are still alive after the refusal (D161). This is the criterion the
    slice exists for; a lock taken after step 1 prevents nothing that matters.
  - S22.3 A lock whose holder fails D23's three-part test — an `exitedAt`, a `startedAt` earlier
    than the host's last boot, or a mismatched image — is reclaimed automatically, the reclaim is
    logged naming the stale holder, and boot proceeds. Asserted for each of the three
    independently, so a single always-stale answer cannot pass this.
  - S22.4 A lock naming a different `hostname` is **never** reclaimed, whatever its `pid` says:
    the refusal stands and says the holder is on another host. The liveness test cannot see
    another machine's process table, and reclaiming on one that it cannot see is how two servers
    over one network share both start.
  - S22.5 A clean shutdown removes the lock, and the next boot takes it without invoking the
    staleness path at all — asserted by instrumenting the reclaim and finding it uncalled.
  - S22.6 A storage root that cannot be written still fails as `StartupError.storage_unwritable`
    and not as a lock error: S7.10's case is unchanged, asserted by re-running it.
  - S22.7 The four server-wide append files and the two registries are untouched by a refused
    boot: `audit.ndjson`, `pids.ndjson`, `reviews.ndjson` and `requisitions.ndjson` are each
    byte-identical before and after, and no session's `meta.json` is rewritten.

Out of scope: an OS advisory lock (D161 rejects it — platform divergence, a native dependency, and
it cannot name the holder); a `--force` override, which is a way to do the corrupting thing on
purpose and which nothing has asked for; coordinating two servers that genuinely want to share a
root, which is a different architecture; any lock over an individual session or workspace, which
is D19's registry claim and already exists.
## S23 — Bound what one session's tool output can cost

**Tier one**, and small. D162 decided it; this builds it. It is separable from S9 because S9 has
landed and because S9.5 already built the only thing that made it hard — the absent-blob path.

Delivers: One session running something that prints enormously cannot fill the server's disk. Past
a configured budget its tool output stops being kept, while the transcript still says exactly how
much there was, so nobody is misled into thinking a command printed less than it did.

Touches: `store` (`writeToolOutput`, the per-session tally), `config` (`caps`), `contract`.

Depends on: S9.

Acceptance:
  - S23.1 A session whose stored blob bytes have reached `caps.sessionToolOutputBytes` writes no
    further blob, and the tool result is otherwise unaffected: the envelope still carries
    `truncated: true` and the true pre-truncation `bytes`, and it is byte-identical in the ring and
    in the spill (S9.1, I3).
  - S23.2 The fetch for an unwritten blob is `404 no_such_output` — the path S9.5 already
    specifies, asserted here as reached deliberately rather than by failure.
  - S23.3 **Nothing already written is ever evicted.** Over a run that crosses the budget, every
    blob written before the crossing is still fetchable afterwards, byte for byte (D162).
  - S23.4 The budget is total per session, not per turn and not per call: asserted with many small
    results summing past it, and with one large result crossing it alone.
  - S23.5 The tally survives a restart — a rehydrated session's budget reflects what is on disk,
    not a counter that reset — asserted by restarting with a session already past the budget and
    confirming no further blob is written.
  - S23.6 `attachments/` is not bounded by this cap and is not swept by it: a session past its
    tool-output budget still stores attachments normally, subject only to
    `caps.attachmentBytes` and `caps.attachmentCount` (D162, D160).
  - S23.7 The enforcement is synchronous at the write call site — no timer, no sweeper, no
    background scan. Asserted by a search of `store` finding no scheduled work over `tool-output/`.

Out of scope: an age-based sweep (D162 rejects it); evicting already-written blobs (D162 rejects
it); a deployment-wide rather than per-session budget, which needs a tally nothing holds and would
let one session exhaust every other session's allowance — the argument D53's rejected
per-deployment token budget already made; any retention rule for `audit.ndjson`, which I13 forbids
shortening.

---

## What no slice covers

Stated so it is a decision rather than an omission. Every item below is already a GitHub issue
except the last two, which nothing tracks yet.

**The two-platform gate is now S19.** It was listed here as tier-one work with no slice, on the
grounds that it is not a vertical path from an entry point to persistence. That is still true of
its shape and it is now sliced anyway — the four criteria it blocks (**S1.6**, **S5.2**,
**S7.5**, **S7.6**) cannot be checked without it, and a tier one that cannot be finished is the
worse of the two irregularities. See S19 for why the verticality rule's purpose survives.

**Questions, each already an issue:**

- **Token-level streaming** — whether `--include-partial-messages` yields usable deltas and
  whether `message.delta` survives contact with it (#13).
- **A retention rule for tool-output blobs** (#20) — **resolved by D162 and no longer uncovered.**
  A per-session byte budget refused at write, built by S23.
- **A lock file preventing two server processes over one storage root** (#21) — **resolved by
  D161 and no longer uncovered.** Taken, and built by S22; the staleness objection is answered by
  reusing D23's own liveness test rather than by new machinery.
- **An offset index** for the spill and now for `audit.ndjson` (#19).
- **Attachments on `POST /message`** — **resolved by D160 and no longer uncovered.** Designed and
  sliced as S21, which opens with a probe of whether the Claude CLI accepts non-text content
  blocks at all and stops if it does not (#22).
- **Who renders `ToolCall.summary`** — unowned between the adapter and the manager (#23).
- **`Start-AgentSession.ps1`** (#17), unreconciled against this architecture.
- **What a dragged ticket does**, and whether operator-driven assignment needs a
  definition-of-done item (#26). D52 keeps the gesture; no tier-two item is a backlog, so
  nothing here provides for it.
- **Cost per shipped PR** (#27) — **resolved by D158 and no longer uncovered.** The figure had no
  source inside this server; it is replaced by a priced-burn tile, which S20 builds. Reinstating
  the original would need a forge integration and a brief amendment.

**Untracked, found while writing this set:**

- **How a removed or retyped field in `reviews.ndjson` or `requisitions.ndjson` is migrated**
  (`20-contract.md § Unresolved` 11). Every other persisted shape gates on `meta.json`'s
  `schemaVersion`; these two files are not under it and have no discriminator to hang a rule on.
  Adding fields is safe today. It is the only `Unresolved` item with no issue behind it.
- **The prototype's trailing-30-day metrics grid and weekly timecard.** D54 kept the employee
  record whole, and D59 then recast tier two as brief items 8 to 12, none of which names either
  aggregation. S16 covers the part with a source — burn and idle over a session's own event log.
  Whether the rest is in scope, and from what data, is unanswered.

Next: run `/track` in a fresh session to open the issues for S12 to S18 and to sync the
existing ones. `/slices` does not write to GitHub.
