# S8 findings — Codex, honestly

Written before any mapping code, per S8.1 (`design/30-slices.md § S8`). All probes were run
against the real, installed CLI — `codex-cli 0.146.0` — from this repository's working
directory, not against a fixture. `20-contract.md § Vendor mapping — Codex` states its
hypothesis was drawn from the on-disk rollout schema documented in `SubZeroDev.AgentKit`'s
`tools/Measure-Session.ps1`, not from an observed live stream. This is that observation.

## Summary

The hypothesis in `20-contract.md § Vendor mapping — Codex` does not hold. It is not a close
approximation that needs three unknown rows filled in — none of its record shapes are
observed, and the CLI turns out to expose **two different live-streaming interfaces**, not
one, with materially different guarantees. Both are documented below because the choice
between them is a contract decision, not something this slice may resolve by guessing (S8.2).

## 1. Does the Codex CLI expose a live streaming mode at all?

Yes — two, discovered via `codex --help`, `codex exec --help` and `codex app-server --help`:

- **`codex exec --json`** — non-interactive, one-shot or resumable. Prints newline-delimited
  JSON events to stdout. Confirmed live (not a post-hoc dump) by observing `item.started`
  arrive before the command's `item.completed` in a long-running command.
- **`codex app-server`** — a JSON-RPC 2.0 server over stdio (also `ws://`/`unix://`), marked
  `[experimental]` in `codex --help`. Confirmed by hand-rolling a minimal NDJSON JSON-RPC
  client (`initialize` → `thread/start` → `turn/start`, reading `readline` off stdout) and
  driving a real conversation end to end.

Neither is the rollout-file schema. `codex app-server generate-json-schema` dumps the full
protocol as JSON Schema — this is what the four probes below were read against, not guesswork.

## 2. What records does each mode emit? Do they match the rollout schema?

**No, neither matches.** The contract's hypothesis (`payload.type == 'session_meta'` →
`AdapterNotification 'cli-session'`; `payload.info.token_count` → `usage`; everything else
`(unknown)`) describes none of what either live interface actually sends.

**`codex exec --json`** (probe: `echo <prompt> | codex exec --json -s read-only
--skip-git-repo-check`, prompting a directory listing):

```
{"type":"thread.started","thread_id":"019feef4-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"…"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"…","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"…","aggregated_output":"…","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}
{"type":"turn.completed","usage":{"input_tokens":46942,"cached_input_tokens":33280,"cache_write_input_tokens":0,"output_tokens":111,"reasoning_output_tokens":33}}
```

No `session_meta`. There is a `thread.started`, but it carries only a `thread_id`, nothing
resembling `payload.info`.

**`codex app-server`** (probe: `initialize` → `thread/start` → `turn/start`, prompting a file
write): richer and named differently again — `thread/started`, `turn/started`,
`item/started`/`item/completed` (with per-item-type sub-notifications:
`item/reasoning/summaryTextDelta`, `item/agentMessage/delta`,
`item/commandExecution/outputDelta`), `thread/tokenUsage/updated`, `turn/completed`. Full
transcript of one two-command exchange with escalation is not reproduced here for length; the
shapes are documented completely (and authoritatively, since they are schema-generated, not
hand-transcribed) in `codex app-server generate-json-schema`'s `v2/` output — `ThreadItem`,
`ItemStartedNotification`, `TurnCompletedNotification`, `ThreadTokenUsageUpdatedNotification`.

**Neither interface has a separate `tool_call` / `tool_result` pair to normalise.** Both model
a command execution as a single `ThreadItem` (`command_execution` / `commandExecution`) whose
lifecycle is `item.started` (fields null/`in_progress`) → `item.completed` (same id, now
carrying `aggregated_output`, `exit_code`, `status`). This is a structural mismatch with the
contract's three unmapped kinds (`message`, `tool.call`, `tool.result`) — there is no discrete
`tool.result` record at all; the result is a field update on the same item the call opened.
Any mapping to `NormalizedEvent`'s `tool.call`/`tool.result` pair has to synthesize the split
from one item's two lifecycle states, not read it off the wire as two records.

## 3. Are `callId`s (here, item ids) unique within a session, or only within a turn?

**It depends on which interface is used — this is not a single fact about "the Codex CLI."**

- **`codex exec --json`: only within a turn.** Item ids are a per-turn counter (`item_0`,
  `item_1`, `item_2`, …). Probe: started a thread, ran one turn (`item_0`…`item_3`), then
  `codex exec resume --last --json` and sent a second prompt in the *same thread* — the second
  turn's items were again `item_0`…`item_3`. Confirmed reproducible across two independent
  resumes.
- **`codex app-server`: unique within the thread, at least across the two turns tested.**
  Command-execution item ids are UUID-based (`exec-a2215fa5-…`, `exec-0c9a346e-…`), and two
  sequential `turn/start` calls on one thread produced two distinct UUIDs, no collision.
  **Not exhaustively verified** — only two turns were probed, and only for `commandExecution`
  items; this is evidence of the scheme, not a proof it never collides.

This directly triggers **S8.7**: at least one of the two live interfaces (`exec --json`) has
`callId`s unique only within a turn. Correlating tool calls across a session through that
interface needs a server-side alias — open question 7's territory, and a design decision, not
an adapter one. Whether that problem exists at all is itself contingent on which interface
`/contract` chooses; this report does not choose for it.

## 4. Is `approval_policy = "on-request"` reachable over a programmatic stream?

**Yes, via `app-server` — and confirmed by an actual approval round trip. No, via `exec
--json`.**

- **`codex exec --json`, `-c approval_policy=on-request`, `-s read-only`, prompted to write a
  file:** the write was denied by the OS-level sandbox (`Access to the path '…' is denied`),
  and the turn ended by having the agent report failure in its own message
  (`item.completed`/`agent_message`: "Couldn't create the file: the workspace is read-only…").
  **No approval-request record of any kind appeared in the JSON stream.** `exec` is
  non-interactive by construction; it cannot pause for approval, and does not represent the
  denial as a distinguishable event — the model just sees the command fail.
- **`codex app-server`, `approvalPolicy: 'on-request'`, `sandbox: 'read-only'`, prompted to
  write a file:** the server sent a genuine JSON-RPC **request** (not a notification) on the
  wire:

  ```json
  {"method":"item/commandExecution/requestApproval","id":0,"params":{
    "threadId":"019feefb-…","turnId":"019feefb-…","itemId":"exec-fd0bb4a3-…",
    "reason":"Do you want to allow creating scratch-codex-test.txt in this workspace and reading it back?",
    "command":"…Set-Content -LiteralPath .\\scratch-codex-test.txt -Value 'hello'; …",
    "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[…]}},"cancel"]
  }}
  ```

  The probe's reply used a guessed, wrong response shape (`{"decision":"approved"}`) and the
  server logged `approval request failed`, declining the command — but the request itself,
  its `id`, and its `availableDecisions` enum are exactly what a real approval client would
  need. The generated schema (`ExecCommandApprovalResponse.json`,
  `CommandExecutionRequestApprovalResponse.json`) documents the correct response shape; this
  probe did not attempt a second round with it, since the reachability question was already
  answered by the request having arrived at all.

**This resolves S8.1's `approval_policy` question in the direction the contract's "policy for
every Codex session, until proven otherwise: `preauthorised`" fallback did not anticipate**:
`on-request` is reachable, over `app-server`, and a real client could drive it. Whether
`preauthorised` (D5's chosen default) or `on-request` (now known reachable) is what this
repository ships is `/design`'s call, not reopened here (`Out of scope`, S8 slice text) —
this only establishes that the reachability question the contract left open has an answer.

## 5. Token usage — a fifth question, forced by finding 2's mismatch

Neither interface emits `payload.info.token_count`. `codex exec --json`'s `turn.completed.usage`
looked at first like it might be cumulative (both `input_tokens` and `cached_input_tokens`
were observed to almost exactly double between two sequential resumed turns — 46276→93393 and
33280→66560), consistent with each call resending the full growing context rather than
reporting a delta. `codex app-server` settles this ambiguity directly: `turn/completed` and
`thread/tokenUsage/updated` both carry **explicit `total` and `last` sub-objects** —
`last.inputTokens` on the second observed turn was 24309, close to but distinct from the first
turn's own `total.inputTokens` of 23809, i.e. `last` is that turn's own marginal usage, `total`
is the running thread sum. If `app-server` is adopted, D75's "normalised to a delta" requirement
is satisfied by reading `last` directly — no adapter-side subtraction needed, the same shape of
answer S1's findings reached for the Claude CLI.

## What this means for S8.2 (`/contract`, not this slice)

Three things the contract cannot fill in without a decision this slice is not authorised to
make (S8.2, S8.7):

1. **Which interface is the vendor mapping's source**: `exec --json` (simpler, per-turn-only
   ids, no approval path) or `app-server` (richer, thread-scoped ids observed so far, real
   approval round trip, marked `[experimental]` by the CLI itself — a stability question
   `/contract` or `/design` has to weigh, not this report).
2. **How a single-lifecycle `ThreadItem`/`item` (started → completed-with-result) maps to
   `NormalizedEvent`'s split `tool.call` / `tool.result`** — there is no wire-level pair to
   normalise; the split has to be synthesized from one record's two states, which the current
   `(unknown)` placeholder rows do not describe.
3. **Whether `callId` correlation needs a server-side alias at all**, and if so, only for
   which interface — S8.7's condition is confirmed for `exec --json`, tentatively not for
   `app-server` (two turns, no collision, not exhaustively proven).

This slice stops here per S8.2. No mapping code, no `AdapterError.schema_mismatch` wiring, and
no banner/policy implementation (S8.3–S8.5) until the contract is corrected against the above.
