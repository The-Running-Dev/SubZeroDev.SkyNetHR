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

## Open

Staging only. Once an item becomes an issue it leaves this list.

- Does `--include-partial-messages` yield usable token-level deltas on the Claude CLI, and
  does `message.delta` survive contact with it? Cheap experiment, changes the renderer.
- Does the Codex CLI expose a live NDJSON stream, and does it resemble the rollout schema?
  Blocks the whole Codex adapter; see S5.
- Does Codex offer any runtime approval hook? If yes, D5 is revisited.
- Checkpoint restore when two operators share one workspace is undefined. Probably refuse
  rather than resolve.
- Whether `permission_suggestions` from the Claude CLI is a sufficient grammar for
  "always allow", or whether a local rule language is needed. Look before inventing.
- `Start-AgentSession.ps1` (D14) is unreconciled against this repo's own architecture — it
  assumes a local interactive terminal, not the server/SSE/adapter shape D1–D12 settled on.
  Reconcile when a slice first needs a CLI launcher, not before.
- Once a spill reader exists (D20), a too-old `Last-Event-ID` could be served from disk
  rather than answered with `replay_gap`. That would remove a failure mode, but S3.3 tests
  for `replay_gap`'s existence, so it is a slice change and not a free simplification.
- Is there a turn timeout? A child producing no output is indistinguishable from one that is
  thinking. Any value risks killing a legitimately long tool call, and none is derivable
  from the brief.
- Are Codex's `callId`s unique within a session or only within a turn? If the latter, tool
  correlation breaks and `10-design.md § Data model — Identity spaces` needs a server-side
  alias after all. Answered by S8.1.
- `20-contract.md` needs two amendments, both owned by `/contract`. Its `session.exit`
  conflates turn-process exit with session teardown — under D16 a normal turn ends its
  child, so a contract-obedient client tears the session view down after every successful
  turn. And `workspace_busy`, which D19 requires, has no entry in its error table.
