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
| The Claude CLI can be driven over stdio with stdin held open across a permission round trip | S1 (the wire, auto-denied), S4 (the feature), S26 (against the real binary, which no earlier slice reached) |
| The ring buffer is a strict suffix of the spill, so replay can be served from either | S3 |
| A child's whole process tree can be terminated on Windows and on Linux | S5, and S7 reuses the same mechanism |
| Codex exposes a live stream resembling its rollout schema | S8.1 |
| `audit.ndjson` can be read newest-first, bounded, with no index (D73) | S12 |
| Tier two adds two append-only files and one module and no new architecture (D65, D77) | S13, then S15 |
| One design compiles into two working behaviours across the eight surfaces `10-design.md § Platform divergence` lists | S19 |
| A process tree can still be reached from the pid of a process that has already exited | S28.1 |
| The operating system's own creation time for a process is readable, and exactly comparable, on both platforms | S29.1 |
| Watching a counter for one observation window is enough evidence of a dead holder, on the storage classes D194 supports | S30 |

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

**Twelve slices open with a stop rather than with code.** S8.1, S10.1, S12.1, S13.1, S14.1,
S15.1, S16.2, S21.1, S25.1, S26.1, S28.1 and S29.1 name a question the design, the contract, or the
vendor's observed behaviour has not answered, and each says the slice stops until it does. **Three
of them stop a second time after the probe reports** — S25.2, S26.6 and S28.2 — because a
measurement that settles what is possible does not settle what should be built, and S28.2 is that
read the other way round: a measurement finding that the contract's mechanism cannot reach where the
contract puts it does not settle where to move it. That is the shape an unresolved
input has to take here: a criterion that is checkable, because the amendment either landed or
it did not, rather than an implementer's guess wearing the amendment's clothes.

**D199's five slices are S28 to S32, and two of them are coupled.** S28 goes first: it is the one
of the five an operator meets today without misconfiguring anything, and its probe answers whether
D38's mechanism can do what I59 asks of it at all. **S29 lands before S30, and that is a
requirement rather than a preference** — the lease makes another host's `pids.ndjson` records
reachable for the first time, so a reaper with no host gate reading them looks a foreign pid up in
the local process table and kills whatever holds that number (D181). Building the lease first opens
that window and closes it in the following slice. S31 and S32 depend on neither and can be taken in
any order, before or after; S32 is the one of the five that closes a definition-of-done item.

`spike/` covers parts of S1 and S2 as throwaway proof. It is not the implementation; see
`spike/README.md § What this is not`. `spike/.data` is deleted rather than migrated
(`20-contract.md § Migration`).

---

## Landed

Every slice below has a closed GitHub issue. `/track` does not sync these — the issue already
carries the doneness signal, and re-deriving it from this document's prose is the generative
comparison `design/FROZEN.md` exists to escape. Bodies are kept in full rather than retired to a
bare index, because other slices, `10-design.md` and `90-decisions.md` cite specific criterion
ids from several of them (S1.6, S3.3, S6.5, S7.5, S7.6, S8.1 among others) and those citations
need the criterion text to resolve.

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
`--include-partial-messages` and `message.delta`, which are S25's (#13).

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
    A healthy spill produces one only for a resume point outside the session's history; a
    truncated or unwritable spill produces one for any range, after which the client
    refetches.
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

Out of scope: the spill's read direction, which D163 settles as a backwards seek from the
tail rather than an offset index (#19); the WebSocket reconnect path (S11);
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
  - S7.5 **Retired by S29 (D183, D186), and the id is kept allocated rather than removed.** It
    asserted that a `ProcessRecord` with no `exitedAt`, a `startedAt` later than the host's last
    boot and a matching process image is reaped — killing the tree — and its entry tombstoned.
    Those three tests remain, and are no longer sufficient: I19 adds a host gate ahead of them and
    an exact creation-time limb behind them, and a record whose recorded creation time is absent is
    tombstoned rather than reaped. S29.4, S29.5 and S29.6 assert the guard that replaces this. The
    assertions behind this criterion are S29's to replace, not this document's to delete.
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
specified the absent-blob path; an offset index for the spill, which D163 declines (#19);
virtualised scrollback beyond whatever S9.6 requires.

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
offset index for `audit.ndjson` — D163 declines one, and I39's bounded backwards read is why this
file never needed it (#19); any
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
    `X-Content-Type-Options: nosniff` on **every** response, and echoes the stored `mediaType`
    only for the image allow-list — `image/png`, `image/jpeg`, `image/gif`, `image/webp` —
    serving `application/octet-stream` otherwise. `Content-Disposition` follows the same
    allow-list: `inline` for an allow-listed image (so the client's `<img src>` paints it in
    every browser, including Safari/WebKit, which honors the header even on a subresource
    fetch), `attachment` otherwise. Asserted with an upload declaring `text/html` whose body is
    a script: the response carries `application/octet-stream` and `Content-Disposition:
    attachment`, and navigating to the URL directly executes nothing.
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
  - S22.3 **Retired by S30 (D180), and the id is kept allocated rather than removed.** It
    asserted that a lock whose holder fails D23's three-part test — an `exitedAt`, a `startedAt`
    earlier than the host's last boot, or a mismatched image — is reclaimed automatically, for each
    of the three independently. The lease deletes that test: liveness is decided by watching the
    holder's own counter, and S30.1 asserts the decision table that replaces it. The assertions
    behind this criterion are deleted by S30, not by this document.
  - S22.4 **Retired by S30 (D180), on the same terms.** It asserted that a lock naming a different
    `hostname` is never reclaimed, whatever its `pid` says. That rule is deleted rather than
    relaxed — it is exactly what made a recreated container's refusal permanent, since recreating
    changes the hostname and nothing ever reclaimed a foreign lock (#206) — and S30.2 asserts the
    opposite behaviour. What it was guarding against is covered instead by never consulting a
    process table.
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
## S24 — Read the spill backwards

**Tier one**, and small. D163 declined the offset index and specified the read direction instead;
this makes the tree match. S3 landed against a forward scan from byte 0, whose cost the design
accepted at the time and no longer does.

Delivers: Reopening a very long session is fast. A reconnect costs time proportional to how much
happened while the operator was away, not to everything that ever happened in that session.

Touches: `store` (`readEventsAfter`).

Depends on: S3, S9 (S24.4 reuses its long-run fixture).

Acceptance:
  - S24.1 `readEventsAfter` locates `after + 1` by reading backwards from the file's end and then
    emits forward. Every existing S3 criterion still passes unchanged — S3.1's element-for-element
    equality, S3.2's spill-served mid-turn replay, S3.4's ended session, S3.6's torn trailing line
    — asserted by re-running them, because this is a change of strategy and not of behaviour.
  - S24.2 The bytes read to serve a replay grow with the distance from the tail, not with the
    file: instrumented against one session's spill at 10 000 and at 100 000 envelopes, replaying
    from the last 100 in each, with both figures and both elapsed times stated in the slice report.
    The two byte counts should be within noise of each other, and that is the criterion.
  - S24.3 `after = 0` — a replay of the whole session — still works and is still O(file), because
    it genuinely asks for every envelope. It is not a regression and the slice report says so
    rather than reporting a bound it does not have.
  - S24.4 A torn trailing line is still dropped and logged, and the file is still not modified by
    the read (S3.6), asserted with the tear now at the point the backwards read starts rather than
    where a forward read would have ended.
  - S24.5 No offset index, sidecar or cache file is created: a search of `store` finds no second
    file written beside `events.ndjson`, and the storage layout is unchanged (D163).

Out of scope: the payroll fold's O(spill) cost, which is a fold and not a seek and which no index
or read direction changes (D147, D163); `audit.ndjson`, which already reads this way (I39); any
change to `readEventsAfter`'s signature or to the replay contract — S24.1 exists to assert there
is none.
## S25 — Token-level streaming for Claude

**Tier one's surface, but not a tier-one item** — brief item 3 is satisfied by message-granular
streaming. What this closes is an asymmetry that already exists: `message.delta` is a live envelope
kind, Codex's `app-server` transport maps `item/agentMessage/delta` onto it, and the Claude mapping
has no delta row, so one vendor streams token by token on the console's main surface and the other
does not. **It opens with a probe and carries a second stop after it** (D165).

Delivers: A Claude session's replies appear as they are written rather than arriving whole, so the
console reads the same way whichever vendor is behind it — or, if the CLI cannot do that without
disturbing the permission round trip, a written answer saying so and nothing built on a guess.

Touches: `adapters/claude` (the flag and the mapping), `contract` (only if S25.2 says deltas are
not persisted), `session-manager`, `client` (the delta renderer), `config`.

Depends on: S1, S2, S3, S4, S9.

Acceptance:
  - S25.1 A written finding, committed before any mapping code, citing the command run and its
    observed output, answering four things: whether `--include-partial-messages` emits usable
    incremental text records at all; whether those records concatenate **exactly** to the final
    `message`, which is the rule `20-contract.md § Rules the renderer may rely on` already states;
    whether the flag disturbs the `control_request` permission round trip that S1.1 and S4.2 rest
    on; and whether it disturbs `usage`, which D75 and S1.11 normalise per `message.id`. **A
    disturbance to either of the last two stops the slice outright** — neither is tradeable for
    streaming polish — and the remaining criteria are recorded blocked rather than failed.
  - S25.2 **The slice stops a second time, for a decision, before any delta is emitted**: whether a
    `message.delta` takes a `seq` and is appended to the spill, or is live-only. Both readings are
    live in the documents as they stand — the renderer rule says a client "may render either and
    must not render both", which live-only satisfies, while S1.5 asserts `seq` is contiguous from 1
    with no gaps and replay depends on it. The finding states the measured multiplier from S25.1
    against the spill, the ring (S9.7), D163's backwards replay and D147's payroll fold, and the
    ruling is `/design`'s at its own tier. This slice may not settle it by implementing one.
  - S25.3 With the flag on, every existing Claude criterion still passes unchanged, re-run rather
    than assumed: S1.3's twelve mappings, S1.5's contiguous `seq`, S1.11's per-`message.id` usage,
    S4.2's allow-and-deny round trip against a real child, and S4.3's one-resolution-per-request.
  - S25.4 Deltas for one `turnId` concatenate in **arrival order** to the `message` that follows,
    byte for byte, over a fixture of at least twenty messages including one containing multi-byte
    UTF-8 split across a chunk boundary (S1.2's hazard, at a new granularity). Arrival order, not
    `seq` order: D168 rules a `message.delta` a live-only frame that carries no `seq`.
  - S25.5 The client renders deltas or the final message and never both, picking by `turnId`, and a
    reconnect mid-message renders exactly once — asserted by disconnecting between two deltas and
    comparing the rendered text against an uninterrupted run.
  - S25.6 The flag is configuration, defaulting off, and a deployment with it off produces the
    envelope sequence this repository ships today, element for element. Token-level streaming is
    not made the only way the console works on the strength of one probe.
  - S25.7 The measured cost is stated in the slice report, not estimated: envelopes per turn with
    the flag on and off, spill bytes for the same turn both ways, and the longest browser
    main-thread task under S9.6's method.

Out of scope: token-level streaming for Codex `exec --json`, which emits no deltas of any kind
(`20-contract.md § Vendor mapping — Codex`) and where the absence is the vendor's, not ours;
`thinking` deltas, which are a second stream with the same volume question and no criterion here;
changing `MessageDelta`'s shape, which already exists and is already exercised by Codex; and
deciding S25.2 — this slice surfaces the measurement and stops.

---

## S26 — Ask before you run it, against the real binary

**Tier one, and it is brief item 4.** "Approve or deny a Claude tool-permission request, and have
the agent continue" is a definition-of-done item, and today it is met against a stand-in: S4 built
the whole approval path and S1.1, S1.9 and S4.2 are verified against a fixture CLI speaking the
documented wire shape, because at 2.1.226 the real binary emitted no `can_use_tool` at all (D88,
D96, #56). **It opens with a probe and stops a second time for a decision**, the shape S10, S21 and
S25 already take, because the premise that probe would confirm is already contradicted by this
repository's own evidence — see the note under S26.1.

Delivers: An operator supervising a Claude session is actually asked before a tool runs — the
approval prompt this console has always specified, working against the agent the operator really
runs rather than against a stand-in — or, where the agent still will not ask before some of what it
does, a written answer naming exactly which of its actions go unwatched, so nobody is told a
session is supervised when part of it is not.

Touches: `adapters/claude` (spawn arguments, and the decision path if it moves), `config`,
`session-manager` (a second entry point into the `pending` map, only if S26.6 rules one in),
`edge/*` (only if a decision reaches the server from outside the child), `contract` (a prerequisite,
not a part — S26.7).

Depends on: S1, S2, S4.

Acceptance:
  - S26.1 A written finding, committed before any transport code and before any spawn-argument
    change, citing every command run and its observed output, against the real installed CLI with
    its version named — answering whether `control_request` / `can_use_tool` fires under the flags
    this server actually spawns with, and for which tools. **The premise is already in doubt and
    this criterion settles it rather than assuming it**: D88's three probes at 2.1.226 (`Read`,
    `Bash`, `Bash` under `--permission-mode manual`) saw no prompt at all, while S25's run 4 at
    2.1.227 answered a real `can_use_tool` for `Write` and the tool then ran
    (`design/findings/S25-token-streaming-probe.md`). Two readings are open and the finding must
    name which holds: the upstream defect was fixed between those versions, or the prompt was
    always tool-dependent and neither probe set covered the other's tools. Both cannot be true, and
    the documents currently state only the first observation.
  - S26.2 **Coverage is the finding, not the round trip.** For each `--permission-mode` the CLI
    accepts, the finding lists every probed tool that prompted and every one that ran with no
    prompt, over at least `Read`, `Write`, `Edit` and `Bash`, each run to completion so that a tool
    which merely ran late is not recorded as one that ran unasked. A transport that misses a tool
    is worse than no transport, because it reports a supervised session that partly is not one, so
    a gap here is a result to be stated and not a probe to be re-run until it closes.
  - S26.3 Only where S26.1 and S26.2 leave a gap: the same finding answers whether the vendor's
    `PermissionRequest` hook fires under those same flags and whether it can carry an operator's
    decision back. **The finding qualifies the name at every use** — the vendor's hook and this
    repository's `PermissionRequest` type share it, the collision is the vendor's, and a finding
    that leaves a reader to infer which one a sentence means is not usable evidence.
  - S26.4 **The question that decides whether the hook is viable at all, answered before any of its
    details.** A hook is a separate short-lived process, not a channel on the child's stdio, so an
    operator's decision reaches it by a path this design has never specified. The finding states,
    from observation, how a decision would reach that process and whether D26's ordering — the
    audit record durable *before* the response reaches the child — survives the process boundary
    that D33 and I11 were not written against. **Where it cannot be shown to survive, the hook is
    not viable and the slice records it so**: S26.5 and the hook half of S26.6 are recorded blocked
    rather than failed, and no partial transport is built to see how far it gets.
  - S26.5 Only where S26.4 says the ordering survives: whether a hook can be injected for one
    spawned session without writing into the operator's own settings. `--settings` accepts inline
    JSON on 2.1.227 and is documented, so the mechanism looks reachable and whether a hook injected
    that way actually fires is unverified. Asserted by observing the hook fire in a spawned session
    while the operator's own settings file is byte-identical before and after.
  - S26.6 **The slice stops a second time, for a decision, before any transport changes.** Two
    questions, both `/design`'s at its own tier: whether the hook is adopted where S26.2 found a
    gap, against what it costs — a second process on the approval path, a local surface that can
    approve a tool call, and who may reach it; and whether a tool call arriving with no preceding
    approval request is surfaced to the operator at all, given the console can see one on the wire
    but has never been told to say anything about it. This slice may not settle either by
    implementing one.
  - S26.7 Any surface a hook process reaches gains a declared shape in `20-contract.md` before it
    ships. That is a contract amendment at `/contract`'s tier; this slice may not introduce a
    signature the contract does not carry, and the amendment landing is what makes this criterion
    checkable.
  - S26.8 Where S26.1 reports the round trip firing: allow and deny each round-trip to a **real**
    `claude` child, on one real tool call run both ways, with the child's subsequent output recorded
    for each — S1.1, S1.9 and S4.2 re-run against the real binary rather than the fixture, which is
    what #56 has blocked since D88 and the only thing that closes it.
  - S26.9 The fixture CLI stays and every assertion resting on it passes unchanged, re-run rather
    than assumed. A working real binary does not retire the deterministic test path: D88 chose it
    for reproducibility, not only for the defect, and both suites green is the criterion.
  - S26.10 The ordering guarantees are asserted against the real binary and not only against the
    fixture: the `AuditRecord` is fsync'd before the response reaches the child (I10, D26), the
    `pending` delete is synchronous with the lookup so two answers in one tick produce exactly one
    audit record and exactly one write (D33, S4.5), and every request has exactly one resolution
    over a run containing at least three (I9, I11).
  - S26.11 Any change to what this server spawns is configuration, defaulting to what it spawns
    today: a deployment with the new setting off produces the same argument vector and the same
    envelope sequence, element for element. The permission path is not re-pointed on the strength of
    one probe.

Out of scope: **Codex, and D5.** A restored Claude round trip is what D5 already assumes — D5 makes
Codex `preauthorised` because Codex's runtime prompt is unreachable on `exec --json`, and says
nothing this evidence touches. It is worth naming because "a runtime approval path was found" reads
exactly like D5's own reversibility clause and is not it. Also out: standing rules and the matcher
(S10 owns the grammar, and an auto-answer enters by the same path and needs no second one);
**auditing the operator's own hooks**, which already run inside every session this server spawns and
are already visible on the wire the adapter reads, a live property of today's build that is staged
in `design/90-decisions.md § Open` and is its own issue whichever way this probe goes; fixing
anthropics/claude-code#34046 or acting on `--permission-prompt-tool stdio` being accepted at 2.1.227
while absent from `--help` — the probe records that, and what to do about an undocumented flag the
permission path depends on is a decision, not a fix; inventing the shape of any surface a hook
process would reach; and retiring the fixture CLI.

## S27 — Stop the server without leaving an agent behind

**Tier one**, and small. D174 to D178 decided it; this builds it. It exists because the stop path
that ships today cannot finish while anyone is watching a session, and because a terminal's Ctrl-C
reaches this server and not the agent it spawned.

Delivers: An operator who stops the server — with Ctrl-C, or by stopping the deployment — gets a
stop that actually finishes, even while they or a colleague have a session open and streaming,
instead of one that hangs until something harder kills it. No agent is left running on their
machine afterwards with nobody watching it and nothing reading what it does, and pressing stop a
second time gets out at once rather than waiting again.

Touches: `server.ts` (the six ordered steps), `session-manager` (one new method, and the mute on
its own notification sink), `store` (`appendPid` for the tombstone, unchanged), `contract` (no new
type).

Depends on: S3 (a force-closed subscriber's reconnect is served from the spill), S5 (the kill
mechanism, and the interrupt path this must not use), S7 (`pids.ndjson`, tombstones, and the tree
kill this reuses), S22 (`releaseLock`, and the ordering this puts it last in).

Acceptance:
  - S27.1 A second `SIGTERM` or `SIGINT` arriving during a shutdown exits immediately with a
    non-zero code and runs no step below the guard — asserted by sending it during a deliberately
    stalled drain, then confirming `server.lock` is still present and the turn's child is still
    running afterwards by process enumeration (D174).
  - S27.2 After the first signal the listener is closed: a new connection is refused, so no session
    and no turn can be created. A request already accepted when the signal arrived still completes
    and returns its normal response.
  - S27.3 With one event stream open and a subscriber that never disconnects, the process still
    reaches exit `0` within the drain bound, and the server closes that stream. This is the
    criterion the slice exists for: the same test against today's build hangs until the harness
    times it out (I54, D176).
  - S27.4 A subscriber force-closed by the drain loses nothing. After a restart, a reconnect
    carrying the last `seq` it saw receives every envelope from that watermark to the spill's tail,
    contiguous and with no `error / replay_gap` (D40).
  - S27.5 **Every** live turn's child tree is dead after exit, not one of them — asserted with two
    sessions each holding a live turn, each having spawned a grandchild, and process enumeration
    finding all four gone (I4, D177).
  - S27.6 Shutdown writes nothing to any spill and emits no envelope. Asserted with a live turn
    holding at least two outstanding permission requests at signal time — the case that would
    otherwise append one `permission.resolved` each and a `turn.ended` — by byte-comparing every
    session's `events.ndjson` before the first signal and after exit and finding them identical
    (I52, D177).
  - S27.7 The mute is at the notification sink and not on the `exited` handler. With all four
    `AdapterNotification` kinds instrumented, zero are delivered to a handler from the moment the
    shutdown method is entered. The negative case is asserted too: the same suite run against a
    mute placed in the `exited` handler fails, because the adapter's `turn.ended` follows `exited`
    as a second notification inside the same synchronous callback (I55, D178).
  - S27.8 One `ProcessTombstone` per child killed is appended at the moment the kill is issued, not
    in response to an exit — asserted by driving shutdown with the child's exit notification
    suppressed and finding the tombstone already written.
  - S27.9 A `spawned` notification arriving after the mute is dropped, so that child gets no
    `pids.ndjson` entry and is owed no tombstone — and it is killed all the same, asserted by
    process enumeration after exit (D178).
  - S27.10 `server.lock` is removed only after the kill step has completed — asserted by
    instrumenting both and confirming every kill's completion precedes the removal. A release that
    cannot finish within its bound leaves the file rather than holding the exit (I53, D175).
  - S27.11 Past the guard, no step can prevent the exit: with the tombstone write forced to fail,
    the failure is logged, the lock is still released, and the process still exits `0`. No error
    union gains a variant.
  - S27.12 S22.5's assertion now holds with an operator watching. A clean shutdown taken with a
    subscriber attached removes the lock, and the next boot takes it with the reclaim path
    instrumented and found uncalled — which S22.5 could only demonstrate when nobody was connected.
  - S27.13 Shutdown never reads `pids.ndjson` to choose what to kill: an entry with no `exitedAt`
    naming a live process this manager does not hold is untouched, and that process is still
    running after exit. Collecting it stays boot's reap (D177).
  - S27.14 The `shutdown` declaration lands in the tree, and the placeholder block carrying it in
    `20-contract.md § Public surface § session-manager` is deleted in the same commit — the block
    itself instructs this, since the pointer opening that section already names the file.
  - S27.15 The store close is step 5 and survives this slice's rewrite of the shutdown path:
    `store.close()` is entered only after step 4 has returned, asserted by instrumenting both, and
    the process still exits `0`. A close that throws is logged and changes neither the exit code nor
    any earlier step, like every step past the guard. **Introducing the close is not this slice's** —
    D202 routes it to `/fix` against today's path — and what this asserts is that the rewrite keeps
    it, and keeps it behind the one act a successor can observe (D202, I53).

Out of scope: **finalising anything.** No session is marked ended, no open turn is closed on disk,
and no `session.notice / server_restart` is written — every one of those is boot's, and duplicating
it here is the single thing D174 exists to refuse, made tempting by the fact that Ctrl-C is what a
developer exercises and the crash path is not. Also out: routing the kill through
`SessionManager.interrupt`, which would emit `turn.ended` under a stop reason D24 reserves for the
operator's own act (D177); a clean-shutdown marker for boot to trust, rejected by D174 because it
selects between two repair paths on a file that is absent exactly when it is most needed; promoting
either the drain bound or the release bound to a `Config` field, which is a contract amendment and
not this slice's (they are module constants beside the existing one); adding anything to `Adapter`,
which gains nothing here on purpose (D178); liveness and readiness endpoints for a proxy to probe,
which are their own issue; and doing anything about a `ckpt.git/index.lock` a dying process leaves
behind — the next turn's checkpoint already fails it with a warning and proceeds, and nothing
further is owed. Running this slice's suite on the second platform is **S19's**, not this one's.

## S28 — Nothing the agent starts outlives its turn

**Tier one**, and a live defect rather than an addition. D184 decided it; this builds it. Ordinary
completion — the overwhelmingly common way a turn ends — is the one of four end paths that does not
end the process tree its child rooted, so a tool that starts something in the background leaves it
running while the console reports the session idle, the workspace claim released and the next
session admitted. **It opens with a measurement and carries a second stop after it**, because the
mechanism the contract names may not be able to do what the contract asks of it on one of the two
platforms.

**Both stops have now fired and both are answered, so the slice resumes at S28.3.** S28.1's finding
is committed (`design/findings/S28-tree-reachability.md`) and it reports the tree **unreachable**
after the child's exit on Windows — `taskkill /PID <exited pid> /T /F` fails at target resolution
and never begins `/T`'s walk — so S28.2 stopped correctly. D201 answered it: the kill moves ahead of
the child's exit, to the `result`, and I59 stays unconditional. The criteria that answer to that
move are S28.9 to S28.11; **S28.3 to S28.8 are unchanged and none of them is retired.**

Delivers: An operator whose agent starts something in the background — a development server, a file
watcher, a long test runner — has it stopped when the turn stops, instead of finding it still
running afterwards with nobody watching it. Rolling the folder back then works, instead of failing
on a file something invisible is holding, and the next person to open that folder is not competing
with it.

Touches: `session-manager` (the turn's end path, and the tree-kill helper it already holds),
`adapters/*` (the close path, which today notifies and clears without terminating). No new type —
the contract already carries the invariant.

Depends on: S1, S5 (the one kill mechanism), S6 (the restore this exists to protect), S7 (boot's
reap, which already uses that mechanism).

Acceptance:
  - S28.1 A written finding, committed before any change to the turn's end path, citing the command
    run and its observed output on each supported platform: **whether a process tree can still be
    reached from the pid of a process that has already exited.** The contract puts this kill on the
    normal-completion path, which runs after the CLI child's own exit, and D38's Windows mechanism
    "resolves the tree from the live process table at kill time" — from a pid that is by then gone.
    The finding spawns a child, has it spawn a detached grandchild, waits for the child to exit,
    issues the kill, and reports whether the grandchild died. POSIX and Windows are recorded
    separately with the OS version named, because the two mechanisms are different and only one of
    them is in doubt.
  - S28.2 **The slice stops for a decision where S28.1 reports the tree unreachable after the
    child's exit.** Where the kill is issued is `/design`'s and `/contract`'s: the contract has it
    run "before `turn.ended` is emitted and before the turn slot is cleared", and moving it earlier
    — to the `result` record, before the child is allowed to exit — changes what the adapter owes
    and when a turn is considered over. This slice may not settle that by implementing one of them,
    and a half-platform invariant is not I59.
  - S28.3 A turn whose tool started a detached grandchild ends with that grandchild gone: process
    enumeration once `turn.ended` is observable finds it absent. Asserted on the
    **normal-completion** path — a `result`, then the kill, then the child's exit as its consequence
    (D201) — which is the path that does not kill today. **Do not wait for the child to exit on its
    own before asserting**: that sequence is what S28.1 measured as unreachable on Windows, and
    S28.9 is where the ordering itself is checked.
  - S28.4 The kill completes before `turn.ended` is emitted and before the turn slot is cleared,
    asserted by instrumenting all three in order, so a caller that reacts to `turn.ended` by
    requesting a restore cannot race a surviving descendant.
  - S28.5 One mechanism, not two: the same helper boot's reap and `interrupt` already call is
    entered on each of the four paths a turn can end by — normal exit, interrupt, adapter failure
    and shutdown — asserted by a call count per path rather than by reading the code.
  - S28.6 A turn that spawned nothing, and a turn whose child is already gone, both end normally:
    exactly one `turn.ended`, no extra envelope, no notice, and the kill is a no-op rather than a
    failure.
  - S28.7 The capability this costs is asserted rather than assumed: a turn told to start a server
    and report its address ends with that server dead, and the transcript is unchanged — no new
    envelope kind, no new `stopReason`, no notice. The loss is silent by decision (D184), and a
    test naming it is what stops a later reader from filing it as a bug.
  - S28.8 The suites S5, S7 and S27 already own re-run green unchanged: interrupt still ends a turn
    under its own stop reason, boot's reap still tombstones what it kills, and shutdown still writes
    nothing to any spill.
  - S28.9 On the normal-completion path the kill is issued while the child is still alive:
    instrumented, the kill is entered at the `result` and precedes the child's own `close`, and the
    child's exit arrives behind it. Asserted as an ordering and not as an outcome, because the
    outcome S28.3 checks is reachable on POSIX from either placement and this is the placement that
    makes it reachable on Windows too (D201, I59).
  - S28.10 A child's exit status is not diagnostic behind a `result`: a turn whose child exits
    non-zero, and one whose child dies under a signal, both end with the outcome the `result`
    established — the same `turn.ended`, the same stop reason, no new envelope kind and no notice.
    Asserted for both, because the server's own kill is what produced the status and a turn that
    completed must not be reported as one that failed (D201).
  - S28.11 The obligation is the manager's path and not one vendor's close handler: a fixture
    adapter that emits a `result` and holds its child open indefinitely has its tree killed just the
    same, and its turn ends. Asserted against that adapter rather than against Claude's, because
    D201 makes surrendering the tree at `result` an obligation every later adapter inherits, and an
    assertion that only ever runs through one adapter cannot show where the obligation lives.

Out of scope: a liveness check before a restore or before the workspace claim is released, which
D184 rejects — the claim may not become conditional on something no component can observe; keeping
a deliberate background process alive past its turn, which is the capability D184 spends and which
cannot be had back without that check; changing D38's mechanism, which this slice reuses and does
not touch; and **the second platform's suite, which is S19's** — S28.1's finding covers both
platforms because the value it measures is the platform's own, and that is a different thing from a
gated suite.

## S29 — The reaper knows whose process it is, and which one

**Tier one**, and it lands before S30. D181, D183 and D186 decided it; this builds it. Boot's reap
guard has three limbs and both of the missing two were adjudicated: one because the lease S30 builds
makes another machine's process records readable for the first time, the other because a host that
reuses a process number within one boot for another child of the same name defeats all three limbs
at once — and in a console whose every child is named `claude` or `codex`, that is not a remote
case. **It opens with a measurement**, because the fourth limb reads a value no platform exposes to
this runtime directly.

Delivers: A console starting up after a crash no longer risks killing an unrelated program that
happens to have been given the same process number as an agent it once ran. Where two consoles
share one storage folder, neither touches anything the other machine started. Where the console
cannot be certain a process is the one it recorded, it leaves it alone and writes down that it did,
rather than guessing.

Touches: `contract` (`ProcessRecord` gains the host that spawned it and the operating system's own
creation time for it), `store` (the spawn append and the open-record fold), `session-manager` (the
capture at spawn, and the reap guard, which stops being shared with the lock's).

Depends on: S1, S5, S7 (the guard and the file this grows).

Acceptance:
  - S29.1 A written finding, committed before any change to `ProcessRecord`, citing the command run
    and its raw output on each supported platform: whether the operating system's own creation time
    for a just-spawned child is readable at all, and whether reading it twice for one live process
    yields **byte-identical** values — which is what an exact-equality limb requires and what a
    coarse or recomputed reading would not give. The OS version is named. **The slice stops where
    either platform cannot produce a stable exact value**: a limb that never matches makes the
    guard's fail-closed behaviour universal, so nothing is ever reaped and every orphan is left to
    an operator by hand, which is a different bargain from the one D183 struck and is not this
    slice's to accept.
  - S29.2 A record naming another host is neither reaped nor tombstoned. Asserted with a record
    whose host is a foreign string but whose pid, image and timings all name a **live local
    process** — D181's coincidence — which is still running afterwards, with `pids.ndjson`
    byte-identical: no tombstone was appended either.
  - S29.3 A record written before the host field existed is read as this host's and takes the
    ordinary guard, asserted against a `pids.ndjson` holding lines in the previous shape. This is
    the migration D181 chose over the conservative reading, which would strand one generation of
    real orphans on bare metal.
  - S29.4 The fourth limb rejects same-boot pid reuse: a record whose recorded creation time differs
    from the live process's is logged and tombstoned, never killed. Asserted against a live local
    process that passes all three original limbs — no exit recorded, a `startedAt` after the host's
    last boot, a matching image — and which is still running afterwards.
  - S29.5 The guard fails closed at both ends, asserted independently so one always-null answer
    cannot satisfy both: a record whose recorded creation time is absent is tombstoned and logged,
    never reaped; and a record whose live counterpart's creation time cannot be read is tombstoned
    and logged, never reaped.
  - S29.6 A record passing all five limbs is still reaped — tree killed, then tombstoned — in the
    same suite. This is the negative control on S29.2, S29.4 and S29.5: without it, a guard that
    refuses everything passes all three.
  - S29.7 A capture failure at spawn costs nothing but the guard: the child runs, its line is
    appended with the creation time absent, no envelope and no notice is emitted, and the turn is
    indistinguishable from one where the capture succeeded.
  - S29.8 The reap guard is no longer shared with the lock's liveness probe (D193). The probe `boot`
    hands `claimLock` is unchanged in behaviour, and S22.1, S22.2, S22.5, S22.6 and S22.7 re-run
    green — S30 is what retires that probe, and this slice must not leave a lock decision reading
    limbs written for a process record.
  - S29.9 The open-record fold still never hands back a tombstone as an open record, now with two
    more fields to lose: a pid whose latest line is a tombstone is absent from the open set, and one
    whose latest line is a spawn carries all five guard inputs from that spawn line and none from
    any tombstone.

**S7.5 stated the three-limb guard, and this slice gives the guard five.** It read "a
`ProcessRecord` with no `exitedAt`, a `startedAt` later than the host's last boot and a matching
process image is reaped"; after this slice, such a record whose recorded creation time is absent is
tombstoned instead — a landed criterion contradicting `20-contract.md`'s I19, which outranks it.
**S7.5 is marked retired by this slice**, on the same terms S30 retires S22.3 and S22.4: the id
stays allocated at the head of its own line, is never reused, and S7.6 still reads against the
three tests it names. S7.6 itself is untouched and remains true — a record failing any one test is
logged and tombstoned rather than killed — over five tests now rather than three.

Out of scope: `server.lock` in every respect — S30 owns the lease, the probe's retirement and the
decision table; reaping another host's orphans, which D181 states stays that host's own next boot
and is the residual it accepts; closing the window between a spawn returning and its line landing,
which D23 and D38 both accept; and re-asserting S7.6, which this slice leaves standing. Running
this slice's suite on the second platform is S19's; S29.1's finding covers both platforms because the value it reads is the
platform's own.

## Outstanding

Slices below have no closed issue, or an issue reopened because it was closed with unticked
`Done when` boxes. `/track` syncs these normally.

## S30 — The storage lock becomes a lease

**Tier one**, and the largest of the five. D180 decided it and D193 to D196 finished it; this builds
it, and it is what #206 was closed without. **It cannot be split**: a claim that reclaims on an
unmoving counter, with nothing renewing, declares every live holder dead one observation window
after it starts, so the two halves are one slice or a regression.

Delivers: A console that gets redeployed — its container recreated, its service reinstalled —
starts again by itself, instead of refusing forever because the machine now answers to a different
name. Two consoles pointed at one storage folder still cannot both run. One that has been taken
over while it was stalled notices, stops, and does not delete its replacement's claim on the way
out.

Touches: `contract` (the lock gains an identity for the run and a counter; a startup refusal for a
damaged lock; the liveness probe retires; `store` gains a renewal method and `claimLock` loses a
parameter), `store` (the decision table, the renewal, the ownership-checked release, and the two
constants), `session-manager` (boot's first step, which now hands `store` nothing), `server.ts` (the
renewal clock, the displaced stop, where renewal is cancelled, and the failed-bind path, which
reaches the same release).

Depends on: S7, S22 (the lock this replaces), S27 (shutdown's five steps, whose step 4 is where
renewal is cancelled), S29 (the reaper's host gate, which must be in place before a foreign host's
records can be read).

Acceptance:
  - S30.1 Each row of `claimLock`'s decision table asserted independently: an absent lock is claimed
    **with no wait**, measured as a boot completing in well under one observation window; a lock
    whose identity-and-counter pair changes across the window is refused with `storage_locked`
    naming the holder's pid, hostname and start time; a pair unchanged across the window is
    reclaimed with the stale holder logged; and a lock that will not parse is refused with
    `storage_lock_corrupt` naming the path.
  - S30.2 **A lock naming a different hostname whose counter is not moving is reclaimed, and boot
    proceeds.** This is the criterion the slice exists for and the defect #206 was opened on: under
    the rule this replaces, recreating a container changed the hostname and nothing ever reclaimed
    a foreign lock, so the refusal was permanent.
  - S30.3 A lock written before the lease — well-formed, carrying no counter — reaches the reclaim
    path by the ordinary rule and is not treated as corruption. The refusal is keyed on parsing and
    never on an absent field, and this is the deployment the migration story exists for.
  - S30.4 No wall clock is compared anywhere in the decision. Asserted by stepping the system clock
    an hour backwards during one observation window and an hour forwards during another, and
    finding both decisions unchanged.
  - S30.5 A live holder is never declared dead: with one server running and renewing, three
    consecutive boots each observe the counter move and each refuse.
  - S30.6 The renewal interval and the observation window are declared in one file, the interval is
    exported and the process's clock imports it rather than declaring a second copy, and a test over
    the two imported values fails if the interval ever stops being at most a third of the window.
    Violating that relation has no other symptom short of two servers over one storage root.
  - S30.7 Every write publishes the file whole, and the claim additionally loses a race it did not
    win: two boots racing on one absent lock produce exactly one claim, and the loser takes the
    refusal path rather than overwriting. A reclaim and a renewal go through the same
    atomic-rename helper `meta.json` already uses.
  - S30.8 Release is an ownership check. A server whose lock was reclaimed and rewritten by a
    successor removes nothing at shutdown, and the successor's lock file is byte-identical
    afterwards.
  - S30.9 A renewal reports `displaced` — a success, not an error — when the lock is absent and when
    it carries another identity, and reports a storage error only when the renewal could not be
    attempted at all. All three asserted; conflating the first two with the third is what would let
    a caller carry on past the one outcome no caller may carry on past.
  - S30.10 A displaced holder stops by running shutdown's ordinary steps and exits non-zero: its
    live turns' children are killed and tombstoned, the successor's lock is untouched, and its
    renewal timer stops at once rather than at step 4.
  - S30.11 A shutdown that still holds the root keeps renewing through the drain and the kill and
    cancels renewal as step 4's first act — asserted by instrumenting both and finding at least one
    renewal between the first signal and the kill step's completion. A timer cancelled any earlier
    lets a successor reclaim a root still being written to.
  - S30.12 No decision reads the lock's pid, hostname, start time or image. Asserted by
    instrumenting those four reads and finding the only reader is the text of the refusal (I57).
  - S30.13 S22.1, S22.2, S22.5, S22.6 and S22.7 re-run green unchanged. **S22.3 and S22.4 are
    retired by this slice** and the assertions behind them deleted, because each states the rule
    D180 removes; their ids stay allocated and are never reused.
  - S30.14 A refused boot has still written nothing server-wide, on the corrupt-lock row as well as
    the held one: the four server-wide append files are byte-identical before and after, no
    session's `meta.json` is rewritten, and the reap step did not run.
  - S30.15 The failed-bind path releases through this slice's ownership check and runs nothing else.
    A server whose `listen` fails before it ever bound — asserted against a port already held —
    removes the lock its own boot claimed, exits non-zero, and reaches neither the drain nor the kill
    step, both instrumented and found uncalled. **Introducing this path is not this slice's** —
    #207 built it and I53 now states it — and what this asserts is that rewriting `releaseLock` into
    an ownership check keeps it, on the one path where the ordinary preconditions for a release
    cannot be met: no listener ever opened and no turn ever started (I53, D199).
  - S30.16 A server that never bound issues no renewal after its error path is entered, asserted by
    instrumenting `renewLock` and finding no call from that moment to exit. Where the clock is
    started only on `listening` this holds with nothing to cancel; the criterion states the outcome
    and not the placement, so either implementation satisfies it and neither can leave a timer
    renewing a lock for a process that is not serving.

Out of scope: introducing the failed-bind path, which #207 already built and which S30.15 and
S30.16 assert this slice's rewrite keeps rather than re-deciding — the invariant behind it is
amended and landed, so D199's routing of it to `/contract` is spent; correcting the design's three
surviving statements that a network-share storage root is
supported, which D199 routes to `/design`; a network-share root itself, out of supported scope until
a gate exercises one (D194); an OS advisory lock and a `--force` override, both already refused by
S22; coordinating two servers that genuinely want to share a root; promoting either constant to a
deployment setting, which is a contract amendment; the reap guard, which is S29's; and fencing
outside the storage root, which is the dependency D7 kept out and the only thing that would close
the residual. Running this slice's suite on the second platform is S19's.

## S31 — Storage may not live inside a workspace

**Tier one**, and small. D185 decided it; this builds it. It exists because nothing compared the
server's own storage tree against the roots it admits sessions in, so a deployment can put its
records where a checkpoint's `add -A` ingests them and a rollback deletes them — including the audit
log that exists to be beyond the reach of whoever it indicts.

Delivers: A deployment that would keep the console's own records inside a folder it also hands to
agents is refused at startup, by name, instead of starting and then losing the record of what the
agent did the first time somebody rolls that folder back.

Touches: `config` (the storage root is normalised the way the workspace roots already are, and then
checked against them), `contract` (the storage root stops being a raw string), `jail` (nothing new —
the one containment predicate gains its second caller).

Depends on: S1 (the jail and its normalisation), S2 (configuration loading, and the startup refusal
this is shaped after).

Acceptance:
  - S31.1 A storage root that equals a workspace root, sits inside one, or contains one is refused
    with `ConfigError.invalid_field` naming the field and the root it collides with. All three
    containment relations asserted independently — an equality-only check passes two of them.
  - S31.2 The refusal is at startup and nothing is listening: asserted by a non-zero exit with no
    port bound, rather than a server that goes on to serve the workspaces that happen not to
    collide.
  - S31.3 The collision is found through spelling and not only through a literal match, because the
    storage root now goes through the same normalisation the workspace roots already get: a `..`
    traversal, a symlink whose target is inside a workspace root, and on Windows a case variation
    and an 8.3 short name are each refused.
  - S31.4 No error variant is minted: `ConfigError` is unchanged and the refusal reuses the
    invalid-field variant. A variant whose only caller is this one check is a surface this refusal
    has no standing to add.
  - S31.5 A non-overlapping configuration is untouched: a storage root that is a sibling of a
    workspace root starts normally, and every existing configuration test passes unchanged.
  - S31.6 The containment predicate is the jail's and there is still exactly one, with two callers
    and no others — the workspace busy check and this one. Asserted at the call sites rather than by
    searching for a duplicate implementation.
  - S31.7 Nothing downstream notices the type change: a full session round trip — meta, spill,
    blobs, audit, pids, the shadow git directory and both record logs — writes to the same paths as
    before, asserted by comparing the on-disk layout against a run taken before the change.

Out of scope: refusing per session instead of at startup, which D185 rejects — one loud failure
beats a quiet partial one, and what is at risk here is server-wide evidence rather than one
session's files; overlap between two workspace roots, which is a different question nothing has
asked; the live sessions' `cwd` busy check, which is D30's and already exists; and anything about
where a child process may reach once running, which the jail has never governed. Running this
slice's suite on the second platform is S19's.

## S32 — Say what the rollback did not reach

**Tier one, and it finishes brief item 6.** "Roll the workspace back … and be told what the rollback
could not reach" is a definition-of-done item, and only the first half is built: the exclusion of
ignored paths is deliberate and symmetric, and it is silent. D182 and D187 decided the report; this
builds it.

Delivers: An operator rolling the project folder back is told which of the excluded files — the
environment file, the build output, the dependency folder — changed since the point they rolled back
to and were left standing. Where the console cannot work that out, it says so, rather than showing
the same clean success it shows when nothing differed.

Touches: `contract` (the manifest, its entries, one difference, and what a restore returns),
`checkpoints` (capture alongside every checkpoint, and the comparison at restore), the restore
route, `client` (the two answers, which must not render alike).

Depends on: S2, S6 (checkpoints, restore, and the safety checkpoint this return type now carries).

Acceptance:
  - S32.1 Every checkpoint writes a manifest beside it holding one entry per line of the
    ignore-matching status, each carrying a workspace-relative POSIX path, whether it is a file or a
    collapsed directory, a size absent exactly for a directory, and its own modification time.
    Asserted against a workspace holding both an ignored file and an ignored directory, where the
    directory contributes exactly one entry however many files sit beneath it.
  - S32.2 No entry carries content or a digest of it: a known byte string written into an ignored
    file appears nowhere in the manifest, and a 60 000-file ignored dependency tree still produces
    one entry. Size and modification time are what make a change detectable without the bytes.
  - S32.3 A capture failure never fails the commit: with the status command forced to fail, the
    checkpoint returns normally, appears in the list, writes no manifest, and emits no envelope and
    no notice.
  - S32.4 A restore returns the safety checkpoint it took on the way in and never the target —
    asserted by restoring that safety checkpoint and getting the pre-restore state back, which is
    S6.4 re-run against the return type this slice grows.
  - S32.5 The report names the differences and only the differences: an ignored file edited since
    the target reads as modified, one created since reads as added, one deleted since reads as
    removed, and one untouched appears in neither the report nor as a false positive. All four in
    one workspace, in one assertion.
  - S32.6 Unknown is `null`, and all three routes to it are asserted independently: the target
    predates this mechanism and has no manifest; the manifest is present and will not parse; the
    status command fails at restore time. None of the three yields an empty report.
  - S32.7 An empty report is the positive answer and is distinguishable from unknown both on the
    wire and on the screen: the route's JSON carries an empty array in one case and a null in the
    other, and the console renders them as two different sentences. A renderer showing both as a
    clean restore puts back exactly the silence this slice exists to break.
  - S32.8 The report gates nothing. With the manifest deleted, corrupt, or reporting differences,
    the restore itself is identical: the same files on disk compared by recursive hash, the same
    success response, the same envelopes. No error variant is added at either end.
  - S32.9 The report runs last and can neither delay nor prevent a restore: instrumented, it is
    entered after the verification pass, and a restore whose report throws still succeeds and
    returns unknown.
  - S32.10 A verification pass that comes back dirty still fails the restore the way it does today —
    the non-fatal `error / checkpoint_restore_failed` and the `500 checkpoint_failed` — and carries
    no report. S6.11 re-run unchanged.
  - S32.11 Deleting a session removes its manifests along with its shadow git directory. S6.10
    re-run, extended to the new directory.
  - S32.12 The collapsed-directory blindness is asserted rather than left in prose: an edit inside
    an ignored directory that does not move that directory's own modification time is **not**
    reported, and the test says so by name. This report is a pointer and not evidence, and the
    difference is invisible at the call site.
  - S32.13 Every path in the report reaches the page as a text node and never as markup (I26),
    asserted with an ignored file whose name carries angle brackets and a quote.

Out of scope: recording content or a hash per ignored path, which D187 rejects as the widening the
brief declined arriving by the back door; making the report a gate, a control, or a precondition on
anything, which I58 forbids and which is why the blindness is stated where the call site is;
checkpointing or cleaning ignored paths, which the brief itself excludes and which this slice does
not touch in either direction; a git note or `meta.json` as the manifest's home, both rejected by
D187; and reporting ignored paths anywhere but a restore. Running this slice's suite on the second
platform is S19's.

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
  whether `message.delta` survives contact with it (#13) — **resolved by D165 and no longer
  uncovered.** Sliced as S25, which opens with that probe and stops a second time for whether a
  delta is persisted at all.
- **A retention rule for tool-output blobs** (#20) — **resolved by D162 and no longer uncovered.**
  A per-session byte budget refused at write, built by S23.
- **A lock file preventing two server processes over one storage root** (#21) — **resolved by
  D161 and no longer uncovered.** Taken, and built by S22; the staleness objection is answered by
  reusing D23's own liveness test rather than by new machinery.
- **An offset index** for the spill and for `audit.ndjson` (#19) — **resolved by D163 and no
  longer uncovered.** Declined: the audit read already walks backwards under a scan budget, the
  spill takes the same technique, and the fold that scans most often is one no index could help.
- **Attachments on `POST /message`** — **resolved by D160 and no longer uncovered.** Designed and
  sliced as S21, which opens with a probe of whether the Claude CLI accepts non-text content
  blocks at all and stops if it does not (#22).
- **Who renders `ToolCall.summary`** — unowned between the adapter and the manager (#23).
- **`Start-AgentSession.ps1`** (#17) — **resolved by D164 and never belonged on this list.** It is
  development tooling, not a product component, so no slice covers it for the same reason no slice
  covers `Test-DesignDrift.ps1`.
- **What a dragged ticket does**, and whether operator-driven assignment needs a
  definition-of-done item (#26). D52 keeps the gesture; no tier-two item is a backlog, so
  nothing here provides for it.
- **Cost per shipped PR** (#27) — **resolved by D158 and no longer uncovered.** The figure had no
  source inside this server; it is replaced by a priced-burn tile, which S20 builds. Reinstating
  the original would need a forge integration and a brief amendment.

**Untracked, found while writing this set:**

- **How a removed or retyped field in `reviews.ndjson` or `requisitions.ndjson` is migrated**
  (`20-contract.md § Unresolved` 11, #49) — **resolved by D200 and no longer uncovered.** Both
  files are additive-only, and a shape change the additive rules cannot absorb renames the file,
  so the filename is the discriminator they had nowhere else to carry (I63). No slice covers it
  because there is nothing to build. It is tracked by #49, not untracked as this listed it.
- **The prototype's trailing-30-day metrics grid and weekly timecard.** D54 kept the employee
  record whole, and D59 then recast tier two as brief items 8 to 12, none of which names either
  aggregation. S16 covers the part with a source — burn and idle over a session's own event log.
  Whether the rest is in scope, and from what data, is unanswered.

Next: run `/track` in a fresh session to open the issues for any slice above that still has none,
and to sync the existing ones — including the criteria appended to S27 and S28 by the previous pass
and to S30 by this one, all of them additions at the next free id rather than drift. **This pass
appended two criteria and wrote no new slice**, which is the finding rather than a short run: every
decision through D204 already has a home, and the one thing that had fallen through was I53's
failed-bind clause, excluded by S30 while its `/contract` amendment was pending and left uncovered
once that amendment landed. **#206 is not reopened**: D199 asked for it, D204
settled that it stays closed, and #272 is the artifact holding S30 outstanding against the current
slice text. `design/90-decisions.md § Open` is empty, so nothing needs clearing from it this pass.
`/slices` does not write to GitHub.
