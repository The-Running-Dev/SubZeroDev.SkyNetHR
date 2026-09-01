# Contract — SkyNet HR

Derived from `10-design.md`. Where this document and the code disagree, one of them is a
defect — say which, do not reconcile silently.

The governing rule from the design: **no vendor string above the adapter layer.** Every type
here is vendor-neutral except the three vendor-minted opaque identifiers named in
`10-design.md § Data model — Identity spaces`. `raw` exists for debugging and must never be
rendered.

**The design has two tiers and so does this document.** Everything unmarked is tier one.
Structures marked **(tier two)** are the operator's working surfaces admitted by D53 to D55
and D58; they are binding scope, and they are separable — tier one is finishable without any
of them (D59).

## Shape lives in the tree; this document carries meaning

**A declaration written here and present in `src/` is two copies, and this one is the copy
that rots.** So where a type or a signature is materialised, this document names the file
that declares it and states only what a declaration cannot express: which fields are
meaningful under which state, what must never be normalised away, what a caller may rely on,
what it must never do. That is the part no parameter list can carry, and it is the reason
this document exists.

**Where the code does not exist yet there is nowhere else for shape to live**, so it is
written here as a scaffold — a full declaration in the project's language, types and
signatures only, no bodies — and **the slice that materialises it replaces the scaffold with
a pointer in the same commit**. That replacement is descriptive drift corrected where it is
found (`AGENTS.md` *Hard rules*), not a contract amendment, and it needs no approval. It is
one-way: a later pass never turns a pointer back into a scaffold.

`FrameKind` and `Frame` are declared in `src/contract/index.ts`, next to `Envelope` (S25).

**A comment in the tree is not the canonical statement of a rule.** The declarations in
`src/contract/index.ts` carry explanatory comments, many of them copied from earlier
revisions of this document. They are a convenience for a reader already in the file; the
binding statement is here, and a comment that disagrees with this document is the defect.

Language is TypeScript, per `00-brief.md § Constraints`.

## Types

Every type below is declared in **`src/contract/index.ts`**, which is the `contract` module
of `10-design.md § Module boundaries`: the normalised vocabulary, depending on nothing, and
leaving nothing behind at runtime except the single enumeration `RATINGS` (D150). `VENDORS` is
the other runtime enumeration in this contract and it is **not** here — it lives in `adapters`,
for the reason given under *Public surface*.

### Identifiers and scalars

Every identifier is a branded string or number, so that two identifiers of different
namespaces cannot be assigned to one another by accident. Six namespaces coexist and
conflating them is the most likely source of a subtle cross-vendor bug
(`10-design.md § Data model — Identity spaces`).

**Who may mint one, which is the part a `Brand` cannot say:**

- `SessionId`, `TurnId`, `Seq`, `AttachmentId`, `ReviewId`, `RequisitionId`, `AuditCursor` —
  the server. `Seq` is assigned by `session-manager` alone and by no adapter.
- `OperatorId` — the identity edge, from an upstream claim. Never minted here, never stored
  as a record of its own (D3).
- `CliSessionId`, `CallId`, `RequestId` — **the vendor**. These are the one deliberate
  exception to "no vendor above the adapter", and they are **opaque**: no code above
  `adapters/*` may parse one, compare one for ordering, or infer structure from one.
  Equality is the only permitted operation (I21).
- `ResolvedPath` — **only `jail`**. A `ResolvedPath` is a path *proven*, once, to resolve
  inside a configured workspace root; a module that constructs one by assertion has defeated
  the jail. `Requisition.workspace` is deliberately not one (I34).
- `StandingRuleExpression` — **only `parseStandingRule`**. Its grammar is below.
- `ChecklistItemId` — a deployment, in its `config` checklist template.

**`AuditCursor` is opaque to every caller including the client.** It encodes a position in
`audit.ndjson` and what it encodes is `store`'s business. No caller may parse, compare or
construct one; round-tripping it back to `GET /api/audit` is the only permitted use. A byte
offset was rejected as the cursor precisely because it would make the file's physical layout
a public interface, and `(ts, index)` was rejected because it collides at millisecond
precision under a fast stream (D86).

**`IsoTimestamp` is UTC, millisecond precision, `Z` suffix.** `GitSha` is a 40-character
lowercase hexadecimal git object id. Neither is validated by its brand; both are minted by
the module that owns the fact.

**`StandingRuleExpression`'s grammar is contractual and is stated here in full**, because a
brand on a string says none of it and `parseStandingRule`'s implementation is not a
specification (D108):

- The form is `"<tool>:<pattern>"`, matching `/^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^\r\n]+$/`, and
  no longer than `Caps.standingRuleBytes` as UTF-8.
- The half before the **first** colon is compared for equality against
  `PermissionRequest.tool`. Every later colon belongs to the pattern.
- The pattern is matched against `PermissionRequest.matchTarget` **in full, anchored at both
  ends, byte for byte and case-sensitively, with no normalisation on either side**.
- `*` is the only metacharacter. It matches any run of characters including the empty run,
  **except** `;` `&` `|` `<` `>` `` ` `` `$` CR LF. There is no escape, so no rule matches a
  literal `*`. Nothing else in the pattern is special.

`Vendor`, `SandboxMode` and `SessionState` are closed unions. `Vendor`'s runtime enumeration
lives in `adapters` and `Rating`'s in `contract`; the reasons differ and are given under
*Public surface*.

**`Result<T, E>` is how failure crosses a module boundary.** Every fallible operation that
crosses one returns it rather than throwing. This is the whole of the "no bare exceptions, no
string errors" rule: a thrown value has no declared type, and a caller cannot be held to
handling what the signature does not name.

### Session

Declared in `src/contract/index.ts`: `PermissionPolicy`, `SessionRecord`, `SessionSummary`,
`LiveSession`, `SessionSnapshot`.

**`SessionRecord` is exactly what `meta.json` carries and nothing more** — the session minus
turn, buffer and subscribers (D49). What the declaration cannot say:

- `id`, `owner`, `vendor`, `cwd`, `model`, `policy`, `sandbox` and `createdAt` are immutable
  for the life of the session. `policy` and `sandbox` are immutable because both are
  properties of how the child was launched: changing a Codex sandbox means a new session,
  never a mutation.
- **`cwd` is the resolved real path, resolved exactly once, at session creation** (I7). Every
  later spawn reuses the stored resolution rather than re-resolving the client's string. This
  is a deliberate TOCTOU trade — a root re-pointed by symlink mid-session is not re-checked —
  accepted because re-resolving per turn lets a session silently migrate between turns, which
  is worse (D4).
- **`cliSessionId` is last-write-wins, from every `system/init`, never write-once** (D34). The
  CLI mints a fresh id on each `--resume`, so a write-once cell would have turn 3 resuming the
  id turn 1 reported. Where a child dies before emitting `init` at all the cell stays null, the
  next turn spawns **without** `--resume`, and that emits
  `session.notice / resume_unavailable`.
- **`lastSeq` on disk is a diagnostic hint and not authority** (D37, I17). Boot derives it from
  the tail of `events.ndjson`; where the two disagree the spill is right.
- `state` is one-way. It distinguishes the two ways a session has no turn running: a **live,
  idle** session accepts a new message, an **ended** one answers `409 session_ended`. There
  are exactly three ways in — the operator (D36), a restart (D20), a storage failure (D41).
- `endedAt` is non-null **exactly when** `state === 'ended'` (I8).
- **`policy` is the adapter's capability; `sandbox` is the operator's choice.** Only the second
  answers "which sandbox governed this session?" after the fact, which the threat model
  requires and which is why it is copied onto every audit record — D25 deletes `meta.json` and
  keeps `audit.ndjson`.
- `PermissionPolicy.banner` is non-null **exactly when** `mode === 'preauthorised'`.

**`SessionSummary` is what crosses to the client**: the persisted record minus
`cliSessionId`, which is vendor-opaque and has no client use. It is the authoritative
statement of a session's current `state`; a `state` read off a replayed `session.started` is
not (see *Rules the renderer may rely on*).

**`LiveSession` declares only what the invariants are stated over** — the persisted record
plus the one piece of state that is never written. `turn === null` means idle, and it is
always null once `state === 'ended'`, which is what makes I8 assertable against a declared
field. **The manager's actual registry entry extends this, and the extension is deliberately
not declared**: fan-out bookkeeping, the per-session append chain, the standing-rule list and
the flags deciding whether a later turn retries a doomed checkpoint are scheduling state
crossing no module boundary, and a contract enumerating them would need amending every time
the manager learned a new thing about its own turns. The ring buffer and the subscriber set
are named here only to say they are **not** it: the ring is `store`'s, reached by `pushRing`
and `readRingAfter` on a `SessionId`, and the subscriber set never leaves the manager's
fan-out.

**`SessionSnapshot` is a copy, never a reference** (D67, I30). It is the denormalised session
identity a review takes at authorship; after D25 deletes the session, this is what still
resolves. Nothing re-resolves it, and no read of a review resolves its `subject`.

**There is no employment-status field and none may be added.** D79 makes the badge a
client-side projection over `state`, the live turn and outstanding permission requests.

### Turn

Declared in `src/contract/index.ts`: `Turn`, `PendingPermission`.

**In memory only.** No `turns.json` exists; turn history is reconstructed from the event log
by pairing `turn.started` with `turn.ended`, and that reconstruction is the only durable
record. A live `Turn` is scheduling state, it hangs off `LiveSession.turn` and nowhere else,
and at most one per session is non-null at any time (I4).

**It carries no child-process handle, and the absence is the design.** The child is spawned
inside `Adapter.send` and terminated through `Adapter.kill`, so the handle never crosses into
`session-manager`. A second reference here would give the manager a way to reach a process the
adapter is the only declared owner of — which is the whole of why interrupt goes through
`kill` rather than through a stored handle.

**`pending`'s value type carries four fields rather than a `callId`, and each is load-bearing**
(D109). `answerPermission` must enforce I43 — `scope: 'always'` against a request whose
`matchTarget` is `null` is `bad_request` — and append I11's audit record carrying `tool` and
`input`, **without re-reading the originating request**. Re-reading it is what would put
tool-shape knowledge in `session-manager` and break I46. `matchTarget` here is a copy of the
adapter's projection, never a second projection.

### Process record

Declared in `src/contract/index.ts`: `ProcessRecord`, `ProcessTombstone`.

`pids.ndjson` carries **two line shapes**: a full `ProcessRecord` at spawn, and the narrower
`ProcessTombstone` at exit, because `tombstonePid` is given a pid and a timestamp and nothing
else (D95). `pgid` is `null` on Windows, which has no equivalent to record.

**`startedAt` is load-bearing rather than decoration**: the pid-reuse guard reads it, and a
bare pid is not safe to kill. Operating systems reuse process ids, so a pid recorded before a
reboot may name something unrelated afterwards — reaping it would kill an innocent process, as
root on some hosts.

**`hostname` is load-bearing for the same reason, one step earlier** (D181): it decides whether
the guard is worth running at all. Every limb of that guard reads *this* host's process table, so
running it against a record another host wrote is not a weaker check but a meaningless one — the
two hosts' pid 4711 agreeing on an image is a coincidence that reads as proof. A record naming
another host is skipped entirely: not reaped, and **not tombstoned either**, because an exit
record for a child this server never saw is a lie in the file boot trusts most. **A record with no
`hostname` is read as this host's**, which preserves today's behaviour exactly on the single-host
deployments that are the only ones that have existed — shared storage was unsupported before D180,
so no current `pids.ndjson` holds a foreign record to mistake.

**The guard's fourth limb reads a value the server recorded, not one it computes** (D183, D186).
An amendment owed to the declaration: `ProcessRecord` gains `osCreatedAt: IsoTimestamp | null`,
the operating system's *own* reading of when that process was created, taken at spawn. The three
original limbs — no `exitedAt`, a `startedAt` later than the host's last boot, a matching `image`
— all pass when the host reuses a pid within a single boot for another child of the same name,
which in a console whose every child is `claude` or `codex` is not a remote case. What separates
*that* process from *a* process with the same number and name is when it was created. **The
comparison is exact equality, and it is against `osCreatedAt` rather than `startedAt` because
only one of those is from the same clock**: `startedAt` is this server's wall-clock reading at
spawn, while a platform derives creation time from boot time plus ticks against a coarse
`btime`, so no tolerance between the two is at once wide enough to be reliable and narrow enough
to exclude same-second reuse. `startedAt` keeps the boot-time limb and stops being what the
fourth limb reads.

**`osCreatedAt` is nullable, and a null is never reapable.** No platform exposes creation time to
Node, so the read at spawn is a shell-out of the same shape `taskkill` already is and it can
fail; where it does the field is `null`. An entry carrying `null` — and an entry whose *live*
counterpart cannot be read at boot — is tombstoned and logged rather than reaped, so the guard
fails closed at both ends. The cost is a genuine orphan an operator ends by hand, which is the
price the spawn-window reasoning already accepts and for the same reason: this design would
rather leak a process than end the wrong one. **This is the only field here whose absence changes
what boot is permitted to do**, which is why it is `null` and not an empty string: a reader must
be unable to mistake "not recorded" for a value that could match.

**A reader must never hand back a tombstone as an open record.** Liveness comes from the
latest line for a `pid`; `startedAt`, `image` and `osCreatedAt` must come from that pid's most recent
**spawn** line, because the reuse guard reads all four of `exitedAt`, `startedAt`, `image` and
`osCreatedAt` (I19) and a reader taking them off the tombstone would find three missing and reap
on a guard that never ran. That is the requirement. Folding the two shapes meets it; so does filtering
the latest line on `exitedAt === null`, because a tombstone always carries a non-null
`exitedAt` and so never survives the filter — which is what `store` does.

### Server lock

Declared in `src/contract/index.ts`: `ServerLock`.

**A `ServerLock` is a lease, and the only evidence of liveness it carries is a counter** (D180).
It names an `instanceId` — minted randomly at boot, identifying one *run* of one server — and a
monotonic `renewals` count the holder increments for as long as it holds the root. Liveness is
decided by **watching that pair change**, never by interrogating a process table and never by
comparing a clock. That is what lets one rule cover this container, another container and another
host, where the two-rule split it replaces needed two and got both wrong.

**`pid`, `hostname`, `startedAt` and `image` are retained and are informational only.** They are
what a refusal prints, and **no decision reads any of them** (I57). Keeping them is D161's real
insight surviving the mechanism that carried it — naming the holder is most of a refusal's value
to the operator looking at one. Treating them as evidence is the defect D180 was opened on: inside
a container a fresh pid namespace hands a booting server the pid its predecessor recorded, and
`os.uptime()` reports the *host* kernel's uptime, so a probe built on them finds itself and calls a
dead holder live.

**There is still no `exitedAt`, and its absence now proves less than it did.** `releaseLock`
removes the file at clean shutdown, so an absent lock is an unheld root and a boot claims it with
no wait. A lock nobody removed is evidence of nothing by itself; it is reclaimed only after its
counter has been observed not moving (*Public surface § `store`*).

**`LivenessProbe` is no longer part of this surface.** D23's test survives for the file it was
written for — `pids.ndjson`'s reap guard (I19) — as `session-manager`'s own, no longer shared with
a second file and no longer handed to `store`. It is no longer the three-limb test D161 borrowed
either: D183 and D186 gave it a fourth limb reading `osCreatedAt`, and D181 a hostname gate ahead
of all four. Sharing it is what made growing it a change to two files at once; it now grows for
one (D193).

### Event envelope

Declared in `src/contract/index.ts`: `EventPayloadMap`, `EventKind`, `Envelope`.

**`(sessionId, seq)` is the primary key of the entire system.** Everything replayable is keyed
on it, which is why `seq` assignment sits in the session manager (D2) and why it is expensive
to change. **`seq` is never assigned by an adapter**: an adapter that restarts must not restart
the sequence.

**The vocabulary is closed** (D44). A vendor record that fits none of it is
`error / adapter_unknown_record` with the record preserved in `raw`, never a new kind invented
at the edge. `checklist.item.completed` is the one kind tier two adds, and it is
session-scoped: it carries no `turnId` and may land between a `turn.started` and its
`turn.ended`.

**Not everything a client receives is an envelope, and `message.delta` is the one exception**
(D168). A delta is a **frame**: delivered to live subscribers and to nobody else, carrying no
`seq`, never entering the ring buffer, never appended to the spill, and never replayed. The kind
stays in `EventPayloadMap` — it is one of the vocabulary's members and a client dispatches on it
exactly as before — but no `Envelope` is ever constructed for it (I51).

The exception is deliberate rather than an omission, and the reason is what makes it safe: deltas
concatenate **exactly** to the `message` that follows them, so the text is already durable in that
envelope, and spilling the deltas as well would store it a second time while multiplying the
spill, the ring and `PayrollView`'s fold by the delta rate — measured at roughly an order of
magnitude on text turns (`design/findings/S25-token-streaming-probe.md`). Giving a delta no `seq`
at all
removes the collision with I1's contiguity **by construction** rather than weakening the
invariant to accommodate a rendering nicety. What a client gives up is partial text across a
reconnect: a reconnect mid-message replays no deltas and renders the `message` when it lands,
which *Rules the renderer may rely on* already permits.

**It holds for both vendors**, so persistence never becomes vendor-dependent for one kind: Codex's
`item/agentMessage/delta` is a frame on the same terms as Claude's.

A frame is an envelope minus `seq` — the manager assigns `sessionId`, `ts` and the payload's
`turnId` as it always has, and assigns no `seq`, because a frame has no position in the
replayable stream. `raw` (`src/contract/index.ts`) exists for debugging and **must never be
rendered**.

`Config.streamDeltas` (`src/config/index.ts`) is what makes the Claude CLI emit them at all —
defaulting off, threaded to the adapter as `AdapterOptions.streamDeltas` — and is the only new
deployment flag S25 owes (S25.6). Named vendor-neutrally, per I20: Codex streams deltas
unconditionally and simply ignores it.

### Event payloads

Declared in `src/contract/index.ts`, one per member of `EventPayloadMap`: `SessionStarted`,
`SessionEnded`, `SessionNotice`, `TurnStarted`, `TurnEnded`, `MessageEvent`, `MessageDelta`,
`Thinking`, `ToolCall`, `ToolResult`, `PermissionRequest`, `PermissionResolved`,
`CheckpointCreated`, `UsageEvent`, `ErrorEvent`, and tier two's `ChecklistItemCompleted`. The
supporting unions and value types are declared beside them: `SessionEndReason`,
`SessionNoticeCode`, `TurnStopReason`, `AttachmentUpload`, `AttachmentRef`,
`StandingRuleExpression`, `PermissionDecision`, `AnswerScope`, `ResolvedScope`,
`PermissionResolvedReason`, `Usage` and `ErrorEventKind`.

**`AnswerScope` and `ResolvedScope` are two types rather than one, and the asymmetry is the
point.** `AnswerScope` is what a *client may send* — `'once' | 'always'`. `ResolvedScope` is
what a resolution *reports*, and it adds `'standing'`, which no client can ask for because it
means the server matched a rule it was already holding and answered without asking anyone. A
single union would let a client claim a scope only the server can produce.

What the declarations cannot say, payload by payload where there is anything to say:

**`SessionStarted.state` is the state at emission and is therefore always `'live'`.** It is
retained knowingly (D45); the authoritative current state is `SessionSummary.state`. `vendor`
here is display only and no logic may branch on it (I20).

**`SessionEndReason` names three transitions and one of them is never on the wire.** The three
ways into `ended` are D36's operator, D20's restart and D41's storage failure — but **no
`session.ended` carries `server_restart`**. Boot appending one was D45's rejected alternative,
dropped with the derive-state-from-the-stream proposal it belonged to, and nothing has added
it since. The value is retained knowingly and **an implementer must not close the apparent gap
by emitting one at boot**. What boot does append is `session.notice / server_restart` (D130),
which shares the spelling and is a different thing: a notice is not an end reason, and it marks
where an outage fell without claiming to say why the session ended.

**`SessionNoticeCode` members, and the two with no producer:**

| Member | Fires when |
|---|---|
| `compaction` | the CLI is compacting, or reported a compact boundary |
| `resume_unavailable` | spawning with no `--resume`; conversation context is not carried forward |
| `checkpoints_unavailable` | `ckpt.git` could not be initialised; the session proceeds without checkpoints |
| `checkpoint_skipped` | the pre-turn checkpoint failed; the turn proceeds with no restore point (D42) |
| `sandbox` | **never — no producer, retained knowingly.** Superseded by `PermissionPolicy.banner`, which the client renders instead and which survives a replay because it is a session field rather than an envelope (S8.3). Dropping a member narrows a declared union and buys nothing |
| `audit_unavailable` | a permission was denied because the audit append failed |
| `storage_failure` | a spill write failed; the session is ending |
| `server_restart` | boot found this session live at shutdown (D130) |
| `usage_unavailable` | this session's transport reports no token usage, so its burn is unknown rather than zero (D146) |

**`usage_unavailable` is emitted once, at session start, before the first `turn.started`** —
not per turn, which would say the same thing repeatedly and bury it. It is emitted by whichever
adapter selects a transport that cannot report usage, today only `codex exec --json`. It is the
discriminator between a burn of zero because the session was idle and a burn of zero because
nothing was ever counted, and **nothing may infer that distinction by testing `burn` against
zero** instead.

**`TurnStopReason`** distinguishes an expected end from a failure, and the distinction is the
point: an operator who interrupts has not caused a crash and must not be shown one.
`completed` and `error` are the CLI's own reported result; `process_exit` is a child that died
without reporting one; `interrupted` is `POST /interrupt`; `server_restart` is boot closing a
turn a crash left open (D39); `storage_failure` is D41.

**`TurnEnded.usage` has no producer and is retained knowingly** (D151). Every adapter and every
synthesised close emits `null`, because D75 puts the vendor-normalised summable figure on the
dedicated `usage` envelope and `PayrollView`'s fold reads only that. A reader summing both
sources would double-count a turn's burn the moment anything populated this — the failure I28
exists to prevent. The slot is where a vendor-reported turn total would go if one ever proved
worth carrying.

**`MessageEvent.attachments` carries refs only, never bytes** (D160, I49): the spill is the
transcript, and an attachment's bytes never enter it. It is empty on every `assistant` message,
because an attachment originates with an operator. Bytes are fetched from
`GET /api/sessions/:id/attachments/:turnId/:attachmentId`.

**On `AttachmentUpload`, two fields are the client's claim and neither is trusted.**
`filename` is display text and **never reaches a filesystem path** — the server-minted
`AttachmentId` is the only path segment (I49). `mediaType` is stored verbatim and is never
echoed unguarded on the way out; the read route's allow-list is in *HTTP routes*.
`Caps.attachmentBytes` bounds the **decoded** size.

**`MessageDelta` is the payload of a frame, never of an envelope** (D168, I51). `text` is
append-only: each delta carries the increment, never the accumulation, and the increments for one
`turnId` concatenate to the `message` that follows. **The concatenation is in arrival order and
cannot be in `seq` order, because a frame has no `seq`** — an ordering a consumer therefore takes
from the live stream it received them on, which is the only stream they exist in. A delta is never
re-delivered, so there is no second arrival for that order to disagree with.

**`ToolResult.output` is truncated before the envelope is constructed** (I3, D22), and
`bytes` is the pre-truncation size. The envelope in the ring and the line in the spill are the
same bytes; a design where the spill held the full output and the wire the truncated one would
make replay-from-disk and replay-from-memory return different transcripts.

**`ToolCall.summary` is display-only** (I48, D159). Above `adapters/*` it is rendered as a text
node and nothing else: no module parses it, matches against it, or derives anything persisted
or security-relevant from it, and **its shape is not contractual**, so an adapter may change
how it reads without breaking a consumer. Testing it for empty, to decide whether to show the
line at all, is display and is permitted.

**`PermissionRequest.input` is exactly what will run, never a summary.** Where the control is a
prompt, the prompt must show what is actually being run.

**`PermissionRequest.matchTarget` is the one string a rule's pattern is matched against**,
projected from `input` by the adapter and emitted verbatim. It is `null` where the adapter
defines no projection for that tool, and then **no standing rule may be created against this
request** (I43). Its projection table is the adapter's and is the only place tool-shape
knowledge is permitted to live (I46).

**`PermissionRequest.suggestions` is the vendor's `permission_suggestions`, forwarded exactly
as it arrived, and read by nothing** (D104, I44). No module narrows, parses, indexes or derives
a `StandingRuleExpression` from it. The field is unobservable on this transport — the
`control_request` that would carry it has never appeared across two independent probes — and
forwarding it costs nothing while keeping the payload from being dropped silently if the
channel ever starts firing.

**`PermissionResolvedReason.superseded` has no producer and is reserved rather than dead.**
Nothing resolves one request because another replaced it; if such a path is ever added this is
its reason, and until then **it must not be repurposed**.

`PermissionResolved.operator` is `null` exactly when the server decided rather than an
operator.

**`CheckpointCreated.turnId` is `null` for the safety checkpoint taken before a restore**, and
non-null for a pre-turn checkpoint.

**`Usage` is incremental and summable by construction** (D75, I28). The adapter normalises
whatever the vendor reports into deltas before emitting; nothing above `adapters/*` performs
arithmetic on a vendor's own token numbers. Whether a given vendor reports cumulatively is the
adapter's problem and never a caller's. `Usage` carries **no model identifier**, which is why
`Config.tokenRates` is flat per deployment.

`ErrorEvent.fatal` distinguishes a diagnostic line from a stream that has stopped meaning
anything: `adapter_schema_mismatch` is fatal, `adapter_unknown_record` and `adapter_bad_line`
are not.

### Rules the renderer may rely on

- **`message.delta` frames for one `turnId` concatenate, in arrival order, to the `message` that
  follows** (D168). Not in `seq` order: a delta is a frame and carries no `seq` (I51). A client
  may render either and must not render both, and picks by `turnId`.
- **A delta never survives a reconnect, and that is what makes the rule above decidable.** Deltas
  are live-only: they are never replayed, so a client that reconnects mid-message receives no
  deltas for that message and renders the `message` when it lands. The "must not render both"
  choice therefore only ever arises on an uninterrupted connection; across a reconnect the
  question does not arise at all.
- `tool.result` always follows its `tool.call`. A `tool.call` with no result by `turn.ended`
  was abandoned.
- `permission.request` is always answered by exactly one `permission.resolved`, including
  when the process dies, when an operator interrupts, and when boot closes a turn a crash
  left open — all three carry `reason: 'cancelled_process_exit'`.
- A `preauthorised` session emits **zero** `permission.request` events. That is normal and
  must not read as a stalled turn.
- `session.started` is emitted once per session, on the first turn only, even though the CLI
  reports `system/init` on every turn.
- **`SessionStarted.state` is the state at emission and is therefore always `'live'`.** The
  authoritative current state is `SessionSummary.state` from `GET /api/sessions` or
  `GET /api/sessions/:id`, or the presence of a `session.ended` later in the stream. A client
  that reads `state` off a replayed `session.started` will show an enabled compose box for an
  ended session. The field is retained knowingly (D45).
- The untruncated bytes behind a `tool.result` with `truncated: true` are at
  `GET /api/sessions/:id/tool-output/:turnId/:callId`. Both segments come from the same
  envelope.
- **Belonging to a turn is a field, never a position in the stream.** `checkpoint.created`,
  `session.notice` and `checklist.item.completed` carry no `turnId` and do land between a
  `turn.started` and its `turn.ended`. A renderer that treats that interval as the turn's
  contents will attribute an operator's click to the agent.
- **There is no employment-status field on the wire** (D79). `CLOCKED OUT` is
  `state === 'ended'`; `BLOCKED` is a live session with an unresolved `permission.request`;
  `ON SHIFT` is a live turn; `IDLE` is the remainder. `ON PIP` is orthogonal and comes from
  the review fold below, not from the session.
- **PIP status is derived, never served as a session field** (D72). It is the `pip` value of
  the review for that subject with `state === 'final'` and the greatest `updatedAt`, ties
  broken by the later line in `reviews.ndjson`. Drafts are excluded. `GET /api/reviews?subject=`
  returns exactly the finals this fold reads.

### Checkpoint

Declared in `src/contract/index.ts`: `Checkpoint`.

**Entirely derived from the shadow `GIT_DIR`.** The checkpoint list is `git log`; no mirror is
persisted, because git is the store and a second copy would be a second thing to fall out of
sync. `ts` is the git commit time, not a server clock reading.

**The ignored-path manifest is the one exception to that, and it is an exception rather than a
softening** (D182, D187). Ignored paths are neither checkpointed nor cleaned, so git holds no
record of them at all and there is nothing for a second copy to disagree *with*. What the
manifest can be is absent, and the whole of the rule below exists so that absence cannot be read
as a clean result. These four are not yet in the tree and are written here as scaffolds:

```ts
// One line of `git status --ignored=matching`, which collapses an ignored *directory* into a
// single entry rather than walking the files beneath it.
export interface IgnoredEntry {
  readonly path: string;               // workspace-relative, POSIX separators, never absolute
  readonly kind: 'file' | 'dir';       // 'dir' is a collapsed directory
  readonly sizeBytes: number | null;   // null exactly when kind === 'dir'
  readonly mtimeMs: number;            // the entry's own mtime, not its subtree's
}

export interface IgnoredManifest {
  readonly sha: GitSha;                // the checkpoint this was captured alongside
  readonly capturedAt: IsoTimestamp;
  readonly entries: readonly IgnoredEntry[];
}

// One difference between a target checkpoint's manifest and the workspace as restore found it.
export interface IgnoredDelta {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'modified';
}

// What `restore` returns. `safety` is the checkpoint taken on the way in, never the target.
export interface RestoreResult {
  readonly safety: Checkpoint;
  readonly unreached: readonly IgnoredDelta[] | null;
}
```

**No entry carries content, and that is a constraint rather than an omission** (I58). Storing the
bytes of ignored paths is the widening the brief declined, and it would arrive by the back door
and be paid for on every checkpoint rather than on the one restore that reads it. `sizeBytes` and
`mtimeMs` are what make `'modified'` detectable without them.

**A `'dir'` entry is compared on its own metadata, so this report is a pointer and not
evidence.** A collapsed directory's mtime moves when a child is added or removed and does not
move for an edit deeper inside, so a manifest can call a `node_modules` unchanged while a file
within it differs. That is the price of a manifest bounded by the ignore rules that match rather
than by the file count beneath them — a 60 000-file dependency tree contributes one line. It is
stated here because **no security control may come to lean on this**, and the difference between
a pointer and evidence is invisible at the call site.

**`unreached === null` means the comparison could not be made. It never means nothing differs**
(I58). A checkpoint predating this mechanism has no manifest, a manifest write can fail, and a
manifest read at restore can fail; all three land on `null`, and a client renders it as unknown.
An empty array is a real answer and says the ignored paths match.

### Audit record

Declared in `src/contract/index.ts`: `AuditRecord`, `AuditQuery`, `AuditPage`.

**This is the artifact that makes multi-operator use defensible, and three properties are the
whole of why:**

- **`input` is never truncated, summarised, or derived** (I12). It is the exact input that was
  approved — the same bytes shown to the operator. This is the only place in the system where
  the byte cap governing `tool.result` does not apply, and that is deliberate: an audit record
  of a truncated command records something that did not run.
- **`vendor` and `sandbox` are copied from the session at decision time**, not looked up later,
  and the redundancy is the point. D25 deletes `meta.json` and keeps `audit.ndjson`, so a
  record storing only `sessionId` could not answer "which sandbox governed this?" about exactly
  the session someone had reason to remove.
- **`audit.ndjson` is never deleted, rewritten or shortened**, including when the session it
  names is deleted (I13). A log a subject can delete is not evidence.

`operator` is `null` exactly when the server decided rather than an operator. On
`scope === 'standing'`, `reason` carries the matched `StandingRuleExpression` **verbatim** —
which is what makes an auto-approval explain itself without a new persisted field. On a denial
it carries the operator's stated reason, and where the server forced the decision it names the
cause.

**The read side is one read with filters, never two shapes** (D73). `AuditQuery` serves brief
item 7 in tier one and the incident view of item 11 in tier two; the incident view is
`incidentsOnly: true`, which selects `decision === 'deny'`, **or** `operator === null` (the
server forced it), **or** `scope === 'standing'`. Grouping by session and by operator is the
reader's.

**`Caps.auditPageMax` bounds records *examined*, not only records returned, and the consequence
is that a page may be short — or empty — with a cursor still to follow** (I39). A filter bounded
only by its result count is not bounded at all: a query matching nothing walks to the start of
the file, which is exactly the scan D73 refuses and the one that grows with the deployment
rather than with the answer. A read stops at whichever comes first, `limit` matches or
`Caps.auditPageMax` records inspected, and reports where to resume either way. **A short page
is therefore not the end of the log and a caller must not read it as one**; only
`nextCursor === null` is.

`before` is newest-first: `null` starts at the newest record.

### Review (tier two)

Declared in `src/contract/index.ts`: `Rating`, `ReviewState`, `Review`.

**Every field is `readonly` because a line in `reviews.ndjson` is immutable.** Editing a draft
appends a new line for the same `reviewId` and the latest line wins (D65); the earlier drafts
stay on disk. That is not a storage compromise — it is the behaviour an employment record
should have.

**`state` is one-way and it governs two things rather than one** (D70, I29, I31). A `final`
review is terminal — a further append for that `reviewId` is refused — **and it is the point at
which the review becomes visible to anyone but its author.** A draft is readable and writable
by its author alone; a final is readable by every authenticated operator. This is the one
carve-out in D70's open-read rule, and it is what makes "draft state" a state rather than a
label: the purpose of drafting is not having published yet.

**`Rating` is display-independent** (D82). The tokens are what persists and the wording an
operator sees is the client's, because rewording the scale later must not become a migration of
`reviews.ndjson`. It is deliberately not numeric: a numeric scale invites arithmetic on a
judgement whose five points are not evenly spaced. **Nothing ranks or compares the tokens**,
and no caller may rely on their order.

**`updatedAt` on a `final` line is the finalisation time, and it is the ordering key for "the
most recent final review"** (D83, I35). It can be, precisely because `final` refuses every
further append — which is why no separate finalisation timestamp is needed. Ties break on the
later line in the file.

`snapshot` is copied at authorship and never refreshed (I30).

### Requisition (tier two)

Declared in `src/contract/index.ts`: `RequisitionState`, `RequisitionDecision`, `Requisition`.

Same file discipline as `Review`: append-only, latest line per id wins.

**The lifecycle is `open → approved → consumed`, or `open → rejected`, and nothing else** (I32).
Every other transition is refused. There is no revocation and no expiry: an approval stays
spendable until it is spent (D81).

**`workspace` is the client's string, stored unresolved, and it is deliberately not a
`ResolvedPath`** (D68, I34). This is the one place the design declines to reuse D4's
resolve-once discipline, because a requisition can sit unapproved for a day: resolving at raise
time would store a path whose meaning may have changed by the time it is used, and would leak
whether a directory exists to any operator who can raise one. **An approval is permission to
try, not a grant** — the jail runs at session creation as it always has, so a requisition for a
path outside every root is approvable and then fails `409 outside_workspace_root` at the moment
it is used.

**Consumption is once and is claimed synchronously** (I33, I5). A second claim is refused,
never queued.

`decidedBy` may equal `raisedBy`: self-approval is permitted and recorded (D69).

### Onboarding checklist (tier two)

Declared in `src/contract/index.ts`: `ChecklistItemTemplate`, `ChecklistItemState`.

**The template is a `config` value and completion lives in the session's event stream; the
checklist is the fold over it** (D71). Nothing is persisted for a checklist and it dies with
its session under D25, which is correct: it is first-run provisioning, not evidence.

The template is **not** per-requisition and not per-vendor — a checklist varying by who raised
the requisition is a workflow engine, which nothing has asked for. Every session has one.

`ChecklistItemState.label` is read from the template at read time, so a deployment editing a
label does not rewrite history. `completedAt` is the `ts` of the completing envelope.

### Payroll view (tier two)

Declared in `src/contract/index.ts`: `PayrollView`.

**A fold over the session's own event log and a `config` value. No entity, no file, no running
counter** (D147). A live session and a rehydrated one are folded from the spill identically; two
sources for one number is a pair that must agree, and a reconciliation rule nothing enforces is
not a guarantee. The fold is O(spill) per read and that is the cost accepted.

- `burn` is the component-wise sum of every `usage` event for the session. It is a sum **only
  because the adapter guarantees the numbers are summable** (D75, I28).
- `remainingTokens` subtracts `burn`'s **full** component-wise sum — input, output, cache reads
  and cache creation all count against the budget — from `budgetTokens`, and is `null` whenever
  `budgetTokens` is (D129). The budget is per session (`Config.sessionTokenBudget`): the only
  scope needing no new persisted entity, and the only one where the number on a session's
  screen is about that session.
- `idleMs` is wall-clock time the session was `live` with no turn: the gaps between `turn.ended`
  and the next `turn.started`, plus creation-to-first-turn and last-turn-to-end.
- **`costCurrency` is an estimate against operator-set rates, never a vendor's billed amount**
  (D158). It is `burn`'s four components each multiplied by their rate in `Config.tokenRates`
  and summed. Rates are flat per deployment because `Usage` carries no model identifier, so a
  session that switched models is priced approximately — recorded rather than smoothed over.
- **`costCurrency` is null on exactly the sessions that cannot report burn, and the test is not
  `burn === 0`.** A fabricated `0.00` misreads as authoritative in a way `0 tokens` does not.
  The signal is `session.notice / usage_unavailable` (D146). Null also covers an unpriced
  deployment: `tokenRates` null means the operator set no rates, and the tile is absent rather
  than zero. `currency` is a label the server stores and echoes and **never interprets** — no
  conversion, no lookup, no network call — and is null whenever cost is.

**`session.notice / server_restart` is the fold's only restart marker, and `turn.ended`'s
`server_restart` stop reason carries no fold meaning** (D130, D76). The fold walks the spill and
stops billing at that notice: the idle interval the notice closes, **if one was open**, is
dropped and counted in `droppedIntervals`, and nothing after it is billed. Both restart cases
fall out of the one rule — a server that went down while the session sat idle between turns had
an interval open and reports one dropped; a server that went down mid-turn had none, because the
outage was inside a turn and was never idle, so it reports zero and the outage is attributed to
the turn. Reading `turn.ended { stopReason: 'server_restart' }` as the marker instead is what
leaves the idle case unmarked entirely, since D39 appends that close **only** where the spill
ends on an unpaired `turn.started` — and the whole outage is then billed as that operator's idle
time, a wrong number on a screen headed *payroll*.

**`PayrollView` carries no field separating unknown from zero**, and giving it one is a second
public-surface change that is not made here; see `## Unresolved` 12.

### Operator

Declared in `src/contract/index.ts`: `Operator`.

**Not persisted.** There is no user record, no profile, no preferences — D3 chose delegated
identity precisely so that no credential or account state lives here. An operator exists as a
string on a `SessionRecord`, an `AuditRecord`, a `Review` and a `Requisition`, and nowhere
else (D66). Tier two adds no operator record and no preference: the theme is browser state and
never reaches this server (D60, D78).

### Config

Declared in `src/contract/index.ts`: `AuthConfig`, `Caps`, `TokenRates`, `Config`.

**This document declares the fields and sets none of the values** (D84). The values are a
deployment's.

**`storageRoot` is a `ResolvedPath`, not a raw string** (D185) — an amendment owed to the
declaration. It was the one path in this configuration that reached the server unnormalised while
`workspaceRoots` beside it were already jail-resolved, which is D94's argument arriving one field
short: two spellings of one directory are two values to every comparison, and the comparison this
field now has to survive is the overlap check under *Public surface § `config`*. Canonicalising it
is what makes that check possible at all rather than merely stricter.

**A cap is a threshold, not a truncation**, for every text field that names one: a review body,
a requisition title or justification, a standing rule or an attachment over its cap is refused
with `422 bad_request`, never silently shortened. `Caps.toolResultBytes` is the one exception
and is a genuine truncation, because the untruncated bytes survive in a blob.

**Caps exist as configuration rather than as constants because a buried constant is a cap that
cannot be changed without a release.** That reasoning applies hardest to
`sessionCookieMaxAgeSeconds`, which is a deployment's security posture and is what a deployment
shortens after an incident. It is read **only** under `auth.mode === 'shared-secret'` and is
ignored under either header mode, where the credential is the upstream proxy's and its lifetime
is not ours to set.

**`Config.edge` selects which transport edge this deployment binds** (D10, D117). `server.ts`
constructs `createSseEdge` or `createWsEdge` accordingly; exactly one binds.

`TokenRates` is one rate per `Usage` component, in `currency` units per token, flat per
deployment (D158). `null` disables the cost tile. `checklist` empty disables the checklist.
`sessionTokenBudget` null disables the view's budget.

`Caps.sessionToolOutputBytes` is declared in `src/contract/index.ts` (D162, S23): total blob
bytes one session may store, enforced at the `writeToolOutput` call site.

## Persisted schemas

```
<storage>/sessions/<sessionId>/
  meta.json                                   SessionMetaFile
  events.ndjson                               one Envelope per line, append-only
  tool-output/<turnId>/<callId>               untruncated bytes, one file per call
  attachments/<turnId>/<attachmentId>         operator uploads, one file each
  ckpt.git/                                   shadow GIT_DIR, work-tree = the session's cwd
  ignored/<sha>.json                          one IgnoredManifest per checkpoint       (D182)
<storage>/audit.ndjson                        one AuditRecord per line, append-only
<storage>/pids.ndjson                         ProcessRecord and ProcessTombstone lines
<storage>/server.lock                         one ServerLock object; a renewed lease   (D180)
<storage>/reviews.ndjson                      (tier two) one Review per line, append-only
<storage>/requisitions.ndjson                 (tier two) one Requisition per line, append-only
```

`SessionMetaFile` is declared in `src/contract/index.ts`. Its `schemaVersion` is the one
discriminator in the system, and an unknown value is **a corrupt file, never a migration
attempt** (D49): the file rehydration depends on is the one place where reading old data as
though it were new is silent wrong state rather than a parse error.

| File | Key | Ordering / index | Constraints |
|---|---|---|---|
| `meta.json` | `sessionId` from the directory name | — | Written by temp-file-then-atomic-rename, never in place, on exactly three occasions: create, a `state` transition, a `cliSessionId` change. Never per event (I16) |
| `events.ndjson` | `(sessionId, seq)` | `seq` ascending, contiguous from 1 | Append-only, written in `seq` order through the session's own append chain (D89). Not fsync'd per line. **Read backwards from the tail to locate `after + 1`, then emitted forward** — O(envelopes since the disconnect), not O(file). No offset index exists and none is planned (D163). **A `message.delta` is never appended**: it is a frame, not an envelope, so this file holds no line for one and a replay never produces one (D168, I51) |
| `tool-output/<turnId>/<callId>` | `(sessionId, turnId, callId)` | — | Written once, never appended. `turnId` is in the path because `callId` is vendor-minted and only *assumed* session-unique (I22). Bounded per session by `Caps.sessionToolOutputBytes`: past the budget the blob is **not written**, and the fetch answers `404 no_such_output` exactly as S9.5 already specifies (D162). Nothing already written is ever evicted |
| `attachments/<turnId>/<attachmentId>` | `(sessionId, turnId, attachmentId)` | — | Written once, never appended, fsync'd before the envelope naming it exists (I49). `attachmentId` is server-minted, so the operator's `filename` never reaches a path. A sidecar `attachments/<turnId>/<attachmentId>.meta` holds the stored `mediaType` as UTF-8 text, written the same way, so the read route can echo it for an allow-listed image type without scanning the spill for the `AttachmentRef` that named this id. Removed with the session (D25, D160) |
| `audit.ndjson` | append order | append order, read newest first | Server-wide. fsync'd before the decision it records reaches the child (I10). Never truncated, never deleted with a session (I13). Every read is a bounded window resumed by `AuditCursor` (I39) |
| `pids.ndjson` | append order; `pid` is not unique over time | append order | Server-wide. Two line shapes: a `ProcessRecord` at spawn, a `ProcessTombstone` at exit (D95). The latest line for a `pid` decides liveness; the spawn line carries everything else |
| `server.lock` | — | — | Server-wide, one `ServerLock` object, written before boot's first step and removed as shutdown's last act, after the children are gone (D161, D175). A shutdown that does not get that far leaves it. **Not append-only, and alone among these files rewritten repeatedly while the server runs**: every renewal is a whole-file write (D180). Reclaimed only on a holder whose `renewals` did not move across one observation window, whichever host wrote it. **Every write publishes the file whole, so a sample observes the previous contents or the next and never a torn file** (D196, I61). The mechanism differs by which write it is, and the difference is not cosmetic: a **claim on an absent lock is an exclusive create**, which must fail rather than overwrite when a second booting server got there first, while a **reclaim and every renewal are a temp-file-then-atomic-rename**, the shape I16 already gives `meta.json`, which must overwrite. Each sample is a fresh open-read-close. **The one file here where durability is irrelevant**: it is not fsync'd, because a lock lost to a host crash and a lock that survived one lead a booting server to the same correct outcome — claim with no wait, or reclaim one window later |
| `reviews.ndjson` *(tier two)* | `reviewId` | append order; the latest line for an id wins | Server-wide. Never rewritten. Survives deletion of the session it names (D67). Durable per line (D128). A `final` line is terminal — no later line for that id is written |
| `requisitions.ndjson` *(tier two)* | `requisitionId` | append order; the latest line for an id wins | Server-wide. Never rewritten. **Not durable per line**, which is why a lost consumption line reverts an approval to spendable — D68's written exception |
| `ckpt.git/` | git object ids | git history | Git is the store. `add -A` honours the workspace's own `.gitignore`, and neither `read-tree` nor `clean -fd` takes `-x`, so exactly the same set is left alone — which is what `ignored/<sha>.json` exists to report on |
| `ignored/<sha>.json` | the checkpoint `sha` | — | **Written by `checkpoints`, not by `store`** — it is the only artifact in this directory that is, because it is derived from the same `git status` the checkpoint is built from and is meaningless apart from a sha (D187). Written once after the commit that names it, never appended, never rewritten. Not durable: a lost manifest degrades a later restore's report to unknown and costs nothing else. **A checkpoint whose manifest is absent is still a valid checkpoint** — capture failure never fails the commit. Removed with the session directory (D25) |

**The four server-wide append files are the design's only shared mutable state on disk**, and
the claim that no lock is needed rests on each being opened once, as a single append stream
owned by `store`, with every writer going through it. Ordered appends through one stream in one
single-threaded process cannot interleave a partial line. **Two server processes over one
storage root would break that for all four, which is what `server.lock` prevents** (D161, D180) —
so the single-process premise is enforced rather than assumed.

**The one case the lease cannot cover is out of reach rather than tolerated, and that is what
draws the supported scope** (D180, D194). A holder that is alive but whose renewals are invisible to
an observing boot for a full window is declared dead, reclaimed, and then both servers do write to
these four files. No filesystem-only mechanism closes it; closing it needs a fencing token from a
service outside the storage root, which is the dependency D7 kept out. What it needs to happen at
all is a cache or a partition between the writer and the reader — and **a storage root is supported
on a local filesystem or a bind mount only** (D194), where two processes on one host share one page
cache and no such gap exists. So the case is not a hole inside the supported scope; it is what a
network-share root would reintroduce, and it is the reason one is out of scope until a gate
exercises it. Where it did occur, the displaced holder would detect it at its next renewal and stop
(I56), bounding the overlap rather than preventing it.

**"Durable" means fsync**, and for a rename the containing directory too. An append that has
reached the OS survives a process crash; it does not survive a host crash. Exactly two writes
are durable per line: the audit record before a permission response reaches the child (D26,
I10), and every review line before a review route's response reaches the caller (D128).
Ordinary spill appends are **not** fsync'd per line — the cost is unjustifiable at event rates
and the loss window is bounded by the OS writeback interval.

**A torn trailing line is dropped at read, and what dropping costs differs by file.** In an
*event* log the transcript is one event short. In a *latest-wins* log the previous line becomes
authoritative again — the record does not lose its tail, it travels backwards. A review reverts
to its prior draft; a requisition reverts to its prior state, and the sharpest case is a lost
consumption line, where an approval that was spent shows as `approved` again and one approval
can produce two sessions. Both new sessions still face the jail and the workspace busy check,
so the consequence is a bookkeeping lie rather than a hazard. It is accepted rather than
solved, and it is the one place D68's once-only claim can be untrue.

**Authority.** `lastSeq` is derived at boot from the tail of `events.ndjson`. Where `meta.json`
and the spill disagree, the spill is right (I17).

**Migration.** There is no deployed data. `spike/.data` is throwaway proof-of-concept storage
in an unversioned shape and is not migrated; it is deleted. Forward rules for the first shipped
shape:

| File | Existing data | Rule |
|---|---|---|
| `meta.json` | none | `schemaVersion` gates rehydration. An unknown version is treated exactly as a corrupt file: the session is skipped, logged, and its files left untouched |
| `events.ndjson`, `audit.ndjson`, `pids.ndjson` | none | Readers ignore unknown fields and drop an unparseable trailing line. Added fields must be optional; a removed or retyped field is a new `schemaVersion` on `meta.json` and a refusal to rehydrate older sessions |
| `reviews.ndjson`, `requisitions.ndjson` | none | Readers ignore unknown fields; added fields must be optional. A dropped trailing line does not shorten the record, it reverts it to the previous line for that id. **A removed or retyped field has no discriminator to gate on in these two files**; see `## Unresolved` 11 |
| `server.lock` | none | Rewritten whole at every claim **and at every renewal**, and removed at every clean release. Nothing reads a lock it did not just find, so there is nothing to migrate. A lock left by a build predating the lease carries neither `instanceId` nor `renewals`, which is a counter that can never be observed moving — the reclaim path, reached by the ordinary rule and not by a special case. **That is why D196's refusal is keyed on a file that will not *parse*, not on one missing a field**: a legacy lock is well-formed JSON and must reach the reclaim path, and a rule that refused on an absent `renewals` would strand exactly the deployment this migration story exists for |
| `ignored/<sha>.json` | none | Readers ignore unknown fields; added fields must be optional. **A file that fails to parse is treated exactly as an absent one**: the restore reports unknown rather than reading a partial manifest as a complete one (I58). There is no discriminator and none is needed — nothing rehydrates from it and a wrong answer here is a degraded report, not wrong state |
| `tool-output/*`, `attachments/*` | none | Opaque bytes; no schema to migrate |
| `ckpt.git/` | none | Git's own format; not ours to migrate |

## Public surface

Internal helpers are out of scope. Every entry below crosses a module boundary, and each names
the file that declares it. A **Markdown command file has no separate declaration to point at**;
this project has none, so every entry here is code.

### `contract`

Declared in `src/contract/index.ts`. Types, plus **two runtime exports**, each of a kind this
section admits and each named here: the enumeration of a closed union a validator must test
membership of — `RATINGS` (D150) — and the discriminator for a union the type system cannot
separate structurally — `isFrame` (D171). Everything else this module exports is a type and
leaves nothing behind at runtime.

**The property is stated as a rule so that it stays checkable**: a runtime export of neither
kind does not belong in this module, and one of either kind that is not declared by name in this
section is a defect in the section, not a permitted omission. It has widened twice, each time
against a named export and never speculatively.

`RATINGS` is the one runtime enumeration of `Rating`'s members, and it lives here rather than
beside its consumer because the edge validator that tests membership before accepting a
`Rating` on a review route would otherwise hand-copy the union — a second, independently typed
list free to drift from the one it validates. It is deliberately **not** the `VENDORS`
arrangement (D126): `Vendor`'s list sits in `adapters` beside the `createAdapter` switch that
makes each member runnable, and `Rating` has no such switch, its members being validated and
stored rather than dispatched on. Nor may it move to `records`, which is tier two, while the
tier-one edge needs this vocabulary to parse a body.

**A caller may rely on the array holding every member of `Rating` and no other value. It may
not rely on the order**: the tokens read as a scale, but nothing ranks or compares them, and
`Rating` is display-independent besides (D82).

**`isFrame` is the one place the frame-versus-envelope test is written** (D168, I51). A `Frame`
is an `Envelope` minus `seq`, so the two are not separable structurally by anything a consumer
can name, and every module that must tell them apart otherwise repeats the same negative test.
It lives here rather than beside either consumer because I51 *defines* a frame in this module's
own vocabulary, so the discriminator belongs beside the types it discriminates; moving it to
`session-manager` was rejected for putting a predicate over `contract`'s types in the largest
module in the system, and for giving `edge/sse` a concrete import where it takes the manager by
injection today (D171).

**A caller may not repeat that test inline.** Two independent copies of the I51 discriminator is
the drift the `RATINGS` argument above was written against, and it is the sharper case of the
two, because a wrong copy does not fail loudly — it silently spills or replays a frame, against
I51. What a caller may rely on is the predicate's *meaning*: a true answer says the value carries
no `seq` and therefore has no position in the replayable stream. **Its implementation is not
contractual** and moves with `Frame`; nothing may reimplement it from that meaning.

### `config`

`loadConfig` is declared in `src/config/index.ts`. It reads the environment and returns a
validated `Config` or a `ConfigError`; it never partially applies a configuration and never
warns instead of refusing.

**`config` depends on `jail`, and the edge runs that way round and not the other** (D94).
`config` must canonicalise each declared workspace root with **the same normalisation** the
jail applies to a candidate, or a legitimate `cwd` is refused for spelling — a Windows 8.3
short name, a `\\?\` prefix, a case variation. That is why `workspaceRoots` is
`readonly ResolvedPath[]` and why `jail` exports `stripExtendedPrefix`.

**`storageRoot` goes through the same normalisation, and then the server refuses to start if it
overlaps any workspace root** (D185). `loadConfig` calls `pathsOverlap` — the jail's, never a
second predicate — against every declared root and returns
`ConfigError.invalid_field { field: 'STORAGE_ROOT' }` naming the root it collides with. Storage
inside a workspace puts `meta.json`, the spills, `audit.ndjson`, `pids.ndjson` and every
`ckpt.git` inside a checkpoint's own work-tree: `add -A` would ingest live server state and grow
recursively, and a restore or `clean -fd` would delete evidence this server is mid-write on,
including the audit log that exists to be beyond the reach of the subject it indicts (I13).

**The refusal is at startup and not at session creation**, and that is the decision rather than
an implementation convenience. Refusing per session would let a misconfigured deployment serve
the workspaces that happen not to collide, trading one loud failure for a quiet partial one —
the same argument `insecure_bind` makes, and sharper here because what is at risk is server-wide
evidence rather than one session's files. **No new error variant is minted for this**: the field
genuinely is invalid relative to `WORKSPACE_ROOTS`, and a variant whose only caller is this one
check is a contract surface this refusal has no standing to add.

### `identity`

`IdentityRequest`, `IdentityResolver` and `resolverFor` are declared in
`src/contract/index.ts` (the types) and `src/identity/index.ts` (the function).

One resolver per deployment mode. The resolver is handed the request's headers and its
`remoteAddress`, and **the second is not decoration**: under the header-trust modes a trusted
header is only trustworthy if the client cannot set it, so the resolver refuses
`untrusted_proxy` for an identity header arriving from an address outside `trustProxy`.

**Under `auth.mode === 'shared-secret'` the resolver returns one `OperatorId` for every
caller**, because a shared secret authenticates the deployment and not a person, and D3 refuses
the operator record that would fix it. Four consequences follow and are stated in
`10-design.md § Threat model`; the contract-level one is that
`404 no_such_session` stops being access control under that mode. **Nothing here enforces a
refusal**: the server does not decline to start under `shared-secret`.

### `jail`

`resolveInsideRoot`, `pathsOverlap` and `stripExtendedPrefix` are declared in
`src/jail/index.ts`.

- **`resolveInsideRoot` is the only minter of a `ResolvedPath`.** It accepts a candidate only
  if its fully resolved real path — symlinks followed, `..` collapsed, case-normalised on
  Windows — is inside a root. `JailError.unresolvable` is a refusal, not a fallback: the jail
  admits only paths *proven* inside a root.
- **`pathsOverlap` is the one containment predicate in this server**, and no module may
  hand-roll a second. It is true when the two paths are equal **or either contains the other**,
  under the same normalisation `resolveInsideRoot` applies. Both arguments must already be
  jail-resolved. It has two callers and no others: `session-manager`'s workspace busy check
  (D30, I6), and `config`'s startup check that storage does not sit inside a workspace root
  (D185, I60). **The second is why "both arguments must already be jail-resolved" is a
  requirement on `config` and not only on this module** — a raw `storageRoot` string could not
  have been compared at all, whatever the predicate.
- `stripExtendedPrefix` normalises away the `\\?\` extended-length prefix a native realpath
  returns on Windows. It is exported for `config`'s use, above.

**The roots arrive as a parameter**, which is what keeps `jail → config` undrawn. `jail`
depends on `contract` alone.

**What this module does not do is stated because the misreading is the likely one** (D28): the
jail decides where a session may *start* and pins `cwd` so it cannot drift between turns. It
does nothing about where the child process may reach once running. `workspaceRoot` is not a
sandbox.

### `store`

`LoadedMeta`, `Store` and `createStore` are declared in `src/contract/index.ts` (the types) and
`src/store/index.ts` (the factory).

`store` owns `meta.json`, the spill, the tool-output and attachment blobs, `audit.ndjson`,
`pids.ndjson`, `server.lock`, the ring buffer, and the two record logs. It depends on `config`
and `contract` and on nothing else.

What the declarations cannot say:

- **`readAllMeta` never aborts boot.** It returns one `LoadedMeta` per session directory, each
  carrying its own `Result`, so a corrupt or unknown-version `meta.json` costs that session and
  no other.
- **`readRingAfter` returning `null` means "cannot serve", not "nothing to serve".** An empty
  array is a real answer; `null` sends the caller to the spill.
- **`readEventsAfter` locates `after + 1` by reading backwards from the tail**, then emits
  forward. It is O(envelopes since the disconnect) and not O(file), which matches the access
  pattern rather than fighting it: a reconnect's `Last-Event-ID` is recent almost by definition.
  No offset index exists and none is planned (D163).
- **`appendAudit` and `appendReview` are durable: fsync'd before they return** (I10, D128).
  No other append is.
- **`readOpenPids` must never hand back a tombstone as an open record** — see *Types § Process
  record* for the requirement and why.
- **`readAuditPage` is bounded and never scans the whole file** (I39). See *Types § Audit
  record* for what the bound counts.
- **A record-log read failure yields an empty list and never aborts boot** (I38). Tier two
  failing must not deny an operator tier one.
- `writeAttachment` carries `mediaType` alongside the bytes so that a later `openAttachment`
  can answer the read route's allow-list check without scanning the session's spill for the
  `AttachmentRef` that named the id.

**`ServerLock`, `Store.claimLock` and `Store.releaseLock` are declared in
`src/contract/index.ts` (the type) and `src/store/index.ts` (the bodies). `claimLock` no longer
receives a `LivenessProbe`** (D180): there is nothing left for a probe to answer, and `store`'s
independence from process enumeration — which is what the parameter bought — is now structural
rather than arranged.

**A third method joins them, and it has no declaration to point at yet** (D195):

```ts
type LockRenewal = 'renewed' | 'displaced';

renewLock(): Promise<Result<LockRenewal, StoreError>>;
```

`displaced` is a **success**, not an error: the call did what it was asked to do and found that this
process no longer holds the root. Modelling it as a `StoreError` would put it beside `io` — a
failure the caller may reasonably log and carry on past — and this is the one outcome no caller may
ever carry on past. A `StoreError.io` here means the renewal could not be attempted, which is not
the same thing and does not by itself mean the root was lost.

**`claimLock` decides by observation, and the observation is the expensive part.** Finding a lock
at all costs one full observation window before this server may do anything: sample
`(instanceId, renewals)`, wait the window **on this process's own monotonic clock**, sample again.
No wall clock is compared, across hosts or otherwise. D194 narrows the supported storage classes to
a local filesystem and a bind mount, so no cross-host claim is being made today — the property is
kept because it costs nothing, because it is what any later widening would have to rest on, and
because the alternative it rules out is worse on one host too: a wall-clock `expiresAt` compared
against the reader's own clock declares a live server dead the moment the two disagree, and an NTP
step is enough.

**`claimLock`'s decision table, which the signature cannot carry:**

| Lock file | Outcome |
|---|---|
| absent | Write `self`. Claimed, **with no wait** — the ordinary restart, and keeping it out of the window is the whole return on releasing cleanly (D175) |
| present, `(instanceId, renewals)` changed across the window | Refuse. `StartupError.storage_locked` naming the holder's `pid`, `hostname` and `startedAt` — informational fields, printed because a refusal that cannot say *who* is most of the way to useless |
| present, `(instanceId, renewals)` unchanged across the window | Reclaim: log the holder, overwrite with `self`. Claimed. **Whichever host wrote it** — there is one rule here, and the absence of a second is the correction (I50) |
| present but unparseable | Refuse. `StartupError.storage_lock_corrupt`, naming the path (D196). **This is corruption, not a race**: every write publishes the file whole (I61), so a sample sees the previous contents or the next and never a partial file. It is also not a legacy lock — one written before the lease parses cleanly and simply carries no `renewals`, which takes the row above (I61) |

**The holding host has left this table, and the deletion is the point.** D161's rule — a lock
naming another `hostname` is never reclaimed — made a recreated container's refusal permanent,
since recreating changes the hostname and nothing ever reclaims a foreign lock. It is deleted
rather than relaxed, and what it was guarding against is covered instead by never consulting a
process table.

**D194's local-only scope does not make "whichever host wrote it" vacuous, and reading it that way
is the mistake the narrowing invites.** A hostname is not a machine here. Two containers sharing one
bind-mounted storage root sit on one host and answer to different hostnames — that *is* the
`docker compose up -d` recreate path D180 was opened on, and it is inside the supported scope. So a
lock naming a hostname this process does not recognise is still an ordinary, expected observation,
D181's reap guard is still load-bearing for `pids.ndjson`, and neither becomes dead code.

**A failed `claimLock` must leave every server-wide file byte-identical.** The claim precedes
reaping specifically so that a second server cannot take down the first server's running work
before anything else goes wrong (D161).

**Release and renewal are both ownership-checked, and the renewing half is the more valuable
one** (D180, I56). `releaseLock` removes the file only while it still carries the `instanceId`
this process claimed with, so a server that stalled long enough to be reclaimed and then shut
down tidily cannot delete its *successor's* lock and leave the root open to a third. Renewal
applies the same check as it writes: a holder finding the lock absent, or carrying another
`instanceId`, has lost the storage root and must stop rather than go on writing server-wide state
it no longer owns. That is what turns "two servers over one storage root" from the silent state
D161 correctly said an operator cannot diagnose from symptoms into a detected and logged one.

**`store` renews on demand; it owns no clock** (D195). `renewLock` performs one ownership-checked
write and reports which of the two things happened. It starts no timer, holds no interval, and
schedules nothing — `store` has no lifecycle anywhere else in this design, and giving it one here
would make every test that claims a lock responsible for tearing a timer down. **`server.ts` drives
the clock**, which is the module that already owns exiting and already holds the drain and release
bounds; what a displaced holder's stop travels through is stated under *`server`* below.

**The window and the interval are module constants, and they live in one file so that their
relation is enforced rather than requested** (D194, D195, I62):

| Constant | Value | Home | Read by |
|---|---|---|---|
| `LOCK_OBSERVATION_WINDOW_MS` | 10 000 | `src/store/index.ts` | `claimLock`, and nothing else |
| `LOCK_RENEWAL_INTERVAL_MS` | 2 000 | `src/store/index.ts`, exported | `server.ts`'s timer |

The interval must stay strictly below the window with room to spare — at 2 000 against 10 000 a
live holder has to miss five consecutive renewals before it is declared dead. **Violating that
relation has no symptom short of two servers over one storage root**, which is why the interval is
declared beside the window and imported rather than written a second time in `server.ts` beside the
drain's bound, where the two could drift apart in separate commits with nothing to catch it. Neither
is a `Config` field: D194 fixes the supported storage classes to a local filesystem and a bind
mount, so no correct value here depends on how an operator mounted anything, and this document's
standing ruling stands — promoting either to a deployment flag is a contract amendment.

**The cost is one window, and only where a lock is found.** An absent lock claims immediately, so
the wait falls on an unclean restart and never on the ordinary one, which is the whole return on
releasing cleanly (D175) and the reason `30-slices.md § S22.5` instruments the reclaim and expects
it uncalled.

**Every write of the lock publishes it whole, and which mechanism does that depends on the
write** (D196, I61). A **reclaim and every renewal** go through the temp-file-then-atomic-rename
helper the same module already uses for `meta.json` under I16, writing into the same directory so
the rename stays on one volume — they must overwrite what is there. A **claim on an absent lock does
not**, and must not: `rename` overwrites unconditionally and so cannot detect that a second booting
server made the same "absent" observation and wrote first, which is why the claim is an exclusive
create instead — atomic, and failing rather than clobbering. Both publish a complete file or none,
which is all I61 asks; only the claim additionally needs to lose a race it did not win. That is what
makes the unparseable row above a refusal rather than a guess: a reader observes the previous contents or the next, never a
partial file, so a lock that will not parse is corruption and not a renewal caught in flight. **It
is deliberately not fsync'd.** This is the one file here whose durability buys nothing — a lock lost
to a host crash and a lock that survived one lead a booting server to the same correct outcome, and
the holder that wrote it is gone either way.

### `checkpoints`

`Checkpoints` and `createCheckpoints` are declared in `src/contract/index.ts` (the type) and
`src/checkpoints/index.ts` (the factory). It depends on `config` and `contract` and **never on
adapters**, which is what let the shadow-git mechanism survive the move to two backends
unchanged.

**`restore` returns the safety checkpoint, never the target** — as `RestoreResult.safety`,
since the return type grows to carry the report as well (D182), an amendment owed to the
declaration. Its sequence is five operations of which the second is not D31's (D112):

```
commit    --allow-empty -m "before restore to <sha>"    a way back
read-tree --reset -u <sha>                              make the work-tree match, exactly
clean     -fd                                           remove directories read-tree emptied
verify    diff --quiet <sha>, ls-files --others         prove it, do not infer it
report    <sha>'s manifest vs status --ignored=matching say what was not reached
```

**The report runs last and would give the same answer first**, which is worth stating because it
is the symmetry claim restated as an ordering fact: no step between touches an ignored path, so
the ignored set restore finds at the end is the set it would have found at the start. Running it
last means it never delays the restore and never has a way to prevent one.

**D31 specified `checkout <sha> -- .` and that sequence cannot do what D31 says it does.** The
argument was that `clean -fd` removes what the agent created since the target. It does not,
because D31's own first step prevents it: the safety commit runs `add -A`, so every file the
agent created is *tracked* by the time the second step runs, `checkout <sha> -- .` writes only
paths the target's tree holds, and `clean` never removes a tracked path. That is precisely the
failure D31 exists to close, reintroduced by D31's own opening move. `read-tree --reset -u`
makes index and work-tree match the target exactly — additions, edits and removals alike —
**without moving `HEAD`**, so the shadow history stays linear and `list`'s `git log` still walks
it.

**Ignored paths are neither checkpointed nor cleaned.** `add -A` reads the workspace's own
`.gitignore`, and neither `read-tree` nor `clean -fd` takes `-x`, so exactly the same set is
left alone. The pair is deliberate and symmetric: a restore can only remove things a checkpoint
could have restored, so it never forces a dependency reinstall — the failure that would make
operators stop using restores.

**The exclusion is reported rather than silent, and reporting it is what the manifest is for**
(D182). Symmetry keeps a restore from forcing a reinstall; it does nothing to make the operator's
belief about what was rolled back true. An agent that edits `.env` or deletes a generated
artifact leaves that change standing across a restore this console reports as successful. So
`commit` captures an `IgnoredManifest` alongside every checkpoint and writes it to
`ignored/<sha>.json`, and `restore` diffs the target's manifest against the workspace and returns
what differs as `RestoreResult.unreached`.

Three obligations follow, and none of them is optional:

- **A capture failure never fails the commit.** A checkpoint is worth more than its manifest, and
  a `status` that cannot run must not cost an operator their way back. The checkpoint returns
  normally and no manifest is written — which a later restore reports as unknown.
- **`unreached === null` is unknown and never "nothing differs"** (I58). Absent manifest,
  unparseable manifest, failed `status` at restore time: all three are `null`. An empty array is
  the positive answer.
- **A manifest is never consulted for anything but this report.** Nothing gates on it, nothing in
  *Error semantics* branches on it, and no security control may come to lean on it — the
  collapsed-directory weakness under *Types § Checkpoint* is why, and it is invisible at the call
  site, so the constraint is written where the call site is.

**Success is verified, not inferred from an exit code.** `read-tree` exits 0 with only a warning
when it cannot remove a directory an embedded repository occupies, and `clean` declines such a
directory unless forced twice, which this deliberately never does. So the sequence ends with
`diff --quiet <sha>` for tracked content and `ls-files --others --exclude-standard` for what was
left behind. Either coming back dirty is `CheckpointError.restore_incomplete`, and the workspace
is then **partially restored** — a state this code detects and reports rather than one it
accepts silently. No step is atomic; the safety checkpoint is the way back.

**`init` failing is not fatal to a session.** The session proceeds without checkpoints and says
so; DoD #6 is unavailable for it and nothing else changes. A workspace needs no git repository
of its own — the shadow `GIT_DIR` is in server storage and the operator's real `.git` is never
touched.

### `adapters/*`

`AdapterNotification`, `AdapterEmitted`, `AdapterEvent`, `AdapterOptions`, `AttachmentPayload`
and `Adapter` are declared in `src/contract/index.ts`; `VENDORS` and `createAdapter` in
`src/adapters/index.ts`; the two adapters in `src/adapters/claude/` and `src/adapters/codex/`.

**Adapters are leaves.** They depend on `contract` and nothing else: they do not read config,
do not touch the store, do not write audit records, and do not know whether a turn is in
flight. They are handed a resolved `cwd` and one outbound channel and that is their entire
world. This is what keeps a second vendor from becoming a second architecture, and two edges
must never be drawn: **adapter → session-manager**, to ask whether a turn is running, and
**adapter → store**, to write the audit record where the decision is known.

**The outbound channel is `notify`, a four-member union rather than a bare `emit`** (D46).
Three facts have to reach the manager that are not normalised events — the `cliSessionId` from
every `system/init`, the spawned child's pid, pgid and image, and the child's exit — and with an
envelope-only callback there is no signature for any of them, so the first implementer either
draws a forbidden edge or smuggles them through `raw`. **The adapter emits payloads carrying no
`seq`, no `sessionId`, no `ts` and no `turnId`; the manager assigns all four.**

**Five kinds an adapter may never emit**, and `AdapterEmitted` excludes each for a reason:
`session.started` and `session.ended` are the manager's lifecycle, `checkpoint.created` is
`checkpoints`', `checklist.item.completed` originates with an operator rather than a child
process, and **`permission.resolved` is the manager's because resolution owes an audit record**
(D97, I11). The manager holds the `pending` map, deletes from it synchronously (D33) and appends
the record every resolution owes; an adapter resolving a request of its own would produce a
resolution with no audit record and leave the manager's map holding an entry nothing will clear.
What the adapter contributes when its child dies is the `exited` notification — deciding that
every outstanding request is now `cancelled_process_exit` is the manager's, in the same place it
decides it for an interrupt and for a turn boot closes.

**`send` spawns the turn's child, writes the message to stdin, and holds stdin open for the
life of the turn.** Closing it after the prompt forecloses the permission feature entirely and
is the obvious first implementation. `kill` is terminate-then-force **on the process tree**, not
on the pid: the recorded process is the agent CLI, and what holds the workspace open is whatever
it spawned. Terminate-then-force is the POSIX half only — Windows has no signal to be graceful
with, so `taskkill /T /F` is one step and the grace period has nothing to elapse over (D148).

**`Adapter` gains nothing for shutdown, and that is deliberate** (D178). There is no `detach`,
and no way for an adapter to be told the server is stopping: the silence step 3 needs lives on
`SessionManager`'s own notification sink instead (I55) — one public addition rather than two,
since the manager surface is needed either way. A vendor adapter still knows nothing about
server lifecycle, which is the direction I20 fixes.

**`policy` is the vendor's capability, fixed at create**, and is what the client renders as
either "you will be asked" or a standing sandbox banner. `sandbox` is the operator's choice and
is validated by the adapter.

**`acceptsAttachments` is a capability, not a vendor test** (D160). It is read to refuse
`attachments` with `422 bad_request` on a vendor whose transport carries no non-text content,
which is a question about a capability and not about which vendor this is — so I20 holds. **The
reader is `session-manager`, not an edge**, along with the two attachment caps beside it: an edge
holds no reference to a live session's adapter, and giving it one would put an adapter capability
on `SessionManager`'s interface to relocate a check whose refusal is identical either way.

**`VENDORS` is the one enumeration of `Vendor`'s members and it is declared beside
`createAdapter`'s switch, not in `contract`** (D126), because a list that is not beside the
dispatch it authorises is a list free to gain a member nothing can create.
`edge/http-common` imports it to validate a `vendor` on a request body, which is the one read
D10 permits an edge to make of this module: **testing membership of a closed union is not asking
which vendor this is.** A caller may rely on the array holding every member of `Vendor` and no
other value, and on no member of it reaching `createAdapter`'s `unsupported_vendor` — that
second property is what keeping the list and the switch in one file buys, and it is not the same
as the call succeeding, which `unsupported_sandbox` may still refuse. Nothing may rely on the
order.

**A vendor adapter may accept one thing beyond `AdapterOptions`, and it is a test seam rather
than a deployment knob** (D91). `createClaudeAdapter` and `createCodexAdapter` each take an
optional `executable`, defaulting to `SKYNET_<VENDOR>_EXECUTABLE` and then to the vendor's own
name, so a fixture CLI speaking the documented wire shape can stand in for the real binary over
a real child process — which is what verifying the permission round trip rests on. It is
deliberately **not** a `Config` field: a deployment that can repoint the agent binary from the
environment is a deployment where the audit log names a program nobody chose. `createAdapter`
does not expose it, so nothing above `adapters/*` can reach it.

**Transport selection is the adapter's alone and it ends there.** `createAdapter` takes no
transport parameter and none is added: a transport is a vendor fact and I20 forbids one above
`adapters/*`.

### `records` *(tier two)*

`RaiseRequisitionInput`, `CreateReviewInput`, `ReviewPatch` and `Records` are declared in
`src/contract/index.ts`; `createRecords` in `src/records/index.ts`.

It owns the review and requisition lifecycles and their in-memory registries, and depends on
`config`, `store` and `contract` — **never on `session-manager`** (D77). It is handed a
`SessionSnapshot` as a parameter; **it does not know a session registry exists.** The edge is
what composes the two: the edge resolves the session through `session-manager`, applies the
ownership check it applies to every session route, and hands the snapshot down. Making `records`
ask the manager for one would put a live-session dependency inside the module whose whole point
is outliving sessions.

**Both registries are held in memory as well as on disk, and that is not convenience**: the
once-only requisition claim has to be tested and taken in one synchronous block (D32, I5), which
a file read cannot be.

What the declarations cannot say:

- **`boot` never fails.** An unreadable log yields an empty registry and a log line, because
  tier two must not deny an operator tier one (I38).
- **`claim` is synchronous** — it tests `state === 'approved'` and takes the claim in the same
  block. `attachSession` and `release` complete the three steps control flow 1 draws.
  **`release` is in-process only: a crash between claim and attach leaves the approval spent**
  (D80). That is a dead approval and a new one is raised; it is not recovered.
- **A failed append leaves the registry unmutated** (I37), which is the reverse of the audit
  path's ordering and deliberately so (D26). Neither write is irreversible and nothing
  downstream acts on it, so losing a retypable edit is a smaller failure than the registry
  claiming a `state` the disk does not have — which the next boot, reading the disk, would
  silently revert.
- **What is claimed synchronously for `decide`, `appendReview` and `finaliseReview` is an
  exclusivity lock distinct from `state`** (D120). The lock is tested the way `turn == null` is
  tested and is never itself written back as the answer; it releases when the write settles
  either way, and `state` changes only once that write has durably succeeded. D32 still holds
  without exception — the correction is naming the protected thing correctly as the lock, not
  the state it will eventually hold.
- **`getReview` and `appendReview` answer `no_such_review` — never a distinct forbidden — for a
  draft belonging to someone else**, matching D50's treatment of a session an operator does not
  own.
- **`listReviews` returns finals only**, for every caller including a draft's own author (I31).
  An author reaches their own draft by id.
- **`CreateReviewInput` carries `subject` and the supplied `SessionSnapshot` carries
  `sessionId`; the two must name the same session**, and `records` refuses with `bad_request`
  when they do not. It is the one consistency check it can make without resolving a session it
  is forbidden to resolve.
- **`getRequisition` has no caller today and is retained rather than removed** (D145): every
  client read path goes through `listRequisitions`, and a decision route reporting current state
  without listing all of them is the obvious next caller.
- **`isUnderPip` has no caller above `records` today, and that is the shape D72 forces rather
  than an omission**: PIP is derived and never served as a session field, so the fold runs
  wherever the finals already are — which for the badge is the client, over
  `GET /api/reviews?subject=`. It is kept as the server-side statement of I35, so the invariant
  can be asserted against an implementation in the module that owns it instead of only against
  browser code (D145).
- **There is no `revoke` and no expiry** (D81, I32).

### `session-manager`

`CreateSessionInput`, `PermissionAnswer`, `SubscriberSink`, `Subscription` and `SessionManager`
are declared in `src/contract/index.ts`; `createSessionManager`, `parseStandingRule` and `match`
in `src/session-manager/index.ts`.

It owns ownership, turn state, `seq`, fan-out, reaping, the payroll fold, and the audit read and
the incident view over it. **The audit read is here and not on `records`** because `records` is
tier two and `GET /api/audit` is tier one, which must work in a build where tier two's module
does not exist (D157, `## Unresolved` 5).

What the declarations cannot say:

- **`boot` runs six steps and the order is the point**, and nothing in it may abort boot:

  ```
  0. lock       claim <storage>/server.lock, or refuse to start                    (D180)
                a renewing holder → refuse; an unmoved counter → reclaim, logged
  1. reap       pids.ndjson entries with no exitedAt, subject to the reuse guard   (D23)
                only records this host spawned; another host's are left alone      (D181)
                kill the process TREE, not the recorded pid                        (D38)
  2. rehydrate  meta.json → registry, every session marked ended                   (D20)
  3. mark       one session.notice / server_restart per session live at shutdown   (D130)
     close      any turn the spill left unterminated, by appending to the spill    (D39)
  4. load       the two record logs → registries, latest line per id  (tier two, D65)
  5. listen     only now are connections accepted                                 (I18)
  ```

  **Step 0 precedes step 1 and that ordering is the whole point of the lock.** Reaping kills
  process trees it believes are orphans and cannot tell another server's live agents from its
  own dead ones, so the claim comes before the first destructive act rather than merely before
  `listen`. **Step 0 hands `store` nothing any more** (D180): the reuse guard stays here and
  serves step 1 alone, because the lock is decided by watching a counter rather than by asking
  this host about a pid.

  **Step 1 reaps only what this host spawned, and that guard arrives with step 0's** (D181).
  Reclaiming a lock another host wrote is now possible and `pids.ndjson` is read immediately
  afterwards, so without it the reaper would look a foreign pid up in the local process table and
  kill whatever holds that number — the exact wrong kill D23's guard exists to prevent, reached by
  a route D23 never covered. A foreign record is left alone in both directions: not killed, not
  tombstoned. **The residual is stated rather than hidden** — an orphan on a host that has lost the
  root survives until *that* host next boots successfully, which is the smaller of the two costs.
  **Reaping precedes rehydration** so no rehydrated session is adopted by an orphan still
  holding its workspace. **Listening comes last** so no client observes a half-loaded registry —
  a `GET /api/sessions` answered mid-rehydration reports a partial list as though it were
  complete, which is a wrong answer rather than a slow one. **Step 4 runs before listening
  because the requisition guards are synchronous** and a claim that must be taken without an
  `await` cannot read a file to find out whether the requisition is approved.

  **Every step here repairs state some earlier process left, and shutdown deliberately leaves
  all of it** — see *`server`* below, and I52. So `server_restart` fires on an orderly stop
  exactly as it does after a power cut: boot cannot tell them apart and is not asked to.
- **A turn ends by ending everything it spawned, on every path it can end by** (D184, I59).
  The tree kill is not the interrupt path's and boot reaping's alone: normal completion — a
  `result` followed by `close(0)`, which is the overwhelmingly common way a turn ends — kills the
  tree too, before `turn.ended` is emitted and before the turn slot is cleared. **There is one
  way to end a process tree in this server (D38's) and no path may grow a second.**

  **What a caller may rely on is the whole point**: when `turn.ended` is observable, no process
  that turn started is still running. Without that, "no turn means no child" meant only "no CLI"
  — a tool that starts a detached dev server, watcher or daemonised runner left it holding the
  workspace while the session reported idle, the workspace claim was released and the next
  session admitted. That is a restore failure on Windows by the exact mechanism the per-turn
  child is supposed to make impossible, and a silent cross-session race on POSIX.

  **The capability this costs is stated rather than discovered: an agent cannot leave a server
  running past the end of its turn.** Asked to start a dev server and report the URL, it starts
  one that dies with the turn. That is a real loss, accepted because the alternative is a
  workspace exclusivity claim and a restore guarantee both conditional on something no component
  can observe.
- **`boot` has exactly one counterpart, and it exists because shutdown's step 3 has nowhere
  else to live** (D178; *`server`* below for the step it serves). Declared as `shutdown(): Promise<void>` on `SessionManager` in `src/contract/index.ts` — no owner, no arguments, like
  `boot`, and **returns no `Result`**: shutdown is best-effort throughout and no error union
  gains a variant for it. It does three things, in this order:

  ```
  0. mute    the manager's own notify sink stops delivering, every kind      (D178, I55)
  1. kill    adapter.kill() for every live turn — the TREE, D38's mechanism  (D177)
  2. record  one ProcessTombstone per child killed, written at kill time     (D178)
  ```

  **The mute is at the sink and not in the `exited` handler, and the tree is what settles
  that.** A tree kill by any route drives the adapter's `exited` notification, whose handler
  resolves every outstanding permission — a `permission.resolved` emitted and an `AuditRecord`
  appended for each, as I11 requires — and the adapter's `turn.ended` follows it as a *second,
  separate* notification inside the same synchronous callback. A mute written into the handler
  would catch the cancellations and miss the turn's closure, which is both an emission during
  teardown (I52) and a shutdown reported under a stop reason D24 reserves for the operator's
  own act. Muting where every notification already passes catches both and leaves no second
  path for a later change to forget. **It covers all four members of `AdapterNotification`, not
  the three the outcome turns on**: a `spawned` arriving behind the mute is dropped too, so that
  child is never recorded in `pids.ndjson` and no tombstone is owed for it — it is killed all
  the same, because the adapter holds it.

  **The mute is one-way, and shutdown is its only caller.** Nothing clears it, and no parameter
  narrows it to one session. A method that could blind a live session while the server keeps
  running is the hazard that kept this off `Adapter` as a `detach` (*`adapters/*`* above).

  **The tombstone is written at kill time rather than in response to an exit**, which is what
  the mute buys rather than what it costs: with the sink muted the manager never learns the
  child died, so the record no longer has to win a race against whatever budget the drain has
  left. It names the pid this server recorded for that turn at `spawned`. **Shutdown never
  reads `pids.ndjson` to decide what to kill** — its targets are the live sessions this manager
  already holds, and finding them in the file is the "repair what you find" side of D177's
  distinction, which shutdown is not on. How the pid reaches this point is internal to the
  module and is not a surface question.
- **`CreateSessionInput.cwd` is the client's string and is never used after the jail check.**
  `model` is constrained rather than free text — `/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/`, else
  `422 bad_request` — because it reaches a child's argv, which Windows passes through a shell
  (D90). `requisitionId` is optional and **never a gate** (D68): supplied, it is claimed once and
  only from `approved`; absent, nothing in the path changes.
- **`PermissionAnswer.rule` is required, and only permitted, when `scope === 'always'`**, and is
  operator-typed at answer time rather than parsed from a vendor suggestion. `scope: 'always'`
  additionally requires `decision === 'allow'` and a non-null `matchTarget` on the named request
  (I43). **None of those four failures is silently downgraded to `once`.**
- **`answerPermission` returning `{ accepted: false }` is not an error.** It means another
  client answered first, and it carries `200`.
- **`interrupt` takes a `turnId` and that is not a formality.** Two clients are an explicitly
  supported shape: client 1's interrupt for turn N can be in flight as turn N ends on its own
  and client 2 starts turn N+1. Unscoped, that interrupt terminates a turn nobody asked to stop,
  seconds in, reported as an expected interruption and attributable to no one. It returns
  `{ ok: true }` and emits nothing when there is no live turn or when `turnId` does not name it:
  **an interrupt is a statement about a desired end state, not a command that can arrive too
  late.**
- **Interrupt does not undo anything.** Files the agent already wrote stay written; the
  checkpoint taken before the turn is what returns the workspace, and that is a separate operator
  action.
- **`subscribe` replays from the ring, else from the spill, else delivers one
  `error / replay_gap`, then joins the live stream** — for live and ended sessions alike (D40).
  **A replay never yields a `message.delta`**, because neither store holds one (I51); a subscriber
  receives deltas only for the part of the stream it was attached for.
- **`emit` assigns no `seq` to a `message.delta` and neither spills nor rings it** (D168, I51). A
  frame goes to the current subscribers and nowhere else. That is the whole of the exception —
  `sessionId`, `ts` and the payload's `turnId` are assigned exactly as for any other kind, and
  every other kind still takes a `seq` from the same synchronous prefix, so I1's contiguity is
  untouched rather than relaxed.
- **`tickChecklistItem` is idempotent**: a second tick for an item already complete emits no
  second envelope and still succeeds (I36).
- **`readAudit` and `getSnapshotForReview` take no owner and apply no ownership check**, unlike
  every other method here, because D70 opens both reads to every authenticated operator
  regardless of session ownership. They sit on this interface only because it already bridges
  edges to `store`, not because either read is about a session the caller owns (D127).
- **The `records` dependency is one-directional and exists for the claim during `create` alone.**
  Nothing else in the manager may call it, and `records` may never call back.

**Standing rules.** `parseStandingRule` and `match` are pure and total: no I/O, no state, no tool
knowledge, no vendor knowledge.

- `parseStandingRule` is **the only way to mint a `StandingRuleExpression`**. It returns `null`
  for anything failing the grammar in *Types § Identifiers and scalars*, which `answerPermission`
  maps to `bad_request` naming `rule`.
- **`match` reads `rule`, `request.tool` and `request.matchTarget` and nothing else — never
  `input`** — which is what keeps tool-shape knowledge inside `adapters/*` (I46). It returns
  `false` whenever `matchTarget` is `null`, so **an unprojectable tool is unmatched rather than
  universally matched.**
- **A rule lives in its session's in-memory state and nowhere else**: no field on
  `SessionRecord`, no line in any file, no entry in `meta.json`. **There is therefore no
  persisted schema and no migration story for standing rules — that is the ruling, not an
  omission** (I45). A session rehydrated at boot holds none and the operator is asked again.
  This is stronger than "a new session on the same workspace asks again", and deliberately: a
  grant outliving the process holding it cannot be revoked by ending the session, which is the
  only revocation this design offers.
- **A standing rule is never handed to the child.** `updatedPermissions` is not written to
  stdin under any decision (I47) — that is the whole of D35 and the reason this grammar exists
  at all. Handing the grant to the CLI persists it outside this server's storage, where every
  later match runs with no `can_use_tool` on the wire: no event, no audit record, in this
  session or in a later one on the same workspace owned by someone else.

### `edge/sse` and `edge/ws`

`EdgeDeps` is declared in `src/contract/index.ts`; `createSseEdge` in `src/edge/sse/index.ts`,
`createWsEdge` in `src/edge/ws/index.ts`. The two modules they compose through are
`src/edge/error-envelope/index.ts` (the one `ApiErrorCode → HTTP status` mapping) and
`src/edge/http-common/index.ts` (everything about a request that is not framing: the origin
check, identity resolution, login, body reading, the `AuditQuery` parse, and the handlers both
edges share).

**D10 forbids the two edges importing each other; it does not forbid a third module both
compose through**, and that distinction is what keeps two transports answering one request
identically instead of by parallel maintenance.

**Both edges apply the origin allow-list before resolving identity** (I24). `edge/ws` applies it
at the **handshake**, not at first-message auth: browsers do not apply the same-origin policy to
WebSocket connections, `Origin` is the only signal the handshake carries, and deferring the check
means the connection is already open and driven by whoever opened it.

**`createWsEdge` serves the whole `## HTTP routes` table exactly as `createSseEdge` does, with
one substitution.** `GET /api/sessions/:id/events` is not reachable as a plain request under this
edge — a client that tries it is refused `422 bad_request` naming the field `upgrade` — because
that route's real handler runs on the `http.Server`'s `'upgrade'` event, which a bare
`RequestListener` is never given. `createWsEdge` attaches its upgrade handler to the returned
function as `.handleUpgrade`, Node's own `'upgrade'` listener signature, and `server.ts` wires
`server.on('upgrade', listener.handleUpgrade)` whenever `config.edge === 'ws'`. **This is an
extension of the returned value, not a widened contract**: the function is still exactly a
`RequestListener` to every caller that only calls it as one.

**The WebSocket stream is the same stream `edge/sse` writes**, one JSON-encoded `Envelope` per
text frame, in `seq` order, with **nothing else multiplexed onto the same socket** — save the one
thing the SSE edge also carries, a `message.delta`, which is written as a `Frame` and is therefore
distinguishable by the **absence of `seq`** rather than by a wrapper of its own (D168, I51). That
absence is the signal: `seq` is a client's only resume position on this edge, so a body without
one is a frame it must render and must not treat as a resume point. A delta interleaves with the
`seq`-ordered envelopes and does not interrupt their order. The first client frame is JSON `{ after?: Seq }`, read exactly as `Last-Event-ID` is on
the SSE edge: omitted or `0` replays from the start, otherwise from `after + 1`, including the
spill-served case and the gap case, where `error / replay_gap` is sent as a frame carrying no
resumable position exactly as SSE's gap frame carries no `id:`.

**How the client learns which edge is live.** `index.html` carries
`<meta name="skynet-edge" content="sse">` or `content="ws"`, set by whichever edge serves the
document — a `<meta>` tag and not a `<script>`, so it costs the strict CSP nothing. The client
reads it once at load and never probes.

### `server`

`src/server.ts` is the composition root, and it has **no exported declaration to point at** —
it is a process. Its surface is the process contract: what it accepts on the way in, what it
does on the way out, and what it leaves on disk either way. That is stated here in full, on the
same grounds a Markdown command file's is.

It loads config, builds `store`, `records`, `checkpoints` and `session-manager`, runs boot in
the order *`session-manager`* fixes above, wires exactly one edge (D10, D117) — plus
`server.on('upgrade', listener.handleUpgrade)` where `config.edge === 'ws'` — and only then
listens (I18). Every refusal on that path exits non-zero having named the fix on stderr, and
none of them is a warning.

**Shutdown runs five steps and, as with boot, the order is the point**
(`10-design.md` § *Shutdown ordering*):

```
0. guard    a second signal exits immediately, non-zero                       (D174)
1. quiesce  close the listener: no new connection, so no new session or turn
2. drain    bounded; whatever is still connected when the window closes
            is closed                                                         (D176)
3. kill     every live turn's child TREE, then one ProcessTombstone each      (D177)
4. release  stop renewing, then remove <storage>/server.lock if still ours,
            bounded, exit zero                                                (D175, D180, D195)
```

**What is *not* among them is the load-bearing part** (D174, I52). No session is marked ended,
no turn is closed on disk, no `session.notice / server_restart` is written, and no envelope is
emitted. Each of those is boot's — D20, D39 and D130 — and stays boot's, because a `SIGKILL`,
an OOM kill and a power cut produce no shutdown at all, so boot must handle the unfinalised
case whatever shutdown does. A shutdown that also finalised would be a second implementation of
boot's repair distinguished only by running more often, and it would be the *tested* one, since
Ctrl-C is what a developer exercises. **The bar is therefore not "leave things tidy" but "leave
nothing boot does not already expect"**, and writing nothing clears it.

**Step 2's bound is what makes the clean path reachable at all**, which is a correction to the
obvious implementation rather than a refinement of it. `server.close()` fires its callback when
the last connection is gone, and a subscribed client is by construction never idle — its
response is open for the life of the stream. With one open event stream the callback does not
fire (measured, not assumed; the deployment image is `node:22`, where it was not re-run), so a
release and an exit sitting behind it are unreachable **whenever any operator is watching**. The
drain window must be shorter than the supervisor's grace period, because completing before that
period's `SIGKILL` is the entire purpose of bounding it. **Neither this bound nor the release's
is a `Config` field**; they are module constants beside the existing `RELEASE_LOCK_TIMEOUT_MS`,
and promoting either to a deployment flag is a contract amendment.

**Force-closing a subscriber loses nothing.** D40 already serves a reconnect from the spill when
the ring cannot reach back far enough, for live and ended sessions alike, and a stream cut
without warning is precisely the case that path was built for. **Subscriptions are not closed
through `SessionManager`**: it has `boot` and deliberately no counterpart, and the HTTP server
reaches this outcome by itself.

**Step 3 kills because supervision is what has ended, not because a turn was judged stuck.** The
adapter spawns `detached` on POSIX — D38's process-group kill requires it — so a terminal's
Ctrl-C reaches this server and not the agent, and without this step the tree outlives the
console that was watching it: an agent CLI holding write access to the operator's work-tree with
nobody reading its stream. **This is not D21's timer under another name.** D21 refused to end a
turn on elapsed silence because a long compile and a hang are indistinguishable and only the
operator can separate them; this step makes no judgement about the turn at all. The cost is
stated rather than hidden — **`docker stop` and Ctrl-C end a turn in flight** — and what it
leaves behind is what interrupt leaves behind: files the agent already wrote stay written, and
the pre-turn checkpoint is what returns the workspace (D24).

**It does not route through `SessionManager.interrupt`, and that boundary is what keeps I52
intact.** Interrupt emits `turn.ended`, resolves every pending permission and starts the spill's
append chain — all at the moment the process is trying to exit, and all under a stop reason D24
reserves for the operator's own act. The turn is closed instead at the next boot, by D39, under
`server_restart`, which is both the truthful reason and the one D130's payroll marker already
pairs with. **Shutdown terminates what it started; boot repairs what it finds** — and a
`ProcessTombstone` records something shutdown *did*, which is why it is the one durable write
I52 permits.

**"Every live turn", not "the live turn".** Sessions are independent and each may hold one turn
(I4), so a shutdown may face several children at once. Killing one of them and not the rest
would leave exactly the orphan step 3 exists to prevent.

**The tombstone is best-effort and bounded like the release.** A lost one leaves `pids.ndjson`
recording a dead pid as live, and D23's reuse guard then tombstones it at the next boot rather
than killing whatever now holds that pid (I19) — the case that guard exists for.

**The lock is released last, and that is D161 read backwards** (D175, I53). D161 put the claim
ahead of boot's reap step because a second server that got as far as reaping cannot tell the
first server's live agents from its own dead ones. A release issued while this server still has
children recorded with no `exitedAt` opens the identical window from the other end, and a
restart is the one moment at which a successor is certain to be starting. **Failing to release
is safe by design rather than by luck**: a holder that has stopped renewing stops looking alive one
observation window later, so a lock nobody removed is reclaimed by the next boot with nobody
clearing anything (D180). What clean release buys is keeping that reclaim — and the window's wait —
off the ordinary restart, and a guard exercised on every boot has stopped being a guard.

**Renewal stops as step 4's first act, and not when shutdown begins** (D195, I56). The direction is
easy to get backwards, so it is stated rather than left to taste: this server still holds the
storage root all the way through steps 1 to 3 — it is draining, killing children, and writing the
one `ProcessTombstone` I52 permits — so it must keep renewing across them. A timer cancelled at
step 0 or 1 would let a booting successor observe an unchanged counter and reclaim the root while
this server is still writing to it, which is the exact overlap the lease exists to prevent, arrived
at through the tidy path rather than the crash. The timer is cancelled immediately before the
ownership-checked read below, and the gap between the two is the only moment in this server's life
when it holds the root and is not renewing.

**A displaced holder runs this same path, and that is why there is no second one** (D195). Where a
renewal returns `displaced` — the lock absent, or carrying another `instanceId` — this server has
lost the root and stops, and it stops by running steps 1 to 4 unchanged. Nothing special is needed
at step 4, because I56 already made release an ownership check: it reads a foreign `instanceId` and
removes nothing. What differs is the exit code, below — and the timer, which is **cancelled at once
rather than at step 4**: the renewal that returned `displaced` is by definition this server's last,
and a process that no longer holds the root has no business writing to the lock through steps 1 to
3. The paragraph above orders the two only for a shutdown that still holds it.

**Release is a check, not a delete** (D180, I56). Removing the lock unconditionally was safe only
while "the lock on disk" and "the lock this process claimed" could not come apart, and a lease is
precisely the mechanism that lets them: a server that stalled long enough to be declared dead, was
reclaimed, and then shut down tidily would delete a *successor's* lock. Step 4 therefore removes
the file only while it still carries this instance's `instanceId`, and a mismatch is a logged
no-op rather than an error — shutdown raises nothing, as below.

**Shutdown raises nothing.** Past the guard every step is best-effort: a failure is logged and
the next step runs, and **no variant is added to any error union** for it. **Shutdown has exactly
two non-zero exits** (D195): the guard — the operator saying they are done waiting, on which nothing
below it is retried — and a displacement, which is nobody asking for anything and is the one
abnormal end this path has. They are not symmetrical. A displacement runs all four steps; the guard
runs none past wherever the second signal found it, which is why its row below leaves both a tree
and the lock.

**What is left behind, by how the server was stopped:**

| Ended by | `server.lock` | Spill of a turn in flight | Children | What boot does |
|---|---|---|---|---|
| One signal, drain completes | Removed | Ends on an unpaired `turn.started` | Killed and tombstoned | Reclaim not invoked, reap finds nothing. D39 still closes the turn, D130 still marks the outage |
| One signal, drain times out | Removed | As above | As above | As above |
| A second signal | **Left** | As above | **Still running** — the guard exits before step 3 | Reclaimed one observation window after the last renewal, logged; the reap kills the tree; the rest as above |
| `SIGKILL`, OOM, power cut | **Left** | As above | Still running, or gone with the container | As above — except after a host crash, where the `startedAt` limb of D23's *reap* guard tombstones the `pids.ndjson` entry rather than killing anything |
| **Displaced** — a renewal found the lock absent or foreign (D195) | **Left, and it is the successor's**: release reads a foreign `instanceId` and removes nothing (I56) | As above | Killed and tombstoned | Nothing to reclaim — a successor already holds the root and has already reaped. This server's `pids.ndjson` children are tombstoned by its own step 3, so the successor's reap finds them closed |

**The spill column does not vary, and that is the measure of how little shutdown is
load-bearing**: all five end a turn in flight identically on disk, and boot repairs all five the
same way. **Two of the five still leave a tree for boot's reap**, and both are ways of stopping
that shutdown does not control — which is why D177 adds a step without taking anything away
from D23. The displacement row is not among them: it runs step 3 like an ordinary signal, and it
differs from one only in what it may do to the lock and in the code it exits with.

**A shutdown may leave `ckpt.git/index.lock`** behind, where the process dies with a
`git commit` in flight. That is an already-designed state rather than a new one:
`CheckpointError.locked` above has the next turn's checkpoint failing with a
`session.notice / warn` (`checkpoint_skipped`) and the turn proceeding with no restore point.
Nothing further is owed.

**How step 3 reaches those children is `SessionManager`'s one shutdown method** (D178,
`## Unresolved` 14; declared under *`session-manager`* above with what it must do). `server.ts`
kills nothing itself: it holds no adapter, and a kill it issued against a recorded `pid` — boot's
reap shape — would drive the same `exited` notification into a manager that is still watching,
with no surface available to mute it. The method never rejects, and **this caller bounds it**,
from the module constants beside the drain's and the release's rather than from `Config`, which
is what lets step 4 follow it unconditionally.

### `client`

No runtime interface. It consumes `Envelope` and the HTTP routes below. **Its rendering rules
are binding** and are in `10-design.md § Security controls`:

- A strict CSP with no `unsafe-inline` and no `unsafe-eval`, served on the document.
- **No `innerHTML` for anything this codebase did not write** (D74, I26) — agent output, tool
  results and stored operator text alike. The rule is not "agent-derived", because "is this
  string agent-derived?" is a question a renderer eventually gets wrong and "did we write this
  literal?" is one it cannot. Text nodes only; diffs, code, tool output and prose are built into
  elements the client constructs, never parsed as markup.
- **The four themes are CSS custom properties in a stylesheet served from `'self'`, toggled by
  an attribute on the root element** (D78). No style text is generated, injected or interpolated
  at runtime, which is what keeps the theme feature compatible with a `style-src 'self'` that has
  no `unsafe-inline`. The choice is held in browser storage and **never reaches this server**
  (D60).

## HTTP routes

The routing table is this document's, not the tree's: it is a surface a client is held to and
no single declaration expresses it.

All request and response bodies are JSON unless stated. **Every route under `/api/` requires
authentication, with exactly one exception — `POST /api/login`, which cannot, because it is
what mints the credential.** The static client assets the same listener serves — `/`,
`/app.js`, `/render.js`, `/app.css`, `/theme.js` — are outside `/api/` and outside this rule:
they are the console's own code, they carry no operator's data, and a page that refused to load
before authentication would have nothing left to authenticate with.

**Every `POST` and `DELETE` under `/api/` requires an origin match, checked before identity is
resolved** — `POST /api/login` included (I24). **Read routes are deliberately not covered**: a
cross-origin `GET` cannot be read back by the attacking page, and checking `GET /events` would
break the one client shape that is otherwise legitimate, a reverse proxy rewriting `Origin`.

### Identity

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/login` | `{ secret: string }` | `200 { ok: true }` + `Set-Cookie` | `403 bad_origin`, `401 unauthenticated`, `404 no_such_session`, `422 bad_request` |

**Served only under `auth.mode === 'shared-secret'`**; under either header mode the route does
not exist and answers `404`, because the credential it would mint is one the deployment has said
it does not use. The secret is compared in constant time. The cookie is
`<auth.cookieName>=<secret>; SameSite=Strict; HttpOnly; Path=/; Max-Age=<Config.sessionCookieMaxAgeSeconds>`
— **the attributes are defence in depth and the origin check is the control** (D29). `SameSite`
governs *our* cookie, and the proxy modes are authenticated by a cookie belonging to Authelia or
oauth2-proxy that we do not set and cannot attribute.

The `404` is `no_such_session` because `ApiErrorCode` carries no route-level not-found; see
*Error semantics*.

### Sessions

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/sessions` | `CreateSessionInput` | `201 { sessionId }` | `403 bad_origin`, `401 unauthenticated`, `409 outside_workspace_root`, `409 workspace_busy`, `404 no_such_requisition`, `409 requisition_not_approved`, `409 requisition_consumed`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/message` | `{ text: string, attachments?: AttachmentUpload[] }` | `202 { turnId }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `503 agent_unavailable` |
| `POST` | `/api/sessions/:id/permission` | `PermissionAnswer` | `200 { accepted: boolean }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/interrupt` | `{ turnId: TurnId }` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request` |
| `POST` | `/api/sessions/:id/end` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `POST` | `/api/sessions/:id/checkpoint/restore` | `{ sha: GitSha }` | `200 { ok: true, safety, unreached }` | `403 bad_origin`, `404 no_such_session`, `404 no_such_checkpoint`, `409 session_ended`, `409 turn_in_flight`, `422 bad_request`, `500 checkpoint_failed` |
| `DELETE` | `/api/sessions/:id` | — | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 turn_in_flight` |
| `GET` | `/api/sessions` | — | `200 { sessions: SessionSummary[] }`, caller's own only | `401 unauthenticated` |
| `GET` | `/api/sessions/:id` | — | `200 { session: SessionSummary }` | `401 unauthenticated`, `404 no_such_session` |
| `GET` | `/api/sessions/:id/events` | `Last-Event-ID` header | `200 text/event-stream` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/checkpoints` | — | `200 { checkpoints: Checkpoint[] }` | `404 no_such_session` |
| `GET` | `/api/sessions/:id/tool-output/:turnId/:callId` | — | `200 text/plain; charset=utf-8` | `404 no_such_session`, `404 no_such_output` |
| `GET` | `/api/sessions/:id/attachments/:turnId/:attachmentId` | — | `200`, media type per the allow-list below | `404 no_such_session`, `404 no_such_attachment` |

**Every route that reads or mutates a session's data is under `/api/sessions/:id` and applies
the ownership check** (I23). That is not a style preference: a route keyed on a vendor-minted
identifier instead — fetching untruncated tool output by `callId` alone — is reachable by any
authenticated operator who can guess or observe one, and no amount of care elsewhere fixes it.

`GET /api/sessions/:id` is the single-resource read of the same `SessionSummary` the list route
returns, and it exists so a client holding one `sessionId` can re-read that session's
authoritative `state` without fetching every session it owns.

The permission route resolves identity and the ownership check like every other session route;
**the operator it resolves is the one written to `AuditRecord.operator`.**

`POST /interrupt` returns `{ ok: true }` when the session has no live turn, or when `turnId` does
not name the live turn.

**The restore response carries the whole of `RestoreResult`** (D182): `safety` is the `Checkpoint`
taken on the way in, and `unreached` is `IgnoredDelta[]` or `null`. **A client must render `null`
as unknown and an empty array as "nothing differs", and must not collapse the two** — that
distinction is the entire reason item 6 of the brief is qualified rather than unqualified, and a
renderer that shows both as a clean restore puts back exactly the silence this route exists to
break. `ok: true` continues to mean the restore itself succeeded; a dirty verification pass is
`500 checkpoint_failed` and carries no `RestoreResult`.

**The tool-output route serves `Content-Type: text/plain; charset=utf-8` with
`X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`**, so a tool result that
happens to be HTML cannot render as a document in the console's own origin.

**The attachment route never echoes an upload's declared media type unguarded** (D160). It
serves `nosniff` on every response, and sets `Content-Type` to the stored `mediaType` only when
that value is in a server-side allow-list of image types — `image/png`, `image/jpeg`,
`image/gif`, `image/webp` — and to `application/octet-stream` otherwise. An operator-uploaded
`text/html` served under its own type on the console's origin is stored XSS holding the
console's credentials, which is D74's population arriving as bytes rather than as text.
`Content-Disposition` follows the same allow-list check — `inline` for an allow-listed image,
`attachment` otherwise — because WebKit honours `Content-Disposition: attachment` even on an
`<img>` subresource fetch and would show a broken-image icon instead of painting it. **`nosniff`
plus the `Content-Type` allow-list, not `Content-Disposition`, is what stops a non-image type
from ever being rendered as markup.**

**`POST /message` refuses, with `422 bad_request` naming the field and nothing written**: an
attachment whose decoded size exceeds `Caps.attachmentBytes`; a message carrying more than
`Caps.attachmentCount` of them; and any attachment at all on a session whose adapter declares
`acceptsAttachments: false`. None is truncated, shortened or silently dropped (D84).

### Audit — tier one (D73)

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `GET` | `/api/audit` | `AuditQuery` as query parameters | `200 AuditPage` | `401 unauthenticated`, `422 bad_request`, `503 agent_unavailable` |

**Readable by every authenticated operator, not scoped to the caller's own sessions** (D70): the
question this log answers crosses sessions, and scoped to one operator it answers only "what did
I approve", which nobody needed a log for. The window is bounded by `Caps.auditPageMax` and
resumed by `nextCursor`; **there is no unbounded read**, because this is the one file that grows
for the deployment's lifetime — never truncated, never shortened, and explicitly outliving every
session it names. The incident view of brief item 11 is this route with `incidentsOnly: true`.

What the bound counts, and why a short page is not the end of the log, is in *Types § Audit
record*.

### Requisitions — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/requisitions` | `RaiseRequisitionInput` | `201 { requisition }` | `403 bad_origin`, `401 unauthenticated`, `422 bad_request`, `500 record_write_failed` |
| `GET` | `/api/requisitions` | — | `200 { requisitions: Requisition[] }`, all of them | `401 unauthenticated` |
| `POST` | `/api/requisitions/:id/decision` | `{ decision: RequisitionDecision }` | `200 { requisition }` | `403 bad_origin`, `404 no_such_requisition`, `409 already_decided`, `422 bad_request`, `500 record_write_failed` |

**The decision route belongs to `records` alone and never touches the session manager.** A
requisition at this point has no session, no workspace claim and no turn — nothing the manager
owns.

**`already_decided` is a refusal, not a last-write-wins.** Two operators reaching a requisition
in the same tick — one approving, one rejecting — is not exotic on a shared list, and a
latest-line-wins file would resolve it silently in favour of whichever `await` completed second.

`workspace` is stored as the client sent it and is not resolved here. A requisition naming a
path outside every root is approvable, and fails `409 outside_workspace_root` at the moment a
session tries to spend it — **with the claim not taken, because the jail runs first** (D68).

Self-approval is permitted and recorded: `decidedBy` may equal `raisedBy` (D69).

### Reviews — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `POST` | `/api/reviews` | `CreateReviewInput` | `201 { review }` | `403 bad_origin`, `404 no_such_session`, `422 bad_request`, `500 record_write_failed` |
| `POST` | `/api/reviews/:id` | `ReviewPatch` | `200 { review }` | `403 bad_origin`, `404 no_such_review`, `409 review_final`, `422 bad_request`, `500 record_write_failed` |
| `POST` | `/api/reviews/:id/finalise` | `{}` | `200 { review }` | `403 bad_origin`, `404 no_such_review`, `409 review_final`, `500 record_write_failed` |
| `GET` | `/api/reviews` | `?subject=<SessionId>` | `200 { reviews: Review[] }`, finals only | `401 unauthenticated`, `422 bad_request` |
| `GET` | `/api/reviews/:id` | — | `200 { review }` | `404 no_such_review` |

`GET /api/reviews` returns finals and **no drafts at all**, for every caller including a draft's
own author. An author reaches their draft by `GET /api/reviews/:id` with the `reviewId` that
`POST /api/reviews` returned.

**`404 no_such_review` covers three cases and distinguishes none of them**: no such id, a draft
that is not the caller's, and a review the caller may not touch. `404` rather than `403`,
matching D50.

`ReviewPatch`'s absent fields are left as they stand on the latest line for that review.

### Session records — tier two

| Method | Path | Request | Success | Refusals |
|---|---|---|---|---|
| `GET` | `/api/sessions/:id/payroll` | — | `200 PayrollView` | `404 no_such_session`, `500 payroll_unavailable` |
| `GET` | `/api/sessions/:id/checklist` | — | `200 { items: ChecklistItemState[] }` | `404 no_such_session` |
| `POST` | `/api/sessions/:id/checklist/:itemId` | `{}` | `200 { ok: true }` | `403 bad_origin`, `404 no_such_session`, `409 session_ended`, `404 no_such_item` |

Both checklist routes are under `/api/sessions/:id` and carry the ownership check: only the
session's owner may read or tick its checklist. **Every session has a checklist**, and a tick on
an ended session is `409 session_ended` (D122).

**A tick is idempotent and is not audited**: `audit.ndjson` records tool approvals, and diluting
it with provisioning clicks makes the artifact the threat model leans on harder to read for no
gain.

### Streaming

`GET /api/sessions/:id/events` is Server-Sent Events. One envelope per SSE message, with `id:`
set to `seq`:

```
id: 42
event: tool.call
data: {"seq":42,"sessionId":"...","ts":"...","kind":"tool.call","data":{...}}
```

On reconnect the browser's `EventSource` sends `Last-Event-ID`. **The server replays from
`seq + 1` — from the ring buffer where it can, otherwise from the spill, for live and ended
sessions alike** (D40). Only where the spill cannot serve the range does the server send a single
`error` with `kind: 'replay_gap'`, after which the client refetches. **A resume point past the
session's own `lastSeq` is one such range**: no store holds it and waiting for `seq` to climb to
it would stream nothing forever, so it is reported as a gap rather than served as a complete
replay of nothing.

**The refetch happens once, and what follows a second gap is a reported state rather than a
third attempt** (D155). A refetch is a fresh stream carrying no `Last-Event-ID`, so it asks for
the transcript from `seq` 1. If *that* gaps too, the spill cannot be read at all, and reopening
again is a reconnect loop rather than a recovery — so the client stops and says the history is
unavailable and it is showing live events only.

**A `message.delta` is written with no `id:` line, because it has no `seq` to put there** (D168,
I51). It is delivered to whoever is attached at the moment it is produced and to nobody else, so a
client's resume point is unchanged by receiving one — which is the property that matters: an
`EventSource` reconnecting after a delta asks for the same `Last-Event-ID` it would have asked for
without it, and the `message` that follows the deltas is the envelope that carries the text
forward. This is the same framing device `replay_gap` already uses for a different reason, and the
two must not be conflated: a gap frame restates a watermark, a delta frame has none.

**A `replay_gap` envelope restates the watermark its subscriber is complete through; it does not
consume a `seq`** (D156). It is the one envelope `emit` never produces: no `seq` is assigned,
nothing is appended to the spill, nothing reaches the ring, and it goes to a single subscriber
rather than to fan-out. Its `seq` field therefore repeats a value that subscriber already holds,
which is the one place a reader of the delivered stream sees `seq` not advance — I1 governs what
`emit` assigns and is not weakened by it. The alternative is what makes this worth declaring:
**stamping a gap with a fresh `seq` makes the gap frame itself the next resume point, past the
very history it just failed to serve**, converting one reported gap into permanent silent loss.
The SSE edge expresses this by writing no `id:` line for such a frame; on the WebSocket edge the
body's `seq` is the only resume signal a client has, so the rule is the contract's rather than a
framing detail.

**A session whose durable store has died or been deleted delivers its last few envelopes live and
only live, and they do consume a `seq`** (D170). There are two such paths and both end a session:
a spill append that failed (D41) — `permission.resolved / cancelled_process_exit` for each
outstanding request, `turn.ended / storage_failure`, `session.ended`, `session.notice / error` —
and a partial delete (D25), which delivers `error / session_delete_incomplete` after the session
directory is already gone. In both, the file these would be appended to no longer exists, so there
is no store for them to enter and no replay for them to appear in. **The consequence a client is
entitled to know is that a delivered `seq` is not proof of a replayable envelope**, on these two
paths and nowhere else. They are the opposite of a gap frame rather than another instance of it: a
gap restates a watermark and takes no number, these take a number and advance `lastSeq` — which is
deliberate, and is what stops a client that saw them live being told, on its next reconnect, that
its resume point is past the end of a history it already holds. Neither I1 nor I2 is weakened: I1
governs what `emit` assigns and `emit` produces none of these, and the ring is dropped before the
first of them is delivered, so it never holds an envelope the spill will not.

A comment line (`: keepalive`) every `Caps.keepaliveMs` keeps intermediaries from closing an idle
stream, and **is what lets a client tell a silent agent from a dead connection** — which is what
makes D21's no-server-side-timer rule cost nothing on the wire.

## Error semantics

`ApiError`, `ApiErrorCode`, and every per-module error union — `ConfigError`, `StartupError`,
`IdentityError`, `JailError`, `StoreError`, `CheckpointError`, `AdapterError`, `RecordsError`,
`SessionError` — are declared in `src/contract/index.ts`.

**This section never becomes a pointer.** A variant's name is in the tree; when it fires, whether
it is retryable, and what the caller is expected to do are not, and they are the whole of what
makes an error type a contract rather than a spelling.

`StartupError.storage_locked` carries the holder as a `ServerLock` (declared in
`src/contract/index.ts`, and see *Types § Server lock* above). The holder is named because a
refusal that does not say who is holding it leaves an operator with nothing to act on — which
is most of the value when an operator is looking at one, and is why an OS advisory lock was
rejected (D161, and again on the network-share ground in D180). **The named fields are evidence
for the operator and for nothing else**: this error is the one place `pid`, `hostname`, `startedAt`
and `image` are read at all, and reading them where a decision is made violates I57.

**`StartupError` gains one variant, and it exists because the other one cannot carry the case**
(D196). A lock that will not parse names nobody, and `storage_locked` is declared with a
`holder: ServerLock`:

```ts
| { readonly code: 'storage_lock_corrupt'; readonly path: string; readonly detail: string }
```

Widening `storage_locked`'s `holder` to nullable was rejected: it would make every consumer of the
one error whose whole value is *naming the holder* handle the case where it names nobody, to spare
one variant. The two are also acted on differently — a held root is someone else's server and the
operator goes and looks at it; a corrupt lock is a damaged file on this host and the operator
removes it.

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `unauthenticated` | No usable identity |
| 403 | `bad_origin` | `Origin` / `Sec-Fetch-Site` did not match the allow-list on a mutating route |
| 404 | `no_such_session` | Unknown, or not the caller's |
| 404 | `no_such_output` | The tool-output blob is missing or unreadable |
| 404 | `no_such_attachment` | The attachment blob is missing or unreadable |
| 404 | `no_such_checkpoint` | No such `sha` in this session's shadow git |
| 409 | `turn_in_flight` | A turn is running |
| 409 | `session_ended` | The session is ended: it accepts no new turn, no checklist tick, and no restore |
| 409 | `workspace_busy` | The resolved path equals, contains, or is contained by a live session's `cwd` |
| 409 | `outside_workspace_root` | `cwd` failed the jail check |
| 422 | `bad_request` | Malformed body, or a text field over its cap |
| 500 | `checkpoint_failed` | A checkpoint operation failed; see the accompanying `error` event |
| 503 | `agent_unavailable` | CLI missing or failed to spawn |
| 404 | `no_such_requisition` *(tier two)* | Unknown `requisitionId` |
| 409 | `requisition_not_approved` *(tier two)* | Its state is not `approved` |
| 409 | `requisition_consumed` *(tier two)* | Already spent on a session |
| 409 | `already_decided` *(tier two)* | A decision is terminal; the refusal names who made it and what it was |
| 404 | `no_such_review` *(tier two)* | Unknown, or a draft that is not the caller's |
| 409 | `review_final` *(tier two)* | A final review accepts no further append — and neither does one whose own append is still in flight (D120) |
| 404 | `no_such_item` *(tier two)* | No such `itemId` in the configured checklist template |
| 500 | `record_write_failed` *(tier two)* | The record-log append failed; nothing changed anywhere |
| 500 | `payroll_unavailable` *(tier two)* | The fold could not read the spill; the session itself is unaffected |

**An unknown route has no code of its own, and the two substitutes it gets are split by
prefix.** This union carries no route-level not-found, so:

- A path **outside `/api/`** that is not one of the five static client assets answers
  `404 no_such_session`. So does `POST /api/login` under a header auth mode, where the route
  genuinely does not exist for that deployment.
- A path **under `/api/`** that this build does not serve — including an unrecognised sub-route
  under an existing session id — answers `422 bad_request`, naming the offending path or
  sub-route in `detail.field`.

The consequence of the first is stated so a client does not read more into it than it holds: **a
`404 no_such_session` distinguishes "no such session", "not your session" and "no such route" in
none of the three cases.** The consequence of the second is that a `422` from a session
sub-route means *this build serves no such route*, and is deliberately not a `404` against the
session — a client must not read it as "this session does not exist". Adding a code to separate
route-level not-found from both is additive and is not done here (D116).

**`SessionError.storage` reaching an edge is reported as `503 agent_unavailable`.** Every storage
failure the table below routes by call site — a spill append ends the session, an audit append
denies the permission, a blob read is a `404`, a record-log append is `500 record_write_failed` —
and what is left is a storage failure during `create`, where no more specific declared refusal
exists. `503` is right, since it is transient and the caller should retry; the code name is not,
and it is retained rather than multiplied because the alternative is a `storage_unavailable`
variant whose only caller is this one path.

**`404` rather than `403` for another operator's session is deliberate**: session existence is
not something a non-owner should be able to probe. There is no `403 forbidden` for session
access, and no per-operator vendor authorisation — there is no operator record to hold one.
**What that `404` buys narrowed when tier two arrived**: reviews and audit records name
`SessionId`s, so existence is discoverable through the record logs, and the `404` is now access
control rather than concealment (D50, D70).

### Per-module error types

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `ConfigError.insecure_bind` | A routable bind that no `trustProxy` allow-list covers, **under `proxy-header` or `open-webui` only** (D154) — those are the modes that trust a header the client could otherwise set. Under `shared-secret` the same bind is legitimate and this is never raised: a credential the caller must present is not a claim about who the peer is. **Not** a missing auth mode either: D93 makes one mandatory in every configuration, so that case is `missing_field` at parse time and never reaches here | No | Refuse to start, naming the fix |
| `ConfigError.missing_field` / `invalid_field` | Validation of the environment. `invalid_field` additionally covers **`STORAGE_ROOT` overlapping any `WORKSPACE_ROOTS` entry** under `pathsOverlap`, once both are jail-normalised (D185, I60) — `detail` names the root it collides with. No variant is added for it: the field is genuinely invalid relative to another field | No | Refuse to start. On the overlap, naming both paths and which to move; nothing is written and the storage tree is untouched |
| `StartupError.storage_unwritable` | The storage root cannot be written at boot | No | Refuse to start |
| `StartupError.storage_lock_corrupt` | `<storage>/server.lock` is present and will not parse (D196). **Not a renewal caught in flight** — every write publishes the file whole (I61), so a reader sees complete contents or none — and **not a lock predating the lease**, which parses and reaches the reclaim path on its absent counter (I61) | No | Refuse to start with a non-zero exit, naming the path. Nothing server-wide has been written. The operator's action is to remove the file, having satisfied themselves no server is running |
| `StartupError.storage_locked` | Another server process holds this storage root: the lock's `renewals` moved across one observation window measured on this process's own monotonic clock (D180). **Never raised on a host comparison**, which no longer happens | No | Refuse to start with a non-zero exit, naming the holding `pid`, `hostname` and `startedAt`. **Nothing server-wide has been written**, because the claim precedes the reap step |
| `IdentityError.no_identity` | No header, no cookie, or an empty one | No | `401 unauthenticated` |
| `IdentityError.untrusted_proxy` | The identity header arrived from an address not in `trustProxy` | No | `401 unauthenticated`; log the address |
| `IdentityError.bad_secret` | The shared-secret cookie does not match | No | `401 unauthenticated` |
| `JailError.outside_workspace_root` | The resolved real path is inside no root | No | `409 outside_workspace_root`, naming the roots |
| `JailError.unresolvable` | The candidate cannot be resolved to a real path | No | `409 outside_workspace_root`. The jail admits only paths *proven* inside a root |
| `StoreError.io` | Any write or read failure | Sometimes | On a spill append: end the session (`storage_failure`). On an audit append: deny the permission. On a blob read: `404`. On a record-log append: `500 record_write_failed`, registry unchanged |
| `StoreError.not_found` | A blob or session directory is absent | No | `404 no_such_output` / `404 no_such_attachment` |
| `StoreError.corrupt` | `meta.json` fails to parse, or a trailing line does | No | Skip that session at boot, or drop that line and serve the rest. **Never abort boot** |
| `StoreError.unsupported_schema_version` | `meta.json` carries an unknown `schemaVersion` | No | Skip that session at boot; leave its files untouched. Never a migration attempt, never a partial read |
| `CheckpointError.git_unavailable` / `init_failed` | `ckpt.git` cannot be created | No | `session.notice / warn` (`checkpoints_unavailable`); the session proceeds without checkpoints |
| `CheckpointError.locked` | `ckpt.git/index.lock` exists | Yes, after the lock clears | Pre-turn: `session.notice / warn` (`checkpoint_skipped`); the turn proceeds with no restore point |
| `CheckpointError.commit_failed` | A commit fails for any other reason | Sometimes | As above |
| *(no variant)* | **The ignored-path manifest could not be captured at commit, written, read, or parsed at restore** (D182) | — | **Not an error at all, at either end.** The commit succeeds with no manifest; the restore succeeds with `unreached: null`. A manifest is a report and never a gate, so no path may fail on its absence — and `null` is the one thing that must never be rendered as "nothing differs" (I58) |
| `CheckpointError.no_such_checkpoint` | Restore names an unknown `sha` | No | `404 no_such_checkpoint`; the workspace is untouched |
| `CheckpointError.restore_incomplete` | `read-tree` or `clean` fails, **or the verification pass comes back dirty** — `diff --quiet <sha>` for tracked content, `ls-files --others --exclude-standard` for what was left behind. Never an exit code alone: `read-tree` exits 0 with a warning on the embedded-repository case (D112) | No | `error / checkpoint_restore_failed`, non-fatal, plus `500 checkpoint_failed`. **The workspace is partially restored**; the safety checkpoint is the way back |
| `AdapterError.agent_unavailable` | `spawn` returns `ENOENT`, or no supported transport is available | Yes, once installed | `503 agent_unavailable`; `error / agent_unavailable`, fatal to the turn; clear the turn. The session stays live |
| `AdapterError.unsupported_vendor` | An unknown vendor string | No | `422 bad_request` |
| `AdapterError.unsupported_sandbox` | A sandbox the vendor does not offer | No | `422 bad_request` |
| `AdapterError.no_child` | `send` or `respond` with no live child | No | Treat as a turn that has already ended; emit nothing new |
| `AdapterError.schema_mismatch` | The stream does not match the expected shape for the transport actually selected | No | `error / adapter_schema_mismatch`, **fatal**. Fail loudly; never degrade quietly |
| `AdapterError.write_failed` | A write to the child's stdin fails | No | Resolve pending permissions `cancelled_process_exit`; end the turn `process_exit` |
| `RecordsError.no_such_requisition` | Unknown id, on a decision or a claim | No | `404 no_such_requisition`; during `create`, no claim was taken |
| `RecordsError.already_decided` | A second decision on one requisition | No | `409 already_decided`, naming the decider and the state |
| `RecordsError.requisition_not_approved` | A claim against `open` or `rejected` | Yes, once approved | `409 requisition_not_approved`; nothing is claimed |
| `RecordsError.requisition_consumed` | A claim against one already spent | No | `409 requisition_consumed`; raise another (D80, D81) |
| `RecordsError.no_such_review` | Unknown id, or a draft that is not the caller's | No | `404 no_such_review`. **Never distinguishes the two** |
| `RecordsError.review_final` | An append or a second finalise on a final review, **or on one whose own append is still in flight** — D120's exclusivity lock, refusing the second writer before either write lands, exactly as `already_decided` does for a requisition | No | `409 review_final`. Terminal in the first case and retryable in the second; a caller that cannot tell them apart retries and either succeeds or is refused again |
| `RecordsError.bad_request` | A text field over its cap, a malformed field, or a `subject` disagreeing with the supplied snapshot | No | `422 bad_request`, naming the field |
| `RecordsError.storage` | The record-log append failed | Sometimes | `500 record_write_failed`. **The registry is not mutated**; the edit is still in the operator's form |
| `SessionError.no_such_session` | Unknown id, or the caller is not the owner | No | `404 no_such_session` |
| `SessionError.session_ended` | A message, a checklist tick, or a **restore** against a session in state `ended`. Restore is refused because an ended session keeps its `cwd` while the busy check excludes only *live* sessions (D30), so a new session may already hold that workspace — restoring through the ended one would run git against a work-tree it no longer owns. `POST /:id/end` is the exception and is deliberately inert on a repeat call | No | `409 session_ended` |
| `SessionError.turn_in_flight` | A second message, or a restore, end, or delete during a turn | Yes, once the turn ends | `409 turn_in_flight` |
| `SessionError.workspace_busy` | The resolved path overlaps a live session's `cwd` | Yes, once that session ends | `409 workspace_busy`, naming the holding path and operator |
| `SessionError.no_such_item` | A tick for an `itemId` absent from the configured template | No | `404 no_such_item` |
| `SessionError.bad_request` | A malformed or missing field. On `answerPermission` this is four distinct cases, each naming the offending field: `scope: 'always'` with no `rule` (`rule`); a `rule` `parseStandingRule` refuses (`rule`); `scope: 'always'` with `decision: 'deny'` (`decision`); `scope: 'always'` against a request whose `matchTarget` is `null` (`scope`) | No | `422 bad_request`, naming the field |
| `SessionError.payroll_unavailable` | The fold could not read the spill | Sometimes | `500 payroll_unavailable`. The session is unaffected — it is a read of a file the session is still writing |
| `SessionError.jail` / `adapter` / `checkpoint` / `storage` / `records` | A dependency's error, wrapped | Per the cause | Map the cause, per the rows above |

Three error paths are decisions rather than mappings, and are stated so they are not
re-derived:

- **An audit append that fails denies the permission.** The manager sends
  `control_response { behavior: 'deny' }` with the storage failure as the reason, emits
  `permission.resolved { decision: 'deny', reason: 'audit_unavailable' }` and a
  `session.notice / error`. The turn continues, the agent can respond to the denial, and nothing
  unaudited executes. **Denial is the only decision safe to make without being able to record
  it** — the alternatives are running a tool with no record, or wedging a turn whose child is
  blocked forever.
- **A spill append that fails ends the session.** The live turn is interrupted with
  `stopReason: 'storage_failure'` and the session moves to `ended`. Continuing to stream would
  leave the ring holding events the spill never will — the invariant I2 protects, broken by our
  own error handling and with none of `replay_gap`'s reporting.
- **A record-log append that fails changes nothing.** No registry mutation, no partial state, and
  the operator retypes nothing they cannot see. This is the reverse of the audit path's ordering,
  deliberately: a review or a decision is not irreversible and nothing downstream acts on it,
  where a registry claiming a `state` the disk does not have would silently revert at the next
  boot (D120).

### The divergence classes

`tools/Test-DesignState.ps1` declares the same ids and `ClassListDisagreement` compares the two:
**the script is the detection and this section is the policy** (D192, D197). A class not listed
here does not exist, and adding one is a contract amendment. **Whether that comparison currently
reaches this repository is a separate question, and it is answered — no — at the end of this
section rather than left to be assumed.**

**The list is this repository's, and where it is shorter than the kit's that is deliberate.**
These classes arrive with `SubZeroDev.AgentKit`, whose own contract carries a longer table — a
record-pair and site-placement round the script in this tree does not implement. Transcribing
that table would state a policy no installed code detects, which is the exact divergence
`ClassListDisagreement` exists to catch, written in by hand. The table below is true of the
script this repository has; a `/kit-sync` bringing a newer script brings the rows with it, in the
same commit.

**Blocking.** Every one is evaluable from the checkout alone — no network, no tracker, no running
service. That rule is what decides membership; it is not a coincidence of the list.

| Class | Raised when | Caller sees |
|---|---|---|
| `UnresolvedId` | A record names an id with no record | The referring record and the missing id |
| `AnchorMissing` | An **active** record carries a tree-pointer field naming a path not in the tree — a unit's `Anchor`, a contract's `Declaration`, or any entry of an `Evidence` list | The record, the field, and the path. **Which of the two sides is wrong is the user's call** |
| `OwnerMismatch` | A contract's `Owner` is not the unique active unit whose `Exposes` names that contract — nobody exposes it, or two units do | The contract, its `Owner`, and every unit exposing it |
| `UnrecordedArtifact` | A tree artifact of a unit kind has no record | The unrecorded artifact |
| `ProjectionStale` | A region differs from its regeneration, after line-ending normalisation | A diff of the region |
| `RegionMalformed` | A marked region of either kind is unbalanced or nested | The document and the marker |
| `IdCollision` | An id is duplicated, renumbered, disagrees with its file path, or appears in both the projected and the declared marker form | Every file claiming it |
| `DecisionAnchorAmbiguous` | A decision anchor resolves to zero or two log headings | The anchor and the count |
| `LogEntryUnrecorded` | A log heading has no decision record | The entry's heading |
| `EnforcementUnevidenced` | A conditionally-required field is absent on a record whose own `Status` or `Enforcement` requires it — an invariant with `Enforcement: code` and no `Evidence`, a decision with `Status: superseded` and no `SupersededBy`, or a question with `Status: answered` and no `AnsweredBy` | The record, the absent field, and the value that required it |
| `ClosureOverBudget` | A closure exceeds 16,384 bytes | The unit, its size, and its largest contributor |
| `ClassListDisagreement` | The checker's declared class ids differ from this section's list | Both sets, and the difference in each direction |
| `GlobDisagreement` | For a globbed unit kind, the file set § *Artifacts of a unit kind*'s patterns resolve to differs from the set the checker's enumeration returns | The kind, the direction, and the paths |

**`GlobDisagreement` compares file sets, not tokens, and only in that direction.** Comparing the
patterns as text would be a third id-level check in a section that already knows id-level checks
miss definition drift. Resolving both sides against the checkout instead means the table is
checked for what it *means*, and it is what qualifies the class as blocking on the rule's own
terms: expansion needs the checkout and nothing else. The `invariant` kind is outside the
comparison because it has no pattern in either cell, which is a fact about the table rather than
an exemption the checker carries.

**What a set comparison cannot see, stated rather than left to be found: an exclusion that
excludes nothing in this checkout.** `*-local.md` is the standing example — this repository ships
no command companion — so removing it from the table would change no resolved set here and the
class would stay silent. That is the comparison working as specified, not a hole in it, and the
exposure is bounded by the same fact that causes it: a divergence invisible here is invisible
because it has no artifact here to be wrong about.

**`AnchorMissing` is named for a unit's `Anchor` and checks every tree pointer a record carries.**
`Contract.Declaration` and the `Evidence` list on a unit or an invariant record restate a tree
path exactly as `Anchor` does, so leaving them unresolved would be an unchecked restatement. One
class covers all three because the check, the remedy, and the reason each is evaluable from the
checkout alone are the same in every case. **The name reading narrower than what it checks is the
price, and it is paid deliberately** — renaming it costs this list, the checker's declared ids,
and the tests that cite it by name. Three exemptions, each of which would otherwise block
forever:

- **A retired record is exempt entirely.** Its artifact is gone by definition, which is why it
  was retired.
- **An invariant record's `Anchor` is the invariant number, not a path.** Its resolution check is
  well-formedness and uniqueness, and it is `IdCollision`'s, never `Test-Path`'s.
- **A contract's `Declaration` of the literal `prose` resolves to nothing on purpose.** A
  Markdown command surface has no declaration to point at, and that is the field's documented
  second value rather than an absent path.

**A widened class definition is invisible to `ClassListDisagreement`.** That class compares class
*ids*, and an id does not change when what it detects does, so a definition widened ahead of its
detection stays green until the code lands. `GlobDisagreement` fixes the shape of the remedy
rather than being an exception to it — what closed the glob table's own version of this was
resolving both sides against the checkout instead of comparing their names. A definition has no
checkout to resolve against, so that remedy does not carry, and nothing on this list closes it.

**Reported, never blocking.** Each fails in exactly the environment where the failure means
nothing, which is why none of them is on the list above.

| Class | Raised when | Why it never blocks |
|---|---|---|
| `MirrorStale` | A `WorkRef`'s `MirroredAt` is not the current commit | The mirror is stale by construction; that is its documented state, not a divergence |
| `WorkStateDivergence` | A `WorkRef` disagrees with the tracker | Needs `gh`. A build that fails on an unauthenticated CLI reports an absent comparison as a divergence |
| `PinAncestry` | A cited commit is not an ancestor of the default branch | A shallow CI checkout has no history to answer with, and "could not check" must not read as "checked and failed" |
| `SemanticDisagreement` | A model judges a record's claim untrue | Permanently reported. The brief's *no formal specification of behaviour* non-goal puts it out of reach, and a build that fails on a model's opinion is a build nobody trusts |

**Could not evaluate.** Exit 2, and **never** a pass.

| `DesignStateFailure` | Raised when | Caller does |
|---|---|---|
| `StateSetAbsent` | `design/state/` missing, or holding no records other than `WorkRef` mirrors | Report that nothing was checked |
| `RecordUnparseable` | A line matches no production | Report the file, the line number, and the line **verbatim**. Never drop it |
| `TrackerUnavailable` | `gh` missing or unauthenticated | Report the tracker classes as not compared; the rest of the run completes |
| `ShallowCheckout` | No history for `merge-base` | Report that ancestry was not checked, and why. Never a pass |
| `ProjectorFailed` | `Update-DesignProjection.ps1 -DryRun` non-zero or absent | Report `ProjectionStale` as uncomputed, not as clean |
| `ContractListUnreadable` | A list this section is canonical for cannot be read or parsed — the divergence classes above, § *Invariants*, or § *Artifacts of a unit kind* | Report the class it feeds as uncomputed: `ClassListDisagreement` for the first, `UnrecordedArtifact`'s invariant half for the second, `GlobDisagreement` for the third. **Read-and-disagrees is a finding; cannot-read is not** |

**`StateSetAbsent` is this repository's standing state, and it is not a defect** (D192). The
tooling is adopted; the record set is not. `design/state/` holds `WorkRef` mirrors alone, which
`/track` writes into every target regardless of adoption and which therefore never count toward
the set being present. A run consequently reaches only the two reads that precede it — this
section's class list, and § *Invariants* — and returns.

**And that return currently discards the class-list comparison, which is measured rather than
inferred** (D197). `Test-ClassListAgreement` runs *before* the graph is read, deliberately,
because it needs no records — and `StateSetAbsent` then returns an empty finding list, dropping
the result it already computed. Called directly against a table carrying an undeclared class, the
comparison reports it: `ClassListDisagreement`, `contract-only: [Blocking:<id>]`, blocking. Run
through `Invoke-DesignStateCheck`, the same table reports zero findings. **So this section is
canonical and its agreement with the script is not, today, enforced here** — the policy binds a
reader, and nothing checks the reader. It is written down because a section that silently claims
a live check is worse than one that states its own reach: the discrepancy is a defect in
`tools/Test-DesignState.ps1`, which is kit-owned, and resolving it is not this document's.

**§ *Artifacts of a unit kind* does not exist here, and its absence is reachable rather than
inert.** `GlobDisagreement` runs after the `StateSetAbsent` return, so nothing reads the glob
table today; the first commit that populates the record set makes it read, and it reports
`ContractListUnreadable` until that section is written. Stating it here is what keeps it from
being rediscovered as a regression.

**§ *Invariants* is read by id, and the ids must be legible to a parser.** Its rows carry the
invariant number in the first column in bold, `| **I1** |`, because that is the form
`Test-DesignState.ps1` matches. The reason this is written down rather than left as formatting:
a row in any other form is not reported — it is silently absent from the set, and an empty set
compares clean against every artifact. **A false clean is worse than an unreadable table**, which
is why `ContractListUnreadable` exists beside it, and it is the one failure mode this section's
own canonicity cannot protect against.

### The freeze

While `design/FROZEN.md` exists: every blocking class is **downgraded to reported**, the count
downgraded is stated, and the marker's `Frozen because` and `Lifts when` are reproduced
**verbatim**. Exit 2 still stands.

A freeze permits known staleness. It does not permit a checker that could not run, and treating
those the same would make writing one file a way to switch the gate off — including for a broken
checker, which has nothing to do with the staleness a freeze is meant to permit.

## Invariants

Written so each could become an assertion. The named module is responsible for maintaining it;
where two are named, the second is where a violation would first be observable. **This section
is never a pointer**: an invariant is the thing a declaration cannot state, and it is the
highest-value section in this document.

| # | Invariant | Owner |
|---|---|---|
| **I1** | `seq` is strictly increasing by exactly one, per session, from 1. A gap is a bug, never a dropped event. It governs what `emit` assigns, and two things are outside that: the `replay_gap` envelope restates a watermark instead of consuming a `seq` (D156, *Streaming*), and a `message.delta` is assigned none at all (I51). Neither weakens the contiguity — the first consumes no number and the second never enters the sequence (D168) | `session-manager` |
| **I2** | The ring buffer's contents are a strict suffix of the spill's, envelope for envelope, byte for byte | `store` |
| **I3** | A `tool.result` is truncated before its envelope is constructed; the envelope in the ring and the line in the spill are identical | `session-manager` |
| **I4** | At most one `Turn` per session is non-null at any time | `session-manager` |
| **I5** | A guard is claimed in the same synchronous block that tests it: no `await` sits between a check and the mutation it protects. It governs six guards — the turn slot, the workspace claim, a requisition's decision, a requisition's consumption, a review's mutation, and a checklist item's completion | `session-manager`, `records` |
| **I6** | No two `live` sessions have `cwd` values where one equals, contains, or is contained by the other | `session-manager` |
| **I7** | `cwd` is a `ResolvedPath` inside a configured root, resolved exactly once at session creation and never re-resolved | `jail`, `session-manager` |
| **I8** | `state === 'ended'` implies `LiveSession.turn === null` and `endedAt !== null`; `state === 'live'` implies `endedAt === null` | `session-manager` |
| **I9** | Every `permission.request` is followed by exactly one `permission.resolved` with the same `requestId`, in the same session, before or at `turn.ended` | `session-manager` |
| **I10** | An `AuditRecord` is fsync'd before the corresponding `control_response` is written to the child's stdin | `session-manager`, `store` |
| **I11** | Every `permission.resolved` has exactly one `AuditRecord`, including auto-answers with `scope: 'standing'` | `session-manager` |
| **I12** | `AuditRecord.input` is never truncated, summarised, or derived; it is the bytes shown to the operator | `session-manager` |
| **I13** | `audit.ndjson` is never deleted, rewritten, or shortened, including when the session it names is deleted | `store` |
| **I14** | `turn.started` for a turn precedes every other event of that turn, and `turn.ended` follows all of them, including across a server restart | `session-manager` |
| **I15** | The `checkpoint.created` for turn N precedes `turn.started` for turn N, where a checkpoint was taken at all | `session-manager` |
| **I16** | `meta.json` is written only by temp-file-then-atomic-rename, and only on create, a `state` transition, or a `cliSessionId` change | `store` |
| **I17** | `lastSeq` used at boot is derived from the spill's tail, never read from `meta.json` | `session-manager`, `store` |
| **I18** | No connection is accepted until the storage lock, reaping, rehydration, open-turn closure, and record-log loading have all completed | `session-manager`, `records` |
| **I19** | A `ProcessRecord` is reaped only when its `hostname` is this host's — or absent, which reads as this host's (D181) — and it has no `exitedAt`, its `startedAt` is later than the host's last boot, the live process's image matches, **and the live process's creation time is exactly the recorded `osCreatedAt`** (D183, D186). A record naming another host is neither reaped nor tombstoned. The guard **fails closed**: a record whose `osCreatedAt` is `null`, or whose live counterpart cannot be read, is tombstoned and logged, never reaped. Reaping kills the tree, never the bare pid. **It governs `pids.ndjson` alone** — `<storage>/server.lock` is reclaimed by observation and shares nothing with this guard (D180, I50) | `session-manager` |
| **I20** | No module above `adapters/*` branches on a vendor string. `vendor` is carried as data on `SessionRecord`, `SessionSummary`, `SessionStarted`, `AuditRecord`, `SessionSnapshot` and `Requisition`, and is display or evidence in every one of them | all |
| **I21** | `CliSessionId`, `CallId`, and `RequestId` are only ever compared for equality above the adapter layer | `session-manager` |
| **I22** | A blob path contains both `turnId` and `callId`; no blob is addressable by `callId` alone | `store` |
| **I23** | Every route that reads or mutates a **session's** data is under `/api/sessions/:id` and applies the ownership check. The record routes are not session data and are governed by D70 instead: read is open, write is attributed | `edge/sse`, `edge/ws` |
| **I24** | The origin allow-list is applied to every mutating route and to the WebSocket handshake, before identity is resolved | `edge/sse`, `edge/ws` |
| **I25** | A `preauthorised` session emits zero `permission.request` events | `adapters/*` |
| **I26** | No string this codebase did not write is ever assigned to `innerHTML` or parsed as markup — agent output, tool results, and stored operator text alike | `client` |
| **I27** | There is no mutex, lock, or semaphore in the server. `emit`'s synchronous prefix — `seq`, ring push, fan-out — is the serialisation point. The per-session append chain that follows it orders I/O and excludes nothing (D89). `server.lock` is not a counter-example: it excludes a second *process*, not a second caller, and the running server only ever renews a lock it already holds — no code path acquires or waits on one after boot (D161, D180) | all |
| **I28** | `Usage` on an emitted `usage` event is incremental and summable; no module above `adapters/*` performs arithmetic on a vendor's own token numbers | `adapters/*` |
| **I29** | *(tier two)* A review's `state` moves `draft → final` and never back. A `final` review accepts no further append for that `reviewId` | `records` |
| **I30** | *(tier two)* A review's `snapshot` is copied at authorship and never refreshed; no read of a review resolves its `subject` | `records` |
| **I31** | *(tier two)* A `draft` review is readable and writable by its `author` alone; a `final` review is readable by every authenticated operator; `listReviews` returns finals only | `records` |
| **I32** | *(tier two)* A requisition moves only `open → approved → consumed` or `open → rejected`. There is no revocation and no expiry | `records` |
| **I33** | *(tier two)* A requisition is consumed at most once. A second claim is refused, never queued | `records` |
| **I34** | *(tier two)* `Requisition.workspace` is never a `ResolvedPath` and is never resolved before session creation; only `jail` mints a `ResolvedPath` | `records`, `session-manager` |
| **I35** | *(tier two)* PIP status is the `pip` of the `final` review for that subject with the greatest `updatedAt`, ties broken by the later line. Drafts never contribute | `records` |
| **I36** | *(tier two)* At most one `checklist.item.completed` envelope exists per `(sessionId, itemId)`; a second tick emits nothing and still succeeds | `session-manager` |
| **I37** | *(tier two)* A record-log append that fails leaves the in-memory registry and the file agreeing, with nothing changed in either | `records` |
| **I38** | *(tier two)* An unreadable or partly corrupt record log yields an empty or shortened registry and a log line. It never aborts boot, and never denies an operator tier one | `records` |
| **I39** | Every read of `audit.ndjson` is bounded by `Caps.auditPageMax` and resumed by cursor. Nothing scans the whole file | `store` |
| **I43** | A standing rule is created only where `decision === 'allow'`, `rule` parses, and the named request's `matchTarget` is non-null. Every other `scope: 'always'` is `bad_request`; none is silently downgraded to `once` | `session-manager` |
| **I44** | `PermissionRequest.suggestions` is the vendor's array forwarded verbatim. No module narrows, parses, indexes, or derives a `StandingRuleExpression` from it | `adapters/*`, `client` |
| **I45** | A standing rule exists only in its session's in-memory state. Nothing writes one to disk, and a session rehydrated at boot holds none | `session-manager` |
| **I46** | `match` reads only `rule`, `request.tool` and `request.matchTarget`. It never reads `input`, and no tool name appears in `session-manager` | `session-manager` |
| **I47** | `updatedPermissions` is never written to a child's stdin, under any decision or scope | `adapters/*`, `session-manager` |
| **I48** | `ToolCall.summary` is display-only: above `adapters/*` it is rendered as a text node and nothing else. No module parses it, matches against it, or derives anything persisted or security-relevant from it; its shape is not contractual. Testing it for empty, to decide whether to show the line at all, is display and is permitted | `adapters/*`, `session-manager`, `client` |
| **I49** | An attachment's bytes never enter `events.ndjson`, and an operator's `filename` never reaches a filesystem path — the server-minted `AttachmentId` is the only path segment. The blob is written and fsync'd before the `message` envelope naming it is constructed | `store`, `session-manager` |
| **I50** | A storage root is held by at most one server process. `<storage>/server.lock` is claimed **before boot's reap step**, not merely before `listen`, and is reclaimed only where its `(instanceId, renewals)` pair is observed unchanged across one full observation window measured on the claiming process's own monotonic clock — **whichever host wrote it**, and with no wall clock compared anywhere in the decision (D180). A boot that refuses on a held lock has written nothing server-wide. **A storage root is supported on a local filesystem or a bind mount only** (D194): the one hole — a live holder whose renewals are invisible for a full window — needs a cache or a partition between writer and reader, which two processes on one host do not have, so it is out of reach rather than tolerated. It is what a network-share root would reintroduce, and closing it there would need a fencing service outside the storage root (D7) | `store`, `session-manager` |
| **I51** | A `message.delta` is a live-only frame, for **both** vendors: it is assigned no `seq`, no `Envelope` is ever constructed for it, it never enters the ring buffer, it is never appended to `events.ndjson`, and it is never replayed. It is delivered to the subscribers attached when it is produced and to no others. Deltas for one `turnId` concatenate in arrival order to the `message` that follows (D168) | `session-manager`, `adapters/*` |
| **I52** | A shutdown establishes no durable state and holds no session invariant. It marks no session ended, closes no turn on disk, appends to no spill, writes no `session.notice`, and emits no envelope. Its only durable write is one `ProcessTombstone` per child it killed, which records what shutdown *did* rather than repairing what it found. Every repair stays boot's, so the crash path and the orderly path converge on one implementation of each (D174). **It is held by construction rather than by inspection**: I55 stops every notification at the sink, so no code below it is in a position to emit, resolve or append during teardown (D178) | `server`, `session-manager` |
| **I53** | `<storage>/server.lock` is removed only as the last act before exit, after the listener has closed and after the kill step has run. A shutdown that cannot get that far leaves the lock rather than releasing it early, and the next boot reclaims it one observation window after the holder's last renewal (D175, D180) | `server` |
| **I54** | A shutdown's completion never depends on a client disconnecting. Every step past the guard is bounded, so the exit is reached whether or not a subscriber is still attached — the clean path is reachable in the configuration that ships, not only when nobody was watching (D176) | `server` |
| **I55** | From the moment `SessionManager`'s shutdown method is entered, no `AdapterNotification` of any kind reaches a handler. The mute sits on the manager's own `notify` sink, which every notification already passes through, and **not** on the `exited` handler: `turn.ended` arrives as a second, separate notification after `exited` inside the same synchronous callback, so a mute on the handler would silence the cancellations and let the turn's closure through. The mute is one-way — nothing clears it, and shutdown is its only caller (D178) | `session-manager` |
| **I56** | `<storage>/server.lock` is written or removed only by the instance that holds it. `releaseLock` and every renewal read the file first and act only while it still carries this process's `instanceId`; an absent file or a foreign one means this server has been displaced — it removes nothing, and stops by running shutdown's ordinary steps, whose release then reads a foreign id and deletes nothing of its own accord (D180, D195). **Renewal continues through shutdown's steps 1 to 3 and is cancelled as step 4's first act**: this server holds the root while it drains, kills and tombstones, so a timer stopped any earlier lets a successor reclaim a root still being written to | `store`, `server` |
| **I57** | `pid`, `hostname`, `startedAt` and `image` on a `ServerLock` are informational. No decision reads them: not the reclaim decision, not the release check, not the renewal check. Their only consumer is the text of a `StartupError.storage_locked` (D180) | `store`, `session-manager` |

| **I59** | A turn ends by ending the process tree its child rooted, on **every** path a turn can end by — normal exit, interrupt, adapter failure, shutdown — using D38's one mechanism and no other. When `turn.ended` is observable for a turn, no process that turn started is still running, so a released workspace claim and a subsequent restore are never conditional on an untracked descendant (D184) | `session-manager`, `adapters/*` |
| **I60** | `Config.storageRoot` is jail-normalised, and `pathsOverlap` is false between it and every entry of `Config.workspaceRoots`. A configuration failing this is refused at startup and the server does not listen; no session is ever served from it (D185) | `config` |
| **I58** | An `IgnoredManifest` records path, kind, size and mtime and **never content**. `RestoreResult.unreached === null` means the comparison could not be made and never that nothing differs; an empty array is the positive answer. No gate, control, or refusal anywhere in this contract reads a manifest — it is a report to an operator and its collapsed-directory blindness makes it unusable as evidence (D182, D187) | `checkpoints`, `client` |
| **I61** | Every write of `<storage>/server.lock` publishes the file whole, so a sample observes complete contents or none and never a partial file: a reclaim and every renewal by temp-file-then-atomic-rename, and a claim on an absent lock by an exclusive create, which must fail rather than overwrite when a second booting server wrote first. A lock that will not **parse** is therefore corruption, and `claimLock` refuses on it rather than reclaiming (D196). A lock that parses and merely lacks `renewals` is not corruption: it predates the lease, and it reclaims by the ordinary rule (I50) | `store` |
| **I62** | `LOCK_RENEWAL_INTERVAL_MS` is strictly less than `LOCK_OBSERVATION_WINDOW_MS`, by a margin of at least three renewals, so a live holder can never be sampled unchanged across a window. **Enforced by the two being declared in one file** — `src/store/index.ts`, with the interval exported for `server.ts` to import rather than written a second time beside the drain's bound — because a violation has no symptom short of two servers over one storage root (D194, D195) | `store`, `server` |

**I40, I41 and I42 were never allocated, and the gap is left open rather than closed.** The
numbering jumps from I39 to I43 and nothing is missing. Ids here are cited by number in
`90-decisions.md`, in this document's own prose, and in `src/`, so renumbering to close a gap
would silently repoint every one of those citations — the same reason `AGENTS.md § Tracking
work` compares drift on ids and never on position.

**I59 and I60 were briefly numbered I56 and I57, and a citation predating this pass may still
mean them.** Two passes allocated independently: `97c1483` took I56, I57 and I58 for D184, D185
and D182/D187, and the lease pass six days later reused I56 and I57 for the lock, leaving each id
defined twice and every citation of them resolving to whichever row the reader met first. The
lease's pair keeps the ids and D184's and D185's move, which is the direction that leaves
`90-decisions.md` — append-only — untouched, since the one entry citing either sense (D193) means
the lock's. **This is the exception the paragraph above argues against, and it is taken only
because the alternative was two invariants answering to one name.** The table is ordered by when
a row was written, never by id, so I58 following I60 is not a symptom of it.

## Vendor mapping — Claude

Verified against `Forks-Claude-Code-Chat@ab6e307`, and against the installed CLI where noted.

| CLI stdout | Normalised |
|---|---|
| `system` / `init` | `AdapterNotification` `cli-session`; the manager emits `session.started` on the first turn only |
| `system` / `status: compacting` | `session.notice` (`compaction`) |
| `system` / `compact_boundary` | `session.notice` (`compaction`), reset local token counters |
| `assistant` → content `text` | `message` (role assistant) |
| `assistant` → content `thinking` | `thinking` |
| `assistant` → content `tool_use` | `tool.call` |
| `assistant` → `message.usage` | `usage`, **normalised to a delta** (D75) |
| `user` → content `tool_result` | `tool.result` |
| `control_request` / `can_use_tool` | `permission.request` |
| `result`, subtype success | `turn.ended`, `stopReason: 'completed'`; close stdin |
| `result`, any other subtype | `turn.ended`, `stopReason: 'error'`; close stdin |
| `close` with no `result` seen | `turn.ended`, `stopReason: 'process_exit'` |
| `stream_event` → `content_block_delta` → `delta.type: 'text_delta'` | `message.delta` — a **frame**, on the same terms as Codex's (D168, I51) |
| A record on the ignored list below | *nothing*, deliberately — **not** `adapter_unknown_record` |

Launched with `-p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio`, plus `--model <model>` when the session names one and
`--resume <cliSessionId>` when the manager supplies one. **`-p` is not optional**: without it the
CLI does not run non-interactively and the stream-json transport never starts. Outbound user
messages and `control_response` are single JSON lines written to stdin, **which stays open for
the whole turn**.

**The thirteen rows are not the CLI's whole vocabulary, and the mapper must not treat them as one**
(D92). The live stream carries records that are ordinary, harmless, and no part of this
vocabulary; raising `error / adapter_unknown_record` for each would put a diagnostic line in
front of the operator on every routine turn. The adapter therefore holds a named ignore list —
top-level `rate_limit_event` and `control_response`, and the `system` subtypes `hook_started`,
`hook_response`, `thinking_tokens` and `post_turn_summary` — and returns silently for those.
Anything outside both the thirteen rows and that list still raises `adapter_unknown_record`,
non-fatally, with the record preserved in `raw`. **The list is a vendor fact and lives with the
vendor's adapter; adding to it is an adapter change, never a change to `ErrorEventKind`.**

**The `message.delta` row above is S25.3's**, filled from observation the same way the Codex
tables were filled by S8.1 rather than hypothesised: `--include-partial-messages` is proven to
emit usable incremental text that concatenates byte for byte to the final `message`, and to
disturb neither the `control_request` round trip nor the per-`message.id` usage normalisation —
S25.1's finding (`design/findings/S25-token-streaming-probe.md`). Every other `stream_event`
subtype the probe observed — `message_start`, `content_block_start`, `content_block_stop`, the
top-level `message_delta` (its own final `usage`, unread — D75/S1.11's dedup already reads
`assistant`'s) and `message_stop` — carries nothing this vocabulary renders and is ignored the
same way the top-level ignore list below is, rather than raising `adapter_unknown_record` on
every streamed turn. Only reachable with the flag on (S25.6); off, no `stream_event` record is
ever sent and this row is dead code.

`updatedPermissions` is never sent (I47). Standing approvals are held by this server and matched
here, so that every match still produces a `permission.request` / `permission.resolved` pair and
an audit record.

**`permission_suggestions` stays forwarded unmapped** (D104, D108). At the time of D108's two
probes the field had never appeared on this transport, so no mapping could be written against a
shape nobody had seen; S26.1 later observed it, populated, on every `control_request` for a
state-mutating tool call (`design/findings/S26-real-permission-round-trip.md`), which reopens the
premise D108 rested on without reopening D108's grammar choice itself — carried as #194. The
adapter still passes the array through as `readonly unknown[]` and nothing narrows it (I44);
forwarding costs nothing and keeps the payload from being dropped silently regardless of how
that question resolves.

**`matchTarget` is this adapter's projection table**, and it is the only place tool-shape
knowledge is permitted to live (I46). It is emitted verbatim — no case folding, no separator
rewriting, no trimming:

| `tool` | `matchTarget` |
|---|---|
| `Bash` | `input.command` |
| `Read`, `Edit`, `Write` | `input.file_path` |
| anything else, including every `mcp__*` | `null` |

**Four rows, because four are what the finding names.** Every other tool in the CLI's vocabulary
projects `null` — not because a projection would be wrong, but because none has been observed and
this table is not the place to guess one. Adding a row is an adapter change carrying the same
obligation as any other row here: an observed request showing the field. **It never changes
`StandingRuleExpression`.**

A tool in the table whose named field is absent or is not a string projects `null` rather than a
coerced string. `null` is not a failure and raises nothing: it means a standing rule cannot be
created against that request, which the route refuses with `422 bad_request` on `scope` (I43).

Policy for every Claude session: `{ mode: 'interactive', sandbox: null, banner: null }`.

**Claude's usage is per-message, not cumulative, and the arithmetic the adapter owes is
de-duplication rather than subtraction** (open question 14, answered for Claude by S1). Each
`assistant` record reports that API call's own marginal usage, so nothing is subtracted. But **one
logical message arrives as several `assistant` records that share a `message.id` and repeat
byte-identical usage**, so the adapter emits `usage` **once per `message.id`** and drops the
repeats. The `result` record's usage is a different and larger basis and has no row in this table;
mixing it in would misreport burn. Probes and fixtures:
`design/findings/S1-claude-adapter.md`. **The obligation stays the adapter's; no caller
compensates for it.**

**Claude's runtime approval fires for a state-mutating tool call and not for a read-only one**,
under the default mode this server spawns with — observed against the real, installed CLI at
2.1.228, driven through this adapter's own `send()` (D173, S26.1,
`design/findings/S26-real-permission-round-trip.md`). D88's original probes (a `Read`, and a
non-redirecting `Bash echo`) were both the safe case; the "no `can_use_tool` of any subtype"
reading generalised past what those two commands could show. It does not reopen D5: the
mechanism was never a capability that was not there (D96).

## Vendor mapping — Codex

**Observed against `codex-cli 0.146.0`, not hypothesised**
(`design/findings/S8-codex-adapter.md`, S8.1). Neither live interface emits `session_meta`,
`payload.info` or `token_count`: that schema describes `~/.codex/sessions/**/rollout-*.jsonl` on
disk, which S8's *Out of scope* forbids scraping, and it is not what the CLI puts on a wire.

The CLI exposes **two** live interfaces, not one, and their guarantees differ in ways this
contract cannot average away — item-id uniqueness and the usage basis both change between them.
Both are mapped. **`app-server` is primary; `exec --json` is the fallback** (D107).

**Transport selection is the adapter's and it ends there.** `createAdapter` takes no transport
parameter and none is added: a transport is a vendor fact, and I20 forbids one above
`adapters/*`. The adapter selects `app-server` where the installed CLI offers it and
`exec --json` otherwise, once, at `create`. Where neither is available the result is
`AdapterError.agent_unavailable`, exactly as for a missing binary.

### `codex app-server` — primary

JSON-RPC 2.0 over stdio, marked `[experimental]` by the CLI itself. The shapes below are
schema-generated (`codex app-server generate-json-schema`, `v2/`), not hand-transcribed.

| Wire record | Normalised |
|---|---|
| `thread/started` | `AdapterNotification` `cli-session`, carrying `threadId`; the manager emits `session.started` on the first turn only |
| `turn/started` | *nothing* — the manager emitted `turn.started` when it claimed the slot |
| `item/started`, type `reasoning` | *nothing*; text accumulates in the adapter |
| `item/reasoning/summaryTextDelta` | *nothing*; accumulated |
| `item/completed`, type `reasoning` | `thinking`, with the accumulated text |
| `item/agentMessage/delta` | `message.delta`, role assistant — a **frame**, not an envelope (D168, I51) |
| `item/completed`, type `agentMessage` | `message`, role assistant |
| `item/started`, type `commandExecution` | `tool.call`; `callId` is the item's `id` |
| `item/commandExecution/outputDelta` | *nothing*; accumulated |
| `item/completed`, type `commandExecution` | `tool.result`, same `callId`; `ok` from `status`, `output` from `aggregatedOutput` |
| `thread/tokenUsage/updated` → `last` | `usage` |
| `turn/completed` | `turn.ended`; `stopReason` from `turn.status` — `completed`, `interrupted`, `error`, and anything else is `schema_mismatch`. Its `last` is **not** mapped: see *Usage* |
| `item/commandExecution/requestApproval` | **unreachable under the shipped policy** — see below |
| `close` with no `turn/completed` seen | `turn.ended`, `stopReason: 'process_exit'` |

### `codex exec --json` — fallback

Newline-delimited JSON on stdout. **No deltas of any kind**: text arrives whole, on completion.

| Wire record | Normalised |
|---|---|
| `thread.started` | `AdapterNotification` `cli-session`, carrying `thread_id` |
| `turn.started` | *nothing* |
| `item.completed`, `item.type == 'reasoning'` | `thinking` |
| `item.completed`, `item.type == 'agent_message'` | `message`, role assistant |
| `item.started` / `item.completed`, `item.type == 'command_execution'` | *not mapped* — recognised and dropped, deliberately. The item's `aggregated_output`, `exit_code` and `status` are all there; what is missing is a session-unique `CallId` to correlate on. See *Item ids* below and `## Unresolved` 13 |
| `turn.completed` | `turn.ended`, `stopReason: 'completed'`. Its `usage` is **not** mapped — see *Usage* |
| `close` with no `turn.completed` seen | `turn.ended`, `stopReason: 'process_exit'` |

**That row is live-only, and D168 changed it rather than leaving Codex where it shipped.** A delta
on this transport was previously spilled like any other envelope; it no longer is. The ruling is
cross-vendor deliberately — closing Claude's rendering asymmetry by opening a persistence
asymmetry, on the same surface, is the trade D165 declined in the other direction.

### Neither interface emits a `tool.call` / `tool.result` pair

Both model a command execution as **one** item with two lifecycle states — `started` with null
result fields, then `completed` on the same id carrying `aggregated_output`, `exit_code` and
`status`. There is no discrete result record to normalise. **The adapter therefore synthesises
the contract's pair from one item's two states.**

The ordering guarantee holds by construction: `completed` for an item cannot precede its
`started`, so *"`tool.result` follows its `tool.call`"* is satisfied with no buffering.

### Policy, and the approval prompt now known to be reachable

Policy for every Codex session:
`{ mode: 'preauthorised', sandbox: <the mode chosen at launch>, banner: <naming that mode> }`,
and I25 holds — a Codex session emits **zero** `permission.request` events.

**What changed is that the fallback's premise no longer holds, and this says so rather than
quietly keeping the conclusion.** Under `app-server` with `approvalPolicy: 'on-request'`, the
server sends a genuine JSON-RPC **request** — `item/commandExecution/requestApproval`, carrying
`reason`, `command` and an `availableDecisions` enum — which a client can answer. `exec --json`
sends nothing of the kind and structurally cannot; it is non-interactive by construction and
represents a sandbox denial only as the model reporting its own failure in prose.

The asymmetry D5 accepted is therefore **measurably narrower than when it was accepted**. This
section does not act on that: S8's *Out of scope* says a reachable `on-request` prompt is
reported, not acted on, and D5 is `/design`'s. **The row is marked unreachable under the shipped
policy rather than deleted, because the mapping it would need is one decision away, not one
experiment away.**

This adapter therefore has **no `matchTarget` projection table, and needs none**: it constructs
no `PermissionRequest` at all. Should the `on-request` row ever be mapped, a projection table is
part of that work — `item/commandExecution/requestApproval` carries `command`, so the row exists
in evidence already — and it is that adapter's, never `session-manager`'s (I46).

### Usage

**`app-server` needs no arithmetic, and it reads exactly one of the two records that offer it.**
`turn/completed` and `thread/tokenUsage/updated` both carry explicit `total` and `last`
sub-objects. The adapter reads `thread/tokenUsage/updated`'s `last`, which is that turn's own
marginal figure, so D75's summability requirement is met **by reading rather than by
subtracting** — the same shape of answer S1 reached for Claude. **`turn/completed`'s `last` is
deliberately not mapped**: it is the *same* marginal figure by a second route, so emitting
`usage` from both would put two envelopes carrying one turn's burn into the fold that sums them —
double-counting on the one screen headed *payroll*, which is the failure I28 exists to prevent.
**Which of the two is read is arbitrary; reading only one is not.**

**`exec --json`'s basis is undetermined, so its usage is not mapped at all.** Its
`turn.completed.usage` was observed almost exactly doubling across two sequential resumed turns
of one thread — `input_tokens` 46276 → 93393, `cached_input_tokens` 33280 → 66560 — which is
consistent with a running total and equally consistent with each call resending a growing
context. S8.1 did not settle which, and **I28 forbids guessing**: a cumulative figure summed as a
delta double-counts burn. A session on this transport therefore emits no `usage` events.

**That silence is surfaced, and surfacing it is not optional** (D146). An adapter selecting a
transport that cannot report usage appends `session.notice / usage_unavailable` at
`level: 'warn'` **once, at session start, before the first `turn.started`** — not per turn, which
would say the same thing repeatedly and bury it. The notice is the discriminator between a burn
of zero because the session was idle and a burn of zero because nothing was ever counted, and
without it `PayrollView.burn` reports the two identically. This is *fail loudly, never degrade
quietly* applied to the one screen where a silent zero reads as good news.

A notice envelope is the right carrier, and the `sandbox` notice member is not the precedent
against it: `sandbox` needed to be visible to a client joining at an arbitrary point, which an
envelope cannot promise and a session field can, whereas `PayrollView` is a fold that walks the
spill from the beginning. `session.notice / server_restart` is already folded that way (D130), so
this consumes an existing path rather than adding one.

**What the fold does with it is not settled here.** `PayrollView` has no field distinguishing
unknown from zero, and giving it one is a second public-surface change; `## Unresolved` 12
carries it.

### Item ids, and where the fallback breaks correlation

`CallId` is session-unique **by assumption** (`10-design.md § Data model — Identity spaces`).
That assumption is now measured for Codex, and it holds on only one of the two transports.

- **`app-server`: UUID-based** (`exec-a2215fa5-…`), distinct across two sequential turns of one
  thread. That is evidence of the scheme, not proof it never collides — two turns were probed,
  and only for `commandExecution` items. It is treated exactly as Claude's is: assumed, and
  stated as an assumption.
- **`exec --json`: a per-turn counter** — `item_0`, `item_1`, `item_2` — that **restarts on every
  turn of the same thread**, reproduced across two independent `codex exec resume --last` runs.
  This is not an assumption that might fail; it is a known collision.

S8.7 stops the slice before implementing tool correlation where this is found, and it is found.
**The fallback's `tool.call` / `tool.result` correlation is therefore not specified here and no
alias is invented**; `## Unresolved` 13 carries it. What must not happen is the obvious patch:
composing a session-unique `CallId` from `(turnId, itemId)` inside the adapter is cheap and
invisible above the boundary, and may well be the answer — but S8.7 reserves it, and a contract
that quietly took it would be deciding open question 7's correlation half by writing a table.

Storage is unaffected either way: D22 already puts `turnId` in the blob path, so a turn-scoped
`callId` cannot overwrite an earlier turn's output (I22). **Correlation is the half no path
scheme closes.**

### Schema mismatch

Two surfaces to check rather than one. A stream not matching the table for the transport
**actually selected** returns `AdapterError.schema_mismatch` and emits
`error / adapter_schema_mismatch` with `fatal: true`; the session refuses to start. **The adapter
must fail loudly, not degrade quietly** — a Codex adapter that silently renders nothing is worse
than one that refuses to start, because the operator will believe the agent is thinking.

**An `app-server` probe that finds no such subcommand is not a mismatch**: that is the fallback's
trigger, and it is the one case where falling back rather than failing is correct.

Records outside a transport's table but harmless may be held on a named ignore list, exactly as
D92 gives Claude one. Adding to it is an adapter change, never a change to `ErrorEventKind`.

## Unresolved

Signatures the design does not determine. Nothing downstream may invent them. Each item names
the issue that carries it. **This list only ever shrinks**: an entry a previous pass resolved
never reappears.

1. **Resolved by D160.** The field is restored, against types that now exist. Each gap D47 named
   is answered: the **transport** is the Anthropic content-block array the adapter already writes,
   with `Adapter.acceptsAttachments` declaring vendor support and S21.1 probing whether the Claude
   CLI accepts non-text blocks before anything is built on it; **storage** is
   `attachments/<turnId>/<attachmentId>`, D22's tool-output shape reversed, with bytes kept out of
   the spill (I49); the **byte cap** is `Caps.attachmentBytes` and `Caps.attachmentCount`, both
   refusals rather than truncations (D84); and the **audit consequence** is that there is none —
   `audit.ndjson` records tool approvals and S14.10 already refused to dilute it, so the `message`
   envelope is the record. The jail objection is answered too, and not by a control: *Threat model*
   already holds that `workspaceRoot` is not a sandbox, so an attachment adds no filesystem reach —
   it adds operator-chosen content to the agent's context, which is the *confused agent* row with
   a known author. (#22)
2. **Resolved by S10.1 and this pass** (D108–D110). Open question 8 is answered, and the answer
   is narrower than "insufficient": at the time of S10.1's probes `permission_suggestions` had
   never appeared on this transport. S26.1 later observed it populated
   (`design/findings/S26-real-permission-round-trip.md`), which reopens that premise without
   reopening the grammar choice itself — carried as #194. `StandingRuleExpression` is
   therefore a local grammar, `"<tool>:<pattern>"`, declared above with its full constraint;
   `parseStandingRule` and `match` are declared under `session-manager`; the tool-shape
   knowledge `match` would have needed moved to the adapter as `PermissionRequest.matchTarget`,
   which is what keeps `## Unresolved` 4's boundary intact. The rule's home is in-memory
   session state and its lifetime ends with the process — stated as a ruling, so there is no
   persisted schema and no migration story to write. `scope: 'always'` is implementable and
   `ResolvedScope: 'standing'` is reachable. (#16, #37)

   Two things this deliberately did **not** settle, neither blocking: whether a standing
   *denial* is ever wanted (`always` + `deny` is refused today, D110, and relaxing it is
   additive), and whether a rule should be revocable other than by ending the session.
3. **Resolved by S8.1.** The Codex event mapping had three normalised kinds with no source
   record. Both transports are now mapped from observation in `## Vendor mapping — Codex`, and
   the three rows are filled: there is no wire-level `tool.call` / `tool.result` pair on either
   interface, and the adapter synthesises it from one item's two lifecycle states. What the
   experiment exposed instead is carried as 12 and 13 below. (#14, #18)
4. **Resolved by D159.** `ToolCall.summary` is the adapter's, and D109 had already governed it:
   the tool-to-string projection behind `matchTarget` faced the identical question and was ruled
   the adapter's, because a per-tool field table is one vendor's vocabulary and hard-codes it into
   vendor-neutral code. Summarising a call in one line needs the same table under a different name.
   The discomfort this item recorded — vendor code producing a display string — is bounded rather
   than removed, by I48: `summary` is display-only, nothing above `adapters/*` parses or branches on
   it, and its shape is not contractual, so an adapter may change how it reads without breaking a
   consumer. Rejected alternatives are in D159; the sharpest is deriving it from `name` +
   `matchTarget`, which fails because `matchTarget` is `null` outside Claude's four mapped rows and
   because it would couple a display string to the field I43 and I46 match against. (#23)
5. **Resolved by S12.** `session-manager.readAudit` serves the route, delegating straight to
   `Store.readAuditPage`; `session-manager` was chosen over `records` because `records` is
   tier two and does not exist when tier one's `GET /api/audit` must already work, and every
   edge already depends on `session-manager` and never on `store` directly. The method takes
   no owner and applies no ownership check, unlike every other method on that interface,
   because D70 opens this read to every authenticated operator regardless of session
   ownership — it sits on `session-manager` only because that module already bridges edges to
   `store`, not because the read is about sessions. S17 (tier two) reuses the same method with
   `incidentsOnly: true` rather than duplicating it on `records`. (#34)
6. **Resolved by D127.** `SessionManager.getSnapshotForReview` reads a session's snapshot with
   no owner parameter and no ownership check, shaped like `readAudit` above. `POST /api/reviews`
   calls it directly rather than the ownership-checked `get`. (#32)
7. **Resolved by D120.** The two orders were each partly right: a requisition's decision and a
   review's mutation claim an exclusivity lock synchronously, before the append — which is what
   D32's guard rule requires — but that lock is distinct from `state`, and `state` itself
   changes only after the append durably succeeds, never before. The signatures above needed no
   change; `decide`, `appendReview` and `finaliseReview` already return only once the store call
   settles, and `RecordsError.storage`'s "the registry is not mutated" already said the right
   thing. (#31, and #35 for the review half)
8. **Resolved by D129.** `remainingTokens` subtracts `burn`'s full component-wise sum — input,
   output, cache reads, and cache creation all count against the budget — from `budgetTokens`.
   The budget's *scope* is resolved separately: per session (#29), which this contract already
   followed the design in taking.
9. **Resolved by D122.** Every session has a checklist — the template is global configuration
   (D71) and not tied to a requisition — and ticking is refused on an ended session,
   `409 session_ended`, matching every other session-write route. (#41)
10. **Resolved by D120, D124 and D128.** `finaliseReview` claims the same synchronous I5 lock
    as `appendReview` (D120, and named among I5's six guards by D124). The crash half is closed
    by D128: `Store.appendReview` is durable — fsync'd before it returns — so a line the caller
    was actually told succeeded cannot be un-written by a later host crash. The accepted
    latest-line-wins reversion (D65) still applies to a write the caller was never acknowledged
    for, which is the same durable-before-ack shape I10 already gives `AuditRecord`. (#35, #36)
11. **How a removed or retyped field in `reviews.ndjson` or `requisitions.ndjson` is
    migrated.** Every other persisted shape gates on `meta.json`'s `schemaVersion`, and these
    two files are not under it. Adding fields is safe today; removing or retyping one has no
    stated rule and no discriminator to hang one on.

Items 12 and 13 arrived with S8.2, and both are now carried by an issue: 12 by #29 and #30,
13 by #93. The note that stood here said both were un-issued because `/track` was suspended
under D105 — D111 established that D105's freeze was decided and never executed, so nothing
was suspended and that reason was never true. `/track`'s own mandate covers `30-slices.md` and
`90-decisions.md § Open` only, never this section directly, which is why item 13 sat unissued
even after D111 — it needed opening by hand rather than by `/track`'s next run. Both items
belong to the `exec --json` fallback alone; neither affects a session on `app-server`.

12. **What basis `codex exec --json` reports usage on.** Its `turn.completed.usage` was observed
    roughly doubling across two resumed turns of one thread, which fits a running total and fits a
    growing resent context equally well. I28 requires the adapter to emit something summable, and
    guessing wrong double-counts burn in `PayrollView`. Until a probe distinguishes the two, that
    transport emits no `usage`. Related: 8, and whether `reasoning_output_tokens` counts toward
    `Usage.outputTokens` at all. (#29, #30)

    **The rider is resolved by D146 and no longer waits on the basis.** Whether a session that
    reports no burn says so is answered yes: `SessionNoticeCode` gains `usage_unavailable`,
    emitted once at session start by an adapter on a transport that cannot report usage, per
    *Vendor mapping — Codex § Usage*. Deferring it until the basis was known was rejected — the
    two questions are independent, and the silence misreads as a zero for however long the basis
    stays open. Shipping the fallback is therefore not gated on this either. (#91)

    **What remains open is the consumer, not the signal.** `PayrollView.burn` is a `Usage` whose
    all-zero value now has two meanings, and the view carries nothing to separate them. Making
    `burn` nullable is the honest shape and forces every reader to handle the unknown, where a
    boolean beside it can be ignored silently — but it is a second public-surface change to a
    materialised type, it makes `remainingTokens` null by consequence, and it was not decided
    here. Nothing may infer the distinction by testing `burn` for zero. (#30, #91)
13. **Tool correlation on `codex exec --json`, whose item ids collide across turns.** Its ids are
    a per-turn counter that restarts each turn of a thread, so `CallId` is not session-unique on
    that transport — measured, not assumed. S8.7 stops before implementing correlation here and
    routes it to `/design` as open question 7's correlation half. The obvious fix — the adapter
    composing a session-unique `CallId` from `(turnId, itemId)` — is deliberately **not** taken
    here: it is invisible above the adapter boundary and may well be right, but S8.7 reserves the
    choice, and writing it into the mapping table would decide it by omission. (#93)

14. **Resolved by D178.** The call site is one new method on `SessionManager`, declared under
    *Public surface § `session-manager`* with the three things it must do and the order it must
    do them in; `server.ts` calls it and kills nothing of its own. The finding this item
    recorded is what forced that shape rather than being set aside by it: a tree kill by **any**
    route drives the adapter's `exited` notification, so something has to silence that path, and
    the only modules that can are the one holding the sink and the one raising it. `server.ts`
    reaches neither without a new surface on `SessionManager`, so "no manager counterpart" was
    never among the outcomes.

    The silence is the manager's, and it sits in the manager's own `notify` closure rather than
    in the `exited` handler — measurable rather than stylistic, because `turn.ended` is a
    second, separate notification arriving after `exited` inside the same synchronous callback,
    so a mute on the handler would catch the cancellations and miss the turn's closure (I55).
    `Adapter.detach()` was rejected on cost and blast radius: two public additions rather than
    one, since the manager surface is needed either way, and a method whose only correct caller
    is shutdown blinds a live session silently in every other hand. **I52 is then met by
    construction rather than by inspection** — nothing reaches the sink, so nothing below it is
    in a position to emit, resolve or append — and the `ProcessTombstone` moves to kill time,
    where it no longer has to win a race against whatever budget the drain has left.

    Building it is staged in `90-decisions.md § Open` with D174–D177's, and is not yet issued.

15. **Resolved by D195.** Both halves are settled and neither shape was taken whole. `store` gains
    one plain method, `renewLock`, declared under *Public surface § `store`*: it performs the
    ownership-checked write and reports `renewed` or `displaced`, and it owns no clock — `store` has
    a lifecycle nowhere else in this design, and giving it one here would make every test that
    claims a lock responsible for tearing a timer down. `server.ts` drives the interval, which is
    the module that already owns exiting and already holds the drain's and the release's bounds.
    **What a displaced holder's stop travels through turned out to be nothing new**: it runs
    shutdown's ordinary steps 1 to 4, because I56 already made release an ownership check, so step 4
    reads a foreign `instanceId` and removes nothing without being told to. The only addition is a
    second non-zero exit beside the guard's. The interval's own value follows from 16 and is
    `LOCK_RENEWAL_INTERVAL_MS`, declared beside the window and exported so the two cannot drift
    apart (I62). (#206)
16. **Resolved by D194, and it is the design's open question 16 that was answered.** The supported
    storage classes are a local filesystem and a bind mount, and nothing else; a network-share root
    is out of scope until a gate exercises one, rather than claimed and ungated — which is the
    design's own reading of D64 applied to itself. Fixing the scope answers the shape as well as the
    number: within these classes a write is visible to another process on the same host at once, so
    the window is bounded by a stalled *holder* rather than by a client's attribute cache, and no
    correct value depends on how an operator mounted anything. It is therefore a **module
    constant** — `LOCK_OBSERVATION_WINDOW_MS`, 10 000 ms — and this document's standing ruling on
    sibling bounds stands unreversed. The partition residual is not closed but put out of reach, and
    is now the reason the scope is drawn where it is. **This leaves `10-design.md` overstating the
    scope in three places** — *Platform divergence*'s network-share row and the paragraph above it,
    the partition row in *Failure modes*, and open question 16 itself. That edit is `/design`'s, and
    this pass deliberately did not make it. (#206)
17. **Resolved by D196, and only because 16 went the way it did.** Every write of the lock
    publishes it whole — a reclaim and every renewal by the temp-file-then-atomic-rename helper the
    same module already uses for `meta.json` under I16, a claim on an absent lock by an exclusive
    create, which unlike a rename fails rather than overwrites when a second booting server wrote
    first (I61). A reader therefore observes complete contents or none. An
    unparseable lock is therefore corruption rather than a renewal caught in flight, and `claimLock`
    refuses on it: `StartupError` gains `storage_lock_corrupt`, since `storage_locked` names a
    `holder: ServerLock` and a file that will not parse names nobody. **D161's objection does not
    survive into the lease, which is what makes refusing affordable**: a crash now leaves a
    well-formed lock whose counter merely stops moving, reclaimed by the ordinary rule one window
    later, so no unclean shutdown needs a human and refusal costs nothing that objection was
    protecting. The rule is keyed on *parsing* and not on a missing field, so a lock predating the
    lease still reclaims (I61). Had 16 kept a network share in scope this would have gone the other
    way — rename's atomicity over SMB and NFS is exactly the uncertainty the item named. (#206)
