# S34 enumeration — does an edit-class tool result carry a recoverable change?

S34.1: against a captured fixture of a real edit-class tool result from each supported vendor,
record which field carries the change and in what form. Stop only if **neither** vendor's result
carries a recoverable change.

## 1. Claude CLI: `Edit` and `Write` results carry a recoverable before/after pair

Captured live (`claude -p --output-format stream-json --verbose`), a `Read`-then-`Edit` turn against
`sample.txt` (`"line one\nline two\nline three\n"` → `"line one\nline TWO edited\nline three\n"`).

The `tool_result` content block on the `user`-type record has a sibling top-level field
`tool_use_result` on the same JSON line. For the `Edit` result:

```
"tool_use_result":{"filePath":"...\\sample.txt","oldString":"line two","newString":"line TWO edited",
"originalFile":"line one\nline two\nline three\n",
"structuredPatch":[{"oldStart":1,"oldLines":3,"newStart":1,"newLines":3,
"lines":[" line one","-line two","+line TWO edited"," line three"]}],
"userModified":false,"replaceAll":false}
```

— the full pre-edit file text (`originalFile`) plus an already-computed unified-diff-shaped hunk
array (`structuredPatch`: `oldStart`/`oldLines`/`newStart`/`newLines`/`lines`, each line prefixed
`" "`/`"-"`/`"+"`). A second capture against the `Write` tool (fresh-file create) shows the
degenerate case:

```
"tool_use_result":{"type":"create","filePath":"...\\fresh.txt","content":"hello\nworld",
"structuredPatch":[],"originalFile":null,"userModified":false}
```

— full new-file `content`, empty `structuredPatch`, null `originalFile` (there is no before).

This field is not new to this probe: `src/agent-console/providers/claude-cli/fixtures/
usage-probe-two-reads.ndjson` and `usage-probe-bash.ndjson` already carry `tool_use_result` for
`Read` and `Bash` results (a `{type,file:{filePath,content,numLines,startLine,totalLines}}` shape
and a `{stdout,stderr,interrupted,isImage,noOutputExpected}` shape respectively) — confirming the
field is a real, already-precedented part of the wire protocol this project's own fixtures
capture, not an artifact of this probe.

`src/agent-console/providers/claude-cli/index.ts:282` currently reads only `block['type'] ===
'tool_result'` and the block's own `tool_use_id`/`content`; the sibling `tool_use_result` field is
not read anywhere in the adapter. **What this means for this slice**: the data exists on the wire
and is unread today — mapping it is in scope for S34, not a separate slice.

## 2. Codex `app-server`: a real edit turn exposes no write-class evidence on the wire

Captured live (`codex app-server`, `gpt-5.6-sol`, cliVersion `0.155.1`), a `thread/start` +
`turn/start` turn instructing the agent to edit `sample2.txt` directly (not via a shell command).
The file was genuinely edited on disk (`sample2.txt` reads `line one\nline TWO edited\nline
three\n` after the run).

`grep -o '"command":"[^"]*"' codex-appserver-raw2.ndjson | sort -u` — the exhaustive, deduplicated
set of every command string anywhere in the 807 KB capture — returns:

```
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -First 160
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -Skip 160 -First 110
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -Skip 160 -First 160
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -Skip 270 -First 110
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -Skip 320 -First 160
Get-Content 'C:\...\AGENTS.shared.md' | Select-Object -Skip 480
Get-Content -Raw 'C:\...\AGENTS.md'
Get-Content -Raw 'C:\...\AGENTS.shared.md'
Get-Content -Raw 'C:\...\agent.md'
Get-Content -Raw 'sample2.txt'
git branch --show-current
git log -5 --oneline
git remote -v
git status --short --branch
rg --files
```

Every command executed is a read (home AgentKit config, git/rg onboarding, and one read-back of
`sample2.txt`). No write of any kind appears in `command`, and no `item/fileChange/patchUpdated`
notification appeared in this capture — the file was edited through a channel invisible to this
JSON-RPC client. **This is a claim about the capture, not the protocol**: the app-server schema
(`schema/v2/FileChangePatchUpdatedNotification.json`) defines exactly this notification as carrying
`changes: [{diff: <unified-diff string>, kind, path}]` per changed file — a real, recoverable,
Codex-native diff — and the adapter's own `IGNORED_APP_SERVER_METHODS` already lists the method name
as previously observed and deliberately ignored. That method simply never fired in this probe's
edit turn, for a reason not yet root-caused (sandbox mode, approval policy, or model-chosen edit
path are the leading candidates). **What this means for this slice**: Codex's real captured turn is
the "neither" case for itself — it carries nothing recoverable *in this capture*. It is not, on its
own, grounds to stop S34; see the verdict below. Wiring `item/fileChange/patchUpdated` into the
Codex adapter is out of this slice's authorized scope (mapping Claude's `tool_use_result` only) and
is logged as an open item in `design/90-decisions.md` rather than pursued here.

## Verdict

S34.1's stop condition requires **neither** vendor's result to carry a recoverable change. Claude
does (finding 1): `structuredPatch` + `originalFile` for `Edit`, `content` for `Write`. Codex's
real captured turn does not (finding 2). One vendor clears the bar, so **the stop condition is not
met — S34 proceeds**, rendering from Claude's shape and falling back to S34.5's "renders exactly as
it does today" path for any result — Codex's, or Claude's own `Read`/`Bash` — that carries none.

Whether Codex exposes recoverable change data through some other surface is no longer fully open:
the protocol schema confirms `item/fileChange/patchUpdated` carries a real per-file unified diff,
already known to (and currently ignored by) the adapter — this probe simply never observed it fire.
Mapping it is not this slice's question to chase further, though, since S34's authorized scope is
the Claude `tool_use_result` mapping. S34.5 already gives the renderer a defined behaviour for a
`diff: null` result, so the Codex adapter emits that explicitly and unconditionally for now; wiring
`item/fileChange/patchUpdated` is logged as a follow-up in `design/90-decisions.md`.
