# S25 finding — does `--include-partial-messages` yield usable token-level deltas?

Written before any mapping code, per S25.1 (`design/30-slices.md § S25`). Probed against the real,
installed CLI — `claude` 2.1.227 — from a scratch directory, not against a fixture. Six runs, each
a Node script spawning `claude -p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio` with and without `--include-partial-messages`, writing one `user`
record to stdin (the same record shape `src/adapters/claude/index.ts`'s `send` already writes) and
capturing every line of stdout.

## Method and runs

1. Plain text turn, flag on, `--dangerously-skip-permissions` (short sentence, to read raw shapes).
2. Same turn, flag off, same skip-permissions (baseline for comparison).
3. Tool-use turn (`Bash echo`), flag on, skip-permissions — the tool ran without a prompt, so this
   run answers nothing about the permission round trip; kept only to see delta shapes around a
   tool call.
4. Tool-use turn (`Write` a file), flag on, **without** `--dangerously-skip-permissions` — the
   probe itself answers `control_request`, the same way `send`'s existing permission handling
   does (`type: 'control_response'`, `response.behavior: 'allow'`, `updatedInput` echoed back,
   `toolUseID` set from the request).
5. Same tool-use turn, flag **off**, same real permission round trip — baseline for comparison
   against run 4.
6. A longer (163-word) plain-text turn, flag on, skip-permissions — to measure delta granularity
   and envelope volume on a less trivial response.

## Answers

**1. Does the flag emit usable incremental text records at all? Yes.** With the flag on, the CLI
emits `{"type": "stream_event", "event": {...}}` records wrapping the raw Anthropic Messages API
streaming event shapes: `message_start` (carries the message's `id` and an interim `usage`),
`content_block_start`, one or more `content_block_delta` (`delta: {type: "text_delta", text}` for
text blocks), `content_block_stop`, `message_delta` (carries the turn's final `usage`), and
`message_stop`. None of these five types appear at all with the flag off (runs 2 and 5). `type:
"stream_event"` is not in the adapter's `IGNORED_TOP_LEVEL_TYPES`, so an unmodified adapter would
currently emit a non-fatal `adapter_unknown_record` error for each — expected, since no mapping
exists yet, and not itself a disturbance to anything this criterion asks about.

**2. Do the deltas concatenate exactly to the final `message`? Yes**, in every run checked (1, 4,
6). Run 1: `"The"` + `" quick brown fox jumps over the lazy dog."` equals the `assistant` record's
`content[0].text` byte for byte. Run 4: two separate text blocks (`"I'll create that file."` before
the tool call, `"Created \`probe5-marker.txt\`..."` after it) each reassemble exactly from their
own `content_block_start`…`content_block_stop` span. Run 6: nine deltas concatenate to a 947-
character, 163-word paragraph matching the `assistant` record exactly. This is the rule
`20-contract.md § Rules the renderer may rely on` already states, and it holds.

**3. Does the flag disturb the `control_request` permission round trip? No.** Run 4 answered a real
`can_use_tool` request for the `Write` tool the same way `send` does today — `control_response` /
`behavior: allow` / `updatedInput` / `toolUseID` — and the tool ran (the target file exists on
disk afterward), with ordinary `assistant`/`stream_event` traffic before and after the tool call.
Nothing about the request shape, the response shape, or the sequencing of `control_request` against
`stream_event` differs from the flag-off baseline (run 5) beyond the presence of the new stream
events themselves.

**4. Does the flag disturb `usage`, which D75 and S1.11 normalise per `message.id`? No — the field
the adapter reads is unchanged.** The adapter's `usage` event is emitted from the `assistant`
record's `message.usage`, deduplicated by `message.id` (`lastUsageMessageId`). That record's shape
and values are **identical with the flag on or off**: in both run 1 and run 2, `message.usage.
output_tokens` reads `1` — an interim, not-yet-final count, already true today and unrelated to
this flag. The turn's real final usage lands on `message_delta`'s `usage` and on the terminal
`result` record, neither of which the adapter reads today, flag on or off. A second, pre-existing
fact confirmed by runs 4 and 6 rather than caused by the flag: the CLI already splits one logical
assistant turn into **multiple `assistant` records sharing one `message.id`**, one per content
block (text, then `tool_use`, as separate records) — reproduced identically in the flag-off
baseline (run 5: `msg_...Seaesque` appears on a `text`-only record and then a `tool_use`-only
record). The adapter's per-`message.id` dedup already handles this, flag on or off; nothing new is
introduced.

## Volume, for S25.2

Run 6 (163 words, 947 characters): **9** `content_block_delta` events and **14** `stream_event`
records total, against **1** `assistant` record today. The granularity is coarse, not one event
per token — roughly 18 words per delta in this sample — which is a server-side or transport-level
batching, not the CLI passing through every model-emitted token individually. A short reply (run 1,
9 words) produced 2 deltas and 7 stream events total.

## Consequence for this slice

S25.1 is satisfied on all four questions: no disturbance found, so the slice does not stop outright
and the finding is not applicable in the "stops the slice" sense. **S25.2's decision — whether
`message.delta` takes a `seq` and is persisted to the spill, or is live-only — is not settled
here.** Both readings stay live on the evidence above: the renderer rule permits live-only, while
`seq` contiguity (S1.5) and replay depend on every envelope being spilled. That ruling is
`/design`'s, per `AGENTS.md § Command routing` and D165, and this slice does not implement past it.
S25.3 through S25.7 are consequently **blocked, not attempted** — each depends on the shape S25.2
settles (a persisted `message.delta` needs a contract addition and a spill/ring/replay path; a
live-only one does not, and renders differently) and building against a guess is exactly what
D165 sliced this to prevent.
