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
**Superseded in its mechanism by D112** — the goal below stands and the middle operation does
not. `checkout <sha> -- .` cannot remove a file created after the target, because this entry's
own safety commit runs `add -A` and tracks it first; `read-tree --reset -u <sha>` replaces it.
The safety checkpoint and the `.gitignore` symmetry argued for here are unchanged.

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

### 2026-08-08 — D59 The definition of done becomes two tiers
Context: D53 to D55 and D58 admitted payroll, performance reviews and PIP, hiring, onboarding,
incidents and a four-theme switcher. The definition of done was still the seven console items,
so the brief asserted this project is finished at a point where roughly half the admitted scope
does not exist.
Chosen: two tiers. Tier one is the seven console items and is finishable on its own; tier two
carries the admitted surfaces as items 8 to 12, each stated as an operator outcome rather than a
screen. Both tiers are binding.
Rejected: one flat list of twelve — three of the four admitting decisions record expensive
reversibility, and folding them in leaves no point at which anything is honestly finished.
Rejected: leaving the definition at seven and holding the surfaces as scope only — the
completion bar would permanently describe a smaller product than the one being built, which is
the drift the source-of-truth rule exists to catch.
Rejected: reopening D54 and D55 — signed off, and re-running the prototype adjudication to reach
the same place buys nothing.
Reversibility: cheap. Moving an item between tiers is an edit.

### 2026-08-08 — D60 The theme preference is held by the browser, not by this server
Context: D58 ships four operator-selectable themes with a persisted per-operator preference.
`10-design.md § Data model § Operator` states an operator is `{ id }`, **not persisted**, with no
profile and no preferences, because D3 chose delegated identity so that no account state lives
here. A stored preference is account state.
Chosen: the client holds the choice; it never reaches the server. `Operator` stays `{ id }`, and
D3 and D58 both stand. The known cost is retained rather than solved: the theme follows the
browser, not the person, so a new device or profile starts on the default and operators sharing
a browser profile share a theme.
Rejected: persisting an `Operator` record with preferences — the first account state on this
server, reopening D3, and forcing an answer to what the record means once the upstream identity
provider renames or removes that person. A persisted entity is not un-written.
Rejected: one theme per deployment, set in configuration — no account state anywhere, but it
reduces D58's product feature to an administrator setting.
Reversibility: cheap. Making the choice travel later adds storage; it undoes nothing.

### 2026-08-08 — D61 The model-hosting non-goal says reported usage stays visible
Context: D53 records this non-goal narrowing so payroll's token burn and budget tiles are
legitimate. Read literally, the previous wording — "No API keys are held by this server, no
inference happens here" — never claimed usage was invisible. This was a misreading risk, not a
contradiction.
Chosen: state it anyway. No inference is performed and no vendor credential is held, and that
does not make reported usage invisible.
Rejected: leaving the wording untouched — a payroll screen sitting under a non-goal headed
"Hosting the model" stops every future reader and every red-team pass, with nothing in the brief
to point them at.
Rejected: narrowing further to forbid pricing lookups — that pre-decides the open "cost per
shipped PR has no source" item, which D53 deferred to `/contract`.
Reversibility: cheap.

### 2026-08-08 — D62 The orchestration non-goal bans agents starting agents, not concurrency
Context: three defects in two sentences. The wording distinguished neither side of D52; "one
session, one agent process" is untrue against D16's turn-scoped child; and "fan-out" meant
distributing work across agents here while `10-design.md` uses it for one-to-many envelope
delivery to subscribers (D18), which is in scope and built.
Chosen: restate the body and keep the heading, so D51's and D52's references to it still resolve.
The ban is on an agent starting another agent and on work moving between sessions without an
operator action, with D52's audit-identity reason stated in the brief itself. Operator-driven
assignment and concurrent sessions are named explicitly as *not* forbidden. The word "fan-out"
leaves the brief, leaving the term solely to D18's meaning.
Rejected: appending D52's carve-out and nothing else — leaves a sentence untrue against D16, and
leaves the term collision for someone to rediscover.
Rejected: renaming D18's concept so the brief could keep "fan-out" — churn across the design and
the contract to protect a phrase the brief can simply stop using.
Reversibility: cheap.

### 2026-08-08 — D63 Codex is tier one, and its permission asymmetry is stated in the brief
Context: definition-of-done item 2 promised "choosing Claude or Codex" while item 4 named Claude
only and items 3 and 5 to 7 were silent about Codex. D5 makes Codex sessions `preauthorised`;
D27 leaves it unverified whether Codex's `on-request` approval is reachable over a programmatic
transport rather than only inside its terminal UI.
Chosen: Codex stays in tier one. The brief now says which items a Codex session satisfies, that a
launch-time policy with a sandbox banner stands in for item 4, and that D27's unverified question
is explicitly not a blocker on done — D5's fallback is already the shipping answer if the
experiment fails.
Rejected: moving Codex to tier two — the four-layer vendor boundary would ship with a single
implementation behind it, which is where such abstractions are usually found to be wrong.
Rejected: requiring approval parity before tier one closes — reverses D5, and stakes "done" on
an unverified vendor capability resolving favourably.
Reversibility: cheap to move between tiers. The adapter is the cost either way.

### 2026-08-08 — D64 Both platforms are gated, and the brief stops claiming a CI that does not exist
Context: the constraint read "The primary host is Windows; CI is Linux". `.github/workflows/`
does not exist — this repository has no CI at all. The only gates present are the Pester suites
in `tools/` and `git diff --check`. A two-platform requirement was asserted and gated by nothing.
Chosen: state both as supported targets held to the same definition of done and gated by an
automated run, and say plainly that no such gate exists yet and that building it is tier-one work.
Rejected: Windows supported with Linux best-effort — cheaper by one matrix leg, but a Linux
operator finds the breakage instead of a gate, and the design already carries work for both.
Rejected: correcting the false sentence without asserting a gate — that leaves the constraint
unfalsifiable, which is the "do not claim a gate that did not run" failure promoted into the
brief.
Reversibility: cheap as text. The CI itself is ordinary work.

### 2026-08-08 — D65 Tier two persists to append-only latest-wins files, not a database
Context: D53 to D55 admitted two entities this system has no shape for — a review that is
authored, mutable while draft and terminal once final, and a requisition with an approval
state. Everything persisted to date is either append-only or a single atomic-rename file, and
D7 deferred a database until "session listing needs querying beyond mine, recent". Two
mutable, authored, cross-operator entities is the closest this project has come to that
moment, so the deferral was re-examined rather than assumed to still hold.
Chosen: two server-wide NDJSON logs, `reviews.ndjson` and `requisitions.ndjson`, append-only,
latest line per id wins, loaded into in-memory registries at boot. This is the pattern
`pids.ndjson` already uses for tombstones, generalised. The registries exist because the
once-only requisition claim must be tested and taken in one synchronous block (D32), which a
file read cannot be.
Rejected: SQLite. The volumes are a handful of trusted operators' worth and every query is a
full scan of a file measured in kilobytes, so it buys no query capability that is needed. It
costs a dependency, a schema-migration story, and a second durability model beside the
fsync-before-respond guarantee the audit log needs (D26) — or, if the audit log moves into it
too, the append-only-file property that makes that log evidence.
Rejected: a mutable JSON document per record with atomic rename. A second write protocol, a
second torn-write failure row, and it discards the edit history an authored record should
keep — a draft overwritten in place leaves no trace it existed.
Known and retained: a dropped torn line in a latest-wins log reverts a record to its previous
state rather than shortening a history, which is a different failure from the one the spill
has. The sharpest case is a lost consumption line, which makes a spent approval spendable
again and is the one way D68's once-only claim can be untrue; the resulting sessions still
face the jail and the busy check, so it is a bookkeeping lie rather than a hazard. Stated in
`10-design.md § Persistence summary` and accepted; `pids.ndjson` already carries the same
shape, which is why D23 has a reuse guard. The alternative is refusing to boot over one bad
line in a file unrelated to running a session.
Reversibility: cheap while the volumes stay small — the files are a load-and-replay away from
any other store. Expensive once an operator has years of reviews, which is the usual shape.

### 2026-08-08 — D66 A review's subject is a session, not a person
Context: D54 made performance reviews and PIP status first class, which reads as an employee
record. `10-design.md § Data model § Operator` is `{ id }`, **not persisted**, because D3 chose
delegated identity so that no account state lives on this server — the same tension D60 had to
resolve for the theme preference. The brief's item 9 says "record a performance review against
a session".
Chosen: take the brief literally. `subject` is a `SessionId`; `author` is an `OperatorId`
string on a record, exactly as `AuditRecord.operator` already is. There is no employee entity,
no operator entity, and nothing here that an identity provider renaming someone invalidates.
Rejected: an employee or operator entity with review history. It is the first account state on
this server, it reopens D3, and it must answer what the row means when the upstream provider
renames or removes that person — a question with no good answer and a persisted entity that is
not un-written.
Rejected: attaching a review to a workspace path. Paths are reused, so a review would silently
accrue to whoever holds that directory next.
Reversibility: expensive. A persisted authored record is not removed once written to, which is
D54's own reversibility note applied to the shape rather than the feature.

### 2026-08-08 — D67 Reviews and requisitions are server-wide and survive session deletion
Context: D25 deletes a session's `meta.json`, spill, tool-output blobs and `ckpt.git`, and
deliberately never touches `audit.ndjson`, because a log its subject can delete is not
evidence. A review stored under the session it reviews has exactly that defect, with more
claim to it than the audit log has. A requisition has the opposite problem: it exists before
any session directory does.
Chosen: both live beside `audit.ndjson` at the storage root. A review carries a
`SessionSnapshot` — the session's `owner`, `vendor`, `cwd` and `createdAt`, denormalised at
authorship — for the same reason `AuditRecord` copies `vendor` and `sandbox`: after D25 the
`SessionId` resolves to nothing, and a review that can only say "session `9f2c…`" says nothing.
Rejected: per-session storage for reviews. It hands the subject of a review the ability to
destroy it by deleting the session, which is precisely what D25 refuses for audit.
Rejected: keeping a session's `meta.json` alive as a tombstone so a review can resolve it. D25
already rejected that exact tombstone, for the reason that it adds a rehydration case for a
session whose transcript is gone in order to record something another log already records.
Reversibility: cheap for the file location; expensive for the snapshot, since removing it later
would strand every review written before the removal.

### 2026-08-08 — D68 A requisition is an optional second path into session creation, never a gate
Context: brief item 10 is "open a session through a requisition someone approved". Brief item 2
is "start a session against a workspace directory", with no approver in it, and D59 makes tier
one finishable on its own. If a requisition were required, item 2 would become an approval
workflow and tier one would depend on tier two.
Chosen: `requisitionId` is an optional field on `POST /api/sessions`. Supplied, it is claimed
once and only from state `approved`, in the same synchronous block that tests it (D32).
Absent, nothing in the creation path changes. The claim sits **after** the jail and workspace
checks. The requisition stores the client's workspace **string**, unresolved.
Rejected: requiring a requisition. It breaks D59's two tiers, and it imposes an approval policy
the brief never asked for on a group the brief describes as trusted.
Rejected: resolving the workspace at raise time. A requisition can sit unapproved for a day, so
the stored path may no longer mean what it did; and a resolve-or-refuse at raise time leaks
which directories exist to anyone who can raise one. An approval is permission to try, and
`409 outside_workspace_root` at the moment of use is the correct place for that refusal.
Rejected: claiming the requisition before the jail and busy checks. It burns the approval on a
refusal that has nothing to do with it, leaving the operator holding an unspendable approval.
Reversibility: cheap. The field is optional and additive in both directions.

### 2026-08-08 — D69 Self-approval of a requisition is permitted and recorded
Context: D68 gives a requisition an approval state. Whether `decidedBy` may equal `raisedBy`
decides whether the feature is a control or a record.
Chosen: permitted, and `decidedBy` is always written. The record is honest about who approved
it and the deployment decides socially what that means.
Rejected: forbidding self-approval. It wedges the single-operator deployment — which the brief
explicitly contemplates, "a small group" including one — since no requisition could ever be
spent. It also claims an enforcement the threat model already concedes is unavailable: a
determined operator is out of scope and has shell access as the server's user, so a
second-person rule this server enforces is a UI convention presented as a control.
Rejected: making it configurable. A control that is off by default is never exercised, which
D21 already rejected in this repository for the same reason.
Reversibility: cheap. Adding the constraint later refuses future decisions and invalidates no
stored record.

### 2026-08-08 — D70 The audit log and both record logs are readable by every authenticated operator
Context: brief item 1 is "authenticate, and see only their own sessions", and D50 returns
`404 no_such_session` to a non-owner so session existence cannot be probed. Tier two needs a
second operator to see a requisition in order to approve it (item 10), and brief item 7's
audit read is a tier-one promise this design had specified no route for at all.
Chosen: read is open across operators for `audit.ndjson`, `requisitions.ndjson` and every
**final** review. Write stays attributed and constrained — only a review's author may append
to it, only a session's owner may tick its checklist, and the ownership check on every session
route is unchanged.
One carve-out, and only one: a review in state `draft` is readable and writable by its author
alone, and becomes visible to everyone when it is finalised. That is what a draft state is for
— the purpose of drafting is not having published yet — and without it D54's draft state is a
label rather than a state. The carve-out is bounded by being one-way: nothing here ever becomes
less visible. A non-author reading a draft gets `404`, matching D50, and drafts do not appear
in the list route at all.
Known and retained: this narrows D50's justification rather than reversing it. Reviews and
audit records name `SessionId`s, so from tier two onward session existence *is* discoverable
through the record logs. The `404` stays and is still load-bearing, but what it buys is access
control, not concealment. The `SessionSnapshot` on a review (D67) means a reader never needs to
resolve the session, so nothing is later tempted to relax the `404` to make a screen render.
Rejected: scoping each operator to their own records. The audit log is server-wide precisely
because the question it answers, "who approved what", crosses sessions — scoped, it answers
only "what did I approve", which needed no log; and a requisition cannot be approved by someone
who cannot see it.
Rejected: a reviewer or auditor role. The first account state on this server, which D3 refuses
and D66 has just refused again.
Reversibility: expensive in the direction that matters. Opening a read is easy to do and hard
to take back once operators rely on seeing each other's records.

### 2026-08-08 — D71 The onboarding checklist lives in the session's event stream
Context: brief item 10's second half is a per-session first-run checklist. It is mutable
per-session state, which the storage layout has exactly one existing shape for — `meta.json`,
whose write protocol (D37) is deliberately restricted to three occasions and is not this.
Chosen: a `checklist.item.completed { itemId, by }` envelope through the same `emit` as
everything else; the checklist is the fold over the session's event log; the item template is a
`config` value. Ticking is idempotent — a second tick emits nothing and returns `200`. It is
not audited: brief item 7 promises a record of every *tool approval*, and diluting that log
with provisioning clicks makes the artifact the threat model leans on harder to read.
Rejected: a `checklist.json` per session. A second per-session mutable file needing its own
write protocol, its own atomic-rename discipline and its own torn-write failure row, for a
handful of booleans that already have a durable, ordered, replayable, fanned-out home.
Rejected: a per-requisition or per-vendor template. That is a workflow engine, and nothing in
the brief asks for one.
Known and retained: the checklist dies with its session under D25. That is correct — it is
first-run provisioning, not evidence — but it means a completed checklist is not recoverable
after a delete, unlike the review of the same session.
Reversibility: cheap to add a new event kind; expensive to move the data afterwards, since
existing sessions' checklists would live only in their event logs.

### 2026-08-08 — D72 PIP status is derived from the latest final review, and drafts do not set it
Context: brief item 9 asks to "see whether a session is under a performance plan". D54 put PIP
on the review. Whether it is also a field somewhere, and whether a draft counts, are both open
in a way that shows up on other operators' screens.
Chosen: derived. Fold the review log for that subject, take the most recent review in state
`final`, read its `pip`. Drafts are excluded.
Rejected: a stored flag on the session. Two places to be wrong, and it would have to survive
D25 deleting the session while the review that justified it (D67) did not — leaving a flag with
no evidence or evidence with no flag.
Rejected: letting drafts set it. Under D70 a draft is invisible to everyone but its author, so
a draft that set the badge would leak the draft's content in the one bit that matters most —
and would do it while the author was still deciding. Worse than the badge arriving when they
finish.
Reversibility: cheap. It is a fold; changing the rule changes one function.

### 2026-08-08 — D73 The audit log gets a bounded read route, and tier one always needed one
Context: brief item 7 is a *read* — "read an audit record of every tool approval: who, what,
when" — and it is tier one. `10-design.md § Security controls` specified the append in six
paragraphs and the read in none, and `20-contract.md § HTTP routes` accordingly has no audit
route. A route the design never states is one the contract cannot derive.
Chosen: a bounded window with a cursor, newest first, readable by every authenticated operator
(D70). Brief item 11's incident history is the same read with filters — denials, server-forced
decisions, standing-rule auto-allows, grouped by session and operator — which is why that item
costs no new storage.
Rejected: leaving it unstated. This is the gap, not a design choice.
Rejected: an unbounded read of the whole file. `audit.ndjson` is the only file in the system
that grows for the deployment's lifetime — never truncated, and explicitly outliving every
session it names (D25) — so a whole-file scan is a screen that degrades permanently.
Rejected: building an offset index now. Open question 11 already carries that for the spill and
now for this file; the bound is what makes it not yet necessary.
Reversibility: cheap. It is a read route with no persisted consequence.

### 2026-08-08 — D74 The no-`innerHTML` rule covers everything this codebase did not write
Context: D43 wrote the rule as "no `innerHTML` for anything derived from an agent", which was
the whole population of untrusted strings at the time. Tier two adds review bodies and
requisition justifications — operator-authored, stored, and under D70 rendered in a *different*
operator's browser. That is the first stored path from one operator's keyboard to another's.
Chosen: widen the rule. Text nodes only for anything not a literal in this codebase.
Rejected: adding a second clause for operator-authored text. "Is this string agent-derived?" is
a question a renderer eventually answers wrong, and the answer is invisible at the call site;
"did we write this literal?" is one it cannot get wrong.
Known and retained: this does not defend against a determined operator, who has shell access
already. It defends the ordinary case where operator-authored text is pasted from somewhere
else, which is the same argument the confused-agent row makes for tool output.
Reversibility: cheap. It is strictly stricter than what it replaces.

### 2026-08-08 — D75 `usage` is normalised by the adapter; nothing above it does token arithmetic
Context: brief item 8 wants "token burn to date". `10-design.md § Ordering guarantees` already
warns that `usage` arrives per assistant record rather than per turn, and the Claude vendor
mapping resets local token counters at a `compact_boundary` — behaviour consistent with
per-context cumulative reporting, under which summing raw values double-counts input tokens.
Codex's `token_count` is unverified for the same question.
Chosen: the adapter emits `usage` in a form the contract defines as summable, and every
consumer sums. Whether a vendor reports cumulative or incremental counts is vendor knowledge
and stays below the boundary.
Rejected: summing raw vendor numbers in the payroll view. A view performing that arithmetic is
vendor knowledge above the adapter arriving by the back door — the same failure D44 describes
for open-string stop reasons — and it is wrong under compaction.
Rejected: displaying the latest raw `usage` instead of a total. Defensible and cheap, and it is
not "burn to date", which is what the brief asks for.
Known and retained: which of cumulative or incremental each vendor reports is unverified for
both. Carried as `10-design.md § Open questions` item 14. This decision fixes *where* the
answer is applied, not what it is.
Reversibility: cheap. It is an internal normalisation with two implementations.

### 2026-08-08 — D76 Derived idle time excludes any interval spanning a restart
Context: brief item 8 includes paid idle time, derived from session state transitions. D39 has
boot close a crashed turn by appending a `turn.ended` carrying the *boot* timestamp, so an
outage of any length lands inside one interval of the derived timeline — either the turn or the
idle gap after it, depending on where you cut.
Chosen: drop any interval containing a `turn.ended` with `stopReason: 'server_restart'`, and
report how many intervals were dropped.
Rejected: counting it as idle. The payroll screen then bills an operator for the server being
down.
Rejected: counting it as turn time. The same wrong number, moved somewhere it is less obvious.
Rejected: inferring the outage from the host's last boot time. That signal exists for the pid
reuse guard (D23), it says nothing about how long the process was absent, and it is simply
wrong on a host that did not reboot.
Reversibility: cheap. It is a fold.

### 2026-08-08 — D77 `records` is a twelfth module and does not depend on the session manager
Context: tier two owns two lifecycles that are not sessions — a requisition exists before any
session, a review outlives one (D67) — and neither touches turn state, `seq`, fan-out or child
processes, which is `session-manager`'s entire ownership.
Chosen: a `records` module depending on `config`, `store` and `contract`. `session-manager →
records` exists for exactly one call, the once-only requisition claim during session creation.
The review route needs a `SessionSnapshot`, and the **edge** composes it: it resolves the
session through `session-manager`, applies the ownership check it already applies to every
session route, and passes the snapshot to `records` as a parameter. The graph stays acyclic.
Rejected: five more methods on `session-manager`. It already owns ownership, turn state, `seq`,
fan-out and reaping; a second unrelated lifecycle is how a module becomes the place everything
goes, and it would make tier two impossible to leave unbuilt cleanly.
Rejected: `records → session-manager` for the snapshot. It makes the module designed to outlive
sessions a client of the module that owns live ones.
Reversibility: cheap. It is an internal module boundary with no persisted or wire consequence.

### 2026-08-08 — D78 The four themes are CSS custom properties and a root attribute
Context: D58 ships four operator-selectable visual systems and D60 puts the choice in the
browser. D43's CSP is `style-src 'self'` with no `unsafe-inline`, and the obvious
implementation of a runtime theme switcher writes a `<style>` block.
Chosen: one stylesheet served from `'self'` holding four blocks of CSS custom properties; the
switcher sets a `data-` attribute on the root element and nothing else. No style text is
generated, injected or interpolated at runtime. The choice is read from and written to browser
storage (D60) and never reaches the server.
Rejected: generating or injecting style text. It needs `unsafe-inline`, which weakens the one
CSP directive this design has standing to be strict about, having criticised the prior art's
CSP by name.
Rejected: four stylesheets swapped at runtime. A flash of unstyled content on every switch, and
four files to keep in step instead of one block of variables — which is exactly the drift D58's
reversibility note warns about.
Reversibility: cheap.

### 2026-08-08 — D79 The prototype's employment status is a client-side projection, not a field
Context: staged in `## Open` — the prototype's `ON SHIFT / BLOCKED / IDLE / ON PIP / PROBATION /
CLOCKED OUT` vocabulary overlaps `SessionSummary.state` without matching it, and the note
recorded only that they are different concepts needing separate fields.
Chosen: it is not a field at all. The badge is derived in the client from facts that already
exist — `ended` is `CLOCKED OUT`; a live session with an outstanding `permission.request` is
`BLOCKED`; a live session with a running turn is `ON SHIFT`; a live session with no turn is
`IDLE`. `ON PIP` is orthogonal and comes from D72. `PROBATION` is **cut**: nothing in this
system is a source for it, and keeping it would require inventing one.
Rejected: a stored status field. It overlaps `state` without matching it, which is two fields
that must agree and one that eventually does not — the drift the single-ownership rule exists
to prevent.
Rejected: extending `state`'s union with the prototype's vocabulary. `state` is what decides
whether the compose box is enabled (D20, D45); putting presentation vocabulary into it means a
renderer branching on six values to answer a two-value question.
Reversibility: cheap. It is a projection in one component.

### 2026-08-08 — D80 A requisition claim lost to a crash is a dead approval, and that is accepted
Context: the red-team pass on `10-design.md` found that control flow 1 appends the `consumed`
line to `requisitions.ndjson` before `store.mkdir` and the rest of session creation. A process
death in that window leaves the requisition `consumed`, naming a `sessionId` that resolves to
nothing. The in-process release path — `Failure modes § Records boundary`, "release the claim;
requisition returns to `approved`" — cannot run after a crash, and `consumed` is terminal.
Chosen: accept it and write it down. The approval is spent, the operator raises another, and the
log honestly records a consumption that happened.
Rejected: a two-phase claim, or a boot reconciliation that returns a `consumed` requisition with
no resolvable session to `approved`. Both add a second write protocol and a new boot step to
recover a state whose remedy is one form submission, and the boot version cannot distinguish a
crashed creation from a session deleted under D25.
Known and retained: this is the same shape as the accepted spawn→append window in
`10-design.md § Data model § Process record` — a short window whose consequence is one item of
bookkeeping an operator repairs by hand. It differs in being visible: the phantom `sessionId`
stays on the record.
Reversibility: cheap. Nothing persisted would have to change to add reconciliation later.

### 2026-08-08 — D81 An approved requisition cannot be revoked, and that is accepted
Context: the red-team pass observed that `open → approved → consumed` refuses every other
transition and approvals carry no expiry, so an approval outlives the judgement behind it
indefinitely — the approver changed their mind, circumstances moved, the raiser left.
Chosen: no revocation and no expiry. An approval stays spendable until it is spent.
Rejected: an `approved → revoked` transition. D69 already permits self-approval, and the threat
model already concedes a determined operator has shell access as the server's user, so revocation
is a control that cannot hold against the adversary it appears to address — it would read as one
while enforcing nothing. Rejected an expiry window: it needs a duration nobody can source, and it
fails an operator holding a legitimate approval over a weekend.
Known and retained: this is an ordinary-case gap, not a security one. A requisition raised in
error is answered by rejecting it before approval; after approval the remedy is that the session
it opens is subject to the jail, the busy check and the audit log exactly as any other.
Reversibility: cheap. Adding a state to a latest-wins log is an append and a union member.

### 2026-08-08 — D82 `Rating` is a five-member token enum, not the prototype's display strings
Context: D54 ruled the rating scale in as "a contract enum" and named no members. The only
source anywhere for the scale is the imported prototype, which offers five labels — *Does not
meet*, *Meets some*, *Meets*, *Exceeds expectations*, *Exceptional*. `10-design.md § Data model
§ Review` types the field as `Rating | null` against a type nothing defines.
Chosen: `'does_not_meet' | 'meets_some' | 'meets' | 'exceeds' | 'exceptional'`, with the wording
an operator sees owned by the client.
Rejected: persisting the prototype's display strings as the union members — self-describing on
the wire and one less mapping to write, but it freezes product wording into an append-only
employment record, so rewording the scale becomes either a migration of `reviews.ndjson` or two
vocabularies on disk. Rejected a numeric 1–5 scale — it invites arithmetic on a judgement, and
the five points are not evenly spaced. Rejected leaving `Rating` undefined — `Review` could not
then be declared and the review slice could not be planned.
Reversibility: expensive in the same way every persisted authored record is. Tokens are what
make the *labels* cheap to change; the tokens themselves are written down forever.

### 2026-08-08 — D83 The most recent final review is ordered by `updatedAt`, with no new field
Context: D72 answers "is this session under a performance plan?" from the most recent **final**
review, and nothing said what "most recent" is measured by. Creation time, file order and a
finalisation timestamp that is never stored all give different answers, and file order rewinds
under the accepted torn-tail reversion.
Chosen: order finals by `updatedAt`, ties broken by the later line in `reviews.ndjson`. This
works without a new field because `state: 'final'` is terminal — a final review refuses every
further append — so `updatedAt` on the final line *is* its finalisation time.
Rejected: adding `finalisedAt: IsoTimestamp | null`, non-null exactly when `state === 'final'`.
More legible, and it gives the finalisation guard an explicit thing to hold — at the cost of a
second timestamp on the same line that must always agree with the first, which is two fields
that must agree and one that eventually does not.
Known and retained: this settles the ordering key only. Whether finalisation is claimed under
the single-writer invariant, and what stops a torn tail retracting a final review other
operators have already seen, are unresolved and stay with `/design` (issues #35, #36).
Reversibility: cheap. Adding an explicit timestamp later is an added optional field, which the
record logs' forward rule already permits.

### 2026-08-08 — D84 The contract declares the tier-two text caps and the audit window, and sets no values
Context: nothing bounded a review body or a requisition's title and justification, while every
edit re-appends the whole record and both logs are held wholly in memory at boot — which is the
volume assumption D65 used to refuse a database. The audit read needs a bound for the same
reason D73 gives.
Chosen: `Caps.reviewBodyBytes`, `Caps.requisitionTextBytes` and `Caps.auditPageMax` are declared
in `20-contract.md`; the numbers are a deployment's, set in configuration. Over-cap text is
refused with `422 bad_request`, never silently truncated the way `tool.result` is.
Rejected: picking numbers here — a capacity judgement with no measured basis, and `config`
already owns every other cap. Rejected truncating instead of refusing — a review is an authored
record and a silently shortened one misrepresents its author; truncation is right for tool
output because nobody wrote it.
Reversibility: cheap. A cap is a configured number and a validation branch.

### 2026-08-08 — D85 The checklist fold is served by the server, not assembled in the client
Context: D71 makes completion an event and the checklist the fold over it, and puts the item
template in `config`. The client holds the events but has no way to read `config`, so as drawn
nothing can render an item's label.
Chosen: `GET /api/sessions/:id/checklist` returns the folded `ChecklistItemState[]` — template
joined to completion — under the session's ownership check like every other session route.
Rejected: shipping the template to the client in a bootstrap payload and folding there — it
adds a second place the template exists and a second thing to be stale, to save one route over
data the server already holds. Rejected returning the fold on the tick response only — a client
that reconnects has no way to obtain it.
Reversibility: cheap. A read route over derived data, persisting nothing.

### 2026-08-08 — D86 The audit read's cursor is opaque and server-minted
Context: D73 specifies a bounded window with a cursor, newest first, over a file whose records
carry no identifier — an `AuditRecord` has a timestamp and nothing unique.
Chosen: `AuditCursor`, a branded string the server mints and the caller only round-trips. No
caller may parse one, and what it encodes is `store`'s business.
Rejected: a byte offset or line number as the cursor — it publishes the file's physical layout
as a public interface, which is exactly what an offset index would later change (open question
11). Rejected `(ts, index)` pagination — timestamps collide at millisecond precision under a
fast stream, which is the argument D2 already made against timestamps as a key.
Reversibility: cheap, and cheap *because* it is opaque — that is the point of the choice.

### 2026-08-09 — D87 The spike's contract divergence is declared, not reconciled
Context: `/reconcile` compared the working tree against `10-design.md` and `20-contract.md`.
The tree holds no implementation — the only server code is `spike/`, which its own README and
`30-slices.md:68` declare is throwaway proof. It diverges from the contract in seventeen ways,
of which the README declared four. An undeclared divergence in the only running code is how a
throwaway becomes a reference: `agent.md` already records that a shortcut in the reference
implementation gets copied, because the next author reads the working example before the
contract.
Chosen: enumerate every divergence in `spike/README.md` as a table against the contract, and
fix only the two that are defects rather than gaps — `respondPermission` forwarding a
client-supplied `input` to the CLI as `updatedInput`, which let an answering client change what
runs after the operator saw something else (I12); and a comment claiming `scope: 'always'`
handed the vendor suggestion back, beside a branch that set `updatedPermissions` to `undefined`
either way, which D35 rejects outright.
Rejected: bringing the spike up to the contract — the `notify` union, `turnId` on every
turn-scoped payload, the closed error vocabulary, the origin check, the busy check, atomic
`meta.json`, the strict CSP. Substantial work on files S1 and S2 delete, and it would make the
spike look like the implementation it is documented not to be. Rejected deleting the spike now:
its four proofs are cited by S1 to S4 and the recorded Claude fixtures go with it. Rejected
fixing the false comment alone and leaving the `input` pass-through — it is the single shortcut
here most worth not copying.
Known and retained: the spike still emits `session.exit` (retired by D45), error kinds outside
`ErrorEventKind`, and payloads without `turnId`. Every one is now in the README's table. Its
tests cover the NDJSON splitter only, so neither defect fix is under test.
Reversibility: cheap, and shortly moot — `spike/` is rebuilt in TypeScript by S1 and S2, and
`spike/.data` is deleted rather than migrated (`20-contract.md § Migration`).

### 2026-08-09 — D88 S1's permission round trip is verified against a fixture CLI, not the real one
Context: `--permission-prompt-tool stdio`, the mechanism S1.1 and S1.9 depend on, does not
emit `control_request`/`can_use_tool` on the real, installed `claude` CLI (2.1.226) — verified
directly by three probes (Read, Bash, Bash with `--permission-mode manual`), every one of which
ran the tool with no control-channel prompt at all. This matches a currently open upstream
defect, anthropics/claude-code#34046, tracked since CLI 2.1.6. `design/findings/S1-claude-adapter.md`
has the full probes and citations.
Chosen: implement the adapter against the documented protocol, and test S1.1/S1.3/S1.9 against
a deterministic fixture CLI (`src/adapters/claude/fixtures/fake-claude-cli.mjs`) that speaks the
documented wire shape exactly, over real stdio and a real child process — just not the real
vendor binary. The non-permission path (spawn, drive a turn to `turn.ended`, `session.started`,
`usage`, `message`) is additionally verified against the real CLI via the S1 harness
(`harness/run.mjs`), and that half works.
Rejected: blocking the whole slice on the upstream fix landing — S1's other nine criteria do
not depend on the control channel and there is no reason to hold them. Rejected silently
marking S1.1/S1.9 as passing against the real CLI — they did not, and `AGENTS.md § Verification`
forbids claiming a gate that did not run.
Reversibility: cheap to re-verify once #34046 ships a fix — swap `SKYNET_CLAUDE_EXECUTABLE`
back to the real binary and re-run the same fixture-shaped assertions.

### 2026-08-09 — D89 `emit` has a synchronous prefix and a per-session append chain
Context: `10-design.md § Concurrency` said "`emit` is synchronous and is the serialisation
point" and "there is no mutex anywhere in this design". S1's `emit` is `async`: it assigns
`seq`, pushes the ring and fans out to subscribers synchronously, then chains the
`events.ndjson` append onto a per-session promise chain and awaits it. Two appends issued in
`seq` order do not complete in `seq` order on their own, so without the chain the spill is
written out of order — which falsifies I1 on disk rather than in memory, where nothing would
notice until a replay.
Chosen: keep the code and correct both documents. The serialisation point is named as `emit`'s
synchronous *prefix*; the append chain is described as ordering rather than exclusion — it
excludes nothing, blocks no other session, and cannot deadlock — so "no mutex" survives
intact. I27 is reworded to say so.
Rejected: making `emit` fully synchronous by firing the append unawaited. It loses the append
failure, and D41 (a spill write failure ends the session) is built on seeing it; it also
returns the out-of-order-write problem to a design that would then owe an answer for it.
Rejected leaving both documents and deciding at S3: every slice between here and there reads
an invariant the tree already contradicts, which is the failure `/reconcile` exists to catch.
Reversibility: cheap. It is a doc edit and a rewording of one invariant; no code moves.

### 2026-08-09 — D90 Anything reaching a child's argv is charset-refused, not escaped
Context: the model string from `CreateSessionInput` and the resume id a CLI reports both land
on a child's argv, and on Windows that argv can pass through a shell (D91). The contract
constrained neither: `model` was `string | null` with no stated shape.
Chosen: refuse both unless they match a conservative charset —
`/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/` for `model`, answered `422 bad_request` naming the field
before any session exists, and `/^[A-Za-z0-9._-]+$/` for a resume id, answered
`AdapterError.schema_mismatch` because a CLI reporting a session id with shell metacharacters
in it is not following its own wire schema. The constraint is stated on
`CreateSessionInput.model` in the contract so a second adapter inherits it rather than
rediscovering it.
Rejected: escaping per platform in each adapter — it is the same quoting bug written once per
vendor, and the one place it is got wrong is a shell injection with the server's privileges.
Rejected trusting the vendor's own id — the value is only trustworthy while the vendor is
well-behaved, and the cost of not trusting it is one regex.
Reversibility: cheap, and it only ever loosens: a model name refused today is admitted by
widening the class, and nothing is stored that a wider class would invalidate.

### 2026-08-09 — D91 How a vendor binary is found and launched, including the fixture seam
Context: spawning `claude` on Windows fails outright without a shell — the bare name resolves
through `PATH`/`PATHEXT` to a `.cmd` shim, which modern Node refuses to exec directly (EINVAL,
thrown synchronously rather than surfaced as an `error` event). Separately, D88's verification
of the permission round trip needs a fixture CLI to stand in for the real binary over a real
child process.
Chosen: spawn through a shell on Windows for the bare vendor name and for explicit `.cmd`/
`.bat` paths, quoting a path containing a space because a shell spawn concatenates rather than
escapes; run a `.mjs`/`.js` fixture under `process.execPath`; catch `spawn`'s synchronous throw
and return `agent_unavailable` rather than rejecting the promise past the `Result` contract.
The fixture is selected by an optional `executable` on `createClaudeAdapter`, defaulting to
`SKYNET_CLAUDE_EXECUTABLE` — declared in the contract as a **test seam**, not a `Config` field,
and not reachable through `createAdapter`. Two rows are added to the platform-divergence table
D64 requires.
Rejected: a `Config` field for the agent binary path. A deployment that can repoint the agent
from the environment is one where `audit.ndjson` names a program nobody chose, and the audit
log is the artifact the threat model leans on. Rejected `shell: true` unconditionally — it puts
a shell in the path on Linux, where none is needed, for the benefit of one platform.
Reversibility: cheap. The seam is one optional parameter and the shell gate is one predicate.

### 2026-08-09 — D92 Records outside the vendor mapping may be ignored by a named list
Context: `10-design.md § Failure modes` and S1.4 say an unrecognised record kind raises
`error / adapter_unknown_record`. Run against the real CLI, the stream carries records that
are ordinary and no part of the twelve-row mapping — `rate_limit_event`, `control_response`,
and the `system` subtypes `hook_started`, `hook_response`, `thinking_tokens`,
`post_turn_summary` — several of them on every routine turn.
Chosen: hold a named ignore list in the vendor's own adapter and return silently for its
members; keep `adapter_unknown_record` for everything outside both the mapping and the list.
The list is written into `20-contract.md § Vendor mapping — Claude` so it is a declared fact
rather than a silent omission, and extending it is an adapter change, never a change to
`ErrorEventKind`.
Rejected: flagging them all, which was the literal reading. It puts a diagnostic line in front
of the operator on every ordinary turn, and a diagnostic nobody can act on is one they learn to
scroll past — including the one that mattered. Rejected adding rows to the mapping table that
normalise to nothing: the table says what a record becomes, and "nothing" is a different
statement that belongs beside it, not in it.
Reversibility: cheap; the list is data.

### 2026-08-09 — D93 An auth mode is required in every configuration
Context: the design's fail-closed rule refuses a non-loopback bind "with no auth mode
configured", and `ConfigError.insecure_bind` exists for it. S1's `loadConfig` makes `AUTH_MODE`
mandatory unconditionally, so a configuration with no auth mode never loads at all.
Chosen: keep it mandatory. There is no deployment shape this project wants in which the auth
mode is absent, and refusing at parse time is a smaller, earlier failure than refusing at bind
time. S2 therefore inherits a narrower `insecure_bind`: the reachable cause is a routable bind
with no `trustProxy` allow-list, not a missing auth mode.
Rejected: an implicit "none" mode defaulting to loopback-only. It is the configuration most
likely to be copied to a server and then bound to `0.0.0.0` by someone changing one line.
Reversibility: cheap now, expensive after a deployment exists — it would be a required field
appearing in an existing environment.

### 2026-08-09 — D94 `config` depends on `jail`, and `jail` owns the containment predicate
Context: `10-design.md § Module boundaries` drew `jail → config`. The code has no such edge —
`resolveInsideRoot` takes the roots as a parameter, exactly as the contract has always said —
and has the reverse one: `config` canonicalises each declared workspace root through the jail's
own normalisation. Without that, a root and a candidate are spelled differently on Windows (8.3
short names, a `\\?\` prefix, case) and a legitimate `cwd` is refused. The session manager
separately needs an overlap test for the busy check (D30) and had hand-rolled one.
Chosen: `jail` exports three functions — `resolveInsideRoot`, `pathsOverlap`, and
`stripExtendedPrefix` — all three declared in `20-contract.md § jail`; the design's graph drops
`jail → config` and gains `config → jail`, which stays acyclic. There is one containment
predicate in this server and no module hand-rolls a second.
Rejected: a thirteenth module holding the normalisation so neither exports beyond its declared
surface — two functions do not earn a module, and the twelve-module count is load-bearing prose
in two documents. Rejected declaring `pathsOverlap` alone and letting `config` keep its own
copy of the prefix handling: two copies of a Windows path rule is the divergence single
ownership forbids, and its failure mode is a correct path refused for spelling.
Reversibility: cheap.

### 2026-08-09 — D95 `pids.ndjson` carries two line shapes
Context: the contract said the file holds one `ProcessRecord` per line, and `tombstonePid(pid,
exitedAt)` is given a pid and a timestamp and nothing else — so the line it writes is narrower
than a `ProcessRecord`, and under latest-line-wins the folded entry for an exited pid loses
`startedAt` and `image`. Those are two of the three fields the reuse guard reads (I19), so a
reader that took them off the latest line would reap on a guard that never ran. Nothing calls
`tombstonePid` yet; S7 is where this is first read.
Chosen: declare the second shape. `pids.ndjson` holds a full `ProcessRecord` at spawn and a
`ProcessTombstone { pid, exitedAt }` at exit; liveness comes from the latest line for a pid and
everything else from that pid's most recent spawn line. Stated in the contract before S7 reads
it.
Rejected: widening `tombstonePid` to take the whole record. The manager's `exited` notification
carries a code and a signal, so the record would have to be held across the turn or read back
out of the file — real cost, to preserve a one-shape claim nothing needs. Rejected leaving it
for S7 to decide: its implementer would read a contract sentence the store already contradicts,
which `agent.md` records as how a shortcut becomes the reference.
Reversibility: cheap; there is no deployed data.

### 2026-08-09 — D96 The broken Claude handshake corrects the premise and does not reopen D5
Context: `10-design.md § The hard problem` sourced Claude's runtime approval as "Verified —
read from the fork" and framed the vendor asymmetry as one of verification rather than
capability. D88 established that `--permission-prompt-tool stdio` emits no `can_use_tool` on
the shipping CLI (2.1.226, anthropics/claude-code#34046). Neither vendor's runtime approval is
therefore observed on a live wire today, and the sentence justifying the interactive model as
the contract described a state that no longer obtains.
Chosen: correct the premise in place — say that Claude's handshake is documented by the vendor
and observed in someone else's code, not against the shipping binary — and keep D5. A vendor
defect in a documented mechanism is behaviour to be restored, not a capability that was never
there, and the console's reason to exist is unchanged either way.
Rejected: reopening D5. It would relitigate a signed-off decision on evidence about a bug
rather than about capability, and it puts S4 and the permission half of the design back in play
for no gain. Rejected a footnote pointing at D88 while the table still reads "Verified" — that
word is what a future session reads first, and this repository already knows it is false.
Reversibility: cheap, and it reverts the day #34046 ships a fix.

### 2026-08-09 — D97 `permission.resolved` leaves `AdapterEmitted`; the manager is its sole emitter
Context: the Claude adapter resolves its own pending permissions when the child closes, emitting
`permission.resolved` directly. `AdapterEmitted` permitted it — the type excluded four kinds and
not this one — while D33 puts the `pending` delete in the manager, synchronous with the lookup,
and I11 requires exactly one `AuditRecord` per resolution, which only the manager can write. So
the contract licensed a path that cannot satisfy two of its own rules: the resolution carries no
audit record, and the manager's own `pending` map is never cleared by it.
Chosen: exclude `permission.resolved` from `AdapterEmitted`. The adapter's contribution when its
child dies is the `exited` notification it already sends; deciding that every outstanding request
is now `cancelled_process_exit` is the manager's, in the same place it already decides it for an
interrupt (D24) and for a turn boot closes (D39) — one code path for three causes rather than
three.
Rejected: keeping the type and requiring the manager to audit adapter-originated resolutions. It
gives one invariant two emit paths, and the adapter would be choosing `operator` and `reason` for
a record it does not own. Rejected deferring to S4: the behaviour is live and untested today, and
S4's implementer would read a contract that permits what its own invariants forbid.
Reversibility: cheap. One type edit; the code change is `/fix`'s and is three small moves.

### 2026-08-09 — D98 D93's narrowing is propagated, and S2.8 becomes two checkable cases
Context: D93 made `AUTH_MODE` mandatory in every configuration. It was recorded and not
propagated: the contract's error table, the design's *Fail closed on startup* paragraph, its
failure-mode row and its threat-model row all still described `insecure_bind` as "a non-loopback
bind with no auth mode configured" — a configuration that can no longer be loaded. **S2.8, the
next slice's acceptance criterion, asserted it**, so as written it could not be constructed.
Chosen: restate the reachable cause everywhere — a routable bind that no `trustProxy` allow-list
covers — and split S2.8 into the two refusals that actually exist: `insecure_bind` for the bind,
`missing_field` at parse time for a missing auth mode.
Rejected: dropping `insecure_bind` from `ConfigError` and letting the generic validation codes
carry every startup refusal. The brief's fail-closed rule is the one place a refusal should say
what it is rather than which field was absent. Rejected reopening D93 to make the old wording
reachable again — that is the configuration D93 rejected precisely because it is the one most
likely to be copied to a server and then bound to `0.0.0.0`.
Reversibility: cheap; four prose edits and one criterion, no code.

### 2026-08-09 — D99 The ring's bound is a cap, not a constant, and its default is 2000
Context: `10-design.md § Event envelope` asserted the ring holds "currently 2000 envelopes" and
D40's whole argument for reading the spill is calibrated on that number. `config` defaults
`CAPS_RING_CAPACITY` to 500, so every replay argument in the design was reasoned against a figure
no deployment would get.
Chosen: the design names `Caps.ringCapacity` rather than a constant, and states 2000 as the
shipped default so the argument and the deployment agree. The code default moves to 2000.
Rejected: recalibrating the design to 500. D40's threshold reasoning and S3.3's test shape both
follow the number, so the rewrite reaches further than the one line it looks like. Rejected
stripping every figure from the design: D40 persuaded because it was concrete about when the ring
is outrun, and number-free it is an assertion.
Reversibility: cheap. It is a deployment value in both directions.

### 2026-08-09 — D100 A spill-append failure restores the invariants in S1; the rest is S5's
Context: S1's `emit` marks the session `ended` on a failed append and stops there — leaving
`turn` set, which I8 forbids, writing no `meta.json`, which I16's state-transition occasion
requires, and emitting none of D41's `session.ended` or `session.notice / error`. The code
conceded the gap in a comment; the design conceded nothing.
Chosen: split the row explicitly. S1 clears the turn slot and writes `meta.json`, so I8 and I16
hold today. The half needing a child killed and a notice on the wire lands with S5, which owns
interrupt and the process-tree kill, and the design says so where the failure mode is described
rather than only in a decision entry.
Rejected: implementing D41 whole in S1 — its *Out of scope* names interrupt, so this pulls S5's
kill path into a landed slice, and it emits envelopes into a spill that has just failed. Rejected
weakening I8 to permit a live turn during the transition: I8 is what lets every consumer assume
`ended` means no child is running, and a carve-out is invisible at every call site relying on it.
Reversibility: cheap.

### 2026-08-09 — D101 S1.8 is restated to the contract's three `meta.json` write occasions
Context: S1.8 required `meta.json` to be written "at create and not again during the run". The
contract's third write occasion is a change of `cliSessionId`, and D34 makes the CLI mint a fresh
one every turn — so the manager rewrites the file per turn, correctly, against a criterion that
forbids it. The test ticking S1.8 drives `store` directly and never the manager, so the
contradiction could not surface there.
Chosen: the contract is right and the criterion is wrong. S1.8 becomes the three occasions, and
is asserted through the session manager driving a real turn so the per-turn write is observed
rather than side-stepped. Separately, `/fix` guards the write on an actual change of value, which
is what the contract's word *change* says and the code does not check.
Rejected: keeping S1.8 literal by never rewriting `meta.json` and recovering `cliSessionId` at
boot from the event log. No envelope carries it — it is vendor-opaque and deliberately absent from
`SessionSummary` — so that needs a new field on the wire, which D44's closed vocabulary forbids.
Rejected recording the divergence and changing neither: a criterion asserted only where it cannot
fail is not a criterion.
Reversibility: cheap, but the S1.8 tick has to be re-earned against a test that can now fail.

### 2026-08-09 — D102 A turn-scoped fact arriving with no live turn is an error, never an invented value
Context: two sites assumed a turn is always live and quietly manufactured something when it was
not. The manager stamps `turnId` only while the slot is occupied, so a turn-scoped envelope
arriving after the slot is freed goes out without the field D44 requires; and `appendPid` writes
`entry.turn?.turnId ?? randomUUID()`, putting a fabricated id naming no turn into `pids.ndjson`.
Chosen: treat both as unreachable states and fail loudly — an `error` envelope naming the
condition. `turnId` stays required on turn-scoped payloads and `ProcessRecord.turnId` stays
non-null.
Rejected: carrying a `lastTurnId` forward and stamping late arrivals with it — that attributes an
envelope to a turn it does not belong to, which is the misattribution D44 put the field on the
payload to prevent, and it is unfalsifiable afterwards. Rejected making both fields optional:
every renderer and the boot reaper gain a permanent null case to describe a state the design says
cannot occur.
Reversibility: cheap.

### 2026-08-09 — D103 The environment-variable surface and the cap defaults are `config`'s own
Context: S1's `config` invented the whole deployment surface — `AUTH_MODE`, `WORKSPACE_ROOTS`,
`STORAGE_ROOT`, `BIND_*`, `CAPS_*`, `INCLUDE_RAW`, `SESSION_TOKEN_BUDGET`, `CHECKLIST_JSON` — and
a shipped default for all seven caps, against D84's "the contract declares the fields and sets no
values". Nothing recorded it.
Chosen: read D84 as governing the contract *document* rather than forbidding a module from having
a default, and record the surface here. The operator-facing table of names is `/make-human-docs`'
output, not a design artifact.
Rejected: declaring the variable names in `20-contract.md`. It takes on deployment configuration
D84 deliberately kept out, and every rename or added cap becomes a contract amendment before it is
a code change. Rejected a Configuration section in `10-design.md`: a table of literal values in the
design is the thing most likely to rot silently, which is exactly what D99 just had to repair.
Reversibility: cheap; nothing downstream is pinned to a name.

### 2026-08-09 — D104 The Claude adapter forwards `permission_suggestions` unmapped
Context: the adapter passes the vendor's `permission_suggestions` array through as
`PermissionSuggestion[]` with no mapping. That type names `{ label, rule }` against a
`StandingRuleExpression` whose grammar is undecided (`20-contract.md § Unresolved` 2, issue #16),
so there is nothing to map onto. Nothing exercises it: no observed CLI run has produced a
`control_request` at all (D88), and the fixture sends an empty array.
Chosen: declare the pass-through in the vendor mapping and forbid any consumer from reading a
forwarded element as a `PermissionSuggestion`, until #16 decides the grammar.
Rejected: mapping now — it invents the grammar #16 owns, and D35 requires a rule this server can
evaluate, so guessing its shape is what the seven slice-stops exist to prevent. Rejected retyping
the field to `readonly unknown[]`: the contract would lose a shape whose intent it already knows,
every consumer would cast, and the type returns anyway.
Reversibility: cheap — one paragraph, deleted when #16 lands.

### 2026-08-09 — D105 `design/` is frozen for the rest of tier one; reconciliation is one pass at the end
Context: measured over 22 commits, one touched `src/`. Design churn is roughly 14,600 lines
against 3,222 lines of source, and `design/` at HEAD is 6,733 lines specifying 3,222 lines of
software. The mechanism is visible either side of the one code commit: S1 landed, and the
reconciliation that followed emitted D89 to D104 — sixteen decisions and 534 lines of design
change — which rewrote S2's acceptance criteria before S2 had been started. Landing a slice
therefore invalidates the next slice's specification, which desyncs the tracker, which needs
`/track`, which finds drift, which needs `/reconcile`. The loop has no fixed point because each
pass is generative rather than merely checking. Compounding it, issue #3 pinned its criteria to
`design/30-slices.md § S2 @ 4ea4660` and #42 to #48 to `@ a89d820`; neither commit is an ancestor
of `main`, so the tracker cites slice documents this project's history does not contain.
Chosen: freeze `design/` at HEAD for the remainder of tier one. `/reconcile` and `/track` are not
run between slices. Slices are implemented against `20-contract.md` as a fixed artifact. Where the
implementation contradicts a design document, the contradiction is stated in that slice's pull
request and **left in the document** — the docs are permitted to go stale, deliberately, and one
reconciliation pass runs when tier one is code-complete. GitHub issues are repinned once, now, to
the slice document as it stands on `main`, and are not resynced until that pass.
Rejected: continuing per-slice reconciliation. It is the loop being escaped and its cost is
measured above. Rejected abandoning the design docs — they are why the contract is coherent and
why S1 landed as cleanly as it did; the defect is that they are kept live *during* implementation,
not that they exist. Rejected splitting S2 into smaller slices first: renumbering is what desynced
the tracker to begin with, and S2's criteria are implementable on one branch even though they are
more than one session's reading. Rejected repinning every issue continuously — one pass now, one
pass at the end.
Reversibility: cheap. This is a working convention, not a code change; resuming per-slice
reconciliation is one command.

### 2026-08-09 — D106 S2 splits into S2a to S2d, in place, as the last edit before the freeze binds
Context: D105 rejected splitting S2, on the ground that "renumbering is what desynced the
tracker to begin with." That reason is sound and is not overturned here — what changed is that
the split turns out not to require any renumbering. D105's own sentence also concedes the
defect it declined to fix: S2's criteria "are more than one session's reading," and
`AGENTS.md` § *Session boundaries* states that a slice which does not fit one session without
compaction **is too large — that is a `/slices` defect**. So D105 recorded a known defect and
chose to carry it, which is a legitimate call but not a permanent one. Two further facts were
established while checking: the repin pass D105 states as done ("repinned once, now") was only
partly done — #3 carries the D105 repin note, but #42 to #48 still cite
`design/30-slices.md § S<n> @ 4ea4660`, and `git merge-base --is-ancestor` confirms neither
`4ea4660` nor `a89d820` is an ancestor of `main`. Fourteen criteria also group cleanly along
S2's own `Touches:` line, and the uncommitted tree already had `src/config/` and `src/identity/`
as separate work, which is the split asserting itself in practice before it was written down.
Chosen: S2 becomes S2a (refuse to start insecurely, S2.8), S2b (know who is asking, S2.4, S2.5,
S2.9, S2.13), S2c (routes, ownership and the stream, S2.1, S2.2, S2.3, S2.6, S2.7, S2.10) and
S2d (the page itself, S2.11, S2.12, S2.14). **Nothing is renumbered at either level**: letters
subdivide S2 in place so S3 to S18 keep their numbers and issues #4 to #48 stay valid, and every
criterion keeps the exact id it already had, so `/track` compares on ids and sees a
redistribution rather than drift. `Depends on: S2` lines elsewhere are left alone and defined to
mean all four — narrowing them would be exactly the generative reconciliation D105 froze
`design/` to prevent. S2.6 sits in S2c rather than S2b because its own wording is "every
`/api/sessions/:id` route implemented in this slice," which is vacuous in a slice with no routes.
**The freeze binds after this edit**, which is the one structural change D105's own subject
matter could not be corrected without; the tracker is repinned in the same single pass D105
already scoped, finishing the half that did not happen.
Rejected: **Renumbering S2 to S5 and shifting S3 to S18 up to S6 to S21** — cleanly sequential,
and rejected for D105's stated reason unchanged: it invalidates sixteen slice numbers and every
downstream issue pin, which is the desync being escaped. **Leaving S2 whole**, per D105 as
written — rejected because it preserves a defect this repository's own contract names, and the
only argument for it was a renumbering cost this split does not incur. **Three slices, folding
config into identity** — offered and declined; S2.8 is a startup refusal that must hold before
any route or identity code exists, and merging it into an authentication slice hides the
ordering guarantee that makes the insecure intermediate state unreachable. **Repinning every
issue continuously from here** — unchanged from D105, still rejected; this is one pass, and the
next is when tier one is code-complete.
Reversibility: cheap. Four headings merge back into one, the criterion ids are already
unchanged so nothing has to be renamed to undo it, and the tracker repin is one pass either way.
Amends: D105 — its rejection of splitting S2 is reversed on the narrow ground that no
renumbering is required; every other clause of D105 stands, including the freeze itself, the
suspension of `/reconcile` and `/track`, implementing against `20-contract.md` as fixed, and
letting the documents go stale until one reconciliation at the end.

### 2026-08-11 — D107 The Codex mapping covers both live transports, `app-server` preferred
Context: S8.2 required `20-contract.md § Vendor mapping — Codex` corrected against observation.
S8.1 found the section's premise false in a way it did not anticipate: the CLI exposes **two**
live interfaces rather than one — `codex app-server` (JSON-RPC 2.0 over stdio, marked
`[experimental]` by the vendor) and `codex exec --json` (non-interactive NDJSON) — and neither
resembles the on-disk rollout schema the section was hypothesised from. Nothing in `10-design.md`
chooses between them; it could not, since neither was known to exist when it was written. The
choice is not cosmetic: item-id uniqueness and the usage basis differ between the two, and only
`app-server` carries a runtime approval request, so picking `exec --json` alone would settle D5
permanently by removing the option rather than by deciding it.
Chosen: map both. `app-server` is primary and `exec --json` is the fallback where the installed
CLI does not offer it. Selection is the adapter's, once, at `create`, and is never visible above
`adapters/*` — a transport is a vendor fact and I20 forbids one above the boundary. The two
places the transports genuinely diverge are declared rather than averaged: `exec --json` emits no
`usage` at all until its basis is probed (`20-contract.md § Unresolved` 12), and its tool
correlation is unspecified because its item ids are a per-turn counter that collides across turns
(`Unresolved` 13, S8.7). Policy stays `preauthorised` and I25 is untouched; the reachable
`on-request` prompt is recorded and not acted on, per S8's *Out of scope*.
Rejected: **`app-server` alone** — the recommendation, and the cleaner contract: thread-scoped
UUID ids, explicit `last`/`total` usage that satisfies D75 by reading rather than subtracting, and
a verified approval round trip. Declined because the vendor marks it `[experimental]`, and a
deployment whose CLI drops or renames it would have no Codex path at all. **`exec --json` alone**
— non-experimental and simpler, and rejected because it buys that stability with three defects:
per-turn ids that fire S8.7, an undetermined usage basis that I28 forbids guessing at, and no
approval record on the wire in any configuration, which forecloses D5 rather than deferring it.
**Exposing the selected transport above the adapter** so callers could branch on the guarantees
that differ — rejected outright as the vendor string above the adapter layer that the design's
governing rule exists to prevent; where a difference cannot be normalised away it is declared
Unresolved, not published. **Inventing the `(turnId, itemId)` composition** that would make the
fallback's ids session-unique — cheap, invisible above the boundary, and probably correct, but
S8.7 reserves it for `/design`, and taking it here would decide open question 7's correlation half
by writing a table.
Reversibility: expensive in one direction only. Dropping the fallback later is cheap — delete a
table and a probe. Dropping `app-server` later is not: the approval path, the delta stream and the
usage basis all rest on it, and D5 would have to be re-decided against a transport that cannot
carry the prompt.

### 2026-08-12 — D108 `StandingRuleExpression` is a local grammar, `"<tool>:<pattern>"`, and the vendor's field stays unread
Context: open question 8 (#16) asked whether `permission_suggestions` is a sufficient grammar for
"always allow". D35 made it blocking rather than nice-to-know, because the matching happens in
this server. S10.1's finding (`design/findings/S10-standing-rule-grammar.md`) answers it, and the
answer is narrower than "insufficient": the field is **unobservable**. A fresh probe against
`claude 2.1.226` on 2026-08-12 reproduced D88 exactly — no `control_request` of any subtype, on
any line, so a field that only ever appears inside one has never existed on any wire this project
can inspect. `anthropics/claude-code#34046` is closed by a stale-bot auto-lock, not a fix, with no
maintainer response anywhere in the thread. The vendor's documented `PermissionUpdate` shape
describes the SDK's in-process `canUseTool` callback, not the `--permission-prompt-tool stdio`
channel this project uses.
Chosen: a local grammar, `"<tool>:<pattern>"` — the tool name compared for equality, the pattern
matched in full against one projected string, anchored both ends, byte-exact and case-sensitive
with no normalisation on either side. `*` is the only metacharacter and matches any run of
characters **except** `;` `&` `|` `<` `>` `` ` `` `$` CR LF, so `Bash:git *` matches
`git push --force` but not `git status && rm -rf /`. No escape, so no rule matches a literal `*`.
Rules are operator-typed at answer time and never parsed from a vendor suggestion.
`permission_suggestions` is retyped `readonly unknown[]` and forwarded verbatim, which reverses
D104's rejection of exactly that retyping — D104 declined it while the grammar was undecided and
the shape might still be adopted; now that the grammar is local and the channel is known dead,
`{ label, rule }` asserts a two-field shape on data nobody has observed, and the branded `rule`
would additionally claim the CLI emits our grammar.
Rejected: **the vendor's `Tool(pattern)` syntax** — it is the CLI's own settings-file grammar,
matched by the CLI before `can_use_tool` would fire, and reusing it implies this server
understands `.claude/settings.json`, `Edit`'s anchor forms and `mcp__*` scoping. It does not; it
matches one string against one glob. **A fuller glob (`**`, `?`, character classes)** — the
separator-crossing distinction that gives `**` meaning is incoherent for a command line, so the
dialect would have to vary per projection kind, which is machinery bought for nothing.
**Plain `*` with no exclusions** — simpler and uniform, rejected because `Bash:git *` would then
grant every command an operator can chain after `git`; the audit record would capture it, but the
approval was not the one given. **Exact equality, no wildcard** — the most conservative option and
still useful, rejected because `10-design.md` explicitly asks for coarse patterns so a standing
approval is "a shape rather than a string". **Deleting `suggestions`** — it has never carried
data and nothing may read it, but forwarding costs nothing and keeps the payload from being
dropped silently if the channel ever starts firing.
Reversibility: cheap in the widening direction — adding a metacharacter, or an exclusion-set
member, is a parser change behind `parseStandingRule`. Expensive in the narrowing direction once
operators have typed rules against the looser form.

### 2026-08-12 — D109 The tool→string projection is the adapter's, carried as `PermissionRequest.matchTarget`
Context: S10.1's proposed grammar needs `match` to project a request's `input` down to one string
— `input.command` for `Bash`, `input.file_path` for `Read`/`Edit`/`Write`. D35 puts matching in
`session-manager`. But that projection table is tool-shape knowledge, and `20-contract.md §
Unresolved` 4 already records that moving tool-shape knowledge into the session manager "is
exactly what the vendor boundary forbids". Worse, `Bash`/`Read`/`Edit`/`Write` are one vendor's
tool names: a table there hard-codes Claude's vocabulary into vendor-neutral code and is wrong the
moment another adapter ships standing rules. The two rulings could not both hold as drawn.
Chosen: the adapter projects. `PermissionRequest` gains `matchTarget: string | null`, emitted
verbatim, and `match(rule, request)` reads only `rule`, `request.tool` and `request.matchTarget` —
never `input` (I46). `null` means the adapter defines no projection, and a `scope: 'always'`
against such a request is `422 bad_request` on `scope` (I43) rather than a rule that matches
everything or nothing by accident. The Claude table carries **four rows**, the four S10.1 names
from observation; every other tool projects `null`, because guessing a field name is the thing
this project stops for. Codex needs no table: it is `preauthorised` and constructs no
`PermissionRequest` at all (I25).
Rejected: **a projection table inside `session-manager`** — nothing new on the wire and one place
to read the grammar, rejected as the boundary violation above. **A new `permissions` module** —
keeps the table out of both, rejected because it still has to know tool shapes, so the boundary
problem moves rather than resolves, and it buys a module boundary and an error type for two pure
functions. **Falling back to a canonical JSON of `input` for unmapped tools** — rejected: it makes
every rule match against a serialisation nobody typed against and whose key order is not
contractual.
Reversibility: cheap. Adding a row is an adapter change. Moving the projection back down into
`session-manager` later would mean deleting a wire field consumers may already render.

### 2026-08-12 — D110 A standing rule is in-memory, session-scoped, allow-only, and dies with the process
Context: `20-contract.md § Unresolved` 2 recorded that the design describes standing approvals and
gives the rule no home — no entity, no field, no file, no lifetime across session end or restart.
S10.5 requires only that a *new* session on the same workspace asks again, which leaves the
rehydration case open: `boot()` restores sessions from disk, so a persisted rule would survive a
restart. Separately, `AnswerScope` and `PermissionDecision` are orthogonal in the type, so
`always` + `deny` is expressible today and nothing ruled on it. Both would otherwise be decided by
whatever the implementing slice happened to do.
Chosen: in-memory session state only — no field on `SessionRecord`, no line in any file, no entry
in `meta.json`. **There is therefore no persisted schema and no migration story, and that is the
ruling rather than an omission.** A session rehydrated at boot holds no rules and the operator is
asked again (I45). `scope: 'always'` additionally requires `decision: 'allow'`; `always` + `deny`
is `422 bad_request` naming `decision`, so the store holds only allow-rules, `match` returns a
boolean, and there is no precedence question to state or test. An auto-approval records the
matched rule verbatim in the existing `AuditRecord.reason`, which lets the record explain itself
without adding a persisted field — I11 already requires the record, and this makes it legible.
Rejected: **persisting rules so a restart is invisible** — rejected because a new persisted shape
needs a home under `meta.json`'s `schemaVersion` and a stated migration story, and more
importantly because a grant surviving in a file outlives the process that could revoke it; ending
the session is the only revocation this design offers, and it must actually revoke. **Supporting
standing denials** — genuinely useful, and denial is the decision this design already treats as
always-safe, but it makes precedence a permanent invariant and puts `scope: 'standing'` on
denials, which S10.4's five-match criterion was not written for. Relaxing this later is additive.
**A new `AuditRecord` field naming the matched rule** — cleaner typing, rejected as a persisted
schema change needing a migration story for a string that `reason` already holds.
Reversibility: cheap in every direction taken. Persisting later is additive; allowing standing
denials later widens a refusal. Neither invalidates a record already written.

### 2026-08-12 — D111 D105's freeze was decided but the marker was never written; the record is corrected, not the tree
Context: D105 states `design/` is frozen for the rest of tier one. `design/FROZEN.md` is the
whole mechanism (`AGENTS.md § The design freeze`) and no commit in this repository's history
ever added it, so every authoring and tracking command since D105 — including the `/track` pass
that found this — has in fact run unfrozen. The decision and the tree disagreed.
Chosen: treat D105 as a decision that was made and never executed, and say so here, rather than
retroactively making the tree match it. The marker is not created by this entry.
Rejected: running `/freeze` now to make `design/FROZEN.md` match D105's intent. Tier two
(S13–S18) is mid-flight with open design questions of its own (S13.1, S15.1) that `/design`
would need to answer before a freeze could honestly claim the tree is settled, and gating
`/design`, `/contract`, `/slices`, `/reconcile` and `/track` immediately, unasked, is a bigger
change than this record needed to make. Freezing, if wanted, is a separate call for `/freeze` to
make deliberately, not a side effect of correcting a stale log entry.
Reversibility: cheap. Running `/freeze` later is unaffected by this entry; it only stops this
particular discrepancy from being rediscovered as a bug.

### 2026-08-12 — D112 Checkpoint restore resets the work-tree with `read-tree`, not `checkout <sha> -- .`
Context: D31 specifies `commit` → `checkout <sha> -- .` → `clean -fd`, and argues the `clean`
is what removes files created after the target. That argument fails against its own first
step. The safety commit runs `add -A`, so every file the agent created is tracked by the time
`checkout` runs; `checkout <sha> -- .` writes only paths the target's tree holds, and `clean`
never removes a tracked path. A file created after the target therefore survives both
operations — the precise failure D31 exists to close, reintroduced by D31's own sequence. S6
found this while implementing and shipped the correction (`src/checkpoints/index.ts`); nothing
in `design/` recorded it, so both `10-design.md` and `20-contract.md` still described a restore
that is known not to restore.
Chosen: `read-tree --reset -u <sha>` as the middle operation, making index and work-tree match
the target exactly — additions, edits and removals alike — without moving `HEAD`, so `list`'s
`git log` still walks a linear shadow history. `clean -fd` is retained behind it for the
directories `read-tree` empties but does not remove. Neither takes `-x`, so D31's symmetry
between what a checkpoint captures and what a restore removes is unchanged. The sequence then
verifies rather than trusting exit codes — `diff --quiet <sha>` for tracked content,
`ls-files --others --exclude-standard` for what was left behind — because `read-tree` exits 0
with only a warning when an embedded repository blocks a directory removal. `20-contract.md`
is amended now; `10-design.md § Data model — Checkpoint` and D31 are the stale side and are
left for `/reconcile`.
Rejected: keeping `checkout <sha> -- .` and widening the `clean` to `-x`. It removes the
tracked-file case only by accident, and it deletes `node_modules`, build output and local env
files — the failure D31 names as the one that would make operators stop using restores.
Rejected `checkout` followed by an explicit removal pass computed from `diff --name-only`:
that is `read-tree --reset -u` reimplemented in this repository, with a race between the two
git invocations that the single builtin does not have. Rejected recording the divergence and
changing neither document: a contract that describes a restore leaving the offending file on
disk would have the implementing agent "fix" the code back to the defect.
Reversibility: cheap in the mechanism, expensive in the evidence — reverting means re-earning
S6's verification that a file created after the target is actually gone.

### 2026-08-12 — D113 `10-design.md` absorbs three slices' worth of contract amendments, in eleven passages
Context: `10-design.md` and `20-contract.md` were last in sync at `4e79b04`. The contract has
since taken three slice-time amendments — `bb1bcae` (S6), `f24e13e` (S8.2/D107), `ec6d59f`
(S10/D108–D110) — plus D112, and the design absorbed none of them, because D105 froze the loop
that would have. `## Open` staged eight places. Reading both documents against the tree found
those eight reach into eleven passages: the five extra are § Prior art's "look at
`permission_suggestions` before inventing", § Identity spaces' "unverified for Codex",
§ Control flow 2's "`permission_suggestions` is where the shape comes from", § Failure modes'
partially-restored row, and § Derived views' burn bullet.
Chosen: rewrite all eleven, direction design ← contract, in one pass. The five unenumerated
ones are included because leaving them means the design's body contradicts its own resolved
open questions — § Identity spaces would still call a *measured* collision "unverified" while
open question 7 four hundred lines below records the measurement.
What each resolved to: open question 4 answered yes on `app-server` only; 6 answered — two
live interfaces, neither matching the rollout schema; 7 measured and **split** — UUIDs on
`app-server`, a colliding per-turn counter on `exec --json`; 8 answered more narrowly than
asked, the field being *unobservable* rather than insufficient; 14's Codex half answered for
`app-server` and left undetermined for the fallback, which now emits no `usage` at all.
Two things this pass deliberately did **not** do. **D5 is not revised.** S8.1 found Codex's
`on-request` prompt reachable, which narrows the asymmetry D5 accepted, but S8's *Out of
scope* reports a reachable prompt rather than acting on one and D5 is `/design`'s; the design
now says the experiment ran and says the decision is unchanged, which are different claims.
And **no open question was closed that the code has not exercised** — 5 (partial messages), 2,
3, 12 and 13 stand as they were.
Rejected: editing only the eight staged places — the five reaching passages would be
rediscovered by the next pass and `## Open` reopened. Rejected marking the open questions
resolved without rewriting the body — the cheapest option, and it leaves a document whose
prose argues against its own answers.
Reversibility: cheap. Nothing here changes behaviour; it changes which of two documents a
future session is misled by.

### 2026-08-12 — D114 `LiveSession` and `Turn` become the shapes the manager actually holds
Context: D112 added `LiveSession` two commits ago so I8 would assert against a declared field.
It did not achieve that. The manager's registry entry is `SessionEntry` — eleven fields — and
its turn was a private `TurnState` with no `startedAt` and a `PendingPermissionState` that
added `matchTarget`. So `LiveSession` named nothing that existed, `Turn` was exported and
imported by no module, and I8 was still stated over an undeclared shape.
Chosen: make the declarations true rather than narrow them. `SessionEntry extends LiveSession`,
so `record` and `turn` are the contract's; `TurnState` is deleted and the manager holds the
contract's `Turn`, stamping the `startedAt` it had been ignoring; `matchTarget` moves onto
`PendingPermission`, where the invariant that reads it (I43) and the field it reads are the
same object. The contract additionally states that the manager's entry *extends* `LiveSession`
with scheduling state deliberately left undeclared — fan-out bookkeeping, the append chain,
the standing-rule list — so "the persisted record plus one field" is not read as exhaustive.
Rejected: narrowing the contract's claim and changing no code. It is honest and it leaves two
declared shapes nothing instantiates, which is how a type becomes decoration. Rejected
reverting D112's first half and pointing I8 back at `10-design.md § Data model — Session` —
relitigates a decision two commits old and restores the exact gap D112 closed.
Rejected declaring `SessionEntry` in full: the contract's own preamble says internal helpers
are out of scope, and a contract enumerating the manager's scheduling state must be amended
every time the manager learns something new about its own turns.
Reversibility: cheap. One field on a type nothing persists, and a rename.

### 2026-08-12 — D115 `POST /api/login` and `GET /api/sessions/:id` are declared, and the cookie's lifetime becomes config
Context: both routes have been served since S2 and appear in no route table — the hard rule
against public interfaces the contract does not carry, broken in two places. The login
exchange is what mints the shared-secret cookie `10-design.md § Security controls` describes
the attributes of while naming no route that sets them. Its `Max-Age` was the literal
`2592000` in the edge.
Chosen: declare both. `POST /api/login` gets its own *Identity* section, stating that it is the
one authenticated-route exception (it mints the credential), that it exists only under
`shared-secret`, and that the origin check still precedes it. `GET /api/sessions/:id` joins the
sessions table as the single-resource read of `SessionSummary` under the same ownership check.
The cookie lifetime becomes `Config.sessionCookieMaxAgeSeconds`, defaulting to thirty days.
The contract also scopes its "all routes require authentication" sentence, which was false of
the four static client assets the same listener serves before any identity is resolved.
Rejected: leaving the lifetime a literal. Shortening a session lifetime is what a deployment
does after an incident, and D103's argument that a buried constant is a cap nobody can change
without a release applies harder to a credential than to a ring size.
Rejected deleting `GET /api/sessions/:id` instead of declaring it: it is the natural
single-resource read, a test already covers it, and removing it means rewriting a passing test
to avoid documenting a route S11's WebSocket edge would want anyway.
Reversibility: cheap for the config field; a declared route is expensive to withdraw once a
client depends on it, which is the argument for declaring the one that already exists.

### 2026-08-12 — D116 Two error-code overloads at the edge are recorded as known, not fixed
Context: `ApiErrorCode` carries no route-level not-found, so an unknown path — and
`POST /api/login` under a header auth mode — answers `404 no_such_session`. Separately,
`SessionError.storage` reaching an edge is reported as `503 agent_unavailable`; every other
storage failure is routed by call site, and what is left is a failure during `create` with no
more specific declared refusal.
Chosen: state both in `20-contract.md § Error semantics` and change neither. The consequence
is written down so a client does not read more into a `404 no_such_session` than it holds — it
distinguishes "no such session", "not yours" and "no such route" in none of the three cases.
Rejected: adding a not-found variant to `ApiErrorCode`. It is additive and correct and its
only caller is a misrouted client; the code change is small and the contract amendment is not,
and an undocumented overload is the defect here rather than the overload itself.
Rejected a `storage_unavailable` variant for the second: one path would use it, and `503` is
already the right status for a transient failure the caller should retry.
Reversibility: cheap in both directions — these are text today and a variant tomorrow.

### 2026-08-12 — D117 `Config.edge` names which transport binds; `edge/ws`'s upgrade handler rides on the returned function
Context: D10 chose transport by deployment mode back in the design phase, but no signature
ever carried the choice — `interface Config` had no field for it, `loadConfig`'s declared
shape was that same `Config`, and `EdgeDeps` gave `edge/sse` and `edge/ws` no discriminator.
`/slice S11` found this mid-implementation: S11.5 ("the edge is chosen by configuration")
names a signature that did not exist. Stopped and reported rather than widening `Config`
unilaterally; directed to proceed anyway rather than route it through `/contract` first.
A second gap surfaced alongside it: `createWsEdge`'s declared return type is
`RequestListener`, but a WebSocket handshake arrives on the `http.Server`'s `'upgrade'`
event, which no `RequestListener` is ever given — `server.on('request', listener)` alone
cannot serve one.
Chosen: add `readonly edge: 'sse' | 'ws'` to `Config`, read from an `EDGE` env var in
`loadConfig` (default `'sse'`, matching every existing deployment's behaviour unchanged).
`createWsEdge` attaches its `'upgrade'`-event handler to the returned function as
`.handleUpgrade`, an implementation-only property that leaves the value still exactly a
valid `RequestListener` to every caller that only calls it as one; `server.ts` reads the
property off and wires `server.on('upgrade', ...)` only when `config.edge === 'ws'`. The
client learns which edge is live from a `<meta name="skynet-edge">` tag on the served
`index.html`, per S11.5's "not by probing" — a meta tag rather than a script, so it costs
the strict CSP nothing.
Rejected: a second contract function (e.g. `createWsUpgradeHandler`) returning the
`'upgrade'`-event handler directly — rejected because it forces every caller to know it
must call two functions and wire two listeners to get one edge working, where a single
factory that hands back both faces is one fewer thing to get wrong at the composition
root. Rejected probing (client tries `EventSource`, falls back to `WebSocket` on failure)
for S11.5's own stated reason: it is probing, and it means the client's first attempt on a
proxied deployment is always a failure. Rejected a `first-message` auth token scheme
distinct from the existing header/cookie identity (the Open WebUI precedent in D10 uses
`{"type":"auth","token":"<jwt>"}`) — this deployment's WebSocket handshake carries the same
headers and cookies any other request does, so `edge/ws` resolves `OperatorId` from those,
deferred to just after the first client frame arrives rather than at the handshake itself,
which is what makes "first-message auth resolves the same `OperatorId` ... from the same
credentials" (S11.3) true without inventing a second credential.
Reversibility: cheap. `edge: 'sse'` is the default, so no existing deployment's behaviour
changes; a deployment that sets `EDGE=ws` can revert by unsetting it.

### 2026-08-13 — D118 Kit re-install: AGENTS.md merged forward, cores taken outright
Context: `/install` against `SubZeroDev.AgentKit` at `2b706ca` (previously synced at `af610a6`,
25 commits behind). `Sync-Kit.ps1 -DryRun` found zero target edits to any command file, so all
21 `.claude/commands/*.md` plus `tools/Sync-Kit.ps1` applied outright, and `.claude/COMPANIONS.md`
plus the four new `tools/Test-*.ps1` validators (Companion, DesignDrift, VerifyReport,
WriteSurface, each with its `.Tests.ps1`) were added new. `AGENTS.md` had drifted from the kit's
content since the last install — missing the Vendor model aliases table, the Third-party text
rule, the descriptive-drift clause in *Source of truth* and *Hard rules*, and the
*Single ownership* "a document states only what the tree cannot" bullet.
Chosen: merged the missing kit sections into the existing structure, keeping this repository's
`## Project identity` section and its `Hard rules`-after-`The design freeze` ordering untouched.
Also adopted the kit's newer `20-contract.md` line ("invariants, error semantics, and the
surface the tree cannot state") in place of this repo's older "types, schemas, signatures,
error semantics" phrasing, for consistency with the kit's current standard description of that
document's role.
Rejected: leaving `AGENTS.md` as-is for this install — would have left the newer vendor-alias
and third-party-text gating rules unenforced here with no record of why. Rejected reordering
`Hard rules` to match the kit's current position (before `The design freeze`) — pure structural
churn with no rule content behind it; not worth the diff.
Reversibility: cheap. Wording only; no behavioural change to code, and a later install can
re-merge or re-word freely.

### 2026-08-13 — D119 `GET /api/audit` served by `session-manager.readAudit`
Context: S12.1 (`30-slices.md`) and `## Unresolved` 5 (`20-contract.md`) left `GET /api/audit`'s
owner undecided: `10-design.md § Module boundaries` gives the audit/incident read to `records`,
but `records` is tier two and does not exist yet when tier one's `GET /api/audit` must already
work, and an edge may not call `store` directly. The slice itself stops until this lands.
Chosen: `session-manager.readAudit(query)`, a pure delegation to `Store.readAuditPage`. It takes
no `owner` and applies no ownership check, unlike every other method on that interface —
D70 already opens this read to every authenticated operator regardless of session ownership.
S17 (tier two) reuses the same method with `incidentsOnly: true` rather than duplicating it
on `records`.
Rejected: giving the route to `records` early — would mean building part of tier two's
registry module just to serve a tier-one read, which is exactly what S12.1 says tier one must
not need. Rejected letting `edge/sse`/`edge/ws` depend on `store` directly for this one route
— every edge's dependency set is `config`, `session-manager`, `records`, `identity`, `contract`
(`10-design.md § Module boundaries`), and carving out a single-route exception there is a
bigger, less local change than one extra method on a module edges already depend on.
Reversibility: cheap. `readAudit` is a one-line delegation; moving it onto `records` once that
module exists (if `## Unresolved` 5's tier-two duplication concern is ever revisited) touches
one call site in each edge and nothing else.

### 2026-08-13 — D120 A record-log mutation claims an exclusivity lock, never the state itself; the append settles first
Context: `## Unresolved` 7 (`20-contract.md`, #31) named a real contradiction, and closing #31 and
#35 did not fix it — both were closed citing decisions (D83, D87) that discuss unrelated topics
(review ordering by `updatedAt`; the spike's contract divergence) and contain none of the
resolution text their closing comments quote. The contradiction is still live in
`10-design.md`: *The single-writer invariant* table said a requisition's decision claims its
guard synchronously before `await store.appendRequisition` and releases on nothing, because "a
decision is terminal" — meaning the guard's value is the decided `state` itself, set in memory
before the write. *Records boundary*, four sections later, said the opposite for the same
write: a failed append "must not mutate the registry", and the ordering is deliberately the
reverse of the audit path's (D26) — file first, registry follows — because neither write is
irreversible and a lost edit is a smaller failure than a registry claiming a `state` the disk
does not have.
Chosen: the two tables were each partly right and describing different things. A requisition's
decision and a review's mutation each claim, synchronously and before the `await` on their
append, an **exclusivity lock — a marker distinct from `state`** — so a second decision or a
second append for the same id is refused before either write's `await` resolves (D32 still
holds: no `await` sits between the check and the thing it protects, and the thing it protects is
now named correctly as the lock, not the state). The lock releases when the append settles,
success or failure alike. `state` (`decidedBy`/`decidedAt` on a requisition; the appended line
and `final` on a review) changes only after the append durably succeeds — matching Records
boundary's rule exactly, and matching `RecordsError.storage`'s existing text ("the registry is
not mutated") and `Records.decide`/`Records.appendReview`/`Records.finaliseReview`'s async
signatures in `20-contract.md`, which already return only after the store call settles. Nothing
in the contract's shape needed to change; the design's prose was the only place carrying the
contradiction.
Rejected: the turn slot's and workspace claim's shape (state set synchronously, reverted on
failure) applied unchanged to record decisions — this is what the original, uncorrected table
row did, and it is exactly what Records boundary's rule forbids: a window exists, between the
synchronous claim and the awaited append, where the registry disagrees with the disk, and a
crash in that window is a torn-tail-shaped defect (#33's sibling) rather than the retypable loss
Records boundary is written to guarantee.
Rejected: dropping the synchronous guard and relying on the append's own ordering — two decisions
dispatched in the same tick would both pass the in-memory `state == 'open'` check before either
append lands, and both would append a decision. D32's rule exists precisely because "the file
write settles it" is false when two writers can both start one.
Reversibility: cheap. This corrects `10-design.md` prose (*The single-writer invariant* table and
its surrounding paragraph) and `20-contract.md § Unresolved` 7's status; no signature in the
contract changes, so no code built against the current signatures is affected.

### 2026-08-13 — D121 Kit re-install: two-commit AGENTS.md gap merged forward
Context: `/install` against `SubZeroDev.AgentKit` at `6bdd8dc` (previously synced at `2b706ca`,
recorded by D118's install, 2 commits behind). `Sync-Kit.ps1 -DryRun` found zero upstream changes
to any command file, tool script, or `.claude/COMPANIONS.md` — the two new kit commits touched
only `AGENTS.md` (and the kit's own `design/90-decisions.md`, never installed). The gap: the
*Model, effort, and review budget* tier-comparison paragraph was missing the "comparison is
always by tier, never by literal name" clarification and its `Terra`/`sonnet,medium` worked
example, and *Vendor model aliases* was missing the `GPT-5 → Implementation` row. `agent.md`'s
apparent gap (missing the kit's D105/D111 freeze-marker lesson, its D31 restore lesson, and its
`permission_suggestions`/`--permission-prompt-tool` lesson) is not a real gap — all three trace by
decision ID back to this repository's own `D31`, `D105`, and `D111` entries above, so per the
provenance rule they are correctly absent rather than offered back.
Chosen: merged both `AGENTS.md` paragraphs forward in place, at this repository's existing
section positions — `## Project identity` and the `Hard rules`-after-`The design freeze` ordering
from D118 both left untouched.
Rejected: leaving `AGENTS.md` as-is — would leave the tier-vs-literal-name distinction and the
`GPT-5` alias unstated here, with the *Vendor model aliases* table then contradicting its own
lead sentence (which lists `GPT-5` in the text kit ships, once merged) had only the second edit
been taken and not the first.
Reversibility: cheap. Wording only; no behavioural change to code, and a later install can
re-merge or re-word freely.

### 2026-08-13 — D122 The checklist applies to every session, and ticking is refused once the session has ended
Context: issue #41 (S14.1's stop condition) found the checklist-tick route, as drawn, checks only
ownership and the template — no session-state refusal, unlike every other route that writes to a
session, and no eligibility rule for which sessions get a checklist at all. #41 was closed citing
`D93` as the resolution; `D93` is "An auth mode is required in every configuration," unrelated,
and no other decision in this log states either rule. The question #41 was meant to settle was
never actually decided.
Chosen: the checklist applies to every session, not only ones opened through a requisition — the
template is global configuration (D71), tier one has no requisitions at all, and brief item 10's
first-run checklist is not a tier-two feature. Ticking is refused on an ended session,
`409 session_ended`, matching the refusal every other session-write route already gives (D36's
pattern).
Rejected: gating the checklist to requisition-opened sessions — would make a tier-one session's
onboarding conditional on a tier-two feature that may not even be enabled, and nothing in the data
model currently carries a field to gate on. Leaving ticking permitted after the session ends —
every other write to a session already refuses post-end; an unexplained exception here is an
omission, not a design choice with a reason behind it.
Reversibility: cheap. A later eligibility field could still narrow this without changing the
route's shape.

### 2026-08-13 — D123 The child handle leaves `Turn`; the adapter is its only owner
Context: `10-design.md § Data model — Turn` listed a `child | process handle` row and typed
`pending` as `Map<RequestId, {callId}>`. `20-contract.md § Turn` declared neither, stated both
as divergences, and deferred the child one to `/reconcile` by name. The tree agrees with the
contract: `Turn` is `{turnId, phase, startedAt, pending}`, the child is spawned inside
`Adapter.send`, and the manager reaches it only through `adapter.kill()`.
Chosen: the design changes. The `child` row is removed and the section states that the child is
turn-scoped (D16) and adapter-owned, and that shape is `20-contract.md`'s. `pending` is four
fields, which the contract had already ruled settled — `answerPermission` needs `tool`, `input`
and `matchTarget` to enforce I43 and append I11's record without re-reading the request, which
would put tool-shape knowledge in `session-manager` and break I46 (D109).
Rejected: putting a handle on the live `Turn` to match the design. It gives `session-manager` a
second reference to a process `20-contract.md § adapters/*` names the adapter the sole owner
of, and it reopens the leaf-adapter argument *Module boundaries* rests on. Rejected leaving the
divergence stated — it is what made this finding reappear on every pass, which is the cost the
lesson below names.
Reversibility: cheap in the document; expensive in code once anything reads such a handle,
which is the argument for closing it in the direction the tree already runs.

### 2026-08-13 — D124 I5 governs six guards, and both documents say six
Context: `20-contract.md` I5 enumerated five — turn slot, workspace claim, requisition decision,
requisition consumption, checklist completion. `10-design.md § The single-writer invariant`
enumerated a different five, with a review's mutation in place of the checklist. Both guards are
real: the checklist claim is taken synchronously before `emit`'s first `await` and is what makes
I36 hold, and the review lock is D120's. Each document had silently dropped the other's.
Chosen: six, enumerated identically in both. The guard table gains a checklist row and says how
that guard is shaped — state-marked-then-reverted, like the turn slot, not lock-shaped like the
decision and the review append. D120's paragraph is corrected from "adds three guards, one of
them" to "adds four, two of them", which is what it already described.
Rejected: dropping the review lock from I5 — S15 would then implement a guard no invariant
asserts, and D120's own argument that it is the same rule as the turn slot stops being
expressible. Rejected dropping the checklist — the synchronous claim is exactly D32's shape and
removing it from I5 hides why it must not move after the `await`.
Reversibility: cheap. Text in two places, no code change; the guards themselves already exist.

### 2026-08-13 — D125 An unknown route's answer is split by prefix, and the contract says which
Context: `20-contract.md § Error semantics` and D116 both state that a path this build does not
serve answers `404 no_such_session`. Only paths outside `/api/` do. Every unrecognised path
under `/api/`, and every unrecognised sub-route under an existing session id, answers
`422 bad_request` naming the path — behaviour that landed in S2a–S2d and therefore predates
D116, whose context sentence was already false when it was written.
Chosen: the contract changes to describe the split, and states the consequence of each half —
the `404`'s three-way ambiguity, and that a `422` from a session sub-route means "no such route
in this build" and must not be read as "no such session".
Rejected: making the code answer `404` everywhere. It deletes the one signal distinguishing a
missing route from a session that is not yours, and rewrites passing tests to lose information.
Rejected adding `no_such_route` to `ApiErrorCode` — D116 weighed and rejected exactly that, and
nothing since has changed the balance; overturning it needs a reason this pass does not have.
Reversibility: cheap. Text today, a variant tomorrow, as D116 already says.

### 2026-08-13 — D126 Fourteen modules: the two edges compose through a shared third
Context: `src/edge/http-common` and `src/edge/error-envelope` are shipped modules appearing in
neither the module table nor the dependency graph, which still said twelve. `http-common` is not
a helper — it owns the origin check (I24), identity resolution, `POST /api/login`, body reading,
the `AuditQuery` parse, and the requisition and checklist handlers, all of which the table
attributed to `edge/sse` and `edge/ws` themselves. It also imports `VENDORS` from `adapters`, an
arrow the graph did not draw.
Chosen: the design changes. Both modules join the graph and the table; the ownership column
moves what they own off the two edges, leaving each edge exactly its own transport and routing
table; and the `http-common → adapters` arrow is drawn with a paragraph saying why it is not an
I20 violation — validating membership of `Vendor` is not asking which vendor this is. The
reading D10 permits is stated rather than left implicit: it forbids the two edges importing each
other, not a third module both compose through.
Rejected: removing the `VENDORS` import and enumerating `Vendor`'s members a second time at the
edge or in `contract`. It buys a tidier graph at the cost of the drift that enumeration exists
to prevent — the list lives beside the `createAdapter` switch that makes each member runnable.
Rejected calling both modules private helpers and leaving the table at twelve: the origin check
is an invariant with a named owner, and the table would keep naming the wrong one.
Reversibility: cheap. Documentation of structure that already exists.

### 2026-08-13 — D127 `session-manager.getSnapshotForReview` reads a session with no ownership check
Context: `## Unresolved` 6 (#32) named a real contradiction: the threat model says writing a
review about another operator's session is deliberately open, while the only existing route to
a session applies the ownership check and answers `404` to a non-owner. `records.createReview`
already takes the snapshot as a parameter (D77); nothing supplied one for a session the caller
does not own.
Chosen: `SessionManager` gains `getSnapshotForReview(sessionId): SessionSnapshot | null`,
shaped exactly like `readAudit` (`## Unresolved` 5, #34, resolved by S12) — no owner parameter,
no ownership check, `null` for a session that does not exist, which `POST /api/reviews` turns
into `404 no_such_session`. The precedent is direct: D70 already opens both audit reads and
review reads/writes to every operator regardless of session ownership, and `readAudit` is the
existing answer to "how does a tier-one-owned method serve a tier-two route without applying
the per-session ownership check."
Rejected: a variant of `get`/`message` that takes an `ignoreOwnership` flag — it puts a footgun
on the one method everything else legitimately calls with ownership enforced, for the sake of
avoiding one new method name.
Rejected: resolving the session inside `records` itself — `records.createReview`'s own comment
already states "`records` never resolves a session," and giving it a `store`/session dependency
to do so would cross the boundary `## Unresolved` 5 drew for the opposite direction.
Reversibility: cheap. One new method, no change to an existing signature.

### 2026-08-13 — D128 A review's finalising line is fsync'd before the response, closing the retraction gap I29 leaves open
Context: `## Unresolved` 10 (#35, #36) named two halves. The first — whether finalisation
claims a guard at all — was already closed by D120 and D124: `finaliseReview` claims the same
synchronous lock as `appendReview`, named among I5's six guards. What remained is mechanism:
`10-design.md § Persistence summary` (D65) accepts, for both record logs generally, that a
torn trailing line reverts the previous line to authoritative — a requisition's consumption can
un-happen and D68's own text says so in writing. I29 carries no matching exception: it states,
unqualified, that a review's `state` moves `draft → final` and never back. A torn tail
reverting an acknowledged `final` review to `draft` would silently break a stated invariant,
not merely repeat an accepted, written-down cost the way the requisition case does — and unlike
a requisition's bookkeeping lie, a retracted review may already have been read by other
operators and may already have raised a PIP badge they saw.
Chosen: `Store.appendReview` is durable — fsync'd before it returns — for every line, matching
`appendAudit`'s existing shape and D26's "durable before the response reaches the caller"
argument, extended here to `finaliseReview`'s response rather than a permission decision.
Because `finaliseReview` and `appendReview` (the draft-edit path) share the one store method,
every review line is fsync'd, not only the finalising one; the cost argument that exempts
ordinary spill events (`10-design.md` line ~820, "unjustifiable at event rates") does not apply
here; reviews are human-paced and kilobytes, the same basis already used to reject an offset
index for the record logs. Consequence: once a caller has received a `200`/`201` for any review
route, that line survives a subsequent host crash, so the reversion `## Unresolved` 10 worried
about can only ever hit a write the caller was never told succeeded — which is the same
durable-before-ack shape I10 already establishes for `AuditRecord`, applied to the one record
log carrying an invariant strict enough to need it.
Rejected: leaving `appendReview` un-fsync'd and adding a separate, fsync'd path only
`finaliseReview` calls — two store methods writing the same file for one difference in
durability is the extra surface D65's own reasoning (avoid a second write protocol, a second
torn-write story) argues against, for a cost this file's size does not justify avoiding.
Rejected: applying the same fix to `appendRequisition` — no invariant on a requisition is
written as absolutely as I29, D68 already accepts and documents the loss, and widening the fix
unasked is exactly the kind of scope this session was told to leave alone.
Reversibility: cheap. One store method's durability changes; no signature changes shape.

### 2026-08-13 — D129 `remainingTokens` subtracts `burn`'s full component-wise sum, cache included
Context: `## Unresolved` 8 (#29, #30) left `PayrollView.remainingTokens` with `burn` determined
(a component-wise sum) but the subtraction itself open: nothing said whether cache reads and
cache creation count against the budget alongside input and output tokens. S16.2 stops the
slice until both this and the budget's scope have landed; the scope half was already resolved
by #29 (per session). Raised during `/slice S16`, decided by the owner in-session rather than
guessed.
Chosen: `remainingTokens = budgetTokens - total(burn)`, where `total` sums every `Usage` field —
input, output, cache reads, cache creation. Consistent with `burn` already being the complete
component-wise sum; a budget that ignored cache tokens would understate real spend, since cache
reads and creation are billed by every vendor observed so far.
Rejected: subtracting only input and output, treating cache tokens as budget-neutral. Would need
a second scalar alongside `burn` with no name anywhere in the contract, and there is no stated
reason to treat cache tokens as free — they cost the deployment even when they discount the
vendor's own bill.
Reversibility: cheap. A read-time computation over an existing, already-durable fold; no
persisted schema or signature changes shape, so a later change of basis only changes what one
route returns.

### 2026-08-13 — D130 Boot marks a restart with a `session.notice`, and that notice is the payroll fold's only drop marker
Context: D76 drops any idle interval containing a restart, and its only signal is `turn.ended
{ stopReason: 'server_restart' }`, which D39's boot appends *only* where the spill ends on an
unpaired `turn.started`. A server that goes down while a session is idle between turns leaves no
marker at all, and boot still synthesises `endedAt` as the boot timestamp — so `foldPayroll` bills
the whole outage as that operator's idle time and reports `droppedIntervals: 0`. That is the number
*Derived views* says must not be silently wrong, and D76's own text never considers the case. Found
by `/code-review` on S16; S16.7's criterion as written is met, so this is a gap in the criterion
rather than a defect in the slice.
Chosen: a new `SessionNoticeCode` for the restart, emitted by boot as one `session.notice` per
session that was **live** at shutdown — not for sessions already ended, which would append to every
dead session's spill on every restart. The payroll fold's rule becomes *drop the interval ending at
a restart notice*, and `turn.ended { server_restart }` stops carrying fold meaning: one marker, one
rule, both cases. The mid-turn case consequently reports `droppedIntervals: 0`, because an outage
inside an open turn was never billed as idle — that is D76's "either the turn or the idle gap after
it, depending on where you cut" finally cut, in favour of the turn.
Rejected: a durable `endReason` on `meta.json` stamped `server_restart` at boot. It is the better
*root* fix — `endedAt` is fabricated at boot and every future consumer inherits that, not only
payroll — but it is invisible to the operator, and a transcript showing nothing where an outage was
is the quiet degradation this design refuses. It composes with this decision rather than competing,
and is worth its own item.
Rejected: accepting the gap and amending D76 and S16.7 to say only mid-turn restarts are
detectable. `10-design.md § Derived views` has already ruled against it twice.
Rejected: `session.ended { reason: 'server_restart' }`. Forbidden by `20-contract.md`'s note under
`SessionEndReason` — D45's rejected alternative, retained knowingly. This decision leaves that
undisturbed: a notice is not an end reason, and boot still ends a rehydrated session without saying
why on the wire.
Rejected: inferring the outage from host uptime. D76's own named rejected alternative for this
exact problem.
Reversibility: cheap. One enum value, one boot emission scoped to live-at-shutdown sessions, and a
fold rule; nothing persisted changes shape.

### 2026-08-14 — D131 `Caps.auditPageMax` bounds records examined, not only records returned
Context: `20-contract.md § store` promises `readAuditPage` is "bounded; never a whole-file scan"
and I39 says "Nothing scans the whole file", but `readAuditPageImpl` stopped only on
`records.length >= limit`. A query with a filter — `incidentsOnly`, a `sessionId`, a `since` —
that matched fewer than `limit` records therefore walked backward to byte 0. The incident view of
brief item 11 is precisely that query, and `audit.ndjson` is precisely the file D73 bounded the
read of because it grows for the deployment's lifetime and is never truncated. The S12.9
performance test asserted the bound only for an unfiltered query, where every record matches and
the two bounds coincide, so nothing caught it.
Chosen: a read stops at whichever comes first — `limit` matches, or `Caps.auditPageMax` records
*inspected* — and mints a `nextCursor` at the same kind of line boundary either way. The cap is
reused rather than a second one added, because I39 already names it as the bound on the read. The
visible consequence is that a page may be short, or empty, with a cursor still to follow, so
`nextCursor === null` becomes the only end-of-log signal; `20-contract.md § Audit` states that and
the client's "no records" message now waits for it.
Rejected: a separate byte or line budget in `Caps`. A second knob for one call site, and I39
already binds this read to `auditPageMax` by name.
Rejected: narrowing I39 to a bound on the result rather than the read. That concedes exactly the
permanently-degrading screen D73 exists to prevent, on the one file that never stops growing.
Rejected: an offset index now. Issue #19 carries it, it constrains the file format, and the bound
is what D73 says makes it not yet necessary.
Reversibility: cheap. One stop condition in `store`; no persisted shape changes and `AuditCursor`
stays opaque.

### 2026-08-14 — D132 Both jail failures answer `409 outside_workspace_root`
Context: the contract's error table routes `JailError.unresolvable` to `409
outside_workspace_root` — "The jail admits only paths *proven* inside a root" — and
`edge/http-common`'s `apiErrorFor` answered `422 bad_request` naming `cwd`, with a comment
arguing that a path which was never resolved was not rejected by the jail. Nothing recorded the
divergence.
Chosen: the contract's mapping. Both failures answer `409 outside_workspace_root`; only the
`outside_workspace_root` branch carries `detail.roots`, because `unresolvable` has none to carry.
The property this protects is that `POST /api/sessions` cannot be used to tell "no such
directory" from "outside every root" — without it, any authenticated operator has a filesystem
existence probe over the whole host, which is the concealment D50 and the jail's own wording
assume. D68's requisition story depends on the same code being the answer at spend time.
Rejected: keeping `422 bad_request`. More accurate to the operator who typed a path wrong, and it
publishes the existence of every path outside the roots to every operator; the threat model does
not list that as accepted.
Rejected: a third code distinguishing the two. It publishes the same bit with extra ceremony.
Reversibility: cheap in code, awkward in the log — a client written against the looser refusal
would have to be revisited.

### 2026-08-14 — D133 D102 lands, and reuses `adapter_unknown_record` rather than widening `ErrorEventKind`
Context: D102 (2026-08-09) chose to treat a turn-scoped fact arriving with no live turn as an
error rather than an invented value, naming two exact lines. Neither changed. `appendPid` still
wrote `entry.turn?.turnId ?? randomUUID()`, putting an id naming no turn into `pids.ndjson` where
the boot reaper reads it as fact; and a turn-scoped payload arriving after the slot was freed
still went out with no `turnId`, which the contract declares non-optional on every one of them
and which, for `permission.request`, also means the request never enters `pending` and is never
resolved (I9).
Chosen: implement D102 as written. Both sites emit a non-fatal `error` envelope naming the
condition; the pid record is refused rather than written with a minted id, and the malformed
event is dropped with the original preserved in `raw`. The envelope's `kind` is
`adapter_unknown_record`, which is an overload — the condition is the manager's, not an
adapter's — taken because `ErrorEventKind` is a closed vocabulary (D44) and widening it is
`/contract`'s, not a reconciliation's.
Rejected: a new `ErrorEventKind` for it. More honest on the wire and the right eventual shape;
it is a contract amendment to a closed union and does not belong in this pass. Recorded here so
the overload is deliberate rather than discovered.
Rejected: writing the pid record with a placeholder id so boot can still reap the child. It is
the fabricated value D102 refuses, and the only reachable path to it — a spill failure clearing
the slot mid-turn — already kills the child on its own.
Reversibility: cheap.

### 2026-08-14 — D134 The ring is dropped whenever the spill can no longer back it
Context: I2 says the ring buffer's contents are a strict suffix of the spill's, and two paths
broke it. `emit` pushes to the ring synchronously and appends asynchronously, so a failed append
(D41) left in the ring the one envelope the spill would never hold, servable to any later
reconnect. And `remove()` deleted the storage and the registry entry but never the ring, so a
deleted session's envelopes stayed in memory for the life of the process — with `Store.dropRing`
declared in the contract and called from nowhere.
Chosen: call `dropRing` in both places — the whole ring, not the offending envelope. A ring that
has been dropped makes `readRingAfter` answer `null`, which sends every replay to the spill, and
the spill is the authority wherever the two disagree (D37's rule, D40's read path). Keeping a
truncated ring would leave a structure whose suffix property holds only by argument rather than
by construction.
Rejected: popping just the failed envelope. Restores I2 literally and leaves the ring live on a
session that is ending, so the next reconnect is served from memory rather than from the
transcript that is now shorter than it — the divergence, moved.
Rejected: weakening I2 and deleting `dropRing`. It gives up the property D40 spends to make ring
and spill interchangeable for reads, which is the whole argument that replay is truthful.
Reversibility: cheap.

### 2026-08-14 — D135 Restore is refused on an ended session, and the contract declares it
Context: `session-manager.restore` refuses `409 session_ended`, a refusal the route's table did
not list and which `SessionError.session_ended`'s row described only as "a message to a session
in state `ended`". `30-slices.md § S6` compounds it, putting "restoring a workspace held by
another session" out of scope on the grounds that S5.7 makes it impossible — which is true for
live sessions and false for ended ones, since an ended session keeps its `cwd` and the busy check
excludes only `state === 'live'` (D30).
Chosen: the code is right and the contract is the stale side. `POST
/api/sessions/:id/checkpoint/restore` declares `409 session_ended`, and the error table's row
names all three writes it now covers, with the reason. Dropping the guard instead would let a
rehydrated session run `read-tree --reset -u` against a work-tree a *different* live session now
owns, which is the silent cross-session revert D19 and D30 exist to close.
Rejected: dropping the guard to match the table as written. Restores parity between browsable
and restorable for rehydrated sessions, at the cost of the one hazard the workspace rule is for.
Rejected: routing the added refusal to `/contract` as an amendment pass. The refusal already
ships; leaving it undeclared for a pass is the state a client can actually trip over.
Reversibility: expensive-ish — this is a declared refusal on a public route, so removing it later
is a compatibility question rather than an edit.

### 2026-08-14 — D136 A review's in-flight append answers `review_final`
Context: D120 gave a requisition's decision and a review's mutation an exclusivity lock claimed
synchronously before the append, and named what a *requisition* collision answers —
`already_decided`, "reporting the outcome the in-flight decision is about to produce", which that
code's declared meaning genuinely covers. It said nothing about reviews, and `records` answers a
review lock collision with `review_final`, whose declared meaning — "a final review accepts no
further append" — is false in that case: the review is a draft, and the caller may retry and
succeed.
Chosen: widen `review_final`'s declared meaning to cover both, matching the shape D120 already
blessed for requisitions. The two record-log locks then answer symmetrically, and the contract
says plainly that the code is terminal in one case and retryable in the other.
Rejected: a distinct `ApiErrorCode` for a record-log write already in flight. The honest answer,
since a retry is meaningful in one case and not the other; it adds to a union the contract keeps
deliberately small, against D116's precedent of recording an overload rather than multiplying
codes, and adding it is `/contract`'s.
Rejected: answering `RecordsError.storage` or `bad_request` instead. Both are equally wrong about
what happened, and `storage` would report a failed write where none was attempted.
Reversibility: cheap; nothing persisted and no signature changes.

### 2026-08-15 — D137 D130 lands, and the restart notice is appended before boot's synthetic turn close
Context: D130 (2026-08-13) was decided, recorded, and never delivered. `SessionNoticeCode` carried
no restart member in either `20-contract.md` or `src/contract/index.ts`, boot emitted no notice, and
`foldPayroll` still keyed on `turn.ended { stopReason: 'server_restart' }` — the D76 rule D130
supersedes. `10-design.md` still stated that rule in two places. Found by `/reconcile` reading the
decision log against the tree, three slices after the decision was taken; nothing else could have
found it, because no slice, issue or `## Open` entry carried it and no gate fails on a decision that
was never implemented. The defect D130 names was live throughout: a server that went down while a
session sat idle between turns billed the whole outage as that operator's idle time and reported
`droppedIntervals: 0`.
Chosen: implement D130 as written, and settle the two things it left to the implementer. The code is
spelled `server_restart` at `level: 'warn'`, emitted once per session found `live` on disk at boot
and never for one already `ended` — which makes it idempotent across restarts for free, since the
first boot writes `state: 'ended'`. And the notice is appended **before** step 3's D39 turn close,
which is what makes D130's "one marker, one rule, both cases" actually hold: the fold stops billing
at the notice and drops the interval that notice closes *if one was open*. Idle at shutdown leaves an
interval open, so it is dropped and counted; mid-turn leaves none, because `turn.started` cleared the
cursor and the close has not been appended yet, so nothing is dropped and the outage stays attributed
to the turn — D130's stated `droppedIntervals: 0`. `turn.ended`'s stop reason consequently carries no
fold meaning, exactly as D130 requires, and the fold reads a `restarted` flag rather than that field
so boot's own close cannot open a fresh interval at the boot clock.
Rejected: appending the notice after the turn close. The natural order — boot finishes repairing the
turn, then says why — and it collapses D130's two cases into one: the interval the notice closes is
then boot's own millisecond between the synthetic `turn.ended` and the notice, which reports
`droppedIntervals: 1` for the mid-turn case D130 says must report zero. Recovering the distinction
after that needs the fold to read `turn.ended { server_restart }` again, which is the marker D130
removed.
Rejected: a durable `endReason` on `meta.json`. D130 already rejected it as the better *root* fix and
a separate item — `endedAt` is fabricated at boot and every future consumer inherits that, not only
payroll. Unchanged by this: it composes rather than competes.
Rejected: leaving `SessionEndReason`'s `server_restart` note alone. It reads "**No envelope carries
`server_restart`**", which this makes false by spelling. Narrowed to "no `session.ended` carries" it,
with the distinction stated — a notice marks where the outage fell and is not a claim about why the
session ended, which is what keeps D45's retained-knowingly value retained and knowing.
Reversibility: cheap. One enum member, one boot emission, one fold rule; nothing persisted changes
shape and no signature moves.

### 2026-08-18 — D138 The Codex mapping table is reconciled to the adapter, in both directions at once
Context: `/reconcile` read `20-contract.md § Vendor mapping — Codex` against
`src/adapters/codex/index.ts` and found the table wrong twice, in opposite directions. The
`app-server` row for `turn/completed` mapped it to `usage` (from `last`) and to `turn.ended` with
`stopReason: 'completed'`; the adapter emits neither the `usage` nor two of the three stop reasons
it actually produces. And the `exec --json` rows for `item.started`/`item.completed`
`command_execution` mapped a `tool.call`/`tool.result` pair that the same section's *Item ids*
subsection, forty lines below, says is "not specified here" and that S8.7 stopped before
implementing. The tree followed the prose; a reader consulting the table would not have.
Chosen: correct the table on all three counts. `turn/completed` maps to `turn.ended` alone, with
`stopReason` from `turn.status` over `completed | interrupted | error` and `schema_mismatch` for
anything else; its `last` is marked not mapped, and *Usage* now carries why. The two
`command_execution` rows collapse to one row reading *not mapped — recognised and dropped,
deliberately*, naming what is present on the item and what is missing (a session-unique `CallId`)
and pointing at `## Unresolved` 13.
The usage half is the one that mattered: S8.1 observed **both** `turn/completed` and
`thread/tokenUsage/updated` carrying `last`, and `last` is that turn's own marginal figure by
either route. Implementing the row literally therefore emits two `usage` envelopes carrying one
turn's burn into a fold that sums them (`session-manager.foldPayroll`), double-counting on the one
screen headed *payroll* — the failure I28 and D75 exist to prevent. Which of the two records is
read is arbitrary; reading only one is not, and the contract said nothing about that until now.
Rejected: changing the adapter to emit `usage` from `turn/completed` as well. It satisfies a table
row nothing asked for, at the cost of the payroll number, unless the adapter also de-duplicates
the two — machinery the Claude adapter already needed for `message.id`, and no reason to build it
here.
Rejected: deleting the two `exec --json` rows outright. Marking them reserved keeps the work
visible in the place a reader looks for it; deleting them makes the fallback's missing correlation
discoverable only from `## Unresolved`.
Reversibility: cheap. Documentation only; no signature and no behaviour moves.

### 2026-08-18 — D139 An unproduced union member is annotated, never quietly left
Context: the same pass found five values in `20-contract.md` with no producer anywhere in the tree.
Two — `SessionEndReason.'server_restart'` and `SessionStarted.state` — already carry explicit
retained-knowingly notes and were fine. Three did not: `SessionNoticeCode.'sandbox'`,
`PermissionResolvedReason.'superseded'` (the only member of its union with no comment at all), and
`ErrorEventKind.'agent_unavailable'` — and separating "dead by choice" from "dead by omission" took
a grep-and-trace per value, with a different answer each time. `'agent_unavailable'` turned out to
be the third kind: behaviour both documents promise and nothing delivers, which is D143's.
Chosen: annotate rather than remove, in `20-contract.md` and in `src/contract/index.ts` alike, in
the shape the two already-noted values set. `'sandbox'` is superseded by `PermissionPolicy.banner`,
which the client renders instead and which survives a replay because it is a session field rather
than an envelope (S8.3). `'superseded'` is reserved rather than dead: nothing resolves one request
because another replaced it, and until such a path exists it must not be repurposed. **The standing
rule this sets: a union member with no producer states so in its own comment, or the member goes.**
Two more corrections ride along, both the same species. `GET /api/audit`'s route row declared `401`
and `422` and the handler answers `503 agent_unavailable` on a storage failure — the row gains the
cell, because that is the treatment `SessionError.storage` already gets everywhere else in the
document. And `pids.ndjson`'s bolded "a reader folds the two shapes; it does not treat the latest
line as a whole record" forbade a correct implementation: `store.readOpenPids` does exactly the
forbidden thing and is right, because a tombstone always carries a non-null `exitedAt` and so never
survives its `exitedAt === null` filter, leaving I19's guard its three fields every time. Restated
as the requirement — a reader must never hand back a tombstone as an open record — with folding
named as one way to meet it rather than the only one.
Rejected: removing `'sandbox'` and `'superseded'`. Cleanest to read, and it narrows a declared
public union, which is `/contract`'s to do and not a reconciliation's — and a persisted
`permission.resolved` line carrying one would stop parsing as its own type.
Rejected: mapping `/api/audit`'s storage failure to a declared code instead. The contract already
rejects the only honest candidate by name — "a `storage_unavailable` variant whose only caller is
this one path" — so the alternative is reusing a code that does not fit to keep a table unchanged.
Rejected: making `readOpenPids` fold properly. Buys nothing observable and costs a second pass at
boot; the sentence was the thing that was wrong.
Reversibility: cheap throughout.

### 2026-08-18 — D140 A shared secret authenticates the deployment, not a person, and the design now says so
Context: `src/identity/index.ts` resolves every caller under `auth.mode === 'shared-secret'` to a
single `OperatorId`, `'shared'`. The module's own comment argues it correctly from D3; `design/`
had no idea. The consequences are load-bearing and were nowhere: `GET /api/sessions` returns every
session rather than the caller's; the ownership check on every session route passes for anyone
holding the cookie, so `404 no_such_session` stops being access control; `AuditRecord.operator` is
the same string on every line, so the log answers what was approved and not by whom, which is most
of what `§ Threat model` leans on it for; and D70's one carve-out collapses, because a `draft`
review is its author's alone and under this mode every reader is the author. Brief DoD #1 — "see
only their own sessions" — is met under the two header modes and not under this one.
Chosen: record it, and add *One auth mode has one operator* to `§ Threat model` stating all four
consequences and the conclusion — the mode is for a deployment with one operator, and a deployment
with several who must be told apart runs a proxy in front, which is what the primary mode is. This
documents; it constrains nothing new. The alternative reading, that the identity module is
unfinished, is the one that had to be foreclosed.
Rejected: minting a per-browser `OperatorId` under this mode. That is the operator record D3
refuses, and reopening D3 is `/design`'s, not a reconciliation's.
Rejected: refusing to start under `shared-secret` when tier-two record routes are reachable. It is
the one consequence that is silently wrong rather than merely coarse — a draft every operator can
edit — but the threat model already concedes a determined operator has shell access as the server's
user, so the refusal would be an enforcement claim with nothing behind it, and it couples config
validation to feature flags the design does not have.
Reversibility: cheap. Prose only.

### 2026-08-18 — D141 Two implementation choices with observable consequences are recorded
Context: neither had a decision entry, and both are things a future reader would ask "why?" about.
Chosen, first: **an audit cursor's lifetime ends at process restart.** `store` mints the HMAC key
for `AuditCursor` with `randomBytes(32)` at `createStore` and never persists it, so a client paging
history across a restart is answered `422 bad_request` on its next page rather than silently served
from a stale offset. This is consistent with D86 — the cursor stays opaque and what it encodes
stays `store`'s business — and D86's rejection of "a byte offset" was of *publishing* the layout,
which an authenticated offset does not do.
Rejected: persisting the key. It survives restarts and becomes a secret with a lifecycle, a file,
and a rotation question, to spare a caller one refetch of a page it can simply request again.
Rejected: an unauthenticated offset. D86's rejected shape; a caller could then seek anywhere in the
file by construction.
Chosen, second: **Codex transport detection is a synchronous probe at session creation.**
`detectTransport` runs up to two `spawnSync` `--help` calls, each bounded at 2 s, inside
`createAdapter` inside `manager.create`. D107 fixed selection at create and did not price it: on a
healthy binary this is tens of milliseconds, and on a slow or hung one it stalls the whole
single-threaded server — every other operator's session included — for up to four seconds. Recorded
rather than changed, because `createAdapter` is synchronous in the contract and the honest fix is
to probe once per process and cache rather than to make the call async.
Rejected: probing at first `send`. It moves the stall into the turn and contradicts D107's "once,
at create".
Rejected: an async probe. `createAdapter`'s signature is `Result`, not `Promise<Result>`; widening
it is a contract amendment for a cost that caching removes entirely.
Reversibility: cheap. Both are records of what is already true; the caching follow-up is staged in
`## Open`.

### 2026-08-18 — D142 The interrupt boundary and the Open WebUI mode are narrowed to what the tree does
Context: two `10-design.md` statements described more than the tree has, in ways that read as
defects rather than as choices. `§ Interrupt` said everything an interrupt *means* — "which events
fire, what state is left, whether it counts as a failure" — belongs to the manager; both adapters
in fact hold a per-turn `killRequested` flag and emit `turn.ended` with `interrupted` or
`process_exit` from their own `close` handler. And `§ Security controls` presented `open-webui` as
consuming a three-part contract — `X-User-Id`, `X-Session-Id`, bearer upstream auth (D11) — where
the tree reads `X-User-Id` only, declares `sessionHeader` and reads it nowhere, requires
`AUTH_SESSION_HEADER` at startup regardless, and validates no bearer. The mode is `proxy-header`
plus a dead field.
Chosen: narrow both statements. Interrupt — the manager decides *that* an interrupt happens and
owns the state it leaves; the adapter names the stop reason, because only the `close` handler knows
whether the process stopped under a kill or on its own, and a manager inferring it from "I called
`kill`" would report a turn that crashed in the same instant as an expected interruption, which is
exactly the misattribution D24's first property exists to prevent. Open WebUI — say which part is
consumed and why the other two are not: `X-Session-Id` is per-session cwd tracking in Open WebUI's
own terms and this console has no use for it, and what constrains who may set an identity header
here is `trustProxy` plus the loopback-by-default bind, not a token this server validates.
Rejected: moving the stop reason into the manager. It keeps D17's ownership sentence literally true
and duplicates the kill-versus-crash discrimination into a module that can only guess at it.
Rejected: dropping `sessionHeader` and collapsing `open-webui` to an alias of `proxy-header`.
Smallest and most honest, and it removes a declared field from a public type, which is
`/contract`'s call — and it costs a deployment its configuration portability if the field is ever
read.
Rejected, for both: recording the divergence as known and changing neither document. It leaves the
next reader to rediscover precisely what this pass just did.
Reversibility: cheap. Prose only; no code moves.

### 2026-08-18 — D143 Three stated behaviours the tree does not have: the code is the wrong side, and the work is staged
Context: `/reconcile` found three places where `design/` or `20-contract.md` describes behaviour
that is not implemented, and in each the document's argument is the sound one. They are adjudicated
here so the next pass does not re-derive them, and staged in `## Open` so they have a landing point
— a decision with none does not land (`agent.md`).
Chosen: the code changes in all three.
**`error / agent_unavailable` is never emitted.** `10-design.md § Failure modes` row one and
`20-contract.md`'s error table both promise it, `fatal: true`, when the CLI cannot spawn; a failed
`adapter.send` produces only `turn.ended { stopReason: 'error' }` and a `503` on the HTTP response.
The event is the half a subscriber can see, and the design's own "Operator sees: Agent unavailable"
column has no source without it.
**The four server-wide append-only files are not a single append stream.** `§ Concurrency` rests
the no-lock claim on it verbatim — "each is opened once, as a single append stream owned by
`store`" — and `store.appendLine` opens a fresh handle per append and closes it. `events.ndjson`
has `emit`'s per-session chain; `audit.ndjson`, `pids.ndjson`, `reviews.ndjson` and
`requisitions.ndjson` have nothing, so two sessions resolving permissions concurrently issue two
overlapping `O_APPEND` writes. `AuditRecord.input` is the one field the design forbids truncating,
which makes it the one line long enough to split.
**`caps.subscriberQueueHighWater` bounds only the spill catch-up window.** It is read in one place,
the proxy that buffers while a replay runs; once that flips to live the sink writes straight to the
socket and neither edge checks `res.write`'s return value or waits for `drain`. So `§ Failure modes
— Client boundary`'s "slow client stalls the stream → drop that subscriber, report a gap to it
alone" is true during replay and false afterwards, and the steady state is D18's *second rejected
alternative*, unbounded per-subscriber buffering — moved into Node's socket queue rather than
removed. S3.7 passes because it holds a replay open deliberately and never exercises a live
subscriber.
The last of these exposed an assumption neither document notices: **D18's per-subscriber queue and
D89/I27's synchronous fan-out pull against each other.** `emit`'s prefix delivers to every
subscriber synchronously, which is what orders `seq` without a lock; a bounded queue needs
somewhere to hold an envelope a subscriber is not ready for, and there is no such place inside a
synchronous prefix — it has to live in the edge, where `subscriberQueueHighWater` is not visible.
The tree resolved it by keeping the prefix and dropping the queue, silently. That is the root of
the third item, and the fix belongs in the edges for the same reason.
Rejected, for the first: striking the event from both documents and marking `ErrorEventKind
.'agent_unavailable'` retained-knowingly. Free, and it accepts that a client watching the stream
cannot tell a missing CLI from any other turn failure.
Rejected, for the second: rewording `§ Concurrency` to rest the no-lock claim on `write()`
atomicity for one line instead of on a stream. Honest and free, and it weakens the claim exactly
where the audit log is the artifact the threat model leans on.
Rejected, for the third: narrowing D18 and the Failure-modes row to the catch-up window. Free, and
it concedes an unbounded memory path with no stated limit in a console whose whole point is a phone
on a bad connection.
Reversibility: cheap for all three fixes; each is local and none changes a persisted shape or a
signature.

### 2026-08-18 — D144 `edge/ws` must serve the record routes, and the contract was already right
Context: `20-contract.md § edge/sse and edge/ws` says `createWsEdge`'s `RequestListener` "serves
the whole `## HTTP routes` table exactly as `edge/sse`'s does, with one substitution" — the events
route, which moves to the upgrade handler. It serves eight fewer. `src/edge/ws/index.ts` wires no
`/api/requisitions`, no `/api/requisitions/:id/decision`, and none of the four `/api/reviews`
routes; they fall to the catch-all and answer `422 bad_request`. Session sub-routes are at parity,
so this is the two record collections alone. Under `config.edge === 'ws'` a deployment loses all of
tier two's record surface, with nothing anywhere saying it would, and `422` tells the client the
build serves no such route — which is true and is not what the contract promises.
Chosen: the code changes. Every handler already exists in `edge/http-common` and is already
reachable from this edge — `records` is in `EdgeDeps` and reaches `createWsEdge`, which simply
never routes to it, so `EW --> RC` in the module diagram is an arrow the types draw and the code
never traverses. The fix is the eight route arms, copied from `edge/sse`, plus a parity test that
**enumerates** the table rather than asserting parity in prose: the claim is a sentence today and
no test can fail on it, which is why a whole reconciliation pass (D138–D143) read both documents
against the tree and missed it. Staged in `## Open` rather than implemented here — this is
implementation against a settled contract, and a reconciliation decides which side is wrong.
Rejected: narrowing the contract to declare the record routes `edge/sse`-only. Free, and it makes
tier two transport-conditional for no stated reason. D77 put the shared handlers in
`edge/http-common` precisely so two transports could not answer one request differently; conceding
this divergence spends that argument to keep a routing table unchanged, and leaves a deployment
choosing its transport by which features it needs — a choice the design nowhere says exists.
Rejected: recording it as known and changing neither. The alternative D142 rejected, for the same
reason: it leaves the next reader to rediscover exactly what this pass just did.
Reversibility: cheap. The arms delete cleanly and no persisted shape or signature moves.

### 2026-08-18 — D145 A declared method with no caller states so, the same as a union member
Context: `Records.isUnderPip` and `Records.getRequisition` are declared in `20-contract.md`,
implemented, and covered by `records`' own tests — and called by nothing above the module. D139 set
the standing rule one size down, for a union member with no producer, after separating "dead by
choice" from "dead by omission" cost a grep-and-trace per value. These cost the same again, one
size up, and the two answers were different: `getRequisition` is simply never wired, and
`isUnderPip` is not dead at all.
`isUnderPip` is the one that mattered. I35 names `records` as the owner of the PIP fold; the fold
anyone observes is `client/app.js`, scanning the finals from `GET /api/reviews?subject=` for the
greatest `updatedAt` with ties to the later entry. It is the same rule, and the client's own
comment says so. That is not a defect: **D72 forbids serving PIP as a session field and D79 forbids
an employment-status field on the wire**, so the fold has to run wherever the finals already are,
and for a badge in a browser that is the browser. What was missing was any statement that the
duplication is deliberate — leaving a reader to conclude either that the client re-implemented
server logic by accident, or that `records`' copy is dead.
Chosen: annotate both, in `20-contract.md` and `src/records/index.ts` alike, in the shape D139 set.
`isUnderPip` is I35's server-side statement, kept so the invariant is assertable in the module that
owns it rather than only against browser code, and marked as one rule in two places that change
together. `getRequisition` is reserved for a single-requisition read. **The standing rule this
extends: a declared interface method with no caller states why in its own comment, or the method
goes.**
Rejected: removing both. Cleanest to read, and it narrows a declared public interface, which is
`/contract`'s and not a reconciliation's — the boundary D139 declined to cross for `'sandbox'` and
`'superseded'`. It also deletes the only implementation I35 can be asserted against, leaving an
invariant owned by `records` with nothing in `records` to check.
Rejected: serving PIP from the server so `isUnderPip` gains a caller. It removes the duplication
outright and contradicts D72 and D79 to do it; reopening either is `/design`'s.
Reversibility: cheap. Comments only.

### 2026-08-18 — D146 A transport that cannot report usage says so, once, and the payroll fold reads it
Context: `codex exec --json` emits no `usage` events, because S8.1 could not settle whether its
`turn.completed.usage` is a running total or a growing resent context, and I28 forbids guessing
(`20-contract.md § Vendor mapping — Codex § Usage`). The consequence is that `PayrollView.burn`
sums to zero on that transport — **indistinguishable from a session that genuinely burned
nothing**, on the one screen headed *payroll*, where a zero reads as good news rather than as an
absence of measurement. `20-contract.md § Unresolved` 12 carried this as a rider on the basis
question, needing a `SessionNoticeCode` that did not exist. #91 asked for it at this command's
tier.
Chosen: add `usage_unavailable` to `SessionNoticeCode`, `level: 'warn'`, appended **once at
session start, before the first `turn.started`**, by whichever adapter selects a transport that
cannot report usage — today only `codex exec --json`, but the member is written against the
capability rather than against the vendor, so a second such transport needs no second code. The
notice is the discriminator between an unmeasured zero and a real one.
A notice envelope rather than a session field, which is the shape `'sandbox'` was superseded *for*:
that member lost to `PermissionPolicy.banner` because a client joining at an arbitrary point must
still see a standing sandbox banner, and an envelope cannot promise that. The consumer here is
`PayrollView`, a fold that walks the spill from the beginning (D75, D76), and `session.notice /
server_restart` is already folded exactly that way (D130) — so this reuses an existing path
instead of adding a session field for a reader that does not need one.
Rejected: deferring until the usage basis is known, and gating the fallback's shipping on it. The
two questions are independent — one asks what the number means, the other asks what to say while
nobody knows — and the silence misreads as a zero for however long the basis stays open, which is
precisely the interval the notice exists to cover.
Rejected: emitting it per turn. Same statement repeated, and a standing condition rendered as
recurring noise buries it rather than surfacing it.
Rejected: deciding `PayrollView`'s discriminator in the same pass. Making `burn` nullable is the
honest shape and forces every reader to handle the unknown where a boolean beside it can be
ignored — but it is a second public-surface change to a materialised type and makes
`remainingTokens` null by consequence. It is left in `## Unresolved` 12 for its own sign-off.
Reversibility: cheap in the contract, and additive in the tree — a union member with no producer
is the case D139 already ruled on. Expensive only if a `PayrollView` shape is built on it first.

### 2026-08-18 — D147 Payroll has one read path; the running burn counter is dropped
Context: `10-design.md § Derived views` said a live session's burn "is also tracked as a running
counter in `emit`", that a rehydrated session is folded from the spill instead, and that "the two
must agree; if they ever do not, the spill is right." No counter was ever built. `foldPayroll`
(`src/session-manager/index.ts`) walks the spill for every read, live and rehydrated alike, and
S16.5's own comment says that is deliberate. So the design specified a second source of truth, and
a reconciliation rule between the two, for a pair that does not exist — the document described a
mechanism the tree does not have, which is exactly what makes a reconciliation generative rather
than a check.
Chosen: the document changes. One read path, folded from the spill, for every session in every
state. The counter's argument — `emit` sees every envelope exactly once, so the count is exact and
free — is true, and it is not the question. Two sources for one number is a pair that must agree,
and **an agreement rule nothing enforces is not a guarantee, it is a sentence.** The same shape was
already refused twice for the same reason: D37 derives `lastSeq` from the spill rather than keeping
`meta.json` current, and D72 derives PIP rather than storing a flag. The cost is O(spill) per
payroll read, stated in `§ Derived views` rather than hidden, and open question 11's offset index
is what pays it down if the volume ever justifies one.
Rejected: building the counter to match the document. It buys a cheaper live read and costs the
one property the fold currently has for free — that a live read and a post-restart read cannot
disagree, because they are the same code over the same bytes. It would also need the cross-check
the old wording asserted and nothing implemented, which is a third thing to get wrong.
Rejected: keeping the paragraph and softening it to an option not taken. `§ Derived views` would
then still carry a mechanism absent from the tree, and the next reconciliation finds it again.
Reversibility: cheap. Adding a counter later is additive, and this entry is what a future pass
reads before re-arguing it.

### 2026-08-18 — D148 The interrupt grace period is the POSIX half, not both platforms
Context: `10-design.md § Concurrency § Interrupt` property 2 read "The sequence is therefore
terminate-then-force with a grace period, on a process **tree**", as one sequence for both
platforms. The tree does that only on POSIX — `SIGTERM` to the group, then `SIGKILL` after the
grace period (`src/adapters/claude/index.ts`). On Windows the adapter issues `taskkill /T /F` in a
single step with no grace period at all, and the reasoning for that lived in a code comment and in
neither document.
Chosen: the document changes. Windows has no signal to be graceful with — the concession the same
paragraph already makes about `child.kill('SIGINT')` terminating rather than signalling — so there
is nothing for a grace period to elapse over, and `/F` is both phases collapsed by the platform
rather than a phase skipped by this code. What is genuinely cross-platform is the *tree*, and the
amended wording says that instead.
Rejected: adding a `taskkill /T` phase before the forced one so the code matches the sentence. It
would give a child tree a window to close its own handles, which is not nothing on the platform
where an open handle blocks a checkpoint restore — but D16's per-turn child already makes that a
non-issue by construction (no turn, no child, no handle), and the design has never named an
observed failure the window would fix. A kill phase with no stated purpose is one nobody exercises.
Rejected: recording the divergence and changing neither side. `§ Concurrency` would keep a sentence
that is false on the primary host.
Reversibility: cheap. Prose, plus this entry.

### 2026-08-18 — D149 D146's notice is specified and unbuilt: the code is the wrong side, and the gap is staged
Context: D146 added `usage_unavailable` to `SessionNoticeCode` and `20-contract.md § Vendor mapping
— Codex § Usage` states when it fires — once, at session start, before the first `turn.started`, by
an adapter on a transport that cannot report usage. `src/contract/index.ts` has no such member and
the `exec` transport in `src/adapters/codex/index.ts` emits no notice, so a session on the fallback
still reports a burn of zero indistinguishable from an idle one. That is the exact failure D146 was
written to close, and it is closed in two documents and nowhere else.
The gap was untracked. #91 carries this item and both its `Done when` boxes are about documents —
the contract gaining the member, and the design stating when it is emitted — which D146 satisfied.
Nothing on that issue says the adapter emits it, so the issue reads one tick from done for
behaviour that does not exist.
Chosen: the code changes. The member is added to `src/contract/index.ts` and the Codex adapter
appends the notice on the `exec` path. Staged in `## Open` rather than edited here: this is
implementation against a settled contract, which is `/fix`'s tier, and a reconciliation that
absorbed it would be doing implementation work at deep-reasoning tier — the same boundary D143
observed when it staged its three rather than fixing them.
Rejected: withdrawing D146 so the documents match the tree. It costs the whole of that entry's
argument, decided two commits ago on evidence nothing has since contradicted, and
`AGENTS.md § Budget discipline` forbids relitigating a recorded decision without new evidence.
There is none — only an absence.
Rejected: recording the divergence and changing neither side. The alternative D142, D144 and D148
each rejected for the same reason: the next pass rediscovers it, and here it costs more than
rediscovery, because #91 would close green over a behaviour that was never built.
Reversibility: cheap. A union member with no producer is the case D139 already ruled on, so a
withdrawal is an annotation rather than a removal.

### 2026-08-18 — D150 The contract admits the enumeration of a closed union; `RATINGS` stays where it is
Context: `20-contract.md § contract` says "Types only. No runtime export." `src/contract/index.ts`
exports `const RATINGS`, read once — `edge/http-common` testing membership before it accepts a
`Rating` on the review routes. It is the same job `VENDORS` does for `Vendor`, and
`10-design.md § Module boundaries` argues that case explicitly: the enumeration lives beside the
code that makes each member mean something, so a second independently-typed copy cannot drift.
`RATINGS` has no such argument written anywhere and sits in the one module declared runtime-free.
Chosen: the contract changes. `Rating` has no `createRating` switch to sit beside — its members are
not made runnable by anything, they are validated and stored — so the `VENDORS` argument does not
transfer, and moving the list to `records` would put the wire-validation vocabulary in a tier-two
module that the tier-one edge would then import to parse a body. The declared property becomes
narrower and still checkable: `contract` exports types, plus the enumeration of a closed union
where a validator must test membership, and each such export is declared here like any other
public interface.
**The amendment is not made in this pass.** Adding `RATINGS` to `20-contract.md` adds a public
interface the document does not carry, which `AGENTS.md § Hard rules` reserves to `/contract` —
the same boundary D145 declined to cross in the other direction when it kept two methods rather
than narrowing a declared interface from a reconciliation. Staged in `## Open`.
Rejected: moving `RATINGS` to `records`, which was this pass's recommendation. It keeps the
contract's sentence true with no amendment and draws no new module edge, and it was not chosen
because it puts a validation vocabulary tier one needs behind tier two's module, and because the
`VENDORS` precedent it leans on rests on a runtime switch `Rating` does not have.
Rejected: recording it and changing neither. The alternative D142, D144, D148 and D149 each
rejected for the same reason, and here it leaves a grep-checkable sentence — "no runtime export" —
false, which is worse than an unstated one because it invites a reader to trust it.
Reversibility: cheap. Prose plus one declared const; nothing persisted and no signature moves.

### 2026-08-18 — D151 A declared field with no producer states so, the third size in the same series
Context: `TurnEnded.usage` is declared `Usage | null` in `20-contract.md § Event payloads` with no
note. Every emission site passes `null` — both adapters' `result` / `turn.completed` and `close`
paths, and the manager's three synthesised closes for a storage failure, a boot-closed turn and a
failed spawn. The only statement that the field is empty by design is a comment inside
`foldPayroll`, where a reader looking at the contract will never find it.
D139 set this rule for a union member with no producer and D145 raised it to a declared interface
method with no caller. A field is the third size and had no ruling, which is why this one sat
unannotated through both passes.
Chosen: annotate, in `20-contract.md` and `src/contract/index.ts` alike, in the shape the two prior
entries set. D75 put the vendor-normalised, summable figure on the dedicated `usage` envelope and
`PayrollView`'s fold reads only that, so the code is right and what was missing was any statement
of it. The annotation names the hazard rather than only the absence: a reader that summed both
sources would double-count a turn's burn on the one screen headed *payroll*, which is the failure
I28 exists to prevent. **The standing rule this extends, and completes: a declared field with no
producer states so in its own comment, or the field goes** — the same sentence D139 wrote for a
member and D145 for a method.
Rejected: removing the field. Cleanest to read, and it makes the double-count impossible rather
than documented. It narrows a declared public interface, which is `/contract`'s and not a
reconciliation's — the boundary D145 declined to cross for `isUnderPip` and D150 declined again for
`RATINGS` — and it forfeits the slot a vendor-reported turn total would occupy if one ever proves
worth carrying.
Rejected: recording it and changing neither. It leaves the hazard reachable by anyone reading the
declaration rather than the fold, and this is the third pass in which the field went unnoticed.
Reversibility: cheap. Comments only, in two files that change together.

### 2026-08-18 — D152 The supported Node floor is the one the gate runs
Context: `package.json` declared `engines.node: ">=20.6"`. S19 pinned both CI legs to 22.11.0
because `node --test "dist/**/*.test.js"` does not resolve an explicit glob argument on 20.18.1, on
either platform (`657bb91`) — so `npm test`, the whole of this repository's gate, is known-broken on
the bottom of the range the package advertised. Nothing in `design/` names a Node floor, so this is
a claim the tree made about itself rather than doc-versus-tree drift, and S19 is what falsified it.
Chosen: raise the floor to `>=22.11.0`, the only version anything has been proven against on either
platform. D64's objection was to a two-platform claim gated by nothing, and a runtime range is the
same species of claim — three majors wide, one of them proven, the bottom one failing the gate. The
cost is nothing real: this is a self-hosted console whose operators install the runtime beside it,
and no consumer resolves this package.
Rejected: keeping the range and fixing the invocation instead — passing directories to `node --test`
rather than a glob, so the suite runs on 20.x again. It preserves the wider claim honestly and is a
small change, and it was not chosen because the claim would still be gated by nothing: a second
runtime is only proven by a second matrix dimension, which S19 put out of scope by name and nobody
has asked for. A range nothing exercises is what this entry exists to stop declaring.
Rejected: recording it and changing neither. It leaves an `engines` floor that fails this
repository's own gate, found by whoever first trusts it.
Reversibility: cheap. One line, and lowering it again is what a Node dimension on the matrix would
justify.

### 2026-08-18 — D153 `VENDORS` is declared where it lives, and D150's rule stops at one module
Context: D150 narrowed `20-contract.md § contract` to admit "the enumeration of a closed union
where a validator must test membership" and had `RATINGS` declared under it. `adapters` exports
`VENDORS` for the same job — `edge/http-common` tests membership before accepting a `vendor` on a
request body — and `§ adapters/*` declared it nowhere. Nothing was false: that section never
claimed to be runtime-free, which is what made `§ contract`'s sentence a defect rather than an
omission. But `## Public surface` covers every export crossing a module boundary, and this
crosses one.
Chosen: declare `VENDORS` in `§ adapters/*`, beside `createAdapter`, with the reason it is not in
`contract` written down — D126's argument, that the list belongs beside the switch that makes each
member runnable, so a member nothing can create cannot be added. The two guarantees a caller gets
are stated: the array holds every member of `Vendor` and no other value, and `createAdapter`
accepts each one. That second clause is the whole point of the co-location and was previously
recoverable only by reading the switch.
This deliberately does **not** extend D150. D150 said each such export is declared "here", meaning
`§ contract`, and explicitly refused the `VENDORS` analogy — `Rating` has no dispatch to sit beside.
Treating D150 as a general rule would have moved `VENDORS` into `contract` and reversed D126.
Rejected: adding `VENDORS` to `§ contract` alongside `RATINGS`, so one section holds every runtime
enumeration. Tidier to read and it is what a careless reading of D150 licenses; it contradicts D126,
draws an `edge → contract` arrow in place of the `edge → adapters` one the design deliberately
drew, and separates the list from the switch that is its only correctness argument.
Rejected: recording it in `## Open` for a later pass. `## Open` is a staging area, and this is a
two-paragraph edit in the command that owns it, running now.
Rejected: leaving it undeclared on the grounds D126 already settled where it lives. D126 settled the
module, not the public surface; a reader of `20-contract.md` would find `createAdapter` declared and
its vocabulary not.
Reversibility: cheap. Prose plus one declared const; nothing persisted and no signature moves.

### 2026-08-19 — D154 `insecure_bind` is a header-trust-mode refusal, and three documents said otherwise
Context: `src/config/index.ts` gates the routable-bind refusal on `auth.mode` being `proxy-header`
or `open-webui`, so `shared-secret` on `0.0.0.0` with an empty `TRUST_PROXY` starts. Four statements
described the condition and they did not agree: `20-contract.md`'s error table, `10-design.md`'s
threat-model *internet* row and its *Failure modes — Server lifecycle* row all stated it
unconditionally, while `10-design.md § Security controls` scoped it to "those modes". The code
follows the scoped one, and `src/identity/index.ts`'s `peerIsTrusted` and `src/server.ts`'s refusal
text are both written against that reading, so the tree is internally consistent and three sentences
are not.
Chosen: the documents change. All three unconditional statements are qualified to the header-trust
modes, *Failure modes* gains a row saying the same bind under `shared-secret` is refused by nothing,
and the contract's error row states when the variant is *not* raised as well as when it is. A shared
secret is a credential the caller must present, not a claim about who the peer is, so there is no
header a routable bind makes forgeable — and *Threat model* already calls the mode "for a bare LAN
box", which binds routably by definition.
Rejected: extending the refusal to `shared-secret` so all four sentences become true as written. It
makes the one deployment shape that mode exists for unconfigurable without naming an upstream proxy
that does not exist in it — an enforcement claim with nothing behind it, which is the shape D69
rejected for self-approval and D140 rejected for per-operator identity under the same mode.
Rejected: recording the divergence and changing neither side. The alternative D142, D144, D148 and
D149 each rejected, and here it costs more than rediscovery: the unqualified rows read as a security
control the server does not have.
Reversibility: cheap. Four prose edits, no code and no persisted shape.

### 2026-08-19 — D155 One refetch, then a reported state: the second `replay_gap` is declared
Context: `20-contract.md § Streaming` said only "after which the client refetches".
`client/app.js`'s `handleReplayGap` refetches once and, on a second gap, reports `history
unavailable — showing live events only` rather than reopening. Issue #66 adjudicated this at S3's
code review and routed it to "the one reconciliation pass that runs when tier one is code-complete";
tier one has been code-complete since S19 and five passes (D138–D153) have run since without landing
it, because a reconciliation derives its findings from the tree and `design/` and reads nothing from
the tracker.
Chosen: the contract changes, transcribing #66 rather than deciding it. *Streaming* now states that
a refetch is a fresh stream carrying no `Last-Event-ID`, that a gap on *that* stream means the spill
cannot be read at all, and that the client terminates in a reported live-only state rather than
reopening again. The same paragraph names the past-the-end resume point as one of the ranges the
spill cannot serve, which `session-manager.subscribe` already reports as a gap.
Rejected: making the client reopen on every gap so the bare sentence becomes literally true. That is
the reconnect loop S3's review closed, and it relitigates a recorded adjudication with no new
evidence (`AGENTS.md § Budget discipline`).
Rejected: leaving #66 for a later pass. Nothing structural would surface it next time either — which
is the lesson, not the decision.
Reversibility: cheap. One paragraph; no signature and no behaviour moves.

### 2026-08-19 — D156 A `replay_gap` restates a watermark and consumes no `seq`
Context: `session-manager.subscribe` stamps a gap envelope with the `seq` its subscriber is complete
*through*, and `edge/sse` suppresses the `id:` line for any envelope that does not advance. The SSE
half was stated — the WebSocket section says a gap frame carries "no resumable position, exactly as
SSE's gap frame carries no `id:`" — but the envelope's own `seq` field was not, and I1 declared `seq`
strictly increasing with no carve-out. On the WebSocket edge the body's `seq` is the only resume
signal a client has (`client/app.js` sends `{after: state.lastSeq}` and assigns `state.lastSeq` from
`envelope.seq`), so the rule is not a framing detail.
Chosen: the contract states it, in *Streaming* and as a clause on I1. A `replay_gap` is the one
envelope `emit` never produces: no `seq` assigned, nothing appended to the spill, nothing pushed to
the ring, and one subscriber rather than fan-out. I1 governs what `emit` assigns and is not weakened.
Rejected: having a gap consume a fresh `seq` so I1 needs no clause. It makes the gap frame itself the
next resume point — past the very history it failed to serve — turning one reported gap into
permanent silent loss, which is the failure the gap exists to announce.
Rejected: leaving the rule in the code comment that already explains it. A rule a WebSocket client
must follow, discoverable only by reading `session-manager`, is one the second client implementation
gets wrong; and I1 as it stood read as forbidding what the tree does.
Reversibility: cheap. Prose plus one invariant clause; the behaviour is unchanged.

### 2026-08-29 — D191 Windows runs the server natively, supervised by NSSM, not the same container
Context: issue #72. The Linux delivery mechanism was already decided (2026-08-19 entry above,
corrected by D179) and ships as `Dockerfile`/`docker-compose.yml` — a runnable artifact `README.md`
already documents. No decision existed for Windows, the brief's own primary host
(`design/00-brief.md` Constraints: "Must run on Windows and Linux servers... path handling, process
termination and workspace rollback all differ between them"). `src/server.test.ts` already documents
why that constraint bites here specifically: `child.kill('SIGTERM')` on Windows is Node emulating an
unconditional kill, not a real signal delivery, so the container's own shutdown path
(`ENTRYPOINT ["/usr/bin/tini", "--"]`, ↦ `SIGTERM` ↦ `server.ts`'s `stop()`) is untestable on Windows
by construction — the S27.2/S27.3 tests already skip there, citing #28.
The reason that decides it is deployment reach, not code shape: **Docker Desktop is not supported on
Windows Server.** A container-only Windows story therefore does not run on the class of host this is
most likely deployed to, which is not a parity argument but an availability one.
`src/jail/index.ts`'s Windows handling — 8.3 short names through `realpath.native`, `\\?\`
extended-length prefixes, case-insensitive comparison with separator normalisation — is consistent
with native execution and would go unexercised in production under a container-only story, but it is
**not** on its own decisive: `win32`/`process.platform` branches appear in four non-test source files
(not the eleven an earlier draft of this entry claimed, a count that wrongly included test files), and
`.github/workflows/verify.yml`'s `windows-latest` job already exercises them on every push. Supported
native behaviour is not the same as a requirement to deploy natively, and this entry originally
conflated the two.
Chosen: Windows does not run the Linux container under Docker Desktop, even though bind-mounting
Windows paths into a Linux container works on supported desktop Windows and would be the cheaper
option there. It is unavailable on Windows Server, and a deployment story that silently excludes the
server SKUs of the brief's primary platform is not one. Instead the compiled server runs directly on the
host, registered as a Windows Service by a new script, `tools/Install-WindowsService.ps1`, via NSSM
(an operator-installed tool, not a project dependency — the Windows analogue to Docker itself, which
is likewise never installed by this repository's own tooling). Credential parity with the Linux
bind-mount comes for free rather than needing one: the service runs under the operator's own Windows
account, so `claude`/`codex` resolve `%USERPROFILE%\.claude`/`.codex` exactly as interactive use
would, with no container boundary to cross. The script validates every field `src/config/index.ts`'s
`loadConfig` refuses to boot without, plus `ALLOWED_ORIGINS` (a deployment-level requirement
`docker-compose.yml` also imposes with no default, though the app itself falls back to an empty
list), and refuses to touch NSSM at all if any is missing from its `-EnvFile` — the same fail-closed
shape the compose files get from `${VAR:?...}` interpolation.

**The environment block is written to the registry, not passed to `nssm set`.** Under `shared-secret`
it contains `AUTH_SECRET`, the credential authenticating every operator, and a Windows command line
is not a private channel: it is readable through `Win32_Process.CommandLine` and captured by Sysmon
Event ID 1 and PowerShell script-block logging. `Set-ServiceEnvironment` writes `AppEnvironmentExtra`
directly as `REG_MULTI_SZ` and reads it back before returning, so a wrong assumption about NSSM's
registry layout fails loudly instead of leaving a service that boots with no configuration; neither
the comparison nor its failure message ever echoes a value. `-ServiceAccount` is advisory for the same
reason and deliberately sets nothing — configuring it non-interactively would put a password on a
command line, the very exposure this avoids.

**The graceful shutdown route works, and an earlier draft of this entry wrongly hedged it.** That
draft reasoned that `GenerateConsoleCtrlEvent` needs a console, that an SCM-started service has none,
and therefore that the console step might never reach the process. The first two premises are true of
services in general and false of NSSM in particular: NSSM gives the child a console — 2.24 allocates
one for inheritance, newer builds use `CREATE_NEW_CONSOLE` — and on stop it attaches to that console
and raises `CTRL_C_EVENT`. Node converts that to `SIGINT`, which `src/server.ts` already handles on
the same path as the container's `SIGTERM`. The installer does not disable any of it. The hedge was
reasoning from the general case to a specific tool without reading the tool, and it is withdrawn.
Two corrections travel with it: NSSM walks the process tree during stop escalation, so even the
`TerminateProcess` fallback does not inherently orphan children — what it costs is the graceful path
(`manager.shutdown()`, the tombstones, the lock release), not the children; and #28 was never the
right tracker for any of this, being the two-platform CI gate and closed on 2026-08-17.

**The post-stop check survives, on a different justification.** It is no longer needed to answer
whether NSSM *can* deliver the event — it can. It is needed because the delivery is
configuration-dependent in a way an operator can trip without noticing: NSSM 2.24 is documented as
unable to launch services on newer Windows without `AppNoConsole=1`, and that setting removes the very
console the Ctrl+C route depends on, converting every stop into a hard kill that still reports
success. So after a stop, `<STORAGE_ROOT>\server.lock` must be absent — a shutdown that reached
`stop()` removes it (D175, asserted by `server.test.ts`'s S27.12); a hard kill leaves it and the next
boot logs a stale-lock reclaim (S22.3). `Invoke-Install` prints the check on success and names the
symptom. The observation itself is tracked as #232, which is what #72 item 5 needs and what this
change does not supply.
`tools/Install-WindowsService.Tests.ps1` covers all of the above in 15 Pester cases, including the
read-back guard's own negative case and an assertion that its failure message names `AUTH_SECRET`
without echoing its value.
Rejected: the same container via Docker Desktop. Mechanically simplest, but it tests nothing about
Windows' own process model — the reason the brief's constraint exists — and would leave
the primary host's actual termination behaviour as unverified as it is today, just hidden behind a
green checkmark that measured Linux instead.
Rejected: `node-windows` (an npm dependency that self-installs a service wrapper) over NSSM. It would
be a new project dependency needing its own decision-log entry under "no new dependencies", for a
capability an already-external, already-documented tool (NSSM) provides with no addition to
`package.json` at all — the same reasoning that keeps `tini` and `git` as `apt-get install` lines in
the Dockerfile rather than npm packages.
Rejected: passing the environment through `nssm set` because it is the documented interface and the
argv exposure is "only local". The exposure is to any process enumerating command lines plus every
log sink that records them, for the one value in the block that is a credential — and this same script
already refuses that trade for the service password, so accepting it for `AUTH_SECRET` would be
inconsistent within a single file.
Rejected: closing #72's Windows item as fully verified. Item 5's shutdown-reaping check is confirmed
for Linux (`src/server.test.ts`'s S27.2/S27.3/S27.10/S27.12, passing, plus S27.5–S27.13 in
`session-manager/index.test.ts` covering the reap logic `stop()` calls into) but not exercised end to
end on Windows in this pass — building an unverified end-to-end claim into the record would be exactly
the assertion `AGENTS.md § Verification` rules out. Tracked as #232 instead, and the pull request
carries no closing keyword — GitHub honours no partial exception, so `Closes #72 except item 5` would
have closed the whole issue on merge with that item unobserved.
Rejected: holding the Windows half back entirely until a real NSSM stop had been observed. The
artifact is useful before that check runs, and the check is one command an operator runs on their own
host — withholding a documented deployment path to wait for evidence only a deployment can produce is
circular.
Reversibility: cheap. Two new files under `tools/`, one README section, no product code touched.

### 2026-08-19 — D157 The audit read is `session-manager`'s, and the design's module table is corrected
Context: `10-design.md § Module boundaries` credited `records` with "the incident read". `records`
has no such method, in the tree or in `20-contract.md`'s `Records` interface; the read is
`session-manager.readAudit`, and the incident view is that read with `incidentsOnly: true`. D119 made
that choice and `20-contract.md § Unresolved` 5 records it — only the design's table was left behind,
and its `session-manager` row was stale the other way, listing the payroll fold and not the audit
read.
Chosen: the design changes, transcribing D119. "the incident read" leaves the `records` row, the
`session-manager` row gains the audit read and the incident view over it, and a short paragraph under
the table names why the module cannot be `records` — `GET /api/audit` is tier one, and tier one must
work in a build where tier two's module does not exist.
Rejected: moving the read onto `records` so the table becomes true. It reopens D119 with no new
evidence and puts a tier-one route behind a tier-two module, which is exactly what D119 refused.
Rejected: recording the staleness without editing. A table that names the wrong owner for a route is
the class of error that misleads whoever reads the architecture before the code.
Reversibility: cheap. One table row pair and one paragraph.

### 2026-08-19 — The deployment artifact borrows the host's authenticated Claude CLI
Context: `design/00-brief.md`'s "Hosting the model" non-goal states plainly that no inference happens
here and no vendor credential is held — the server drives an agent CLI that is "already installed and
already authenticated" wherever it runs. `README.md` still read "Status: design + spike" with no
container artifact of any kind, and nothing in `design/30-slices.md` builds one; deployment was an
omission, not a decision, the same gap `SubZeroDev.com`, `SubZeroDev.Blog` and `SubZeroDev.Adventures`
had each already closed for their own services, all three landing on the same shape: a Dockerfile, a
local build-from-source Compose file, a GHCR publish workflow, and a deployment Compose file that pulls
the published tag onto the shared `proxy-net`.
Chosen: the image installs the `claude` CLI itself (`npm install -g @anthropic-ai/claude-code`) but
holds no credential for it — both Compose files bind-mount the operator's own already-authenticated
credential directory (typically `~/.claude`) over the container's `$HOME/.claude`, run as the base
image's existing non-root `node` user so that mount is writable without a root container. `client/` is
copied into the runtime image as a sibling of `dist/`, not inside it, because
`src/edge/http-common/index.ts` resolves it at runtime relative to the compiled file's own location
(`new URL('../../../client/', import.meta.url)`) rather than through `tsconfig.json`, which compiles
`src/**/*.ts` only. The local Compose file (`docker-compose.dev.yml`) builds from source with
`shared-secret` auth, needing no reverse proxy to exercise; the deployment file
(`docker-compose.yml`, following the majority convention of `SubZeroDev.Blog` and
`SubZeroDev.Adventures`, both of which keep the pull-based file at the repository root and the
build-based one nested) pulls `ghcr.io/the-running-dev/skynet-hr:latest` with `pull_policy: always`,
joins `proxy-net` and publishes no port, and every variable it needs is `${VAR:?...}`/`${VAR:-...}`
interpolation with no `env_file:` — Portainer's stack "Environment variables" only feed `${...}`
interpolation, never write a `.env` file, the same reasoning `SubZeroDev.Adventures/docker-compose.yml`
and `SubZeroDev.Blog/docker-compose.yml` each record for themselves. `.github/workflows/publish.yml`
mirrors `SubZeroDev.com/.github/workflows/ci.yml`'s `image-gate` → `publish-release` shape: the image
is built and smoke-tested once, saved as an artifact, and the job that pushes to GHCR loads that same
tarball and asserts its digest unchanged rather than rebuilding — but carries none of that repository's
human-approval environment or redeploy webhook, since neither exists here and this task did not ask for
either.
Rejected: baking a credential into the image — directly contradicts the "no vendor credential is held"
sentence the non-goal states outright, and would make every rebuild a place a secret could leak into a
layer. Rejected running the container as `root` so the credential mount needs no ownership
reconciliation — trades a real, low-cost mount-permissions problem (documented in the compose files'
own comments) for running an internet-facing-adjacent process as root, for no offsetting benefit.
Rejected nesting `docker-compose.dev.yml` under a subdirectory the way `SubZeroDev.Adventures/server/`
and `SubZeroDev.Blog/tools/blog-mcp/` do — both of those are self-contained build contexts inside a
larger repository; this repository's Dockerfile already builds from the repository root, so there is
no equivalent subtree to nest a second file under, and inventing one would separate the file from the
`Dockerfile` it exists to exercise. Rejected a redeploy-webhook step in `publish.yml` mirroring
`SubZeroDev.com`'s `publish-release` or `SubZeroDev.Adventures`' `deploy-api.yml` — both need a
Portainer stack and a stored webhook secret that do not exist for this deployment yet, and
`docker-compose.yml`'s `pull_policy: always` already picks up a new `:latest` on the next
`docker compose up` without one; adding a webhook this repository cannot fire yet is speculative
infrastructure, the AGENTS.md "Definitely avoidable" case for scope this task did not ask for.
Reversibility: cheap. The three new files and the workflow are additive and self-contained; nothing
in `src/` changed to produce them, and none of `design/00-brief.md`, `design/20-contract.md` or
`design/30-slices.md` needed a word altered — the "Hosting the model" non-goal already drew the
boundary this artifact stays inside of.

### 2026-08-19 — D158 Payroll's fourth tile is session cost in currency, at flat deployment rates
Context: the prototype's payroll screen draws four tiles. D53 kept the screen whole by the owner's
ruling but recorded the asymmetry plainly — three tiles need no credential, while the fourth, cost
per shipped PR, has "no source and is left open". Nothing in this server knows what a shipped PR is:
that fact lives in a forge, and reaching it means a forge credential, an outbound-network assumption
`00-brief.md § Constraints` does not make, and a session-to-repository-to-PR mapping nothing records.
Brief item 8 names three tiles, so cutting the fourth needed no brief change and keeping it did.
Chosen: replace the tile rather than cut it. The fourth tile becomes **session cost in currency** —
`burn` priced against four operator-set rates, one per `Usage` component, with a currency label the
server never interprets. This is the reading of item 8's own headline sentence, "see what a session
has cost", that the three sub-clauses under-serve, and it stays what the other three tiles are: a
fold over data already written plus a `config` value, needing no credential and no network call.
D61 is not reversed by this and was never in tension with it — D61 explicitly *rejected* narrowing
the model-hosting non-goal to forbid pricing lookups, on the grounds that doing so would pre-decide
this very item. This decision is the one D61 held the door open for.
Rates are **flat per deployment**, not per model. `Usage` carries four token components and no model
identifier, and `UsageEvent` is `{ turnId, usage }`, so pricing per model would mean a new field on a
public event payload and a corresponding change in every adapter. The known cost of flat rates is
stated rather than hidden: a session that switched models is priced approximately, and the figure is
an estimate against operator-set rates, never a vendor's billed amount.
Rejected: dropping the tile. It was the recommendation and the owner ruled against it, consistent
with D53's ruling on the same screen; recorded here as known-and-retained rather than dropped
silently.
Rejected: a forge integration to source the original figure. A new credential class, a new network
assumption, and a brief amendment, for one tile.
Rejected: per-model rates. Materially more correct and materially larger — it changes a public event
payload and every adapter, and turns a fold into a plumbing change. The imprecision it would fix is
recorded above and is tracked, not accepted silently.
Reversibility: cheap in code — the tile is a fold and a `config` read, and nothing persists it.
The brief edit adding a fourth clause to item 8 is the expensive half to reverse, because the
definition of done is what everything downstream is checked against.

**One coupling this creates, and it is not closed here.** `20-contract.md § Unresolved` 12 records
that `PayrollView.burn`'s all-zero value already carries two meanings — a genuinely free session,
and `codex exec --json` reporting nothing — and rules that nothing may infer the distinction by
testing `burn` for zero. A currency figure inherits that and sharpens it: a fabricated `0.00` reads
as authoritative in a way `0 tokens` does not. `costCurrency` is therefore `null` on exactly the
sessions that emit `session.notice / usage_unavailable` (D146), derived from the same signal and
never from testing `burn`. Whether `burn` itself should become nullable stays open on #30 and #91;
this decision adds weight to it and does not settle it.

### 2026-08-19 — D159 `ToolCall.summary` is the adapter's, and D109 already governed it
Context: `20-contract.md § Unresolved` 4 carried the owner of `ToolCall.summary` as open, calling
the adapter's authorship "the one place that reading is uncomfortable" — vendor code producing a
display string. It has sat open since the contract was first derived. What the item does not say is
that the identical question was answered three days later for a sibling field: D109 asked whether
the tool-to-string projection behind `matchTarget` belongs to the adapter or to `session-manager`,
and ruled for the adapter, because a projection table is tool-shape knowledge and
`Bash`/`Read`/`Edit`/`Write` are one vendor's vocabulary — "a table there hard-codes Claude's
vocabulary into vendor-neutral code and is wrong the moment another adapter ships".
Chosen: the adapter owns `summary`, and this is recorded as decided rather than tolerated. D109's
argument transfers without modification: summarising a tool call in one line requires knowing which
field of that tool's input is the interesting one, which is the same table by a different name. The
tree already reflects it and reflects the kinship — `summariseToolCall` sits in its own module
beside the Claude adapter, `summariseCommand` beside the Codex one, and `projectMatchTarget` shares
`BASH_COMMAND_FIELD` with the summariser precisely "so the two can't silently disagree about it".
**A constraint is added rather than left implied: `summary` is display-only.** Above `adapters/*`
it is rendered as a text node and nothing else — no parsing, no matching, nothing persisted or
security-relevant derived from it (I48). That is what bounds the cost of vendor code producing a
display string: it makes the string's shape non-contractual, so an adapter may change how it reads
without breaking a consumer. The invariant was checked against the tree before it was written, not
asserted: `client/render.js` renders it with `el(doc, 'div', 'tool__summary', data.summary)` and
tests only whether it is empty, which is a display decision and is why I48 permits that one case
explicitly rather than leaving a true statement looking like a violation.
Rejected: **moving it to `session-manager`**. It reopens D109 with no new evidence and reintroduces
the exact boundary violation D109 refused.
Rejected: **removing `summary` from the wire and letting the client compose one from `name` and
`input`.** It relocates tool-shape knowledge into the client, which S2.11 forbids outright — a
search of client sources for `claude` and `codex` must return nothing, and a per-tool field table is
that vocabulary in all but spelling.
Rejected: **deriving `summary` above the adapter from `name` + `matchTarget`.** Superficially
attractive, since it would delete a field and reuse a projection that already exists. It fails
twice: `matchTarget` is `null` for every tool outside Claude's four mapped rows while a summary must
exist for all of them, and it couples a display string to a security primitive that I43 and I46
require be matched anchored and untruncated. A change to how a summary looks would then bear on the
field the standing-rule grammar matches against.
Reversibility: cheap. `summary` stays where it already is; the change is a settled owner, a stated
constraint and one invariant.

### 2026-08-19 — D160 Attachments ride inline with the message, and their bytes never enter the spill
Context: D47 removed `attachments?: Attachment[]` from `POST /message` because the type was never
defined and nothing described handling — "it is a feature, not a type, and inventing one at the
contract stage commits the implementer to a transport nobody chose". `20-contract.md § Unresolved`
1 has carried the gap since. No definition-of-done item needs attachments, so the owner was asked
whether to drop them or design them, and ruled: design them.
Chosen, in five parts.

**1. Inline with the message, not a separate upload.** `POST /message` takes
`attachments?: AttachmentUpload[]`, each carrying `filename`, `mediaType` and base64 bytes, and the
whole thing is one request. Rejected: a two-step `POST /attachments` minting an id that `/message`
then references. It enforces a byte cap on a stream rather than after a parse, which is the one
thing it is better at — and it buys that by creating uploaded bytes that belong to no message,
which is a half-wired state the slice rule forbids and a sweeper nothing else here needs. An
attachment has no meaning apart from the message it arrives with, so it is atomic with it.

**2. The bytes never enter `events.ndjson`.** They are written to
`<storage>/sessions/<id>/attachments/<turnId>/<attachmentId>` before the envelope is constructed,
and `MessageEvent` carries `AttachmentRef[]` — id, filename, media type, byte count — and never the
data. This is D22's tool-output rule run in the other direction, and for the same reason: the spill
is the transcript and a base64 screenshot in it makes every replay pay for the image. The path
carries `turnId` for D22's reason too, so an id cannot collide across turns.

**3. No audit record, and the transcript is the record.** `audit.ndjson` holds tool approvals.
S14.10 already refused to dilute it with provisioning clicks — "diluting it with provisioning
clicks makes the artifact the threat model leans on harder to read" — and an attachment is not an
approval. What records it is the `message` envelope itself: ordered by `seq`, durable, replayable,
attributed to the session's owner. Brief item 7 asks who let the agent *run* what, which this does
not change.

**4. It is not a jail question, and saying why is the point.** The obvious objection is that an
attachment walks bytes past `workspaceRoot`. It does not, because the jail never contained them:
*Threat model* already states that `workspaceRoot` is not a sandbox and that the agent runs with
the server user's full filesystem access, so an attachment adds no reach the child did not have.
What it does add is **operator-chosen content entering the agent's context**, which is the *confused
agent* row with the operator as the source rather than a README. The control is unchanged — the
operator chose it, at the same trust level as the message text beside it — and that is stated
rather than left to be inferred.

**5. Vendor support is declared, never assumed.** `Adapter` gains `acceptsAttachments`, and a
message carrying attachments to an adapter declaring `false` is `422 bad_request` naming
`attachments`. The edge tests a capability, not a vendor, so I20 is intact. Whether the Claude CLI
accepts image content blocks over `--input-format stream-json` is **unprobed**: the adapter already
writes the Anthropic content-block shape, `content: [{ type: 'text', text }]`, so the transport has
structural room, but room is not acceptance. S21.1 is a committed finding that stops the slice if
the answer is no — the shape S8.1 and S10.1 already use for unverified vendor behaviour.

Rejected: **dropping attachments**. It was the recommendation — no DoD item needs them and the
agent already reaches the whole workspace — and the owner ruled against it. Recorded as
known-and-retained rather than dropped silently.
Rejected: **serving an upload back under its own declared media type.** An operator-uploaded
`text/html` served inline on the console's origin is stored XSS holding the console's cookies. The
read route serves `nosniff` and `Content-Disposition: attachment` always, and echoes the stored
media type only for an allow-list of image types, `application/octet-stream` otherwise. D74 widened
the no-`innerHTML` rule to everything stored; this is that population arriving as bytes.
Rejected: **truncating an oversized attachment**, the way `tool.result` is truncated. D84's rule
governs authored content instead: over `caps.attachmentBytes` or `caps.attachmentCount` is
`422 bad_request` naming the field, with nothing written and nothing shortened. A silently
truncated file is a corrupt file.
Reversibility: expensive. It adds a persisted store, a public route, a request field and an
`Adapter` method signature. The probe in S21.1 is what keeps the expensive half from being built
against an assumption.

### 2026-08-19 — D161 One server per storage root, enforced by a lock reusing D23's liveness test
Context: `10-design.md` open question 3. Nothing prevents two server processes over one storage
root, and the no-lock argument in *Concurrency* — one append stream per file, one single-threaded
process, so appends cannot interleave — holds for one process and stops holding for two **without
saying so**. Three things break, and they are not equally bad: appends to the four server-wide
files interleave, which corrupts `audit.ndjson`, the artifact the threat model leans on; two
registries disagree about which workspace is busy (D19), and in tier two both consume one approved
requisition; and boot **reaps a live sibling's children**, because S7.5's reaper cannot tell
another server's agents from its own orphans. The design already called a lock "the obvious answer"
and left it open on the grounds that whether an accidental double-start is worth a startup failure
mode is a deployment judgement rather than an architectural one.
Chosen: take the lock. `<storage>/server.lock` is written at boot, before step 1 of *Boot ordering*,
carrying `pid`, `hostname` and `startedAt`. A boot that finds a live lock refuses with
`StartupError.storage_locked` naming the holder and exits non-zero.
**Staleness is answered with machinery that already exists, which is what makes this cheap.** The
objection to any lock is the crash that leaves one behind, and it sharpened when the container
artifact landed — a restarted container is exactly where a stale lock bites. D23 already built the
test: a `ProcessRecord` is live only if it has no `exitedAt`, a `startedAt` later than the host's
last boot, and a matching process image. A lock is reclaimed automatically on exactly the same
three-part test against its own `pid`, `startedAt` and this server's image, and reclaiming is
logged. So the guard is not new code and not a new dependency; it is the reuse guard pointed at a
second file. A lock whose `hostname` is not this host is **never** reclaimed automatically — the
liveness test cannot see another machine's process table, and guessing there is how two servers on
one network share come to run anyway.
Rejected: **refusing on any lock file at all, cleared by hand.** Simpler, with no liveness test to
get wrong, and rejected because every unclean shutdown then needs manual intervention before the
service returns — including an ordinary container restart, which is not an incident and must not
become one.
Rejected: **no lock, recorded as accepted risk.** Cheapest, and it leaves the failure silent. A
corrupted audit log and a reaped sibling's children are not failures an operator diagnoses from
symptoms.
Rejected: **an OS advisory lock** (`flock`, `LockFileEx`) instead of a file with contents. It is
self-releasing, which removes the staleness problem entirely — and it is rejected because the two
platforms differ here in exactly the way `10-design.md § Platform divergence` catalogues, it adds a
native dependency or a fragile shim, and it can tell you the root is held without telling you
*by what*. Naming the holder is most of the value when an operator is looking at a refusal.
Reversibility: cheap. One file, one boot step, one `StartupError` variant.
### 2026-08-19 — D162 Tool-output blobs get a per-session byte budget, refused at write
Context: `10-design.md` open question 2. Tool-output blobs (D22) are the only storage that grows
with tool volume rather than with session count, and one `find`-heavy turn can outweigh a month of
transcripts. Today they are deleted with their session and otherwise never — the option list called
that "a decision made by not making one".
Chosen: `Caps.sessionToolOutputBytes` bounds the **total** blob bytes one session may store. Past
it, the blob is not written and the tool result is unaffected in every other way: the envelope
still carries `truncated: true` and the true pre-truncation `bytes`, and the fetch route answers
`404 no_such_output`. Deletion with the session (D25) is unchanged and remains the other half of
the rule.
**What makes this cheap is that blob absence is already a designed state.** S9.5 specifies that a
missing or unreadable blob is `404 no_such_output` with the truncated envelope unaffected, so this
introduces no error path — it reaches an existing one deliberately. Enforcement is at write and
therefore synchronous, which keeps it inside the guard rule D32 already governs and avoids a
sweeper, a timer, and a second thing that can disagree with the directory.
**The rule stops at tool output and does not reach `attachments/`** (D160). The two directories
look alike and are not: a tool-output blob is the output of a command that can be run again, and an
attachment is operator-supplied and unreconstructible. Dropping the first costs a convenience;
dropping the second destroys the only copy. An attachment is bounded at upload by
`Caps.attachmentBytes` and `Caps.attachmentCount` instead, which refuse the write rather than
discard a stored file.
Rejected: **an age-based sweep at boot.** Predictable, and it never runs on a server that stays up
— which is this deployment. It also bounds nothing about a single burst, which is the case the
question was asked about.
Rejected: **evicting the oldest blobs within a session** rather than refusing new ones. It keeps
the budget while preserving recency, and it is rejected because it makes a completed, fetchable
link go dead later for reasons the operator never sees, and because scanning and deleting inside a
live session's directory is exactly the sweeper this decision avoids.
Rejected: **leaving it deleted-with-session and saying so.** Zero mechanism and consistent with
`audit.ndjson`'s accepted unbounded growth, and rejected because the objection here is *rate*
rather than growth: the audit log grows with approvals, which are human-paced, while a blob
directory grows with whatever a single command printed.
Reversibility: cheap. One cap, one test at one call site, and the absent-blob path already exists.
### 2026-08-19 — D163 No offset index; the spill is read backwards from the tail, as the audit log already is
Context: `10-design.md` open question 11 held that no append-only file here has an index and every
read scans, naming two files that needed one — the spill, and `audit.ndjson` as "the worse case",
since the audit log is never truncated and its scan would grow with the deployment's whole
lifetime.
**Half of that is now stale, and checking it is what changed the answer.** S12 landed a bounded
read: `readAuditPageImpl` walks backwards from the file's end under a scan budget, and I39 bounds
*the read* rather than merely the result — a filtered query returns a short page with a non-null
cursor instead of walking to byte 0. The audit log is therefore not the worse case and is not
unindexed-and-scanning; it is solved, by a technique rather than by a sidecar.
Chosen: no offset index, for the spill either, and the same technique instead. `readEventsAfter`
finds `after + 1` by reading **backwards from the tail** and then emits forward, which costs
O(envelopes since the disconnect) rather than O(file). This matches the access pattern rather than
fighting it: a reconnect's `Last-Event-ID` is recent almost by definition, because the client just
dropped.
**The case that scans most often is not the one an index would fix.** D147 makes the payroll view a
fold over every `usage` event in the spill, O(spill) per read, and a fold reads everything by
definition — an index gives it nothing at all. So the index's only beneficiary was deep replay, and
that is the case the backwards read already answers. Open question 11 named the index as the fix
for "both files that need it" without separating seek from aggregation, and separating them is what
leaves nothing for a sidecar to do.
Rejected: **an offset sidecar.** It buys O(1) seek and costs a second file that must stay
consistent with the spill, a crash story for a torn index against a torn spill — the spill's own
torn tail is already an accepted hazard (#33) and a second file doubles that surface — and byte
offsets becoming a quasi-public interface. D86 already refused exactly that for the audit cursor:
"a byte offset makes the file's physical layout a public interface, which is exactly what open
question 11's index would move."
Rejected: **deferring again with a stated threshold.** Honest, and it leaves a question open that
turns out to be answerable now, on evidence already in the tree.
Reversibility: cheap. Nothing is built that an index would later have to be retrofitted around; a
sidecar remains addable if a fold, not a seek, ever becomes the bound.
### 2026-08-19 — D164 `Start-AgentSession.ps1` is development tooling and is not reconciled against the product
Context: `10-design.md` open question 10 and issue #17 held that `tools/Start-AgentSession.ps1`
(D14) is "unreconciled against this architecture" — that it assumes a local interactive terminal
rather than the server/SSE/adapter shape D1 to D12 settled on — and that reconciling it should
wait until a slice first needs a CLI launcher.
Chosen: **there is nothing to reconcile, because the script is not part of the product.** Its own
header states its three jobs: routing an agent-kit slash command to the model family
`AGENTS.md § Command routing` prescribes, refusing to carry a session across a boundary
`§ Session boundaries` forbids, and launching it in the project directory. It is a developer's
tool for driving *this repository's own development*, sitting in `tools/` beside
`Test-DesignDrift.ps1` and `Measure-Session.ps1`, and gated with them by S19.11's Pester job.
Nothing about the server, the SSE edge or the adapter boundary bears on it, and a CLI launcher for
the product remains unbuilt and unasked-for.
**The confusion has a traceable source and it is worth naming, because it is what will cause the
question to be asked again.** D14 justified relocating the script here on the grounds that "its
subject — supervising agent sessions — is this repo's concern, not the kit's". That sentence reads
as the *product's* session supervision, which is exactly what this repository is about. It is not
what the script does: those are the *developer's* agent sessions. Two senses of "agent session",
and open question 10 inherited the wrong one.
Rejected: **reconciling it against the server/SSE/adapter architecture.** It would build a product
CLI launcher no definition-of-done item asks for, out of a script that does something else.
Rejected: **moving it back to `SubZeroDev.AgentKit`.** There is a real argument for it — if the
script's subject is routing `AGENTS.md`'s own commands, that is the kit's subject, and D14's stated
reason rests on the same conflation this decision identifies. It is declined because a re-reading
of an unchanged file is not new evidence, and *Budget discipline* forbids relitigating a signed-off
decision without some. Recorded here so the argument is retained rather than rediscovered.
Reversibility: cheap. Nothing is built or moved; a later decision to relocate the script is a pure
move, exactly as D14 was.
### 2026-08-19 — D165 Token-level streaming is sliced as S25, opening with the probe it needs
Context: `10-design.md` open question 5 and issue #13 ask whether
`claude --include-partial-messages` yields usable token-level deltas and whether `message.delta`
survives contact with it. It is an experiment, not a decision — nothing about it can be settled by
reading — and it has stayed open because no slice owned the run.
Chosen: slice it, opening with the finding, in the shape S8.1, S10.1 and S21.1 already use. The
issue closes as designed-and-sliced rather than as answered, and the answer becomes a gate on the
work instead of a note nothing depends on.
**Why it is worth doing at all, given no definition-of-done item needs it.** Brief item 3 —
"send a message and watch the agent's output stream in" — is satisfied by message-granular
streaming, so this is not a gap. What it is, is an **asymmetry that already exists**:
`message.delta` is a live envelope kind, `## Vendor mapping — Codex` maps
`item/agentMessage/delta` onto it on the `app-server` transport, and the Claude mapping has no
delta row. A Codex session streams token by token and a Claude session does not, on the console's
main surface. The renderer contract for it is already written and already exercised.
**The probe must answer more than "does the flag work", and the extra questions are the reason
this is a slice rather than an afternoon.** Three things ride on it. Whether the flag disturbs the
permission round trip, which S1.1 and S4.2 rest on and which is the one thing this project cannot
trade. Whether it disturbs `usage`, which D75 and S1.11 normalise per `message.id` and which a
second stream of records could duplicate. And **envelope volume**: every envelope today takes a
`seq`, enters the ring and is appended to the spill, so token-level deltas multiply all three by a
large factor — the spill grows, S9.7's ring bound means something different, D163's backwards
replay reads further per second of disconnection, and D147's payroll fold walks more lines.
**Whether deltas are persisted at all is therefore left open deliberately, as the slice's second
stop.** The renderer rule already says a client "may render either and must not render both",
which is what makes live-only deltas conceivable — and dropping them from the spill collides with
`seq` contiguity, which S1.5 asserts and replay depends on. That is a design decision, not an
adapter one, and S25.2 stops for it rather than letting the first implementation settle it by
omission.
Rejected: **running the probe inline and closing the issue with a finding.** It answers the cheap
half and leaves the volume question to whoever later writes the mapping, which is where an
unowned decision gets made by accident.
Rejected: **dropping token-level streaming.** Defensible — no DoD item needs it — and it leaves a
visible cross-vendor inconsistency on the main surface as a permanent choice rather than an
unanswered question.
Reversibility: cheap. Nothing is built; the slice may still stop at S25.1 and report the flag
unusable, which is a real outcome rather than a failure.

### 2026-08-19 — D166 `20-contract.md` states meaning and points at the tree for shape
Context: `/contract` has always required that the slice materialising a declaration replace the
scaffold with a pointer in the same commit, and `AGENTS.md § Single ownership` says a document
states only what the tree cannot. Neither was ever discharged: `src/contract/index.ts` had grown
to 1,022 lines declaring every type, every module interface and every error union in this
document, comments included, near byte-for-byte. The rot the rule predicts had already started —
the document declared `Caps.sessionToolOutputBytes`, `StartupError.storage_locked` and
`ServerLock`, none of which the tree carried, while the tree declared
`ApiErrorCode.no_such_attachment`, which this document's own routes table used and its union
omitted. Two copies, already disagreeing in four places, with no mechanism that would have said so.
Chosen: convert wholesale. Every block the tree materialises becomes a named pointer to its
declaring file plus the semantics a declaration cannot carry; a scaffold survives only where the
code does not exist yet, and each surviving one names the slice that owes it — S22 and S23 today.
Section headings are unchanged, so every `20-contract.md § X` citation in `30-slices.md`, the
issues and `src/` still resolves; `## Public signatures` is renamed `## Public surface`, which
nothing cited. `## Unresolved` is carried forward unchanged and no invariant or decision citation
was dropped, checked by set comparison rather than by eye.
**A comment in the tree is not the canonical statement of a rule**, and the new preamble says so.
The declarations carry explanatory comments copied from earlier revisions of this document; they
are a convenience for a reader already in the file, and where one disagrees with this document it
is the defect.
Rejected: **keeping the scaffolds.** The document stays self-contained and a frozen contract stays
genuinely fixed — the strongest argument against this change, since `AGENTS.md § The design freeze`
has slices implement against `20-contract.md` "as a fixed artifact at the SHA the marker names",
and a pointer into a moving tree weakens that. It loses because the tree at the freeze SHA is
pinned exactly as the document is, and because the alternative is keeping an arrangement that had
already diverged in four members with nothing able to detect it.
Rejected: **converting only the sections S22 touches**, leaving the rest for future slices. It
produces a document where an absent scaffold means either "in the tree" or "not yet decided" and a
reader cannot tell which, which is worse than either end.
Reversibility: expensive in effort, cheap in risk. The declarations are all still in git history,
and nothing downstream reads this document mechanically.

### 2026-08-19 — D167 `store` claims the storage lock; the liveness test is injected, not duplicated
Context: D161 decided the lock and `30-slices.md § S22` named `store.claimLock` / `releaseLock` as
the surface, but neither settled how D23's three-part liveness test is reused. The test lives in
`session-manager` (S7.5, S7.6, I19); the lock file lives under `<storage>`, which is `store`'s;
and `store → session-manager` is an edge `10-design.md § Module boundaries` forbids. D161 says
"the reuse guard pointed at a second file" — reuse, not duplication — and stops there.
Chosen: `claimLock` takes the liveness test as a parameter, `LivenessProbe = (holder: ServerLock)
=> Promise<boolean>`. `SessionManager.boot` calls it as step 0 and passes its own reuse guard, so
there is exactly one implementation of D23's test, called from two places, and `store` acquires no
dependency on process enumeration and no forbidden edge — the guard arrives as a value. `boot`
already returns `Result<void, StartupError>`, so `storage_locked` composes with no wrapper and no
signature change. `server.ts` calls `releaseLock` on clean shutdown.
**The first limb of the three-part test is satisfied structurally rather than by a field.** A
`ProcessRecord` carries `exitedAt` and a `ServerLock` does not, because `releaseLock` removes the
file: the lock's absence *is* that limb. The probe reads the other two. `30-slices.md § S22.3`
lists "an `exitedAt`" as one of three independently asserted limbs, which names a field
`ServerLock` has never had — reported as drift rather than reconciled here, since an acceptance
criterion is a decision and `20-contract.md` outranks `30-slices.md` (**#S22 drift**).
Rejected: **`store` implementing the test itself.** No wiring, and it could then claim at
`createStore` time beside the `storage_unwritable` refusal it belongs with. Rejected because it is
a second implementation of a guard whose failure mode is a wrong kill — the drift `agent.md`
warns about hardest, against D161's own word "reuse".
Rejected: **moving the claim into `session-manager`**, leaving `store` only file primitives.
Cleanest against I19 and the module table, and rejected because it contradicts `30-slices.md
§ S22`'s stated surface, so the contract and the slices would then disagree about which module
owns the method.
Rejected: **listing the signature under `## Unresolved` and stopping**, which is `/contract`'s
literal instruction for a signature the design does not determine. Rejected because the answer is
a wiring choice rather than an architectural one, and it would block S22 on a question one answer
settles.
Reversibility: cheap. One parameter, one boot step; nothing is built yet.

### 2026-08-19 — D168 A `message.delta` is a live-only frame and takes no `seq`, for both vendors
Context: `10-design.md` open question 5, and S25.2, which stopped the slice for this and named
`/design` as its owner. S25.1's probe (`design/findings/S25-token-streaming-probe.md`) cleared all
four of its gates against the installed CLI — `--include-partial-messages` emits usable incremental
text, it concatenates byte for byte to the final `message`, and it disturbs neither the
`control_request` round trip S1.1 and S4.2 rest on nor the per-`message.id` usage normalisation of
D75 and S1.11 — and left the volume question open by design. Measured: a 163-word reply produced
nine `content_block_delta` and fourteen `stream_event` records against one `assistant` record
today; a nine-word reply produced two and seven. Every envelope today takes a `seq`, enters the
ring and is appended to the spill, so persisting deltas multiplies all three by roughly an order of
magnitude on text turns. Codex already emits `message.delta` through that same path, so this was
never a Claude-only question.
Chosen: a `message.delta` is delivered to live subscribers and to nobody else. It carries no `seq`,
never enters the ring buffer, is never appended to the spill and never replays. It is therefore the
first thing a client receives that is **not** an envelope, and that frame-versus-envelope split is
now stated in `10-design.md § Event envelope` rather than left to whichever module noticed it
first. It applies to **both** vendors: Codex's `item/agentMessage/delta` mapping stops being
spilled.
**Why the cost is not payable.** Deltas concatenate exactly to the `message`, and the `message` is
spilled regardless. Persisting the deltas stores the same text a second time and buys nothing on
replay of a completed turn, because that envelope is already complete and authoritative. The one
thing it buys is mid-message reconnect fidelity — partial text a few seconds before the `message`
would have arrived anyway — and the price is about 10x spill bytes on text turns, 10x the lines
D147's payroll fold walks, 10x the distance D163's backwards replay reads per second of
disconnection, and a `ringCapacity` of 2000 (D99) covering roughly a tenth of the wall-clock it
covers today. S25.6's flag defaulting off would have mitigated the Claude half and done nothing
about the Codex half.
**Why `seq` is the deciding constraint rather than a casualty of it.** S1.5 asserts `seq` is
contiguous from 1 with no gaps, and replay depends on it. A delta that took a `seq` and was not
spilled would put a hole in the spill; a delta that took a `seq` and was spilled is the costly
option above. Giving deltas no `seq` at all removes the collision by construction rather than
weakening the invariant to accommodate a rendering nicety, and `(sessionId, seq)` stays the primary
key of everything replayable — the property `10-design.md § Event envelope` opens by calling
expensive to change.
**Why both vendors rather than Claude alone.** D165 sliced S25 to close a cross-vendor asymmetry on
the console's main surface. Ruling live-only for Claude while Codex's deltas stayed replayable
would close a rendering asymmetry by opening a persistence one, on the same surface — the trade
D165 declined in the other direction.
**What this owes elsewhere, and to whom.** `20-contract.md` states the delta concatenation rule in
`seq` order and carries `message.delta` in the envelope-kind union; both are amendments, and both
are `/contract`'s rather than this document's. S25.2 is answered and S25.3 to S25.7 are unblocked;
S25.4's byte-for-byte concatenation assertion loses its `seq` ordering and asserts arrival order
instead, and S25.6's flag-off comparison now holds trivially for persistence, which is a
strengthening of that criterion rather than a loss.
Rejected: **spilling deltas with a `seq`, uniform with every other kind.** The conservative
reading — no new frame class, no contract addition, mid-message-faithful on replay. Rejected on the
measured cost above, paid permanently, against a benefit the `message` envelope already delivers.
Rejected: **live-only for Claude, Codex left exactly as it ships.** Touches nothing already built
and needs no re-run of the Codex criteria. Rejected because it makes persistence vendor-dependent
for a single envelope kind, which is a worse inconsistency than the one S25 exists to remove, and
because it is the reading that gets chosen by nobody deciding.
Rejected: **dropping the delta kind entirely and rendering only whole messages.** The cheapest
thing in the tree, and it would delete `MessageDelta` and one Codex mapping row. Rejected because
it regresses Codex's shipped behaviour to settle a question about Claude's, and because *Rules the
renderer may rely on* was written for two granularities deliberately.
Reversibility: expensive in one direction only, and the direction chosen is the recoverable one.
Making a live-only delta persisted later is additive — it gains a `seq` and an append, and nothing
already written becomes wrong. Going the other way once deltas are in the spill means either a
spill with gaps or rewriting existing sessions' `events.ndjson`, and the ring-is-a-strict-suffix-
of-the-spill invariant makes the intermediate state unrepresentable.

### 2026-08-20 — D169 The attachment refusals are `session-manager`'s, and the documents named the edge
Context: `10-design.md § Control flow 2` drew `edge : attachments? adapter.acceptsAttachments,
count and size caps` and `20-contract.md § adapters/*` said "the edge reads it to refuse". All
three refusals — `acceptsAttachments`, `Caps.attachmentCount`, `Caps.attachmentBytes` — are in
`session-manager.message`, ahead of the turn-slot claim and inside the same unbroken synchronous
block (I5). The edge's only attachment-shaped use of the caps is deriving a request body-size
bound. The refusal a client sees is `422 bad_request` with nothing written either way, so this was
never a behaviour difference; it was two documents naming the wrong module.
Chosen: the documents change. An edge holds no reference to a live session's adapter — `EdgeDeps`
carries `manager`, `records`, `config` and `identity`, and reaches `adapters` only for `VENDORS`
(D126) — so an edge-side check needs a new method on `SessionManager` exposing an adapter
capability. `10-design.md § Module boundaries` already justifies the `edge/http-common → adapters`
arrow as membership testing *and nothing else*, so the tree matches that paragraph and these two
statements were the outliers.
Rejected: moving the check to the edge. It widens a public interface — `/contract`'s call — to
relocate a check whose outcome is identical, and leaves attachment validation living in two places
rather than one.
Rejected: recording the divergence and changing neither side. The alternative D142, D144, D148 and
D149 each rejected for the same reason: the next pass rediscovers it.
Reversibility: cheap. Prose in two files; no code moves.

### 2026-08-20 — D170 A dying session's last envelopes are live-only and do take a `seq`
Context: `session-manager` has two paths that build an `Envelope`, assign it a `seq`, advance
`record.lastSeq`, deliver it to the current subscribers, and touch neither the ring nor the spill:
`deliverDirect`, which carries D41's storage-failure completion set, and `remove()`'s
`error / session_delete_incomplete` (D25). So a delivered envelope carrying a `seq` is not always
replayable. Nothing said so. `20-contract.md § Streaming` enumerated exactly two envelopes outside
the durable stream — `replay_gap` (D156) and `message.delta` (D168) — and this is a third family
with the opposite shape: a gap restates a watermark and consumes no number, these consume one.
Chosen: state it, in `§ Streaming` beside the other two, and leave I1 and I2 alone. Both are
literally true — I1 governs what `emit` assigns and `emit` produces none of these, and `emit`'s
failure branch drops the ring before the first of them goes out, so the ring never holds an
envelope the spill will not (I2). What was missing was the consumer-facing consequence, not an
invariant. The behaviour itself is right: in both paths the file these would be appended to is dead
or already deleted, so there is nothing to append to and nothing to replay from, and advancing
`lastSeq` is what stops a client that saw them live being told on its next reconnect that its
resume point is past the end of history it already holds.
Rejected: **widening I1's exception clause to three items.** More complete, and it makes the
property assertable in the module that owns it — but amending an invariant is a decision
`AGENTS.md` routes to `/contract`, and I1's scope sentence is not false today, so the amendment
would be restating in the invariant what the section beside it now says.
Rejected: **routing both through `emitFrame` so they carry no `seq` at all**, matching
`message.delta`. Structurally the cleanest — nothing delivered with a `seq` would then be
unreplayable — and it changes the delivery shape of `turn.ended`, `session.ended` and `error` on
paths every client already handles as envelopes, and gives up the `lastSeq` bump the reconnect
check depends on. It is also implementation against a settled contract, which is `/fix`'s tier.
Rejected: recording the divergence and changing neither side. The alternative D142, D144, D148,
D149 and D169 each rejected for the same reason.
Reversibility: cheap. Prose plus this entry; no code moves.

### 2026-08-20 — D171 `contract` may declare a discriminator, not only an enumeration, and `isFrame` is one
Context: `src/contract/index.ts` exports `isFrame`, a type predicate over `Envelope | Frame`,
read by `session-manager` and `edge/sse`. Both documents say the module exports no such thing:
`20-contract.md § Public surface § contract` reads "Types, plus **one runtime enumeration**:
`RATINGS`", and `10-design.md § Module boundaries` said "Types only, no runtime" — a cell D150
never updated, corrected in this pass. D150 narrowed the property deliberately, to the
enumeration of a closed union a validator must test membership of, and required each such
export to be declared in the contract like any other public interface. `isFrame` is neither an
enumeration nor declared, and D168, which introduced frames, does not mention it.
Chosen: the contract changes. The frame-versus-envelope split is contract knowledge — I51
*defines* a frame as an envelope minus `seq` — so the discriminator belongs beside the types it
discriminates, and one canonical predicate is what D150's own anti-drift argument asks for. The
declared property widens once more and stays checkable: `contract` exports types, plus the
enumeration of a closed union a validator must test membership of, plus the discriminator for a
union the type system cannot separate structurally; each such export is declared there by name.
**The amendment is not made in this pass**, exactly as D150 declined to make its own: adding a
public interface `20-contract.md` does not carry is `/contract`'s, `opus`/`high`. Staged in
`## Open`.
Rejected: **moving `isFrame` to `session-manager`**, with `edge/sse` importing it over an edge the
module graph already draws. It keeps both documents true with no amendment. Rejected because a
predicate over `contract`'s own types would then live in the largest module in the system, and
because `edge/sse` would gain a concrete import where it takes the manager by injection today.
Rejected: **inlining `!('seq' in envelope)` at both call sites.** Smallest tree change, no
amendment. Rejected because two copies of the I51 discriminator is the drift D150's `VENDORS`
argument was written against, and a third site is one slice away.
Rejected: recording it and changing neither. The alternative D142, D144, D148, D149, D150, D169
and D170 each rejected for the same reason — it leaves a grep-checkable sentence false, which is
worse than an unstated one because it invites a reader to trust it.
Reversibility: cheap. Prose plus one declared function; nothing persisted and no signature moves.

### 2026-08-20 — D172 An ignore list is a list, and the Claude adapter's two inline drops join it
Context: `20-contract.md § Vendor mapping — Claude` states the rule as thirteen mapped rows plus a
**named** ignore list, and then: "Anything outside both the thirteen rows and that list still
raises `adapter_unknown_record`, non-fatally, with the record preserved in `raw`." Two paths in
`src/adapters/claude/index.ts` return silently instead, neither on a named list — a
`control_request` whose `subtype` is not `can_use_tool`, and a `stream_event` →
`content_block_delta` whose `delta.type` is not `text_delta` (`thinking_delta`,
`input_json_delta`). The second is commented as though it were on `IGNORED_STREAM_EVENT_TYPES`
and is not. The Codex adapter has no equivalent: every drop there goes through
`IGNORED_APP_SERVER_METHODS` or `IGNORED_ITEM_TYPES`.
Chosen: the code changes. Both cases become members of named ignore sets, so the contract's rule
stays literally true and the set of things this adapter swallows stays auditable in one place —
which is the whole value D92 attributed to the list. Implementation against a settled contract,
so `/fix`'s tier, `sonnet`/`medium`. Staged in `## Open`.
Rejected: **widening the contract's prose** to permit silent drops of unmapped sub-shapes of a
mapped record type. Cheapest in the tree and changes no behaviour. Rejected because "outside both
raises" is the property that made the list worth having, and a carve-out for sub-shapes admits
every future inline drop without review.
Rejected: **raising `adapter_unknown_record` for both**, which is what the contract already says
and needs no document change at all. Rejected because with `streamDeltas` on, every thinking block
and every streamed tool input would put a diagnostic line in front of the operator on every turn —
the failure D92 wrote the ignore list to prevent.
Rejected: recording it and changing neither, for the reason D171 gives.
Reversibility: cheap. Three strings and two conditions; nothing persisted.

### 2026-08-20 — D173 D88/D96's "no `control_request` fires" was two probe artifacts stacked, not a CLI defect

Context: S26.1 (`design/30-slices.md § S26`) required a written finding, against the real
installed CLI, on whether `control_request`/`can_use_tool` fires under the flags this server
spawns with — the mechanism D88 and D96 recorded as broken, tracked as an open upstream defect
(`anthropics/claude-code#34046`). `design/findings/S26-real-permission-round-trip.md` has the
full method and seven probe scripts. It fires, and correctly resolves both `allow` and `deny`,
driven through the unmodified production adapter (`src/adapters/claude/index.ts`) against the
real, installed CLI (2.1.228) — including a real double-answer rejection on a real child
(`{ok:true, value:{accepted:false}}`), matching the fixture-tested exactly-one-resolution
guarantee (D33, I9, I11) with a real process on the other end of the pipe.

Two things were true at once, and untangling them took most of the slice. **First**: the CLI's
prompt is genuinely tool/content-dependent, not universal — it fires for `Write`, `Edit`, and any
`Bash` command with a side effect, and does not fire for `Read` or a side-effect-free `Bash`
command, under the default mode (and `manual`, which `system/init` reports identically). D88's
two original probes (a `Read`, and `echo hello-from-bash-tool` — no redirect) were both,
unrecognised at the time, the safe case; the "no prompt of any subtype, in any case" reading in
`10-design.md § The hard problem` and `20-contract.md § Vendor mapping — Claude` generalised past
what those two commands could show. S25's run 4 (a `Write`, prompted) already contradicted the
generalisation and was logged as a puzzle rather than the missing half. **Second, independently**:
every standalone probe script written against this question — D88's original three, and this
finding's own first four attempts — closed the child's stdin immediately after writing the `user`
record, before any `control_request` could be answered on it. The CLI aborts the wait
near-instantly on a closed pipe (`AbortError: Stream closed`). Run against a state-mutating
command with that bug present, every mode looks broken regardless of what the CLI would actually
do. The production `send()` never had this bug — it was already correct, and its own fixture test
already documents the trap by name (`src/adapters/claude/index.test.ts`, S1.1's comment) — but
nobody had run it against the real binary before this slice to find out.

Chosen: correct the premise in place, the same way D27 and D96 corrected D5's — `10-design.md §
The hard problem` and `20-contract.md`'s Claude vendor-mapping section now state the
tool-dependent behaviour and cite this finding, and the table row claiming Claude's approval is
"not observed on a live wire" is corrected to "observed for state-mutating tool calls." D88 and
D96 are left standing as a record of what was believed and why, per the entries above; they are
not rewritten. `permission_suggestions` (D104, D108) is a related casualty: S10.1's probes were
the same miscounted "never appears" observation, and S26.1 directly observed it populated on
every state-mutating `control_request`. That reopens D108's *premise* without reopening its
*grammar choice*, which belongs to whoever next touches `StandingRuleExpression` — carried to
`## Open` below rather than decided here, since S10 is out of S26's scope (`design/30-slices.md §
S26`, *Out of scope*).

Rejected: leaving D88/D96 uncorrected and only landing S26's code-level consequence (none — no
transport change was needed). The documents would keep stating a universal "does not fire" that
three separate pieces of evidence (S25.1's run 4, this finding, and the fixture test's own
defensive comment) already contradicted, which is exactly the drift `AGENTS.md § Source of truth`
exists to catch. Rejected treating this as `/design`'s tier rather than correcting inline: this is
a factual correction to an observed capability, the same category D27 and D96 already established
as correctable within the slice that discovers it, not a new invariant, non-goal, or interface.

Reversibility: not applicable — a factual correction, not a design choice. `anthropics/claude-code#34046`
can be closed or narrowed to the tool-dependent behaviour actually observed; that is a report to
the vendor, not an action this repository takes.

### 2026-08-23 — D174 Shutdown repairs nothing; boot stays the only repair pass
Context: `10-design.md § Boot ordering` has six steps, four of which repair durable state left by
however the last process ended. The symmetric question — what a shutdown owes — had never been
asked, so `server.ts` grew a signal handler with no design behind it and the document said nothing
about a path every deployment takes on every restart. Every candidate answer is already boot's:
marking a rehydrated session ended (D20), closing a turn the spill left open (D39), emitting the
restart notice the payroll fold reads (D130), reaping an orphan under the reuse guard (D23).
Chosen: shutdown establishes no durable state and holds no invariant. It stops accepting work,
releases the lock, and exits; boot remains the sole repair pass, so the crash path and the clean
path converge on one implementation of each repair. The bar shutdown is held to is "leave nothing
boot does not already expect", which it clears by writing nothing.
Rejected: **finalising at shutdown** — mark sessions ended, close the open turn, emit the notice.
It cannot be complete, because `SIGKILL`, an OOM kill and a power cut produce no shutdown at all
and boot must handle the unfinalised case regardless; so it is a second implementation of boot's
repair whose only distinguishing property is running more often. Worse, it is the path a developer
exercises with Ctrl-C, which makes the duplicate the tested one and leaves the path that matters
untested — `agent.md`'s "a shortcut taken in the reference implementation gets copied", one level up.
Rejected: **a `clean-shutdown` marker file boot trusts to skip repair.** It makes boot cheapest in
exactly the case where nothing was wrong and unchanged in the case that matters, and it reintroduces
two code paths selected by a file that is absent precisely when things went badly — so the rarely
taken branch is chosen by the least trustworthy evidence available.
Reversibility: cheap. It is an argument about where existing work lives, and no code moves.

### 2026-08-23 — D175 The storage lock is claimed first and released last
Context: D161 argued the *claim* side hard — the lock precedes boot's reap step, not merely
`listen`, because a second server that got as far as reaping cannot tell the first server's live
agents from its own dead ones. The *release* side was never argued at all. `server.ts` happens to
release after `server.close()` settles, and "happens to" is what a design says out loud before
someone tidies it into a signal handler.
Chosen: release is the last act before exit, after the listener has closed and connections are
gone. Read backwards this is D161's own argument: a release issued while this server still has
children in `pids.ndjson` with no `exitedAt` lets a successor boot into a free lock, read those
entries, and reap processes that are still working — the identical wrong kill, arrived at from the
other end. A restart is the one moment a successor is certain to be starting.
**Failing to release is safe, and by design rather than by luck.** A `ServerLock` carries no
`exitedAt` because the file's absence *is* the first limb of D23's three-part test
(`20-contract.md § Server lock`, D167), so a lock nobody removed is reclaimed by the next boot on
the strength of the other two limbs.
Rejected: **releasing on signal receipt**, before the drain. Fastest, and it shortens the window a
restarting supervisor waits — and it opens exactly the window the lock exists to close, at exactly
the moment it is most likely to be walked into.
Rejected: **never releasing**, relying on the staleness reclaim every time. It works, and it makes
the reclaim the ordinary path rather than the exception. A guard exercised on every boot has
stopped being a guard, and `30-slices.md § S22.5` asserts the opposite by instrumenting the reclaim
and finding it uncalled.
Reversibility: cheap. One call's position in one handler.

### 2026-08-23 — D176 The shutdown drain is bounded, and what is still connected is then closed
Context: The clean shutdown path's own precondition is unreachable in the normal case. Closing an
HTTP listener closes the connections that are idle and waits for the rest, and a subscribed client
is by construction not idle — its response is open for the life of the stream. Probed rather than
assumed: with one open event-stream response the close callback does not fire (Node v25.3.0 on the
development host; the deployment image is `node:22`, where this was not re-run). Both `releaseLock`
and the zero exit sit behind that callback, so **a server with any operator watching it never
completes a clean shutdown on its own** — it waits out the supervisor's grace period, takes
`SIGKILL`, and leaves the lock behind. D175's release is then code that runs only when nobody was
connected, and D23's reclaim becomes the ordinary restart path rather than the exception S22.5
asserts it stays.
Chosen: bound the drain. Close the listener, allow a grace window for in-flight requests to finish,
then close whatever connections remain, then release and exit. **Force-closing a subscriber loses
nothing**: D40 already serves a reconnect from the spill when the ring cannot reach back far
enough, for live and ended sessions alike, and a stream cut without warning is the case that path
was built for.
Rejected: **closing subscriptions through the session manager**, so a subscriber is told the server
is going rather than discovering it. Politer, and it needs a shutdown surface on a `SessionManager`
that has `boot` and deliberately no counterpart, plus a traversal of every session's subscriber
set, to reach an outcome the HTTP server produces by itself.
Rejected: **leaving the unbounded wait and treating `SIGKILL` as the shutdown.** Zero code, and it
spends the supervisor's entire grace period on every ordinary stop while making the clean path dead
code in the configuration that ships.
Reversibility: cheap. Landing point: staged in `## Open` below, because this is a code change taken
outside a slice and `agent.md` is explicit that a decision with no landing point does not land.

### 2026-08-23 — D177 Shutdown kills the turn's child tree, and leaves the turn's closure to boot
Context: `10-design.md § Open questions` 15. Nothing killed the child at shutdown. The adapter
spawns `detached` on POSIX because D38's process-group kill requires it, so a terminal's Ctrl-C
reaches the server and not the agent: the CLI survives the console that was supervising it, keeps
write access to the operator's work-tree, and is collected only if the server comes back on that
host with a matching image. In the container the cgroup takes the tree and the question is moot;
on a bare host a server that never comes back leaves an unsupervised agent writing to a repository
indefinitely.
Chosen: shutdown kills the live turn's process tree, between the drain and the lock release, by
D38's mechanism — the one interrupt and boot's reap already share. **This is not D21's timer under
another name.** D21 refused to end a turn on elapsed silence because a long compile and a hang are
indistinguishable and only the operator can separate them; this step makes no judgement about the
turn, it observes that there will shortly be no console at all. The cost is stated rather than
hidden: **`docker stop` and Ctrl-C end a turn in flight**, and what is left behind is what
interrupt leaves behind — files already written stay written, and the pre-turn checkpoint is what
returns the workspace (D24).
**The kill does not go through interrupt, and that boundary is what keeps D174 intact.** Routing it
through the manager would emit `turn.ended`, resolve every pending permission and start the spill's
append chain at the moment the process is trying to exit, all under a stop reason D24 reserves for
the operator's own act. So the step is a tree kill and one `ProcessTombstone`, and nothing else;
the turn is closed at the next boot by D39, under `server_restart`, which is both truthful and the
reason D130's payroll marker already pairs with. Shutdown terminates what it started; boot repairs
what it finds.
The tombstone is the one durable write a shutdown makes, and it records something shutdown *did*
rather than repairing something it *found*, which is why it does not reopen D174. It is
best-effort and bounded like the release: a lost one leaves a dead pid recorded live, and D23's
reuse guard tombstones it at the next boot rather than killing whatever now holds that pid — the
case that guard exists for.
Rejected: **leaving it to boot's reap, recorded as accepted risk.** Consistent with D174 read at
its widest, and free in the container. Rejected because outside one it inverts the project's own
premise, and because the whole of the orphan's cost is conditional on an assumption — that the
server comes back, on this host, with a matching image — that nothing guarantees.
Rejected: **killing only outside a container.** Cheapest in stated cost, and it puts the code path
in the one configuration that never exercises it, so the shipped artifact would be the untested
case. That is the shape D174 rejects for finalise-at-shutdown, arrived at from the other side.
Rejected: **routing the kill through `SessionManager.interrupt`.** Reuses a tested path and needs
no new call site, and it makes shutdown emit, append and resolve during teardown and reports a
shutdown as an operator interruption — the misattribution `10-design.md § Interrupt` property 1
exists to prevent.
Reversibility: cheap. One step in one handler. Landing point: staged in `## Open` below, with
D176's.

### 2026-08-23 — D178 Shutdown's kill is silenced at the manager's own sink, not at the adapter
Context: `20-contract.md § Unresolved` 14. D177 fixed step 3's *outcome* exactly — the tree dies,
one `ProcessTombstone` per child, no envelope, no audit append, no spill write (I52) — and named
no call site for it. The three candidates are not interchangeable, and the reason is that a tree
kill by **any** route drives the adapter's `exited` notification. The manager's handler for that
resolves every outstanding permission, emitting a `permission.resolved` and appending an
`AuditRecord` for each as I11 requires, then reports the turn ended under `interrupted` — which is
emission, resolution, an append, and precisely the misattribution D177 refuses. So the real
question was never whether to silence that path but where the silence lives, and only two modules
can hold it: `adapters/*` raises the notification, `session-manager` holds it. `server.ts` reaches
neither without a new surface, so a manager counterpart was never optional.
Chosen: **the manager's own `notify` closure carries the mute, and `SessionManager` gains one
method for `server.ts` to call.** Every `AdapterNotification` already passes through that single
function — it is what an adapter is handed at create, `AdapterOptions.notify` — so muting there
covers `exited`, `event` and `cli-session` in one place and leaves no second path for a later
change to forget. `Adapter` is untouched, which keeps server lifecycle out of `adapters/*` in the
direction I20 fixes: a vendor adapter still knows nothing about the server stopping.
**The sink rather than the `exited` handler is the load-bearing half, and the tree says why:**
`turn.ended` is a *second, separate* notification the adapter sends immediately after `exited`
and inside the same synchronous callback (`src/session-manager/index.ts`). A mute written into
the handler would silence the cancellations and let the turn's closure through — an emission
during teardown, which is the thing I52 forbids — so only a mute at the point every
notification passes catches both.
**The tombstone stops being exit-driven, and that is the gain rather than the cost.** With the
sink muted the manager never learns the child died, so it writes the `ProcessTombstone` from the
process record at the moment it issues the kill. D177's record no longer has to win a race against
whatever budget the drain has left. I52 is then satisfied by construction rather than by
inspection — nothing reaches the sink, so nothing downstream *can* emit, resolve or append — which
is the difference between an invariant that is checked and one that cannot be broken by the code
below it.
Rejected: **`Adapter.detach()`, silencing at the source.** Structurally the cleanest reading, and
it leaves the manager with no mode at all. Rejected on cost and on blast radius: it is two public
additions rather than one, because the manager surface is needed either way and `detach` is added
to it rather than instead of it; and it is a public method whose only correct caller is shutdown,
so any other caller silently blinds a live session with nothing in the type to say so.
Rejected: **a kill from `server.ts` on the recorded `pid`/`pgid`**, the shape boot's reap uses,
with no manager surface. Attractive because it needs no new public interface at all. Rejected
because it does not reach the outcome: boot's reap emits nothing only for want of an adapter to
notice, and at shutdown one exists and is still watching, so the forbidden path runs exactly as
before — with no manager surface available to mute it.
Reversibility: cheap. One method and one flag, both above `adapters/*`. Landing point: staged in
`## Open` below, with D174–D177's. Owed elsewhere: the `SessionManager` method is a public-surface
addition and is `/contract`'s to write into `20-contract.md`, which is also where `Unresolved` 14
is closed.

### 2026-08-25 — D179 The published image installs both vendors' CLIs, and the 2026-08-19 entry's claim is corrected
Context: issue #198. The 2026-08-19 entry above ("The deployment artifact borrows the host's
authenticated Claude CLI") documented the Dockerfile and both Compose files as they stood the day
this repository first shipped a container — `npm install -g @anthropic-ai/claude-code` in the
image, the operator's own `~/.claude` bind-mounted over it, no baked-in credential. That was
accurate then and is not now: `src/adapters/index.ts`'s `VENDORS` has advertised `['claude',
'codex']` since Codex's own adapter landed, `design/00-brief.md` names both vendors, but the image
never installed a `codex` executable and neither Compose file mounted a Codex credential
directory. A clean, documented deployment built from either file could not open a Codex session —
`createAdapter`'s `codex` case constructs successfully, but the adapter's own transport probe
(`detectTransport` in `src/adapters/codex/index.ts`) finds no `codex` on `PATH` and returns
`agent_unavailable` the first time a session tries to start one. Reproduced against a clean build
of `main` at the commit issue #198 was filed against: `docker run --rm skynet-hr:<sha> codex
--version` exits 127, `exec codex failed: No such file or directory`.
Chosen: install `@openai/codex` in the runtime stage the same way the Claude CLI already is —
pinned (`ARG CODEX_VERSION=0.146.0`, the exact build `design/findings/S8-codex-adapter.md` probed
and the adapter's own tests were written against), globally, with a `codex --version` build step
so a broken or renamed package fails the build rather than surfacing as a runtime
`agent_unavailable` nobody sees until a session is opened. Both Compose files gain a
`CODEX_CREDENTIALS_DIR` bind mount over `/home/node/.codex`, required (`:?...`) the same way
`CLAUDE_CREDENTIALS_DIR` already is — symmetric with the existing Claude mount rather than
optional, on the reasoning that this one image advertises both vendors and an operator using only
one can still point the other vendor's mount at an empty directory: that vendor's sessions then
fail per-turn auth, not container startup, which is a cheap, already-documented failure mode
(`agent_unavailable`) rather than a new one. `.github/workflows/publish.yml`'s image gate adds one
step verifying `codex --version` and `codex exec --help` both answer inside the built container
with no credential mounted — the same no-credential-needed property the adapter's own transport
probe already relies on — so a future regression that silently drops the Codex install from the
image fails the gate instead of only surfacing the next time an operator opens a Codex session.
`src/adapters/index.ts`'s `VENDORS` list needed no change: it already declared both vendors before
this fix, and "runtime capabilities advertise only vendors actually installed" (issue #198's fourth
`Done when` item) is satisfied by the image now matching what that list already said, not by
changing what the list says.
Rejected: amending the brief to a Claude-only product and dropping the Codex vendor entirely — the
brief, contract and a working, tested adapter all already commit to two vendors; #198's own
"Suggested direction" names this as the fallback only if the two-vendor contract were not the
intended product, and nothing surfaced here suggests it is not.
Reversibility: cheap. Two Dockerfile lines, two Compose mount lines apiece, one CI step; nothing
in `src/` changed, and none of `design/00-brief.md` or `design/20-contract.md` needed a word
altered — both already described two vendors, and this entry is the record that the deployment
artifact has now caught up to what they already said.

### 2026-08-25 — D182 A restore reports the ignored paths it did not roll back
Context: A red-team pass on `main` at `984eae5` found that DoD #6 promised the workspace back at
its state before an earlier message while `10-design.md` deliberately excluded every
`.gitignore`d path from both the checkpoint and the clean. Both are defensible and they cannot
both be unqualified, so this was ruled a brief conflict rather than a defect. The operator-facing
consequence is the part neither document owned: an agent that edits `.env` or removes a generated
artifact leaves that change standing across a restore the console reports as successful, and the
operator has no way to learn it short of noticing.
Chosen: qualify the brief and buy back the honesty rather than the reach. `00-brief.md` item 6
gains "and be told what the rollback could not reach" plus a paragraph saying the exclusion is a
decision and why; `10-design.md`'s symmetry bullet gains the reporting obligation. A checkpoint
records a manifest of the ignored paths `git status --ignored=matching` names — never their
content — and a restore diffs the target's manifest against the workspace and names what differs.
`--ignored=matching` collapses an ignored directory into one entry, so the manifest is bounded by
the matching ignore rules rather than by the files beneath them; the cost is that a collapsed
directory is compared on its own metadata, which sees a child added or removed and not an edit
deeper inside. That weakness is stated in the design because the report is a pointer for the
operator and not evidence, and no security control may come to lean on it.
Rejected: amending the brief and stopping there. Cheapest, and the design already carried the
reasoning — but it leaves the console saying "restored" over a workspace that is not, which is the
same class of silent partial success `read-tree`'s verification pass (D112) exists to refuse.
Rejected: widening the checkpoint with `add -A -f` and `clean -fdx` so item 6 becomes literally
true. It makes every restore force a dependency reinstall, which is the failure that makes
operators stop using restores at all — the exact argument D31's symmetry was adopted for — and it
grows a checkpoint with the workspace rather than with the diff. Expensive to reverse once
checkpoints exist holding that content.
Rejected: a manifest that walks the files inside an ignored directory. Precise, and it costs more
per checkpoint than the checkpoint does on any workspace with a dependency tree.
Reversibility: cheap for the two documents. The manifest itself is a new persisted artifact and a
new field on the restore result, so it needs a `/contract` amendment before it is implemented;
this entry does not authorise that edit.
Note: D180 and D181 are reserved by the unmerged `design/180-storage-lock-lease` branch, which is
why this entry is D182.


### 2026-08-25 — D183 The pid reuse guard gains a creation-time limb, and fails closed
Context: The guard reaps a `pids.ndjson` entry when it has no `exitedAt`, its `startedAt` is later
than the host's last boot, and the live process's image matches. A red-team pass on `main` at
`984eae5` found all three pass on same-boot reuse: the recorded child exits, the host hands pid
4242 to another `claude`, and boot runs `taskkill /PID 4242 /T /F` against another operator's live
agent and everything under it. The image limb is nearly free to satisfy by accident in a console
whose every child is named `claude` or `codex`, and the boot-time limb was written against
reboots when reuse is not confined to them. `src/session-manager/index.ts:509` implements exactly
the three documented limbs, so this is a defect in the design and in the code together.
Chosen: a fourth limb comparing the live process's own creation time against the recorded
`startedAt`, and where creation time cannot be established the entry is tombstoned and logged
rather than reaped. Node exposes creation time on no platform, so each is a shell-out of the shape
`taskkill` already is — CIM `Win32_Process.CreationDate` on Windows, `/proc/<pid>/stat` field 22
against `/proc/stat`'s `btime` on Linux. The same helper serves the `server.lock` staleness test,
whose same-container PID/image reuse failure is #206's second bullet.
Rejected: the same limb, failing open — falling back to the three existing limbs when creation
time cannot be read. It reaps more genuine orphans automatically, and it leaves a live path to
the exact incident the guard exists to prevent, on precisely the hosts where the check is least
reliable. The cost of failing closed is one orphan an operator ends by hand, which the
spawn-window paragraph already accepts as the price of not owning a pre-spawn handle.
Rejected: abandoning pid identity for an OS-enforced ownership token — a Windows Job Object, a
cgroup. Correct by construction, and it would also close the spawn-window exposure. It is the
dependency D23 rejected, it is a far larger change, and it overlaps the unmerged
`design/180-storage-lock-lease` work; nothing here is new evidence against D23.
Reversibility: cheap. One limb, one helper, and the tombstone-and-log path already exists.

### 2026-08-25 — D184 A turn owns every process it spawned, and ends all of them
Context: `10-design.md § Process lifetime` claims checkpoint restore is safe by construction
because no turn means no child and no child means nothing holds a handle on the workspace. A
red-team pass found "no child" meant only "no CLI". A tool that starts a detached process — a dev
server, a watcher — leaves it running when its CLI parent exits, and `close` in both adapters
notifies and clears without calling `terminate` (`src/adapters/claude/index.ts:528`). Interrupt
tree-kills and boot reaping tree-kills; ordinary completion, the overwhelmingly common way a turn
ends, did not. So the workspace is reported idle, the claim released and the next session admitted
while an untracked process is still writing — a Windows restore failure by the exact mechanism
D16 claims to make impossible, and a silent cross-session race on POSIX.
Chosen: run the tree kill on every path a turn can end by, normal exit included, using the
mechanism interrupt and boot reaping already share (D38, D148). There is one way to end a process
tree in this server and no path may grow a second. The consequence is stated in the design rather
than discovered: an agent cannot leave a server running past the end of its turn.
Rejected: leaving descendants alive and adding a liveness check before a restore and before the
workspace claim is released. It preserves the deliberate dev-server case, at the cost of a new
detection path on two platforms and a workspace claim that becomes conditional on something no
component can observe — which is the complexity D30's blanket refusal was adopted to avoid.
Rejected: accepting the leak and correcting only the prose, so the design stops claiming safety by
construction. Cheapest and honest, and it leaves operators a Windows restore failure that this
console exists to not have.
Reversibility: cheap. One call on an existing helper, on a path that already runs.

### 2026-08-25 — D185 The storage root may not overlap a workspace root
Context: D30's overlap rule compares live sessions' `cwd` to each other. Nothing compared the
server's own storage tree to the roots it admits sessions in, and `storageRoot` was a raw
configuration string while `workspaceRoots` were jail-normalised (`src/config/index.ts:184`) — so
the two could not have been compared even had anything tried. Storage at `D:\work\.skynethr`
under a root at `D:\work` puts `meta.json`, the event spills, the audit log, the process records
and every `ckpt.git` inside a checkpoint's work-tree: `add -A` ingests live server state and grows
recursively, and a restore or `clean -fd` deletes evidence the server is mid-write on — including
the audit log D25 exists to keep beyond the reach of the subject it indicts.
Chosen: canonicalise `storageRoot` through the jail's own normalisation, then refuse to start when
`pathsOverlap` says it meets any `workspaceRoot`. `pathsOverlap` is the one containment predicate
in this server and no second is hand-rolled for this. The refusal reuses
`ConfigError.invalid_field` with `field: 'STORAGE_ROOT'` and a `detail` naming the root it
collides with, so no new public interface is minted and no contract amendment is owed. The shipped
Compose deployment already separates `/workspaces` from `/data`, so nothing documented moves.
Rejected: a dedicated `ConfigError` variant. More legible in a log, and it is a contract surface
this decision has no standing to add; `invalid_field` with a naming `detail` is honest, since the
field genuinely is invalid relative to `WORKSPACE_ROOTS`.
Rejected: refusing at session creation instead, so a misconfigured deployment still serves the
workspaces that do not collide. It trades a loud startup failure for a quiet partial one, and the
thing at risk is server-wide evidence rather than one session's files.
Rejected: permitting the overlap and pathspec-excluding the storage subtree from `add -A` and from
restore. It supports the storage-inside-the-repo layout, and D30 already rejected pathspec-scoped
checkpoints on the grounds that they make restore partial by design and hand the shared-workspace
question to every downstream component.
Reversibility: cheap. One predicate call at configuration load; deleting it restores today's
behaviour exactly.


### 2026-08-25 — D186 The pid-reuse guard's fourth limb compares a recorded OS reading, not `startedAt`
Context: D183 added a fourth limb reading "the live process's own creation time matches the
recorded `startedAt`". Deriving the contract from it exposed that those two values come from
different clocks and are never equal: `startedAt` is this server's wall-clock reading taken at
spawn, while a platform derives creation time from boot time plus ticks — on Linux from
`/proc/stat`'s `btime`, which is second-granularity, plus `/proc/<pid>/stat` field 22. Compared
for equality the limb never passes and the guard reaps nothing; compared within a tolerance, the
window has to absorb clock-domain error and NTP steps, and a window wide enough to be reliable is
wide enough to admit same-second pid reuse — which is the case D183 exists to close. D183 did not
determine the rule, so this settles it rather than reopening it.
Chosen: record the operating system's own reading at spawn, as `ProcessRecord.osCreatedAt`
(`IsoTimestamp | null`), and have the guard compare it for exact equality against the same
platform source at boot. Like is compared with like, there is no tolerance to pick or justify, and
the shell-out at spawn is the shape `taskkill` already is. `ServerLock` gains the same field for
the same reason — the `server.lock` staleness test shares the implementation, and same-container
pid-and-image reuse defeats three limbs there identically. Where the spawn-time read fails the
field is `null`, and a `null` is tombstoned and never reaped, which is the fail-closed posture
D183 already chose at the other end.
Rejected: a tolerance window against `startedAt`, D183's literal wording. No new field and no
spawn-time cost, and it turns a security limb into a tuned constant whose safe value is smaller
than its reliable value. The two requirements have no overlap, which is the whole finding.
Rejected: deriving `startedAt` itself from the OS reading, so one field serves both limbs. It
collapses the new field away, and it retypes an existing field two other limbs and every log line
already depend on; a spawn whose OS read failed would then have no `startedAt` at all, which the
boot-time limb needs.
Reversibility: cheap while nothing has been written. One additive nullable field on two records,
and readers already ignore unknown fields.

### 2026-08-25 — D187 The ignored-path manifest is a per-checkpoint sidecar written by `checkpoints`
Context: D182 ruled that a restore reports the ignored paths it did not roll back, and delegated
the manifest's shape and home to `20-contract.md` without settling either. Two constraints shaped
the answer. The manifest is keyed by a checkpoint sha that does not exist until the commit
returns, so it cannot be part of the commit it describes. And `20-contract.md § Types §
Checkpoint` claims no mirror is persisted because git is the store — a claim this artifact has to
either break or work around.
Chosen: one JSON file per checkpoint at `<storage>/sessions/<sessionId>/ignored/<sha>.json`,
written by `checkpoints` rather than by `store`. `checkpoints` already derives that directory from
`config.storageRoot` and already runs the `git status --ignored=matching` the manifest is built
from, so no module edge is added — which `store` ownership would have required, since
`checkpoints` depends on `store` nowhere. The "git is the store" claim is stated as an exception
rather than softened: ignored paths are the one thing git holds no record of, so there is nothing
for a second copy to disagree with. What a sidecar can be is *absent*, and that is answered by
I58 — `unreached === null` is unknown and never "nothing differs", covering an absent file, an
unparseable one, and a `status` that fails at either end.
Rejected: a git note on a dedicated ref inside `ckpt.git`. Keeps the no-mirror claim literally
true, travels with the history, and dies with `destroy` for free. It costs notes plumbing on every
read and write and a second ref to reason about, and it does not remove the missing-manifest case
that forced I58 anyway — a note is as absent as a file. The claim it preserves is one sentence in
a document; the plumbing is permanent.
Rejected: storing the manifest inside `meta.json`. One file fewer, and it puts per-checkpoint data
under the one file with a `schemaVersion` gating rehydration (D49) — a corrupt manifest would then
cost the whole session at boot, which is the opposite of the degrade-to-unknown behaviour this
needs.
Rejected: recording content or a hash per ignored path, making `'modified'` exact. It is the
widening the brief declined arriving by the back door, paid on every checkpoint rather than on the
one restore that reads it, and on a workspace with a dependency tree it costs more than the
checkpoint does. Size and mtime are what make `'modified'` detectable without it; the
collapsed-directory blindness that leaves is stated in the contract and in I58 precisely so no
control comes to lean on the report.
Reversibility: cheap while no checkpoints carry one. The file is additive, nothing rehydrates from
it, and deleting the mechanism degrades every restore to today's silence.

### 2026-08-26 — D188 Kit re-install: /done renamed to /clean, delivery delegation widened to all work, Codex tier resolution moved to configuration
Context: `/kit-sync` against `SubZeroDev.AgentKit` at `de6ae8f` (previously synced at `80a19bdd`,
30 commits behind). `Sync-Kit.ps1` found `.claude/commands/done.md` removed upstream (renamed to
`clean.md`, #122) and `.claude/commands/install-all.md`/`kit-help.md`/`kit-sync.md` updated
outright; two non-core tools (`Test-DesignDrift.ps1`, `Update-WorkMirror.ps1`) had diverged in
both directions; six files present in the kit since before the last sync
(`Read-DesignState.ps1`, its `.Tests.ps1`, `Test-DesignState.ps1`, its `.Tests.ps1`,
`Update-DesignProjection.ps1`, its `.Tests.ps1`, and `Test-CIWorkflow.Tests.ps1`) had never been
installed here; and `AGENTS.md` had drifted from the kit's content on several points beyond what
`Sync-Kit.ps1` covers, since it only diffs kit-owned command/tool files.
Chosen, one per fork:
- **Adopted the `/done` → `/clean` rename.** The new `/clean` always hands off to `/track`
  (#111/#121), unlike this repository's non-pipelined `/done`. Deleted `done.md`, took `clean.md`
  outright, and updated the 2 `AGENTS.md` references and the Command routing row.
- **Took the kit's `Invoke-GhRaw` UTF-8 fix** for `Test-DesignDrift.ps1` and `Update-WorkMirror.ps1`
  (native `& gh` capture decodes non-ASCII via the OEM code page on Windows, corrupting section
  marks and em dashes in issue text) — a real bug this repository's copies had not received — and
  **re-applied this repository's own `(?!\.)` regex fix** on top of `Test-DesignDrift.ps1` (without
  it, `^S5\b` also matches a bug issue titled `"S5.1's interrupt test is flaky..."` as if it were
  slice S5's own tracking issue), which has no upstream equivalent and would otherwise have been
  silently dropped by taking the kit's file verbatim.
- **Skipped the six design-state/projection files**, matching `D164`'s precedent for
  `Start-AgentSession.ps1`. Each file's own docstring says it targets `design/state/`, a
  structured per-record Markdown schema (`design/20-contract.md § Persisted schemas` — the kit's
  own contract, not this repository's) that is explicitly documented as absent "in every installed
  target, where design/state/ does not exist by design." This repository's `design/` uses the
  prose-plus-append-only-decision-log methodology instead; the two are alternatives, not layers.
- **Added `/install-code-review-agent`** (writes only `.github/workflows/claude-code-review.yml`;
  GitHub App consent and the API secret stay manual by the command's own design) and
  `tools/Invoke-CodexCommand.ps1` (a `codex --profile` launcher keyed off `AGENTS.md`'s Command
  routing table) — both new, no local conflict.
- **Added the missing `## Marked regions` section to `AGENTS.md`.** `.claude/COMPANIONS.md`
  (already installed) names it as the section defining what a "declared" region is; this
  repository's `AGENTS.md` had no such section, a dangling cross-reference rather than a fork.
  Installed the kit's text, dropping its `design/20-contract.md § Marked regions` pointer (that
  section does not exist in this repository's contract).
- **Adopted retiring the "High volume"/`haiku`/`Luna` tier.** The kit merged that tier's work
  (summaries, formatting, changelogs, commit messages, PR descriptions, mechanical triage) into
  Implementation (`sonnet`, medium/high) and dropped haiku and `Luna` everywhere. Retargeted
  `/kit-help` and `/clean` (formerly `/done`) from `haiku`/`low` to `sonnet`/`medium` to match.
- **Adopted widening delivery delegation to all work, not just the named commands.** The kit's
  *Git and delivery* now requires every session to branch off the default branch before its first
  edit and delegates commit/push/PR-open uniformly, rather than scoping delegation to `/slice`,
  `/fix`, `/pr` and `/install` by name. This session had already branched before editing, which is
  what surfaced the gap.
- **Adopted `/code-review` running `high` effort by default, always applying fixes, and
  auto-committing/pushing the result** — consistent with the delivery-delegation widening above;
  once a fix is being applied on a branch, committing it is no longer a separate ask.
- **Adopted resolving a Codex session's tier from its configured `model`/`model_reasoning_effort`
  (via `codex/PROFILES.md`, layering any `--profile` overlay) rather than from its self-reported
  name.** Replaced the `Vendor model aliases` table and its surrounding text with the kit's
  configuration-based version, dropped the stale `Luna` row, and made a bare `GPT-5` self-report an
  explicit unresolved-mismatch rather than a match for Implementation tier — closing a real gate
  gap, since every model in that family answers `GPT-5` regardless of which tier it is actually
  running at.
Rejected: leaving any of the above as a silent gap for the next sync to re-raise — each has a
concrete reason (a real bug fix, a closed gate gap, or a stated kit-internal boundary) rather than
being simple staleness, so each is worth a citable record now.
Reversibility: cheap. All wording and tooling; no product code or contract shape changed.

### 2026-08-26 — D189 `Test-DesignReferences.ps1` learns a conditional citation; adopting the record mechanism is judged by its five non-work directories, not `design/state/` as a whole
Context: `/pr`'s gate phase on D188's branch found `tools/Test-DesignReferences.ps1` (issue #210,
PR #225) failing with all 5 of this repository's `design/10-design.md` § citations broken —
`contract.md`, `design.md`, `fix.md`, `reconcile.md` and `slice.md` each cite `§ Record` or
`§ Orient`, and neither heading exists in this repository's `10-design.md`. Confirmed pre-existing
on `main` (`git show main:.claude/commands/contract.md` carries the identical line; none of the
five files are touched by D188), and out of `/pr`'s gate-phase scope by its own rule against
fixing a failure there — put to the user as a decision (fix here vs. file an issue), who chose to
widen this PR's scope and fix it now. Each citation's own text is already conditional — "Where
this repository's own `design/state/` exists, ... `§ Record`/`§ Orient` ..." — but the checker
enforced every citation unconditionally. A first fix (checking bare `Test-Path design/state`) was
wrong: this repository's `design/state/` already exists, holding only `work/` — `/track`'s WorkRef
mirror (`Update-WorkMirror.ps1`), a separate mechanism this repository already runs, unrelated to
`§ Record` (the decision-writing sequence) or `§ Orient` (unit-closure orientation). Those sections
describe the other five record kinds the kit's own contract defines
(`units`/`invariants`/`contracts`/`decisions`/`questions`), none of which this repository has ever
populated — consistent with D188 skipping `Read-DesignState.ps1`/`Test-DesignState.ps1`/
`Update-DesignProjection.ps1`, the tools that would create or read them.
Chosen: a citation on a line matching `design/state/`?\s*exists` (case-insensitive) is conditional;
a conditional citation is checked against `10-design.md`'s headings only when at least one of
`design/state/{units,invariants,contracts,decisions,questions}` exists — never `design/state/work/`
alone, and never bare `design/state/`. An unconditional citation is checked exactly as before.
Added four Pester cases: a conditional citation skipped absent any record-kind directory, the same
citation enforced once one is added, a populated `work/`-only mirror still not counting as
adoption, and an unconditional citation still failing regardless. `Run and passed:` in this PR's
`Verified` section replaces the earlier `Run and failed:` entry for this gate — the same tree this
paragraph describes, not two different results reported.
Rejected: dropping the conditional prose from the five command files instead — they are kit cores
this repository does not own reconciling by hand (`.claude/COMPANIONS.md`); an edit there would be
a local fork with no companion, `Unmigrated-Blocked` on the next `/kit-sync`. Rejected treating
bare `design/state/` presence as adoption — correct only by accident today (this repository's sole
subdirectory happens to be `work/`), and wrong the moment any repository runs `/track`'s WorkRef
mirror without ever adopting the record mechanism, which is this repository's actual shape.
Reversibility: cheap. `tools/Test-DesignReferences.ps1` and its tests only; no product code, no
contract shape, and no command-core file changed.

### 2026-08-29 — D190 S3.3's remaining divergence is transcribed, closing #66
Context: D40 (2026-08-08) already decided S3.3's assertion should read "a gap is reported only
when the spill cannot serve", recorded as a slice change, but the edit to `30-slices.md` was
never made — the same as D111 found for D105's freeze marker. D155 transcribed #66's other
divergence into `20-contract.md § Streaming` already; this is the second half of the same issue,
adjudicated and unlanded rather than undecided.
Chosen: S3.3 now reads "a healthy spill produces one only for a resume point outside the
session's history; a truncated or unwritable spill produces one for any range" — matching
`20-contract.md:1694-1697`'s wording for the same rule. The criterion id is unchanged.
Rejected: reopening the question. D40 already settled it; nothing found while checking the tree
against the criterion counts as new evidence (`AGENTS.md § Budget discipline`).
Reversibility: cheap. One sentence in one slice criterion; no behaviour moves.

### 2026-08-30 — D192 Kit sync (d57880d→5095a55): design-state mechanism un-skipped, two tool divergences resolved kit's-way
Context: `/kit-sync` against `SubZeroDev.AgentKit` (previously synced tools/commands at `d57880d`,
12 commits behind at `5095a55`). The kit's current `track.md` core now unconditionally runs
`tools/Update-DesignProjection.ps1` after the work-mirror refresh and commits mirror+projection
straight to `main` under a new `AGENTS.md` carve-out — but `D188`/`D189` had deliberately skipped
that script (and `Read-DesignState.ps1`, `Test-DesignState.ps1`, `Test-CIWorkflow.Tests.ps1`),
matching `D164`'s precedent for `Start-AgentSession.ps1`. Taking `track.md`'s core outright, as
`.claude/COMPANIONS.md` requires with no per-repo reconciliation, would have made `/track` invoke
a script this repository does not have. Separately, `Sync-Kit.ps1` found two non-core tools had
diverged in both directions: `tools/Invoke-DoneHousekeeping.ps1` (kit added a
`TipAheadOfMergedPr` safety check verifying a branch's local tip against the merged PR's
`headRefOid` before force-delete, with tests; this repository independently fixed a stale
`$Matches` bug, #228, with its own regression test) and `tools/Update-WorkMirror.ps1` (kit added
re-fetching closed issues individually so their `WorkRef` never sticks at `OPEN`, plus a
write-only-if-changed optimization; this repository independently added two small correctness
fixes — a single-element array unwrap via the comma operator in `Get-IssueCriteriaIds`, and no
trailing space on an empty `Criteria:` line).
Chosen, one per fork:
- **Reversed `D188`/`D189`'s scope decision and adopted the full design-state mechanism**, on new
  evidence: the kit's own `/track` now structurally depends on `Update-DesignProjection.ps1` to
  satisfy the direct-to-main carve-out, and this repository already carries the exact PR-churn
  loop that carve-out exists to break (`Refresh work mirror after /track run`, #234). Installed
  `Read-DesignState.ps1`, `Test-DesignState.ps1`, `Update-DesignProjection.ps1` (+ their `.Tests.ps1`),
  `Test-CIWorkflow.Tests.ps1`, `Test-RecordWritingSequenceCitation.Tests.ps1` and
  `Test-TrackCommand.Tests.ps1`; added `AGENTS.md § Writing a design-state record` and the
  direct-to-main exception clause in *Git and delivery* the new tests and `track.md`'s core both
  assume. `design/state/{units,invariants,contracts,decisions,questions}` remain unpopulated and
  `design/20-contract.md` still has no `§ Marked regions` section defining the schema — the
  tooling is adopted, not the record set itself. That population, and the contract schema section,
  is `/contract`'s or `/design`'s to do, not a routine sync's.
- **Took the kit's `Invoke-DoneHousekeeping.ps1` and `Update-WorkMirror.ps1` verbatim**, against my
  recommendation to merge — the user chose simplicity over preserving both sides. This discards
  #228's stale-`$Matches` fix (reintroducing that bug) and the two `Update-WorkMirror.ps1`
  correctness fixes. Adopted the matching `AGENTS.md` paragraph widening force-delete delegation
  to squash-merged branches on the `TipAheadOfMergedPr` evidence, consistent with taking the tool
  outright.
- **Adopted `AGENTS.md`'s `AGENTKIT_TIER` stamp-first tier resolution, the `/next` row and command,
  and the `Hard rules` section's reordering** (moved earlier, right after *Model, effort, and
  review budget*, matching the kit) — pure additions/reorg, no local content lost.
- **Left the dropped `design/20-contract.md § Marked regions` cross-reference dropped**, per
  `D188` — that section still does not exist in this repository's contract, and adopting the
  design-state tooling above does not by itself write it.
- **Noted a `Sync-Kit.ps1` defect**: a kit-owned file present unchanged in the kit since the
  target's recorded sync sha, but that the target never had on disk, is invisible to the script's
  report — it falls into the `NoUpstreamChange` branch without ever checking target existence.
  Affected `Read-DesignState.ps1`, `Read-DesignState.Tests.ps1`, `Update-DesignProjection.ps1` and
  `Test-CIWorkflow.Tests.ps1` this run; copied by hand instead of relying on the script. Not filed
  as an issue here — it is a defect in `SubZeroDev.AgentKit`, a repository this entry does not
  own reporting into.
Rejected: keeping `D188`/`D189`'s skip (my recommendation) — would have shipped a `/track` whose
core calls a missing script. Merging both tool files instead of taking the kit's version outright
(my recommendation) — declined in favour of the simpler, kit-verbatim option.
Reversibility: mixed. The design-state adoption is cheap to reverse — tooling and prose only, no
product code, and no `design/state/` records depend on it yet. The tool-file choice is the more
expensive one to notice going wrong: #228's bug and the two `Update-WorkMirror.ps1` fixes are gone
silently until someone rediscovers them.

## Open

Staging only. Once an item becomes an issue it leaves this list.
