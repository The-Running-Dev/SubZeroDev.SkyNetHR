# S10 findings — is `permission_suggestions` a sufficient grammar?

Written before any matching code, per S10.1 (`design/30-slices.md § S10`). Answers open
question 8 (#16), blocking for this slice per D35.

## The question

D35 puts standing-rule matching in this server, not the CLI, so the server needs a grammar
it can evaluate. `permission_suggestions` is forwarded unmapped today (D104) because nothing
has ever been observed on that field — the question is whether, now that this slice needs to
actually build the matcher, it is a grammar worth mapping onto, or whether this slice needs
its own.

## What was probed

A fresh, independent repeat of D88's probe, run today (2026-08-12) against the same installed
binary D88 used:

```
claude --version → 2.1.226 (Claude Code)
```

One turn, `-p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio`, prompting a `Read` tool call on a scratch file — the same
shape as D88's probe 1. Output (`type`, `subtype` per line):

```
system hook_started ×3, system hook_response ×3, system init, system thinking_tokens ×2,
assistant, assistant, rate_limit_event, user, assistant, system post_turn_summary,
result success
```

No `control_request` of any subtype appears anywhere in the trace. The tool executed directly
— `tool_use` in an `assistant` record followed immediately by `tool_result` in the next `user`
record — exactly as D88 describes. `system/init`'s `permissionMode` field read `"default"`.

**This matches D88 exactly, three days later and independently reproduced.** The CLI still
never emits `can_use_tool`, so `permission_suggestions` — a field that would only ever appear
*inside* that request — has never once existed on any wire this project has observed.

## The upstream issue has not been fixed, and will not be soon

`anthropics/claude-code#34046` — the defect D88 cites — is now **closed**, but not by a fix.
The closure was a stale-bot auto-lock after 7 days of inactivity (2026-06-22), and the last
human comments on it, both from unrelated reporters in 2026-05, read as complaints that the
issue was ignored rather than triaged:

> "Why does this issue interface even exist. All I've ever seen is items ignored and then
> closed." — 2026-05-03
> "I would like to question why does this repo exist if a valid issue/bug like this is
> ignored." — 2026-05-03

There is no linked fix, no milestone, and no maintainer response anywhere in the thread. This
is not a bug with a visible path to landing; it is a bug the tracker has stopped tracking.

## What the vendor documents about the shape, when the mechanism does work

Anthropic's Agent SDK docs (`code.claude.com/docs/en/agent-sdk/{permissions,user-input}`,
fetched 2026-08-12) describe an **in-process** `canUseTool` callback whose third argument
carries `suggestions`, an array of `PermissionUpdate` entries an app echoes back (filtered by
`destination === "localSettings"`) as `updatedPermissions` to persist a rule. The rule strings
those updates carry follow the same `Tool(pattern)` syntax documented for `allowed_tools` /
`disallowed_tools` generally — e.g. `Bash(rm *)`, `Edit(//secrets/**)`.

Two things matter about this:

1. It documents the **SDK's in-process callback path**, not the **subprocess CLI's
   `--permission-prompt-tool stdio` control-channel path** this project depends on (D88, D91).
   There is no public documentation, and now no way to observe, whether the stdio channel's
   `permission_suggestions` field carries the same `PermissionUpdate` shape, a looser one, or
   something else — the channel that would carry it does not fire.
2. Even where it is documented, forwarding it still means trusting `updatedPermissions` /
   `PermissionUpdate` as designed for the SDK's synchronous in-process callback, transplanted
   onto a channel this project already rejected forwarding through, for the reasons D35 gives
   (a grant this server can neither enumerate nor revoke, an audit gap on every later match).

## Answer

**Not sufficient — and the honest reason is narrower than "not sufficient": it is
unobservable.** `permission_suggestions` cannot be evaluated as a grammar because it has never
arrived on any wire this project can inspect, on the only transport this project uses, and the
upstream defect responsible has no visible path to a fix. Treating "unobservable" as anything
other than "not sufficient" would mean shipping a matcher against a shape nobody has verified,
which is exactly what D104 already forbids for any other purpose.

## Proposed local grammar

A grammar independent of `permission_suggestions`, so standing rules do not stay blocked on an
upstream defect this project cannot influence:

- **Shape:** `"<tool>:<glob>"` — a tool name, a colon, and a glob matched against one
  tool-specific string projected from `input` (S10.2's `match(rule, request)` needs to define
  that projection per tool; for `Bash` it is `input.command`, for `Read`/`Edit`/`Write` it is
  `input.file_path`). Not the vendor's `Tool(pattern)` syntax verbatim — that syntax is the
  CLI's own settings-file grammar, matched by the CLI itself before `can_use_tool` would ever
  fire, and reusing it here would misleadingly imply this server understands `.claude/
  settings.json`, `Edit`'s four anchor forms, or `mcp__*` scoping. It does not; it matches one
  string against one glob.
- **Origin:** operator-typed at answer time, never parsed from a vendor suggestion. The
  `label` half of `PermissionSuggestion` may still be shown to the operator as a starting
  point for what to type — that is display, not parsing, and needs no grammar decision.
- **Storage:** session-scoped, per S10.5 — this finding does not change that, it only gives
  `match` something concrete to compare.

This is a proposal, not a decision — S10.2 is a contract amendment (`/contract`'s tier) and
this slice may not write `StandingRuleExpression`'s shape into `20-contract.md` itself.
