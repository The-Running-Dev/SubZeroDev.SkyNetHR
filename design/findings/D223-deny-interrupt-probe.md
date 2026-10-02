# D223 finding — does a Claude deny with `interrupt: false` let the turn continue?

Probed 2026-10-02 against the real, installed CLI — `claude` 2.1.283 — from empty scratch
directories, over the flags the adapter spawns with (`buildArgs`,
`src/agent-console/providers/claude-cli/index.ts`: `-p --output-format stream-json
--input-format stream-json --verbose --permission-prompt-tool stdio`). The probe script is not
committed. It sent one `user` record asking for a `Write` of `probe.txt` and, on the resulting
`control_request`/`can_use_tool`, answered `{ behavior: 'deny', message: 'Denied by operator',
interrupt, toolUseID }`, holding stdin open until `result`.

## Result

| `interrupt` | Records after the deny | `result` | Exit |
|---|---|---|---|
| `true` (what the adapter sent) | none | `error_during_execution`, `is_error: true`, `stop_reason: tool_use` | 1 |
| `false` | two `assistant` records, the second a text reply to the refusal | `success`, `is_error: false`, `stop_reason: end_turn` | 0 |

The `false` run's reply was the string the prompt asked for on a refused write, so the agent saw
the denial and answered it. No file was written in either run.

**The turn continues.** D223's gate is met, and the adapter now sends `interrupt: false`.

## Not covered

- Only `Write` was probed; the CLI's deny handling is not tool-specific on the wire, but `Edit`
  and `Bash` were not run.
- The storage-failure text as the deny's reason needs a reason on `Adapter.respond`, a public
  signature, and is `/contract`'s (D223). The adapter still sends the fixed `Denied by operator`.
