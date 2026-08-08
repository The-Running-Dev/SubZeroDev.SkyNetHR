# Slices — Agent Console

Each slice ends runnable. Criteria carry stable ids; drift is compared on ids, never prose.

Ordering follows `10-design.md § What we add`: the three things that dictate structure —
the jail, the sequence number, and identity — land before the surface area grows around
them. The dangerous intermediate state (a console reachable off-box with no auth) is never
reachable, because S3 refuses to bind a routable interface from its first commit.

`spike/` already covers parts of S1–S4 as throwaway proof. It is not the implementation;
see `spike/README.md § What this is not`.

---

## S1 — Claude adapter spine

Spawn the CLI, read its stream, emit normalised events. No HTTP, no browser. A CLI harness
prints events to stdout.

- **S1.1** `claude` is spawned with stream-json in and out, and stdin stays open for the
  whole turn.
- **S1.2** The NDJSON splitter is unit-tested by feeding a known stream one byte at a time
  and asserting the event sequence is identical to feeding it whole.
- **S1.3** Every mapping in `20-contract.md § Vendor mapping — Claude` produces its
  normalised event, verified against a recorded fixture stream.
- **S1.4** An unrecognised record kind is surfaced as `error`, never dropped silently.
- **S1.5** Killing the child mid-turn emits `session.exit` with `expected: false`.

## S2 — Session manager, jail, sequencing

Ownership, lifecycle and the filesystem boundary. Still no HTTP.

- **S2.1** `seq` is assigned by the manager, starts at 1, and has no gaps across an adapter
  restart within one session.
- **S2.2** A `cwd` outside every configured root is refused, with cases covering `..`
  traversal, a symlink pointing out, and on Windows both case variation and an 8.3 short
  name.
- **S2.3** The resolved real path, not the caller's string, is what reaches the child's
  `cwd`. Asserted by inspecting the spawned process, not by reading the calling code.
- **S2.4** Events are held in a bounded ring buffer; overflow is reported, not silent.
- **S2.5** Session metadata round-trips through `meta.json`.

## S3 — HTTP edge and the browser

The first end-to-end: type a message, watch it stream.

- **S3.1** `GET /api/sessions/:id/events` streams envelopes as SSE with `id:` set to `seq`.
- **S3.2** Reconnecting with `Last-Event-ID` replays from `seq + 1` and nothing is
  duplicated or lost. Tested by killing the connection mid-turn.
- **S3.3** A `Last-Event-ID` older than the ring buffer yields one `error` with
  `kind: 'replay_gap'`.
- **S3.4** The server **refuses to start** bound to a non-loopback interface while no auth
  mode is configured, and says why.
- **S3.5** A keepalive comment every 15 s holds an idle stream open through a proxy.
- **S3.6** The browser renders messages, thinking and tool calls from the normalised
  events, with no vendor branch anywhere in client code.

## S4 — Permission handshake

- **S4.1** A `can_use_tool` request becomes `permission.request` carrying the exact tool
  input, not a summary.
- **S4.2** Allow and deny both round-trip to the CLI and the agent proceeds accordingly,
  demonstrated on a real tool call.
- **S4.3** `scope: 'always'` passes the vendor's own suggestion back; no local rule grammar
  is invented before Open is resolved.
- **S4.4** A second client answering an already-resolved request gets
  `{accepted: false}`, not an error, and no second response reaches the CLI.
- **S4.5** Child death with a request outstanding emits `permission.resolved` with
  `reason: 'cancelled_process_exit'`, so no client waits forever.

## S5 — Identity and ownership

- **S5.1** Proxy-header mode extracts an operator identity, and rejects the header unless
  the peer address is in the configured upstream allow-list.
- **S5.2** Shared-secret mode authenticates via cookie and is usable on a LAN box.
- **S5.3** Every session route checks ownership; another operator's session returns `404`,
  not `403`.
- **S5.4** `GET /api/sessions` returns only the caller's sessions.
- **S5.5** The negative cases are counted and stated: requests with no identity, a forged
  header from a non-allow-listed peer, and a wrong shared secret are each rejected, with
  the counts recorded in the slice report.

## S6 — Checkpoints

- **S6.1** A shadow `GIT_DIR` is created per session with the workspace as work-tree, and
  the workspace's own `.git`, if any, is untouched — asserted by comparing its `HEAD` and
  index before and after.
- **S6.2** A checkpoint is committed before each turn and appears in the list.
- **S6.3** Restore returns the workspace to that state, including files the agent created.
- **S6.4** A workspace that is not a git repository still checkpoints.
- **S6.5** Restore during an in-flight turn is refused with `409`.

## S7 — Audit log

- **S7.1** Every permission decision appends operator, session, tool, exact input,
  decision, scope and timestamp.
- **S7.2** The log is append-only and survives restart.
- **S7.3** Pre-approved calls are logged too, with `reason: 'preapproved'` — otherwise the
  record shows only what someone was asked about, not what ran.

## S8 — Codex adapter *(experiment first)*

**This slice begins as an experiment, not an implementation.** `20-contract.md § Vendor
mapping — Codex` is a hypothesis. Stop and report before building against it.

- **S8.1** Report whether the Codex CLI exposes a live streaming mode at all, and what its
  records look like. Written up before any adapter code.
- **S8.2** If it does: the mapping is implemented and the contract table is corrected to
  match observation.
- **S8.3** A Codex session declares `policy.mode: 'preauthorised'` with its sandbox, and
  the client shows the standing banner.
- **S8.4** A stream that does not match emits `adapter_schema_mismatch` with
  `fatal: true` — it never renders nothing and looks like thinking.
- **S8.5** If no live stream exists, stop. Do not fall back to scraping rollout files
  without a decision — that is a `/design` question, recorded in Open.

## S9 — Backpressure and limits

- **S9.1** A tool result above the byte cap is truncated with `truncated: true` and the
  real `bytes`, and the remainder is fetchable by `callId`.
- **S9.2** A tool emitting tens of MB does not stall the browser. Measured, with the
  numbers stated.
- **S9.3** Transcripts spill to `events.ndjson` and memory stays bounded over a long
  session.
- **S9.4** Orphaned child processes are reaped on server boot before connections are
  accepted.
