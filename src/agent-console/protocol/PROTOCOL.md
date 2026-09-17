# AgentConsole runtime protocol 1.0

This is the Phase 4 stdio surface specified by frozen v5. SkyNetHR continues to
use its in-process core. There is no SDK, browser bridge, transport cutover or
automatic runtime restart in this phase.

`schemas/wire.schema.json` is the JSON Schema 2020-12 wire definition;
`wire.ts` is its TypeScript counterpart. `wire-fixtures/operations.json` contains
paired requests and results for all 33 methods. The earlier event schemas remain
the stricter persisted/core vocabulary; the wire admits unknown historical kinds
and unknown string outcomes. Decode optional null and absence identically. A
delta frame has no sequence number; an optional null sequence on an incoming
wire frame means absent and must be normalized before using the core's `isFrame`.
Envelopes retain their sequence number. Timestamps are RFC 3339 UTC. Integers
must be JavaScript-safe. Diagnostics alone enable `raw`; non-object diagnostic
values are carried inside `{value: ...}` so wire `raw` is always an object.

## Link and initialization

Run `node dist/agent-console/runtime/main.js` after the repository build. The
parent owns stdin/stdout. Each UTF-8 LF-delimited line is one JSON-RPC 2.0 object;
batches are unsupported. Client requests have safe integer ids. Runtime host
requests have disjoint `r:<n>` string ids. Replies use the original id. The reader
continues consuming replies while any operation or host callback is waiting.

The first request is `runtime.hello`:

```json
{"jsonrpc":"2.0","id":1,"method":"runtime.hello","params":{"version":"1.0.0","storage":{"kind":"fs","root":"D:/AgentConsole/state"},"workspaceRoots":["D:/work"],"hostMethods":[]}}
```

`storage.kind` is `fs` or `memory`; root and workspace roots are absolute.
Memory storage loses sessions, events, uploads, audit and PID state at restart.
The filesystem backend retains the existing boot scan, reaping, ended-history
rehydration and D130 recovery, including the durable A5 quarantine journal.
The runtime owns only its separate runtime lease; it never claims `server.lock`.
A second live holder fails with `storage_locked`, including the existing holder
and age in the structured error detail. There is no fixed retry delay.

Different major versions fail with `protocol_version_mismatch`. Same-major minor
versions are accepted. Initialization runs once; other operations require its
successful completion. The reply identifies the protocol version, storage kind,
and checkpoint operations with their schemas and mutability flags.

Options are `includeRaw`, `streamDeltas`, `maxLiveSessionsPerWorkspace`, `caps`,
`hostAttemptTimeoutMs` (default 30000), and `providerStdoutLineBytes` (default
67108864). Core caps preserve the existing fields and are validated as bounded
integers. No browser supplies runtime initialization or a storage root.

## Methods

All session-scoped operations take `{sessionId, principal}` in addition to the
fields below. Exact request and result shapes are in the schema and TypeScript.

| Methods | Additional inputs and result |
| --- | --- |
| `sessions.create` | `principal, provider, cwd, model?, sandbox?, input?`; returns `sessionId`. `input` is opaque host create data. |
| `sessions.list` | `principal, cursor?, limit?`; returns `items, next`. |
| `sessions.get` | Returns the existing session summary. |
| `sessions.end`, `sessions.remove` | Return null on success. End is idempotent and never implicitly interrupts. There is no `sessions.close`. |
| `turns.send` | `text, model?, uploads?`; returns `turnId`. Uploads must be committed and owned by this session/principal. |
| `turns.interrupt` | Required `turnId`; stale ids succeed without events or affecting a newer turn. |
| `permissions.respond` | `requestId, decision, scope?, rule?, reason?`; returns `accepted, resolution`, including `cancelled_process_exit`. |
| `events.subscribe` | `fromSeq?` (exclusive watermark, default zero); returns `subscriptionId`. |
| `events.unsubscribe`, `events.credit` | `subscriptionId, principal`; credit additionally takes positive `count`. |
| `events.read` | `fromSeq?, limit?`; returns `events, nextSeq`. |
| `events.append` | `kind, data`; kind is `x-namespace.name`. Returns the durable envelope. Never automatically retry an indeterminate append. |
| `toolOutput.read` | `turnId, callId, offset, length`; returns a base64 chunk, next offset and EOF flag. |
| `attachments.begin` | `name, size, contentType?`; returns `uploadId`. Name is display metadata, never a path. |
| `attachments.write` | `uploadId, principal, offset, data`; returns `nextOffset`. |
| `attachments.commit`, `attachments.abort` | `uploadId, principal`; commit returns `committedUploadId`; abort returns null. |
| `attachments.read` | `turnId, attachmentId, offset, length`; returns a chunk and content type. |
| `providers.list`, `providers.refresh` | No session/principal; asynchronous provider probe results with availability, version and capabilities. |
| `checkpoints.list`, `checkpoints.restore` | Restore additionally takes `sha`; existing checkpoint results/errors are preserved. |
| `admin.sessions.list` | `cursor?, limit?, principal?`; privileged owner-independent catalog. |
| `admin.sessions.snapshot`, `admin.sessions.remove` | `sessionId`, without caller ownership filtering. |
| `admin.sessions.reassignPrincipal` | `sessionId, principal`; principal is the new owner. |
| `admin.audit.read` | `query?, cursor?, limit?`; query supports session, principal, UTC since/until and incidents-only filters. |

Binary chunks are at most 256 KiB before base64 encoding. Binary contents never
appear in events. Filesystem upload staging is `sessions/<id>/uploads/<uploadId>`;
memory staging is in memory. Partial and committed-but-unsent uploads expire
after five minutes. Handles do not survive restart; boot discards leftover staging
files after acquiring the runtime lease. The core performs the existing binding
into `attachments/<turnId>/<attachmentId>` and rollback. A refused send before
binding leaves committed uploads staged. Continuations recheck ownership; a
reassigned principal cannot use old handles.

## Identity and administrative boundary

Principals are opaque strings compared by strict equality. All CLI providers use
the shared host OS/CLI identity. There is no cross-principal sharing and no claim
of filesystem isolation between mutually untrusted tenants. The trusted parent
injects principal; browser input cannot select it. Wrong ownership, including on
handles, returns `not_found`.

The stdio parent is privileged. Browser integrations must use the explicit
`browserMethods` whitelist in `wire.ts`, inject trusted principal, and never route
`admin.*`, `host.*` or runtime initialization. Phase 4 does not implement a bridge.

## Delivery, errors and concurrency

Notifications use `events.event {subscriptionId, event}`. Subscriptions start at
zero credit. Grant credit after a bounded consumer channel accepts notifications;
do not grant it merely because the pipe was read. Responses and control messages
have priority over round-robin subscription delivery. Each subscription has a
bounded event/byte budget. Exhaustion closes that subscription and sends exactly
one control-delivered `error/replay_gap`, restating the last delivered watermark.
The gap is never appended, never assigned a new seq, and never advances resume.
The client resubscribes from its last accepted seq.

Global stdout backpressure is a link fault, never a batch of subscription gaps.
The control queue is bounded to 256 items and the writer to 16 MiB; per-subscription
delivery is bounded to 8 MiB and the configured queue count. Runtime requests and
host callbacks each have a 256-request bound; subscriptions have a 1024-handle
bound. Provider draining and persistence do not await this writer.

Three outcomes are distinct:

* An `error` event is durable transcript information (except the synthetic gap).
  `adapter_output_overflow` is fatal to that turn and precedes `turn.ended`.
* A JSON-RPC error answers one call. Spec-reserved numeric codes retain their
  meanings. Application errors use `-32000` and authoritative `data.code`.
  `data.detail`, when supplied by the core, is the serialized structured core
  error, preserving such details as a storage lease holder and age. A caller must
  not render another transcript error merely because its RPC failed.
* `turn.ended` records the existing turn outcome. Overflow uses the existing
  `error` stop reason; no new end/notice/stop-reason union member is introduced.

Events may arrive before the initiating response. A send can fail after a durable
`turn.started`; the existing paired end/error path remains authoritative. Neither
RPC failure nor cancellation rolls back already emitted events. Concurrent reads
and compatible operations can proceed during a turn. Busy-slot and workspace
decisions remain in the core: send/end/remove/restore conflict with an active
restore, and end/remove refuse an active turn. Checkpoint failure before a send
warns and does not veto the turn. Permission audit fsync still precedes response
to a provider. No I27 lane/allocation guard spans I/O, callbacks or other awaits.

`$/cancel {id}` works in either direction and requests cooperative cancellation.
It never cancels a turn and never compensates a create. A completed mutation may
still return its real result. Use `turns.interrupt` to stop an active turn.

## A5 host create attempts

Declare all four create callbacks together in hello or declare none. No
undeclared callback is called. `prepare {createAttemptId, principal, input}` and
`commit {createAttemptId, sessionId}` return null on success or an RPC error on
failure. `abort {createAttemptId, reason}` and `status {createAttemptId}` return
`{state, sessionId?}`. The host helper owns the idempotent state machine:
`new → prepared → committing → committed|aborted`.

Prepare timeout sends `$/cancel`, then abort. A late prepare must observe its
terminal abort. A commit deadline or lost reply never triggers abort: the core
performs its bounded status/commit reconciliation. Call deadlines forget only the
local reply waiter. They do not roll back host effects. An unresolved outcome
returns `create_outcome_unknown` and retains its hidden session, durable attempt
record and workspace reservation. Ordinary reads cannot expose it; mutations
cannot release it. Boot observes host status before publication: committed uses
the existing ended-history recovery, aborted is removed before allocation is
released, and new/prepared/committing/unavailable remains quarantined. A fresh
host helper's empty state is not proof that an old commit aborted.

## Framing, shutdown and liveness

The link line cap is 8 MiB. An oversized incoming line is discarded and causes
`runtime.protocolError`, then link teardown; an SDK must fault and kill the child.
Provider stdout has a separate configurable 64 MiB default line cap. Complete
records preceding an oversized record retain their order. Overflow ends only the
affected turn, using the same staged process termination mechanism.

`main.ts` redirects console log/info/debug/warn/error to structured stderr before
dynamic runtime/provider imports. Only `RpcWriter` writes stdout. The parent must
continuously drain both output streams. Neither logs nor binary bytes use stdout
outside a protocol object.

Both peers send `runtime.heartbeat {}` every ten seconds. Thirty seconds without
valid incoming protocol traffic faults the link on every OS. A Windows process
job is not a substitute for this deadline.

stdin EOF stops acceptance, mutes the core, kills live child trees, flushes queued
events/PID bookkeeping, closes storage and releases the runtime lease. The process
exits within five seconds. EOF itself emits no turn/session end events. On the
next filesystem boot the ordinary D130 `server_restart` path closes interrupted
history; memory sessions are gone. A parent observing stdout EOF fails all calls
and streams as `RuntimeTerminated`, with no automatic SDK restart. Host recovery
owns prepared-attempt compensation and indeterminate-commit reconciliation.

## Verification

The normal repository test command runs schema/TypeScript fixtures in both
directions, byte/framing and fair-writer tests, cross-platform heartbeat behavior,
child-process stdout/EOF tests, adapter scenarios through the RPC boundary,
principal/handle/admin checks, credits and replay, checkpoint races and A5 callback
and filesystem recovery scenarios. Existing provider, process, store and host
tests remain part of the same gate. C# and browser integration executions belong
to their later implementation phases; this phase publishes their wire contract.
