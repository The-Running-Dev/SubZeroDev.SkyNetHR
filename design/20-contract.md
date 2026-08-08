# Contract — SkyNet HR

Derived from `10-design.md`. Where this document and the code disagree, one of them is a
defect — say which, do not reconcile silently.

The governing rule from the design: **no vendor string above the adapter layer.** Every
type here is vendor-neutral. `raw` exists for debugging and must never be rendered.

## Event envelope

Every event the server sends, on any transport, is this shape.

```ts
interface Envelope {
  seq: number;          // monotonic per session, from 1, no gaps
  sessionId: string;    // opaque, server-issued
  ts: string;           // ISO 8601, UTC, millisecond precision
  kind: EventKind;
  data: unknown;        // narrowed by kind, below
  raw?: unknown;        // vendor payload; debugging only, omitted unless configured
}
```

`seq` is the replay key and the reason it is assigned by the session manager, not the
adapter: an adapter that restarts must not restart the sequence. Gaps mean a bug, not a
dropped event — the ring buffer is the only thing permitted to lose events, and it reports
that as `error` with `kind: 'replay_gap'`.

## Event kinds

```ts
type EventKind =
  | 'session.started' | 'session.exit'  | 'session.notice'
  | 'turn.started'    | 'turn.ended'
  | 'message'         | 'message.delta' | 'thinking'
  | 'tool.call'       | 'tool.result'
  | 'permission.request' | 'permission.resolved'
  | 'checkpoint.created'
  | 'usage'
  | 'error';
```

```ts
interface SessionStarted {
  vendor: 'claude' | 'codex';   // display only; no logic may branch on it
  cwd: string;                  // resolved real path
  model?: string;
  policy: PermissionPolicy;
}

// How this session grants tool use. The two vendors differ here and the UI must say so.
interface PermissionPolicy {
  mode: 'interactive' | 'preauthorised';
  // interactive:    permission.request events will occur; the operator answers them
  // preauthorised:  no permission.request events; the sandbox was fixed at launch
  sandbox?: 'read-only' | 'workspace-write' | 'unrestricted';
  banner?: string;              // shown persistently for preauthorised sessions
}

interface SessionExit  { code: number | null; signal: string | null; expected: boolean }
interface SessionNotice{ level: 'info' | 'warn'; text: string }  // compaction, sandbox, resume

interface TurnStarted  { turnId: string }
interface TurnEnded    { turnId: string; stopReason: string; usage?: Usage }

interface Message      { role: 'user' | 'assistant'; text: string }
interface MessageDelta { role: 'assistant'; text: string; turnId: string }  // append-only
interface Thinking     { text: string }

interface ToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  summary: string;              // one line, server-rendered, safe to show collapsed
}

interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;               // may be truncated
  truncated: boolean;
  bytes: number;                // pre-truncation size
}

interface PermissionRequest {
  requestId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;   // exactly what will run; never a summary
  suggestions?: PermissionScope[];  // vendor-offered "always allow" shapes
}

interface PermissionScope { label: string; rule: string }

interface PermissionResolved {
  requestId: string;
  decision: 'allow' | 'deny';
  scope: 'once' | 'always';
  operator: string;
  reason?: 'answered' | 'preapproved' | 'cancelled_process_exit' | 'superseded';
}

interface CheckpointCreated { sha: string; label: string }
interface Usage { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreate: number }
interface ErrorEvent { message: string; kind: string; fatal: boolean }
```

### Rules the renderer may rely on

- `message.delta` events for one `turnId` concatenate, in `seq` order, to the `message`
  that follows. A client may render either and must not render both.
- `tool.result` always follows its `tool.call`. A `tool.call` with no result by
  `turn.ended` was abandoned.
- `permission.request` is always answered by exactly one `permission.resolved`, including
  when the process dies — that case carries `reason: 'cancelled_process_exit'`.
- A `preauthorised` session emits **zero** `permission.request` events. That is normal and
  must not read as a stalled turn.

## Client to server

All are `POST`, all take and return JSON, all require authentication.

```
POST /api/sessions
  { vendor, cwd, model?, sandbox? }          -> { sessionId }
  409 if cwd resolves outside every workspace root
  403 if the caller may not use that vendor

POST /api/sessions/:id/message
  { text, attachments?: Attachment[] }       -> { turnId }
  409 if a turn is already in flight

POST /api/sessions/:id/permission
  { requestId, decision, scope }             -> { accepted: boolean }
  accepted:false means another client answered first; not an error

POST /api/sessions/:id/interrupt
  {}                                         -> { ok: true }

POST /api/sessions/:id/checkpoint/restore
  { sha }                                    -> { ok: true }
  409 if a turn is in flight

DELETE /api/sessions/:id                     -> { ok: true }
```

```
GET /api/sessions                            -> { sessions: SessionSummary[] }   caller's own only
GET /api/sessions/:id/events                 -> text/event-stream
GET /api/sessions/:id/checkpoints            -> { checkpoints: {sha,label,ts}[] }
GET /api/tool-output/:callId                 -> { output }   untruncated
```

## Streaming

`GET /api/sessions/:id/events` is Server-Sent Events. Each envelope is one SSE message with
`id:` set to `seq`:

```
id: 42
event: tool.call
data: {"seq":42,"sessionId":"...","ts":"...","kind":"tool.call","data":{...}}
```

On reconnect the browser's `EventSource` sends `Last-Event-ID` automatically. The server
replays from `seq + 1`. If that sequence has aged out of the ring buffer, the server sends
a single `error` with `kind: 'replay_gap'` and the client does a full refetch.

A comment line (`: keepalive`) every 15 s keeps intermediaries from closing an idle stream.

## Errors

```ts
interface ApiError { error: { code: string; message: string; detail?: unknown } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `unauthenticated` | No usable identity |
| 403 | `forbidden` | Authenticated, not the session's owner |
| 404 | `no_such_session` | Unknown, or not the caller's |
| 409 | `turn_in_flight` | A turn is running |
| 409 | `outside_workspace_root` | `cwd` failed the jail check |
| 422 | `bad_request` | Malformed body |
| 503 | `agent_unavailable` | CLI missing or failed to spawn |

`404` rather than `403` for another operator's session is deliberate: session existence is
not something a non-owner should be able to probe.

## Vendor mapping — Claude

Verified against `Forks-Claude-Code-Chat@ab6e307`.

| CLI stdout | Normalised |
|---|---|
| `system` / `init` | `session.started`, capture `session_id` for `--resume` |
| `system` / `status: compacting` | `session.notice` |
| `system` / `compact_boundary` | `session.notice`, reset local token counters |
| `assistant` → content `text` | `message` (role assistant) |
| `assistant` → content `thinking` | `thinking` |
| `assistant` → content `tool_use` | `tool.call` |
| `assistant` → `message.usage` | `usage` |
| `user` → content `tool_result` | `tool.result` |
| `control_request` / `can_use_tool` | `permission.request` |
| `result` | `turn.ended`; close stdin |

Outbound: user messages and `control_response` are written as single JSON lines to stdin,
which stays open for the whole turn.

Policy for every Claude session: `{ mode: 'interactive' }`.

## Vendor mapping — Codex

**Unverified.** Everything below is a hypothesis to be tested by the spike, drawn from the
on-disk rollout schema documented in `SubZeroDev.AgentKit/tools/Measure-Session.ps1`, not
from an observed live stream.

| Expected record | Normalised |
|---|---|
| `payload.type == 'session_meta'` | `session.started` |
| `payload.info` → `token_count` | `usage` |
| *(unknown)* | `message`, `tool.call`, `tool.result` |

Policy for every Codex session, until proven otherwise:
`{ mode: 'preauthorised', sandbox: <from launch config>, banner: '...' }`.

**The adapter must fail loudly, not degrade quietly.** If the stream does not match, emit
`error` with `kind: 'adapter_schema_mismatch'` and `fatal: true`. A Codex adapter that
silently renders nothing is worse than one that refuses to start, because the operator will
believe the agent is thinking.
