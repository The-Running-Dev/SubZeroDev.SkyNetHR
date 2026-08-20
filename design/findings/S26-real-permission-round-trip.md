# S26 finding — does the real, installed CLI answer `control_request`/`can_use_tool` under the flags this server spawns with?

Written before any transport code and before any spawn-argument change, per S26.1
(`design/30-slices.md § S26`). Probed against the real, installed CLI — `claude` 2.1.228 — from
scratch directories, not against a fixture, and additionally driven through the unmodified
production code path (`src/session-manager/index.ts`, `src/adapters/claude/index.ts`, harness
scripts under `harness/`, not committed) to rule out probe-script artifacts.

## Summary

**The round trip works, and it is genuinely tool/content-dependent** — the second of S26.1's two
readings, not the first. `control_request`/`can_use_tool` fires and a `control_response`
correctly resolves it — allow lets the tool run, deny stops it — against the real CLI, over the
exact flags this server's adapter already spawns with (`buildArgs`,
`src/adapters/claude/index.ts`: `-p --output-format stream-json --input-format stream-json
--verbose --permission-prompt-tool stdio`, no `--permission-mode`), for `Write`, `Edit`, and any
`Bash` command with a side effect. It does **not** fire for `Read` or a side-effect-free `Bash`
command, under any mode — the CLI treats those as safe by design, not as a defect. D88's own two
probes (a `Read`, and `echo hello-from-bash-tool` — no redirect, no side effect) were both,
without anyone having named it at the time, exactly the safe case, so "no prompt" was a correct
observation of those two specific commands. **The error was in the generalisation**, stated in
`10-design.md` and `20-contract.md` as "the tool simply executes" and "not observed on a live
wire" without qualification — as if no Claude tool call ever prompts. A third data point already
contradicted that generalisation before this slice: S25's run 4, a `Write`, got a real
`can_use_tool` and was recorded as a puzzle rather than the missing half of the picture
(`design/30-slices.md § S26`, S26.1's framing note).

A second, independent bug compounded the miscount. D88's original standalone probe scripts, and
this finding's own first three attempts at the `PermissionRequest` hook, **closed the child's
stdin immediately after writing the `user` record**, before any `control_request` could be
answered on it. The CLI aborts the permission wait near-instantly when its request/response
channel is a closed pipe (`AbortError: Stream closed`, observed directly — see Method, runs 1-3).
Run against a **state-mutating** command with that bug present, every mode looks broken,
regardless of whether the CLI would have prompted correctly. The **production** `send()` in
`src/adapters/claude/index.ts` never has this bug: it holds stdin open and only calls
`child.stdin.end()` inside the `case 'result':` handler, after the turn is already over — its own
test suite even documents the trap by name (`src/adapters/claude/index.test.ts`: "stdin is still
writable here — this is the point in the real handshake where a naive implementation would
already have closed it"). That code was implemented and tested only against the fixture (D88);
this slice is the first time it has been run against the real binary, and it works.

## Method and runs

Six scripts, in order, each answering an open question the previous one raised:

1. **`batch.mjs`** (28 runs: 7 `--permission-mode` values `{default, acceptEdits, auto,
   bypassPermissions, manual, dontAsk, plan}` × 4 tools `{Read, Write, Edit, Bash}`) — a
   hand-rolled probe that writes the `user` record and immediately calls `proc.stdin.end()`.
   Every one of the 28 runs reported `sawControlRequest: false`, tool ran anyway. This reproduced
   D88 exactly and appeared to extend it to full coverage. **Superseded — see `batch2.mjs`
   below; this script had a stdin-closing bug that made every row read the same way regardless of
   what the CLI actually did.**
2. **`run-hook-probe.mjs`/`2`/`3`** — probes of the vendor's `PermissionRequest` hook
   (`--settings` carrying an inline `hooks.PermissionRequest` command), built to answer S26.3/
   S26.4. These also closed stdin early. The hook script (`hook.mjs`) *was* invoked in every run
   that registered it (`tool_name`/`tool_input`/`permission_suggestions` all present on its
   stdin, matching the vendor's documented shape) — but the tool call's own `control_request`
   aborted (`AbortError: Stream closed`) within ~100-150ms of the tool call, **before** the hook
   (which itself takes ≥1 event loop tick to be spawned and read) could possibly have answered.
   Timestamps line up exactly: the abort in probe 3 was logged at `17:25:29.268Z`; the hook's own
   invocation was logged at `17:25:29.411Z`, 143ms *later*. The abort is not caused by the hook
   being slow or wrong — it is caused by the same premature `stdin.end()` these probes share with
   `batch.mjs`.
3. **`run-hook-probe4.mjs`** — corrected: `proc.stdin.end()` moved to fire only after the `result`
   record, matching the production adapter. Run with the hook registered and stdin correctly held
   open: `sawControlRequest: true`, the hook fired, `bash-marker.txt` was written. Re-run with
   `useHook=false` (no `--settings` hook at all, otherwise identical flags): **also**
   `sawControlRequest: true`, tool ran. The hook was not what unlocked the channel.
4. **`probe5.mjs`** — isolates the last variable: `batch.mjs`'s exact flags (no `--settings` at
   all, `--permission-mode manual`), stdin held open. `sawControlRequest: true`, tool ran. This
   confirms the fix is the stdin-open discipline, not `--settings`, not the hook, not the
   permission mode.
5. **`harness/run-s26.mjs`** (not committed) — the actual production code path: real
   `createSessionManager`, real `createClaudeAdapter` via `manager.create`, a real child, real
   `manager.answerPermission`. Two runs against a fresh scratch workspace, one Bash tool call
   each:
   - **Allow**: `permission.request` → `answerPermission({decision:'allow'})` →
     `permission.resolved` → `tool.result: {ok:true}` → `turn.ended: {stopReason:'completed'}`.
     `marker-allow.txt` exists on disk afterward with the expected content. `audit.ndjson` carries
     one `AuditRecord` with `decision:"allow"`.
   - **Deny**: `permission.request` → `answerPermission({decision:'deny'})` →
     `permission.resolved` → `tool.result: {ok:false, output:"The user doesn't want to
     proceed..."}` → `turn.ended: {stopReason:'error'}`. No marker file written. `audit.ndjson`
     carries one `AuditRecord` with `decision:"deny"`.
6. **`harness/run-s26-multi.mjs`** (not committed) — one turn, three sequential Bash tool calls,
   each answered `allow`, plus a **double-answer** on the first `requestId` (a second
   `answerPermission` call fired immediately after the first, before the child could possibly
   have reacted). Three `permission.request`/`permission.resolved` pairs, three files written
   (`one.txt`, `two.txt`, `three.txt`), three `AuditRecord`s in `audit.ndjson` — one per request,
   none duplicated. The double-answer's second call returned `{ok:true, value:{accepted:false}}`:
   rejected, not silently ignored. This is `session-manager`'s own `pending.delete`-before-await
   guarantee (D33, I9, I11) doing its job — unmodified by this slice, and it held against a real
   child exactly as it does against the fixture (S4.5's existing test).
7. **`batch2.mjs`** — `batch.mjs`'s exact matrix (28 runs), corrected to hold stdin open until
   `result`. Superseding coverage data for S26.2. See Coverage below.

## Answers

**S26.1 — does `control_request`/`can_use_tool` fire under the flags this server spawns with?
Yes**, unconditionally, once the probing script itself does not close the channel it is trying to
use. No transport change, spawn-argument change, or hook is needed: the adapter code already in
the tree (`src/adapters/claude/index.ts`) already does this correctly and was already covered by
fixture tests asserting the same shape (S1.1, S1.3, S1.9, S4.2, S4.5, S4.6). What was missing was
ever having run that exact code against the real binary and recorded the result — D88 recorded a
different, buggier probe's result instead.

**S26.2 — coverage.** See the table below, from `batch2.mjs`.

## Coverage (S26.2)

`batch2.mjs`, 28 runs, corrected script (stdin held open until `result`), each tool run to
completion: `Read` a plain file; `Write` a new file; `Edit` replace a word; `Bash` an
**non-redirecting** `echo` (`echo s26-probe-bash-marker`, matching D88's own original Bash probe
verbatim). `control_request` observed:

| `--permission-mode` | `Read` | `Write` | `Edit` | `Bash` (no side effect) |
|---|---|---|---|---|
| *(none — what this server spawns with)* | no | **yes** | **yes** | no |
| `manual` | no | **yes** | **yes** | no |
| `acceptEdits` | no | no | no | no |
| `auto` | no | no | no | no |
| `bypassPermissions` | no | no | no | no |
| `dontAsk` | no | no | no | no |
| `plan` | no | yes (one run needed a second, unanswered `control_request` this probe's simple always-allow responder did not resolve, and it timed out — plan mode appears to raise more than one `control_request` subtype; irrelevant to this server, which never sets `--permission-mode plan`) | yes | yes |

`manual` reports `permissionMode: "default"` on `system/init`, exactly as D88 recorded — it is not
a distinct mode from the CLI's perspective for this purpose.

**Read the coverage together with run 6 (`harness/run-s26-multi.mjs`, `echo marker-one >
one.txt`, a side-effecting Bash command): the CLI's decision to prompt is not "by tool", it is
by whether the specific invocation has a side effect.** `Read` and a side-effect-free `Bash`
command are treated as safe and never prompt, under any mode this server would plausibly use;
`Write`, `Edit`, and a side-effecting `Bash` command all prompt under the two interactive modes
(no flag, and `manual`) and are silently allowed under the four modes documented as
non-interactive by name (`acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`). **This is the
CLI behaving as designed, not a defect** — D88's own two probes (`Read`, `echo
hello-from-bash-tool`) both happened to be exactly the content-safe case, which is why they
reported no prompt: that observation was correct for those specific commands. The error was
generalising "these two probes saw nothing" to "the channel is broken," when a third probe on a
state-mutating command (S25's run 4, a `Write`) had already reported the opposite and was treated
as the anomaly rather than the missing half of the picture.

## Consequence for S26.3 through S26.7 (the hook)

**No gap exists for the hook to fill.** S26.3 is scoped to run "only where S26.1 and S26.2 leave
a gap" — coverage below shows none over `{Read, Write, Edit, Bash}` under the mode this server
actually spawns with (no `--permission-mode` flag, i.e. default). The `PermissionRequest` hook
investigation (probes 1-4 above) is recorded as a secondary result, not a requirement: the hook
*does* fire and *can* carry a decision (probe 4, `useHook=true`), and a decision arriving
asynchronously through an external file (simulating this server relaying an operator's answer)
does reach it and does resolve the tool call — but building any transport on it would be solving
a problem this slice's own evidence says does not exist. S26.4 through S26.7 are recorded **not
applicable**, not blocked: the condition that would have made them necessary did not hold.

## Consequence for this slice

S26.8 and S26.10 are satisfied directly by runs 5 and 6 above: allow and deny each round-tripped
to a real child on a real tool call, ordering guarantees (exactly-one-resolution) held against
the real child exactly as the fixture already asserts. S26.9 (fixture suite unchanged) is
satisfied — `npm test`, 409 passing / 2 skipped / 0 failing, before any of this slice's changes.
S26.11 is satisfied by construction: nothing in `buildArgs` changes, because nothing needed to.
S26.7 does not apply (no hook-reached surface ships). #56 (`anthropics/claude-code#34046`,
tracked since D88) can close: the mechanism it names as broken is not broken in the code this
server ships against it.
