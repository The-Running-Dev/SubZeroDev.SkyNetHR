# Codex approval observation — issue #80

Observed on Windows with installed `codex-cli 0.158.0`, 2026-10-04.
[approval-probe.json](approval-probe.json) contains the actual request/reply
excerpts. Temporary workspace paths and UUIDs are anonymised; protocol fields are
preserved. The deterministic CLI fixture uses these captured request shapes.

Both command execution and file changes completed with documented
`result.decision: accept` and `result.decision: decline` responses. The server
used RPC id `0`, which must not be tested for truthiness. File-edit requests omit
the patch: the preceding `item/started` contains the proposed changes. A command
request's advertised choices omitted `decline`, but the documented response was
accepted in the live deny exchange and the requested file was not created.

The production adapter was then exercised separately for four turns in one
isolated temporary workspace, using `read-only` and `on-request`. Each turn
created a new child, reached completion, and exited before the next turn began.
One thread id survived all four processes. Both allowed writes produced their
expected contents; both denied paths remained absent. Resumed turns recalled the
previous filename. All four adapter runs emitted one permission request and no
error events. The probe checked the exact command/cwd or patch path/content
before answering; it did not grant session access or an exec-policy amendment.

The live run also observed `item/started` for an empty `agentMessage`. Ignoring
that lifecycle marker is necessary before the approval can be reached; the
message itself still arrives via the existing delta/completed handlers.

## Adoption decision and limits

The operator explicitly chose implementation now and deferred contract/process
reconciliation. For app-server sessions, this reverses D5's no-browser-prompt
choice while preserving the per-turn process model. The exec fallback remains
preauthorised under its selected sandbox. Approvals apply when Codex requests
escalation; this does not force every sandbox-permitted action to prompt.

App-server is **still marked experimental**. The earlier 0.146.0 observation and
this release share the core command approval exchange, but newer request fields
have appeared. Issue #80's original protocol-stability condition is therefore
not claimed as satisfied; adoption proceeds under the operator's explicit
override. Contract/decision-log reconciliation is deferred to the follow-up the
operator requested, with the contradiction recorded in the implementation PR.

Responses are one-call accept/decline only. Command-only standing rules would
omit cwd and escalation context, so requests expose no standing-rule target.
Denial reasons remain in the host audit; this Codex response has no reason field.
