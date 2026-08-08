# Decisions — SkyNet HR

Append-only. The rejected alternatives are the point; without them the next session
relitigates the same choice.

### 2026-08-08 — D1 Server-Sent Events downstream, POST upstream
Context: The console needs a live event stream to the browser. Traffic is heavily
asymmetric — agent events flow down continuously, operator actions go up occasionally.
Chosen: SSE for server→client, ordinary POST for client→server.
Rejected: WebSocket — needs a dependency in Node, and reconnect plus replay must be built
by hand. `EventSource` gives automatic reconnect and sends `Last-Event-ID` for free, which
is exactly the replay-after-refresh requirement in the brief. Rejected long-polling — worse
than both.
Reversibility: cheap. The envelope in `20-contract.md` is transport-neutral; swapping
transports touches the edge layer only.
**Superseded in part by D10** — SSE does not survive Open WebUI's HTTP proxy.

### 2026-08-08 — D2 Sequence numbers assigned by the session manager
Context: Replay needs a monotonic key per session, and adapters may restart within a
session's life.
Chosen: the session manager stamps `seq`; adapters emit unsequenced events.
Rejected: adapter-assigned sequences — a restarted adapter restarts the count and silently
corrupts replay. Rejected timestamps as the key — not monotonic under clock adjustment, and
collide at millisecond precision under a fast stream.
Reversibility: expensive. Every stored transcript is keyed on this. Get it right first.

### 2026-08-08 — D3 Authenticate by delegation, not by storing credentials
Context: Self-hosted for a handful of trusted operators. Real auth is needed, but a
password database brings hashing, reset flows, lockout and session fixation — a meaningful
vulnerability surface.
Chosen: trust an identity header from a reverse proxy (Authelia, Authentik, oauth2-proxy,
Cloudflare Access) as the primary mode; a shared secret in a cookie as a fallback for a
bare LAN box. The server refuses to start on a routable interface with neither configured,
and in header mode requires an explicit upstream allow-list.
Rejected: building login — the code most likely to contain the vulnerability that matters,
for no benefit at this user count. Rejected adopting OpenWebUI's user system, see D9.
Rejected no auth on a "trusted LAN" — a LAN is not a trust boundary, and the failure mode
is an unauthenticated remote shell.
Reversibility: cheap to add a third mode; expensive to retrofit ownership if we ever ship
without any identity at all, which is why we do not.

### 2026-08-08 — D4 The jail check runs on the resolved real path
Context: The agent has filesystem access. `cwd` arrives from the client.
Chosen: resolve symlinks, collapse `..`, normalise case on Windows, then test containment
against configured roots. The resolved path, never the client's string, is passed as `cwd`.
Rejected: prefix-matching the raw string — defeated by `..`, by symlinks, and on Windows by
case and 8.3 short names. Rejected a deny-list of sensitive paths — enumerating badness
never terminates.
Reversibility: cheap in isolation, expensive in consequence. Must be in the
session-creation path from the first commit.

### 2026-08-08 — D5 The interactive permission model is the contract; Codex under-delivers visibly
Context: Claude decides tool permission per call at runtime over stdio. Codex fixes
`approval_policy` and `sandbox_mode` at launch. These are different models, not different
spellings.
Chosen: `20-contract.md` models the interactive case. A session declares
`policy.mode: 'interactive' | 'preauthorised'`. Codex sessions are `preauthorised`, carry a
persistent UI banner naming the sandbox, and emit no permission events.
Rejected: lowest common denominator, launch-time policy for both — discards the console's
single most valuable capability, approving a tool call from away from the server. Rejected
synthesising fake prompts for Codex by pausing its process — we cannot honour a denial, so
the prompt would be theatre.
Reversibility: cheap to revisit if Codex turns out to expose a runtime approval hook. That
is listed under Open.

### 2026-08-08 — D6 Checkpoints via a shadow git directory
Context: Operators need to undo a turn's filesystem changes. The workspace may or may not
be a git repository, and if it is, it is the operator's and must not be disturbed.
Chosen: a second `GIT_DIR` per session in server storage, with the workspace as its
`--work-tree`. Commit before each turn; restore with `checkout <sha> -- .`.
Rejected: committing to the operator's own repository — pollutes their history and index.
Rejected filesystem snapshots — not portable across Windows and Linux. Rejected copying the
tree — cost scales with repository size, and large repositories are the normal case.
Reversibility: cheap. Self-contained, vendor-agnostic, and deletable.

### 2026-08-08 — D7 No database in the first cut
Context: Sessions, transcripts and the audit log all need to persist.
Chosen: files. `meta.json` and an append-only `events.ndjson` per session; one
`audit.ndjson` for the server. Ring buffer in memory for live replay.
Rejected: SQLite now — a schema and a migration story bought before any query exists.
Adopt it at the first requirement that is not "mine, recent".
Reversibility: cheap while the only reader is the session manager.

### 2026-08-08 — D8 `Forks-Claude-Code-Chat` is reference only
Context: It is the best available documentation of the Claude CLI's stream-json and
permission protocol. Its LICENSE is all rights reserved, granting viewing for educational
and reference purposes and explicitly forbidding derivative works.
Chosen: take protocol knowledge and technique; copy no source. Findings are recorded with
file and line in `10-design.md § Prior art` so any claim can be rechecked.
Rejected: forking it — the licence forbids it, and independently its 4,049-line extension
host is bound to `vscode.*` throughout with a single-user trust model that does not
generalise.
Reversibility: not applicable. This is a constraint, not a preference.

### 2026-08-08 — D9 Do not build on OpenWebUI
Context: OpenWebUI is a mature self-hosted browser AI interface with the multi-user account
system this project needs, and adopting it would skip D3 entirely.
Chosen: build the console standalone and put authentication in front of it (D3).
Rejected: forking or extending OpenWebUI. It is a chat client for model APIs, not an agent
console — it has no concept of supervising a shell-capable child process, no tool-approval
round trip, and no workspace model, so it solves the half of the problem that a reverse
proxy already solves and none of the half that is actually hard. Adopting it also means
adopting Python/FastAPI/Svelte alongside a Node agent supervisor. Its licence terms have
changed over time and would need checking before any reuse.
Reversibility: cheap in one direction — the console can be run behind or beside OpenWebUI
later. Expensive in the other, since a fork would set the stack.
Caveat: this decision is reasoned, not verified. Unlike D8 there is no local checkout and
no code was read. Revisit if someone interrogates it properly.

### 2026-08-08 — D10 Transport is chosen by deployment mode, not once
Context: D1 chose SSE. Verified against a local Open WebUI checkout (`v0.11.0`,
`backend/open_webui/routers/terminals.py`): its HTTP proxy streams only content types in
`STREAMING_CONTENT_TYPES` — `application/octet-stream`, `image/`, `application/pdf`.
`text/event-stream` is absent, so an SSE response falls through to
`await upstream_response.read()` and is fully buffered, under a 300 s total timeout. **SSE
does not work behind Open WebUI.** That same file carries a separate WebSocket proxy for
interactive terminal sessions, authenticated by a first message
`{"type":"auth","token":"<jwt>"}`.
Chosen: keep SSE for standalone deployment (D1's reasoning holds there — free reconnect and
`Last-Event-ID` replay), and add a WebSocket edge for proxied deployment. The envelope in
`20-contract.md` is transport-neutral, which is what makes two edges cheap rather than a
fork in the design.
Rejected: WebSocket everywhere — loses automatic replay in the standalone case, which is a
brief requirement, for uniformity we do not need. Rejected SSE everywhere — verified not to
work behind the proxy we most want to sit behind.
Reversibility: cheap, and this is exactly why D2 put `seq` in the envelope rather than in
the SSE `id:` field alone. Replay must work on both edges.

### 2026-08-08 — D11 Integrate with Open WebUI as a backing service; do not fork it
Context: supersedes D9, which rejected Open WebUI on reasoning without reading it. Having
now read the local checkout, two of D9's premises were wrong. Its licence is BSD-3-Clause
plus a branding-retention clause that binds only above **50 end users in a rolling 30-day
period** — inapplicable at our scale, so it is effectively permissive for us. And it is not
merely a chat client: it ships OAuth, SCIM, groups with access control
(`utils/access_control/`), audit logging (`utils/audit.py`), rate limiting
(`utils/rate_limit.py`) and security headers — most of what S5 and S7 were going to build.
Decisively, `routers/terminals.py` is an authenticated reverse proxy to **admin-configured
external terminal servers**; it spawns nothing itself. It forwards
`headers = {'X-User-Id': user.id}` plus an `X-Session-Id` described in its own comment as
"per-session cwd tracking", and supports `bearer`, `session`, `system_oauth` and `none`
upstream auth modes.
Chosen: build the console standalone as designed, and make Open WebUI's proxy contract —
`X-User-Id`, `X-Session-Id`, bearer upstream auth — a first-class deployment mode of the
auth edge. The console can then be registered as a terminal-server connection and inherit
accounts, groups, audit and rate limiting from a mature codebase, while owning the part
that is actually hard: agent-process supervision and the permission handshake.
Rejected: forking Open WebUI — adopts Python/FastAPI/Svelte alongside a Node supervisor,
and takes on their release cadence, for capabilities we can consume across a proxy instead.
Rejected ignoring it (D9) — that decision was made without reading the code and was wrong
on the facts.
Reversibility: cheap. It is one auth mode and one transport edge, both additive. Nothing
about standalone operation depends on it.

### 2026-08-08 — D12 `open-webui/computer` is not a base, and not a substitute
Context: it is the nearest existing thing to this brief — "a standalone, mobile-first
computer and coding agent that runs on the machine you own. Files, terminal, and git in a
browser tab." Worth settling explicitly so it is not rediscovered as an idea later.
Chosen: do not adopt it; note it as prior art and as a usable tool for single-operator work
today.
Rejected as a base on two architectural grounds, both verified from its documentation.
**It calls model APIs directly** with the operator's own keys; it does not supervise agent
CLI processes. That means it does not do the one thing this design exists to do, and it
inherits none of the interactive permission handshake that makes the console worth having.
**It is explicitly single-user** — its own security note states that once authenticated a
user has full access to the host filesystem and shell, and that the model holds only when
you are the only user. That contradicts the brief's multi-operator requirement directly,
and it is not a gap that can be closed from outside.
(Its licence is source-available rather than open source. Noted and not weighed — we are
taking ideas, not code.)
Its Gateway API — exposing a workspace as an OpenAI-compatible model so Open WebUI can
consume it — is a pattern worth copying, and independently corroborates D11's
backing-service shape.
Reversibility: not applicable; this is an evaluation, not a commitment.

### 2026-08-08 — D13 SubZeroDev.AgentKit installed: AGENTS.md direction, codex/PROFILES.md, and Measure-Session.ps1 hooks
Context: `/install SubZeroDev.AgentConsole` run from the kit against this repository, a
first install (no prior `.claude/kit.json`). Three forks needed sign-off; the rest of the
kit's artifacts were plain Absent-creates.
Chosen: `AGENTS.md` holds the contract with a Project identity section (derived from
`README.md`) prepended; `CLAUDE.md` is a pointer. `codex/PROFILES.md` installed despite the
kit's skip-by-default, because this repo's own design docs already commit to a Codex
adapter (S8, and the hypothesis in `20-contract.md`) — that is the evidence the kit's rule
asks for. `tools/Measure-Session.ps1` wired as `SessionEnd`/`UserPromptSubmit` hooks in a
freshly created `.claude/settings.json`, identical to the kit's own wiring; `pwsh` confirmed
on `PATH` first. `agent.md` installed unpruned — none of its lessons are demonstrably
inapplicable to a Node/TypeScript project on the same Windows host holding the same
`design/` discipline. `design/` itself was left untouched: this repository's docs already
hold real, fully-authored content at the exact path the kit's template seed would occupy,
so the seed step was a no-op rather than a merge.
Rejected: flipping `AGENTS.md`/`CLAUDE.md` to match some other arrangement — moot, neither
existed yet, so there was nothing to preserve a direction against. Rejected skipping
`codex/PROFILES.md` per the kit's default — the default exists to avoid installing
Codex-specific material into a repo with no evidence of Codex use, which does not describe
this repo. Rejected pruning `agent.md` speculatively — a lesson removed on a guess is a
lesson relearned the hard way a second time.
Reversibility: cheap. Every file here is kit-owned and re-syncable; nothing here touches
`spike/` or the console's own design content.

### 2026-08-08 — D14 `Start-AgentSession.ps1` relocated from AgentKit's spike PR #19
Context: AgentKit's `spike/agent-session-orchestrator` branch (PR #19, unmerged) held a
local PowerShell launcher that routes AgentKit's own slash commands to the right
vendor/model/effort and resumes session chains — session orchestration, but for AgentKit's
own command set, not for driving arbitrary coding-agent CLIs from a browser.
Chosen: relocate it wholesale (`tools/Start-AgentSession.ps1`,
`tools/Start-AgentSession.Tests.ps1`, 1150 lines) into this repo's `tools/`, and remove it
from AgentKit's PR #19 (commit `0ab7f23`, pushed) rather than leaving a duplicate behind.
Its subject — supervising agent sessions — is this repo's concern, not the kit's; keeping it
in AgentKit would have meant two places claiming to own session orchestration.
Rejected: copying without removing — leaves two copies to drift, and PR #19 would keep
proposing a tool whose actual home is here. Rejected leaving it in AgentKit unmodified —
it never fit that repo's own scope (routing AgentKit's *own* commands) as cleanly as it
fits this one's need to launch and manage agent CLI sessions.
Reversibility: cheap — pure move, both repos' git history retains the original content.
Not yet reconciled against this repo's own architecture (D1–D12): the script assumes a
local interactive terminal, not the server/SSE/adapter shape decided here. That reconciliation
is unstarted and belongs to whichever slice first needs a CLI launcher, not to this move.

### 2026-08-08 — D15 Renamed to SkyNet HR
Context: the project was named Agent Console, which described the surface (a console) rather
than the subject (supervising a set of agent workers). Requested rename, applied before any
implementation exists and before a remote repository was created — the cheapest moment it
will ever be.
Chosen: `SkyNet HR` in prose, headings and the project-identity paragraph; `SubZeroDev.SkyNetHR`
as the directory and repository identifier; `skynet-hr-spike` as the spike's package name and
`skynet-hr` in its startup log. Thirteen occurrences across README, `AGENTS.md`, the five
`design/` titles, and three `spike/` files. The historical reference inside D13
(`/install SubZeroDev.AgentConsole`) was left verbatim: this log is append-only, and that
command genuinely ran against that path — rewriting it would make the record false to
tidy the spelling.
Rejected: renaming the directory only and leaving the product as Agent Console — a repository
whose name and subject disagree costs a sentence of explanation to every reader, forever.
Rejected `SkyNetHR` unspaced in prose — identifiers want no space, sentences do; the split
matches how `Agent Console` read against `SubZeroDev.AgentConsole` before it. Rejected
rewriting D13's historical path for consistency, per above.
Reversibility: cheap for the text and the directory, both pure renames with no remote to
coordinate. It stops being cheap the moment a remote exists or the name reaches anyone
outside this machine.

### 2026-08-08 — D16 The agent child process is turn-scoped, not session-scoped
Context: `10-design.md § Data model` had to say what owns a child process, and the answer
determines whether an idle session holds an operating-system handle on its workspace. The
spike already spawns per turn; this makes it a decision rather than an accident.
Chosen: one child per turn. The CLI owns conversation state and it is carried forward with
`--resume <cliSessionId>`; the process is disposable. An idle session holds no process.
Rejected: a long-lived child per session — it keeps handles open on the workspace across
idle time, which on Windows blocks `checkpoint restore` and turns a structural guarantee
into a retry loop. It also needs idle supervision, health checking and reaping that a
per-turn child does not. Rejected a pool of warm children — solves a startup-latency
problem we have not measured, at the cost of both of the above.
Consequence, stated because it is easy to miss: `system/init` arrives on every turn, so
`session.started` must be emitted only on the first, or the client sees the session restart
continuously.
Reversibility: expensive. It is load-bearing for checkpoint safety and for the event
vocabulary, and reversing it reopens the Windows handle problem.

### 2026-08-08 — D17 Turn-in-flight state is owned by the session manager, not the adapter
Context: two operations must refuse to run while a turn is live — `POST /message` and
`POST /checkpoint/restore` (S6.5). The spike raises `turn_in_flight` from inside the Claude
adapter, which only the first of those two can reach.
Chosen: the session manager holds turn state and answers both.
Rejected: leaving it in the adapter — checkpoint restore does not go through an adapter and
must not have to, so the adapter would be consulted about something outside its concern.
That makes the adapter non-leaf and creates exactly the `adapter → session-manager` cycle
that `10-design.md § Module boundaries` forbids. Rejected duplicating the check in both
places — two authorities on one invariant is a promise they will disagree.
Reversibility: cheap now, expensive after a second adapter exists, since each would carry
its own copy of the rule.

### 2026-08-08 — D18 Fan-out uses a per-subscriber queue with explicit gap reporting
Context: one session may have several connected clients, and `emit` dispatches to all of
them synchronously. A client on a slow link would otherwise apply backpressure to every
other client and, through the drain, to the child's stdout.
Chosen: each subscriber gets its own bounded queue. Overflow drops that subscriber and
tells it, so it reconnects and replays; every other subscriber is unaffected.
Rejected: a shared synchronous write to all subscribers — one slow client degrades the
whole session, and the failure is invisible until it is a stall. Rejected unbounded
per-subscriber buffering — converts a slow client into a server memory leak, which is the
same bug with a longer fuse.
Reversibility: cheap. Contained entirely within the session manager's fan-out.

### 2026-08-08 — D19 One live session per workspace path; the second is refused
Context: two sessions rooted at the same resolved path get independent shadow git
directories and no lock between them, so a checkpoint restore in one silently reverts the
other's work. `10-design.md § Concurrency` had this as the single unresolved race, and the
brief does not say whether workspace sharing is allowed.
Chosen: session creation refuses with `409` when another live session already holds that
resolved path. The check runs at create, immediately after the jail resolution that already
produces the path it compares — so it costs a map lookup and no new machinery.
Rejected: allowing it with a warning banner — the hazard is silent data loss, and a banner
is not a lock; it informs an operator about a race they cannot then avoid. Rejected
allowing it with checkpoints disabled on the second session — removes the hazard but costs
that operator DoD #6, and requires the client to explain why a documented feature is
missing for reasons outside their session. Rejected deferring to S6 — session creation
ships in S2, so deferring means reopening the create path later to add a check that belongs
in it from the first commit, which is the same argument D4 makes about the jail.
Consequence: the refusal is on the **resolved real path** (D4), not the requested string,
so two different spellings of one directory are correctly caught as the same workspace.
Reversibility: cheap. Relaxing a refusal is additive; retrofitting one after operators have
built habits around sharing is not.

### 2026-08-08 — D20 Sessions rehydrate read-only after a restart
Context: `meta.json` and `events.ndjson` are written per session, but the registry is a
memory `Map` and nothing reloads it. A restart therefore lost every session while leaving
its files on disk — unreachable, uncleanable, and invisible. The brief's DoD #5 specifies
page refresh, not process restart, so this was genuinely unspecified rather than decided.
Chosen: on boot, after reaping orphaned children and before accepting connections, load each
`meta.json` into the registry marked ended. The transcript and the checkpoints stay
browsable; no new turn may start.
Rejected: full resumption via `--resume` — it depends on the vendor CLI still holding that
`cliSessionId`, which is unverified, and its failure mode is silent: the CLI starts a fresh
conversation the operator believes is continuous. That is worse than a session that plainly
says it ended. It stays available later as a pure addition to this. Rejected deleting
storage on boot — discards transcripts and checkpoints for work that may be hours old and
weakens the audit trail S7 exists to provide. Rejected leaving today's behaviour deliberate
— the storage root then grows without bound with sessions nothing can reach or clean up.
Three consequences, each a real change rather than a restatement:
- **`events.ndjson` becomes a read path.** It was write-only. A rehydrated session has an
  empty ring buffer, so its transcript can only come from the spill.
- **`meta.json` must round-trip `lastSeq`**, or a rehydrated session cannot bound its own
  replay.
- **D19's busy check must consider live sessions only.** An ended session still holding a
  workspace path must not block a new session on it, or one restart makes a workspace
  permanently unusable. This is the sharp edge of the two decisions meeting.
Reversibility: cheap toward full resumption, which is additive. Expensive away from
persistence entirely, since the read path and the `lastSeq` field become load-bearing.

### 2026-08-08 — D21 No turn timeout; a stall indicator instead
Context: a child producing no output is indistinguishable from one that is thinking, so an
operator gets a spinner with no information and the failure table had a row reading "not
detected". The brief yields no timeout value, and any value chosen would be arbitrary.
Chosen: no server-side timer terminates a turn. The client tracks elapsed time since the
last envelope and surfaces it — "no output for 6 min" — with interrupt always available.
The operator judges; the console informs.
Rejected: an idle timeout on silence — a long compile, test run or download emits nothing
and is indistinguishable from a hang, so the legitimate case most likely to be killed is
exactly the one this console exists to supervise. Rejected a hard cap on turn duration —
same objection, less discriminating. Rejected shipping it configurable and defaulting off —
adds a config surface and a kill path that is off by default and therefore never exercised,
which is how a rarely-run code path becomes a bug discovered during an incident.
This follows the threat model rather than departing from it: the operator is already the
control against a confused agent, and that only works if they are given the information to
act on. A timeout substitutes a guess for a judgement.
Costs nothing on the wire. Envelopes already carry `ts`, and the SSE keepalive every 15 s
lets a client distinguish a silent agent from a dead connection — so the indicator is
purely client-side and needs no contract change.
Reversibility: cheap. Adding a timeout later is additive and would arrive with evidence
about real turn durations, which is the thing we do not have now.

### 2026-08-08 — D22 Untruncated tool output is a per-session blob behind a session-scoped route
Context: `10-design.md § Failure modes` promised "full output on disk" and `20-contract.md`
exposes `GET /api/tool-output/:callId`, but no entity or file in the data model held it. Two
things were wrong at once: the bytes had no home, and the route that served them sat outside
`/api/sessions/:id`, so the ownership check every other session route performs did not apply.
Chosen: truncate on the way in, before the envelope is constructed, so the envelope in the
ring buffer and the envelope in the spill are the same bytes. Write the untruncated output to
`<storage>/sessions/<sessionId>/tool-output/<callId>` and serve it from a session-scoped
route.
Rejected: the spill holding the full output while the wire carries the truncated one — no new
files, but replay from disk and replay from memory would then return different transcripts,
which falsifies the stated invariant that the ring buffer is a strict suffix of the spill and
does it silently, with none of `replay_gap`'s reporting. Rejected dropping the fetch entirely
— cheapest, removes the unowned route as a side effect, and it makes a large test log
permanently unreadable through the console, which is a supervision tool refusing to show what
happened. Rejected keeping the route keyed on `callId` alone — `callId` is vendor-minted and
opaque, so a route keyed on it is reachable by any authenticated operator who observes or
guesses one, and no care elsewhere compensates.
Consequence: `20-contract.md` must move the route. That is `/contract`'s edit and is recorded
as known drift, not made here.
Reversibility: cheap in storage shape, expensive in the route — moving a public path after
clients depend on it is a breaking change, which is why it is being fixed before any client
exists.

### 2026-08-08 — D23 Orphan reaping reads a server-wide `pids.ndjson` with a reuse guard
Context: `10-design.md § Boot ordering` reaped "recorded child PIDs" and the failure table
named a "PID file", but the persistence summary listed no such file and `Turn.child` was
explicitly in-memory only. S7.5–S7.6 test the behaviour. The durable record the whole step
depends on did not exist in the data model.
Chosen: an append-only `<storage>/pids.ndjson`, one record per spawn carrying pid, session,
turn, start time and process image, tombstoned with `exitedAt` when the child closes. Boot
reaps an entry only when it has no `exitedAt`, its `startedAt` is later than the host's last
boot, and the live process's image matches.
Rejected: the pid inside each session's `meta.json` — no new file, but it turns `meta.json`
into something written on every turn rather than once at create, and it makes reaping depend
on rehydration having parsed that file, so a corrupt `meta.json` orphans its child instead of
merely hiding its transcript. Rejected a Windows job object or Linux process group with no
record at all — structurally the strongest answer, since the operating system reaps for you
and the file disappears, but Node exposes neither natively, so it trades one append-only file
for a native dependency on the exact platform pair the brief requires.
The reuse guard is the point, not a detail: operating systems reuse process ids, so a pid
recorded before a reboot may name something unrelated afterwards. Reaping it blind would kill
an innocent process, potentially a privileged one. An entry that fails any guard condition is
logged and tombstoned rather than killed — a stale record is bookkeeping, a wrong kill is an
incident.
Reversibility: cheap. The file is additive and the guard is local to boot.

### 2026-08-08 — D24 Interrupt is the manager killing the turn's child, and it is an expected end
Context: `POST /api/sessions/:id/interrupt` is in the contract, `interrupt` was an adapter
method, and D21 leans on interrupt being available as the operator's alternative to a
server-side timeout. It had no control-flow path, no failure row, no defined events, and no
answer for Windows, where a child does not receive `SIGINT` the way the Unix path assumes.
Chosen: the session manager owns interrupt semantics; the adapter exposes `kill` as mechanism
only. Terminate-then-force with a grace period, on the process **tree**, since the agent's own
children — a compiler, a test runner — are what hold the workspace open. Pending permissions
resolve with `cancelled_process_exit`. `turn.ended` carries an interrupted stop reason and the
session stays live and idle, so an operator who interrupts is not shown a crash. Interrupt on
a session with no live turn is `{ok: true}` and emits nothing.
Rejected: a graceful protocol-level interrupt over the CLI's own control channel — strictly
better where it exists, preserves the CLI's session coherence, and it is unverified for both
vendors and undefined when the child is blocked awaiting a permission response, which is
exactly the state an operator most wants to escape. It stays available as a pure addition.
Rejected refusing interrupt while a permission request is outstanding — a simpler state
machine that withdraws the escape hatch in the one state where the turn is definitely not
progressing.
Consequence: `20-contract.md` needs a `stopReason` value for an interrupted turn, or the
distinction between "the operator stopped it" and "it died" is unexpressible. Recorded as
known drift.
Note what interrupt deliberately does not do: it does not undo. Files already written stay
written; the pre-turn checkpoint is what returns the workspace, and that is a separate action.
Reversibility: cheap. Adding a graceful path later is additive; the kill remains the fallback.

### 2026-08-08 — D25 Deleting a session removes its storage and never the audit log
Context: `DELETE /api/sessions/:id` is in the contract and appeared nowhere in the design.
What it did to the spill, the shadow git directory and the audit trail was undecided — and
the audit log's server-wide placement was already justified by exactly this case.
Chosen: delete removes `meta.json`, `events.ndjson`, `tool-output/`, `ckpt.git/` and the
registry entry. It is refused with `409 turn_in_flight` while a turn is running. `audit.ndjson`
is untouched.
Rejected: a soft delete that hides the session and keeps the files — recoverable and
audit-safe, and it adds a third lifecycle state beside live and ended plus a cleanup path
someone must write, or the storage root grows without bound, which is the failure D20 was
written to close. Rejected keeping `meta.json` as a tombstone while removing the bulk —
introduces a rehydration case for a session whose transcript is gone, to record something the
audit log already records.
The audit exception is the substance of this decision rather than a caveat: a record an
operator can delete along with the session it describes is not evidence, and that is the
reason `audit.ndjson` was made server-wide in the first place.
Reversibility: cheap toward soft delete, which is additive. Not reversible per session — a
deleted checkpoint history is gone, and the operator should be told so before confirming.

### 2026-08-08 — D26 The audit record is durable before the permission response reaches the child
Context: `10-design.md § Control flow` path 2 wrote the audit record after `adapter.respond`
had already put the `control_response` on the child's stdin. A crash in that window leaves a
tool that ran with nothing recording who authorised it.
Chosen: append the audit record durably, then respond.
Rejected: responding first — the natural order, since the decision is freshest there, and it
saves the operator a millisecond. It also puts the hole precisely where a crash is most
consequential. Rejected a best-effort append with no stated ordering — the same hole, harder
to notice, and it makes the guarantee untestable.
The threat model calls this log the artifact that makes multi-operator use defensible. A log
with a gap exactly where the process died is not that, and the cost of closing it is one
durable append on the approval path, which is already the slowest path in the system because
a human is in it.
Reversibility: cheap, but it is the kind of ordering that is silently lost in a refactor, so
it is stated as an ordering guarantee in the design rather than left to implementation order.

### 2026-08-08 — D27 Codex's approval model was overstated; the asymmetry is one of verification
Context: `10-design.md § The hard problem` presented Codex as setting tool policy only at
launch, with whole-session granularity and no runtime approval concept. `codex/PROFILES.md`,
in this repository, sets `approval_policy = "on-request"` in every profile — so Codex does
prompt at runtime. The claim was wrong on a fact available locally.
Chosen: correct the design's premise. Codex has a runtime approval concept; what is unverified
is whether it is reachable over a programmatic stream rather than only inside its terminal UI,
where a browser console cannot answer it. D5's decision is unchanged — the contract still
models the interactive case and Codex may still under-deliver against it — but the reason is
now "unverified over a programmatic transport", not "does not exist".
Rejected: leaving the earlier wording. It read as a settled capability gap, and a settled gap
is not something anyone runs an experiment against — it would have quietly retired the very
question that could reverse D5.
This is a correction to a premise, not a reversal of a decision. D5 stands. The open question
it depends on is sharpened from "does Codex offer any runtime approval hook" to "is
`on-request` reachable programmatically".
Reversibility: not applicable; this is a factual correction.

### 2026-08-08 — D28 The workspace jail is stated as a start-time control, not a sandbox
Context: `10-design.md § Threat model` listed "a curious operator wandering outside their
workspace" as in scope with "path jail" as the control. The jail decides where a session may
start and pins `cwd` across turns (D4). It does nothing about where the child may reach once
running — the agent has the server user's full filesystem access, so an approved read of a
path outside every root succeeds. The row credited one control with the work of another.
Chosen: split the row into the start-time control and the runtime one, and say outright that
`workspaceRoot` is not a sandbox. Name what actually constrains a running agent per vendor:
for Claude the permission prompt and nothing else, for Codex its own `sandbox_mode` enforced
below us — the one place the vendor asymmetry runs in Codex's favour.
Rejected: leaving the row as written. The brief's first non-goal already concedes that console
access is equivalent to shell access, so the row was not *false* against the brief, and that
is precisely the problem — a table cell reading "path jail" invites a reader to believe the
agent is confined, and the concession is three sections away in a different document. Rejected
adding a real sandbox instead — that is per-session containers, which the brief makes a binding
non-goal.
No behaviour changes. This is a claim being brought back in line with what the system does,
which is why it is logged rather than left as a wording edit: the next reader who assumes
containment will assume it from a document, and the record should show the assumption was
considered and rejected.
Reversibility: not applicable; this is a factual correction.

### 2026-08-08 — D29 Cross-site request forgery is a named adversary, answered by an origin allow-list
Context: the threat model had no row for a malicious page in an operator's browser, and every
auth mode in D3 authenticates by something the browser attaches automatically. A page the
operator visits can issue `POST /api/sessions/:id/message`, or `/permission
{behavior:'allow'}`, at the console's address; the cookie rides along on a cross-origin POST
and the response being unreadable is irrelevant, because the damage is the request. The
*internet* row claimed coverage through the bind check and the auth check, and this path goes
through an authenticated browser and around both. The audit log then records the operator as
the approver, so the evidence misattributes the exploit.
Chosen: every state-changing route — `POST` and `DELETE` under `/api/` — and the WebSocket
handshake require `Origin`, or `Sec-Fetch-Site: same-origin` where sent, to match a configured
allow-list. `403 bad_origin`, refused before identity is resolved. The fallback shared-secret
cookie becomes `SameSite=Strict; HttpOnly; Path=/` as defence in depth. Read routes are not
covered: a cross-origin `GET` cannot be read back by the attacking page, and covering it
breaks a reverse proxy that rewrites `Origin`.
Rejected: relying on `SameSite` alone. It governs *our* cookie, and the primary deployment is
a reverse proxy authenticating by a cookie belonging to Authelia or oauth2-proxy that we do
not set and cannot attribute — the proxy then injects `X-User-Id` onto the forged request
itself. The exposure is not confined to the shared-secret mode, which is the thing that makes
a cookie attribute the wrong control.
Rejected: a double-submit CSRF token. The textbook answer, and it buys nothing the origin
check does not, at the cost of token issuance, rotation, and a WebSocket handshake path that
has to carry it too.
Rejected: bearer-token-only auth, no cookies. Removes the attack class by construction, since
browsers never attach an `Authorization` header cross-origin. It costs the bare-LAN fallback
mode D3 assumes and complicates the Open WebUI proxy contract D11 consumes, both of which are
cookie-shaped.
The WebSocket case needs the check at the handshake rather than at first-message auth:
browsers do not apply the same-origin policy to WebSocket connections, `Origin` is the only
signal the handshake carries, and deferring it means the connection is already open and driven
by whoever opened it.
Reversibility: cheap. It is a property of the identity edge, designed once. Expensive later
only in that it is invisible until exploited.

### 2026-08-08 — D30 The workspace busy check tests overlap, not path equality
Context: D19 admits one live session per workspace and the check compared resolved paths for
equality. A session at `D:\work\repo` and one at `D:\work\repo\packages\api` have unequal
resolved paths, so both are admitted — and the second is inside the first's work-tree, so
session A's `add -A` checkpoints B's files and A's restore silently reverts B's work. That is
the exact hazard D19 exists to close, under a design that asserts nothing downstream needs to
consider a shared workspace because there cannot be one.
Chosen: refuse when the resolved path equals, is an ancestor of, or is a descendant of any
live session's `cwd`. One predicate in the create path. The refusal names the holding path and
operator.
Rejected: pathspec-scoping each session's checkpoints so overlapping sessions cannot overwrite
each other. It preserves the monorepo case, and it makes restore partial by design and
withdraws D19's guarantee — checkpoints, restore and reaping each have to re-reason about
sharing, which is precisely the cost D19 paid a refusal to avoid.
Rejected: accepting the nesting hazard with a documented risk. D19 already rejected the weaker
form of this (a warning banner) on the grounds that the hazard is silent data loss and a
banner is not a lock.
The cost is real and is stated in the design rather than discovered: two operators cannot take
different packages of one monorepo. That is the price of the guarantee, and D19's own rejected
alternatives show the alternative prices.
Reversibility: cheap while it is one predicate. Expensive after implementation, because
everything downstream was built on the guarantee holding.

### 2026-08-08 — D31 Restore removes files created after the target, behind a safety checkpoint
Context: `git checkout <sha> -- .` writes the target tree over the work-tree and deletes
nothing absent from it. Creating files is the common case for a coding agent, so restoring to
a checkpoint before turn N reverted modified files and left every file turn N created —
including the wrong migration or injected script the rollback was invoked to remove — while
the console reported success. Brief DoD #6 promises the workspace rolled back to its state
before an earlier message.
Chosen: restore is three operations — `commit --allow-empty -m "before restore to <sha>"`,
then `checkout <sha> -- .`, then `clean -fd`.
Rejected: `checkout` alone, as the prior art does it. It is half a rollback reported as a
whole one, and the half it omits is the half most rollbacks are for.
Rejected: `clean` without the preceding safety commit. One fewer commit on the restore path,
and an operator who restores to the wrong sha loses everything since it with nothing in the
console offering a way back. The safety checkpoint makes the mistake itself recoverable.
Rejected: narrowing DoD #6 to match the weaker behaviour. That is a brief change, and it guts
the feature rather than fixing it.
Two properties make `clean` safe enough not to need a warning dialog, and both are stated in
the design: the safety checkpoint precedes it, and `add -A` reads the workspace's own
`.gitignore` so ignored paths never enter the shadow repo — `clean -fd` without `-x` leaves
exactly that same set alone. The pair is symmetric: clean can only remove what a checkpoint
could have restored, so a restore never forces a dependency reinstall.
Reversibility: cheap; restore semantics are contained in the checkpoints module and no code
exists. Expensive later because operators will have relied on restores that were silently
partial, with no record distinguishing them.

### 2026-08-08 — D32 A guard is claimed in the same synchronous block that tests it
Context: the concurrency section argued that no lock is needed because Node is
single-threaded and `emit` is the serialisation point. That argument covers `emit`, which is
synchronous. None of the request handlers are. As written, `POST /message` reads
`check turn == null` → `await checkpoints.commit` (a git subprocess, seconds on a large tree)
→ `set turn`, so two requests in one tick both pass the check and two children spawn for one
session. `POST /sessions` has the identical shape around the busy check and `await mkdir`,
defeating D19 and D30. The races table named "manager turn state" as the enforcer of both,
which described an intention rather than a mechanism.
Chosen: state one rule — no `await` may sit between a check and the mutation it protects — and
apply it in both paths. The turn slot is occupied by a `Turn` in phase `starting` before the
checkpoint is awaited; the workspace claim is registered before storage is touched; both are
released on failure.
Rejected: a per-session async mutex. It solves the same problem and makes "there is no mutex
anywhere in this design" false, replacing one stated ordering with a primitive that has to be
acquired correctly in five call sites.
The rule keeps the ordering guarantee that a turn's checkpoint precedes its `turn.started`,
because claiming the slot and emitting the event are deliberately separate: `turn.started`
still follows the commit.
Reversibility: cheap — it is an ordering statement in two paths. Expensive later because the
failure is probabilistic and every downstream guarantee assumes it never happens.

### 2026-08-08 — D33 The pending delete precedes the audit append, and a failed append denies
Context: D26 fixed that the audit record is durable before the response reaches the child, and
left two things unstated. Where the `pending` map delete sits relative to that append decides
whether two clients answering one permission produce two `control_response`s on one child's
stdin. And what happens when the append itself fails — disk full on `audit.ndjson` — was not
chosen at all: fail-open sends an unaudited allow, fail-closed wedges a turn whose child is
blocked forever.
Chosen: `pending.delete(requestId)` synchronously at lookup, before anything is awaited; then
the durable append; then the response. On append failure, send `control_response
{behavior:'deny'}` carrying the storage failure as its reason, emit `permission.resolved` with
that denial and a `session.notice / error`.
Rejected: appending before the delete. Both requests then pass the lookup during the first
one's append — two audit records, two responses, CLI behaviour undefined.
Rejected: fail-open on an append failure. A tool runs with nothing recording who authorised
it, which is the hole D26 exists to close, arriving by a different door.
Rejected: wedging the turn on an append failure. It is fail-closed in the letter and it strands
the child in the one state an operator most wants to escape.
Delete-first is safe in the crash case precisely because of the ordering: a crash between the
delete and the append loses the record of a decision that never reached the child, so nothing
ran and nothing is unaccounted for. The reverse order puts the same window somewhere it costs
evidence. Denial is the only decision safe to make without being able to record it.
Reversibility: cheap — one stated ordering and one stated failure rule. Both failure shapes
are silent, which is why they are stated rather than left to implementation order.

### 2026-08-08 — D34 cliSessionId is last-write-wins from every system/init
Context: the data model declared `cliSessionId` write-once-then-stable, and the Claude CLI is
documented to mint a new session id on each `--resume`. Under write-once the server keeps
resuming turns 3, 4 and onward with the id turn 1 reported: depending on CLI version that
forks stale context — turn 3 resuming a conversation that never saw turn 2 — or fails. Also
unhandled: a first child that dies before `system/init` leaves the cell null, and what turn 2
does with a null resume id was unstated.
Chosen: the manager stores the id from every `system/init` and resumes with the most recent.
Where the cell is null, the next turn spawns without `--resume` and emits `session.notice /
warn` saying the conversation context was not carried forward.
Rejected: keeping write-once and pinning the first id. It is the current text, and it silently
loses conversation memory mid-session while the transcript renders as continuous.
Rejected: refusing a turn when `cliSessionId` is null after a first turn. It wedges a session
over a recoverable condition.
The notice is the substance, not a nicety: D20 rejected full resumption specifically because
it fails by starting a fresh conversation the operator believes is continuous. That same
failure was re-entering mid-session through a null resume id, unannounced.
Reversibility: cheap — one mutability cell and one stated rule. Expensive later because
`meta.json`'s shape, the adapter contract and the resume path all encode the stability
assumption.

### 2026-08-08 — D35 Standing approvals are held by this server, not handed to the CLI
Context: the prior art expresses "always allow" by returning `updatedPermissions` on an allow,
and the CLI persists it in its own settings — workspace- or user-scoped, outside this server's
storage. Every later tool call matching that grant then runs without emitting `can_use_tool`
at all: no `permission.request`, no `permission.resolved`, no audit append, in this session or
in a later session on the same workspace owned by a different operator. Brief DoD #7 promises
an audit record of *every* tool approval.
Chosen: do not forward `updatedPermissions`. The manager records the standing rule in its own
session-scoped state and auto-answers matching requests itself, emitting the full
`permission.request` / `permission.resolved` pair with `scope: 'standing'` and appending an
audit record every time.
Rejected: forwarding it and accepting the gap, with DoD #7 narrowed from "every". Cheapest,
and it makes the log show one grant then silence while tools execute for other operators under
a scope decision the server can neither enumerate nor revoke. Retroactive attribution of
unaudited runs is impossible, and the multi-operator defensibility claim rests on this log.
Rejected: dropping "always allow" from the first cut so every call is prompted. The most
defensible option and the one that makes an `npm run *` loop unusable, which is how operators
end up wanting `--dangerously-skip-permissions`.
The cost is that the matching grammar becomes ours. `permission_suggestions` is still where
the shape comes from — the CLI proposing `npm run *` from a concrete command is the useful
part — but we evaluate it, so open question 8 stops being a look-before-inventing note and
becomes blocking for the slice that ships standing approvals.
Reversibility: cheap to decide now. Expensive later in the one direction that matters: unaudited
runs cannot be attributed after the fact.

### 2026-08-08 — D36 An operator can end a session
Context: `state` is `'live' | 'ended'` and one-way, and the only transitions into `ended` were
a server restart (D20) and nothing else. An operator finishing work had two options: leave the
session live, holding its workspace busy under D19 against every colleague, or delete it,
which destroys the transcript, the checkpoints and the tool output. "Free the workspace" and
"keep the record" were mutually exclusive.
Chosen: `POST /api/sessions/:id/end`. Refused `409 turn_in_flight` while a turn runs; sets
`state = 'ended'` and `endedAt`, emits `session.ended`, rewrites `meta.json`, releases the
workspace claim. Everything on disk survives.
Rejected: an idle timeout that ends a session automatically. D21 removed every server-side
timer deliberately, and a session with no turn running is indistinguishable from one whose
operator stepped away mid-task.
Rejected: leaving it, on the grounds that delete already frees the workspace. The workaround
operators would find is the record-destruction path, which is exactly the outcome D25's audit
carve-out and D20's rehydration were written to avoid.
Reversibility: cheap. The state machine already had both states; what was missing was one
transition.

### 2026-08-08 — D37 meta.json has a write protocol, and "durable" means fsync
Context: `lastSeq` was declared persisted and changes on every emit, and no write protocol was
stated. Either `meta.json` was rewritten per event — thousands of full-file rewrites per turn,
with no atomic-rename discipline, so a crash mid-rewrite corrupts the one file rehydration
needs — or it was written lazily, leaving `lastSeq` behind the spill's real tail so a
rehydrated session mis-bounds its own replay. Separately, D26 rests on the word *durable*,
which appeared nowhere with a definition: an append that reached the OS survives a process
crash but not a host crash.
Chosen: `meta.json` is written temp-then-atomic-rename, never in place, on exactly three
occasions — create, a `state` transition, and a change to `cliSessionId`. Never per event.
`lastSeq` is derived at boot from the tail of `events.ndjson`; the copy in `meta.json` is a
diagnostic hint and the spill wins where they disagree. *Durable* means fsync of the data and,
for a rename, the containing directory.
Rejected: a per-event rewrite with atomic rename. Correct and unaffordable — a rename and an
fsync per envelope, to keep a number that can be recovered by reading the file that already
holds the answer.
Rejected: leaving `lastSeq` authoritative in `meta.json` and writing it lazily. The cheap
version of the same thing, with a self-inflicted inconsistency between the bookkeeping and the
data.
Ordinary spill appends are deliberately not fsync'd per line; the cost is unjustifiable at
event rates and the loss window is bounded by OS writeback. Stating that difference is the
point, so that one guarantee is not later read as the other.
Reversibility: cheap now — a write-protocol paragraph. Expensive later because every store
consumer will have encoded an assumption about it.

### 2026-08-08 — D38 Reaping kills the process tree, and the spawn window is accepted
Context: `pids.ndjson` records the CLI's pid, and boot reaped that pid. What holds a workspace
open is what the CLI spawned — a compiler, a test runner — which the interrupt section already
identifies. Killing the CLI alone orphans those to the OS: the rehydrated session is ended so
the workspace is not busy, a new session starts, and its checkpoint restore fails on Windows
because a process nothing tracks holds a handle. That is the exact platform failure D16's
per-turn child claims to make impossible by construction.
Chosen: reap the tree with the platform's own mechanism — `taskkill /PID <pid> /T /F` on
Windows, which resolves the tree from the live process table at kill time; `detached: true` at
spawn plus `process.kill(-pgid)` on POSIX, with `pgid` added to the process record. The reuse
guard is unchanged and gates the group leader. This is the same mechanism interrupt already
specifies, now used in both places.
Rejected: continuing to kill the recorded pid alone. It is the current text and it leaves
behind precisely the processes that matter.
Rejected: a Job Object to make the tree a first-class handle. D23 rejected it for a dependency
Node does not expose natively on the required platform pair, and that reasoning is unchanged —
but note the rejection now costs less than it appeared to, because `taskkill /T` and process
groups are built in and reach the same processes.
The window between `spawn` returning and the `pids.ndjson` append landing is stated as an
accepted exposure rather than designed around: a crash inside it leaves a child no record
names, which boot cannot reap at all. Closing it needs a handle that exists before the process
does, which is the Job Object above. The window is short and its consequence is one orphan an
operator kills by hand.
Reversibility: cheap now, while the record schema and kill discipline are on paper. Expensive
after the store schema ships, because it touches spawn, record and boot together.

### 2026-08-08 — D39 Boot closes a turn the crash left open
Context: a server dying between `turn.started` and `turn.ended` — every crash during a turn —
leaves the spill ending on an unpaired `turn.started`, possibly an unanswered
`permission.request`, possibly a `tool.call` with no result. *Ordering guarantees* states
without qualification that `turn.ended` follows all of a turn's events and that a
`permission.request` is answered by exactly one `permission.resolved`. D20 made the spill the
read path, so a rehydrated session serves that transcript to a client told it could rely on
both.
Chosen: during rehydration, for a session whose spill ends unterminated, append a
`permission.resolved` carrying `cancelled_process_exit` for each outstanding request, then a
`turn.ended` with a `server_restart` stop reason, at the next `seq` and durable before the
session is served. Step 3 of boot, before listening.
Rejected: qualifying the ordering guarantees and letting clients handle an unterminated turn.
It pushes the case onto every renderer and every replay consumer permanently, and the failure
without it is a client rendering an ended session as eternally mid-turn, or crashing on an
invariant it was told was guaranteed.
Rejected: reconstructing the closure at read time rather than writing it. It keeps the spill
pristine and means every reader implements the same repair, which is the same defect one layer
down.
Reversibility: cheap — one boot step. It needs a second `stopReason` value on the contract, and
that is recorded as drift alongside D24's.

### 2026-08-08 — D40 The spill serves replay for live sessions, not only ended ones
Context: the ring holds 2000 envelopes and the spill read path was specified for ended
sessions. A turn emitting more than 2000 envelopes — a test run streaming tool results does it
routinely — while an operator's laptop is asleep produces a reconnect whose `Last-Event-ID`
predates the ring, answered with `replay_gap` and a client told to refetch from a read path
that does not exist for a live session. Brief DoD #5 is "refresh the page mid-turn and lose
nothing", and mid-turn is exactly where it failed. This was carried as an optional
simplification in open questions; it was a brief conflict.
Chosen: a too-old `Last-Event-ID` is served from `events.ndjson` for live and ended sessions
alike, then the client joins the live stream. `replay_gap` survives only where the spill
genuinely cannot serve — writes have failed (D41), or the tail is torn.
Rejected: growing the ring. It moves the threshold and bounds nothing; the failing case is a
single turn, so any fixed size has a turn that outruns it.
Rejected: leaving it and accepting the DoD failure. The events are permanently unrenderable
for the duration of the turn that produced them, which is the whole window an operator is
watching.
The machinery is D20's spill reader, already required; the change is which sessions may use
it. It costs S3.3, whose assertion becomes "a gap is reported only when the spill cannot
serve" — a slice change, recorded as one.
Reversibility: cheap.

### 2026-08-08 — D41 A spill write failure ends the session
Context: the failure table said disk full on the spill was non-fatal and live streaming
continues. The ring then holds envelopes the spill never will, so replay-from-memory and
replay-from-disk diverge — the precise failure D22 calls the same as a gap with none of the
reporting, introduced here by the design's own error handling. D40 then makes it worse by
serving reads from the diverged file.
Chosen: a spill write failure is fatal to that session. The live turn is interrupted through
the D24 path with a `storage_failure` stop reason, the session is marked ended, and no new
turn is accepted. The transcript ends at the last durable event and says so.
Rejected: continuing to stream and marking the ring divergent, refusing replay from that point.
It preserves the live view for currently-connected clients and sacrifices the invariant that
makes the two tiers interchangeable, which D40 now depends on.
Rejected: keeping it non-fatal as written. A post-restart transcript missing events an operator
watched live, with no marker at the seam — invisible until a dispute needs the transcript.
Reversibility: cheap — one stated rule for what the ring does when the spill is failing.

### 2026-08-08 — D42 A failed pre-turn checkpoint warns; the turn proceeds
Context: `checkpoints.commit` runs before every turn and the failure table had a row only for
`ckpt.git` init failing at create. A crash mid-commit leaves `ckpt.git/index.lock`, which git
does not clean up, so every subsequent pre-turn commit fails. Nothing said what that does to
the message path — turn refused, proceeds checkpointless with a notice, or proceeds silently.
Chosen: `session.notice / warn` naming the cause, and the turn proceeds with no restore point.
The client marks that turn as not rollback-able, and the notice names `ckpt.git/index.lock`
where that is the cause, because the operator cannot clear it from the console and needs to
know what to clear.
Rejected: refusing the turn with a `checkpoint_failed` error. It protects DoD #6 and wedges the
session on a stale lock file, with every message refused and no in-console remedy.
Rejected: proceeding silently. It is the failure the row exists to prevent — turns running
without the rollback point DoD #6 depends on, with nothing saying so.
This follows the precedent the init-failure row already sets: checkpoints are best-effort and
DoD #6 degrades visibly rather than blocking work.
Reversibility: cheap — one failure-table row.

### 2026-08-08 — D43 The client's rendering rules are part of the design
Context: the design calls the prior art's CSP disqualifying in a browser app that renders model
output, and then specified no CSP, no sanitisation rule and no content-type discipline for its
own client. The client renders model output, tool results, stderr and fetched untruncated
blobs — all attacker-influenceable through prompt injection, which is the threat model's own
confused-agent row. The blob route in particular could serve raw HTML that renders in the
console's origin.
Chosen: state the rules in *Security controls*. A strict CSP with no `unsafe-inline` and no
`unsafe-eval`; no `innerHTML` for anything agent-derived, text nodes only, with diffs and code
built into elements the client constructs; and the tool-output route serving `text/plain;
charset=utf-8` with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`.
Rejected: leaving it to whoever writes the client. The consequence is specific rather than
theoretical — script executing in the console's origin can issue exactly the POSTs the operator
can, from a page D29's origin check trusts — and it is an XSS audit of a finished renderer
instead of a paragraph.
Rejected: sanitising agent output rather than never parsing it as markup. Sanitisers are a
denylist maintained against browser parsing quirks; not parsing is a property.
Reversibility: cheap now, as a stated rule. Expensive later, as a retrofit through a renderer
built without it.

### 2026-08-08 — D44 The event vocabulary is closed, and turn-scoped payloads carry `turnId`
Context: `/contract` had to express the ten amendments `10-design.md § Open questions` item 9
assigns to it. Three of the contract's fields were bare `string` — `TurnEnded.stopReason`,
`ErrorEvent.kind`, and the notice text — which cannot be narrowed by a client and, worse,
invited an adapter to pass a vendor's own stop reason through unchanged. That is a vendor
string above the adapter layer arriving by the back door. Separately, only `MessageDelta`
carried `turnId`, while the ordering rules tell a client to pick a rendering "by `turnId`"
and D22's blob route requires `turnId` from the `tool.result` envelope that links to it.
Chosen: `TurnStopReason`, `ErrorEventKind`, `SessionNoticeCode`, `ResolvedScope`,
`PermissionResolvedReason` and `SessionEndReason` are closed unions enumerated from the
design's failure tables and decision records; every turn-scoped payload carries `turnId`.
Rejected: leaving them open strings — the client then branches on vendor text, and the two
values D24, D39 and D41 need would be indistinguishable from a crash at the renderer.
Rejected: an escape hatch value such as `other` — it is the open string again, with a
narrower spelling.
Reversibility: cheap. Adding a union member is a contract amendment and a renderer case;
nothing persisted encodes the closure.

### 2026-08-08 — D45 `session.exit` becomes `session.ended`, and `state` lives on the summary
Context: amendment 1 of item 9. Under D16 a normal turn ends the child, so a contract-obedient
client tore down the session view after every successful turn. Amendment 3 asked for `state`
on both `SessionSummary` and `session.started`.
Chosen: delete `session.exit`; turn-process exit is `turn.ended` with a `TurnStopReason`.
Add `session.ended { reason }` covering the three ways into `ended` — D36 operator, D20
restart, D41 storage failure. `state` goes on **both** `SessionSummary` and `session.started`,
as amendment 3 asks.
Known and retained: `SessionStarted.state` is the state at emission, and `session.started` is
emitted once at creation and replayed forever — so the field is the constant `'live'` in every
session that ever existed, including ended ones. The contract proposed putting `state` on the
summary alone for that reason; the owner chose the amendment as written, and the staleness is
recorded in `20-contract.md § Rules the renderer may rely on` instead of being designed away.
The authority is `SessionSummary.state`, or a `session.ended` later in the stream; a renderer
that reads the replayed field will show an enabled compose box for an ended session.
Rejected: deriving `state` entirely from the stream, with boot appending
`session.ended { reason: 'server_restart' }` — extends D39's boot writes, and the
storage-failure path cannot append its own ending, so one of the three ways into `ended` would
stay invisible to the stream.
Rejected: keeping `session.exit` alongside, with a flag distinguishing the two — two names for
one boundary, and the client must get the flag right to avoid the original bug.
Reversibility: cheap, before any client exists.

### 2026-08-08 — D46 The adapter's outbound channel is a notification union, not `emit`
Context: the design gives adapters exactly one outbound channel (`emit`) and no dependency on
`store`, and simultaneously requires three facts to reach the manager that are not normalised
events: the `cliSessionId` from every `system/init` (D34, since the manager stores it and
supplies `--resume`), the spawned child's pid, pgid and image (D23, since the manager appends
`pids.ndjson`), and the child's exit. With `emit` carrying envelopes only, there is no
signature for any of them, and the first implementer either adds an adapter→store edge the
module graph forbids or smuggles the values through `raw`.
Chosen: the adapter is given `notify(n: AdapterNotification)`, a four-member union — `event`,
`cli-session`, `spawned`, `exited`. The adapter emits payloads without `seq`, `sessionId`, `ts`
or `turnId`; the manager assigns all four. `spawn` is internal to `send`, matching *Control
flow § 2* where the child is spawned inside the turn rather than at session creation, and the
module table's four-word `spawn, send, respond, kill` is read as the loose summary of the two.
Rejected: a second callback per fact — three parameters where one union does, and each new
fact is a signature change at every call site.
Rejected: the adapter writing `pids.ndjson` itself — makes it non-leaf and puts a storage
dependency inside vendor code, which is what keeps a second vendor from becoming a second
architecture.
Reversibility: cheap. It is an internal interface with two implementations.

### 2026-08-08 — D47 `attachments` is removed from `POST /message`
Context: amendment 6. The route declared `attachments?: Attachment[]` against a type that was
never defined, and no part of the design describes attachment handling — not the transport to
the CLI, not storage, not the byte cap, not what an approved file reaching an agent means for
the audit record.
Chosen: remove the field; record the gap under `20-contract.md § Unresolved`.
Rejected: defining `Attachment` here — it is a feature, not a type, and inventing one at the
contract stage commits the implementer to a transport nobody chose.
Rejected: leaving the field with an undefined type — a contract that does not compile is not a
constraint.
Reversibility: cheap. Adding a request field is backward-compatible.

### 2026-08-08 — D48 Fallible boundaries return `Result`, never a thrown error
Context: the contract must name an error type per public signature, and TypeScript has no
`throws` clause — a thrown error is invisible in a signature and degenerates to `unknown` at
the catch site, which is how string errors and bare exceptions get in.
Chosen: `Result<T, E>` on every fallible signature crossing a module boundary, with a
discriminated union error type per module and an explicit mapping from each variant to its HTTP
code, its retryability and what the caller does.
Rejected: typed exception classes — still invisible in the signature, and `instanceof` across
module boundaries is the check nobody writes.
Rejected: `Result` everywhere including internals — noise on paths where nothing can fail.
Reversibility: expensive. It shapes every call site, which is the argument for settling it in
the contract rather than in the third slice.

### 2026-08-08 — D49 `meta.json` carries `schemaVersion`, and an unknown one is a corrupt file
Context: `meta.json` is the file rehydration depends on and the design gives it a write
protocol but no version. The contract must state a migration story per persisted file, and
there is no story to state without a discriminator.
Chosen: `{ schemaVersion: 1, session: SessionRecord }`. An unknown version is handled exactly as
a parse failure already is — skip the session, log it, leave its files untouched, never abort
boot. Append-only files carry no per-line version: readers ignore unknown fields, and a field
removed or retyped is a `schemaVersion` bump plus a refusal to rehydrate older sessions.
Rejected: no version — the first schema change then reads old data as though it were new, which
is silent wrong state in the one file that decides what a session is.
Rejected: a version per NDJSON line — a discriminator on every event to describe a shape that
changes once a year.
Reversibility: cheap now; the whole point is that it is expensive to add after data exists.

### 2026-08-08 — D50 There is no per-operator vendor authorisation
Context: the contract carried `403 if the caller may not use that vendor` on `POST /sessions`,
and a `403 forbidden` code for "authenticated, not the session's owner" — which the same
document contradicts two paragraphs later by returning `404` so that session existence cannot
be probed.
Chosen: remove both. Vendor choice is open to any authenticated operator, and non-ownership is
always `404 no_such_session`.
Rejected: keeping the vendor check — D3 chose delegated identity precisely so that no account
state lives here, and *Data model § Operator* is `{ id }`, not persisted. There is nowhere to
store a per-operator grant, so the check could only ever have been a constant.
Rejected: keeping `403 forbidden` as a reserved code — a code no path emits is a code someone
later emits by accident, defeating the probe defence.
Reversibility: cheap for the vendor check, which would arrive with whatever introduces operator
records. The `404` is load-bearing and should not be reversed.

### 2026-08-08 — D51 The imported console prototype is a design input, not an authority
Context: a Claude Design prototype (`design/prototype/`) was imported and initially declared a
source of truth. Read against the brief, it describes a different product: an agent fleet
console with payroll, performance reviews and an org chart, and none of the brief's seven
definition-of-done items has a screen. Granting it authority would have overturned two binding
non-goals without either being examined.
Chosen: the prototype is a committed snapshot and a design input. `AGENTS.md § Source of truth`
is unchanged and does not list it. Where it and the design disagree, the disagreement is
adjudicated screen by screen — D52 to D58 are that adjudication.
Rejected: normative standing — it would have silently overridden `Multi-agent orchestration`
and `Hosting the model`, which is the reconciliation the source-of-truth rule exists to stop.
Rejected: discarding it — half its surface maps onto real slices, and the visual language is
work that would be redone from nothing.
Reversibility: cheap. Nothing depends on the snapshot; it can be re-imported or dropped.

### 2026-08-08 — D52 Operator-driven assignment is in scope; agent-spawned sub-agents are not
Context: the brief's non-goal reads "Multi-agent orchestration. One session, one agent process.
Fan-out is not in scope." The prototype's backlog drags a ticket onto an agent, and its org
chart shows sub-agents spawned by a parent. Multiple concurrent sessions were never at issue —
`10-design.md § What is actually concurrent` already lists them, and `GET /api/sessions` exists.
Chosen: the non-goal bans *automated* routing. An operator dragging work onto a session is an
operator action and stays. Agent-spawned sub-agents are cut: `POST /api/sessions` is an operator
call, and a session started by a child has no caller identity, so the audit record required by
definition-of-done item 7 has no answer for who approved it.
Rejected: cutting the backlog too — it discards a gesture the human drives, on a reading of the
non-goal that the design's own session list already contradicts.
Rejected: keeping sub-agents — the audit-identity problem is unsolved, not merely unwritten.
Reversibility: expensive. The backlog needs a persisted queue, which storage has no home for
today; see the open item on what a dragged ticket becomes.

### 2026-08-08 — D53 Payroll is retained in full, and the model-hosting non-goal narrows
Context: the prototype's payroll screen shows weekly token burn, budget remaining, cost per
shipped PR and paid idle time. The `Hosting the model` non-goal states that no inference happens
here and no keys are held.
Chosen: keep the screen whole. Three of the four tiles need no credential — token counts already
arrive in the CLI stream the design parses, budgets are an operator-set `config` value, and idle
time is derivable from session state transitions already recorded. The non-goal narrows to say
that no inference is performed and no vendor credential is held, without claiming that reported
usage is invisible.
Rejected: cutting the screen — the owner ruled the full screen in after the conflict was stated.
Rejected: a reduced usage-only panel — same ruling.
Reversibility: expensive for cost per shipped PR, which has no source and is left open. Cheap
for the other three, which are views over data already written.

### 2026-08-08 — D54 The employee record keeps performance reviews and PIP status
Context: the prototype's employee record mixes documented surfaces — session identity,
permissions scope, the activity file — with a Q3 performance review, a rating scale, PIP status,
a trailing-30-day metrics grid and a weekly timecard that no document mentions.
Chosen: keep the whole screen. Reviews and PIP become first-class, which adds a persisted review
entity with authorship and draft state, and the rating scale as a contract enum.
Rejected: keeping metrics and the timecard while cutting the review — the aggregations are free
and the review is net-new scope serving no stated operator outcome, but the owner ruled it in.
Rejected: stripping to documented surfaces only.
Reversibility: expensive. A persisted entity with authorship is not removed once written to.

### 2026-08-08 — D55 Hiring, onboarding and incidents become real surfaces
Context: none of the three has a counterpart in the brief, the contract or the eleven slices.
Incidents is close to the audit record in a costume; hiring and onboarding are provisioning
workflow around what `POST /api/sessions` already does in one step.
Chosen: keep all three. Hiring becomes the session-creation flow with a requisition and an
approval state, onboarding a per-session first-run checklist, incidents the audit view.
Rejected: incidents only — the cheapest option, and the one that adds no entity.
Rejected: hiring as a reskin of session creation with no requisition.
Reversibility: expensive. The candidate entity and the requisition approval state are both new
persisted shapes.

### 2026-08-08 — D56 Termination and permissions scope are skins over S5 and S10
Context: the prototype's termination screen maps onto S5's `DELETE /api/sessions/:id` but adds
severance, a context purge, an exit-interview transcript stated never to be read, and a Clone
action. Its permissions scope shows standing grants, which is S10's remembered decisions rather
than S4's per-call approve and deny.
Chosen: adopt both as presentation over existing slices. Severance renders real session state.
`GRANTED / REQUEST / DENIED` is the remembered-decision list, where a `REQUEST` row is a rule
that still prompts. Clone is cut — duplicating a session means forking CLI conversation state,
which `Replacing the agent's own context management` puts out of reach. The exit interview is
cut as fiction with no data behind it.
Rejected: Clone as a real feature — it needs the context-management non-goal reopened before it
can even be specified.
Rejected: the exit interview as a final turn — implementable, but it stores a reply the screen
itself says nobody reads.
Reversibility: cheap. Both are presentation over endpoints that already exist.

### 2026-08-08 — D57 The phone gets the prototype's shell plus the approval screen it omits
Context: the brief makes mobile-first a non-goal but names approving a tool call from a phone as
a real use, and S3 exists for it. The prototype draws three phone screens — backlog, staff,
termination — and no approval screen.
Chosen: take the phone chrome as S3's visual spec, and specify the approve and deny screen the
prototype does not draw, since that is S3's reason to exist.
Rejected: building the three drawn screens and deferring approval — S3 would close without
delivering the phone's stated purpose.
Rejected: deferring mobile entirely.
Reversibility: cheap. No document changes; S3 gains a reference and one screen.

### 2026-08-08 — D58 The four-theme switcher ships as a product feature
Context: the prototype carries four complete visual systems — sterile enterprise, black-ops
terminal, 1980s memo, modern SaaS — behind a runtime switcher, so "match the design" had no
single referent.
Chosen: all four ship, operator-selectable. This makes a design-token layer mandatory rather
than optional, and adds a persisted per-operator preference.
Rejected: picking one and discarding the rest — the cheapest option, and the recommendation;
the owner ruled the switcher in as a feature.
Rejected: a light and dark pair.
Reversibility: expensive in practice. Every component must be built four ways from the start, and
a component added later against one palette drifts the set without anything detecting it.

## Open

Staging only. Once an item becomes an issue it leaves this list.

- **"Fan-out" means two different things.** `00-brief.md` uses it for distributing work across
  agents; `10-design.md` uses it for one-to-many delivery of envelopes to several subscribers of
  one session (D18), which is in scope and built. One term, two meanings, two documents.
- **Employment status and process state are one field in the prototype.** Its vocabulary
  (`ON SHIFT / BLOCKED / IDLE / ON PIP / PROBATION / CLOCKED OUT`) overlaps `SessionSummary.state`
  without matching it. They are different concepts and need separate fields.
- **A dragged ticket has no defined effect.** D52 keeps operator-driven assignment without saying
  whether dropping a ticket on a session sends it as a message or labels the session alongside
  one. Those are different features, and the queue has no home in storage either way.
- **Cost per shipped PR has no source.** D53 keeps the tile; the server has no "shipped PR"
  signal and no way to get one without reaching outside itself. Deferred to `/contract`.
- **D58's persisted theme preference contradicts the `Operator` entity.** `10-design.md § Data
  model § Operator` states that an operator is `{ id }`, **not persisted**, with no profile and
  no preferences, because D3 chose delegated identity so that no account state lives here. A
  per-operator theme choice is account state. One of the two gives, and which one is an owner
  decision rather than an editorial fix — carried into the brief amendment.
- **`10-design.md` is stale against D46 and D49.** The module-boundaries section still hands
  adapters an `emit` callback, which D46 replaced with a notification union; and neither the
  `meta.json` write protocol nor the corrupt-`meta.json` failure row mentions the
  `schemaVersion` D49 added or the unknown-version case it defines as corrupt. Both are drift
  from the contract derivation, not new decisions. The design outranks the contract, so which
  side is wrong is a ruling, not a merge — the working read is that the design is stale in both.
