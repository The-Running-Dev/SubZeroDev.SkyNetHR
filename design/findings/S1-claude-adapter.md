# S1 findings — the Claude adapter

Written before the usage-normalisation code and cited by S1.1, S1.9 and S1.11
(`design/30-slices.md § S1`). Both probes were run against the real, installed CLI —
`claude` 2.1.226 — from a scratch directory, not against a fixture.

## 1. `--permission-prompt-tool stdio` does not emit `control_request` (S1.1, S1.9)

Three probes, each with `-p --output-format stream-json --input-format stream-json
--verbose --permission-prompt-tool stdio`:

- A `Read` tool call on a plain file.
- A `Bash` tool call (`echo hello-from-bash-tool`), default `--permission-mode`.
- The same `Bash` call with `--permission-mode manual` added.

In every case the tool executed immediately — visible as `tool_use` followed directly
by a `tool_result` — with no `control_request` of any subtype on stdout at any point.
`system/init`'s `permissionMode` field read `"default"` in all three, and removing the
flag entirely produced the identical trace, i.e. the flag had no observable effect.

This matches a currently open upstream defect:
[anthropics/claude-code#34046](https://github.com/anthropics/claude-code/issues/34046),
"CLI does not emit `can_use_tool` control_request when `--permission-prompt-tool
stdio`", tracked since CLI 2.1.6 and still present at 2.1.226 (confirmed by web search,
2026-08-09). Tool execution itself works; only the permission callback fails to fire.

**Consequence for this slice.** S1.1's assertion — write a `control_response`, observe
the turn continue to `result` — cannot be exercised against a real `claude` child right
now, because the child never emits the `control_request` that response would answer.
S1.9 (`permission.request` → auto-deny → `turn.ended`) has the same dependency. Both
are implemented against the documented protocol and tested against a fixture CLI this
slice controls (`src/adapters/claude/fixtures/`), which reproduces the documented wire
shape exactly. The real-child round trip is recorded as **blocked on the upstream bug**,
not passing, and carried to `90-decisions.md § Open` for `/track`. **S4 depends on the
same mechanism and inherits this block entirely** — it cannot ship a real permission
round trip until #34046 is fixed or a workaround is chosen.

## 2. `usage` is per-message, not cumulative — but content blocks duplicate it (S1.11)

Two probes (`--dangerously-skip-permissions`, no permission dependency): one turn
making two sequential `Read` calls, and one making a `Bash` call. Fixtures captured at
`src/adapters/claude/fixtures/usage-probe-*.ndjson`.

Observed:

- `cache_read_input_tokens` grows monotonically across successive `assistant` records
  within one turn (32947 → 46535 → 47317 in the two-`Read` probe), consistent with each
  record reporting that specific API call's own usage against a growing context — not a
  running total the adapter would need to subtract to find a delta.
- **A single logical message with multiple content blocks (e.g. `thinking` then
  `tool_use`) is streamed as separate `assistant` records that share one `message.id`
  and carry byte-identical `usage`.** Summing every `assistant` record naively
  double-counts these.
- The final `result` record's `usage` (and its `iterations` breakdown) is a materially
  different, larger figure than the sum of the visible `assistant` records' usage —
  observed 136 output tokens at `result` against 19 from summing distinct message ids.
  It is not used here: the vendor mapping table has no `result → usage` row, and
  mixing bases would misreport burn.

**Normalisation adopted.** Emit a `usage` event on the first `assistant` record seen
for a given `message.id`; subsequent records sharing that id are not re-emitted. No
arithmetic subtraction is needed — each message's usage is already that call's own
marginal cost. This satisfies D75's "delta" requirement by construction: what looked
like a possible cumulative-counter problem is a duplicate-emission problem instead.

**Not observed in this probe:** an actual `compact_boundary` record (neither probe ran
long enough to trigger auto-compaction). The mapping still resets local token-counter
tracking on `compact_boundary` per the contract's row, but that specific behaviour is
unverified here — stated so it is not mistaken for having been checked.
